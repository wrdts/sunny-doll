// main.js  --  主进程：透明置顶全屏窗 + 鼠标穿透 + 指针轮询兜底 + 托盘 + 兜底快捷键
"use strict";

const {
  app, BrowserWindow, screen, Tray, Menu, nativeImage,
  globalShortcut, ipcMain, dialog
} = require("electron");
const path = require("path");
const fs = require("fs");
const settingsStore = require("./settings-store");
const settingsSchema = require("./settings-schema");

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

let win = null;
let tray = null;
let pollTimer = null;
let visible = true;
let settingsWin = null;         // 设置窗口（普通可交互窗口，跟覆盖层是两个窗口）
let currentOverrides = {};      // 用户手动调整过的参数（嵌套形状，只含改过的字段）
let lastSentX = NaN;
let lastSentY = NaN;
let recording = false;          // 诊断记录器是否在录（由覆盖层回推的状态维护）

const QUIT_SHORTCUT = "Control+Alt+Q";
const EMPTY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ---------- 读取 config.js 里主进程关心的项 ----------
function readConfigHints() {
  const hints = { pollIntervalMs: 8, emoji: "\u{1F9F8}" };
  try {
    const src = fs.readFileSync(path.join(__dirname, "renderer", "config.js"), "utf8");
    const poll = src.match(/pollIntervalMs\s*:\s*(\d+)/);
    if (poll) hints.pollIntervalMs = Math.max(4, parseInt(poll[1], 10));
    const em = src.match(/emoji\s*:\s*"([^"\\]*)"/);
    if (em) hints.emoji = em[1] || hints.emoji;
  } catch (_) {
    // 配置读不到不影响运行
  }
  return hints;
}

/** 铺满主屏。必须在窗口显示之后再调，否则会被任务栏工作区限制。 */
function fillPrimaryScreen() {
  if (!win || win.isDestroyed()) return;
  const b = screen.getPrimaryDisplay().bounds;
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  lastSentX = NaN;
  lastSentY = NaN;
}

// ---------- 透明置顶全屏窗 ----------
function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,             // 不抢焦点
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false // 失焦时 rAF 也要跑满帧
    }
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 关键：鼠标穿透；forward:true 让 Windows 仍把 mousemove 转发进来
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // did-finish-load 在 index.html 的所有脚本都执行完之后才触发，
  // 此时渲染层的 settings:apply 监听器一定已经注册好，不会漏掉第一帧。
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("settings:apply", { overrides: currentOverrides });
  });

  win.once("ready-to-show", () => {
    win.showInactive();
    // 必须显示之后再 setBounds，否则高度会被工作区压掉 48px（任务栏）
    fillPrimaryScreen();
    // 稍后再校正一次，防止刚开始时窗口尺寸还没稳定
    setTimeout(fillPrimaryScreen, 120);
    startCursorPolling();
  });

  win.on("closed", () => { win = null; });
}

// ---------- 指针轮询兜底 ----------
// 部分显卡驱动 / 多显示器组合下 forward:true 的 mousemove 会失效，
// 这条路径用系统 API 取指针坐标，一定能拿到（频率受定时器限制）。
function startCursorPolling() {
  stopCursorPolling();
  const hints = readConfigHints();

  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !visible) return;

    let p;
    try {
      p = screen.getCursorScreenPoint();   // 与窗口 bounds 同一坐标系（DIP）
    } catch (_) {
      return;
    }

    const b = win.getBounds();
    const cx = p.x - b.x;
    const cy = p.y - b.y;

    // 指针不在本窗口范围就不推送
    if (cx < -40 || cy < -40 || cx > b.width + 40 || cy > b.height + 40) return;

    // 【必须每次都推】早年在位置没变时直接 return，结果是：
    // 渲染进程用脚本把指针钉在 (x,y)，主进程的 lastSentX/Y 也停在同一处，
    // 于是"解锁鼠标"那一刻光标虽然真的在那里，却永远收不到推送，卡死在脚本值上。
    // 渲染进程自己会按 lastMouseEventAt 判断要不要让位给真实 mousemove，重复推送无害。
    lastSentX = cx;
    lastSentY = cy;

    win.webContents.send("cursor", { x: cx, y: cy });
  }, hints.pollIntervalMs);
}

function stopCursorPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---------- 托盘 ----------
function createTray() {
  const hints = readConfigHints();

  let img = nativeImage.createEmpty();
  try {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
      '<text x="8" y="9" font-size="15" text-anchor="middle" dominant-baseline="central">' +
      hints.emoji +
      "</text></svg>";
    img = nativeImage.createFromDataURL(
      "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64")
    );
  } catch (_) {
    // SVG 渲染失败就用透明占位图，菜单依然可用
  }

  tray = new Tray(img.isEmpty() ? nativeImage.createFromDataURL(EMPTY_ICON) : img);
  tray.setToolTip("晴天娃娃 · 挂在鼠标指针下方");
  rebuildTrayMenu();
  tray.on("click", toggleVisibility);
}

/**
 * 托盘里的"档位"子菜单。和设置面板里的七个档位是同一份数据（settings-schema.js），
 * 所以从托盘直接换档不会和面板显示的当前档位打架。
 */
function buildPresetMenu() {
  const activeId = activePresetId();
  return settingsSchema.PRESETS.map((p) => ({
    label: p.name + " 档" + (p.desc ? "   " + p.desc : ""),
    type: "radio",
    checked: p.id === activeId,
    click: () => applyPresetById(p.id)
  }));
}

/** 当前生效值正好等于某个档位时返回它的 id，否则 null（用户手动拖过了） */
function activePresetId() {
  const flat = settingsSchema.toFlat(currentOverrides || {});
  const got = Object.keys(flat);
  for (const p of settingsSchema.PRESETS) {
    const keys = Object.keys(p.values);
    if (keys.length !== got.length) continue;
    let same = true;
    for (const k of keys) {
      if (typeof flat[k] !== "number" || Math.abs(flat[k] - p.values[k]) > 1e-9) { same = false; break; }
    }
    if (same) return p.id;
  }
  return null;
}

/** 从托盘直接套用一个档位：不经面板，但走同一条 sanitize + 存盘 + 广播链路 */
function applyPresetById(id) {
  const p = settingsSchema.BY_PRESET[id];
  if (!p) return;
  const clean = settingsSchema.sanitize(p.values);
  currentOverrides = clean;
  settingsStore.set(clean);
  broadcastOverrides();
  if (settingsWin && !settingsWin.isDestroyed()) {
    // 面板开着的话把它的选中态一起清掉，免得它显示成"待应用"
    settingsWin.webContents.send("settings:changed", { overrides: currentOverrides });
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send("settings:apply", { overrides: currentOverrides });
  }
  rebuildTrayMenu();   // radio 勾要跟着走
}

