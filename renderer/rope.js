// renderer/rope.js  --  绳索物理：Verlet 积分 + PBD 约束
// 纯逻辑，不碰 DOM，可在 Node 里单独测试。
//
// ===== 算法（第 3 轮重构后）=====
// 把绳子离散成 N 个质点 P0..P{N-1}，相邻质点之间是距离约束。
//
// 1) Verlet 积分（位置式，二阶精度，天然稳定）：
//      x' = x + (x - xPrev) * keep + a * h^2
//    keep = exp(-k * h)，k 是「每秒阻尼率」（单位 1/s），与固定步长 h 解耦。
//
// 2) 距离约束（PBD）：每个子步迭代 iterations 次，让 |P{i+1} - P{i}| = restLen。
//
// 3) 长度上限：_limitLength 只做「单向缩短」，超出 restLen * maxStretch 就硬钳回去，
//    所以折线总长永远 <= 绳长，绝不会被拉长（需求 R11）。
//
// 4) 关节弯曲上限 _limitBend：任何一处关节都不许折成锐角（防 Z 字自折）。
//    修正手法是「把关节两侧的邻居绕关节做纯旋转」——旋转精确保持段长，
//    且同时旋转 (x,y) 与 (px,py)，所以不会把修正变成假速度。
//    【关键】它只约束关节角度，不约束绳子的绝对朝向，
//    所以绳子依然可以整体翻到挂点上方（需求 R15）。
//
// ===== 外力 =====
// - 重力 g（向下）
// - 空气阻力：力与速度平方成正比（-drag * |v| * v），等效加速度与 h 无关
// - 湍流：随时间变化的横向力，让静止时也有轻微摆动（「呼吸感」）
//
// ===== 支点 =====
// P0 被钉死在鼠标指针下方（由上层每帧写入），其余质点自由。
//
// ===== 第 3 轮重构要点（详见 docs/09-物理评审与重构方案.md）=====
// 1. 删掉 _lastH / ratio 变步长校正：_lastH 从不更新，导致 ratio 恒为 h*240，
//    只有 fixedStep = 1/240 时才是它自己（1/60 时每子步速度 ×4 直接爆炸，
//    1/480 时 ×0.5 变成过阻尼）。固定步长下这个校正根本不该存在。
// 2. velocityDamping（每子步乘性 keep = 1 - vd）改成 dampingPerSecond（exp(-k*h)）。
//    原写法让阻尼强度随 fixedStep 剧烈漂移：1s 后速度留存 60Hz 0.697 / 480Hz 0.056。
// 3. 删掉 5d monoDrop / 5e minDroopRatio / 5e-2 / 5f 整段几何投影。
//    minDroopRatio 的语义是「绳端竖直距离 >= 绳长 × ratio」，绳长恒定时
//    它等价于一个硬性摆角上限 acos(ratio)：0.9 -> 25.8°。
//    这就是「左右移动看不出变化」（R13）的量化根因，且与 R15 直接冲突。
// 4. 删掉 _centripetal 绕圈检测整套。实测绕圈时 5d/5e 本来就被它旁路，
//    所以「关掉作弊」和「开着作弊」的绕圈数据完全一致 —— 它是纯无效复杂度。
// 5. 子步数 willRun === 0 的帧不再重写锚点：以前每帧都推进 _prevAnchorX，
//    没跑子步的那帧位移被静默丢弃，360Hz 屏上每三帧丢一帧，抖动 73%。
"use strict";

var TAU = Math.PI * 2;

// ★ 未闭合距离约束的松弛（slack）每步收回比例（第 21 轮 T1 修正）。
// 只对最后一节生效，见 _limitLength。取 0.25 是因为一个固定子步只有 1/240s，
// 一帧（1/60s）内会跑 4 个子步，合计收回约 1-(0.75)^4 = 68% —— 肉眼可见的"贴回"，
// 又不会因为一次性拉直而在挂饰上产生可见跳变。
var SLACK_RATE = 0.25;

class RopeChain {
  constructor(cfg) {
    this.cfg = cfg || {};
    // 显式记一份 overlap：设置面板会整份替换配置对象，
    // 记在实例上就不用每帧再去 cfg 里翻。setOverlap 由 main.js 的 applySettings 同步。
    this.overlap = (cfg && cfg.overlap) || 0;
    this.points = [];
    // 折线总长超出自然长度的部分（px），由 _limitLength 逐步收回
    this.slack = 0;
    this.restLen = 1;
    this.length = 100;
    this.anchorX = 0;
    this.anchorY = 0;
    this.accumulator = 0;
    this.ready = false;
    this.time = 0;

    this.tipX = 0;
    this.tipY = 0;
    this.tipDirX = 0;
    this.tipDirY = 1;
    this.tension = 0;

    // 挂点跟随用的状态
    this._prevAnchorX = 0;
    this._prevAnchorY = 0;
    this._stepFromX = 0;
    this._stepFromY = 0;
    this._stepTotal = 0;
    this._stepIndex = 0;
  }

