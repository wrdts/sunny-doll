// rope.test.cjs  --  绳索物理回归测试（纯 Node，不需要 Electron）
// 运行：node rope.test.cjs
//
// 本文件与 renderer/config.js 的参数保持一致。
// 历史教训：旧版测试用的是一套"额外柔化"的配置，且 sweep() 里模拟了
// 一个早已不存在的渲染层平滑跟随（* 0.75），导致测试全绿但线上手感全错。
// 现在测试配置直接对齐线上，且不再有任何假平滑。
"use strict";

const { RopeChain } = require("./renderer/rope.js");

// ---------- 与 renderer/config.js 对齐的参数 ----------
const DEG = 180 / Math.PI;
// 【测试配置必须和 renderer/config.js 的线上值一致】
// 否则测的是一个不存在的配置。改完 config.js 记得回来同步这里。
// 与线上的唯一差异：turbulence 归零，保证可复现。
const PHYS = {
  gravity: 3300,             // 线上值。按 3 段绳补偿过，实测自由摆周期 0.77s
  drag: 0.00015,
  turbulence: 0,            // 测试里关掉湍流，保证可复现
  followMode: "velocity",
  maxBend: 1.50,
  bendIterations: 10,
  fixedStep: 1 / 240,
  maxStepsPerFrame: 48,
  maxAccumulator: 0.1
};
const CHAIN = {
  segments: 3,               // 线上值 = 4 质点 = 2 个可弯关节
  iterations: 2,
  stiffness: 1.0,
  elasticity: false,
  maxStretch: 1.35,
  tailMass: 1.6,
  dampingPerSecond: 0.30
};
const ROPE_LEN = 90;
const DAMP_K = CHAIN.dampingPerSecond;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  PASS  " + name + (detail ? "  (" + detail + ")" : ""));
  } else {
    failures++;
    console.log("  FAIL  " + name + (detail ? "  (" + detail + ")" : ""));
  }
}

// 【段数 vs 节点数】cfg.segments 是【段数】，rebuild() 的第二个参数是【质点个数】。
// 段数 2 => 3 个质点 => 有 1 个可弯关节。传错就会得到一条没有任何弯曲自由度的直线。
function nodeCountOf(segments) {
  return Math.max(2, Math.round(segments || 2) + 1);
}

function fresh(segments, ropeLen) {
  const cfg = Object.assign({}, PHYS, CHAIN);
  if (segments !== undefined) cfg.segments = segments;
  const r = new RopeChain(cfg);
  r.setAnchor(500, 300);
  r.rebuild(ropeLen || ROPE_LEN, nodeCountOf(cfg.segments));
  r.resetVertically();
  return r;
}

/** 让支点匀速移动 frames 帧（dx/dy 是"每帧"位移，不含任何假平滑） */
function sweep(r, x0, y0, dx, dy, frames, dt) {
  dt = dt || 1 / 60;
  for (let i = 0; i < frames; i++) {
    r.setAnchor(x0 + dx * i, y0 + dy * i);
    r.update(dt);
  }
}

/**
 * 平滑加速到 vx（px/s）再匀速：先用 smoothstep 在 rampSec 秒内把速度从 0 拉到 vx，
 * 然后匀速 holdSec 秒。返回匀速段的平均/最大 tipAngle（度）、平均水平滞后 avgDX 与结束时的锚点 x。
 *
 * 【为什么不能用 sweep 起步】sweep 是第一帧就给满速度，等于给摆锤一次 vx 的冲量。
 * 1200px/s 的冲量按能量守恒 ½v² = gL(1-cosθ) 算，θ 已经到 180°，
 * 也就是绳子会被直接甩过顶点进入混沌区 —— 那时测到的既不是"拖动时的滞后角"，
 * 也不是"帧率无关性"，而是一段混沌轨迹的随机采样。
 */
