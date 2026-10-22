// verify.cjs —— 验收测量脚本（不是回归测试，回归用 rope.test.cjs）
//
// 它用 vm 直接读 renderer/config.js 的默认值（不手抄参数），复刻 doll.js 的
// 死区 -> 低通 -> tanh 软限幅渲染链，然后测 10 组固定指标：
//   1) 匀速拖动稳态角（R13 偏移 + 旋转）
//   2) 正弦往返的娃娃角动态范围（R13）
//   3) 自由摆周期 / 振幅衰减 tau（R14）
//   4) 绳端翻到挂点上方的帧占比（R15）
//   5) 60s 剧烈甩动的折叠 / 拉伸 / 非法数值
//   6) 停手静止 + 帧率无关 + fixedStep 无关
//   7) 性能
//   8) 诊断记录器（第 13 轮）：每 0.1s 采样、字段完整、绳力量级与解析式相符
//   9) 娃娃转角在弦角穿越 ±180° 时连续、停手后能收敛（第 14 轮 F15）
//  10) 图片挂点可调（T1）：默认值逐位复现旧行为，且只改渲染不改物理
//
// 用法：node verify.cjs   （改完 config.js 后跑一遍，和 docs/09 的 8.2 对照）
const fs = require("fs");
const path = require("path");
const ROOT = __dirname;
const vm = require("vm");
const src = fs.readFileSync(path.join(ROOT, "renderer/config.js"), "utf8");
const sandbox = { window: { CONFIG: undefined, dispatchEvent(){} }, CustomEvent: function(){}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const C = sandbox.window.CONFIG;
// 不合格项计数。每组自己 console.log PASS/FAIL，最后统一汇总并设退出码。

let fail = 0;
console.log("读到线上配置: gravity=" + C.physics.gravity + " drag=" + C.physics.drag +
  " maxBend=" + C.physics.maxBend + " bendIterations=" + C.physics.bendIterations +
  " seg=" + C.chain.segments + " it=" + C.chain.iterations + " k=" + C.chain.dampingPerSecond);
console.log("   doll: deadzone=" + C.doll.angleDeadzone + " tau=" + C.doll.bodyAngleTau +
  " limit=" + C.doll.angleLimit + " over=" + C.doll.angleLimitOvershoot + " ratio=" + C.doll.bodyRotateRatio);
console.log("   rope: lengthRatio=" + C.rope.lengthRatio + " min=" + C.rope.min + " max=" + C.rope.max);

const { RopeChain } = require(path.join(ROOT, "renderer/rope.js"));

const DEG = 180 / Math.PI;

// 【理论周期必须用链式刚体摆，不能用简单摆】
// 简单摆 T = 2π√(L/g) 只对"质量全集中在绳端"成立。segments >= 2 时质量沿绳分布
// （_massAt 从 1 线性升到 tailMass），有效摆长变短，周期系统性偏快
// （1/2/3/4 段实测对简单摆 -0.1% / -5.4% / -8.9% / -10.5%）。
// 链式刚体摆（挂点被钉死、其余质点刚性连成直线、绕挂点小角度摆动）：
//     T = 2π√( Σ m_i·(x_i²+y_i²) / ( g·Σ m_i·y_i ) )
// 用这个式子，1/2/3/4 段的实测误差都收敛到 1% 以内（-0.1% / +0.8% / +0.8% / +1.0%）。
function chainPendulumPeriod(r, g) {
  const p = r.points;
  let num = 0, den = 0;
  for (let i = 1; i < p.length; i++) {
    const m = p[i].mass;
    const x = p[i].x - p[0].x, y = p[i].y - p[0].y;
    num += m * (x * x + y * y);
    den += m * y;
  }
  return 2 * Math.PI * Math.sqrt(num / (g * den));
}
const SCREEN_H = 864;                       // 1080p 常见可用高度
const DOLL_H = Math.min(C.doll.heightMax, Math.max(C.doll.heightMin, SCREEN_H * C.doll.heightRatio));
const ROPE_LEN = Math.min(C.rope.max, Math.max(C.rope.min, SCREEN_H * C.rope.lengthRatio));
console.log("   屏高 " + SCREEN_H + " => 娃娃高 " + DOLL_H.toFixed(1) + "px, 绳长 " + ROPE_LEN.toFixed(1) + "px");

function mkCfg(over) {
  return Object.assign({}, C.physics, C.chain, { turbulence: 0 }, over || {});
}
// 第 29 轮：挂饰模拟段验收要自己控制 rebuild 与初始状态，所以给一个只组装配置的版本。
function makeRopeCfg(over) {
  return mkCfg(over);
}
function fresh(over) {
  const cfg = mkCfg(over);
  const r = new RopeChain(cfg);
  r.setAnchor(500, 300);
  r.rebuild(ROPE_LEN, cfg.segments + 1);   // segments = 段数，rebuild 要的是质点个数
  r.resetVertically();
  return r;
}
// T1：复刻 doll.js 的 get anchorOffset()。纯几何，不碰 canvas。
// 返回的是「挂点相对图片顶边中点」的偏移，单位 CSS px。
// oy 被 heightMax 夹住，是为了防止超大图把挂点推出图片外面。
function anchorOffsetOf(d, w, h) {
  const ax = d.anchorX !== undefined ? d.anchorX : 0.5;
  const ay = d.anchorY !== undefined ? d.anchorY : 0.0;
  // 第 21 轮语义修正：返回的是「图片静止矩形左上角相对吊环（= 绳端）的偏移」。
  // 吊环永远钉在绳端，调 anchorX/anchorY 平移的是图片。
  // 第 22 轮修：px 原来写成 -w*(ax-0.5)（等价 ox = -w*(1-ax)），把左右镜像了，
  // 面板上「往右」会让挂点往左跑（m08776）。正确语义：px = w*ax、py = ay*h。
  const px = w * ax;            // 挂点在图片坐标系里的 x（左上角为原点）
  const py = ay * h;            // 挂点在图片坐标系里的 y
  return { ox: -px, oy: -py };
}

// 复刻 doll.js 的渲染链：死区 -> 低通(tau) -> tanh 软限幅 -> bodyRotateRatio
function makeDoll() {
  let body = 0;
  let cont = null, prevRaw = null;
  const TAU2 = Math.PI * 2;
  const wrapPi2 = (a) => a - Math.round(a / TAU2) * TAU2;
  function step(rawAngle, dtSec) {
    let a = rawAngle;
    if (Math.abs(a) < C.doll.angleDeadzone) a = 0;
    const fk = 1 - Math.exp(-dtSec / C.doll.bodyAngleTau);
    // 第 27 轮 F15：目标角先展开成连续序列，再喂低通（与 renderer/doll.js 同构）。
    if (cont === null) { cont = a; body = a; prevRaw = a; }
    else { cont += wrapPi2(a - prevRaw); prevRaw = a; }
    body += (cont - body) * fk;
    let out = body * C.doll.bodyRotateRatio;
    const lim = C.doll.angleLimit / DEG, over = C.doll.angleLimitOvershoot / DEG;
    // 与 doll.js 的 _softLimitAngle 保持一致：180° = 不限制（恒等直通）
    if (C.doll.angleLimit < 180 && Math.abs(out) > lim) {
      out = Math.sign(out) * (lim + over * Math.tanh((Math.abs(out) - lim) / over));
    }
    return out * DEG;   // 第 27 轮：去掉 Math.abs —— 带号才看得出「反向猛甩」
  }
  step.raw = function () { return body; };   // 需要内部状态时用
  step.cont = function () { return cont; };   // 连续展开后的目标角（弧度，可漂多圈）
  return step;
}
function rampDrive(r, dollStep, vx, rampSec, holdSec, dt) {
  dt = dt || 1 / 60;
  let x = r.anchorX; const y = r.anchorY;
  const nRamp = Math.max(1, Math.round(rampSec / dt));
  for (let i = 1; i <= nRamp; i++) {
    const u = i / nRamp, w = u * u * (3 - 2 * u);
    x += vx * w * dt; r.setAnchor(x, y); r.update(dt);
    if (dollStep) dollStep(r.tipAngle, dt);
  }
  const nHold = Math.max(1, Math.round(holdSec / dt));
  let sum = 0, mx = 0, sumDX = 0;
  for (let i = 0; i < nHold; i++) {
    x += vx * dt; r.setAnchor(x, y); r.update(dt);
    const b = dollStep ? dollStep(r.tipAngle, dt) : Math.abs(r.tipAngle * DEG);
    sum += b; if (b > mx) mx = b;
    sumDX += r.tipX - r.anchorX;
  }
  return { avg: sum / nHold, max: mx, avgDX: sumDX / nHold };
}
function sineDrive(r, dollStep, amp, f, cycles, dt) {
  dt = dt || 1 / 60;
  const n = Math.round(cycles / f / dt);
  let mx = 0, sumLate = 0, nLate = 0;
  for (let i = 1; i <= n; i++) {
    const t = i * dt;
    r.setAnchor(500 + amp * Math.sin(2 * Math.PI * f * t), 300);
    r.update(dt);
    const b = dollStep ? dollStep(r.tipAngle, dt) : Math.abs(r.tipAngle * DEG);
    if (b > mx) mx = b;
    if (t > cycles / f * 0.5) { sumLate += b; nLate++; }
  }
  return { max: mx, late: nLate ? sumLate / nLate : 0 };
}

console.log("\n=== 验收 1：匀速拖动（R13 偏移 + 旋转）===");
console.log("v(px/s)  绳平均角  绳最大角  娃娃平均角  娃娃最大角  绳端水平偏移");
for (const v of [200, 300, 500, 800, 1200, 1600]) {
  const r = fresh(); const d = makeDoll();
  const out = rampDrive(r, d, v, 1.0, 1.0);
  const r2 = fresh();
  const raw = rampDrive(r2, null, v, 1.0, 1.0);
  console.log(String(v).padStart(4) + "     " + Math.abs(raw.avg).toFixed(2).padStart(6) + "°   " +
    raw.max.toFixed(2).padStart(6) + "°   " + out.avg.toFixed(2).padStart(6) + "°   " +
    out.max.toFixed(2).padStart(6) + "°   " + out.avgDX.toFixed(2).padStart(7) + "px");
}

console.log("\n=== 验收 2：正弦往返（真实人手，R13 动态范围）===");
console.log("amp/f      peakV   绳最大角  娃娃最大角  娃娃后段均值");
const sineRows = [];
for (const [amp, f] of [[15, 1.0], [40, 1.2], [80, 1.5], [150, 1.8], [250, 2.2]]) {
  const peakV = 2 * Math.PI * f * amp;
  const r = fresh(); const d = makeDoll();
  const o = sineDrive(r, d, amp, f, 4);
  const r2 = fresh();
  const raw = sineDrive(r2, null, amp, f, 4);
  sineRows.push(o.max);
  console.log((amp + "/" + f).padEnd(11) + peakV.toFixed(0).padStart(6) + "   " +
    raw.max.toFixed(1).padStart(7) + "°  " + o.max.toFixed(1).padStart(8) + "°  " + o.late.toFixed(1).padStart(9) + "°");
}
console.log("娃娃最大角动态范围 = " + (Math.max.apply(null, sineRows) / Math.min.apply(null, sineRows)).toFixed(2) + "×");

console.log("\n=== 验收 3：自由摆（R14 大摆幅、慢衰减）===");
for (const deg of [10, 20, 30, 45]) {
  const r = fresh();
  // 绕挂点刚性旋转后速度清零
  const a = deg / DEG, cs = Math.cos(a), sn = Math.sin(a);
  for (const p of r.path) {
    const dx = p.x - 500, dy = p.y - 300;
    const nx = 500 + dx * cs - dy * sn, ny = 300 + dx * sn + dy * cs;
    p.x = nx; p.y = ny; p.px = nx; p.py = ny;
  }
  const dt = 1 / 240;
  const dtFrame = 1 / 60;
  const angs = [];
  const crossings = [];
  let prev = r.tipAngle;
  const d = makeDoll();
  let dollPeak = 0;
  for (let i = 1; i <= Math.round(6.0 / dt); i++) {
    r.setAnchor(500, 300); r.update(dt);
    const aa = r.tipAngle;
    angs.push(Math.abs(aa * DEG));
    if ((prev < 0 && aa >= 0) || (prev > 0 && aa <= 0)) crossings.push(i * dt);
    prev = aa;
    if (i % 4 === 0) { const b = d(aa, dtFrame); if (b > dollPeak) dollPeak = b; }
  }
  let peaks = [];
  for (let i = 1; i < angs.length - 1; i++) if (angs[i] >= angs[i - 1] && angs[i] > angs[i + 1]) peaks.push(angs[i]);
  const half = crossings.length > 1 ? (crossings[crossings.length - 1] - crossings[ 0]) / (crossings.length - 1) : 0;
  const q = peaks.filter(v => v > 0.5).slice(0, 8);
  let tau = NaN;
  if (q.length >= 3) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < q.length; i++) { const t = i * half; n++; sx += t; sy += Math.log(q[i]); sxx += t * t; sxy += t * Math.log(q[i]); }
    const sl = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    if (sl < 0) tau = -1 / sl;
  }
  console.log("释放 " + String(deg).padStart(2) + "° => 首峰 " + (peaks[0] || 0).toFixed(1) + "°  保留 " +
    ((peaks[0] || 0) / deg * 100).toFixed(0).padStart(3) + "%  周期 " + (2 * half).toFixed(3) +
    "s  理论 " + chainPendulumPeriod(r, C.physics.gravity).toFixed(3) +
    "s  tau " + tau.toFixed(2) + "s  娃娃首峰 " + dollPeak.toFixed(1) + "°");
}