/** 托盘「开始/停止诊断记录」。真正的采样在覆盖层里，主进程只负责转发命令。 */
function toggleRecording() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("record:cmd", { cmd: recording ? "stop" : "start" });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: visible ? "隐藏娃娃" : "显示娃娃", click: toggleVisibility },
    { type: "separator" },
    {
      label: "重载配置",
      click: () => {
        if (!win || win.isDestroyed()) return;
        lastSentX = NaN;
        lastSentY = NaN;
        win.webContents.send("reload-config");
      }
    },
    { label: "设置…", accelerator: "Control+Alt+S", click: openSettings },
    { label: "档位", submenu: buildPresetMenu() },
    {
      // 托盘这一项和面板里的按钮走同一条通道，所以两边的状态永远一致。
      // 放在托盘是为了不打开面板也能开录 —— 手感出问题的那一秒本来就来不及开面板。
      label: recording ? "停止诊断记录" : "开始诊断记录",
      click: toggleRecording
    },
    { label: "重新铺满主屏", click: fillPrimaryScreen },
    { type: "separator" },
    { label: "退出 (Ctrl+Alt+Q)", click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function toggleVisibility() {
  if (!win || win.isDestroyed()) return;
  visible = !visible;
  if (visible) {
    win.showInactive();
    fillPrimaryScreen();
    // 覆盖层永远保持置顶；面板活着就把它重新压回覆盖层之上
    win.setAlwaysOnTop(true, "screen-saver");
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.moveTop();
    win.setIgnoreMouseEvents(true, { forward: true });
    lastSentX = NaN;
    lastSentY = NaN;
  } else {
    win.hide();
    // 娃娃都藏了，设置面板也就没有作用对象了，一起收起来
    closeSettings();
  }
  rebuildTrayMenu();
}

// ---------- 设置窗口 ----------
// 为什么必须另开一个窗口，而不是在覆盖层里画 DOM 面板：
//   覆盖层是 setIgnoreMouseEvents(true, {forward:true}) + focusable:false 的全屏透明窗，
//   任何控件都点不到（硬约束 C1）。想给用户可点的界面，只能开第二个普通窗口。
// 面板打开期间覆盖层也保持置顶（见下方 ready-to-show 的说明），只把面板压到它上面。

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 620,
    height: 800,
    minWidth: 520,
    minHeight: 480,
    title: "晴天娃娃 · 设置",
    backgroundColor: "#16181d",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWin.loadFile(path.join(__dirname, "settings", "settings.html"));

  settingsWin.once("ready-to-show", () => {
    // 覆盖层任何时候都不能离开置顶层。
    // 早期做法是打开面板时 win.setAlwaysOnTop(false)，等关窗再恢复；变化本身没错，
    // 但面板开着的整段时间里娃娃会被别的窗口盖住，用户看到的就是"置顶没了"。
    // 现在反过来：覆盖层保持 screen-saver 级，把面板也提成置顶，再 moveTop() 压到它上面。
    // 覆盖层是鼠标穿透的透明窗，即使被面板压住也不影响点击，只需要保证面板在它之上。
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, "screen-saver");
    }
    settingsWin.setAlwaysOnTop(true, "screen-saver");
    settingsWin.show();
    settingsWin.moveTop();
    settingsWin.focus();
    rebuildTrayMenu();
  });

  // 关窗（含 Alt+F4 / 右上角 X）统一走这里恢复覆盖层状态
  settingsWin.on("closed", () => {
    settingsWin = null;
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop(); // 面板消失后，覆盖层要重新回到置顶带的最上面
    }
    rebuildTrayMenu();
  });
}

function toggleSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) closeSettings();
  else openSettings();
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  settingsWin = null;
}

/** 把当前覆盖值推给覆盖层（覆盖层是纯接收方，不读文件、不读面板） */
function broadcastOverrides() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("settings:apply", { overrides: currentOverrides });
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send("settings:changed", { overrides: currentOverrides });
  }
  // 这里不要 rebuildTrayMenu()：拖动滑块时它每 60ms 被调一次，重建托盘菜单会闪烁。
  // 菜单内容本身也不随参数变化，没必要跟着刷。
}

// ---------- 诊断记录器 ----------
// 数据流是一条直线，没有任何回路：
//   面板点「开始记录」 -> ipc "record:cmd" -> 主进程 -> 转发给覆盖层
//   -> renderer/recorder.js 每 0.1s 采一条
//   -> 每 0.5s 回推条数给面板显示
//   -> 停止时把完整数据交回主进程，由主进程落盘（渲染层没有文件系统权限）
// 主进程这里只做转发 + 存文件，不碰任何物理量。

/** 记录文件放在 userData/records/ 下，和 settings.json 同级，升级不丢 */
/** 挂饰图片库：项目内 assets/dangles/（第 18 轮）。导入的图复制到这里，settings 里只存项目内路径。 */
function danglesDir() {
  const dir = path.join(__dirname, "assets", "dangles");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function recordsDir() {
  const dir = path.join(app.getPath("userData"), "records");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // 建不出来就交给 writeFile 报错
  }
  return dir;
}

/**
 * 序列化成"每条样本一行"的 JSON：整体仍是合法 JSON（JSON.parse 能读），
 * 但一条样本占一行 —— 几万条也能用编辑器直接翻，不用先写脚本展开。
 */
function serializeRecord(data) {
  const samples = Array.isArray(data.samples) ? data.samples : [];
  const head = Object.assign({}, data);
  delete head.samples;

  const NL = String.fromCharCode(10);
  const parts = ["{"];
  for (const k of Object.keys(head)) {
    const body = JSON.stringify(head[k], null, 2).split(NL).join(NL + "  ");
    parts.push("  " + JSON.stringify(k) + ": " + body + ",");
  }
  parts.push('  "samples": [');
  for (let i = 0; i < samples.length; i++) {
    parts.push("    " + JSON.stringify(samples[i]) + (i < samples.length - 1 ? "," : ""));
  }
  parts.push("  ]");
  parts.push("}");
  return parts.join(NL) + NL;
}