function rampDrive(r, vx, rampSec, holdSec, dt) {
  dt = dt || 1 / 60;
  let x = r.anchorX;
  const y = r.anchorY;
  const nRamp = Math.max(1, Math.round(rampSec / dt));
  for (let i = 1; i <= nRamp; i++) {
    const u = i / nRamp;
    const w = u * u * (3 - 2 * u);
    x += vx * w * dt;
    r.setAnchor(x, y);
    r.update(dt);
  }
  const nHold = Math.max(1, Math.round(holdSec / dt));
  let sum = 0, mx = 0, sumDX = 0;
  for (let i = 0; i < nHold; i++) {
    x += vx * dt;
    r.setAnchor(x, y);
    r.update(dt);
    const a = r.tipAngle * DEG;
    sum += a;
    if (Math.abs(a) > Math.abs(mx)) mx = a;
    // 匀速段里绳端相对支点的水平偏移，平均值才有意义（瞬时值在 ±3px 内来回摆）
    sumDX += r.tipX - r.anchorX;
  }
  return { avg: sum / nHold, max: mx, avgDX: sumDX / nHold, x: x };
}

/** 把所有质点绕挂点刚性旋转到 angleDeg，然后速度清零（= 从该角度静止释放） */
function releaseFrom(r, angleDeg) {
  const a = angleDeg / DEG;
  const cs = Math.cos(a), sn = Math.sin(a);
  const ax = r.anchorX, ay = r.anchorY;
  for (const p of r.path) {
    const dx = p.x - ax, dy = p.y - ay;
    const nx = ax + dx * cs - dy * sn;
    const ny = ay + dx * sn + dy * cs;
    p.x = nx; p.y = ny;
    p.px = nx; p.py = ny;
  }
}

/** 折线总长 */
function polyLen(r) {
  const pts = r.path;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  return total;
}

/** 相邻两段的最小夹角（度）。0 = 完全折返，180 = 完全伸直 */
function minJointAngle(r) {
  const pts = r.path;
  let worst = 180;
  for (let j = 1; j < pts.length - 1; j++) {
    const b = pts[j], a = pts[j - 1], c = pts[j + 1];
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const dot = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
    worst = Math.min(worst, Math.acos(dot) * DEG);
  }
  return worst;
}

/**
 * 链式刚体摆的小角度周期：T = 2π√( Σ m_i·(x_i²+y_i²) / ( g·Σ m_i·y_i ) )
 *
 * 【为什么不用简单摆 2π√(L/g)】那个式子只对"质量全集中在绳端"成立。
 * segments >= 2 时质量沿绳分布（_massAt 从 1 线性升到 tailMass），有效摆长变短，
 * 周期系统性偏快：实测 1/2/3/4 段对简单摆分别 -0.1% / -5.4% / -8.9% / -10.5%。
 * 用链式刚体摆公式后，1/2/3/4 段的误差收敛到 1% 以内（-0.1% / +0.8% / +0.8% / +1.0%）。
 * 注意：必须在绳子竖直静止（x_i 全为 0）时调用，否则 x_i²+y_i² 里混进横向偏移。
 */
function chainPendulumPeriod(r) {
  const pts = r.path;
  let num = 0, den = 0;
  for (let i = 1; i < pts.length; i++) {
    const m = (r.points && r.points[i] && r.points[i].mass) || 1;
    const x = pts[i].x - pts[0].x, y = pts[i].y - pts[0].y;
    num += m * (x * x + y * y);
    den += m * y;
  }
  return 2 * Math.PI * Math.sqrt(num / (PHYS.gravity * den));
}

// ---------- 1. 静止：整条绳竖直下垂 ----------
console.log("[1] 静止：整条绳竖直，总长 = 设定长度");
{
  const r = fresh(2);
  for (let i = 0; i < 200; i++) { r.setAnchor(500, 300); r.update(1 / 60); }
  const pts = r.path;
  let maxDX = 0;
  for (const p of pts) maxDX = Math.max(maxDX, Math.abs(p.x - 500));
  check("各点水平偏移 < 1px", maxDX < 1, "maxDX=" + maxDX.toFixed(3));
  check("绳端 y 约等于 支点 + 长度", Math.abs(pts[pts.length - 1].y - (300 + ROPE_LEN)) < 2,
        "tipY=" + pts[pts.length - 1].y.toFixed(1));
  check("总长约等于设定长度", Math.abs(polyLen(r) - ROPE_LEN) < 2, "total=" + polyLen(r).toFixed(1));
}