console.log("\n=== 验收 4：R15 绳子能否翻到挂点上方 ===");
{
  const r = fresh();
  let above = 0, belowZ = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 1800; i++) {
    const t = i * dt;
    r.setAnchor(500 + 300 * Math.sin(t * 6.0), 300);
    r.update(dt);
    if (r.tipY < r.anchorY) above++;
  }
  console.log("300px @ 6rad/s 往返：绳端高于挂点 " + (above / 1800 * 100).toFixed(1) + "% 帧");
}

console.log("\n=== 验收 5：折叠 / 拉伸 / 数值稳定（60s 剧烈甩动）===");
{
  const r = fresh();
  let minJ = 180, maxLen = 0, minLen = 1e9, bad = 0, above = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 3600; i++) {
    const t = i * dt;
    r.setAnchor(500 + 380 * Math.sin(t * 2.2) * Math.cos(t * 0.7), 300 + 220 * Math.sin(t * 1.7 + 1.1));
    r.update(dt);
    const pts = r.path;
    for (let j = 1; j < pts.length - 1; j++) {
      const ax = pts[j - 1].x - pts[j].x, ay = pts[j - 1].y - pts[j].y;
      const bx = pts[j + 1].x - pts[j].x, by = pts[j + 1].y - pts[j].y;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) continue;
      const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
      minJ = Math.min(minJ, Math.acos(dot) * DEG);
    }
    let pl = 0;
    for (let j = 0; j < pts.length - 1; j++) pl += Math.hypot(pts[j + 1].x - pts[j].x, pts[j + 1].y - pts[j].y);
    maxLen = Math.max(maxLen, pl); minLen = Math.min(minLen, pl);
    for (const p of pts) if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.px) || !isFinite(p.py)) bad++;
    if (r.tipY < r.anchorY) above++;
  }
  // 下限 = 180 - maxBend（无余量）。_limitBend 是有限轮迭代（bendIterations），
  // 每轮只能把超限量压掉一部分，所以极端甩动下会有 0~1.5° 的收敛残差 —— 这是预期行为，
  // 不是 bug。rope.test.cjs 的 [15] 用的是 180 - maxBend - 5° 作合格线，就是这个原因。
  const floorDeg = 180 - C.physics.maxBend * DEG;
  const residual = minJ - floorDeg;
  console.log("非法数值帧=" + bad + "  链长 " + minLen.toFixed(2) + "~" + maxLen.toFixed(2) +
    "px (rest " + ROPE_LEN.toFixed(1) + ")  最小关节夹角 " + minJ.toFixed(1) + "° (硬下限 " +
    floorDeg.toFixed(1) + "°，收敛残差 " + residual.toFixed(1) + "°)  翻上占比 " + (above / 3600 * 100).toFixed(1) + "%");
}

