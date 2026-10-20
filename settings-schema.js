// settings-schema.js  --  设置面板里"能调什么"的唯一定义。
//
// 这份数据同时被两处使用：
//   · 主进程 main.js —— 收到面板提交的值后按 min/max 钳制，挡住手改 JSON 塞进来的
//     999999 或 NaN（一次 NaN 就能让 Verlet 整条链变成 NaN，只能靠 resetVertically 兜）
//   · 设置面板 settings/settings.js —— 按它对每个字段画出滑块和标签
// 所以字段只要加在这里，两边就同时生效，不会出现"面板加了滑块但主进程不认"。
//
// 注意：这里只放【用户真的会调】的参数。fixedStep / maxStepsPerFrame / maxAccumulator
// / maxBend / bendIterations 这些属于数值安全阀，调坏了只会更难用，不给用户碰。
"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SettingsSchema = api;
})(typeof globalThis !== "undefined" ? globalThis : null, function () {

  // readout 是面板右侧额外显示的派生读数：
  //   "period" —— 自由摆一个来回需要多少秒（由 gravity + 段数 + 绳长算出）
  //   "tau"    —— 停手后振幅衰减到 1/e 需要多少秒
  //   "dollPx" / "ropePx" —— 换算成当前屏幕上的实际像素数
  const GROUPS = [
    {
      id: "feel",
      title: "手感",
      note: "「太快」「太强」「停不下来」这三件事全靠这一组。",
      fields: [
        {
          key: "physics.gravity",
          label: "摆动快慢",
          readout: "period",
          hint: "数值越大摆得越快、偏角也越大。出厂 3300 约 0.77 秒一个来回；想要真正的钟摆感就降到 1500 左右（约 1.2 秒）。",
          min: 400, max: 9000, step: 50, unit: "px/s²"
        },
        {
          key: "chain.dampingPerSecond",
          label: "晃动持续",
          readout: "tau",
          hint: "阻尼率。越小停手后晃得越久，越大越快静止。出厂 0.30（约 3~4 秒衰减完）。",
          min: 0.05, max: 1.5, step: 0.01, unit: "1/s"
        },
        {
          key: "physics.drag",
          label: "空气阻力",
          readout: null,
          hint: "只在高速甩动时起作用，负责压住大摆幅。出厂 0.00015；调大能让激烈甩动明显收敛。",
          min: 0, max: 0.002, step: 0.00001, unit: ""
        },
        {
          key: "physics.turbulence",
          label: "呼吸感",
          readout: null,
          hint: "静止不动时绳子自己轻微飘动的强度。0 = 完全静止。出厂 60。",
          min: 0, max: 300, step: 5, unit: ""
        }
      ]
    },
    {
      id: "doll",
      title: "娃娃",
      note: "",
      fields: [
        {
          key: "doll.angleLimit",
          label: "最大倾斜角",
          readout: null,
          hint: "超过这个角度后旋转会被柔和压住。出厂 45°（实际封顶 45+18=63°）。嫌甩得太狠就调到 25~30；调到 180 就完全不限幅，熊可以被甩到倒挂。",
          min: 5, max: 180, step: 1, unit: "°"
        },
        {
          key: "doll.bodyAngleTau",
          label: "旋转跟手",
          readout: null,
          hint: "越小跟得越紧（更抖），越大越平滑（更钝）。出厂 0.08 秒。",
          min: 0.02, max: 0.4, step: 0.005, unit: "s"
        },
      ]
    },
    {
      id: "appearance",
      title: "挂饰与大小",
      note: "换挂饰即时生效，不会重置绳子。选「自定义图片」后点下方「导入图片…」从本地选一张 JPG/PNG。",
      fields: [
        {
          key: "doll.dangle",
          label: "挂饰",
          type: "choice",
          options: [
            { v: "emoji", label: "自带小熊 🧸" },
            { v: "image", label: "自定义图片" }
          ],
          hint: "选「自定义图片」但还没导入时，会先显示自带小熊。"
        },
        {
          key: "doll.heightRatio",
          label: "娃娃大小",
          readout: "dollPx",
          hint: "占屏幕高度的比例，最终会被夹在 56~128 像素之间。出厂 0.10。",
          min: 0.03, max: 0.25, step: 0.005, unit: ""
        }
      ]
    },
    {
      id: "cursor",
      title: "指针",
      note: "绳子挂在系统指针上的位置。系统指针是 Windows 自己画的，程序读不到它的大小，所以这里只能用固定偏移 —— 按你自己的指针调一次就行。",
      fields: [
        {
          key: "cursor.attachOffsetX",
          label: "挂点左右",
          readout: null,
          hint: "正数 = 挂点往右。默认 7（标准箭头尖端在下边缘中部偏右）。想让绳子从箭头正中间垂下来就调到 6 左右。",
          min: -40, max: 90, step: 1, unit: "px"
        },
        {
          key: "cursor.attachOffsetY",
          label: "挂点上下",
          readout: null,
          hint: "正数 = 挂点往下。默认 19（标准箭头下边缘）。调到 30 以上会更远离指针，调到 0 则绳子直接从箭头尖上冒出来。",
          min: -40, max: 90, step: 1, unit: "px"
        }
      ]
    },
    {
      id: "rope",
      title: "绳子",
      note: "改节点段数会同时改变摆动快慢（段数越多越短促），需要配合上面的「摆动快慢」一起调。",
      fields: [
        {
          key: "chain.segments",
          label: "软硬（段数）",
          readout: null,
          hint: "段数越多越软。1 = 直棍，3 = 能弯出弧（出厂），5 开始链长会轻微漂移。",
          min: 1, max: 5, step: 1, unit: "段"
        },
        {
          key: "rope.lengthRatio",
          label: "绳长",
          readout: "ropePx",
          hint: "占屏幕高度的比例，会被夹在 60~120 像素之间。出厂 0.07。",
          min: 0.02, max: 0.25, step: 0.005, unit: ""
        },
        {
          key: "rope.width",
          label: "绳子粗细",
          readout: null,
          hint: "像素。出厂 2.2。",
          min: 0.5, max: 8, step: 0.1, unit: "px"
        }
      ]
    }
  ];

  // 档位：用户选一个档，再点「应用」一次性换一套手感，不用逐条拖。
  // values 为空对象 = 清掉全部覆盖值，回到 config.js 出厂默认。
  //
  // 【这七组数是实测标定出来的，不是拍脑袋爬坡】
  // 关键在于 tanθ = (k·v + drag·v²)/g：
  //   · 想「摆得慢」只能降 g，但降 g 会让拖动倾角变大（用户会觉得"更猛"），
  //     所以降 g 时必须同步降 k，两者同比例降才能"慢而不猛"。
  //   · 想「不那么强」最有效的是压 doll.angleLimit —— 它决定可见封顶角
  //     （可见最大角 = angleLimit + angleLimitOvershoot，出厂 45+18 = 63°）。
  //     第 12 轮起面板上限放到 180°，180 = 不限制（熊可以倒挂）；七档位本身不动。
  //     出厂值太松：普通人手晃（正弦 40px@1.2Hz，峰值速度才 302px/s）就顶到 63°，
  //     于是看起来"永远甩那么大、没有层次"。
  // 实测（绳长 60.5px、3 段、60fps，正弦峰值取娃娃可见角）：
  //   档   g     k      drag      limit   周期      tau     可见封顶  正弦40/1.2
  //   1    1400  0.45   0.00026   17      1.178s    3.50s   35°       35.0°
  //   2    1700  0.40   0.00024   24      1.069s    3.66s   42°       42.0°
  //   3    2100  0.37   0.00021   32      0.963s    3.64s   50°       50.0°
  //   4    3300  0.30   0.00015   45      0.771s    3.46s   63°       62.9°   （出厂）
  //   5    3800  0.26   0.00014   52      0.718s    3.45s   70°       69.8°
  //   6    4200  0.23   0.00012   58      0.684s    3.43s   76°       74.9°
  //   7    4800  0.20   0.00010   64      0.640s    3.32s   82°       78.2°
  // 周期一列对链式刚体摆理论值（第 4 档 0.793s）误差都在 4% 内；
  // 第 4 档给空 values，是「出厂默认」，也是唯一不写 settings.json 的档。
  const PRESETS = [
    {
      id: "lv1", name: "1", desc: "1.18 秒",
      summary: "最缓最轻，一个来回约 1.18 秒，可见倾角封顶 35°",
      values: {
        "physics.gravity": 1400,
        "chain.dampingPerSecond": 0.45,
        "physics.drag": 0.00026,
        "doll.angleLimit": 17
      }
    },
    {
      id: "lv2", name: "2", desc: "1.07 秒",
      summary: "很慢很轻，约 1.07 秒一个来回，封顶 42°",
      values: {
        "physics.gravity": 1700,
        "chain.dampingPerSecond": 0.40,
        "physics.drag": 0.00024,
        "doll.angleLimit": 24
      }
    },
    {
      id: "lv3", name: "3", desc: "0.96 秒",
      summary: "偏慢，约 0.96 秒一个来回，封顶 50°",
      values: {
        "physics.gravity": 2100,
        "chain.dampingPerSecond": 0.37,
        "physics.drag": 0.00021,
        "doll.angleLimit": 32
      }
    },
    {
      id: "lv4", name: "4", desc: "0.77 秒",
      summary: "出厂默认，约 0.77 秒一个来回，封顶 63°",
      values: {}
    },
    {
      id: "lv5", name: "5", desc: "0.72 秒",
      summary: "稍快，约 0.72 秒一个来回，封顶 70°",
      values: {
        "physics.gravity": 3800,
        "chain.dampingPerSecond": 0.26,
        "physics.drag": 0.00014,
        "doll.angleLimit": 52
      }
    },
    {
      id: "lv6", name: "6", desc: "0.68 秒",
      summary: "更快，约 0.68 秒一个来回，封顶 76°",
      values: {
        "physics.gravity": 4200,
        "chain.dampingPerSecond": 0.23,
        "physics.drag": 0.00012,
        "doll.angleLimit": 58
      }
    },
    {
      id: "lv7", name: "7", desc: "0.64 秒",
      summary: "最快最猛，约 0.64 秒一个来回，封顶 82°",
      values: {
        "physics.gravity": 4800,
        "chain.dampingPerSecond": 0.20,
        "physics.drag": 0.00010,
        "doll.angleLimit": 64
      }
    }
  ];

  // 拍平成一维，主进程钳制时按这个顺序遍历
  const FIELDS = [];
  for (const g of GROUPS) {
    for (const f of g.fields) {
      f.group = g.id;
      FIELDS.push(f);
    }
  }
  const BY_KEY = {};
  for (const f of FIELDS) BY_KEY[f.key] = f;
  // 非数值字段：下拉选择（choice）与字符串（如本地图片路径）。
  // 数字滑块走 FIELDS；这两类单独清洗 —— sanitize 只放行枚举内的取值 / 长度受限的字符串。
  const CHOICES = [
    { key: "doll.dangle", values: ["emoji", "image"] }
  ];
  const STRINGS = [
    { key: "doll.image.path", maxLen: 500 },
    { key: "doll.dangleName", maxLen: 50 },
    { key: "doll.dangleList", maxLen: 20000 }
  ];

  const BY_PRESET = {};
  for (const p of PRESETS) BY_PRESET[p.id] = p;

  function getAt(obj, key) {
    const parts = key.split(".");
    let cur = obj;
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function setAt(obj, key, value) {
    const parts = key.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }

  /**
   * 把外部来的覆盖值清洗成"只含已知字段、数值有限、且落在 min..max 内"的对象。
   * 未知字段直接丢弃 —— 防止面板版本和主进程版本不一致时把奇怪的东西写进 CONFIG。
   */
  function sanitize(overrides) {
    const out = {};
    if (!overrides || typeof overrides !== "object") return out;
    for (const f of FIELDS) {
      // 同时接受两种形状：嵌套 {"physics":{"gravity":1}} 和扁平 {"physics.gravity":1}。
      // 扁平优先 —— 面板提交的就是扁平的，而 json.setAt 生成的嵌套值只可能是它自己的回声。
      let v = Object.prototype.hasOwnProperty.call(overrides, f.key) ? overrides[f.key] : getAt(overrides, f.key);
      if (typeof v !== "number" || !isFinite(v)) continue;
      let c = Math.min(f.max, Math.max(f.min, v));
      // 按 step 对齐，避免手改 JSON 写出 3300.0000001 这种值
      if (f.step > 0) c = Math.round(c / f.step) * f.step;
      // 浮点乘法会留尾巴（0.005 的倍数可能算出 0.30000000000000004），收一下
      c = Number(c.toFixed(10));
      setAt(out, f.key, c);
    }
    for (const c of CHOICES) {
      const v = Object.prototype.hasOwnProperty.call(overrides, c.key) ? overrides[c.key] : getAt(overrides, c.key);
      if (typeof v === "string" && c.values.indexOf(v) >= 0) setAt(out, c.key, v);
    }
    for (const st of STRINGS) {
      const v = Object.prototype.hasOwnProperty.call(overrides, st.key) ? overrides[st.key] : getAt(overrides, st.key);
      if (typeof v === "string" && v.length > 0 && v.length <= st.maxLen) setAt(out, st.key, v);
    }
    return out;
  }

  /** 嵌套 -> 一维 {"physics.gravity": 1800, ...}，面板用 */
  function toFlat(overrides) {
    const flat = {};
    for (const f of FIELDS) {
      const v = getAt(overrides, f.key);
      if (typeof v === "number" && isFinite(v)) flat[f.key] = v;
    }
    for (const c of CHOICES) {
      const v = getAt(overrides, c.key);
      if (typeof v === "string") flat[c.key] = v;
    }
    for (const st of STRINGS) {
      const v = getAt(overrides, st.key);
      if (typeof v === "string") flat[st.key] = v;
    }
    return flat;
  }

  /** 一维 -> 嵌套，面板提交时用 */
  function fromFlat(flat) {
    const out = {};
    if (!flat || typeof flat !== "object") return out;
    if (Array.isArray(flat)) return out;
    for (const f of FIELDS) {
      if (typeof flat[f.key] === "number" && isFinite(flat[f.key])) setAt(out, f.key, flat[f.key]);
    }
    for (const c of CHOICES) {
      const v = Object.prototype.hasOwnProperty.call(flat, c.key) ? flat[c.key] : getAt(flat, c.key);
      if (typeof v === "string" && c.values.indexOf(v) >= 0) setAt(out, c.key, v);
    }
    for (const st of STRINGS) {
      const v = Object.prototype.hasOwnProperty.call(flat, st.key) ? flat[st.key] : getAt(flat, st.key);
      if (typeof v === "string" && v.length > 0 && v.length <= st.maxLen) setAt(out, st.key, v);
    }
    return out;
  }

  return { GROUPS, PRESETS, FIELDS, BY_KEY, BY_PRESET, CHOICES, STRINGS, sanitize, toFlat, fromFlat, getAt, setAt };
});