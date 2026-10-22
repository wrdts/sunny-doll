// renderer/recorder.js  --  诊断记录器：每 0.1s 把"现在到底是什么情况"记一条。
//
// 为什么需要它：手感出问题时，光看屏幕分不清是"绳子在拉"还是"娃娃自己在飞"。
// 把每 0.1s 的质点坐标、速度、加速度、绳子净力一起落成文件，事后就能对着数据找原因，
// 不用再靠"我感觉它弹了七八下"这种描述。
//
// 三条纪律：
//   1. 只读物理，绝不写回。记录器不许改变手感。
//   2. 算不出来的量写 null，绝不用 0 冒充 —— 0 会被读成"真的没受力"。
//   3. 每条样本都带墙钟时间戳 w。覆盖层被隐藏导致漏采时，从 t 与 w 的差值就能看出来。
"use strict";

(function () {
  const DEFAULT_INTERVAL = 100;       // 毫秒。用户要的就是每 0.1s 一条
  const DEFAULT_MAX_SAMPLES = 18000;  // 30 分钟。防止忘了关把内存吃光
  const STATUS_PUSH_MS = 500;         // 状态回推间隔（面板上显示的"已记录多少条"）

  /** 保留两位小数。非数字 / 非有限值一律给 null（见纪律 2） */
  function r2(v) {
    if (typeof v !== "number" || !isFinite(v)) return null;
    return Math.round(v * 100) / 100;
  }

  function clock() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  class Recorder {
    constructor(opts) {
      const o = opts || {};
      this.rope = o.rope;
      this.getCursor = o.getCursor || function () { return { x: 0, y: 0 }; };
      this.getAttach = o.getAttach || function () { return { x: 0, y: 0 }; };
      this.getRenderer = o.getRenderer || function () { return null; };
      // 由调用方接上：onStatus(状态) 每 0.5s 一次，onStop(完整数据) 停止时一次
      this.onStatus = null;
      this.onStop = null;

      this.intervalMs = DEFAULT_INTERVAL;
      this.maxSamples = DEFAULT_MAX_SAMPLES;
      this.recording = false;
      this.samples = [];
      this.startedAt = 0;
      this.startedWall = 0;

      this._nextAt = 0;
      this._nextPushAt = 0;
      this._prev = null;
      this._cfgSnapshot = null;
      this._maxSpeed = 0;
      this._maxAngle = 0;
      this._maxForce = 0;
      this._stopReason = null;
    }

    start(opts) {
      const o = opts || {};
      this.intervalMs = Math.max(16, Math.min(2000, o.intervalMs || DEFAULT_INTERVAL));
      this.maxSamples = Math.max(10, Math.min(200000, o.maxSamples || DEFAULT_MAX_SAMPLES));
      this.recording = true;
      this.samples = [];
      this.startedWall = Date.now();
      this.startedAt = clock();
      // 【第 29 轮修】第一条样本要落在 startedAt + intervalMs，不能落在 startedAt 本身。
      // 原来 _nextAt = startedAt，主循环第一帧（+16.67ms）就满足 now >= _nextAt，
      // 于是第一条样本的 t 是 17ms 而不是 100ms，整份记录的节拍从开头就是歪的。
      this._nextAt = this.startedAt + this.intervalMs;
      this._nextPushAt = this.startedAt + STATUS_PUSH_MS;
      this._prev = null;
      this._maxSpeed = 0;
      this._maxAngle = 0;
      this._maxForce = 0;
      this._stopReason = null;
      // 参数快照只在开录那一刻拍一次：中途改设置会让曲线前后不可比，
      // 所以 meta 里记的是"开录时的设置"，分析时必须看这个而不是现在的面板值。
      try {
        this._cfgSnapshot = JSON.parse(JSON.stringify(window.CONFIG || {}));
      } catch (_) {
        this._cfgSnapshot = null;
      }
      return this.status();
    }

    /**
     * 停止。reason: "user"（点了按钮）| "auto"（撞到 maxSamples 上限）。
     * 停止后立刻把完整数据交给 onStop —— 只有一条出口，调用方不用再分别处理
     * "用户停"和"自动停"两种情况。
     */
    stop(reason) {
      if (!this.recording) return null;
      this.recording = false;
      this._stopReason = reason || "user";
      if (typeof this.onStatus === "function") this.onStatus(this.status());
      const data = this.result();
      if (typeof this.onStop === "function") this.onStop(data);
      return data;
    }

    /** 当前状态快照（方法而不是 getter：内部三处调用都写成 this.status()，
        做成 getter 会变成"调用一个对象"，直接 TypeError） */
    status() {
      return {
        recording: this.recording,
        count: this.samples.length,
        elapsedMs: this.recording ? Math.round(clock() - this.startedAt) : 0,
        intervalMs: this.intervalMs,
        maxSamples: this.maxSamples
      };
    }

    result() {
      const n = this.samples.length;
      return {
        version: 1,
        intervalMs: this.intervalMs,
        startedAt: this.startedWall,
        stoppedAt: Date.now(),
        stopReason: this._stopReason,
        meta: {
          screen: {
            w: window.innerWidth,
            h: window.innerHeight,
            dpr: window.devicePixelRatio || 1
          },
          ropeLength: r2(this.rope && this.rope.length),
          restLen: r2(this.rope && this.rope.restLen),
          nodes: (this.rope && this.rope.count) || 0,
          config: this._cfgSnapshot
        },
        summary: {
          count: n,
          durationMs: n ? this.samples[n - 1].t : 0,
          maxSpeed: r2(this._maxSpeed),
          maxAngle: r2(this._maxAngle),
          maxForce: r2(this._maxForce)
        },
        samples: this.samples
      };
    }

    /**
     * 每帧调用一次，内部按 intervalMs 抽稀。
     * 用主循环的 now 而不是 setInterval：覆盖层隐藏时 rAF 会停，
     * 用定时器只会在看不见的时候继续堆样本。
     */
    tick(now) {
      if (!this.recording) return;
      const t = typeof now === "number" ? now : clock();
      if (t < this._nextAt) {
        if (t >= this._nextPushAt && typeof this.onStatus === "function") {
          this._nextPushAt = t + STATUS_PUSH_MS;
          this.onStatus(this.status());
        }
        return;
      }
      // 用"理论节拍 + 间隔"推进，而不是 t + interval：
      // 后者会把每帧的舍入误差一直累积下去，10 分钟能漂出好几条样本。
      this._nextAt += this.intervalMs;
      if (this._nextAt < t) this._nextAt = t + this.intervalMs;
      this._sample(t);

      if (this.samples.length >= this.maxSamples) this.stop("auto");
    }

    _sample(now) {
      const rope = this.rope;
      if (!rope || !rope.path || rope.path.length < 2) return;
      const pts = rope.path;
      const n = pts.length;
      const t = Math.round(now - this.startedAt);
      const dtSec = this._prev ? (t - this._prev.t) / 1000 : 0;

      // Verlet 的"速度"就是 (x - px) / h。这里取和 _step 一样的钳制，
      // 否则 fixedStep 调到 1/60 或 1/480 时报出来的速度会整体偏大/偏小。
      const cfg = rope.cfg || {};
      const h = Math.min(1 / 60, Math.max(1 / 480, cfg.fixedStep || 1 / 240));
      const env = (typeof rope.environmentAccel === "function")
        ? rope.environmentAccel()
        : { gravity: 0, windX: 0, windY: 0 };
      const drag = cfg.drag !== undefined ? cfg.drag : 0;
      // Verlet 里每子步都有 keep = exp(-k*h) 的速度乘性衰减，
      // 折合每秒 -k*v 的减速度。差分出来的加速度里含这一项，必须补回去，
      // 否则算出的"绳力"会系统性偏小（k=0.3、v=1000 时约差 300px/s²，接近重力 1/10）。
      const kDamp = (typeof rope.dampingRate === "function") ? rope.dampingRate() : 0;

      const nodes = [];
      const segs = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        nodes.push({
          x: r2(p.x),
          y: r2(p.y),
          vx: r2((p.x - p.px) / h),
          vy: r2((p.y - p.py) / h)
        });
        if (i > 0) segs.push(r2(Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)));
      }

      const tail = pts[n - 1];
      const tvx = (tail.x - tail.px) / h;
      const tvy = (tail.y - tail.py) / h;
      const speed = Math.hypot(tvx, tvy);

      // 熊受到的【绳子合力】（= 重力之外剩下的那部分）。
      //
      // 推导：熊的净加速度 a = 绳力/m + 重力 + 风 + 空气阻力
      //   => 绳力 = m · (a − 重力 − 风 − 空气阻力 + 阻尼补偿)
      // 所以这个量正好是"绳子在拉熊的力"，静止竖直时它就等于 m·g（向上托住熊）。
      // 想验证物理解析式对不对，看这个数最快：静态 = m·g、摆到最低点 = m(g + v²/L)。
      //
      // 单位是 px/s^2 × 相对质量，不是牛顿 —— 程序里没有真实的质量/长度换算，
      // 所以绝对值只用于【前后对比与量级核对】，不要当成物理意义上的力。
      let ax = null, ay = null, ropeFx = null, ropeFy = null, ropeF = null;
      if (this._prev && dtSec > 1e-6) {
        const pvx = this._prev.tail.vx;
        const pvy = this._prev.tail.vy;
        ax = (tvx - pvx) / dtSec;
        ay = (tvy - pvy) / dtSec;
        const vAvgX = (tvx + pvx) * 0.5;
        const vAvgY = (tvy + pvy) * 0.5;
        const vAvg = Math.hypot(vAvgX, vAvgY);
        const airX = -drag * vAvg * vAvgX;
        const airY = -drag * vAvg * vAvgY;
        ropeFx = tail.mass * (ax + kDamp * vAvgX - (env.windX + airX));
        ropeFy = tail.mass * (ay + kDamp * vAvgY - (env.gravity + env.windY + airY));
        ropeF = Math.hypot(ropeFx, ropeFy);
      }

      const angleDeg = rope.tipAngle * 180 / Math.PI;
      let angVel = null;
      if (this._prev && dtSec > 1e-6) {
        let d = angleDeg - this._prev.angle;
        // 弦角在 ±180 处会跳变，差分前先折回 [-180, 180]，否则会算出假的高角速度
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        angVel = d / dtSec;
      }

      // 娃娃画出去的角度 vs 没限幅前的角度：两者不等就说明被 angleLimit 压住了
      const r = this.getRenderer();
      // 兜底顺序：渲染器自己的 cfg -> window.CONFIG.doll -> {}。
      // 少一层 ?. 就会在"渲染器还没建好"的那一帧抛出去，
      // 而 tick() 是在 rAF 主循环里调的，一抛整帧就断了。
      const dollCfg =
        (r && r.cfg && r.cfg.doll) ? r.cfg.doll :
        (window.CONFIG && window.CONFIG.doll) ? window.CONFIG.doll : {};
      const ratio = dollCfg.bodyRotateRatio !== undefined ? dollCfg.bodyRotateRatio : 1;
      // T1：视口高。只在渲染器没就绪时才用得到（见下面的 heightCss）。
      const viewH = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 1;
      // T1：复刻 doll.js 的 anchorOffset。渲染器在就抄它的 _dollWidth()，
      // 不在就用 panel 里同名的配置兜底，保证记录能离线还原旋转原点。
      const heightCss = r && typeof r.dollHeight === "number" ? r.dollHeight
        : Math.max((dollCfg.heightMin !== undefined ? dollCfg.heightMin : 56),
          Math.min((dollCfg.heightMax !== undefined ? dollCfg.heightMax : 128),
            (dollCfg.heightRatio !== undefined ? dollCfg.heightRatio : 0.1) * viewH));
      const dollW = (r && typeof r._dollWidth === "function") ? r._dollWidth(heightCss) : heightCss;
      function anchorOf(d, h, w) {
        const ax = d && d.anchorX !== undefined ? d.anchorX : 0.5;
        const ay = d && d.anchorY !== undefined ? d.anchorY : 0.0;
        return {
          ox: r2(-w * (ax - 0.5)),
          oy: r2(-Math.min((d && d.heightMax !== undefined ? d.heightMax : 128), h, ay * h))
        };
      }
      const rawDeg = r ? (r._bodyAngle * ratio * 180 / Math.PI) : null;
      const drawnDeg = r ? (r._bodyAngleDrawn * 180 / Math.PI) : null;
      const clamped = (typeof rawDeg === "number" && typeof drawnDeg === "number")
        ? Math.abs(rawDeg) - Math.abs(drawnDeg) > 0.01
        : null;

      const cur = this.getCursor();
      const at = this.getAttach();

      const sample = {
        t: t,
        w: Date.now(),
        cx: r2(cur.x), cy: r2(cur.y),
        ax: r2(at.x), ay: r2(at.y),
        len: r2(rope.length),
        restLen: r2(rope.restLen),
        tension: r2(rope.tension),
        tipX: r2(rope.tipX), tipY: r2(rope.tipY),
        angle: r2(angleDeg),
        angVel: r2(angVel),
        nodes: nodes,
        segs: segs,
        bear: {
          x: r2(tail.x), y: r2(tail.y),
          vx: r2(tvx), vy: r2(tvy), speed: r2(speed),
          ax: r2(ax), ay: r2(ay),
          acc: ax === null ? null : r2(Math.hypot(ax, ay)),
          ropeFx: r2(ropeFx), ropeFy: r2(ropeFy), ropeF: r2(ropeF),
          mass: r2(tail.mass)
        },
        doll: {
          raw: r2(rawDeg), drawn: r2(drawnDeg), clamped: clamped,
          // T1：图片挂点相对顶边中点的偏移（CSS px）。渲染层专属，不进物理，
          // 但「娃娃为什么绕那个点转」只能靠这两个数还原，必须落盘。
          anchor: anchorOf(dollCfg, heightCss, dollW)
        }
      };

      if (speed > this._maxSpeed) this._maxSpeed = speed;
      if (Math.abs(angleDeg) > this._maxAngle) this._maxAngle = Math.abs(angleDeg);
      if (ropeF !== null && ropeF > this._maxForce) this._maxForce = ropeF;

      this._prev = { t: t, angle: angleDeg, tail: { vx: tvx, vy: tvy } };
      this.samples.push(sample);
    }
  }

  if (typeof window !== "undefined") {
    window.Recorder = Recorder;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { Recorder };
  }
})();