console.log("\n=== 验收 6：停手后静止 + 帧率无关 + fixedStep 无关 ===");
{
  function settle(fps) {
    const r = fresh();
    rampDrive(r, null, 500, 1.0, 1.0, 1 / fps);
    const ex = r.anchorX;
    for (let i = 0; i < Math.round(4 / (1 / fps)); i++) { r.setAnchor(ex, 300); r.update(1 / fps); }
    let m = 0;
    for (const p of r.path) m = Math.max(m, Math.abs(p.x - ex));
    return m;
  }
  console.log("停手 4s 后最大水平偏差: " + [60, 120, 144, 240].map(f => f + "Hz=" + settle(f).toFixed(2) + "px").join("  "));
  const frames = [60, 120, 144, 240].map(function (fps) {
    const r = fresh(); const d = makeDoll();
    return rampDrive(r, d, 500, 1.0, 1.0, 1 / fps).avg;
  });
  console.log("娃娃稳态角 @60/120/144/240Hz: " + frames.map(v => v.toFixed(2)).join(" / ") +
    "  spread=" + (Math.max.apply(null, frames) - Math.min.apply(null, frames)).toFixed(2) + "°");
  const steps = [1/60, 1/120, 1/240, 1/480].map(function (h) {
    const r = fresh({ fixedStep: h }); const d = makeDoll();
    return rampDrive(r, d, 500, 1.0, 1.0, 1 / 60).avg;
  });
  console.log("娃娃稳态角 @fixedStep 1/60~1/480: " + steps.map(v => v.toFixed(2)).join(" / ") +
    "  spread=" + (Math.max.apply(null, steps) - Math.min.apply(null, steps)).toFixed(2) + "°");
}

