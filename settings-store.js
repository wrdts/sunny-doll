// settings-store.js  --  用户设置（设置面板里调的那些）的持久化。
//
// 为什么单独存一个文件，而不是直接改 renderer/config.js：
//   1) config.js 是"出厂默认值"，是代码，应该能被 git 管理、被 rope.test.cjs 和
//      verify.cjs 当基线读。用户的手动调参不该混进去。
//   2) 打包后（asar）config.js 是只读的，根本写不进去。
//   3) 用户点"恢复默认"只要清空这个文件即可，不用回滚代码。
//
// 存的位置是 Electron 的 userData 目录（Windows 上是
// %APPDATA%/sunny-doll/settings.json），跟程序目录分开，升级不丢。
"use strict";

const fs = require("fs");
const path = require("path");

let filePath = null;
let data = {};
let saveTimer = null;

const SAVE_DEBOUNCE_MS = 250;

function init(userDataDir) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch (_) {
    // 目录建不出来也不致命，后面写文件时会报错并打日志
  }
  filePath = path.join(userDataDir, "settings.json");
  return load();
}

/** 从磁盘读。文件不存在 / 内容坏了都退回空对象（= 全部用 config.js 默认值） */
function load() {
  data = {};
  if (!filePath) return data;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) data = obj;
  } catch (_) {
    data = {};
  }
  return data;
}

function get() {
  return data;
}

function writeNow() {
  if (!filePath) return false;
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    return true;
  } catch (err) {
    console.error("[晴天娃娃] 保存设置失败：", err && err.message);
    return false;
  }
}

/**
 * 整体替换覆盖值。拖滑块时会被高频调用，所以磁盘写入做 250ms 防抖，
 * 内存里的 data 是立刻更新的（覆盖层靠广播拿最新值，不读文件）。
 */
function set(obj) {
  data = (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, SAVE_DEBOUNCE_MS);
  return data;
}

/** 把防抖中还没落盘的内容立刻写掉。退出前必须调，否则最后几下拖动会丢。 */
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return writeNow();
}

/** 恢复默认 = 清空覆盖值 */
function clear() {
  return set({});
}

function getPath() {
  return filePath;
}

module.exports = { init, load, get, set, flush, clear, getPath };