// renderer/doll.js  --  绘制层。只关心"把绳子/指针/娃娃画在哪、画多大、转多少"。
// 换成真实图片：把 config.doll.emoji 设为 null，并设置 config.doll.image.path。
"use strict";

(function () {
  const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

  class DollRenderer {
    constructor(canvas, cfg) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.cfg = cfg;
      this.img = null;
      this.imgTried = false;
      this._imgPath = null;
      this.dpr = 1;
      this.cssW = 0;
      this.cssH = 0;
      this.emojiMetrics = null;
      // 娃娃旋转角的低通滤波状态
      this._bodyAngle = 0;
      this._bodyAngleDrawn = 0;
      this._lastDrawAt = 0;
    }

  /**
   * 角度软限幅：|angle| <= limit 原样通过；超过后按 tanh 渐近压向 limit + overshoot。
   *
   * 为什么需要它：删掉 minDroopRatio / monoDrop 之后，绳子可以整体翻到挂点上方（R15），
   * 熊也就能真的倒挂。实测 instant-reversal 4000px/s 时弦角能冲到 130°以上，
   * 那是一只会倒过来的熊。这里做「柔性限幅」而不是硬钳：
   *   · angleLimit 以内完全线性 —— 正常摆动的手感不受任何影响；
   *   · 超出后按 tanh 渐近压向 angleLimit + angleLimitOvershoot；
   *   · 用 tanh 而不是 clamp，避免在限幅点附近出现「贴住不动」的塑料感。
   *
   * angleLimit 是纯渲染层的旋钮，出厂 45°（可见封顶 63°）。第 12 轮起面板上限放到
   * 180°：到 180° 就恒等直通（见下面那个 early return），熊可以一路翻到倒挂。
   * 绳端弦角 |tipAngle| 本来就不会超过 180°，所以 180 就是"完全不限制"。
   *
   * 注意：限幅只作用在「画出来的角度」上，不写回物理。
   * 物理必须保持纯净，否则又变成上一版那种「几何投影代替动力学」的老毛病。
   */
  _softLimitAngle(angle) {
    const d = this.cfg.doll;
    const limitDeg = d.angleLimit !== undefined ? d.angleLimit : 45;
    const overDeg = d.angleLimitOvershoot !== undefined ? d.angleLimitOvershoot : 18;
    // 180° = 不限制。弦角 |tipAngle| 的最大值就是 180°，所以这里直接恒等直通。
    // 写显式判断而不是靠「limit 恰好大于 abs」是故意的：bodyRotateRatio > 1 时
    // 传入角可能超过 180°，那时也要真的不限幅。
    if (!(limitDeg > 0) || limitDeg >= 180) return angle;
    if (!(overDeg > 0)) return angle;
    const limit = limitDeg * Math.PI / 180;
    const over = overDeg * Math.PI / 180;
    const abs = Math.abs(angle);
    if (abs <= limit) return angle;
    const shrunk = limit + over * Math.tanh((abs - limit) / over);
    return angle > 0 ? shrunk : -shrunk;
  }

  resize(cssW, cssH, dpr) {
      this.cssW = cssW;
      this.cssH = cssH;
      this.dpr = dpr;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.width = cssW + "px";
      this.canvas.style.height = cssH + "px";
      this.emojiMetrics = null;
    }

    /** 娃娃的目标高度（CSS 像素） */
    get dollHeight() {
      const d = this.cfg.doll;
      const auto = this.cssH * d.heightRatio;
      return Math.min(d.heightMax, Math.max(d.heightMin, auto));
    }

    /** 绳长（CSS 像素） */
    get ropeLength() {
      const r = this.cfg.rope;
      const auto = this.cssH * r.lengthRatio;
      return Math.min(r.max, Math.max(r.min, auto));
    }

    // 挂饰选择：dangle === "image" 且 image.path 非空时用自定义图片，否则画 emoji。
    // path 变化时重新加载（imgTried 只挡同一张图的重复加载，不挡换图）。
    _ensureImage() {
      const useImage = this.cfg.doll.dangle === "image";
      const path = useImage ? (this.cfg.doll.image && this.cfg.doll.image.path) : null;
      if (!path) { this.img = null; this._imgPath = null; return; }
      if (path === this._imgPath && (this.img || this.imgTried)) return;
      this._imgPath = path;
      this.imgTried = true;
      const img = new Image();
      img.onload = () => { if (this._imgPath === path) this.img = img; };
      img.onerror = () => { if (this._imgPath === path) this.img = null; };
      img.src = path;
    }

    /**
     * 以 100px 字号量出 emoji 的真实包围盒，返回 {w,h,ascent,descent,left,right}
     * 用于把字模精确对齐到"顶部贴绳端、水平居中"。
     */
    _measureEmoji(ch) {
      if (this.emojiMetrics && this.emojiMetrics.ch === ch) return this.emojiMetrics;
      const ctx = this.ctx;
      const SIZE = 100;
      ctx.save();
      ctx.font = SIZE + "px " + EMOJI_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      const m = ctx.measureText(ch);
      ctx.restore();
      const ascent = m.actualBoundingBoxAscent || SIZE * 0.8;
      const descent = m.actualBoundingBoxDescent || SIZE * 0.2;
      const left = m.actualBoundingBoxLeft || 0;
      const right = m.actualBoundingBoxRight || m.width;
      this.emojiMetrics = {
        ch, size: SIZE,
        ascent, descent, left, right,
        h: Math.max(ascent + descent, 1)
      };
      return this.emojiMetrics;
    }

    clear() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    /**
     * 绳子挂在指针上的那个点。
     *
     * 第 11 轮起程序不再自绘指针，直接用 Windows 系统指针，所以这里只剩
     * "系统指针热点 + 手动偏移"。默认偏移 (7, 19) 是 Windows 标准箭头在
     * 100% 缩放下的下边缘（箭头图形约 12.3 x 18.6，热点在左上角）。
     *
     * 为什么只能给常量：系统指针的图形尺寸由系统设置决定（辅助功能里的
     * "指针大小" 1~15 档，第三方主题还会换形状），程序完全读不到。
     * 所以给设置面板两个滑块（-40 ~ +90）让用户按自己的指针调。
     */
    attachPoint(cursorX, cursorY) {
      const c = this.cfg.cursor;
      return {
        x: cursorX + (c.attachOffsetX || 0),
        y: cursorY + (c.attachOffsetY || 0)
      };
    }

    /**
     * 画多节绳索。
     * rope = RopeChain 实例；首个质点是指针下方的挂点。
     * 用二次贝塞尔把质点连成平滑曲线（中点法），线宽随张力变化。
     */
    _drawRope(rope, liveAnchor) {
      const cfg = this.cfg;
      const ctx = this.ctx;
      const pts = rope.path;
      if (!pts || pts.length < 2) return;

      // 【断链修复】rope.points[0] 与指针底部实时位置之间可能有极小误差
      // （setAnchor 之后 p0 要等下一次 update 才同步），绘制时直接用实时位置，
      // 保证绳子头永远贴着指针，不会露出缝。
      //
      // 【必须加距离保护】如果 p0 因为某种原因落后指针很远（比如刚启动、
      // 或者指针瞬移），直接把 drawPts[0] 换成指针位置会凭空造出一根
      // 长达几百 px 的假线段（实测 gapLive=383px，画面上是一根长杆
      // 从指针斜穿出去）。超过一节绳长时宁可保留真实 p0，不绘制假线段。
      const live = liveAnchor || { x: pts[0].x, y: pts[0].y };
      const drawPts = pts.slice();
      const gapLive = Math.hypot(live.x - pts[0].x, live.y - pts[0].y);
      const seg01 = pts.length >= 2 ? Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) : Infinity;
      if (gapLive <= Math.max(seg01 * 1.5, 8)) {
        drawPts[0] = { x: live.x, y: live.y, px: live.x, py: live.y };
      }


      const tension = rope.tension || 0;
      const wf = cfg.rope.widthMinFactor !== undefined ? cfg.rope.widthMinFactor : 0.75;
      const width = cfg.rope.width * (1 - tension * (1 - wf));

      // 末端沿最后一节方向再延伸 overlap 像素，伸进娃娃内部：
      // 否则 emoji 字形自带的透明边距会在绳端和熊头顶之间留出缝隙。
      const overlap = cfg.rope.overlap || 0;
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      let ex = b.x, ey = b.y;
      if (overlap > 0) {
        let dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        ex = b.x + (dx / len) * overlap;
        ey = b.y + (dy / len) * overlap;
      }

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 路径只构建一次，描边 / 填充各用一遍
      const buildPath = () => {
        ctx.beginPath();
        ctx.moveTo(drawPts[0].x, drawPts[0].y);
        for (let i = 1; i < drawPts.length - 1; i++) {
          const midX = (drawPts[i].x + drawPts[i + 1].x) / 2;
          const midY = (drawPts[i].y + drawPts[i + 1].y) / 2;
          ctx.quadraticCurveTo(drawPts[i].x, drawPts[i].y, midX, midY);
        }
        ctx.lineTo(ex, ey);
      };

      // 先画一圈深色描边，白底和深色桌面上都能看见
      const ol = cfg.rope.outline;
      if (ol && ol.enabled) {
        ctx.strokeStyle = ol.color;
        ctx.lineWidth = width + (ol.width || 1.2) * 2;
        buildPath();
        ctx.stroke();
      }

      ctx.strokeStyle = cfg.rope.color;
      ctx.lineWidth = width;
      buildPath();
      ctx.stroke();

      // 显示节点小球（可选）
      const nr = cfg.chain && cfg.chain.nodeRadius;
      if (nr > 0) {
        ctx.fillStyle = (cfg.chain && cfg.chain.nodeColor) || "rgba(255,255,255,0.92)";
        for (let i = 0; i < drawPts.length; i++) {
          ctx.beginPath();
          ctx.arc(drawPts[i].x, drawPts[i].y, nr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    /** 指针上的小吊环，视觉上把绳子"挂"上去 */
    _drawLoop(x, y) {
      const cfg = this.cfg;
      if (!cfg.rope.loop) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = cfg.rope.color;
      ctx.lineWidth = cfg.rope.width * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, cfg.rope.loopRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /**
     * 一次完整绘制。
     * state = { rope: RopeChain, cursorX, cursorY, speed }
     */
    draw(state) {
      const cfg = this.cfg;
      const ctx = this.ctx;
      const rope = state.rope;

      this.clear();
      this._ensureImage();

      // ---------- 1) 挂点（系统指针热点 + 手动偏移） ----------
      // 第 11 轮起不再自绘指针：Windows 的系统指针画在 DWM 光标平面上，
      // 任何窗口（含 HWND_TOPMOST）都压不住它，所以自绘指针永远是"两个光标"。
      const attach = this.attachPoint(state.cursorX, state.cursorY);

      // ---------- 2) 绳子（指针是系统的，绳子从挂点垂下来） ----------
      // 绳子首端用 attach（指针底部实时位置），不是 rope.points[0]（平滑挂点），
      // 这样指针和绳子永远不会脱开。
      if (cfg.rope.show && rope && rope.path && rope.path.length >= 2) {
        this._drawRope(rope, attach);
        this._drawLoop(attach.x, attach.y);
      }

      // ---------- 3) 娃娃 ----------
      const height = this.dollHeight;

      let stretch = 0;
      const st = cfg.doll.stretch;
      if (st && st.enabled) {
        const k = Math.min(1, Math.abs(state.speed || 0) / st.speedForMax);
        stretch = k * st.maxPercent;
      }
      const sx = 1 - stretch * 0.55;
      const sy = 1 + stretch;

      // 娃娃挂点 = 绳端
      const hasRope = rope && rope.path && rope.path.length >= 1;
      const anchorX = hasRope ? rope.tipX : attach.x;
      const anchorY = hasRope ? rope.tipY : attach.y;
      // 娃娃旋转角：用整绳连线角，但要做低通滤波 + 死区。
      // 不用末节方向（tipDir）：末节两个质点只隔 20px，方向噪声极大，
      // 实测水平慢摆时抖到 110°（整绳连线只有 50°），反而更晃。
      //
      // 死区的作用：把"几乎竖直"的小角度直接压成 0。
      // 鼠标上下移动时 dy 剧烈变化，atan2(dx, dy) 会算出虚高的角，
      // 死区能吃掉这部分抖动 —— 这正是用户说的"垂直上翻明显"的来源。
      let rawAngle = hasRope ? rope.tipAngle : 0;
      const dz = cfg.doll.angleDeadzone !== undefined ? cfg.doll.angleDeadzone : 0.02;
      if (Math.abs(rawAngle) < dz) rawAngle = 0;

      // 低通滤波：按时间常数收敛，避免帧率不同导致手感不同
      const nowMs = state.time || 0;
      const dtSec = this._lastDrawAt ? Math.min(0.1, (nowMs - this._lastDrawAt) / 1000) : 1 / 60;
      this._lastDrawAt = nowMs;
      const tau = cfg.doll.bodyAngleTau !== undefined ? cfg.doll.bodyAngleTau : 0.08;
      const fk = 1 - Math.exp(-dtSec / tau);
      this._bodyAngle += (rawAngle - this._bodyAngle) * fk;
      const bodyAngle = this._softLimitAngle(this._bodyAngle * cfg.doll.bodyRotateRatio);
      this._bodyAngleDrawn = bodyAngle;
      ctx.save();
      ctx.translate(anchorX, anchorY);

      if (this.img && this.img.complete && this.img.naturalWidth > 0) {
        const ratio = this.img.naturalWidth / this.img.naturalHeight;
        const w = height * ratio;
        ctx.rotate(bodyAngle);
        ctx.transform(sx, 0, 0, sy, 0, 0);
        if (cfg.doll.shadow.enabled) {
          ctx.shadowColor = cfg.doll.shadow.color;
          ctx.shadowBlur = cfg.doll.shadow.blur;
          ctx.shadowOffsetY = cfg.doll.shadow.offsetY;
        }
        ctx.drawImage(this.img, -w / 2, 0, w, height);
      } else {
        const ch = cfg.doll.emoji || "\u2601\uFE0F";
        const m = this._measureEmoji(ch);
        const scale = height / m.h;

        const leftEdge = -m.left * scale;
        const rightEdge = m.right * scale;
        const cx = -(leftEdge + rightEdge) / 2;
        const offsetY = (cfg.doll.offsetY !== undefined ? cfg.doll.offsetY : 0);
        const baselineY = m.ascent * scale + offsetY;

        ctx.rotate(bodyAngle);
        ctx.transform(sx, 0, 0, sy, 0, 0);
        ctx.font = m.size * scale + "px " + EMOJI_FONT;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";

        if (cfg.doll.shadow.enabled) {
          ctx.shadowColor = cfg.doll.shadow.color;
          ctx.shadowBlur = cfg.doll.shadow.blur;
          ctx.shadowOffsetY = cfg.doll.shadow.offsetY;
        }

        if (cfg.doll.outline.enabled) {
          ctx.lineWidth = cfg.doll.outline.width;
          ctx.strokeStyle = cfg.doll.outline.color;
          ctx.lineJoin = "round";
          ctx.strokeText(ch, cx, baselineY);
        }

        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        // 注意：彩色 emoji（如 🧸）的 fillStyle 必须保留默认黑色，
        // Canvas 会用字形自带颜色渲染，填白会让整个熊变白、在白底上凭空消失。
        // （之前这里被写成 "#fff"，导致娃娃完全看不见，排查了很久）
        ctx.fillText(ch, cx, baselineY);
      }

      ctx.restore();
    }
  }
  window.DollRenderer = DollRenderer;
})();
