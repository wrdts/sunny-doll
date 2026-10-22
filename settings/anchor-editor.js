﻿﻿﻿﻿﻿// settings/anchor-editor.js  --  「图片 > 吊环位置」编辑器（第 22 轮，m08506）
//
// 这个控件替代了原先的两个滑块（doll.anchorX / doll.anchorY）。左右并排：
//   左：挂饰缩略图（等比 contain），上面画一个吊环标记，位置就是这两个参数算出来的
//   右：读数（百分比 + 像素）+ 四向微调 + 恢复默认
//
// 第 24 轮 m09645：加了「在预览图上直接拖吊环」（用户要求）。
//   拖拽只在面板这张缩略图上生效 —— 覆盖层是鼠标穿透窗口，那里永远拖不了。
//   三套坐标系（画布内部分辨率 440 / CSS 220 / DPR）只在本文件里换算一次：
//   pointermove 的 clientX/Y 先除以 canvas.getBoundingClientRect() 的尺寸得到 0~1，
//   再乘 canvas.width/height 得到内部分辨率像素；不碰 DPR。
//   拖动期间只重绘、不写 overrides（避免每帧一次 IPC），松手才提交。
//
// 约定（与 renderer/doll.js 的 anchorOffset 完全一致，改一处必须改两处）：
//   anchorX = 0  ->  吊环对准图片左边缘；0.5 正中；1 右边缘
//   anchorY = 0  ->  吊环对准图片顶边；  1 底边
//   即：吊环永远钉在绳端不动，这两个参数动的是【图片】。
//
// 第 37 轮补 2 m12817：预览里挂饰会绕【挂点】转一个「预览角度」（右栏滑杆），
// 红点跟着一起转 —— 因为线上挂饰就是绕挂点摆的。但两个点的存储值永远是
// 「图片未旋转时的归一化坐标」，所以拖拽换算仍在未旋转坐标系里做：
// 拖到哪儿，就等价于「把挂饰摆正之后那个点落到哪儿」。

