// verify.cjs —— 验收测量脚本（不是回归测试，回归用 rope.test.cjs）
//
// 它用 vm 直接读 renderer/config.js 的默认值（不手抄参数），复刻 doll.js 的
// 死区 -> 低通 -> tanh 软限幅渲染链，然后测 7 组固定指标：
//   1) 匀速拖动稳态角（R13 偏移 + 旋转）
//   2) 正弦往返的娃娃角动态范围（R13）
//   3) 自由摆周期 / 振幅衰减 tau（R14）
//   4) 绳端翻到挂点上方的帧占比（R15）
//   5) 60s 剧烈甩动的折叠 / 拉伸 / 非法数值
//   6) 停手静止 + 帧率无关 + fixedStep 无关
//   7) 性能
//   8) 诊断记录器（第 13 轮）：每 0.1s 采样、字段完整、绳力量级与解析式相符
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
function fresh(over) {
  const cfg = mkCfg(over);
  const r = new RopeChain(cfg);
  r.setAnchor(500, 300);
  r.rebuild(ROPE_LEN, cfg.segments + 1);   // segments = 段数，rebuild 要的是质点个数
  r.resetVertically();
  return r;
}
// 复刻 doll.js 的渲染链：死区 -> 低通(tau) -> tanh 软限幅 -> bodyRotateRatio
function makeDoll() {
  let body = 0;
  return function step(rawAngle, dtSec) {
    let a = rawAngle;
    if (Math.abs(a) < C.doll.angleDeadzone) a = 0;
    const fk = 1 - Math.exp(-dtSec / C.doll.bodyAngleTau);
    body += (a - body) * fk;
    let out = body * C.doll.bodyRotateRatio;
    const lim = C.doll.angleLimit / DEG, over = C.doll.angleLimitOvershoot / DEG;
    // 与 doll.js 的 _softLimitAngle 保持一致：180° = 不限制（恒等直通）
    if (C.doll.angleLimit < 180 && Math.abs(out) > lim) {
      out = Math.sign(out) * (lim + over * Math.tanh((Math.abs(out) - lim) / over));
    }
    return Math.abs(out) * DEG;
  };
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
  const dt = 1 / 60;
  let t = 0;
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

  // 2) 每条样本的间隔都必须落在 100ms 附近（t 由主循环 now 决定，允许 ±2ms）
  let worstDt = 0;
  for (let i = 2; i < n; i++) {
    const d = data.samples[i].t - data.samples[i - 1].t;
    worstDt = Math.max(worstDt, Math.abs(d - 100));
  }
  const okPace = worstDt <= 3;
  console.log("最大节拍偏差 " + worstDt.toFixed(1) + "ms（期望 <=3）" + (okPace ? "  PASS" : "  FAIL"));

  // 3) 字段完整性：每条都要有 nodes / segs / bear / doll 与墙钟时间戳
  let badField = 0;
  for (const s of data.samples) {
    if (!s.nodes || s.nodes.length !== r.count) badField++;
    else if (!s.segs || s.segs.length !== r.count - 1) badField++;
    else if (!s.bear || !s.doll) badField++;
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
    process.exitCode = 1;
  }
  delete global.window;
}