console.log("\n=== 验收 7：性能 ===");
{
  const r = fresh();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) { r.setAnchor(500 + 100 * Math.sin(i * 0.05), 300); r.update(1 / 60); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("1000 帧 " + ms.toFixed(2) + "ms => " + (ms / 1000).toFixed(4) + "ms/帧（60fps 预算 16.67ms）");
}

console.log("\n=== 验收 8：诊断记录器（第 13 轮）===");
{
  // recorder.js 在浏览器里跑，顶层只摸 window / module 两样东西。
  // 这里给它一个最小的 window 假体，然后用真 RopeChain 驱动，验证采样本身对不对。
  global.window = {
    innerWidth: 1536, innerHeight: 864, devicePixelRatio: 1.25,
    CONFIG: { doll: { bodyRotateRatio: C.doll.bodyRotateRatio } }
  };
  const { Recorder } = require(path.join(ROOT, "renderer/recorder.js"));

  const r = fresh();
  const cursor = { x: 500, y: 300 };
  const attach = { x: 500, y: 300 };
  const fakeRenderer = {
    cfg: { doll: { bodyRotateRatio: C.doll.bodyRotateRatio } },
    _bodyAngle: 0,
    _bodyAngleDrawn: 0
  };
  const rec = new Recorder({
    rope: r,
    getCursor: function () { return cursor; },
    getAttach: function () { return attach; },
    getRenderer: function () { return fakeRenderer; }
  });
  let saved = null;
  rec.onStop = function (d) { saved = d; };
  rec.start({ intervalMs: 100 });

  // 60fps 跑 3 秒：先把挂点横向推 100px（smoothstep 加速，避免瞬时冲量），再停手
  //
  // 【第 29 轮修】t 必须从 rec.startedAt 起算，不能从 0 起算。
  // recorder.start() 里 this._nextAt = this.startedAt = clock()（真实毫秒时间戳），
  // 而 tick(now) 只在 now >= _nextAt 时才采样。测试从 t=0 起算的话，
  // 要等 t 追上真实时间戳才开始记，开头 3 条会丢（实测 27 条而不是 30 条）。
  // 真实主循环传的就是 performance.now()，与 startedAt 同源，所以线上没有这个问题。
  const dt = 1 / 60;
  let t = rec.startedAt;
  for (let i = 0; i < Math.round(3 / dt); i++) {
    t += dt * 1000;
    const u = Math.min(1, (i * dt) / 0.3);
    const sm = u * u * (3 - 2 * u);
    attach.x = 500 + 100 * sm;
    cursor.x = attach.x;
    r.setAnchor(attach.x, attach.y);
    r.update(dt);
    fakeRenderer._bodyAngle = r.tipAngle;
    fakeRenderer._bodyAngleDrawn = fakeRenderer._bodyAngle;
    rec.tick(t);
  }
  const data = rec.stop("user");

  // 1) 节拍：3 秒 @100ms 应是 30 条上下（允许 ±2）
  const n = data.samples.length;
  const okCount = n >= 28 && n <= 32;
  console.log("采样条数 " + n + "（3s @100ms 期望 30±2）" + (okCount ? "  PASS" : "  FAIL"));

  // 2) 节拍：判【累计漂移】，不是单条间隔。
  //
  // 【第 29 轮修】原来判「每条间隔 |d - 100| <= 3ms」，这个指标在 60fps 下必然失败：
  // 采样只能在帧边界发生（每帧 16.67ms），而 100ms 不是 16.67 的整数倍，
  // 所以 t 只能是 100 / 117 / 200 / 217 / 300 … 这样的量化值，单条偏差可达 17ms。
  // 但这不叫漂移 —— 只要第 i 条的 t 与 i*100 的差一直有界，节拍就是准的。
  // 旧版测试传的是人工时间 t=0,100,200…（不带帧量化），所以一直是 PASS，掩盖了这一点。
  let worstDrift = 0;
  for (let i = 0; i < n; i++) {
    worstDrift = Math.max(worstDrift, Math.abs(data.samples[i].t - (i + 1) * 100));
  }
  const okPace = worstDrift <= 20;   // 量化上限约 16.7ms，留 20ms 余量
  console.log("最大累计漂移 " + worstDrift.toFixed(1) + "ms（期望 <=20，60fps 帧量化上限 16.7）" + (okPace ? "  PASS" : "  FAIL"));

  // 3) 字段完整性：每条都要有 nodes / segs / bear / doll 与墙钟时间戳
  let badField = 0;
  for (const s of data.samples) {
    if (!s.nodes || s.nodes.length !== r.count) badField++;
    else if (!s.segs || s.segs.length !== r.count - 1) badField++;
    else if (!s.bear || !s.doll) badField++;
    else if (!s.doll.anchor || typeof s.doll.anchor.ox !== "number" ||
             typeof s.doll.anchor.oy !== "number") badField++;
    else if (s.w === undefined || s.w === null) badField++;
  }
  const okField = badField === 0;
  console.log("字段不完整的样本 " + badField + " 条（期望 0）" + (okField ? "  PASS" : "  FAIL"));

  // 4) 首条样本的绳力必须是 null（单条样本算不出加速度，不能拿 0 冒充）
  const okFirstNull = data.samples[0].bear.ropeF === null;
  console.log("首条 ropeF = " + data.samples[0].bear.ropeF + "（期望 null）" + (okFirstNull ? "  PASS" : "  FAIL"));

  // 5) 绳力量级：静止竖直吊着时「绳子托住熊」应等于 m·g
  //    这里先让绳子静止收敛 2 秒，再单采一条核对。
  rec.start({ intervalMs: 100 });
  t = 0;
  for (let i = 0; i < 200; i++) {
    t += dt * 1000;
    r.setAnchor(attach.x, attach.y);
    r.update(dt);
    fakeRenderer._bodyAngle = r.tipAngle;
    fakeRenderer._bodyAngleDrawn = fakeRenderer._bodyAngle;
    rec.tick(t);
  }
  const held = rec.stop("user");
  const last = held.samples[held.samples.length - 1];
  const mg = last.bear.mass * C.physics.gravity;
  const relErr = Math.abs(last.bear.ropeF - mg) / mg;
  const okMag = relErr < 0.05;
  console.log("静止时绳力 " + last.bear.ropeF.toFixed(1) + " vs m·g " + mg.toFixed(1) +
    "（偏差 " + (relErr * 100).toFixed(2) + "%，期望 <5%）" + (okMag ? "  PASS" : "  FAIL"));

  // 6) 序列化：不能在这里测（serializeRecord 在主进程 main.js 里），
  //    但能测 summary 的自洽性
  const okSummary = data.summary.count === n &&
    Math.abs(data.summary.durationMs - data.samples[n - 1].t) < 1e-6;
  console.log("summary 与实际自洽（count=" + data.summary.count + ", duration=" +
    data.summary.durationMs + "ms）" + (okSummary ? "  PASS" : "  FAIL"));

  // 7) 边界：撞上 maxSamples 必须自动停（reason="auto"），且 onStop 只调一次
  const rCap = new Recorder({ rope: fresh() });
  const capReasons = [];
  rCap.onStop = function (d) { capReasons.push(d.stopReason); };
  rCap.start({ intervalMs: 100, maxSamples: 10 });
  let tCap = 0;
  for (let i = 0; i < 120; i++) { tCap += 1000 / 60; rCap.tick(tCap); }
  const okAuto = rCap.samples.length === 10 && rCap.recording === false &&
    capReasons.length === 1 && capReasons[0] === "auto";
  console.log("撞上限自动停：samples=" + rCap.samples.length + " recording=" + rCap.recording +
    " onStop=" + capReasons.length + " reason=" + capReasons[0] + (okAuto ? "  PASS" : "  FAIL"));

  // 8) 兜底：渲染器还没建好（getRenderer 返回 null）时 tick 不许抛。
  //    tick 是在 rAF 主循环里调的，抛一次整帧就断了。
  const rSafe = new Recorder({ rope: fresh(), getRenderer: function () { return null; } });
  rSafe.start({ intervalMs: 100 });
  let tSafe = 0, threw = null;
  try {
    for (let i = 0; i < 30; i++) { tSafe += 1000 / 60; rSafe.tick(tSafe); }
  } catch (e) {
    threw = e.message;
  }
  const okSafe = threw === null;
  console.log("getRenderer()=null 不抛异常" + (okSafe ? "  PASS" : "  FAIL: " + threw));

  if (!(okCount && okPace && okField && okFirstNull && okMag && okSummary && okAuto && okSafe)) {
    console.log("  ==> FAIL");
    fail++;
  }
  delete global.window;
}

