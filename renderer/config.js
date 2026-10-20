// renderer/config.js  --  所有可调参数都在这里。
// 改完保存后：托盘图标右键 -> "重载配置"，无需重启程序。
(function () {
  "use strict";

  const DEFAULTS = {
    // ---------- 娃娃外观 ----------
    doll: {
      // 占位表情符号。换成真实图片时把 emoji 设为 null，并填写 image.path
      emoji: "\u{1F9F8}",               // 🧸 泰迪熊（占位；换真图见下方 image.path）
      // 挂饰选择："emoji"=自带小熊，"image"=自定义图片（doll.image.path）。第 17 轮新增。
      dangle: "emoji",
      dangleName: "",
      dangleList: "[]",
      image: {
        path: null                  // 自定义挂饰图片路径（第 18 轮起导入的图存 assets\dangles\）
      },
      // 娃娃高度 = 屏幕高度 * heightRatio，再夹在 [heightMin, heightMax]
      heightRatio: 0.10,               // 娃娃高度 = 屏幕高度 * 该值
      heightMin: 56,
      heightMax: 128,
      // 娃娃绕自身中心旋转量 = 绳角 * 该比例（1 = 完全跟随绳子的方向）
      bodyRotateRatio: 1.0,
      // 娃娃旋转的死区（弧度）：小于这个角度直接当 0，
      // 吃掉鼠标上下移动时 atan2(dx,dy) 产生的假倾角抖动。0.10 ≈ 5.7°
      angleDeadzone: 0.02,            // 弧度。原来 0.10（5.7°）会把停手后 60~74% 的帧角度直接归零
      // 旋转角低通的时间常数（秒）。0.06 跟不住大摆幅，0.08 更顺
      bodyAngleTau: 0.08,
      // 旋转软限幅：45° 以下线性、以上按 tanh 渐近压到 45+18=63°，保证熊永远不会倒挂
      angleLimit: 45,
      angleLimitOvershoot: 18,
      // emoji 字形自带留白，正值往下挪、负值往上挪（像素）
      offsetY: -3,
      // 高速时沿运动方向轻微拉伸，甩动更有速度感
      stretch: {
        enabled: true,
        maxPercent: 0.10,           // 最多拉长 10%
        speedForMax: 2600           // px/s，达到该速度拉满
      },
      // 深色桌面上也看得清的轮廓
      outline: {
        enabled: true,
        color: "rgba(0,0,0,0.22)",
        width: 2
      },
      shadow: {
        enabled: true,
        color: "rgba(0,0,0,0.28)",
        blur: 10,
        offsetY: 4
      }
    },

    // ---------- 绳子 ----------
    rope: {
      show: true,
      color: "rgba(235,238,248,0.95)",
      // 线宽会随"张力"变化：拉得越长越细
      width: 2.2,
      widthMinFactor: 0.75,           // 最大拉伸时线宽缩到 75%
      // 绳长 = 屏幕高度 * lengthRatio，再夹在 [min, max]
      lengthRatio: 0.07,
      min: 60,
      max: 120,
      loop: true,                     // 指针处画一个小环，"挂"在指针上
      loopRadius: 3,
      // 绳子末端向下多画一段，伸进娃娃内部，避免视觉上"绳子断在半空"
      overlap: 10,
      // 绳子描边，保证白底 / 深色桌面上都看得见
      outline: {
        enabled: true,
        color: "rgba(40,44,58,0.55)",
        width: 1.2
      },
    },

    // ---------- 绳索物理（Verlet + 距离约束） ----------
    // segments = 段数（质点个数 = segments + 1）。1 = 纯刚杆（无弯曲自由度），2+ = 软绳。
    // 注意：段数越多，自由摆周期越短（离散弯曲）——2段短 5.6%、3段 8.6%、4段 10.2%。
    // 想保持 0.77s 周期就要按节点数补偿 gravity，见 docs/05 的标定表。
    chain: {
      // 【重要】这个数字是【段数】，质点个数 = segments + 1。
      // segments = 2 => 3 个质点 => 2 段 => 有 1 个可弯关节（软绳的最小配置）。
      segments: 3,                    // 3 段 = 4 质点 = 2 个可弯关节。手感是"能弯出弧"的最小配置：
                                     // 2 段(1关节)只能折成一个角，4 段开始长度会漂（实测 59.7~61.7px）
      iterations: 2,                  // 每子步约束迭代次数。stiffness=1 时 1 次就够（实测 1/2/4/8/16 结果完全一致）
      stiffness: 1.0,                 // 只在 elasticity=true 时生效；关闭弹性时 rope.js 强制按 1 处理
      elasticity: false,              // 绳长是否可轻微拉伸。false = 绝对不伸长（需求 R11）
      tailMass: 1.6,                  // 末端质点相对质量（越大越像"挂着锤"）
      // 每秒阻尼率 k（1/s），作用在【速度】上，与 fixedStep 完全解耦。
      // 振幅与速度同相，所以振幅衰减速率是 k/2；再叠加 PBD 投影固有的数值耗散 omega^2*h/2
      // （omega = sqrt(gravity/绳长)），1/240 下两者合计约 0.24/s => 实测 tau = 3.98s。
      dampingPerSecond: 0.30,

      // 显示节点：0 = 不画；>0 = 在质点上画一个小圆球
      nodeRadius: 0,
      nodeColor: "rgba(255,255,255,0.92)"
    },

    // ---------- 物理 ----------
    // 停手后按 tau 约 4s 缓慢回正（见 chain.dampingPerSecond 的注释推导）。
    physics: {
      gravity: 3300,                  // px/s^2。离散弯曲会把自由摆周期压短（3 段绳约 -8.6%），
                                      // 所以这里按段数补偿过：3300 实测周期 0.77s，与"真实摆"一致。
                                      // 改 chain.segments 必须回来重标这个值（见 docs/05 标定表）
      drag: 0.00015,                  // 空气阻力系数（∝ v²），负责限制高速摆动；衰减时长由 dampingPerSecond 决定，两者独立
      // 挂点跟随策略："velocity" = 挂点按真实鼠标速度推进（离心力生效，偏角随速度增长）；
      // "translate" = 整链刚性平移（偏角与速度无关，只在 2000px/s 才翻转，是早年默认值）。
      followMode: "velocity",
      maxBend: 1.50,                  // 单个关节的最大弯曲角（弧度，约 86°）。只限关节角、不限绝对朝向，所以绳子仍能整体翻到上方（R15）
      bendIterations: 10,             // 弯曲上限与长度约束的交替迭代轮数。
                                      // 关节越多越难收敛：3 段绳 3 轮够（最差关节 105°），
                                      // 5 质点绳 3 轮会漏到 69°（低于 180-maxBend 的 94°），10 轮稳定到 94°

      // 单帧单点最大位移（px）。Verlet 的"速度"就是 (x - px)，
      // 位置投影修正的残余会积累成假速度，这里给个物理上合理的上限。
      // 默认 restLen*1.5，绳长 60 / 2 节时 restLen=30，即 45px/帧（2700px/s）。
      // maxStepPerFrame: 30,

      turbulence: 60,                 // 湍流强度：静止时也有轻微飘动（呼吸感）。重力 4000 下 60 约等于 1.3° 等效倾角
      windFreq: 1.7,                  // 湍流频率（Hz 量级）

      // 固定步长积分：与帧率解耦，60Hz / 144Hz 手感一致
      fixedStep: 1 / 240,             // 秒
      maxStepsPerFrame: 48,
      maxAccumulator: 0.1,            // 秒

      // 支点位移钳制：鼠标瞬移时会产生巨大冲量，必须夹住
      maxPivotStep: 400,              // 单帧位移上限（px），超过视为瞬移，直接重定位
    },

    // ---------- 指针挂点 ----------
    // 第 11 轮起不再自绘鼠标指针，程序直接用 Windows 系统指针。
    // 原因：系统指针由 DWM 画在独立的光标平面上，任何窗口（包括
    // HWND_TOPMOST 的覆盖层）都盖不住它 —— 自绘指针只会变成"两个光标"。
    // 代价是程序读不到系统指针的图形尺寸（受辅助功能"指针大小"1~15 档
    // 与第三方主题影响），所以挂点偏移只能给常量 + 让用户在设置面板里调。
    cursor: {
      // 挂点相对【系统指针热点（箭头尖）】的偏移，单位 CSS 像素。
      // 默认 (7, 19)：Windows 标准箭头在 100% 缩放下图形约 12.3 x 18.6，
      // 热点在左上角，所以 (7, 19) 落在箭头下边缘中部偏右的位置 ——
      // 绳子看起来正好从箭头尖峰下方垂下来。
      attachOffsetX: 7,
      attachOffsetY: 19,
    },

    debug: {
      // true 时开放 window.__doll，可用 CDP 读内部状态 / 脚本设置指针位置。
      // 【交付前必须为 false】。做效果验证时要同时把 lockPointer 打开，见下。
      exposeState: false,          // 排查用；交付前改回 false

      // 【指针控制权模式 · 两种】
      //   false = 鼠标可控（正常使用，你要的最终状态）
      //   true  = 鼠标不可控（调试：真实鼠标完全失效，指针只听脚本的）
      //
      // 为什么需要"不可控"：指针本来有三路来源在竞争——窗口内真实 mousemove、
      // 主进程 8ms 轮询、脚本注入。做效果验证时你的手会不断把坐标改回去，
      // 测出来的数据全是污染值。锁定后只剩脚本一路。
      // 见 docs/03-测试方法论.md 铁律 1。
      //
      // 运行时切换（不必改这里、不必重启）：Ctrl+Alt+L 或 window.__doll.lock(true/false)
      // 【正常使用时必须为 false，否则鼠标不动】
      lockPointer: false
    },
    meta: {
      pollIntervalMs: 8,              // 兜底轮询指针的间隔（毫秒）
      quitShortcut: "Control+Alt+Q"
    }
  };

  // 首次加载：CONFIG 直接指向默认配置；
  // 托盘"重载配置"时会原地覆盖这些值，引用保持不变。
  window.CONFIG = window.CONFIG || DEFAULTS;
  if (window.CONFIG !== DEFAULTS) {
    window.__CONFIG_FRESH__ = DEFAULTS;
    window.dispatchEvent(new CustomEvent("config-fresh", { detail: DEFAULTS }));
  }
})();
