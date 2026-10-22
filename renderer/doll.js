// renderer/doll.js  --  绘制层。只关心"把绳子/指针/娃娃画在哪、画多大、转多少"。
// 换成真实图片：把 config.doll.emoji 设为 null，并设置 config.doll.image.path。
"use strict";

(function () {
  const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

  // 角度工具：把任意角折算到 (-PI, PI]。
  // 娃娃旋转的低通滤波必须用它来算「帧间最短路径增量」，否则 tailAngle 从 +179
  // 跳到 -179 时，滤波器会把 -179 当成新目标，一路倒着追，视觉上就是小熊原地反向转一圈（F15）。
  // 第 29 轮起这里不再用于「展开成连续序列」—— 状态每帧折回主值域，永不累积整圈。
  const TAU = Math.PI * 2;
  const wrapPi = (a) => a - Math.round(a / TAU) * TAU;

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
      // 娃娃旋转角的低通滤波状态（第 29 轮 m11456 简化为最短路径低通）
      this._bodyAngle = 0;          // 滤波后的角，始终留在 (-PI, PI]
      this._bodyCont = 0;            // 展开后的连续角（可超过 ±180°，只给滤波器用）
      this._bodyAnglePrev = null;   // 上一帧的 rawAngle，用来算最短路径增量
      this._bodyAngleDrawn = 0;
      this._lastDrawAt = 0;
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

    /**
      * 挂饰相对吊环的偏移（第 21 轮语义修正）。
      *
      * 【语义】吊环（= 挂点）的位置**永远由绳子决定**，参数调的是「图片相对吊环」
      * 摆在哪 —— 拖动 anchorX/anchorY 时吊环钉在绳端不动，图片在下面平移。
      * （第 20 轮的第一版是「吊环钉在图片上、图片钉在绳端」，两者一起动，
      *   用户 m08270 指出那不是他要的方向。）
      *
      * 返回 { ox, oy }：从「吊环」走到「图片静止矩形的左上角」的平移量（CSS 像素）。
      * 图片矩形是 [ox, ox+w] x [oy, oy+h]，吊环固定在原点 (0, 0)：
      *   anchorX 0   => ox = -w  （挂点贴图片左边缘，整张图挂在吊环右侧）；
      *   anchorX 0.5 => ox = -w/2（图片水平居中）；
      *   anchorX 1   => ox = 0   （挂点贴图片右边缘，整张图挂在吊环左侧）；
      *   anchorY 0.0 => oy = 0   （挂点贴图片顶边，图片在吊环下方 —— 出厂行为）。
      *
      * 反解：挂点在图片坐标系里是 px = w*ax、py = ay*h（左上角为原点），
      * 要让它落在原点，左上角就得在 (-px, -py)。
      * oy 去掉了旧的 heightMax 夹取 —— 那是「挂点必须在图片内」的护栏，
      * 现在夹取对象变成「图片相对吊环能沉多深」，语义不同，不再需要。
      *
      * 这个量只用于渲染，绝不参与物理：绳子的另一端是指针，娃娃对绳没有反作用力，
      * 所以「挂点在哪儿」在力学上不存在。见 docs/10 第 2.3 节。
      */
    get anchorOffset() {
      const d = this.cfg.doll;
      const w = this._dollWidth();
      const h = this.dollHeight;
      const ax = d.anchorX !== undefined ? d.anchorX : 0.5;
      const ay = d.anchorY !== undefined ? d.anchorY : 0.0;
      // px/py = 挂点在「挂饰包围盒」里的位置（左上角为原点）；
      // 反解出「挂点落在原点（吊环）时，包围盒左上角在哪」。
      //   px = w*ax：ax=0 是左侧、ax=1 是右侧
      //   py = h*ay：ay=0 是顶部、ay=1 是底部
      // 第 22 轮修：原来写成 px = -w*(ax-0.5)（等价于 ox = -w*(1-ax)），把左右镜像了 ——
      //   面板上「往右」按钮会让挂点往左跑，用户 m08776「挂点的左右调节是反向的」。
      // 第 23 轮 m09384：用户复测仍报「坐标位置与实际挂钩位置存在偏移」，
      //   第 24 轮起改为「设置页与线上共用同一个包围盒矩形」，见 docs/02 六之二。
      const px = w * ax;
      const py = ay * h;
      return { ox: -px, oy: -py };
    }

    /**
     * 质点相对吊环的位置（第 37 轮 m12496 新增）。
     * 吊环 = 原点 = 绳子末端 p4；质点是图片页那个红点给出的位置。
     *
     * 【第 37 轮补，m12743】挂饰**锁定在挂点（吊环）**，所以这个量现在只当
     * 「质量中心」描述用 —— 它说明质量分布，**不再用作旋转支点**。
     * 支点永远是原点（吊环）：用户 m12743「挂饰应该锁定于挂点，而不是质点」。
     */
    get massOffset() {
      const d = this.cfg.doll;
      const w = this._dollWidth();
      const h = this.dollHeight;
      const ax = d.anchorX !== undefined ? d.anchorX : 0.0;
      const ay = d.anchorY !== undefined ? d.anchorY : 0.0;
      const mx = d.massX !== undefined ? d.massX : 0.5;
      const my = d.massY !== undefined ? d.massY : 0.5;
      // 与 anchorOffset 同一套坐标系：归一化 0~1、原点在包围盒左上角。
      // 吊环本身落在包围盒的 (w*ax, h*ay)，所以质点相对吊环就是下面的差。
      return { mx: w * (mx - ax), my: h * (my - ay) };
    }

    /** 当前挂饰的绘制宽度（CSS 像素）。图片按自身宽高比、emoji 按字模包围盒 */
    _dollWidth() {
      const h = this.dollHeight;
      if (this.img && this.img.complete && this.img.naturalWidth > 0) {
        return h * (this.img.naturalWidth / this.img.naturalHeight);
      }
      const ch = this.cfg.doll.emoji || "\u2601\uFE0F";
      const m = this._measureEmoji(ch);
      // 第 23 轮 m09384 修：原来是 (m.left + m.right) —— 那个式子只在字形左右对称时
      // 才等于真实宽度。字模横向占 m.left..m.right（本机 -18..119），所以真实宽度是
      // (m.right - m.left)。用错会让 anchorX 的比例尺整体偏掉。
      return (m.right - m.left) * (h / m.h);
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

      // 【第 39 轮，m13485】隐藏模拟段（p4→p5）的白色线段：
      // 模拟段是挂点→质点的内部连杆，用户要求不显示。画到 p4（最后一个主体点）为止，
      // 也不再向 overlap 延伸进娃娃身体（那一段属于模拟段的视觉延伸，一并隐藏）。
      // 注意 points 与 path 的索引一致：path[i] 对应 points[i]。
      const overlap = cfg.rope.overlap || 0;
      const lastIdx = (rope.hasTail && drawPts.length >= 2) ? drawPts.length - 2 : drawPts.length - 1;
      const a = pts[Math.max(0, lastIdx - 1)];
      const b = pts[lastIdx];
      const ex = b.x, ey = b.y;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 路径只构建一次，描边 / 填充各用一遍
      const buildPath = () => {
        ctx.beginPath();
        ctx.moveTo(drawPts[0].x, drawPts[0].y);
        // 【第 39 轮补，m13515】循环上界必须是 lastIdx，不能用 drawPts.length - 1：
        // 原写法会把模拟段末端 p5 当成二次曲线的控制点，白线依然穿过 p4→p5 那段，
        // 只是终点被拉回 p4 —— 看起来「没隐藏」。
        for (let i = 1; i < lastIdx; i++) {
          const nx = i + 1 < lastIdx ? drawPts[i + 1] : b;
          const midX = (drawPts[i].x + nx.x) / 2;
          const midY = (drawPts[i].y + nx.y) / 2;
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
        for (let i = 0; i <= lastIdx; i++) {
          ctx.beginPath();
          ctx.arc(drawPts[i].x, drawPts[i].y, nr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    /**
      * 图片上的小吊环，视觉上把绳子"挂"上去。
      * (x, y) 是绳子末端 = 图片挂点所在的枢轴；angle 是图片当前转角。
      * T1 起挂点可以不在图片顶边中点，吊环必须跟着挂点一起转，否则会
      * 出现「绳子从肩膀穿进去、吊环却画在头顶」。
      */
    _drawLoop(x, y, angle, ox, oy) {
      const cfg = this.cfg;
      if (!cfg.rope.loop) return;
      const ctx = this.ctx;
      const c = Math.cos(angle || 0), s = Math.sin(angle || 0);
      const ax = x + (ox || 0) * c - (oy || 0) * s;
      const ay = y + (ox || 0) * s + (oy || 0) * c;
      ctx.save();
      ctx.strokeStyle = cfg.rope.color;
      ctx.lineWidth = cfg.rope.width * 0.9;
      ctx.beginPath();
      ctx.arc(ax, ay, cfg.rope.loopRadius, 0, Math.PI * 2);
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


      // ---------- 3) 娃娃 ----------
      const height = this.dollHeight;

      // 挂饰挂点。第 31 轮（m11899）：有挂饰模拟段时是 **p4**（模拟段的起点），
      // 没有时退回 rope.tailPoint（绳子实际画到的末端）。
      //
      // 教训：这里原来读的是 rope.tailPoint（= p5 + overlap），而 p5 正是挂饰模拟段的
      // 末端质点 —— 挂饰看起来「挂在了 p5 上」。绳子画到哪 ≠ 挂饰该挂在哪，
      // 这两个点在有模拟段时差了一整段（26px）。
      const hasRope = rope && rope.path && rope.path.length >= 1;
      const tail = hasRope ? (rope.hangPoint || rope.tailPoint) : null;
      const anchorX = tail ? tail.x : attach.x;
      const anchorY = tail ? tail.y : attach.y;
      // 【第 29 轮 m11456 / m11460】挂饰朝向 = 挂饰模拟段 p4->p5 的朝向，直接跟随。
      //
      // 用户明确要求（m11456）：「直接跟随。并进行说明，不要管小熊或图片是否会倒立」。
      // 所以这里**没有软限幅**：angleLimit / angleLimitOvershoot 不再作用于挂饰角度。
      // 甩圈时模拟段能转到 178°，挂饰就跟着转到 178°，倒立是预期行为。
      //
      // 【第 33 轮 m12181】曾改成直接数值引用 rope.tailAngle（零滞后、不滤波），
      // 【第 34 轮 m12215】用户反馈「确实抽动了」要求回退到滤波器 —— 现状即滤波版。
      //
      // 代价（记录在此，方便以后回滚时知道换回了什么）：tailAngle 是每帧从
      // p4/p5 两个质点坐标算出的 atan2，源头抖动来源有三 ——
      //   1) PBD 约束残差：bendIterations=10 是上限不是精确解，相邻帧残差方向不同；
      //   2) Verlet 速度项 (x-px)/h，fixedStep=1/240，末子步残差直接进坐标；
      //   3) 挂饰模拟段只有 26px，角度灵敏度 dθ≈Δx/L，1px 坐标误差 = 2.2° 角度误差。
      // 所以剧烈摆动时挂饰会跟着这几度的高频抖动走。要改回平滑，把下面这行换成
      // 第 32 轮（c982a2 之后）的「展开连续角 + 一阶低通」版本即可。
      // ===================== 已隔离（第 34 轮 m12253） =====================
      // 下面这段是「展开连续角 + 一阶低通」滤波实现（第 32 轮 982e71c 版本）。
      // 用户要求「先隔离（代码不删除，但不引用或调用）」，所以整段用 /* */ 包住，
      // 不再参与计算。恢复方法：删掉本段开头的 /* 与结尾的 */，
      // 再把下面【当前生效实现】那 3 行删掉即可。
      /*
      let rawAngle = hasRope ? rope.tailAngle : 0;
      const dz = cfg.doll.angleDeadzone !== undefined ? cfg.doll.angleDeadzone : 0.02;
      if (Math.abs(rawAngle) < dz) rawAngle = 0;
      const nowMs = state.time || 0;
      const dtSec = this._lastDrawAt ? Math.min(0.1, (nowMs - this._lastDrawAt) / 1000) : 1 / 60;
      this._lastDrawAt = nowMs;
      const tau = cfg.doll.bodyAngleTau !== undefined ? cfg.doll.bodyAngleTau : 0.08;
      const fk = 1 - Math.exp(-dtSec / tau);
      const ratio = cfg.doll.bodyRotateRatio !== undefined ? cfg.doll.bodyRotateRatio : 1;
      // 展开成连续角再低通：目标几帧内绕过大半圈时，主值域的最短路径会翻面。
      if (this._bodyAnglePrev === null) {
        this._bodyCont = rawAngle;
        this._bodyAnglePrev = rawAngle;
        this._bodyAngle = wrapPi(rawAngle * ratio);
      } else {
        this._bodyCont += wrapPi(rawAngle - this._bodyAnglePrev);
        this._bodyAnglePrev = rawAngle;
        this._bodyAngle += (this._bodyCont * ratio - this._bodyAngle) * fk;
        this._bodyAngle = wrapPi(this._bodyAngle);
        if (Math.abs(this._bodyCont) > 720 * Math.PI / 180) {
          const k = Math.round(this._bodyCont / TAU);
          this._bodyCont -= k * TAU;
          this._bodyAngle -= k * TAU;
        }
      }
      // 【第 34 轮 m12220】用户要求「将旋转的代码顺时针和逆时针进行翻转」。
      // 翻转放在最后一步（而不是改 tailAngle 的符号）：tailAngle、展开、低通
      // 全部保持原样，只有真正画出去的角度取反，回滚只需删掉这里的负号。
      const bodyAngle = -this._bodyAngle;
      */
      // =================== 隔离结束，下面是当前生效的实现 ===================
      // 【第 34 轮 m12253】滤波器已隔离，当前直接数值引用 rope.tailAngle。
      //   - 不滤波：一帧不滞后；
      //   - 不限幅：angleLimit / angleLimitOvershoot 不作用于挂饰角度（第 29 轮起）；
      //   - 不做死区：angleDeadzone 随滤波一起隔离。
      // 取负号的原因见上方注释（m12220 要求顺时针/逆时针翻转）。
      const tailAngle = hasRope ? rope.tailAngle : 0;
      const ratio = cfg.doll.bodyRotateRatio !== undefined ? cfg.doll.bodyRotateRatio : 1;
      // 【第 38 轮补二，m13459/m13460/m13465】方案 A（运动学锁定）：质点钉在图片上，
      // 旋转的唯一目的是让图片上的质点始终压在绳端 p5 上。
      //   φ（图片系里质点相对挂点的方向角，与 tailAngle 同一约定：
      //      竖直向下=0、顺时针为正）= atan2(mx, my)，mx/my 是 massOffset 的像素偏移。
      //   θ = φ − tailAngle。
      // 自检：质点在挂点正下方（出厂）⇒ φ=0 ⇒ θ=−tailAngle，与第 34 轮公式逐位相同；
      //       应用瞬间 p5 摆在质点处 ⇒ tailAngle=φ ⇒ θ=0 ⇒ 小熊竖直（图片原样）；
      //       p5 被物理拉回竖直 ⇒ θ=φ ⇒ 小熊转 φ 度，质点垂到绳端 ——「小熊被带起」。
      const mo = this.massOffset;
      const phi = Math.atan2(mo.mx, mo.my);
      const bodyAngle = wrapPi(phi - tailAngle * ratio);
      // 记录实际画出去的角度（记录器与测试都读这个字段）
      this._bodyAngleDrawn = bodyAngle;
      ctx.save();
      ctx.translate(anchorX, anchorY);
      // 吊环相对图片的偏移：off = 图片静止左上角相对吊环（= 原点）的位置。
      // 必须在 translate 之后算 —— _dollWidth() 会读 this.img，
      // 而 _ensureImage() 在 draw() 开头已经跑过，此时图片状态是确定的。
      //
      // 第 21 轮语义修正后的绘制约定：
      //   原点 = 吊环 = 绳子末端（吊环永远不偏移、不旋转）；
      //   图片静止矩形 = [off.ox, off.ox + w] x [off.oy, off.oy + h]；
      //   旋转支点 = 吊环（即原点），所以「摆」的力臂就是图片质心到吊环的距离。
      const off = this.anchorOffset;
      // 【第 37 轮补 m12743】旋转支点**永远是吊环（原点）**，不是质点。
      // 第 37 轮前半曾把支点挪到质点，用户 m12743 明确纠正：
      //   「挂饰应该锁定于挂点，而不是质点」。
      // 所以这里不再有 translate(pivot) ... translate(-pivot) 那一对。
      // massOffset 仍然存在，但只当「质量中心」描述用，不参与绘制。

      if (this.img && this.img.complete && this.img.naturalWidth > 0) {
        const imgRatio = this.img.naturalWidth / this.img.naturalHeight;
        const w = height * imgRatio;
        // 绕原点（= 吊环）转 θ。图片静止矩形已经从 off 开始，
        // 所以不需要 translate 到某个「图片上的挂点」——
        // 吊环就在原点，图片是被吊环吊着、围着吊环摆的。
        ctx.rotate(bodyAngle);
        if (cfg.doll.shadow.enabled) {
          ctx.shadowColor = cfg.doll.shadow.color;
          ctx.shadowBlur = cfg.doll.shadow.blur;
          ctx.shadowOffsetY = cfg.doll.shadow.offsetY;
        }
        ctx.drawImage(this.img, off.ox, off.oy, w, height);
      } else {
        // 【第 29 轮 m11343 修】emoji 分支必须自己旋转。
        // 原来这里漏了 ctx.rotate(bodyAngle) —— 图片分支有、emoji 分支没有，
        // 于是自带小熊（默认挂饰）的位置会跟着 p4 走、角度却始终竖直，
        // 而自定义图片是正常的。这正是用户说的「模拟段在摇、小熊跟着动但角度不变」。
        // 旋转支点就是原点（= 吊环 = translate 到的 p4），与图片分支完全一致。
        ctx.rotate(bodyAngle);
        const ch = cfg.doll.emoji || "\u2601\uFE0F";
        const m = this._measureEmoji(ch);
        const scale = height / m.h;

        // 第 23 轮 m09384 修：包围盒左缘必须正好落在 off.ox 上。
        // 原来写 cx = off.ox + wEmoji/2 - leftEdge，等于把「包围盒中心」对到
        // off.ox + wEmoji/2，而 anchorOffset 用的是包围盒左上角 —— 两者差半个宽度，
        // 于是 anchorX=0 时吊环落在字形左侧约 59px 的空白里。
        // 正确关系：字形 x=0 在 fillText 原点，字形左缘在原点 + m.left*scale，
        // 所以原点 = 包围盒左缘 - m.left*scale。
        const boxLeft = off.ox;
        const cx = boxLeft - m.left * scale;
        const offsetY = (cfg.doll.offsetY !== undefined ? cfg.doll.offsetY : 0);
        const baselineY = off.oy + m.ascent * scale + offsetY;

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

      // ---------- 4) 绳子（第 30 轮：画在娃娃之后，盖在娃娃上方） ----------
      // 用户 m11815 要求「把线段的图层移动到小熊上方」。
      // 绳子本来在娃娃之前画（会被娃娃盖住），现在搬到 restore 之后：
      // 顺序变成 娃娃 → 绳子 → 吊环，吊环仍然是最后画的（它要盖住绳端）。
      // 注意：_drawRope 内部自己 save/restore，不受娃娃的 translate/rotate 影响，
      // 传进来的点也都是画布绝对坐标，所以直接搬位置即可，无需改坐标。
      // 绳子首端用 attach（指针底部实时位置），不是 rope.points[0]（平滑挂点），
      // 这样指针和绳子永远不会脱开。
      if (cfg.rope.show && rope && rope.path && rope.path.length >= 2) {
        this._drawRope(rope, attach);
      }

      // 吊环画在娃娃之后：它要盖住绳子末端。
      // 第 21 轮语义修正：吊环 = 挂点本身 = 绳子末端，**不跟着 bodyAngle 转、
      // 也不跟着 anchorX/anchorY 偏移**。调挂点位置时动的是图片，不是环。
      if (cfg.rope.show && cfg.rope.loop && rope && rope.path && rope.path.length >= 2) {
        this._drawLoop(anchorX, anchorY, 0, 0, 0);
      }
    }
  }
  window.DollRenderer = DollRenderer;
})();
