// settings/settings.js  --  设置面板的界面逻辑。
//
// 数据流（单向，只有一条）：
//   面板改值 -> ipc "settings:set" -> 主进程 sanitize + 存盘 + 广播 -> 覆盖层 applySettings()
//   覆盖层不读文件、不读面板，只接收广播，所以任何时刻只有一份真相。
//
// 两种改动方式，故意不一样：
//   · 拖滑块 —— 即时生效。调手感必须一边拖一边看娃娃动，否则没法调。
//   · 拖档位滑条 —— 只预览，点「应用」才生效。档位是"整套换掉"，先看清楚再决定。
// 档位 UI 是一根 1~7 的滑动条（原先是七个 chip 按钮），交互语义不变：
//   selected = 拖到但还没应用；active = 主进程确认已生效的档位。
"use strict";

(function () {
  const S = window.SettingsSchema;
  const DEFAULTS = window.CONFIG;        // config.js 里的出厂值（只读，用来显示"出厂 xx"）

  const els = {
    groups: document.getElementById("groups"),
    presetRange: document.getElementById("preset-range"),
    presetMinLabel: document.getElementById("preset-min-label"),
    presetMaxLabel: document.getElementById("preset-max-label"),
    presetHint: document.getElementById("preset-hint"),
    tabs: document.getElementById("tabs"),
    status: document.getElementById("status"),
    resetAll: document.getElementById("reset-all"),
    apply: document.getElementById("apply"),
    close: document.getElementById("close"),
    recordToggle: document.getElementById("record-toggle"),
    recordStatus: document.getElementById("record-status"),
    recordFile: document.getElementById("record-file")
  };

  // 界面上正在显示的值（嵌套）：{physics:{gravity:1800}}。空 = 全部用出厂值。
  // 必须是嵌套形状 —— S.getAt / S.setAt 都是按点分路径在嵌套对象上走的。
  let overrides = {};
  // 主进程确认已生效的值（嵌套，形状同 overrides）。只用来判断"哪个档位正在生效"。
  let applied = {};
  // 选中了但还没点「应用」的档位 id。null = 没有待应用的档位。
  let selectedPresetId = null;
  // 当前显示的标签页 id。图片页先空着。
  let activeTab = "physics";
  // 控件引用，key -> { input, valueEl, readoutEl, fieldEl, field }
  const controls = {};

  let statusTimer = null;
  function setStatus(text, sticky) {
    els.status.textContent = text;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (!sticky && text) {
      statusTimer = setTimeout(() => { els.status.textContent = ""; statusTimer = null; }, 2600);
    }
  }

  // ---------- 读数换算 ----------
  // 面板上显示的派生量必须和真实物理一致，所以这里复刻的是
  // verify.cjs 的 chainPendulumPeriod 与 rope.js 的耗散模型，不是随手估的。
  const SCREEN_H = window.screen && window.screen.height ? window.screen.height : 864;

  function val(key, fallback) {
    const v = S.getAt(overrides, key);
    if (typeof v === "number" && isFinite(v)) return v;
    const d = S.getAt(DEFAULTS, key);
    return typeof d === "number" && isFinite(d) ? d : fallback;
  }

  /** 链式刚体摆周期：T = 2π√(Σ m_i r_i² / (g Σ m_i y_i)) */
  function pendulumPeriod(gravity, segments, ropePx) {
    const n = Math.max(2, Math.round(segments) + 1);
    const rest = ropePx / (n - 1);
    const tailMass = val("chain.tailMass", 1.6);
    let num = 0, den = 0;
    for (let i = 1; i < n; i++) {
      const t = (i - 1) / Math.max(1, n - 2);
      const m = (1 - t) + tailMass * t;
      const y = rest * i;
      num += m * y * y;      // 竖直静止时 x_i = 0
      den += m * y;
    }
    return 2 * Math.PI * Math.sqrt(num / (gravity * den));
  }

  /** 振幅衰减到 1/e 的秒数。与 rope.js 的 b = k/2 + omega^2*h/2 同源 */
  function decayTau(dampingPerSecond, gravity, ropePx) {
    const omega = Math.sqrt(gravity / ropePx);
    const h = 1 / 240;                     // 线上 fixedStep
    return 1 / (dampingPerSecond / 2 + omega * omega * h / 2);
  }

  function ropePx() {
    const r = DEFAULTS.rope;
    return Math.min(r.max, Math.max(r.min, SCREEN_H * val("rope.lengthRatio", r.lengthRatio)));
  }
  function dollPx() {
    const d = DEFAULTS.doll;
    return Math.min(d.heightMax, Math.max(d.heightMin, SCREEN_H * val("doll.heightRatio", d.heightRatio)));
  }

  function computeReadout(field) {
    if (!field.readout) return "";
    if (field.readout === "period") {
      const g = val("physics.gravity", 3300);
      const seg = val("chain.segments", 3);
      return "约 " + pendulumPeriod(g, seg, ropePx()).toFixed(2) + " 秒一个来回";
    }
    if (field.readout === "tau") {
      const k = val("chain.dampingPerSecond", 0.30);
      const g = val("physics.gravity", 3300);
      return "停手后约 " + decayTau(k, g, ropePx()).toFixed(1) + " 秒衰减完";
    }
    if (field.readout === "dollPx") return "≈ " + dollPx().toFixed(0) + " px 高";
    if (field.readout === "ropePx") return "≈ " + ropePx().toFixed(0) + " px 长";
    return "";
  }

  /** 数值格式化：小数位数由 step 决定，避免 0.30000000000000004 */
  function fmt(v, step) {
    if (!(step > 0)) return String(v);
    const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
    let out = v.toFixed(Math.min(6, decimals));
    // 去掉尾随零：0.300 -> 0.3、2.20 -> 2.2、60.0 -> 60
    if (out.indexOf(".") >= 0) {
      out = out.replace(/0+$/, "");
      // 不要用正则去尾（PowerShell here-string 会把反斜杠吃掉），直接 endsWith + slice
      if (out.endsWith(".")) out = out.slice(0, -1);
    }
    return out;
  }

  // ---------- 标签页 ----------
  // schema 里的 GROUPS 按 group.id 分配到三个标签页：
  //   image   —— 图片（先空着，占位）
  //   cursor  —— 挂点与绳索（cursor + rope 两组）
  //   physics —— 物理（feel + doll 等其余全部）
  const TAB_OF_GROUP = { appearance: "image", cursor: "cursor", rope: "cursor", feel: "physics", doll: "physics" };
  const TAB_TITLE = { image: "图片", cursor: "挂点与绳索", physics: "物理" };

  function buildTabs() {
    for (const btn of els.tabs.querySelectorAll(".tab")) {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    }
  }

  function switchTab(id) {
    activeTab = id;
    for (const btn of els.tabs.querySelectorAll(".tab")) {
      btn.classList.toggle("active", btn.dataset.tab === id);
    }
    for (const sec of els.groups.querySelectorAll(".group")) {
      // 图片页空着也要能切过去 —— 显示一句占位说明
      sec.style.display = sec.dataset.tab === id ? "" : "none";
    }
    const empty = document.getElementById("tab-empty");
    if (empty) empty.style.display = id === "image" ? "" : "none";
    // 档位滑条与诊断记录归属「物理」页（第 17 轮，m05426）
    const presetBar = document.querySelector(".preset-bar");
    const recorder = document.querySelector(".recorder");
    const showExtras = id === "physics";
    if (presetBar) presetBar.style.display = showExtras ? "" : "none";
    if (recorder) recorder.style.display = showExtras ? "" : "none";
  }

  // ---------- 构建界面 ----------
  function build() {
    els.groups.textContent = "";
    // 注意：controls 是普通对象，这里绝不能写 controls.length = 0 ——
    // 那会真的创建一个名为 "length" 的键，之后遍历时会当成控件取出来炸掉。
    for (const k of Object.keys(controls)) delete controls[k];

    // 每个标签页先建一个 section 容器，schema 的组按 TAB_OF_GROUP 分配进去
    const tabSections = {};
    for (const tabId of ["image", "cursor", "physics"]) {
      const sec = document.createElement("section");
      sec.className = "group";
      sec.dataset.tab = tabId;

      const h = document.createElement("h2");
      h.textContent = TAB_TITLE[tabId];
      sec.appendChild(h);

      els.groups.appendChild(sec);
      tabSections[tabId] = sec;
    }

    for (const g of S.GROUPS) {
      const tabId = TAB_OF_GROUP[g.id] || "physics";
      const host = tabSections[tabId];

      if (g.note) {
        const note = document.createElement("p");
        note.className = "note";
        note.textContent = g.note;
        host.appendChild(note);
      }

      for (const f of g.fields) {
        host.appendChild(buildField(f));
      }
      if (g.id === "appearance") {
        host.appendChild(buildImportRow());
        host.appendChild(buildLibrary());
      }
    }
    switchTab(activeTab);
  }

  /** 字符串/枚举字段取值：overrides 优先，其次出厂值，最后给 fallback */
  function sval(key, fallback) {
    const v = S.getAt(overrides, key);
    if (typeof v === "string") return v;
    const d = S.getAt(DEFAULTS, key);
    return typeof d === "string" ? d : fallback;
  }

  // ---------- 挂饰库（第 18 轮，m05728）----------
  // dangleList 存为 JSON 字符串 [{name,path},...]；自带小熊永远是第一项。
  function readDangleList() {
    const raw = sval("doll.dangleList", "[]");
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x) => x && typeof x.path === "string") : [];
    } catch (_) { return []; }
  }
  function writeDangleList(list) {
    S.setAt(overrides, "doll.dangleList", JSON.stringify(list));
  }

  /** 挂饰下拉是动态的：自带小熊 + dangleList 每项。value = "bear" | 列表索引。 */
  function dangleValue() {
    const p = currentImagePath();
    if (sval("doll.dangle", "emoji") !== "image" || !p) return "bear";
    const list = readDangleList();
    const i = list.findIndex((x) => x.path === p);
    return i >= 0 ? String(i) : "raw:" + p;
  }

  /** 挂饰下拉变更：同步写 dangle / image.path / dangleName，并刷细节行 */
  function applyDangleValue(val) {
    if (val === "bear") {
      S.setAt(overrides, "doll.dangle", "emoji");
      // 不清 image.path：换回图片时无需重新导入
    } else {
      const list = readDangleList();
      const item = val.startsWith("raw:") ? { name: "", path: val.slice(4) } : list[Number(val)];
      if (!item) return;
      S.setAt(overrides, "doll.dangle", "image");
      S.setAt(overrides, "doll.image.path", item.path);
      S.setAt(overrides, "doll.dangleName", item.name || "");
    }
    selectedPresetId = null;
    pendingSend = S.toFlat(overrides);
    if (!sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = null;
        push(pendingSend, () => { if (importEls) refreshImportRow(); });
      }, 60);
    }
    refreshReadouts();
    refreshDangleSelect();
    if (importEls) refreshImportRow();
  }

  /** 重建挂饰下拉 options（保存新挂饰后调用） */
  function refreshDangleSelect() {
    const ctl = controls["doll.dangle"];
    if (!ctl || !ctl.select) return;
    const sel = ctl.select;
    const cur = dangleValue();
    sel.textContent = "";
    const bear = document.createElement("option");
    bear.value = "bear";
    bear.textContent = "自带小熊 🧸";
    sel.appendChild(bear);
    const list = readDangleList();
    list.forEach((item, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = item.name || String(item.path).split(/[\\/]/).pop();
      sel.appendChild(opt);
    });
    // 当前在用但还没入库的图（旧版导入遗留）
    if (cur.startsWith("raw:")) {
      const opt = document.createElement("option");
      opt.value = cur;
      opt.textContent = String(cur.slice(4)).split(/[\\/]/).pop() + "（未命名）";
      sel.appendChild(opt);
    }
    sel.value = cur;
    if (sel.value !== cur) sel.value = "bear"; // 兜底
    if (ctl.readout) {
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      ctl.readout.textContent = opt ? opt.textContent : "";
    }
  }

  /** 下拉选择字段（如挂饰 emoji/image）。不走数值滑块那套 refreshField。 */
  function buildChoiceField(f) {
    const wrap = document.createElement("div");
    wrap.className = "field";

    const top = document.createElement("div");
    top.className = "field-top";
    const label = document.createElement("span");
    label.className = "label-text";
    label.textContent = f.label;
    top.appendChild(label);
    const readout = document.createElement("span");
    readout.className = "readout";
    top.appendChild(readout);
    wrap.appendChild(top);

    const sel = document.createElement("select");
    sel.className = "choice";
    for (const o of f.options) {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    if (f.key === "doll.dangle") {
      sel.addEventListener("change", () => applyDangleValue(sel.value));
    } else {
      sel.value = sval(f.key, f.options[0].v);
      sel.addEventListener("change", () => {
        S.setAt(overrides, f.key, sel.value);
        selectedPresetId = null;
        wrap.classList.toggle("overridden", true);
        pendingSend = S.toFlat(overrides);
        if (!sendTimer) {
          sendTimer = setTimeout(() => {
            sendTimer = null;
            push(pendingSend, () => { if (importEls) refreshImportRow(); });
          }, 60);
        }
        refreshReadouts();
        if (importEls) refreshImportRow();
      });
    }
    wrap.appendChild(sel);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = f.hint;
    wrap.appendChild(hint);

    controls[f.key] = { select: sel, readout, wrap, field: f };
    return wrap;
  }

  // ---------- 自定义图片导入行（图片页） ----------
  let importEls = null;

  function currentImagePath() {
    let v = S.getAt(overrides, "doll.image.path");
    if (typeof v !== "string") v = S.getAt(applied, "doll.image.path");
    return typeof v === "string" ? v : null;
  }

  function buildImportRow() {
    const wrap = document.createElement("div");
    wrap.className = "field import-row";

    const label = document.createElement("span");
    label.className = "label-text";
    label.textContent = "自定义图片";
    wrap.appendChild(label);

    const btns = document.createElement("div");
    btns.className = "import-btns";
    const pick = document.createElement("button");
    pick.className = "btn";
    pick.type = "button";
    pick.textContent = "导入图片…";
    pick.addEventListener("click", onPickImage);
    btns.appendChild(pick);
    wrap.appendChild(btns);

    const thumb = document.createElement("img");
    thumb.className = "import-thumb";
    thumb.style.display = "none";
    wrap.appendChild(thumb);

    const cur = document.createElement("span");
    cur.className = "recorder-file";
    wrap.appendChild(cur);

    // 命名 + 入库（第 18 轮）：导入后输入名称，「保存到挂饰库」把它加进下拉
    const saveRow = document.createElement("div");
    saveRow.className = "import-btns";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "text-input import-name";
    nameInput.placeholder = "挂饰名称";
    nameInput.maxLength = 50;
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn";
    saveBtn.type = "button";
    saveBtn.textContent = "保存到挂饰库";
    saveBtn.addEventListener("click", onSaveDangle);
    saveRow.appendChild(nameInput);
    saveRow.appendChild(saveBtn);
    wrap.appendChild(saveRow);

    importEls = { wrap, thumb, cur, dataUrl: null, nameInput, saveRow };
    refreshImportRow();
    return wrap;
  }

  /** 把刚导入的图片以输入的名称存进 dangleList 并应用（第 18 轮） */
  function onSaveDangle() {
    if (!importEls) return;
    const name = (importEls.nameInput.value || "").trim();
    if (!name) { setStatus("请先输入挂饰名称", true); importEls.nameInput.focus(); return; }
    const path = S.getAt(overrides, "doll.image.path");
    if (typeof path !== "string" || !path) { setStatus("请先导入图片", true); return; }
    const list = readDangleList();
    const existing = list.findIndex((x) => x.path === path);
    if (existing >= 0) list[existing].name = name; else list.push({ name, path });
    writeDangleList(list);
    S.setAt(overrides, "doll.dangle", "image");
    S.setAt(overrides, "doll.image.path", path);
    S.setAt(overrides, "doll.dangleName", name);
    selectedPresetId = null;
    pendingSend = S.toFlat(overrides);
    push(pendingSend, () => {
      importEls.nameInput.value = "";
      setStatus("已保存挂饰「" + name + "」并应用");
    });
    refreshDangleSelect();
    refreshLibrary();
    refreshImportRow();
  }

  function refreshImportRow() {
    if (!importEls) return;
    const dangle = sval("doll.dangle", "emoji");
    const p = currentImagePath();
    if (importEls.dataUrl) {
      importEls.thumb.src = importEls.dataUrl;
      importEls.thumb.style.display = "";
    } else {
      importEls.thumb.style.display = "none";
    }
    if (dangle !== "image") {
    importEls.cur.textContent = "当前：自带小熊 🧸（用上方「挂饰」下拉切换）";
    } else if (!p) {
      importEls.cur.textContent = "当前：未导入（先点「导入图片…」，期间显示小熊）";
    } else {
      const nm = sval("doll.dangleName", "");
      const list = readDangleList();
      const hit = list.find((x) => x.path === p);
      const shown = nm || (hit && hit.name) || "";
      importEls.cur.textContent = "当前：" + (shown ? "「" + shown + "」" : "") + String(p).split(/[\\/]/).pop();
      importEls.cur.title = p;
      if (!importEls.dataUrl && p) {
        importEls.thumb.src = p;
        importEls.thumb.style.display = "";
      }
    }
    if (importEls.saveRow) importEls.saveRow.style.display = importEls.dataUrl ? "" : "none";
  }

  async function onPickImage() {
    if (!window.settingsApi || !window.settingsApi.pickImage) {
      setStatus("未连接到主程序");
      return;
    }
    try {
      const res = await window.settingsApi.pickImage();
      if (!res || !res.ok) {
        if (res && res.error) setStatus("导入失败：" + res.error, true);
        return;
      }
      S.setAt(overrides, "doll.dangle", "image");
      S.setAt(overrides, "doll.image.path", res.path);
      selectedPresetId = null;
      if (importEls) importEls.dataUrl = res.dataUrl;
      pendingSend = S.toFlat(overrides);
      push(pendingSend, () => setStatus("已应用自定义图片"));
      refreshReadouts();
      refreshImportRow();
    } catch (e) {
      setStatus("导入失败", true);
    }  }

  // ---------- 挂饰库管理（第 19 轮）：列表 / 重命名 / 删除 ----------
  let libEls = null;

  function buildLibrary() {
    const wrap = document.createElement("div");
    wrap.className = "field import-row dangle-lib";

    const label = document.createElement("span");
    label.className = "label-text";
    label.textContent = "挂饰库";
    wrap.appendChild(label);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "已保存的自定义挂饰。可重命名或删除；删除会同时清掉项目 assets\\dangles\\ 里的图片文件。";
    wrap.appendChild(hint);

    const rows = document.createElement("div");
    rows.className = "lib-rows";
    wrap.appendChild(rows);

    const empty = document.createElement("p");
    empty.className = "hint lib-empty";
    empty.textContent = "（还没有保存的挂饰 —— 用上方「导入图片…」添加）";
    wrap.appendChild(empty);

    libEls = { rows, empty };
    refreshLibrary();
    return wrap;
  }

  function sendOverrides(done) {
    selectedPresetId = null;
    pendingSend = S.toFlat(overrides);
    if (!sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = null;
        push(pendingSend, done);
      }, 60);
    } else {
      if (done) done();
    }
  }

  function refreshLibrary() {
    if (!libEls) return;
    const list = readDangleList();
    libEls.rows.textContent = "";
    libEls.empty.style.display = list.length ? "none" : "";
    const activePath = currentImagePath();
    list.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "lib-row";

      const thumb = document.createElement("img");
      thumb.className = "lib-thumb";
      thumb.src = item.path;
      row.appendChild(thumb);

      const name = document.createElement("input");
      name.type = "text";
      name.className = "text-input import-name lib-name";
      name.maxLength = 50;
      name.value = item.name || "";
      name.placeholder = "名称";
      name.title = item.path;
      name.addEventListener("change", () => onRenameDangle(i, name.value));
      row.appendChild(name);

      const useBtn = document.createElement("button");
      useBtn.className = "btn ghost lib-btn";
      useBtn.type = "button";
      useBtn.textContent = "使用";
      if (sval("doll.dangle", "emoji") === "image" && activePath === item.path) {
        useBtn.textContent = "使用中";
        useBtn.disabled = true;
      } else {
        useBtn.addEventListener("click", () => applyDangleValue(String(i)));
      }
      row.appendChild(useBtn);

      const del = document.createElement("button");
      del.className = "btn ghost lib-btn lib-del";
      del.type = "button";
      del.textContent = "删除";
      del.addEventListener("click", () => onDeleteDangle(i));
      row.appendChild(del);

      libEls.rows.appendChild(row);
    });
  }

  function onRenameDangle(i, value) {
    const list = readDangleList();
    if (!list[i]) return;
    const nm = String(value || "").trim();
    if (!nm) { setStatus("名称不能为空", true); refreshLibrary(); return; }
    if (list[i].name === nm) return;
    list[i].name = nm;
    writeDangleList(list);
    // 当前正在用的那条要同步 dangleName
    if (sval("doll.dangle", "emoji") === "image" && currentImagePath() === list[i].path) {
      S.setAt(overrides, "doll.dangleName", nm);
      sendOverrides(() => setStatus("已重命名为「" + nm + "」"));
    } else {
      setStatus("已重命名为「" + nm + "」");
    }
    refreshDangleSelect();
    refreshLibrary();
    refreshImportRow();
  }

  async function onDeleteDangle(i) {
    const list = readDangleList();
    if (!list[i]) return;
    const item = list[i];
    if (!window.confirm("删除挂饰「" + (item.name || item.path) + "」？\n项目内的图片文件也会一并删除，无法恢复。")) return;
    const wasActive = sval("doll.dangle", "emoji") === "image" && currentImagePath() === item.path;
    list.splice(i, 1);
    writeDangleList(list);
    if (window.settingsApi && window.settingsApi.deleteDangle) {
      try { await window.settingsApi.deleteDangle({ path: item.path }); } catch (_) {}
    }
    if (wasActive) {
      // 删的是正在用的：先回自带小熊（保留 path 无意义了，一并清掉）
      S.setAt(overrides, "doll.dangle", "emoji");
      S.setAt(overrides, "doll.image.path", "");
      S.setAt(overrides, "doll.dangleName", "");
    }
    sendOverrides(() => setStatus(wasActive ? "已删除挂饰，切回自带小熊" : "已删除挂饰"));
    refreshDangleSelect();
    refreshLibrary();
    refreshImportRow();
  }

  function buildField(f) {
    if (f.type === "choice") return buildChoiceField(f);
    const wrap = document.createElement("div");
    wrap.className = "field";

    const top = document.createElement("div");
    top.className = "field-top";

    const label = document.createElement("span");
    label.className = "label-text";
    label.textContent = f.label;
    top.appendChild(label);

    const readout = document.createElement("span");
    readout.className = "readout";
    top.appendChild(readout);

    const valueEl = document.createElement("span");
    valueEl.className = "value";
    top.appendChild(valueEl);

    wrap.appendChild(top);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step || 1);
    input.addEventListener("input", () => onSlide(f, input, valueEl, readout, wrap));
    wrap.appendChild(input);

    const factory = fmt(S.getAt(DEFAULTS, f.key), f.step);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = f.hint + "（出厂 " + factory + (f.unit ? " " + f.unit : "") + "）";
    wrap.appendChild(hint);

    controls[f.key] = { input, valueEl, readout, wrap, field: f };
    return wrap;
  }

  /** 把某个字段的滑块与显示刷成"当前值"。值来源是 overrides 或出厂默认。 */
  function refreshField(key) {
    const c = controls[key];
    if (!c || !c.field) return;
    const f = c.field;
    const cur = val(key, (f.min + f.max) / 2);
    c.input.value = String(cur);
    c.valueEl.textContent = fmt(cur, f.step) + (f.unit ? " " + f.unit : "");
    c.readout.textContent = computeReadout(f);
    const isOver = typeof S.getAt(overrides, key) === "number";
    c.wrap.classList.toggle("overridden", isOver);
  }

  /** 依赖关系的字段：改 gravity / segments / 绳长 都会影响周期和 tau 的读数 */
  function refreshReadouts() {
    for (const key of Object.keys(controls)) {
      const c = controls[key];
      if (!c || !c.field) continue;          // 防御：脏键不许把整个刷新打断
      if (c.field.type === "choice") {
        c.select.value = sval(key, c.field.options[0].v);
        c.wrap.classList.toggle("overridden", typeof S.getAt(overrides, key) === "string");
        continue;
      }
      if (c.field.readout) c.readout.textContent = computeReadout(c.field);
      const cur = val(key, (c.field.min + c.field.max) / 2);
      c.input.value = String(cur);
      c.valueEl.textContent = fmt(cur, c.field.step) + (c.field.unit ? " " + c.field.unit : "");
      c.wrap.classList.toggle("overridden", typeof S.getAt(overrides, key) === "number");
    }
    refreshChrome();
  }

  /** 用 applied（真正生效的值）判断哪个档位是 active；用 selectedPresetId 判断哪个是 selected */
  function refreshChrome() {
    const appliedFlat = S.toFlat(applied);   // applied 是嵌套的，这里拍平才能逐键比
    let activeId = null;
    for (const p of S.PRESETS) {
      const keys = Object.keys(p.values);
      if (keys.length !== Object.keys(appliedFlat).length) continue;
      let same = true;
      for (const k of keys) {
        const got = appliedFlat[k];
        if (typeof got !== "number" || Math.abs(got - p.values[k]) > 1e-9) { same = false; break; }
      }
      if (same) { activeId = p.id; break; }
    }
    // 滑条三态：
    //   thumb 在生效档位上           = active（描边金）
    //   thumb 在选了还没应用的档位上 = selected（描边蓝）
    //   thumb 在中间/手动拖过的位置   = neutral
    const selIdx = selectedPresetId ? presetIndex(selectedPresetId) : -1;
    const actIdx = activeId ? presetIndex(activeId) : -1;
    els.presetRange.classList.toggle("is-selected", selIdx >= 0);
    els.presetRange.classList.toggle("is-active", actIdx >= 0 && selIdx < 0);
    if (selectedPresetId) {
      // 预览中：值先搬到滑块显示，但不写进 overrides（selectPreset 已经搬过）
      els.presetHint.textContent = S.BY_PRESET[selectedPresetId].summary;
      els.apply.disabled = false;
      els.apply.textContent = "应用（第 " + S.BY_PRESET[selectedPresetId].name + " 档）";
    } else {
      els.apply.disabled = true;
      els.apply.textContent = "应用";
      const act = activeId ? S.BY_PRESET[activeId] : null;
      els.presetHint.textContent = act
        ? "当前生效：第 " + act.name + " 档 —— " + act.summary
        : "手动微调模式（拖动上方滑条选档位，点「应用」整组切换）。";
    }
    // 滑条 thumb 落在"生效档"上（没有待应用选择时）
    if (selIdx < 0 && actIdx >= 0) els.presetRange.value = String(actIdx + 1);
  }

  function presetIndex(id) {
    for (let i = 0; i < S.PRESETS.length; i++) if (S.PRESETS[i].id === id) return i;
    return -1;
  }

  let pendingSend = null;
  let sendTimer = null;
  // 自己刚推上去的值会被主进程原样广播回来。如果不忽略这段回流，
  // 拖动中的滑块会被重新赋值，手感上像"被拽回去一下"。
  let ignoreEchoUntil = 0;

  /** 拖动时高频触发：先更新界面，网络（IPC）用 ~60ms 合并一次 */
  function onSlide(f, input, valueEl, readout, wrap) {
    const v = Number(input.value);
    if (!isFinite(v)) return;
    S.setAt(overrides, f.key, v);
    // 手动微调之后就不再是"纯档位"了，把待应用的档位选择清掉
    selectedPresetId = null;
    valueEl.textContent = fmt(v, f.step) + (f.unit ? " " + f.unit : "");
    wrap.classList.toggle("overridden", true);
    refreshReadouts();       // 周期 / tau 依赖 gravity 和 damping，必须联动

    pendingSend = S.toFlat(overrides);
    if (!sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = null;
        push(pendingSend, () => { if (importEls) refreshImportRow(); });
      }, 60);
    }
  }

  /**
   * 把一份扁平值提交给主进程。
   * onDone 只在提交成功后被调用（档位应用要靠它把 selected 清掉）。
   */
  function push(flat, onDone) {
    if (!window.settingsApi) {
      applied = S.fromFlat(flat || {});
      if (onDone) onDone();
      return;
    }
    ignoreEchoUntil = Date.now() + 400;
    window.settingsApi.set(S.fromFlat(flat)).then((res) => {
      if (res && res.ok) {
        // 用主进程清洗后的结果当权威值（它可能按 min/max/step 改了我们的数）
        applied = (res && res.overrides) ? res.overrides : S.fromFlat(flat || {});
        if (onDone) onDone();
        else setStatus("已应用");
      } else {
        setStatus("保存失败");
      }
      refreshChrome();
    }).catch(() => setStatus("保存失败"));
  }

  // ---------- 档位（1~7 滑动条） ----------
  function buildPresets() {
    const n = S.PRESETS.length;
    els.presetRange.min = "1";
    els.presetRange.max = String(n);
    els.presetRange.step = "1";
    els.presetMinLabel.textContent = "1 档";
    els.presetMaxLabel.textContent = n + " 档";
    // 选中档位 → 只预览；「应用」按钮 → 提交（交互语义与原先的 chip 完全一致）
    els.presetRange.addEventListener("input", () => {
      const idx = Number(els.presetRange.value) - 1;
      const p = S.PRESETS[idx];
      if (p) selectPreset(p);
    });
    refreshChrome();
  }

  /** 选中档位：只把值搬到界面上，不提交。要用户点「应用」才生效。 */
  function selectPreset(p) {
    selectedPresetId = p.id;
    // 档位是"整组替换"，不是叠加 —— 否则选了第 3 档再选第 5 档会残留上一次的值
    overrides = {};
    for (const key of Object.keys(p.values)) {
      S.setAt(overrides, key, p.values[key]);
    }
    refreshReadouts();
    if (p.id === "lv4") {
      setStatus("已选中「出厂默认」，点「应用」生效");
    } else {
      setStatus("已选中第 " + p.name + " 档，点「应用」生效");
    }
  }

  /** 点「应用」：把当前 overrides 提交上去，然后清掉待应用状态 */
  function applyPending() {
    if (!selectedPresetId) return;
    const p = S.BY_PRESET[selectedPresetId];
    const flat = S.toFlat(overrides);
    els.apply.disabled = true;
    push(flat, () => {
      selectedPresetId = null;
      refreshChrome();
      // 第 4 档是"清空覆盖值"，文案不能说"已应用第 4 档"，否则用户以为写了个新档案
      if (flat && Object.keys(flat).length === 0) setStatus("已恢复出厂默认");
      else setStatus("已应用第 " + (p ? p.name : "?") + " 档");
    });
  }

  // ---------- 恢复默认 ----------
  els.resetAll.addEventListener("click", () => {
    selectedPresetId = null;
    overrides = {};
    refreshReadouts();
    push({}, () => {
      setStatus("已恢复出厂默认");
    });
  });

  els.apply.addEventListener("click", applyPending);

  els.close.addEventListener("click", () => {
    if (window.settingsApi && window.settingsApi.close) window.settingsApi.close();
    else window.close();
  });

  // ---------- 诊断记录 ----------
  // 状态只有一个来源：覆盖层每 0.5s 回推一次。面板不自己计时，
  // 否则关掉面板再打开会显示成"还在录"但实际早就停了（覆盖层是权威）。
  let recording = false;

  function paintRecordButton() {
    els.recordToggle.textContent = recording ? "停止记录" : "开始记录";
    els.recordToggle.classList.toggle("recording", recording);
  }

  function paintRecordStatus(st) {
    if (!st) return;
    recording = st.recording === true;
    paintRecordButton();
    if (recording) {
      const sec = (st.elapsedMs || 0) / 1000;
      els.recordStatus.textContent = "记录中 " + sec.toFixed(1) + " 秒 · " + (st.count || 0) + " 条";
    } else if (st.count) {
      els.recordStatus.textContent = "已停止 · 共 " + st.count + " 条";
    } else {
      els.recordStatus.textContent = "";
    }
  }

  els.recordToggle.addEventListener("click", () => {
    if (!window.settingsApi || !window.settingsApi.record) {
      setStatus("未连接到主程序");
      return;
    }
    const cmd = recording ? "stop" : "start";
    window.settingsApi.record(cmd).then((res) => {
      if (!res || !res.ok) {
        setStatus((res && res.error) ? res.error : "记录命令失败");
        return;
      }
      // 立刻翻转按钮，别等 0.5s 后的状态推送 —— 否则点下去像没反应
      recording = cmd === "start";
      paintRecordButton();
      if (recording) {
        els.recordFile.textContent = "";
        setStatus("开始记录");
      } else {
        setStatus("已停止，正在保存…");
      }
    }).catch(() => setStatus("记录命令失败"));
  });

  if (window.settingsApi && window.settingsApi.onRecord) {
    window.settingsApi.onRecord((st) => paintRecordStatus(st));
  }
  if (window.settingsApi && window.settingsApi.onRecordSaved) {
    window.settingsApi.onRecordSaved((res) => {
      if (!res) return;
      if (!res.ok) {
        els.recordFile.textContent = "";
        setStatus("保存失败：" + (res.error || "未知错误"), true);
        return;
      }
      // 只显示文件名，完整路径太长会把这一行撑爆
      const name = String(res.path).split(/[\\/]/).pop();
      els.recordFile.textContent = name + " · " + res.samples + " 条 · " + Math.round(res.bytes / 1024) + " KB";
      els.recordFile.title = res.path;
      setStatus("已保存到 records 目录");
    });
  }

  // ---------- 启动 ----------
  build();
  buildTabs();
  buildPresets();

  if (window.settingsApi) {
    // 主进程是唯一真相源：面板打开时先同步一次，之后每次广播都覆盖本地状态
    window.settingsApi.get().then((res) => {
      const server = (res && res.overrides) ? res.overrides : {};
      overrides = S.fromFlat(S.toFlat(server));
      applied = server;
      refreshReadouts();
      refreshImportRow();
      refreshLibrary();
      refreshDangleSelect();
      setStatus("");
    }).catch(() => refreshReadouts());

    window.settingsApi.onChanged((res) => {
      if (!res || !res.overrides) return;
      // 自己刚推上去的回流：值本来就是从这边发出去的，刷新界面只会打断拖动
      if (Date.now() < ignoreEchoUntil) return;
      const server = res.overrides;
      overrides = S.fromFlat(S.toFlat(server));
      applied = server;
      selectedPresetId = null;
      refreshReadouts();
      refreshImportRow();
      refreshLibrary();
      refreshDangleSelect();
    });
  } else {
    // 用浏览器直接打开这个 HTML 时的降级路径：只用出厂默认值把界面画出来
    applied = {};
    refreshReadouts();
    setStatus("未连接到主程序，仅预览界面");
  }
})();
