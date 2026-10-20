// renderer/main.js  --  渲染层入口：拿真实指针坐标 -> 摆好挂点 -> 跑绳索物理 -> 画。
"use strict";

(function () {
  const canvas = document.getElementById("stage");
  const renderer = new DollRenderer(canvas, window.CONFIG);
  // RopeChain 需要同时拿到 chain（刚度/阻尼/段数）与 physics（重力/风/步长）两段参数，
  // 少给一段就会全走默认值（之前只传 physics，导致 chain 段所有参数都没生效）。
  function ropeCfg() {
    const C = window.CONFIG;
    return Object.assign({}, C.physics, C.chain);
  }
  const rope = new RopeChain(ropeCfg());

  // ---------- 诊断记录器 ----------
  // 每 0.1s 采一条：质点坐标、各段长度、绳端速度/加速度、熊的净力、娃娃实际画出的角度。
  // 只在用户从设置面板点了「开始记录」之后才工作，平时完全不跑（recording=false 时
  // tick() 第一行就 return），所以对帧率没有可测量的影响。
  const recorder = new Recorder({
    rope: rope,
    getCursor: function () { return cursor; },
    getAttach: function () { return attach; },
    getRenderer: function () { return renderer; }
  });
  recorder.onStatus = function (st) {
    if (window.api && window.api.sendRecordStatus) window.api.sendRecordStatus(st);
  };
  // 停止时把完整数据交给主进程落盘。渲染层没有 fs 权限，写文件必须走 IPC。
  // 落盘成功 / 失败都会在设置面板上显示，这里只补一条控制台输出方便排查。
  recorder.onStop = function (data) {
    if (!window.api || !window.api.saveRecord) return;
    window.api.saveRecord(data).then(function (res) {
      if (!res || !res.ok) {
        console.error("[晴天娃娃] 记录保存失败：" + (res && res.error));
        return;
      }
      console.log("[晴天娃娃] 记录已保存：" + res.path + "（" + res.samples + " 条）");
    }).catch(function (err) {
      console.error("[晴天娃娃] 记录保存失败：" + (err && err.message));
    });
  };

  let last = 0;
  let rafId = 0;
  // 真实指针位置（窗口 CSS 像素）。挂点 = 这个点 + config.cursor 的手动偏移
  const cursor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const attach = { x: 0, y: 0 };
  let lastMouseEventAt = 0;
  let smoothSpeed = 0;

  // ---------- 指针控制权模式（两种模式，运行时切换） ----------
  // 指针有三路来源在竞争：真实 mousemove、主进程 8ms 轮询、脚本注入。
  // 做效果验证时真实鼠标会污染观测，所以提供"锁定"模式彻底断开前两路，
  // 让 cursor 完全由脚本（window.__doll.setPointer / cursor）控制。
  //
  // 【模式】
  //   false = 鼠标可控（正常使用）：真实鼠标驱动指针
  //   true  = 鼠标不可控（调试用）：只有脚本能改指针，真实鼠标完全失效
  //
  // 切换方式（不暴露给普通用户，只能开发者自己触发）：
  //   1. 配置文件 debug.lockPointer（下次启动生效）
  //   2. 快捷键 Ctrl+Alt+L（立即切换，无需重启）
  //   3. window.__doll.lock(true/false)（CDP 用）
  // 见 docs/03-测试方法论.md 铁律 1。
  const DEBUG_CFG = window.CONFIG.debug || {};
  let pointerLocked = DEBUG_CFG.lockPointer === true;

  // ---------- 挂点：系统指针热点 + 手动偏移 ----------
  function updateAttach() {
    const a = renderer.attachPoint(cursor.x, cursor.y);
    attach.x = a.x;
    attach.y = a.y;
  }

  // ---------- 尺寸 ----------
  function applySize() {
    const dpr = window.devicePixelRatio || 1;
    renderer.resize(window.innerWidth, window.innerHeight, dpr);

    const len = renderer.ropeLength;
    // segments 是【段数】，rebuild() 的第二个参数是【质点个数】= 段数 + 1
    const segs = (window.CONFIG.chain && window.CONFIG.chain.segments) || 2;
    const nodeCount = segs + 1;
    // 这里必须和 nodeCount 比，不能和 segs 比 —— rope.count 是【质点个数】，
    // 写成 rope.count !== segs 会让条件恒为 true，每次 resize 都白白重建一次绳子。
    if (rope.count !== nodeCount || Math.abs(rope.length - len) > 0.5) {
      updateAttach();
      rope.setAnchor(attach.x, attach.y);
      rope.rebuild(len, nodeCount);
      rope.resetVertically();
    }
    // 坐标系变了，重定位避免假冲量
    updateAttach();
    rope.teleport(attach.x, attach.y);
    rope.resetVertically();
  }
  window.addEventListener("resize", applySize);

  // ---------- 指针来源 1：窗口内真实 mousemove（forward:true，最平滑） ----------
  // 监听器【永远注册】，只由 pointerLocked 做运行时拦截。
  // 这样 Ctrl+Alt+L / __doll.lock() 才能把鼠标控制权还回去，不必重启。
  window.addEventListener("mousemove", (e) => {
    if (pointerLocked) return;
    lastMouseEventAt = performance.now();
    cursor.x = e.clientX;
    cursor.y = e.clientY;
  }, { passive: true });

  // ---------- 指针来源 2：主进程轮询 screen.getCursorScreenPoint（兜底） ----------
  if (window.api && window.api.onCursor) {
    window.api.onCursor((p) => {
      if (pointerLocked) return;
      if (performance.now() - lastMouseEventAt < 200) return;
      cursor.x = p.x;
      cursor.y = p.y;
    });
  }

  // ---------- 指针控制权开关 ----------
  // lock=true：鼠标不可控（脚本独占）；lock=false：鼠标可控（真实鼠标生效）
  function setPointerLock(on) {
    pointerLocked = on === true;
    return pointerLocked;
  }

  // 快捷键 Ctrl+Alt+L：立即在两种模式间切换（开发者自用，不写进用户文档）
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.altKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      const now = setPointerLock(!pointerLocked);
      console.log("[pointer] " + (now ? "鼠标已锁定（脚本独占）" : "鼠标已解锁（真实鼠标生效）"));
    }
  });

  // ---------- 主循环 ----------
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    // 【测试用开关】脚本接管物理时必须置 true，否则主循环和脚本会【双驱动】：
    // 同一个 dt 里 rope.update() 被调用两次，位移被推两倍、再被 Verlet 的
    // px 同步抹掉一半，测出来的外甩量只有单驱动的 1/6（实测 5.9px vs 38.0px）。
    // 这不是物理问题，是测试污染。规范见 docs/07-测试规范-强制.md 铁律 0。
    const paused = window.__drivePaused === true;

    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.25) dt = 0.25;

    if (!paused) {
    updateAttach();


    const ph = window.CONFIG.physics;

    // 【挂点跟随：一律直接到位，不做任何平滑】
    //
    // 用户明确要求："不要使用这种缓慢偏移到为止的方法。而是线段的长度几乎不变，
    // 小熊有物理的效果，线段主要起牵引作用"。
    //
    // 曾经用 cursorSmoothing 让挂点指数逼近指针（tau = smooth*0.5 秒），
    // 结果是：指针已经到 B 点，挂点还在半路上蹭，渲染时 _drawRope 又会把
    // 绳首强行画到指针实时位置，于是绳首(指针)与绳身(还在半路)之间被拉出
    // 一条几百 px 的假斜线（实测 gapLive=383px），看起来就是"一根长杆横穿屏幕"。
    //
    // 正确的分工：
    //   挂点 = 指针位置，每帧直接到位（零延迟，视觉上绝不脱节）
    //   惯性 = 由 rope 的 followMode: "velocity" 提供，
    //          见 renderer/rope.js 的 update()：
    //          把本帧锚点位移【均摊到 willRun 个子步】推进，
    //          且 p0.px 保留为上一帧锚点 ⇒ Verlet 速度 = 真实鼠标速度
    //          ⇒ 离心力/加速度响应生效，这才是"绳子牵引、小熊有惯性"。
    //          绝不能一次性把位移注入第一个子步（会把整帧位移当成一个子步
    //          内的速度，实测 60fps 1.44° vs 240fps -23.54°，帧率无关性尽失）。
    const prevX = rope.anchorX;
    const prevY = rope.anchorY;

    // 超大跳变（如指针瞬移/切屏）：直接吸附，避免整链被拖出屏幕外再荡回来
    const jump = Math.hypot(attach.x - prevX, attach.y - prevY);
    if (jump > (ph.maxPivotStep || 400) * 4) {
      rope.teleport(attach.x, attach.y);
    } else {
      rope.setAnchor(attach.x, attach.y);
    }

    rope.update(dt);

    // 挂点速度（给娃娃拉伸效果用）
    const v = Math.hypot(rope.anchorX - prevX, rope.anchorY - prevY) / Math.max(dt, 1 / 240);
    smoothSpeed += (v - smoothSpeed) * 0.25;

    renderer.draw({
      rope: rope,
      cursorX: cursor.x,
      cursorY: cursor.y,
      speed: smoothSpeed,
      time: now,
    });
    } else {
      // 暂停时仍然渲染，方便脚本截图看当前姿态
      renderer.draw({
        rope: rope,
        cursorX: cursor.x,
        cursorY: cursor.y,
        speed: smoothSpeed,
        time: now,
      });
    }

    // 采样放在 draw 之后：娃娃的 _bodyAngleDrawn 是 draw() 里算出来的，
    // 放在前面会拿到上一帧的旋转角。
    recorder.tick(now);
  }
  // ---------- 重载配置（托盘触发） ----------
  function deepAssign(target, fresh) {
    if (!fresh || typeof fresh !== "object") return;
    for (const k of Object.keys(fresh)) {
      const v = fresh[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (!target[k] || typeof target[k] !== "object") target[k] = {};
        deepAssign(target[k], v);
      } else {
        target[k] = v;
      }
    }
  }

  let configFreshHandler = null;
  window.addEventListener("config-fresh", (e) => {
    configFreshHandler = e.detail;
  });

  /**
   * 把 window.CONFIG 的最新值同步给渲染器与物理引擎。
   * 两处会调用它：托盘"重载配置"（整份重读 config.js）和设置面板（只盖覆盖值）。
   */
  function syncCfg() {
    renderer.cfg = window.CONFIG;
    rope.cfg = ropeCfg();
    renderer.emojiMetrics = null;
  }

  let reloading = false;
  function reloadConfig() {
    if (reloading) return;
    reloading = true;
    configFreshHandler = null;
    const s = document.createElement("script");
    s.src = "config.js?t=" + Date.now();
    s.onload = () => {
      const fresh = window.__CONFIG_FRESH__ || configFreshHandler;
      if (fresh) deepAssign(window.CONFIG, fresh);
      syncCfg();
      captureDefaults();      // config.js 换了，出厂基线也要跟着换
      applySize();
      // 重载 config.js 会把用户调过的手感冲掉，所以重新盖一遍当前覆盖值
      applySettings({ overrides: latestOverrides });
      reloading = false;
      console.log("[晴天娃娃] 配置已重载");
    };
    s.onerror = () => {
      reloading = false;
      console.error("[晴天娃娃] 配置重载失败");
    };
    document.head.appendChild(s);
  }

  if (window.api && window.api.onReloadConfig) {
    window.api.onReloadConfig(reloadConfig);
  }

  // ---------- 用户设置（设置面板实时下发）----------
  // 【为什么不能让重复的粘贴值累积】覆盖值是"整份替换"不是"增量合并"：
  // 面板每次提交的都是完整快照（只含被改过的字段）。这里先把 CONFIG 恢复成
  // config.js 的出厂默认，再盖上覆盖值 —— 否则用户把滑块拖回出厂值后，
  // 旧值会永远留在 CONFIG 里，再也回不去。
  let pristineDefaults = null;

  function captureDefaults() {
    // 第一次收到设置时把当前 CONFIG 深拷一份作为"出厂默认"基线。
    // 注意：重载配置（reloadConfig）会换成新的 DEFAULTS 对象，
    // 那时要重新捕获一次，否则基线会停留在旧版本。
    pristineDefaults = JSON.parse(JSON.stringify(window.CONFIG));
  }

  let latestOverrides = {};

  function applySettings(payload) {
    const overrides = payload && payload.overrides ? payload.overrides : {};
    latestOverrides = overrides;
    if (!pristineDefaults) captureDefaults();
    // 1) 回到出厂默认，2) 盖上覆盖值。
    // 必须"先复位再覆盖"：覆盖值是完整快照（只含被改过的字段），
    // 如果直接往 CONFIG 上叠，用户把滑块拖回出厂值后旧值会永远赖着不走。
    deepAssign(window.CONFIG, JSON.parse(JSON.stringify(pristineDefaults)));
    deepAssign(window.CONFIG, overrides);
    syncCfg();

    // 【不要调 applySize()】它结尾无条件 teleport + resetVertically，
    // 拖重力滑块时每 60ms 就会把绳子扳回竖直，摆动被反复打断，看起来像"卡住"。
    // 只有段数或绳长真的变了才需要重建链。
    const len = renderer.ropeLength;
    const segs = (window.CONFIG.chain && window.CONFIG.chain.segments) || 2;
    const nodeCount = segs + 1;
    if (rope.count !== nodeCount || Math.abs(rope.length - len) > 0.5) {
      updateAttach();
      rope.setAnchor(attach.x, attach.y);
      rope.rebuild(len, nodeCount);
      rope.resetVertically();
    }
  }

  if (window.api && window.api.onSettings) {
    window.api.onSettings(applySettings);
  }

  // ---------- 诊断记录：开始 / 停止 ----------
  // cmd = "start" | "stop"，由设置面板发起、主进程转发。
  // 重复 start 是幂等的（先停掉旧的再开新的），这样面板按钮的语义就是"永远从这一秒开始"。
  if (window.api && window.api.onRecordCmd) {
    window.api.onRecordCmd(function (msg) {
      const cmd = msg && msg.cmd;
      if (cmd === "start") {
        if (recorder.recording) recorder.stop("restart");
        recorder.start(msg);
      } else if (cmd === "stop") {
        recorder.stop("user");
      }
    });
  }
  // ---------- 调试：暴露物理状态 ----------
  // exposeState = true 时开放 window.__doll，用于 CDP 读取内部状态。
  // 【交付前必须改回 false】
  if (window.CONFIG.debug && window.CONFIG.debug.exposeState) {
    window.__doll = {
      rope: rope,
      cursor: cursor,
      attach: attach,
      renderer: renderer,
      // 注意：这是 getter，读到的是实时值（切换模式后立刻反映）
      get locked() { return pointerLocked; },

      /** 脚本直接设置指针位置（仅锁定模式下生效，否则会被真实鼠标覆盖） */
      setPointer: function (x, y) {
        if (!isFinite(x) || !isFinite(y)) return false;
        cursor.x = x;
        cursor.y = y;
        return true;
      },

      /** 运行时切换模式，立即生效，无需重启。true = 鼠标不可控，false = 鼠标可控 */
      lock: function (on) { return setPointerLock(on); },

      /**
       * 【测试专用】脚本单步驱动物理：把指针挪到 (x,y) 并推进一帧物理。
       * 用法：__doll.lock(true) + __drivePaused = true，然后循环调 stepTo()，
       * 主循环完全不参与，所以不存在双驱动污染，真实鼠标也已被 lock 断开。
       * @param {number} x CSS 像素
       * @param {number} y CSS 像素
       * @param {number} [dt] 秒，默认 1/60
       */
      stepTo: function (x, y, dt) {
        if (!isFinite(x) || !isFinite(y)) return false;
        const d = dt > 0 ? dt : 1 / 60;
        cursor.x = x;
        cursor.y = y;
        updateAttach();
        const ph = window.CONFIG.physics;
        const prevX = rope.anchorX;
        const prevY = rope.anchorY;
        const jump = Math.hypot(attach.x - prevX, attach.y - prevY);
        if (jump > (ph.maxPivotStep || 400) * 4) {
          rope.teleport(attach.x, attach.y);
        } else {
          rope.setAnchor(attach.x, attach.y);
        }
        rope.update(d);
        const v = Math.hypot(rope.anchorX - prevX, rope.anchorY - prevY) / Math.max(d, 1 / 240);
        smoothSpeed += (v - smoothSpeed) * 0.25;
        return true;
      },

      /** 只推进物理不挪指针（看停手后怎么收敛） */
      stepHold: function (dt) {
        const d = dt > 0 ? dt : 1 / 60;
        updateAttach();
        rope.setAnchor(attach.x, attach.y);
        rope.update(d);
        smoothSpeed = 0;
        return true;
      },

      state: function () {
        const pts = rope.path || [];
        return {
          cx: Math.round(cursor.x), cy: Math.round(cursor.y),
          ax: Math.round(attach.x), ay: Math.round(attach.y),
          tx: Math.round(rope.tipX), ty: Math.round(rope.tipY),
          segs: rope.count,
          len: Math.round(rope.length),
          tension: Number((rope.tension || 0).toFixed(3)),
          angle: Number((rope.tipAngle * 180 / Math.PI).toFixed(1)),
          speed: Math.round(smoothSpeed),
          locked: pointerLocked,
          // 全部质点坐标，逐帧诊断用（也能算 droop）
          pts: pts.map(function (q) {
            return [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10];
          }),
          // 娃娃当前实际画出去的旋转角（度），已经过死区 + 低通 + tanh 软限幅
          dollAngle: Number((renderer._bodyAngleDrawn * 180 / Math.PI).toFixed(1)),
        };
      }
    };
  }

  // ---------- 启动 ----------
  applySize();
  rafId = requestAnimationFrame(frame);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      last = 0;
      rafId = requestAnimationFrame(frame);
    }
  });
})();
