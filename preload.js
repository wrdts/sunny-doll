// preload.js  --  渲染层与主进程之间唯一的受控通道。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  /** 主进程推来的指针坐标（物理像素/屏幕坐标 → 已换算为窗口 CSS 像素） */
  onCursor(cb) {
    ipcRenderer.on("cursor", (_e, p) => cb(p));
  },
  /** 托盘菜单"重载配置" */
  onReloadConfig(cb) {
    ipcRenderer.on("reload-config", () => cb());
  },
  /** 请求主进程重新读取 config.js（实际由渲染层自己重新执行脚本，这里只用于确认） */
  reloadConfig() {
    return ipcRenderer.invoke("reload-config");
  },
  /**
   * 用户设置（设置面板里调的那些值）下发。
   * 覆盖值只含"被改过的字段"，形状是嵌套的 { physics: { gravity: 1800 } }，
   * 渲染层用 deepAssign 盖到 window.CONFIG 上，所以没改的字段仍是 config.js 的出厂值。
   * 首次加载完成后主进程会主动推一次（见 main.js 的 did-finish-load）。
   */
  onSettings(cb) {
    ipcRenderer.on("settings:apply", (_e, payload) => cb(payload));
  },
  /** 托盘"显示/隐藏"时同步状态 */
  onVisibility(cb) {
    ipcRenderer.on("visibility", (_e, visible) => cb(visible));
  },
  /** 指针轮询是否在兜底（调试用） */
  onCursorSource(cb) {
    ipcRenderer.on("cursor-source", (_e, src) => cb(src));
  },

  /** 设置面板按下「开始记录 / 停止记录」时，主进程转发过来的命令 */
  onRecordCmd(cb) {
    ipcRenderer.on("record:cmd", (_e, msg) => cb(msg));
  },
  /** 记录中的状态（条数 / 已录时长），主进程转给设置面板显示 */
  sendRecordStatus(st) {
    ipcRenderer.send("record:status", st);
  },
  /** 停止后把完整数据交给主进程落盘，返回 { ok, path, bytes, samples } */
  saveRecord(data) {
    return ipcRenderer.invoke("record:save", data);
  }
});