// ---------- 2. 质点数可配 2..5 ----------
console.log("[2] 段数 1~4 均可构建（节点数 = 段数 + 1）");
{
  const counts = [];
  for (let seg = 1; seg <= 4; seg++) {
    const r = fresh(seg);
    counts.push(r.count);
    check(seg + " 段：" + (seg + 1) + " 个质点，长度正确",
          r.count === seg + 1 && Math.abs(r.length - ROPE_LEN) < 0.01,
          "count=" + r.count + " len=" + r.length);
  }
  check("逐级递增", counts.join(",") === "2,3,4,5", counts.join(","));
}

// ---------- 3. 向右甩 => 绳端滞后偏左 ----------
console.log("[3] 向右甩：绳端滞后，整体偏左");
{
  const r = fresh(2);
  const d = rampDrive(r, 500, 1.0, 1.0);   // 1s 平滑加速到 500px/s，再匀速 1s
  check("匀速段平均 tipAngle < -1°（绳端被甩在后面）", d.avg < -1.0,
        "avg=" + d.avg.toFixed(2) + "° max=" + d.max.toFixed(2) + "°");
  // 用匀速段的平均水平滞后，不用末帧快照 —— 稳态滞后只有 2.2°，对应 dx 约 -3.5px，
  // 而残余摆动本身就有 ±3px，抓单帧会随机假失败。
  check("匀速段绳端平均水平滞后于支点", d.avgDX < -1.0,
        "avgDX=" + d.avgDX.toFixed(2) + "px");
}

// ---------- 4. 向左甩 => 偏右 ----------
console.log("[4] 向左甩：绳端偏右");
{
  const r = fresh(2);
  const d = rampDrive(r, -500, 1.0, 1.0);
  check("匀速段平均 tipAngle > +1°（反方向对称）", d.avg > 1.0,
        "avg=" + d.avg.toFixed(2) + "° max=" + d.max.toFixed(2) + "°");
}

// ---------- 5. 弯曲自由度 ----------
console.log("[5] 弯曲自由度：1 段必然是直线，2/3 段能弯");
{
  function bendiness(segments) {
    const r = fresh(segments);
    sweep(r, 500, 300, 20, 0, 18);
    const pts = r.path;
    const dirs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      dirs.push(Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
    }
    const mean = dirs.reduce((a, b) => a + b, 0) / dirs.length;
    return dirs.reduce((a, d) => a + Math.abs(d - mean), 0) / dirs.length;
  }
  const b1 = bendiness(1), b2 = bendiness(2), b3 = bendiness(3);
  check("1 段（单连杆，2 质点）必然是直线", b1 < 1e-6, "弯曲=" + b1.toFixed(6) + " rad");
  check("2/3 段能弯出可见弧度", b2 > 0.005 && b3 > 0.005,
        "1段=" + b1.toFixed(3) + " 2段=" + b2.toFixed(3) + " 3段=" + b3.toFixed(3) + " rad");
}