function stampName(ms) {
  const d = new Date(typeof ms === "number" && isFinite(ms) ? ms : Date.now());
  const p2 = function (v) { return String(v).padStart(2, "0"); };
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" +
    p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

function registerRecordIpc() {
  // 面板 -> 主进程 -> 覆盖层。覆盖层没起来时如实报错，面板会显示出来
  ipcMain.handle("record:cmd", (_e, cmd) => {
    if (!win || win.isDestroyed()) return { ok: false, error: "覆盖层没在运行" };
    win.webContents.send("record:cmd", { cmd: cmd });
    return { ok: true };
  });

  // 覆盖层 -> 主进程 -> 面板：只转发条数与时长，不带样本
  ipcMain.on("record:status", (_e, st) => {
    const now = !!(st && st.recording);
    // 托盘那一项的文字要跟着变（"开始记录" / "停止记录"），否则从托盘看不出在不在录
    if (now !== recording) {
      recording = now;
      rebuildTrayMenu();
    }
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send("record:status", st);
    }
  });

  // 覆盖层 -> 主进程：落盘。渲染层没有 fs 权限，所以必须绕这一圈
  ipcMain.handle("record:save", async (_e, data) => {
    try {
      const text = serializeRecord(data || {});
      const file = path.join(recordsDir(), "record-" + stampName(data && data.startedAt) + ".json");
      await fs.promises.writeFile(file, text, "utf8");
      const bytes = Buffer.byteLength(text);
      const res = {
        ok: true,
        path: file,
        bytes: bytes,
        samples: (data && Array.isArray(data.samples)) ? data.samples.length : 0
      };
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send("record:saved", res);
      }
      console.log("[晴天娃娃] 诊断记录已保存：" + file + "（" + res.samples + " 条，" + bytes + " 字节）");
      return res;
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      console.error("[晴天娃娃] 保存诊断记录失败：" + msg);
      return { ok: false, error: msg };
    }
  });
}
function registerSettingsIpc() {
  ipcMain.handle("settings:get", () => ({ ok: true, overrides: currentOverrides }));

  // 设置面板要算「挂饰在覆盖层里到底多大」，而 renderer/doll.js 的 dollHeight 走的是
  // cssH * heightRatio（cssH = 覆盖层 innerHeight），不是屏幕高。两者差一个任务栏，
  // 面板若自己拿 window.screen.height 去算，读数就跟线上差几像素到几十像素。
  // 第 22 轮 m09043：这就是「坐标位置与实际挂钩位置存在偏移」的真因。
  ipcMain.handle("settings:viewport", () => {
    // 【第 37 轮 m12496 修】这里原来读 win.getContentBounds()，但 win 是覆盖层窗口，
    // 而 settings:viewport 这个名字容易被理解成"设置窗口的视口"——
    // 实测设置窗口是 620x800（content 763），覆盖层是全屏 864，
    // 两边取到的高度差 101px，面板算出来的 dollPx 就会比线上小 13%，
    // 于是"挂点↔质点"的距离换算出来的模拟段长度整条偏短。
    // 正确来源是显示器 bounds —— 与 createWindow() 里铺满主屏用的是同一个值。
    try {
      const d = screen.getPrimaryDisplay();
      return { ok: true, width: d.bounds.width, height: d.bounds.height };
    } catch (err) {
      return { ok: false, width: 0, height: 0 };
    }
  });

  ipcMain.handle("settings:set", (_e, values) => {
    // 清洗放在主进程：面板只能产生合法值，但 settings.json 是可以手改的，
    // 一个 NaN 就足以让整条 Verlet 链变 NaN。范围与步长定义在 settings-schema.js。
    const clean = settingsSchema.sanitize(values);
    currentOverrides = clean;
    settingsStore.set(clean);
    broadcastOverrides();
    return { ok: true, overrides: clean };
  });

  ipcMain.handle("settings:close", () => {
    closeSettings();
    return { ok: true };
  });

  // 本地图片导入：JPG/PNG。路径经 settings:set 持久化，dataUrl 只给面板画缩略图。
  ipcMain.handle("settings:pick-image", async () => {
    const parent = (settingsWin && !settingsWin.isDestroyed()) ? settingsWin : undefined;
    const res = await dialog.showOpenDialog(parent, {
      title: "选择挂饰图片",
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png"] }],
      properties: ["openFile"]
    });
    if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    try {
      const ext = path.extname(file).toLowerCase();
      const mime = (ext === ".png") ? "image/png" : "image/jpeg";
      const dataUrl = "data:" + mime + ";base64," + fs.readFileSync(file).toString("base64");
      // 复制进项目 assets/dangles/（第 18 轮，m05728：图片要保存在项目里，不能只存外部绝对路径）
      const dir = danglesDir();
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      const dest = path.join(dir, "dangle-" + stamp + ext);
      fs.copyFileSync(file, dest);
      return { ok: true, path: dest, dataUrl };
    } catch (err) {
      return { ok: false, error: (err && err.message) ? err.message : String(err) };
    }
  });

  // 读一张挂饰图片给设置面板画缩略图（第 22 轮）。护栏与 delete-dangle 完全相同：
  // 只放行 danglesDir 内的文件，且必须真的是文件 —— 防止把任意磁盘路径读成 dataUrl。
  // 返回的 w/h 是面板自己判断"缩略图上哪个像素对应图片哪个点"用的，
  // 所以主进程不猜尺寸，只老实传回字节。
  ipcMain.handle("settings:read-image", (_e, payload) => {
    try {
      const p = payload && typeof payload.path === "string" ? payload.path : "";
      if (!p) return { ok: false, error: "缺少路径" };
      const dir = danglesDir();
      const resolved = path.resolve(p);
      if (path.dirname(resolved).toLowerCase() !== path.resolve(dir).toLowerCase()) {
        return { ok: false, error: "只能读取挂饰库内的文件" };
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { ok: false, error: "文件不存在" };
      }
      const ext = path.extname(resolved).toLowerCase();
      const mime = (ext === ".png") ? "image/png" : "image/jpeg";
      const dataUrl = "data:" + mime + ";base64," + fs.readFileSync(resolved).toString("base64");
      return { ok: true, dataUrl };
    } catch (err) {
      return { ok: false, error: (err && err.message) ? err.message : String(err) };
    }
  });

  // 删除挂饰库文件（第 19 轮）：只允许删 danglesDir 里的文件，防任意路径删除
  ipcMain.handle("settings:delete-dangle", (_e, payload) => {
    try {
      const p = payload && typeof payload.path === "string" ? payload.path : "";
      if (!p) return { ok: false, error: "缺少路径" };
      const dir = danglesDir();
      const resolved = path.resolve(p);
      if (path.dirname(resolved).toLowerCase() !== path.resolve(dir).toLowerCase()) {
        return { ok: false, error: "只能删除挂饰库内的文件" };
      }
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) ? err.message : String(err) };
    }
  });
}