  /** 重建质点链。len = 绳子自然长度（CSS 像素），count = 质点个数（>=2） */
  rebuild(len, count) {
    const n = Math.max(2, Math.round(count || 2));
    this.length = Math.max(4, len);
    this.restLen = this.length / (n - 1);

    const pts = [];
    // 第 29 轮：挂饰模拟段（原称「尾巴段」，第 31 轮 m11899 改名）。count 仍表示「主体质点个数 p1..pn」，模拟段是最后一个额外点。
    // segments=3 => 主体 4 个质点，模拟段再加 1 个（p5），共 5 个。
    //
    // 【关键：模拟段是「额外加的」，不是「从总长里切出来的」】
    // 第一版把它从 this.length 里切走（mainRest = (length - tailLen)/(n-1)），
    // 线上 total=60.5px、tail=52 时主体段只剩 2.8px，整个 PBD 链失稳：
    // 小驱动 ±40px 下主体 tip 峰值从 74° 飙到 178°，模拟段有 46% 的帧朝天。
    // 现在主体段长恒为 length/(n-1)，与有没有模拟段无关，模拟段接在后面额外伸出去。
    const tailLen = this._tailLength();
    const mainRest = this.length / (n - 1);
    this.restLen = mainRest;
    let curY = this.anchorY;
    for (let i = 0; i < n; i++) {
      pts.push({
        x: this.anchorX, y: curY,
        px: this.anchorX, py: curY,
        mass: this._massAt(i, n),
        invMass: 0
      });
      curY += mainRest;
    }
    if (tailLen > 0) {
      // p5：从 p4 沿 tail.angle 方向伸出 tailLen。
      // 【第 38 轮补，m13415】出厂 angle=0（竖直向下，与旧版一致）；
      // 面板「应用」时按挂点→质点方向重设 —— 初始状态（未物理运算）下 p5
      // 精确落在图片上 (massX,massY) 那个点，预览区与实际挂件一致。
      // 物理开始后 p5 由求解器接管，angle 不再约束摆动。
      const ta = this._tailAngle();
      const tx = this.anchorX + Math.sin(ta) * tailLen;
      const ty = curY - mainRest + Math.cos(ta) * tailLen;
      pts.push({
        x: tx, y: ty,
        px: tx, py: ty,
        mass: this._tailMass(),
        invMass: 0,
        isTail: true
      });
    }
    this.points = pts;
    this._recomputeMass();
    this.accumulator = 0;
    this.ready = true;
    this._prevAnchorX = this.anchorX;
    this._prevAnchorY = this.anchorY;
    this._stepFromX = this.anchorX;
    this._stepFromY = this.anchorY;
    this._stepTotal = 0;
    this._stepIndex = 0;
    this._updateTip();
  }

  /** 质量分布：靠近支点轻、靠近娃娃重，甩起来更像真实的绳+摆锤 */
  /** 挂饰模拟段的长度（像素）。0 = 不加。第 29 轮，第 31 轮改名 */
  _tailLength() {
    const t = this.cfg && this.cfg.tail;
    // 【第 29 轮】enabled 三种形态都要认：
    //   · false / "off" ：面板下拉框存的是字符串，sanitize 只收 string，所以是 "off"；
    //   · true / "on"   ：同上；
    //   · 未定义        ：老 settings.json 里没有这个键，按 config.js 的出厂值走。
    // 只写 t.enabled === false 会让面板的 "off" 完全失效（字符串不等于 false）。
    if (!t) return 0;
    if (t.enabled === false || t.enabled === "off" || t.enabled === 0) return 0;
    const v = t.length;
    return isFinite(v) && v > 0 ? v : 0;
  }

  /** 挂饰模拟段末端质点(p5)的质量倍率。默认 20 = 单个绳段的 20 倍（第 29 轮 m11260 定标） */
  _tailMass() {
    const t = this.cfg && this.cfg.tail;
    const m = t && t.mass !== undefined ? t.mass : 20;
    return isFinite(m) && m > 0 ? m : 20;
  }

  /** 模拟段的配置方向角（弧度，竖直向下=0，顺时针为正）。【第 38 轮补 m13415】 */
  _tailAngle() {
    const t = this.cfg && this.cfg.tail;
    const a = t && t.angle !== undefined ? t.angle : 0;
    return isFinite(a) ? a : 0;
  }

  /** 挂饰模拟段朝向（弧度）。给挂饰的旋转用：p4 -> p5 */
  get tailAngle() {
    const pts = this.points;
    const n = pts.length;
    if (n < 2) return 0;
    const a = pts[n - 2];
    const b = pts[n - 1];
    return Math.atan2(b.x - a.x, b.y - a.y);
  }

  /**
   * 挂饰挂点。第 31 轮（m11899）：**严格等于 p4**，不再沿 p4->p5 偏移 overlap。
   *
   * 用户原话：「小熊挂在了 p5 上，而非挂饰模拟段的起始位置 p4」。
   * 之前这里返回 p4 + overlap 沿 p4->p5，而 doll.js 又去读 tailPoint（p5 + overlap），
   * 两个点都不是 p4，挂饰看起来就像挂在下面那一段的末端。
   *
   * 现在：有挂饰模拟段时就是 p4 坐标本身（不偏移）；没有时退回 tailPoint（绳端）。
   * 吊环（rope.loopRadius）与挂饰的旋转支点都用这个点。
   */
  get hangPoint() {
    const pts = this.points;
    const n = pts.length;
    if (n === 0) return { x: this.anchorX, y: this.anchorY };
    if (!pts[n - 1].isTail) return this.tailPoint;
    return { x: pts[n - 2].x, y: pts[n - 2].y };
  }