// ---------- 6. 弹性关闭：长度绝对不变 ----------
console.log("[6] 弹性关闭：甩动时长度不伸长");
{
  const r = fresh(2);
  let maxLen = 0;
  for (let i = 0; i < 60; i++) {
    r.setAnchor(500 + i * 45, 300);      // 2700px/s 猛拉
    r.update(1 / 60);
    maxLen = Math.max(maxLen, polyLen(r));
  }
  check("maxLen <= 绳长 * 1.002", maxLen <= ROPE_LEN * 1.002,
        "maxLen=" + maxLen.toFixed(3) + " / 上限 " + (ROPE_LEN * 1.002).toFixed(3));
  check("maxLen >= 绳长（没有被压缩）", maxLen >= ROPE_LEN * 0.999,
        "maxLen=" + maxLen.toFixed(3));

  const endX = r.anchorX;
  for (let i = 0; i < 400; i++) { r.setAnchor(endX, 300); r.update(1 / 60); }
  check("停手后回到原长", Math.abs(polyLen(r) - ROPE_LEN) < ROPE_LEN * 0.01,
        "len=" + polyLen(r).toFixed(2));
}

// ---------- 7. 拉伸比不超过 maxStretch ----------
console.log("[7] 单节拉伸比不超过 maxStretch");
{
  const r = fresh(4);
  const rest = r.restLen;
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    r.setAnchor(r.anchorX + 60, r.anchorY);   // 每帧瞬移式拉扯
    r.update(1 / 60);
    const pts = r.path;
    for (let k = 0; k < pts.length - 1; k++) {
      const d = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
      worst = Math.max(worst, d / rest);
    }
  }
  check("各节拉伸比 <= maxStretch + 0.02", worst <= CHAIN.maxStretch + 0.02,
        "worst=" + worst.toFixed(3) + " / 上限 " + CHAIN.maxStretch);
}

// ---------- 8. 瞬移不产生冲量 ----------
console.log("[8] 指针瞬移：整体平移，不产生冲量");
{
  const r = fresh(2);
  for (let i = 0; i < 60; i++) { r.setAnchor(500, 300); r.update(1 / 60); }
  const before = r.tipAngle;
  r.teleport(1200, 700);
  r.update(1 / 60);
  check("角度基本不变", Math.abs(r.tipAngle - before) < 0.05,
        "before=" + (before * DEG).toFixed(2) + "° after=" + (r.tipAngle * DEG).toFixed(2) + "°");
  check("绳端跟随到新位置",
        Math.abs(r.tipX - 1200) < 3 && Math.abs(r.tipY - (700 + ROPE_LEN)) < 3,
        "tip=(" + r.tipX.toFixed(1) + "," + r.tipY.toFixed(1) + ")");
}

// ---------- 9. 帧率无关性（用稳态滞后角，不用快照角） ----------
// 旧版拿一个固定帧数后的瞬时角做判据，有两处问题：
//   1) 判据是 < 8°，宽容到能藏住 _lastH 那个 ratio bug（1/60 会 ×4 爆炸）；
//   2) 瞬时角落在起速瞬态里，本身就是振铃采样，抖动比真实差异大。
// 稳态滞后角才对：rampDrive 平滑加速到 500px/s 后取匀速段平均角。
console.log("[9] 帧率无关性：60/120/144/240fps 的稳态滞后角一致（spread < 1°）");
{
  const vals = [60, 120, 144, 240].map(function (fps) {
    const r = fresh(2);
    return rampDrive(r, 500, 1.0, 1.0, 1 / fps).avg;
  });
  const spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
  check("四档帧率 稳态平均角 spread < 1°", spread < 1,
        "60=" + vals[0].toFixed(2) + "° 120=" + vals[1].toFixed(2) +
        "° 144=" + vals[2].toFixed(2) + "° 240=" + vals[3].toFixed(2) +
        "° spread=" + spread.toFixed(2) + "°");
}