// ---------- 启动 ----------
function boot() {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      win.showInactive();
      fillPrimaryScreen();
      win.setAlwaysOnTop(true, "screen-saver");
    }
  });

  app.whenReady().then(() => {
    // 用户设置存在 userData 下（%APPDATA%/sunny-doll/settings.json），
    // 和程序目录分开 —— 升级 / 换目录都不丢，也不污染 config.js 这份"出厂默认值"
    currentOverrides = settingsStore.init(app.getPath("userData"));
    registerSettingsIpc();    registerRecordIpc();


    createWindow();
    createTray();

    const ok = globalShortcut.register(QUIT_SHORTCUT, () => app.quit());
    if (!ok) console.warn("[晴天娃娃] 全局快捷键注册失败，请用托盘菜单退出");
    globalShortcut.register("Control+Alt+S", toggleSettings);

    ipcMain.handle("reload-config", () => ({ ok: true }));

    // 分辨率 / 主屏切换时重新铺满
    screen.on("display-metrics-changed", fillPrimaryScreen);
    screen.on("display-added", fillPrimaryScreen);
    screen.on("display-removed", fillPrimaryScreen);
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopCursorPolling();
    settingsStore.flush();        // 拖滑块有 250ms 防抖，退出前必须落盘
  });

  // 覆盖层 + 设置面板都关掉才退出。单关设置面板不应结束整个程序。
  app.on("window-all-closed", () => app.quit());
}