  /** 挂饰模拟段是否启用 */
  get hasTail() {
    const pts = this.points;
    return pts.length > 0 && !!pts[pts.length - 1].isTail;
  }

  _massAt(i, n) {
    if (i === 0) return 1;
    const tailHeavy = this.cfg.tailMass !== undefined ? this.cfg.tailMass : 1.6;
    const t = (i - 1) / Math.max(1, n - 2);
    return (1 - t) + tailHeavy * t;
  }

  _recomputeMass() {
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      p.invMass = i === 0 ? 0 : 1 / Math.max(1e-4, p.mass);
    }
  }

  /** 设置支点（每帧由上层写入）。非法坐标归零，避免 NaN 污染整条链 */
  setAnchor(x, y) {
    if (!isFinite(x) || !isFinite(y)) {
      x = isFinite(this.anchorX) ? this.anchorX : 0;
      y = isFinite(this.anchorY) ? this.anchorY : 0;
    }
    this.anchorX = x;
    this.anchorY = y;
    if (!this.ready) {
      this.rebuild(this.length, 3);
      return;
    }
    // 注意：这里只记录支点，不动 points[0]。
    // 支点的位移要交给 _step 用 Verlet 语义处理（px 保留上一位置），
    // 否则每次 setAnchor 都把位移抹平，甩动时就没有任何惯性传递给绳身。
  }

  /** 瞬移：整体平移到新位置，速度清零 */
  teleport(x, y) {
    const ok = isFinite(x) && isFinite(y);
    const tx = ok ? x : 0;
    const ty = ok ? y : 0;
    const ax = isFinite(this.anchorX) ? this.anchorX : tx;
    const ay = isFinite(this.anchorY) ? this.anchorY : ty;
    const dx = tx - ax;
    const dy = ty - ay;
    this.anchorX = tx;
    this.anchorY = ty;
    const pts = this.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      p.x += dx; p.y += dy;
      p.px = p.x; p.py = p.y;
    }
    // teleport 是"整链硬搬"，前后位置之间没有物理过程，不能算作速度。
    // 因此必须把这些状态一起清掉，否则 velocity 模式会把整帧的巨大位移当成
    // 一次冲量注入 —— 实测瞬移 340px 后 tipAngle 从 0° 直接崩到 -122.41°。
    this.accumulator = 0;
    this._prevAnchorX = this.anchorX;
    this._prevAnchorY = this.anchorY;
    this._stepFromX = this.anchorX;
    this._stepFromY = this.anchorY;
    this._stepTotal = 0;
    this._stepIndex = 0;
  }

  /** 直接摆成"竖直下垂"的静止姿态 */
  resetVertically() {
    if (!isFinite(this.anchorX) || !isFinite(this.anchorY)) {
      this.anchorX = 0;
      this.anchorY = 0;
    }
    const pts = this.points;
    // 第 29 轮：挂饰模拟段比主体段长，不能再用 restLen*i 累加。
    // 第 38 轮补（m13415）：末段（模拟段）若存在，沿 tail.angle 方向摆放，
    // 与 rebuild 的初值保持同一约定 —— resetVertically 之后 p5 仍落在图片质点上。
    const hasTail = pts.length > 1 && !!pts[pts.length - 1].isTail;
    let cy = this.anchorY;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (hasTail && i === pts.length - 1) {
        const ta = this._tailAngle();
        const len = this._tailLength() || this._restOf(i - 1);
        p.x = this.anchorX + Math.sin(ta) * len;
        p.y = cy - this._restOf(i - 1) + Math.cos(ta) * len;
      } else {
        p.x = this.anchorX;
        p.y = cy;
      }
      p.px = p.x; p.py = p.y;
      cy += this._restOf(i);
    }
    this.accumulator = 0;
    this._prevAnchorX = this.anchorX;
    this._prevAnchorY = this.anchorY;
    this._stepFromX = this.anchorX;
    this._stepFromY = this.anchorY;
    this._stepTotal = 0;
    this._stepIndex = 0;
    this._updateTip();
  }

  /** 每秒阻尼率 k（1/s）。等效 tau = 1/k。 */
  _dampingPerSecond(h) {
    const c = this.cfg;
    if (typeof c.dampingPerSecond === "number") {
      return Math.max(0, c.dampingPerSecond);
    }
    // 兼容旧配置：velocityDamping 是「每子步乘性 keep = 1 - vd」，
    // 换算成等效的每秒速率 k = -ln(1 - vd) / h。
    if (typeof c.velocityDamping === "number") {
      const vd = Math.min(0.999, Math.max(0, c.velocityDamping));
      return -Math.log(Math.max(1e-6, 1 - vd)) / h;
    }
    return 0.30;
  }

  /**
   * 当前每秒速度衰减率 k（1/s），满足 -dv/dt = k·v（振幅按 exp(-k t/2) 衰减）。
   * 诊断记录器要用它把 Verlet 的乘性阻尼从"观测加速度"里补回去：
   * 不补的话，算出的绳子净力会系统性偏小（k=0.3、v=1000 时约差 300px/s^2，
   * 接近重力的 1/10）。纯只读，不改变任何物理状态。
   */
  dampingRate() {
    const c = this.cfg;
    const h = Math.min(1 / 60, Math.max(1 / 480, c.fixedStep || 1 / 240));
    return this._dampingPerSecond(h);
  }

  /** 主推进。dt = 真实帧间隔（秒），内部固定步长积分 */
  update(dt) {
    if (!this.ready || this.points.length < 2) return;

    const c = this.cfg;
    const h = Math.min(1 / 60, Math.max(1 / 480, c.fixedStep || 1 / 240));
    const maxSteps = Math.max(1, c.maxStepsPerFrame || 48);
    const maxAcc = c.maxAccumulator || 0.1;

    if (isFinite(dt) && dt > 0) this.accumulator += Math.min(dt, maxAcc);
    if (this.accumulator > maxAcc) this.accumulator = maxAcc;

    // ---------- 本帧要跑多少子步 ----------
    //
    // 必须先算出来，因为 velocity 模式要把"这一帧的挂点位移"均摊到各个子步里。
    // 早年把位移一次性注入第一个子步，结果是：第 1 个子步 P0 走 10px、后面 3 个
    // 子步 P0 静止，等效一次脉冲冲量。实测帧率无关性直接崩了——
    // 60fps 只有 1.44°，240fps 到 -23.54°，差 24.98°。
    // 加 1e-9 抵消浮点误差：dt = 1/60、h = 1/240 时 accumulator/h 算出来是
    // 3.9999999999999996，floor 后变成 3 —— 少跑一个子步，长期交替 3/4 步抖动。
    const willRun = Math.min(maxSteps, Math.floor(this.accumulator / h + 1e-9));
    const p0 = this.points[0];

    if (willRun > 0) {
      const followMode = c.followMode || "velocity";

      if (followMode === "translate") {
        // 【translate】整链刚性平移：把每个点的 x/y 和 px/py 一起搬同样的量。
        // 好处是鼠标快移不会把绳子甩飞；坏处是 (x-px) 恒不变 => 挂点速度恒为 0
        // => 没有整体平移 => 离心力不存在 => 偏角与鼠标速度无关。
        const dxAnchor = this.anchorX - p0.x;
        const dyAnchor = this.anchorY - p0.y;
        if (isFinite(dxAnchor) && isFinite(dyAnchor) && (dxAnchor !== 0 || dyAnchor !== 0)) {
          const tip = this.points[this.points.length - 1];
          const bobX = tip.x, bobY = tip.y, bobPX = tip.px, bobPY = tip.py;
          for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            p.x += dxAnchor;
            p.y += dyAnchor;
            p.px += dxAnchor;
            p.py += dyAnchor;
          }
          // 绳端恢复原位置：它要靠重力/惯性自己荡过去，而不是被拖过去
          tip.x = bobX; tip.y = bobY;
          tip.px = bobPX; tip.py = bobPY;
        }
        p0.x = this.anchorX;
        p0.y = this.anchorY;
        this._stepTotal = 0;
      } else {
        // 【velocity】只推进挂点位置、保留 px/py（真实速度注入）
        // 本帧起点 = 上一帧锚点；每个子步在 _step 内按 i/total 比例推进。
        this._stepFromX = this._prevAnchorX;
        this._stepFromY = this._prevAnchorY;
        this._stepTotal = willRun;
        this._stepIndex = 0;
        // P0 的"上一帧位置"必须钉在上一帧锚点上，这样 _step 里算出的
        // 挂点速度 = (anchorX - prevAnchorX) / dt，恰好是真实的鼠标速度。
        //
        // 反例（本项目踩过两次，务必记住）：
        //   · 干脆不碰 p0.px  -> 它停在很久以前的位置，
        //     实测 (x-px) 累积到 1490px，推算速度 357600px/s，绳子当场被甩飞。
        //   · 把 p0.px 设成"当前位置" -> 挂点速度恒为 0，离心力不存在，偏角与速度无关。
        // 唯一正确的是"上一帧位置"。
        p0.px = this._prevAnchorX;
        p0.py = this._prevAnchorY;
      }

      while (this.accumulator >= h && this._stepIndex < maxSteps) {
        this._step(h);
        this.accumulator -= h;
      }

      // 只有真的推进了物理，才把锚点记成"上一帧位置"。
      // 以前无条件记录，导致 willRun === 0 的帧（360Hz 屏上每三帧一次）
      // 把这一帧的挂点位移静默丢弃，帧间抖动实测 73%。
      this._prevAnchorX = this.anchorX;
      this._prevAnchorY = this.anchorY;

      // 支点收尾：把 P0 拉到最终锚点。注意【只推进 x/y、不碰 px/py】。
      p0.x = this.anchorX;
      p0.y = this.anchorY;
    }

    this._updateTip();
  }

  /**
   * 当前这一子步的「环境加速度」：重力 + 湍流风。
   * 单位是 px/s^2（每单位质量的加速度），不含空气阻力 —— 阻力与质点速度有关，
   * 由调用方算。抽成方法是为了让诊断记录器（renderer/recorder.js）能
   * 用和物理引擎【完全相同】的公式反推"熊受了多少力"，而不是在记录器里再抄一份。
   */
  environmentAccel() {
    const c = this.cfg;
    const turb = c.turbulence !== undefined ? c.turbulence : 0;
    const windFreq = c.windFreq || 1.7;
    let windX = 0, windY = 0;
    if (turb > 0) {
      const t = this.time;
      windX = turb * (Math.sin(t * windFreq * TAU * 0.37) + 0.5 * Math.sin(t * windFreq * TAU * 0.91 + 1.7));
      windY = turb * 0.35 * Math.sin(t * windFreq * TAU * 0.53 + 3.1);
    }
    return {
      gravity: c.gravity !== undefined ? c.gravity : 4000,
      windX: windX,
      windY: windY
    };
  }

  _step(h) {
    const c = this.cfg;
    const pts = this.points;
    const n = pts.length;
    this.time += h;

    // ---------- 1) 外力 ----------
    const env = this.environmentAccel();
    const g = env.gravity;
    const windX = env.windX;
    const windY = env.windY;
    const drag = c.drag !== undefined ? c.drag : 0.00015;

    // ---------- 2) Verlet 积分 ----------
    //
    // keep 是「每子步速度乘性衰减」，但取 exp(-k*h) 而不是 (1 - vd)：
    // 这样 k 是物理量纲（1/s），与 fixedStep 完全解耦。
    //   k = 0.30/s  ->  tau = 1/k = 3.33s 的振幅衰减
    // 旧写法 keep = 1 - vd 会让 1 秒后的速度留存变成 (1-vd)^(1/h)：
    //   60Hz 0.697 / 120Hz 0.486 / 240Hz 0.236 / 480Hz 0.056（差 1252%）。
    const kDamp = this._dampingPerSecond(h);
    const keep = Math.exp(-kDamp * h);
    const invH = 1 / h;

    for (let i = 1; i < n; i++) {
      const p = pts[i];
      const vx = p.x - p.px;
      const vy = p.y - p.py;

      // 空气阻力：与速度平方成正比，方向与速度相反。
      // airX 是加速度量纲，乘以 h^2 才是位移，所以这一项与 h 无关。
      const vxs = vx * invH;
      const vys = vy * invH;
      const v = Math.hypot(vxs, vys);
      const airX = -drag * v * vxs;
      const airY = -drag * v * vys;

      p.px = p.x;
      p.py = p.y;
      p.x += vx * keep + (windX + airX) * h * h;
      p.y += vy * keep + (g + windY + airY) * h * h;
    }

    // ---------- 3) 支点推进 ----------
    //
    // 【这一处是 P0 速度恒为 0 的真正元凶】
    // 早先这里写了 p0.px = this.anchorX; p0.py = this.anchorY;，
    // 含义是"挂点上一子步也在锚点"，即挂点速度恒等于 0。
    // 挂点速度为 0 => 整条链没有整体平移 => 离心力不存在 =>
    // 偏角与鼠标速度无关（实测 300→1200px/s 只有 7°→8°，理论 10.6°→71.6°）。
    //
    // velocity 模式下本帧挂点位移要【均摊到 willRun 个子步】里，每个子步只走 1/k。
    // 一次性走完全程会让第 1 个子步吃掉整帧位移、后面 k-1 个子步挂点静止，
    // 等效一次脉冲冲量 —— 实测帧率无关性因此崩掉（60fps 1.44° vs 240fps -23.54°）。
    //
    // 两种模式都【绝不碰 px/py】：px/py 必须保持"上一子步的挂点位置"，
    // Verlet 才能算出真实的挂点速度。这是本项目反复踩的同一个坑。
    const p0 = pts[0];
    if (this._stepTotal > 0) {
      this._stepIndex = (this._stepIndex || 0) + 1;
      const r = Math.min(1, this._stepIndex / this._stepTotal);
      p0.x = this._stepFromX + (this.anchorX - this._stepFromX) * r;
      p0.y = this._stepFromY + (this.anchorY - this._stepFromY) * r;
    } else {
      p0.x = this.anchorX;
      p0.y = this.anchorY;
    }

    // ---------- 4) 距离约束 ----------
    const iterations = Math.max(1, c.iterations || 4);
    // 弹性开关：c.elasticity === false 时强制刚度 1（每个约束一次解到位），
    // 绳子长度不再有余量，也就没有"甩长 -> 回弹"这一段。
    const elasticityOn = c.elasticity !== false;
    const stiffness = elasticityOn
      ? Math.min(1, Math.max(0.05, c.stiffness !== undefined ? c.stiffness : 0.85))
      : 1;
    for (let it = 0; it < iterations; it++) {
      this._solveConstraints(stiffness);
    }

    // ---------- 5) 长度上限 ----------
    // 弹性关闭时把上限收到 1.0：绳子绝对不伸长（需求 R11）
    const stretch = elasticityOn ? (c.maxStretch !== undefined ? c.maxStretch : 1.35) : 1.0;
    this._limitLength(stretch);

    // ---------- 6) 关节弯曲上限 + 长度交替收敛 ----------
    // 弯曲上限只约束关节角度，不约束绳子的绝对朝向（所以绳子仍可整体翻到上方，R15）。
    //
    // 【为什么要交替迭代】_limitBend 是"绕关节纯旋转"，本身精确保持段长；但旋转会让
    // 相邻关节的角度互相影响（掰直 j 号关节会把 j±1 号掰弯），而随后的 _solveConstraints
    // 修正长度时又会把关节角拉回去一点。只做一轮时，300px/帧 的极端拉扯下实测：
    //   最差关节角 77.9°（要求 >= 94.1°）、折线总长冲到 107.4px（绳长 90）。
    // 交替迭代 3 轮后：最差关节角 154.4°、折线总长 91.8px。
    const maxBend = c.maxBend !== undefined ? c.maxBend : 1.50; // 弧度，约 86°
    const bendRounds = Math.max(1, c.bendIterations !== undefined ? c.bendIterations : 3);
    for (let br = 0; br < bendRounds; br++) {
      this._limitBend(maxBend);
      this._solveConstraints(1);
    }
    // 收尾必须是 _limitBend：否则"最后说话的是 _solveConstraints"，
    // 它会把刚压下去的角度又拉回一部分（实测超限帧 4.4%）。
    this._limitBend(maxBend);

    // ---------- 7) 收尾收敛 ----------
    // 最后再钳一次长度，保证折线总长永远 <= 绳长。
    this._limitLength(stretch);

    // ---------- 8) 数值安全阀 ----------
    //
    // 【a) 速度硬上限】
    // Verlet 的"速度"就是 (x - px)。任何位置投影都会把同样的量同时写进 x 和 px，
    // 本意是"不让修正被当成速度"，但互相拉扯的残差会积成假速度。
    // 给"每帧位移"一个物理上合理的上限：鼠标最快也就 8000px/s，
    // 60fps 单帧 133px，取 maxStepPerFrame（默认 restLen*1.5）既不影响正常运动，
    // 又能在异常积累刚冒头时就掐灭，比等它变成 NaN 再 resetVertically 好得多。
    const maxStep = c.maxStepPerFrame !== undefined ? c.maxStepPerFrame : this.restLen * 1.5;
    const maxStepSq = maxStep * maxStep;
    for (let i = 1; i < n; i++) {
      const p = pts[i];
      const sdx = p.x - p.px;
      const sdy = p.y - p.py;
      const sq = sdx * sdx + sdy * sdy;
      if (sq > maxStepSq) {
        const sc = maxStep / Math.sqrt(sq);
        // 改 px 让 (x-px) 变小，x 本身不动，所以不会把点从当前位置弹开，只是"减速"
        p.px = p.x - sdx * sc;
        p.py = p.y - sdy * sc;
      }
    }

    // 【b) 非法值兜底】
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.px) || !isFinite(p.py)) {
        this.resetVertically();
        return;
      }
    }
  }

  _solveConstraints(stiffness) {
    const pts = this.points;
    for (let i = 0; i < pts.length - 1; i++) {
      // 第 29 轮：每段用自己的 rest。挂饰模拟段（p4->p5）比主体段长得多，
      // 用统一 restLen 会把它反复拽回 12.67px，模拟段就完全不起作用。
      const rest = this._restOf(i);
      const a = pts[i];
      const b = pts[i + 1];
      const wa = a.invMass;
      const wb = b.invMass;
      const wsum = wa + wb;
      if (wsum <= 0) continue;

      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        dx = 0.0001 * (i % 2 ? 1 : -1);
        dy = 0.0001;
        d = Math.hypot(dx, dy);
      }

      const diff = d - rest;
      if (diff === 0) continue;

      const corr = (stiffness * diff) / (d * wsum);
      const cx = dx * corr;
      const cy = dy * corr;

      a.x += cx * wa;
      a.y += cy * wa;
      b.x -= cx * wb;
      b.y -= cy * wb;
    }
  }

  /**
   * 该索引所在段的自然长度。第 29 轮：挂饰模拟段是独立一段，长度与主体不同。
   * i = 起点质点的下标，段 i 连接 pts[i] 与 pts[i+1]。
   */
  _restOf(i) {
    const pts = this.points;
    if (pts[i + 1] && pts[i + 1].isTail) return this._tailRest();
    return this.restLen;
  }

  /** 挂饰模拟段（p4->p5）的自然长度 */
  _tailRest() {
    const t = this.cfg && this.cfg.tail;
    const v = t && t.length;
    return isFinite(v) && v > 0 ? v : this.restLen;
  }

  /** 相邻两节长度不能超过 rest * maxStretch（单向缩短，只钳不拉） */
  _limitLength(maxStretch) {
    const pts = this.points;
    const rest = this.restLen;
    const limit = rest * maxStretch;
    let stretchSum = 0;
    let segCount = 0;

    // ★ 松弛量（slack，第 21 轮 T1 修正）
    //
    // 问题：约束只限制「每段不超过 rest * maxStretch」，从不把段推回 rest。
    // 绳端被挂饰拽、又被弯曲约束折着，段长会永久停在 > rest 的位置
    // （实测每段多 0.0~0.3%），挂饰挂在最后一节的**端点**上，
    // 这点松弛会直接变成「挂饰离挂点越来越远」，用户看到的是娃娃往下掉。
    //
    // 修法：把总松弛量记在 this.slack 里，每步只从**最后一节**收回一丁点。
    // 不对所有段动手：中间段各有绕圈自由度，一起收会互相打架。
    const last = pts.length - 1;
    if (last >= 1 && this.slack > 0) {
      const a = pts[last - 1];
      const b = pts[last];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const restLast = this._restOf(last - 1);
      if (d > restLast + 1e-6) {
        const want = Math.min(this.slack * SLACK_RATE, d - restLast);
        const ux = (b.x - a.x) / d;
        const uy = (b.y - a.y) / d;
        b.x -= ux * want;
        b.y -= uy * want;
        this.slack = Math.max(0, this.slack - want);
      }
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;

      const segRest = this._restOf(i);
      const segLimit = segRest * maxStretch;
      stretchSum += d / segRest;
      segCount++;

      if (d > segLimit) {
        const wa = a.invMass;
        const wb = b.invMass;
        const wsum = wa + wb;
        if (wsum <= 0) continue;
        const corr = (d - segLimit) / (d * wsum);
        a.x += dx * corr * wa;
        a.y += dy * corr * wa;
        b.x -= dx * corr * wb;
        b.y -= dy * corr * wb;
      }
    }

    if (segCount > 0) {
      // 累计松弛 = 实际折线长 - 自然长度。约束保证 >= 0，这里只做浮点护栏。
      // 第 29 轮：自然总长必须按段累加，模拟段比主体段长得多，不能乘段数。
      let natural = 0;
      for (let i = 0; i < pts.length - 1; i++) natural += this._restOf(i);
      this.slack = Math.max(0, this.polylineLength - natural);
      const ratio = stretchSum / segCount;
      this.tension = Math.min(1, Math.max(0, (ratio - 1) / Math.max(0.01, maxStretch - 1)));
    }
  }

  /**
   * 关节弯曲上限：任何一处关节的弯曲角不得超过 maxBend（弧度，0 = 伸直）。
   *
   * 【为什么不沿用 monoDrop】monoDrop 的语义是"每个节点必须比上一个低 1px"，
   * 等于禁止整条绳翻到挂点上方，与需求 R15（允许翻到指针上方）直接冲突。
   * 实测关掉 monoDrop 后"绳端高于挂点"的帧占比从 0% 升到 51%（这正是 R15 要的），
   * 但相邻段方向差 > 90° 的折叠从 8 次涨到 211~529 次。
   *
   * 【正确做法】只约束"关节的弯曲角度"，不约束"绳子的绝对朝向"：
   * 绳可以整体翻到上方（R15 满足），但任何一处关节都不许折成锐角（防 Z 折）。
   *
   * 【手法】把关节两侧的邻居绕关节做纯旋转：
   *   · 纯旋转精确保持两段长度不变，不可能注入拉伸；
   *   · 同时旋转 (x,y) 与 (px,py)，所以修正不会被 Verlet 当成速度。
   * 设 v1 = a - b、v2 = c - b（都以关节 b 为原点），有符号夹角
   *   alpha = atan2(v1 × v2, v1 · v2)
   * 因为两者同原点：完全伸直时 v1 与 v2 反向 => |alpha| = pi；完全对折时同向 => |alpha| = 0。
   * 所以真正的「弯曲角」是 bend = pi - |alpha|，maxBend 约束的是 bend 而不是 alpha。
   * （第一版把这里写反了：放过了完全对折、反而去掰直绳子，实测最差关节只剩 0.0°。）
   *
   * 把 v1 转 +phi、v2 转 -phi 会让 alpha 变成 alpha - 2*phi，
   * 要增大 |alpha| 到 pi - maxBend 需 delta = bend - maxBend，取
   *   phi = -sign(alpha) * delta / 2
   * 即可把弯曲角压到 maxBend 以内，且两段长度精确不变。
   *
   * 【为什么要交替迭代】掰直 j 号关节会把 j±1 号掰弯，而随后的 _solveConstraints
   * 又会把关节角拉回去一点。单轮实测：最差关节 77.9°、总长冲到 107px；
   * 3 轮（config.bendIterations）收敛到 145~154° / 90.0px，见 _step 里的 bendRounds 循环。
   */
  _limitBend(maxBend) {
    if (!(maxBend > 0)) return;
    const pts = this.points;
    const n = pts.length;
    for (let j = 1; j < n - 1; j++) {
      const b = pts[j];
      const a = pts[j - 1];
      const c = pts[j + 1];
      let v1x = a.x - b.x, v1y = a.y - b.y;
      let v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      v1x /= l1; v1y /= l1;
      v2x /= l2; v2y /= l2;
      const dot = Math.max(-1, Math.min(1, v1x * v2x + v1y * v2y));
      const cross = v1x * v2y - v1y * v2x;
      const alpha = Math.atan2(cross, dot);
      const absA = Math.abs(alpha);

      // 【语义】alpha 是 v1 -> v2 的有符号夹角，两者的原点都是关节 b：
      //   绳子完全伸直 => v1 与 v2 反向 => |alpha| = pi
      //   绳子完全对折 => v1 与 v2 同向 => |alpha| = 0
      // 所以「弯曲角」bend = pi - |alpha|。maxBend 约束的是 bend，不是 alpha。
      // （第一版就是这里写反了：它放过了对折、反而去掰直绳子。）
      const bend = Math.PI - absA;
      if (bend <= maxBend) continue;

      // 要把 |alpha| 增大 delta，使 |alpha| + delta = pi - maxBend。
      // 把 v1 转 +phi、v2 转 -phi 会让 alpha 变成 alpha - 2*phi，
      // 解出 phi = -sign(alpha) * delta / 2。
      const delta = bend - maxBend;
      const phi = -(alpha >= 0 ? 1 : -1) * delta * 0.5;

      // 【必须按逆质量加权】a 可能是被钉死的锚点（invMass = 0）。
      // 第一版无条件 _rotateAbout(a, ...)，实测每次调用都把锚点从鼠标位置
      // 推开 1.0~3.2px（n=3/4/5），等于绳子自己拽着指针跑。
      // 按 wa/(wa+wc) 分配旋转量：铰链点权重为 0 时完全不动，
      // 两端都可动时各转一半（与原来等价），且两段长度依然精确不变。
      const wa = a.invMass, wc = c.invMass;
      const wsum = wa + wc;
      if (wsum <= 0) continue;
      this._rotateAbout(a, b, phi * (wa / wsum) * 2);
      this._rotateAbout(c, b, -phi * (wc / wsum) * 2);
    }
  }

  /** 把质点 q 绕支点 o 旋转 phi（同时旋转位置与上一位置，避免产生假速度） */
  _rotateAbout(q, o, phi) {
    const cs = Math.cos(phi);
    const sn = Math.sin(phi);
    const rx = q.x - o.x;
    const ry = q.y - o.y;
    q.x = o.x + rx * cs - ry * sn;
    q.y = o.y + rx * sn + ry * cs;
    const px = q.px - o.px;
    const py = q.py - o.py;
    q.px = o.px + px * cs - py * sn;
    q.py = o.py + px * sn + py * cs;
  }

  _updateTip() {
    const pts = this.points;
    if (pts.length < 2) return;
    const tip = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    this.tipX = tip.x;
    this.tipY = tip.y;

    const dx = tip.x - prev.x;
    const dy = tip.y - prev.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) {
      this.tipDirX = dx / d;
      this.tipDirY = dy / d;
    } else {
      this.tipDirX = 0;
      this.tipDirY = 1;
    }
  }

  /** 绳端相对支点的整体倾角（弧度，正 = 向右偏），给娃娃旋转用 */
  get tipAngle() {
    const pts = this.points;
    if (pts.length < 2) return 0;
    const a = pts[0];
    const b = pts[pts.length - 1];
    // 注意：这里不能对 dy 做 max(1e-6, ...) 之类的钳位。
    // 一旦绳端被甩到与支点等高或更高（dy <= 0），钳位会让分母恒为 1e-6，
    // 把角度永远算成 ±90°。
    return Math.atan2(b.x - a.x, b.y - a.y);
  }

  /** 折线总长（各段长度之和），测试与调试用 */
  get polylineLength() {
    const pts = this.points;
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    }
    return total;
  }

  /**
   * ★ 挂饰的挂点（T1 修正，第 21 轮）：最后一节的**末端点**。
   *
   * 与 tipX/tipY 的区别：tip 是最后一个**质点**，而绘制绳子时末端还要沿
   * 最后一节方向再延伸 rope.overlap 像素（伸进挂饰内部遮住缝隙，见 doll.js
   * 的 _drawRope）。柔性弯曲允许末节方向与整绳连线角不同，所以
   * 「绳子实际画到哪里」和「最后一个质点在哪里」是两个点，差 overlap 像素。
   *
   * 挂饰挂在最后一段绳的**末尾**，所以旋转枢轴必须用这个点，不能用 tip。
   * 真实绳长恒定 => 这个点到支点的距离恒等于 length（见下方 _slackNode），
   * 因此它不会因为弯曲约束而"缩进"一段。
   */
  get tailPoint() {
    const pts = this.points;
    const n = pts.length;
    if (n === 0) return { x: this.anchorX, y: this.anchorY };
    if (n === 1) return { x: pts[0].x, y: pts[0].y };
    const a = pts[n - 2];
    const b = pts[n - 1];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ex = this.overlap || 0;
    return { x: b.x + (dx / len) * ex, y: b.y + (dy / len) * ex };
  }

  /** 绳子末端延伸量（伸进挂饰内部遮住缝隙），与 config.rope.overlap 同义 */
  setOverlap(px) {
    this.overlap = isFinite(px) ? Math.max(0, px) : 0;
  }

  /** 质点数组（从支点到绳端），画绳子用 */
  get path() {
    return this.points;
  }

  get count() {
    return this.points.length;
  }
}

if (typeof window !== "undefined") {
  window.RopeChain = RopeChain;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { RopeChain };
}