// ---------- 10. 停手后能安静下来 ----------
// 【为什么是 12 秒不是 3 秒】R14 明说「停得慢」，实测振幅衰减 tau ≈ 3.3~4.0s。
// 从 1200px/s 甩停后，摆幅要衰减到 8px 以内需要 5~8 秒 —— 3 秒不可能。
// 这里改成「12 秒内收敛」，另外用 [13] 单独约束 tau，两者分工明确。
console.log("[10] 停手后 12 秒内基本静止（R14 要求停得慢，不能用 3 秒）");
{
  const r = fresh(2);
  sweep(r, 500, 300, 20, 0, 25);
  const endX = r.anchorX;
  // 「首次收敛」必须是"此后一直保持在 8px 以内"的那一帧。
  // 只看"第一次出现 <8px"会在摆动过零点时误判（实测 0.38s 就被判成收敛了）。
  const dxTrace = [];
  for (let i = 0; i < 720; i++) {
    r.setAnchor(endX, 300); r.update(1 / 60);
    let mx = 0;
    for (const p of r.path) mx = Math.max(mx, Math.abs(p.x - endX));
    dxTrace.push(mx);
  }
  let firstSettled = -1;
  for (let i = 0; i < dxTrace.length; i++) {
    let ok = true;
    for (let j = i; j < dxTrace.length; j++) { if (dxTrace[j] >= 8) { ok = false; break; } }
    if (ok) { firstSettled = i / 60; break; }
  }
  let maxDX = 0;
  for (const p of r.path) maxDX = Math.max(maxDX, Math.abs(p.x - endX));
  check("12 秒内收敛到 8px 以内", maxDX < 8, "maxDX=" + maxDX.toFixed(2));
  check("而且确实「停得慢」（首次收敛晚于 2 秒，R14）", firstSettled > 2,
        "首次 <8px 用时 " + firstSettled.toFixed(2) + "s");
}

// ---------- 11. 极端输入不崩 ----------
console.log("[11] 极端输入：NaN / 超大位移");
{
  const r = fresh(2);
  r.setAnchor(NaN, 300);
  r.update(1 / 60);
  let finite = r.path.every(p => isFinite(p.x) && isFinite(p.y));
  check("NaN 后自动恢复", finite);

  for (let i = 0; i < 50; i++) { r.setAnchor(500 + 100000 * i, 300); r.update(1 / 60); }
  finite = r.path.every(p => isFinite(p.x) && isFinite(p.y) && isFinite(p.px) && isFinite(p.py));
  check("超大位移后数值有限", finite);
}

// ---------- 12. 自由摆周期 ----------
// 【不能用简单摆】简单摆 T = 2π√(L/g) 假设质量全集中在绳端。多段绳的质量沿绳分布，
// 有效摆长变短，实测比简单摆快 5~11%。正确公式是链式刚体摆（见 chainPendulumPeriod）。
// 旧实现（g=8000 + 三道几何投影）实测周期 0.50s，连简单摆的 0.54s 都达不到。
console.log("[12] 自由摆周期接近链式刚体摆理论值");
{
  const r = fresh(2);
  const dt = 1 / 240;
  releaseFrom(r, 15);                        // 小角度释放，让线性近似成立
  const crossings = [];
  let prev = r.tipAngle;
  let prevT = 0;
  for (let i = 1; i <= Math.round(3.0 / dt); i++) {
    r.setAnchor(500, 300);
    r.update(dt);
    const a = r.tipAngle;
    if ((prev < 0 && a >= 0) || (prev > 0 && a <= 0)) crossings.push(i * dt);
    prev = a;
  }
  const periods = [];
  for (let i = 1; i < crossings.length; i++) periods.push(crossings[i] - crossings[i - 1]);
  // 相邻两次过零之间是【半个】周期。旧版漏了这个 2，把 0.944s 判成 0.472s 而误报失败。
  const T = periods.length ? 2 * periods.reduce((a, b) => a + b, 0) / periods.length : 0;
  const Ttheory = chainPendulumPeriod(r);
  check("周期与链式刚体摆理论值误差 < 4%", Math.abs(T - Ttheory) / Ttheory < 0.04,
        "实测 T=" + T.toFixed(3) + "s 理论=" + Ttheory.toFixed(3) + "s");
}