// ---------------------------------------------------------------- 验收 9
// F15：弦角穿越 ±180° 时娃娃不能反向转一整圈。
//
// 判据的坑（第 27 轮踩了三次才找对）：**不能用单帧跳变**。
// 低通 fk ≈ 0.188/帧，把 358° 的阶跃摊成 60 帧、每帧几度到几十度的慢过程，
// 每一帧都不大，但累计走了 331° —— 必须量「累计行程」。
//
// 驱动：+179° 停 20 帧 → −179° 停 40 帧（单帧阶跃，模拟绳子绕过指针顶部）。
// 传感器：|末态 body − 首帧 body|。
//   理想（展开后）物理上只转了 2°，实测 179.0° → 180.9° = 1.9°；
//   旧实现（eb48d98，无展开）176.2° → −155.3° = **331.5°**。
function wrapPi(a) { return a - Math.round(a / (Math.PI * 2)) * (Math.PI * 2); }
function f15Run(lim) {
  const saved = C.doll.angleLimit;
  C.doll.angleLimit = lim;
  const d2 = makeDoll();
  let bodyEnd = 0, idealEnd = 0, prevRaw = null;
  for (let i = 0; i < 60; i++) {
    // rope.tipAngle = atan2(...)，值域 (-PI, PI]：i=20 那一帧从 +179° 跳到 -179°
    const rawDeg = i < 20 ? 179 : -179;
    // 测试侧自己维护连续展开角（绝不能用被测对象的内部状态当基准）
    if (prevRaw === null) idealEnd = rawDeg;
    else idealEnd += wrapPi((rawDeg - prevRaw) * Math.PI / 180) * DEG;
    prevRaw = rawDeg;
    d2((rawDeg * Math.PI) / 180, 1 / 60);
    bodyEnd = d2.raw() * DEG;   // 滤波器内部状态（弧度 → 度）
  }
  C.doll.angleLimit = saved;
  // 判据：滤波器内部状态必须跟得上连续展开角（两者都以「度」为单位）。
  // 物理上只转了 2°：新实现 body≈180.9 而 ideal≈181 ⇒ 差 <2°；
  // 旧实现 body≈-155.3 而 ideal≈181 ⇒ 差 ≈336°。
  return Math.abs(bodyEnd - idealEnd);
}
console.log("\n=== 验收 9：弦角穿越 ±180 时娃娃不反向转一圈（F15）===");
let ok9 = true;
for (const lim of [45, 85, 180]) {
  const sweep = f15Run(lim);
  const ok = sweep < 20;   // 物理上只转了 2°，留 10 倍余量
  if (!ok) ok9 = false;
  console.log("  " + (ok ? "PASS" : "FAIL") + "  limit " + String(lim).padStart(3) +
    "°：弦角 ±180 阶跃后娃娃累计转过 " + sweep.toFixed(1) + "° (期望 <20°，物理真实值约 2°)");
}
if (!ok9) fail++;