// 第 35 轮 m12277：预览里同时显示两个标记 ——
//   挂点（蓝，= doll.anchorX / doll.anchorY，吊环在图片上的位置）
//   质点（红，= doll.massX / doll.massY，新自由度）
//   两点之间画一条白色模拟段示意线（10% 不透明度）。
//   下拉框选中哪个就拖哪个（100% 不透明度、实心），另一个不可拖、40% 透明度、空心。
"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnchorEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : null, function () {

  // 与 renderer/config.js 的出厂值一致（第 23 轮 m09384 起是左上角 0 / 0）
  const HOOK_DEFAULTS = { x: 0.0, y: 0.0 };
  // 第 35 轮 m12277：质点的出厂值。居中 —— 直观上像「重心在小熊肚子里」。
  // 质点目前只用于预览与记录，还**没有**接入物理（见 docs/10 的 T4）。
  const MASS_DEFAULTS = { x: 0.5, y: 0.5 };

  // 【第 37 轮补 2，m12817】render() 每帧把两个标记的画布坐标记在这里，
  // activePt（命中判定）直接读它 —— 保证「看到哪儿就能拖哪儿」。
  // 放在模块作用域：canvas 只有一个，且探针/测试也能读到同一份。
  let lastMarks = null;

  /**
   * 把「图片矩形」等比放进画布，返回画布像素坐标里的矩形 {sx, sy, w, h}。
   */
  // 画布内边距（内部分辨率像素）。吊环圆半径 13、描边 5，所以留 40px 才保证
  // anchorX=0 / anchorY=0 / anchorY=1 这些极限位置上的标记也整个落在框内 ——
  // 原来不留边距时标记有一半被 overflow:hidden 裁掉，看起来像"标记没画出来"。
  const PAD = 40;

  /**
   * 预览布局：吊环固定在画布中心（HOOK），图片按 anchorOffset 相对平移。
   *
   * 第 23 轮 m09384：因为图片会整块移动，可用空间必须扣掉「最大平移量」——
   * anchorX=1 时图片整体左移一个图宽，anchorY=1 时整体上移一个图高。
   * 只扣 PAD 的话 anchorX=0 时图片右半截会被 overflow:hidden 裁掉。
   * 所以设 w = iw*k，左右各需 w*k（左移）/ 0（右移），即最大平移 = w。
   * 令 w*(1 + 1) + 2*PAD <= cw  =>  w <= (cw - 2*PAD)/2；同理 h <= (ch - 2*PAD)/2。
   * 单边极限（anchorX=0 不动 / anchorX=1 移一整幅）都能放下。
   */
  function fit(cw, ch, iw, ih) {
    if (!(iw > 0) || !(ih > 0)) return { sx: 0, sy: 0, w: 0, h: 0 };
    const availW = Math.max(1, (cw - PAD * 2) / 2);
    const availH = Math.max(1, (ch - PAD * 2) / 2);
    const k = Math.min(availW / iw, availH / ih);
    const w = iw * k, h = ih * k;
    return { sx: (cw - w) / 2, sy: (ch - h) / 2, w: w, h: h };
  }

  /**
   * 建一个编辑器。
   * opts:
   *   get()               -> { x, y } 当前值（0~1）
   *   set(axis, value)    -> void     写一个轴的值（调用方负责钳制与下发）
   *   setBoth(x, y)       -> void     第 24 轮：一次写两个轴（拖拽用）。不传则退回两次 set。
   *   reset()             -> void     恢复出厂（0.5 / 0）
   *   getSource()         -> { kind: "image" | "emoji", img?, emoji?, font?, w, h, realW, realH }
   *                          w/h 是「图片矩形」的宽高（只用于算比例，任意单位都行）；
   *                          realW/realH 是线上的真实 CSS 像素宽高，用于显示偏移读数
   */
  function create(opts) {

    // render() 每帧把两个标记的画布坐标记在这里，activePt（命中判定）直接用它。
    const wrap = document.createElement("div");
    wrap.className = "field anchor-editor";

    // 第 35 轮 m12277：标签右边加一个下拉框，选「挂点 / 质点」。
    // 选中哪个就能拖哪个，另一个只显示不可拖（40% 透明度、空心）。
    const top = document.createElement("div");
    top.className = "anchor-top";

    const label = document.createElement("span");
    label.className = "label-text";
    label.textContent = "挂点与质点";
    top.appendChild(label);

    const picker = document.createElement("select");
    picker.className = "choice anchor-picker";
    const optHook = document.createElement("option");
    optHook.value = "hook";
    optHook.textContent = "挂点（蓝色）";
    const optMass = document.createElement("option");
    optMass.value = "mass";
    optMass.textContent = "质点（红色）";
    picker.appendChild(optHook);
    picker.appendChild(optMass);
    picker.value = "hook";
    picker.addEventListener("change", function () {
      if (opts.setTarget) opts.setTarget(picker.value);
      render();
    });
    top.appendChild(picker);
    wrap.appendChild(top);

    const body = document.createElement("div");
    body.className = "anchor-body";

    // ---- 左：缩略图 + 吊环标记 ----
    const stage = document.createElement("div");
    stage.className = "anchor-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "anchor-canvas";
    canvas.width = 220 * 2;      // 固定 2x 内部分辨率，靠 CSS 缩放；不跟 DPR 走，避免反复重建
    canvas.height = 220 * 2;
    stage.appendChild(canvas);
    const empty = document.createElement("div");
    empty.className = "anchor-empty";
    empty.textContent = "（没有可预览的挂饰）";
    stage.appendChild(empty);
    body.appendChild(stage);

    // ---- 右：读数 + 四向微调 + 恢复 ----
    const side = document.createElement("div");
    side.className = "anchor-side";

    const readX = document.createElement("div");
    readX.className = "anchor-read";
    const readY = document.createElement("div");
    readY.className = "anchor-read";
    side.appendChild(readX);
    side.appendChild(readY);
    // 另一个点的读数：只读，随下拉框切换而互换
    const readOther = document.createElement("div");
    readOther.className = "anchor-read anchor-read-other";
    side.appendChild(readOther);

    // 图例：让「蓝=挂点、红=质点、白线=模拟段」一眼能对上
    const legend = document.createElement("div");
    legend.className = "anchor-legend";
    const lgHook = document.createElement("span");
    lgHook.className = "lg lg-hook";
    lgHook.textContent = "挂点";
    const lgMass = document.createElement("span");
    lgMass.className = "lg lg-mass";
    lgMass.textContent = "质点";
    const lgSeg = document.createElement("span");
    lgSeg.className = "lg lg-seg";
    lgSeg.textContent = "模拟段";
    legend.appendChild(lgHook);
    legend.appendChild(lgMass);
    legend.appendChild(lgSeg);
    side.appendChild(legend);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "btn anchor-reset";
    // 第 23 轮 m09384：出厂值改成左上角，按钮文案必须跟着变，
    // 否则点完「恢复居中」图跑到左上角，用户会以为按钮坏了。
    resetBtn.textContent = "恢复默认（左上角）";
    resetBtn.addEventListener("click", function () { if (opts.reset) opts.reset(); });
    side.appendChild(resetBtn);

    // 【第 37 轮 m12496】「应用」：把挂点 / 质点 / 模拟段参数真正下发给覆盖层。
    // 拖动时只改面板里的草稿（预览跟着动），按下这里才提交 ——
    // 因为模拟段长度是从两点距离算出来的，改长度要重建绳链，不能每帧都来一次。
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "btn primary anchor-apply";
    applyBtn.textContent = "应用";
    applyBtn.addEventListener("click", function () { if (opts.apply) opts.apply(); });
    side.appendChild(applyBtn);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "挂点（蓝）决定挂饰相对吊环的位置；质点（红）是挂饰的旋转支点，" +
      "两点之间的距离就是「挂饰模拟段」的长度。" +
      "用上面的下拉框选择要拖哪个，直接在左边预览图上拖动，改完点右下「应用」下发。";
    side.appendChild(hint);

    body.appendChild(side);
    wrap.appendChild(body);


    function render() {
      const cv = canvas;
      const ctx = cv.getContext("2d");
      const cw = cv.width, ch = cv.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      const hook = (opts.getHook && opts.getHook()) || HOOK_DEFAULTS;
      const mass = (opts.getMass && opts.getMass()) || MASS_DEFAULTS;
      const target = pickTarget();
      const cur = target === "mass" ? mass : hook;
      const src = opts.getSource ? opts.getSource() : null;
      const has = !!(src && src.w > 0 && src.h > 0);
      empty.style.display = has ? "none" : "";

      if (has) {
        // 第 23 轮 m09384：用户要求「设置页和实际挂点先全部移动到图片左上角」。
        // 预览改成与覆盖层同构：吊环固定在画布参考点 HOOK，图片按 anchorOffset 的
        // (ox, oy) 相对吊环平移 —— 两边画的是同一构图，肉眼一叠就能判断偏移在哪一侧。
        const box = fit(cw, ch, src.w, src.h);
        const w = box.w, h = box.h;
        // 该矩形 = renderer/doll.js 里 anchorOffset 使用的「挂饰包围盒」。
        // emoji 的 src.w/src.h 已是字模包围盒尺寸，这里不能再按 m.h 缩一次。
        const boxW = w, boxH = h;
        // 吊环固定位置：画布中心（ox/oy 都要用，必须先定义）
        const hx = cw / 2, hy = ch / 2;
        const ox = hx - boxW * hook.x;
        const oy = hy - boxH * hook.y;
        // 1) 挂饰本身
        if (src.kind === "image" && src.img && src.img.complete && src.img.naturalWidth > 0) {
          ctx.drawImage(src.img, ox, oy, w, h);
        } else if (src.kind === "emoji" && src.emoji) {
          // 与 renderer/doll.js 的 emoji 分支逐字对应（第 22 轮 m09043）：
          //   scale = height / m.h；leftEdge = -m.left*scale；wEmoji = rightEdge - leftEdge；
          //   cx = off.ox + wEmoji/2 - leftEdge；baselineY = off.oy + m.ascent*scale
          const m = src.metrics;
          if (m) {
            const unit = boxW / (m.right - m.left);
            const emojiCx = ox - m.left * unit;
            const emojiBase = oy + m.ascent * unit;
            const scale2 = unit;
            ctx.font = m.size * scale2 + "px " + (src.font || "Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif");
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            // 必须保持默认黑填充：给彩色 emoji 设 fillStyle 会退化成单色甚至画不出来
            ctx.fillText(src.emoji, emojiCx, emojiBase);
          } else {
            const size = Math.min(w, h) * 0.92;
            ctx.font = size + "px " + (src.font || "Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif");
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(src.emoji, ox + w / 2, oy + h / 2);
          }
        }
        // 2) 两个标记都用「图片矩形上的归一化坐标」表示：
        //      px = ox + boxW * ax, py = oy + boxH * ay
        //    挂点因为 ox = hx - boxW*ax，代入后恒等于 hx —— 这就是「吊环钉住不动」。
        const hookPx = ox + boxW * hook.x, hookPy = oy + boxH * hook.y;
        const massPx = ox + boxW * mass.x, massPy = oy + boxH * mass.y;

        ctx.save();
        // 2a) 白色模拟段示意线：10% 不透明度，两点之间
        ctx.strokeStyle = "rgba(255, 255, 255, 0.40)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(hookPx, hookPy);
        ctx.lineTo(massPx, massPy);
        ctx.stroke();
        ctx.restore();

        // 2b) 选中标记的辅助十字线（十字臂伸到画布边缘，便于对齐图片的边）
        const sel = target === "mass" ? { x: massPx, y: massPy } : { x: hookPx, y: hookPy };
        ctx.save();
        ctx.strokeStyle = target === "mass" ? "rgba(255, 107, 107, 0.30)" : "rgba(90, 169, 255, 0.30)";
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(0, sel.y);
        ctx.lineTo(cw, sel.y);
        ctx.moveTo(sel.x, 0);
        ctx.lineTo(sel.x, ch);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // 2c) 挂点：蓝色。选中 = 100% 实心；未选中 = 40% 空心
        // 命中判定直接复用这两个位置（activePt 读 lastMarks），不要再算一遍
        lastMarks = { hook: { x: hookPx, y: hookPy }, mass: { x: massPx, y: massPy } };
        drawMarker(ctx, hookPx, hookPy, "#5aa9ff", target === "hook");
        // 2d) 质点：红色。同上
        drawMarker(ctx, massPx, massPy, "#ff6b6b", target === "mass");
        // 2b) 包围盒描边：把 anchorOffset 用的那个矩形画清楚，
        //     便于核对 anchorX=0 时吊环是否正好压在左边缘上。
        ctx.save();
        ctx.strokeStyle = "rgba(90, 169, 255, 0.45)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ox, oy, boxW, boxH);
        ctx.restore();
      }
      // 3) 读数：百分比 + 线上真实像素偏移（即 doll.anchorOffset 的 ox / oy）
      const realW = src && src.realW > 0 ? src.realW : 0;
      const realH = src && src.realH > 0 ? src.realH : 0;
      // 与 renderer/doll.js 的 anchorOffset 逐字对应：ox = -w*ax、oy = -h*ay。
      // 第 22 轮修：原来写成 -w*(ax-0.5)，那是旧语义「吊环钉在图片中心」的公式，
      // 读数与线上实际位置差 w/2（半个图宽）——用户 m08776「坐标位置与实际挂钩位置存在偏移」。
      const offX = -realW * hook.x;
      const offY = -realH * hook.y;
      const name = target === "mass" ? "质点" : "挂点";
      readX.textContent = "【" + name + "】水平 " + (cur.x * 100).toFixed(0) + "%" +
        (target === "hook" ? "   图片偏移 " + (offX >= 0 ? "+" : "") + offX.toFixed(1) + " px" : "");
      readY.textContent = "【" + name + "】垂直 " + (cur.y * 100).toFixed(0) + "%" +
        (target === "hook" ? "   图片偏移 " + (offY >= 0 ? "+" : "") + offY.toFixed(1) + " px" : "");
      const other = target === "mass" ? hook : mass;
      const otherName = target === "mass" ? "挂点（蓝，未选中）" : "质点（红，未选中）";
      readOther.textContent = otherName + "  水平 " + (other.x * 100).toFixed(0) + "%   垂直 " +
        (other.y * 100).toFixed(0) + "%";
    }


    // ---------- 第 24 轮 m09645：在预览图上拖吊环 ----------
    //
    // 交互：在画布上按下 -> 如果落点在吊环附近的命中半径内，就进入拖动；
    //       移动时把指针位置换算成 (anchorX, anchorY)，图片反向平移；
    //       松手/pointercancel 时提交一次。
    //
    // 坐标换算只走一条路，不做 DPR 修正（canvas.width 是内部分辨率，
    // getBoundingClientRect 是 CSS 像素，两者之比就是缩放系数）：
    //   rel = (clientX - rect.left) / rect.width          // 0~1，跨两套尺寸都成立
    //   px  = rel * canvas.width                          // 内部分辨率像素
    // 不做任何 ctx.setTransform 缩放，render() 一直按内部分辨率画。
    let dragging = false;
    let dragRect = null;          // 拖动开始时的 { hx, hy, boxW, boxH }

    // 命中半径按内部分辨率给：吊环外圈 r=13、描边 5 -> 视觉半径约 15.5，
    // 留一倍余量让手指/触控板也能抓住。
    const HIT_R = 34;

    function toCanvasPx(ev) {
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return null;
      return {
        x: ((ev.clientX - r.left) / r.width) * canvas.width,
        y: ((ev.clientY - r.top) / r.height) * canvas.height
      };
    }

    /** 当前布局下吊环钉在哪、图片框多大 —— 与 render() 里同一套算法，改一处必须改两处 */
    function layout() {
      const cw = canvas.width, ch = canvas.height;
      const src = opts.getSource ? opts.getSource() : null;
      const has = !!(src && src.w > 0 && src.h > 0);
      if (!has) return null;
      const box = fit(cw, ch, src.w, src.h);
      const hook = (opts.getHook && opts.getHook()) || HOOK_DEFAULTS;
      const mass = (opts.getMass && opts.getMass()) || MASS_DEFAULTS;
      // 与 render() 同一组式子：ox = hx - boxW*ax、oy = hy - boxH*ay（ax/ay 来自挂点）
      const ox = cw / 2 - box.w * hook.x;
      const oy = ch / 2 - box.h * hook.y;
      return { cw: cw, ch: ch, hx: cw / 2, hy: ch / 2, boxW: box.w, boxH: box.h,
               ox: ox, oy: oy, hook: hook, mass: mass };
    }

    /** 归一化坐标 -> 画布像素（两个点用同一套换算） */
    function toPx(v, L) {
      return { x: L.ox + L.boxW * v.x, y: L.oy + L.boxH * v.y };
    }


    /** 挂点的画布像素位置（未旋转）—— 恒等于画布中心，但保留函数以免两处各写一套 */
    function hookPxOf(L) { return toPx(L.hook, L); }

    /** 质点的画布像素位置（未旋转）。绕挂点转由 activePt / render 各自处理 */
    function massPxOf(L) { return toPx(L.mass, L); }

    /** 画一个标记。active=true 用实心 100%，false 用空心 40% —— 这是本轮的核心视觉约定 */
    function drawMarker(ctx, x, y, color, active) {
      ctx.save();
      ctx.globalAlpha = active ? 1 : 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 5 : 3;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.stroke();
      if (active) {
        // 选中的点：白色实心核，和覆盖层的吊环一个样子
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 未选中的点：只有外圈，一眼看出「现在拖不动它」
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    function pickTarget() {
      return opts.getTarget && opts.getTarget() === "mass" ? "mass" : "hook";
    }

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    /**
     * 把指针位置反解成 (anchorX, anchorY)。
     *
     * 关键：拖拽期间【图片矩形冻结在按下那一刻的位置】，指针决定吊环落在图片上的哪一点。
     * 若让图片跟着指针跑，图片会一直在吊环下面滑走，用户永远拖不出想要的相对位置。
     *   ax = (指针x - 图片左上角x) / 图片宽
     *   ay = (指针y - 图片左上角y) / 图片高
     * 这与 renderer/doll.js 的 anchorOffset 是同一件事：ax 是「吊环相对图片左边缘的比例」。
     */
    function pxToAnchor(px, py, L) {
      // 两个点共用同一套反解：图片矩形左上角 + 归一化比例。
      // 无论拖的是挂点还是质点，指针位置都要先减掉图片矩形的左上角。
      // 注意：挂点拖拽时图片矩形是冻结的（dragRect），所以这里不会递归。
      const ax = (px - L.ox) / (L.boxW || 1);
      const ay = (py - L.oy) / (L.boxH || 1);
      return { x: clamp01(ax), y: clamp01(ay) };
    }

    function applyDrag(v) {
      const t = pickTarget();
      if (opts.setBothBoth) opts.setBothBoth(t, v.x, v.y);
      else if (t === "mass") {
        if (opts.setBothMass) opts.setBothMass(v.x, v.y);
        else { opts.setMass("x", v.x); opts.setMass("y", v.y); }
      } else if (opts.setBoth) opts.setBoth(v.x, v.y);
      else { opts.set("x", v.x); opts.set("y", v.y); }
    }

    /** 当前可拖的那个点在画布上的像素位置 */
    function activePt(L) {
      const t = pickTarget();
      const mk = lastMarks;
      return t === "mass" ? mk.mass : mk.hook;
    }

    canvas.addEventListener("pointerdown", function (ev) {
      const L = layout();
      if (!L) return;
      const pt = toCanvasPx(ev);
      if (!pt) return;
      // 只有【下拉框选中的那个点】能被抓住；另一个即使点在圆环上也拖不动。
      const ap = activePt(L);
      const d = Math.hypot(pt.x - ap.x, pt.y - ap.y);
      if (d > HIT_R) return;                 // 没点到当前点：不拦，让页面正常滚动
      dragging = true;
      dragRect = L;
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add("dragging");
      ev.preventDefault();
    });

    canvas.addEventListener("pointermove", function (ev) {
      const L = layout();
      if (!L) return;
      const pt = toCanvasPx(ev);
      if (!pt) return;
      if (!dragging) {
        // 悬停在【当前选中的点】上时给个 grab 光标；另一个点不给，提示拖不动
        const ap = activePt(L);
        const d = Math.hypot(pt.x - ap.x, pt.y - ap.y);
        canvas.classList.toggle("over-hook", d <= HIT_R);
        return;
      }
      const base = dragRect || L;
      applyDrag(pxToAnchor(pt.x, pt.y, base));
      ev.preventDefault();
    });

    function endDrag(ev) {
      if (!dragging) return;
      dragging = false;
      dragRect = null;
      canvas.classList.remove("dragging");
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ }
      // 拖动过程中走的是 setBoth / setBothMass（只重绘不下发）；【第 38 轮 m13309】
      // 松手这里再触发一次常规 set / setMass —— 调用方现在也只改本地草稿，不下发。
      const t = pickTarget();
      if (t === "mass") {
        const m = (opts.getMass && opts.getMass()) || MASS_DEFAULTS;
        opts.setMass("x", m.x);
        opts.setMass("y", m.y);
      } else {
        const cur = (opts.getHook && opts.getHook()) || HOOK_DEFAULTS;
        opts.set("x", cur.x);
        opts.set("y", cur.y);
      }
    }
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", function () {
      if (!dragging) canvas.classList.remove("over-hook");
    });

    return { el: wrap, render: render, canvas: canvas };
  }

  return { create: create, fit: fit, DEFAULTS: HOOK_DEFAULTS, HOOK_DEFAULTS: HOOK_DEFAULTS, MASS_DEFAULTS: MASS_DEFAULTS, PAD: PAD };
});