// ---------- 13. 振幅衰减时间常数 tau ----------
// dampingPerSecond 作用在速度上，振幅与速度同相，所以振幅衰减速率是 k/2。
// 再叠加 PBD 投影的固有数值耗散 omega^2*h/2，总速率 b = k/2 + omega^2*h/2，tau = 1/b。
// 旧实现把 velocityDamping 当成"每子步乘性衰减"，tau 只有 0.69s，
// 而且会随 fixedStep 剧烈漂移（60Hz 1.39s / 480Hz 0.35s）。
console.log("[13] 振幅衰减时间常数 tau 符合 k/2 + omega^2*h/2 模型");
{
  const r = fresh(2);
  const dt = 1 / 240;
  releaseFrom(r, 20);
  const samples = [];              // [t, |angle|]
  let prev = r.tipAngle;
  for (let i = 1; i <= Math.round(6.0 / dt); i++) {
    r.setAnchor(500, 300);
    r.update(dt);
    const a = r.tipAngle;
    // 过零 = 一个半周期的峰值已过，向前找峰值更麻烦；这里直接采样绝对值包络
    samples.push([i * dt, Math.abs(a)]);
    prev = a;
  }
  // 用后半段（0.5s~5s）的包络做对数线性拟合
  const win = samples.filter(s => s[0] > 0.5 && s[0] < 5.0 && s[1] > 1e-4);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  // 包络峰值：把每个半周期内的最大绝对值挑出来
  const peaks = [];
  for (let i = 1; i < win.length - 1; i++) {
    if (win[i][1] >= win[i - 1][1] && win[i][1] >= win[i + 1][1]) peaks.push(win[i]);
  }
  for (const [t, a] of peaks) { n++; sx += t; sy += Math.log(a); sxx += t * t; sxy += t * Math.log(a); }
  const slope = n > 2 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
  const tau = slope < 0 ? -1 / slope : Infinity;
  // dampingPerSecond 作用在【速度】上，而振幅与速度同相，所以振幅衰减速率是 k 的一半。
  // 另外 PBD 投影本身有数值耗散：实测速率约 omega^2*h/2（omega = sqrt(g/L)），
  // 在 1/240 下是 0.093/s，与 0.15/s 的有意阻尼同一量级，做断言时必须算进去。
  const omega = Math.sqrt(PHYS.gravity / ROPE_LEN);
  const tauTheory = 1 / (DAMP_K / 2 + omega * omega * PHYS.fixedStep / 2);
  check("峰值数 >= 3", peaks.length >= 3, "peaks=" + peaks.length);
  check("实测 tau 与 k/2+omega^2*h/2 模型误差 < 25%", Math.abs(tau - tauTheory) / tauTheory < 0.25,
        "实测 tau=" + tau.toFixed(2) + "s 理论=" + tauTheory.toFixed(2) + "s");
}

// ---------- 14. fixedStep 敏感性：必须用「稳态滞后角」而不是「自由摆衰减」 ----------
// 旧实现的 ratio = h/_lastH 恒等于 h*240，导致 fixedStep 一变整个引擎就变：
// 1/60 每子步速度 ×4 直接爆炸、1/480 每子步 ×0.5 变成过阻尼。
// 注意：这里不能用自由摆衰减当指标 —— PBD 投影的数值耗散约 omega^2*h/2，
// 会随 h 变化（1/60 时大到 0.37/s，1/240 才 0.093/s），那是算法固有属性，
// 不是 bug。匀速拖动的稳态滞后角才是真正 dt 不变的量（实测极差 0.06°）。
console.log("[14] fixedStep 敏感性：1/60~1/480 的稳态滞后角一致（spread < 1°）");
{
  const steps = [1 / 60, 1 / 120, 1 / 240, 1 / 480];
  const vals = steps.map(function (step) {
    const cfg = Object.assign({}, PHYS, CHAIN, { fixedStep: step });
    const r = new RopeChain(cfg);
    r.setAnchor(500, 300);
    r.rebuild(ROPE_LEN, nodeCountOf(cfg.segments));
    r.resetVertically();
    return rampDrive(r, 500, 1.0, 1.0, 1 / 60).avg;
  });
  const spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
  check("四档 fixedStep 稳态平均角 spread < 1°", spread < 1,
        vals.map(function (v, i) { return "1/" + Math.round(1 / steps[i]) + "=" + v.toFixed(2) + "°"; }).join(" ") +
        " spread=" + spread.toFixed(2) + "°");
}