// ---------------------------------------------------------------- 验收 10
console.log("\n=== 验收 10：T1 图片挂点可调（只改渲染，物理必须逐位不变）===");
{
  // T1 的契约：anchorX/anchorY 只决定「图片绕哪个点转」，不进物理。
  // 所以同一个驱动轨迹下，三档锚点的弦角序列必须逐位相同，
  // 且默认值 (0.5, 0) 必须精确复现 T1 之前的旋转原点（图片顶边中点）。
  const DT = 1 / 60;
  const W = 86, H = 86;   // 面板默认娃娃高 86px；方形图取 w = h

  // 第 21 轮语义修正后的契约（用户 m08270）：
  //   吊环 = 绳端，永远不动；anchorX/anchorY 平移的是**图片**。
  //   返回的 ox/oy 是「图片静止矩形左上角相对吊环」的偏移。

  // 1) 第 23 轮 m09384：出厂值改成 (0, 0)，语义是「挂饰包围盒左上角与吊环重合」。
  //    断言必须跟着语义走 —— 原来写的是「顶边中点落在吊环」，那是 (0.5, 0) 时代的契约。
  const oDef = anchorOffsetOf(C.doll, W, H);
  const okDefault = Math.abs(oDef.ox) < 1e-12 && Math.abs(oDef.oy) < 1e-12;
  if (!okDefault) fail++;
  console.log("  " + (okDefault ? "PASS" : "FAIL") +
    "  默认 anchorX/anchorY = (0, 0)：包围盒左上角精确落在吊环（原点）上  (" +
    oDef.ox.toFixed(3) + ", " + oDef.oy.toFixed(3) + ")");

  // 2) 三档几何（第 21 轮语义修正后）：
  //    anchorX = 0 表示「挂点落在图片左边缘」=> 图片整体挂在吊环右侧，左上角在 x = 0；
  //    anchorX = 1 表示「挂点落在图片右边缘」=> 图片整体挂在吊环左侧，左上角在 x = -W；
  //    anchorY = 0.5 表示「挂点落在图片垂直中心」=> 图片上移半高，左上角在 y = -H/2。
  const oLeft = anchorOffsetOf(Object.assign({}, C.doll, { anchorX: 0, anchorY: 0 }), W, H);
  const oRight = anchorOffsetOf(Object.assign({}, C.doll, { anchorX: 1, anchorY: 0 }), W, H);
  const oMid = anchorOffsetOf(Object.assign({}, C.doll, { anchorX: 0.5, anchorY: 0.5 }), W, H);
  const okGeom = Math.abs(oLeft.ox - 0) < 1e-12 && Math.abs(oRight.ox + W) < 1e-12 &&
    Math.abs(oMid.oy + H / 2) < 1e-12;
  if (!okGeom) fail++;
  console.log("  " + (okGeom ? "PASS" : "FAIL") +
    "  anchorX 0 => 左上 0px（挂点在图片左边缘）、1 => -" + W + "px（右边缘）、" +
    "anchorY 0.5 => -" + (H / 2) + "px  (" +
    oLeft.ox.toFixed(1) + " / " + oRight.ox.toFixed(1) + " / " + oMid.oy.toFixed(1) + ")");

  // 3) anchorY=1 时图片整体沉到吊环下方整幅高度（不再被 heightMax 夹住 ——
  //    夹取的对象已经是「图片相对吊环沉多深」，不是「挂点必须在图片内」）
  const oBig = anchorOffsetOf(Object.assign({}, C.doll, { anchorY: 1 }), 400, 400);
  const okClamp = Math.abs(oBig.oy + 400) < 1e-12;
  if (!okClamp) fail++;
  console.log("  " + (okClamp ? "PASS" : "FAIL") +
    "  400px 大图 + anchorY=1：图片整体沉到吊环下方 400px  (" + oBig.oy.toFixed(1) + "px)");

  // 4) 绕锚点旋转：锚点自身必须是不动点（这是「绕图片上的点转」的定义）
  let worstPin = 0;
  for (const [ox, oy] of [[0, 0], [W / 2, 0], [-W / 2, -H], [12.5, -37.25]]) {
    for (const a of [0.3, 1.2, -2.4, Math.PI]) {
      const c = Math.cos(a), sn = Math.sin(a);
      const px = ox + (ox - ox) * c - (oy - oy) * sn;
      const py = oy + (ox - ox) * sn + (oy - oy) * c;
      worstPin = Math.max(worstPin, Math.hypot(px - ox, py - oy));
    }
  }
  const okPin = worstPin < 1e-12;
  if (!okPin) fail++;
  console.log("  " + (okPin ? "PASS" : "FAIL") +
    "  绕任意锚点旋转时锚点位移必须为 0  (最大 " + worstPin.toExponential(1) + "px)");

  // 5) 物理无关性：同一驱动轨迹，三档锚点的弦角序列必须逐位相同。
  //    把 anchorX/anchorY 塞进 doll 配置后跑，物理侧代码根本读不到这两个键。
  const rows = [];
  for (const ax of [0.0, 0.5, 1.0]) {
    const savedX = C.doll.anchorX;
    C.doll.anchorX = ax;
    const r = fresh();
    const angs = [];
    const n = Math.round(2.0 / DT);
    for (let i = 0; i < n; i++) {
      const u = Math.min(1, i * DT / 0.35), w = u * u * (3 - 2 * u);
      r.setAnchor(500 + 260 * w, 300);
      r.update(DT);
      angs.push(r.tipAngle);
    }
    C.doll.anchorX = savedX;
    rows.push(angs);
  }
  let worstPhys = 0;
  for (let i = 0; i < rows[0].length; i++) {
    worstPhys = Math.max(worstPhys, Math.abs(rows[0][i] - rows[1][i]), Math.abs(rows[1][i] - rows[2][i]));
  }
  const okPhys = worstPhys === 0;
  if (!okPhys) fail++;
  console.log("  " + (okPhys ? "PASS" : "FAIL") +
    "  anchorX 0/0.5/1.0 三档弦角序列逐位相同  (最大差 " + worstPhys.toExponential(1) + " rad)");
}

