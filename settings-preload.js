// settings-preload.js  --  设置面板专用的 preload。
//
// 单独一个文件（而不是和覆盖层的 preload.js 合并）是因为安全边界不同：
// 覆盖层是鼠标穿透的纯展示窗口，面板是用户真的会点、会拖的普通窗口。
// 面板不需要知道任何物理状态，只需要"读当前覆盖值 / 写覆盖值 / 关自己"。
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settingsApi", {
  /** 拉当前生效的覆盖值（嵌套形状，只含被改过的字段） */
  get() {
    return ipcRenderer.invoke("settings:get");
  },

  /** 提交整份覆盖值。传 {} = 恢复出厂默认。主进程会做范围清洗。 */
  set(values) {
    return ipcRenderer.invoke("settings:set", values);
  },

  /** 覆盖值被别处改过（比如托盘菜单套用了预设）时主进程会广播 */
  onChanged(cb) {
    ipcRenderer.on("settings:changed", (_e, payload) => cb(payload));
  },

  close() {
    return ipcRenderer.invoke("settings:close");
  },

  /** 弹系统文件选择框挑一张本地图片，返回 { ok, path, dataUrl }（dataUrl 仅供缩略图） */
  pickImage() {
    return ipcRenderer.invoke("settings:pick-image");
  },

  /** 删除挂饰库文件（主进程只放行 assets/dangles 目录内的路径） */
  deleteDangle(p) {
    return ipcRenderer.invoke("settings:delete-dangle", p);
  },

  /** 让覆盖层开始 / 停止记录。cmd = "start" | "stop" */
  record(cmd) {
    return ipcRenderer.invoke("record:cmd", cmd);
  },
  /** 记录状态（每 0.5s 一次）与被转存的文件路径 */
  onRecord(cb) {
    ipcRenderer.on("record:status", (_e, st) => cb(st));
  },
  onRecordSaved(cb) {
    ipcRenderer.on("record:saved", (_e, res) => cb(res));
  }
});