// ---------- 15. 折叠审计：关节不会被折成锐角 ----------
// 删掉 monoDrop 之后，绳子允许整体翻到挂点上方（R15），
// 所以这里必须确认「翻上去」没有退化成「自己折自己」。
console.log("[15] 剧烈甩动下关节不折成锐角");
{
  const r = fresh(4);
  let worstJoint = 180;
  let aboveFrames = 0;
  const frames = 600;
  for (let i = 0; i < frames; i++) {
    const phase = Math.floor(i / 30) % 2;
    r.setAnchor(500 + (phase ? 300 : 0), 300);   // 300px 瞬变，极端往返
    r.update(1 / 60);
    worstJoint = Math.min(worstJoint, minJointAngle(r));
    if (r.tipY < r.anchorY) aboveFrames++;
  }
  // minJointAngle 的语义：180° = 完全伸直，0° = 完全对折。
  // maxBend 限制的是「弯曲量」= 180° - 关节夹角，所以合格线是 180 - maxBend - 5，
  // 旧版写成 maxBend - 5 语义正好反了（那等于要求绳子必须折成 86°）。
  const maxBendDeg = PHYS.maxBend * DEG;
  const jointFloor = 180 - maxBendDeg - 5;
  check("最小关节夹角 >= 180 - maxBend - 5°", worstJoint >= jointFloor,
        "worst=" + worstJoint.toFixed(1) + "° 下限=" + jointFloor.toFixed(1) + "°");
  check("绳子确实能翻到挂点上方（R15）", aboveFrames > 0,
        aboveFrames + "/" + frames + " 帧");
}

// ---------- 16. 60 秒剧烈输入：无 NaN，长度不漂 ----------
console.log("[16] 60 秒剧烈甩动：数值有限、链长不漂");
{
  const cfg = Object.assign({}, PHYS, CHAIN);
  const r = new RopeChain(cfg);
  r.setAnchor(500, 300);
  r.rebuild(ROPE_LEN, nodeCountOf(cfg.segments));
  r.resetVertically();
  let bad = 0, minLen = Infinity, maxLen = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 3600; i++) {
    const t = i * dt;
    const x = 500 + 380 * Math.sin(t * 2.2) * Math.cos(t * 0.7);
    const y = 300 + 220 * Math.sin(t * 1.7 + 1.1);
    r.setAnchor(x, y);
    r.update(dt);
    let ok = true;
    for (const p of r.path) {
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.px) || !isFinite(p.py)) ok = false;
    }
    if (!ok) bad++;
    const L = polyLen(r);
    minLen = Math.min(minLen, L);
    maxLen = Math.max(maxLen, L);
  }
  check("无非法数值帧", bad === 0, "bad=" + bad);
  check("链长始终在 [绳长*0.98, 绳长*1.01]", minLen >= ROPE_LEN * 0.98 && maxLen <= ROPE_LEN * 1.01,
        "min=" + minLen.toFixed(2) + " max=" + maxLen.toFixed(2) + " rest=" + ROPE_LEN);
}

// ---------- 17. 性能 ----------
console.log("[17] 性能：600 帧总耗时");
{
  const r = fresh(2);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 600; i++) {
    r.setAnchor(500 + 100 * Math.sin(i * 0.05), 300);
    r.update(1 / 60);
  }
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  check("600 帧 < 100ms", ms < 100, ms.toFixed(2) + "ms（" + (ms / 600).toFixed(4) + "ms/帧）");
}

// ---------- 汇总 ----------
console.log("");
if (failures === 0) {
  console.log("全部通过 ✓");
} else {
  console.log("有 " + failures + " 项失败 ✗");
  process.exitCode = 1;
}