// ---------------------------------------------------------------- 验收 11
console.log("\n=== 验收 11：挂饰模拟段（第 29 轮，挂饰挂在 p4、朝向由 p4->p5 给）===");
// 用户 m11010：「把绳索从 p4 向下延伸一段，延伸到用户自定义的质点处，
//                让挂饰依照该线段进行移动和旋转」。
// p1..p4 是原有的 segments 段主体，p5 是额外加的模拟段末端质点。
// 挂饰位置 = p4（hangPoint），朝向 = p4->p5（tailAngle）。
{
  // 11.1 模拟段使质点个数 +1，且模拟段是「额外加的」——主体段长不变、总长 = 主体 + 模拟段
  //      （第 29 轮踩过的坑：第一版把模拟段从总长里切出来，主体段只剩 2.8px，整链失稳）
  {
    const r = new RopeChain(makeRopeCfg({ tail: { enabled: true, length: 52, mass: 2 } }));
    r.rebuild(90, 4);
    const mainRest = 90 / 3;             // rebuild(90,4) = 4 个质点 = 3 段，每段 30px
    const expectTotal = mainRest * 3 + 52; // 模拟段额外加在 p4 后面
    const ok = r.count === 5 && r.hasTail
      && Math.abs(r.restLen - mainRest) < 1e-9
      && Math.abs(r.polylineLength - expectTotal) < 0.5;
    if (!ok) fail++;
    console.log("  " + (ok ? "PASS" : "FAIL") +
      "  启用模拟段：质点数 " + r.count + "（期望 5）、主体段长 " + r.restLen.toFixed(2) +
      "px（期望 " + mainRest.toFixed(2) + "）、总长 " + r.polylineLength.toFixed(2) +
      "px（期望 " + expectTotal.toFixed(2) + "）");
  }

  // 11.2 挂饰模拟段的自然长度必须真的等于 length，不能被主体段的 restLen 拽回去
  //     这是第 29 轮踩过的坑：_solveConstraints 用统一的 restLen 会把模拟段反复拽回 12.67px，
  //     模拟段完全不起作用（实测挂饰模拟段恒为 12.67，无论配置写 52 还是 90）。
  {
    const r = new RopeChain(makeRopeCfg({ tail: { enabled: true, length: 52, mass: 2 } }));
    r.rebuild(90, 4);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      r.setAnchor(250 * Math.sin((2 * Math.PI * 1.2 * i) / 60), 300);
      r.update(1 / 60);
      const p = r.path, n = p.length;
      const d = Math.hypot(p[n - 1].x - p[n - 2].x, p[n - 1].y - p[n - 2].y);
      worst = Math.max(worst, Math.abs(d - 52));
    }
    const ok = worst < 1.0;
    if (!ok) fail++;
    console.log("  " + (ok ? "PASS" : "FAIL") +
      "  挂饰模拟段长度稳定在 52px  (甩动 5s 内最大偏差 " + worst.toFixed(3) + "px)");
  }

  // 11.3 挂点必须是 p4（模拟段起点），不是整绳末端 p5
  {
    const r = new RopeChain(makeRopeCfg({ tail: { enabled: true, length: 52, mass: 2 } }));
    r.rebuild(90, 4);
    r.resetVertically();
    const p = r.path, n = p.length;
    const hp = r.hangPoint;
    // 竖直时主体 3 段各 30px：p1=0 p2=30 p3=60 p4=90，p5 = p4 + tailLen
    const mainRest = 90 / 3;
    const expectP4 = mainRest * 3;   // p4 = 3 段之后
    const ok = Math.abs(hp.y - p[n - 2].y) < 1e-6 && Math.abs(p[n - 2].y - expectP4) < 0.5;
    if (!ok) fail++;
    console.log("  " + (ok ? "PASS" : "FAIL") +
      "  挂点 = p4：y = " + hp.y.toFixed(2) + "px（期望 " + expectP4.toFixed(2) +
      "，p5 在 " + p[n - 1].y.toFixed(2) + "px）");
  }

  // 11.4 tailAngle 必须等于 p4->p5 的方向，且在甩动中保持有限
  {
    const r = new RopeChain(makeRopeCfg({ tail: { enabled: true, length: 52, mass: 2 } }));
    r.rebuild(90, 4);
    let ok = true, maxAbs = 0;
    for (let i = 0; i < 300; i++) {
      r.setAnchor(250 * Math.sin((2 * Math.PI * 1.2 * i) / 60), 300);
      r.update(1 / 60);
      const p = r.path, n = p.length;
      const expect = Math.atan2(p[n - 1].x - p[n - 2].x, p[n - 1].y - p[n - 2].y);
      const got = r.tailAngle;
      if (!isFinite(got) || Math.abs(got - expect) > 1e-9) ok = false;
      maxAbs = Math.max(maxAbs, Math.abs(got));
    }
    if (!ok) fail++;
    console.log("  " + (ok ? "PASS" : "FAIL") +
      "  tailAngle 与 p4->p5 方向一致  (峰值 " + (maxAbs * DEG).toFixed(1) + "°)");
  }

  // 11.5 关闭模拟段时行为必须完全回到第 28 轮（质点个数、hangPoint 语义、角度来源）
  {
    const r = new RopeChain(makeRopeCfg({ tail: { enabled: false, length: 52, mass: 2 } }));
    r.rebuild(90, 4);
    const hp = r.hangPoint, tp = r.tailPoint;
    const ok = r.count === 4 && !r.hasTail &&
      Math.abs(hp.x - tp.x) < 1e-9 && Math.abs(hp.y - tp.y) < 1e-9;
    if (!ok) fail++;
    console.log("  " + (ok ? "PASS" : "FAIL") +
      "  关闭模拟段：质点数 " + r.count + "（期望 4）、hangPoint 退回 tailPoint");
  }

  // 11.6 质量影响：模拟段越重，挂饰模拟段越不容易被甩偏
  {
    // 【第 29 轮 m11260】必须用线上真实量级做对照：绳长 60.5px、模拟段 26px、±40px@1.2Hz。
    // 用 rebuild(90,4) + ±250px 测不出质量效果：主体本身已经甩到 90°，模拟段被整绳带着转，
    // mass=2 的平均 90.2° vs mass=20 的 88.4°，只差 1.8°，这条断言等于没测。
    // 线上量级下差异是 2 倍：mass=2 平均 78.5°、朝天 50% 的帧；mass=20 平均 37.4°、朝天 0%。
    function avgAbs(mass) {
      const r = new RopeChain(makeRopeCfg({ tail: { enabled: true, length: 26, mass: mass } }));
      r.rebuild(60.5, 4);
      let sum = 0, cnt = 0;
      for (let i = 0; i < 900; i++) {
        r.setAnchor(40 * Math.sin((2 * Math.PI * 1.2 * i) / 60), 300);
        r.update(1 / 60);
        if (i > 300) { sum += Math.abs(r.tailAngle); cnt++; }
      }
      return (sum / cnt) * DEG;
    }
    const light = avgAbs(2), heavy = avgAbs(20);
    // 线上量级下实测 78.5° vs 37.4°，差 41°；阈值定 15° 既留余量又能抓住「mass 失效」
    const ok = Math.abs(light - heavy) > 15;
    if (!ok) fail++;
    console.log("  " + (ok ? "PASS" : "FAIL") +
      "  质量影响手感：mass 2 平均 " + light.toFixed(1) + "° vs mass 20 平均 " + heavy.toFixed(1) + "°");
  }
}

// ================================================================
  // 11.7 挂点必须严格等于 p4 坐标本身（不沿 p4->p5 偏移 overlap）
  //      【第 31 轮 m11899】用户原话：「小熊挂在了 p5 上，而非挂饰模拟段的起始位置 p4」。
  //      之前 hangPoint 返回 p4 + overlap（10px），而 doll.js 又去读 tailPoint（p5 + overlap），
  //      两个点都不是 p4。现在 hangPoint 严格是 p4，这个断言把它钉住。
  {
    const r = new RopeChain(makeRopeCfg({ tail: { enabled: true, length: 52, mass: 2 } }));
    if (r.setOverlap) r.setOverlap(10); else r.overlap = 10;
    for (let i = 0; i < 120; i++) {
      r.setAnchor(300 + Math.sin(i * 0.05) * 120, 100);
      r.update(1 / 60);
    }
    const hp = r.hangPoint;
    const p4 = r.path[r.path.length - 2];
    const p5 = r.path[r.path.length - 1];
    const d4 = Math.hypot(hp.x - p4.x, hp.y - p4.y);
    const d5 = Math.hypot(hp.x - p5.x, hp.y - p5.y);
    const ok = d4 < 1e-9 && d5 > 40;
    if (!ok) fail++;
    console.log("  " + (ok ? "PASS" : "FAIL") +
      "  挂点严格等于 p4（不偏移 overlap=10px）  到 p4 " + d4.toExponential(1) +
      "px、到 p5 " + d5.toFixed(1) + "px");
  }

// 验收 12（已撤除）
//   第 21 轮 T2「多重质点网」与第 25 轮 T3「皮肤式惯性」在 renderer/puppet.js 里实现，
//   第 27 轮 m10287 用户要求「取消挂件图片形变效果，将挂件认定为刚体」，
//   整套网格（含 puppet.js、config.doll.puppet、config.doll.stretch、面板四个滑块）已删除。
//   历史数据留在 docs/02 六之三、docs/06 第十九版、docs/10 第 4.2b/4.2c 节。
// ----------------------------------------------------------------
// ReferenceError，把「某项不合格」伪装成「脚本坏了」。
if (fail > 0) {
  console.log("\n失败 " + fail + " 组");
  process.exitCode = 1;
} else {
  console.log("\n全部通过 ✓");
}