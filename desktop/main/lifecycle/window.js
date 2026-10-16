// T2-1：窗口生命周期域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：窗口状态持久化（bounds 记忆）/ 主窗口创建（dev 走 vite、打包走 file://）/
//       打包版 console tee 到 userData/logs。
//
// 依赖注入：mainWindow 归属 main.js（whenReady 接线与各域广播都要用），
// 经 getMainWindow/setMainWindow 读写；本模块负责创建与状态落盘。
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

let getMainWindow = () => null;
let setMainWindow = () => {};

function init(deps) {
  getMainWindow = deps.getMainWindow;
  setMainWindow = deps.setMainWindow;
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
  } catch (e) {
    return null; // 首次启动或文件损坏时回落默认值
  }
}

function saveWindowState() {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;
  try {
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(mainWindow.getBounds()));
  } catch (e) {
    console.warn('[window] 状态保存失败:', e.message);
  }
}

function createWindow() {
  const state = loadWindowState();
  const mainWindow = new BrowserWindow({
    width: state?.width || 1600,
    height: state?.height || 1000,
    x: state?.x,
    y: state?.y,
    minWidth: 1200, minHeight: 700,
    title: 'MJ Coder', backgroundColor: '#0d0d0d', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  setMainWindow(mainWindow);
  // 生产构建走 file:// 加载打包产物；开发走 vite dev server
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL('http://localhost:5173');
    if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.on('close', saveWindowState);
}

// 打包版诊断日志：console 全量 tee 到 userData/logs/main-YYYYMMDD.log。
// 背景：连续三起打包版问题（SIGSEGV/凭证加密/运行中停止）都因「主进程日志不可见」只能靠猜。
// dev 模式终端可见，不 tee（避免双写）；打包版启用。崩溃类另有 uncaughtException → crash.log。
function setupFileLogging() {
  if (!app.isPackaged) return;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`);
    const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    const tee = (level) => (...args) => {
      orig[level](...args);
      try {
        const body = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${body.slice(0, 4000)}\n`);
      } catch { /* 日志落盘失败不影响主流程 */ }
    };
    console.log = tee('log');
    console.warn = tee('warn');
    console.error = tee('error');
  } catch (e) {
    console.warn('[logging] 文件日志初始化失败:', e.message);
  }
}

module.exports = { init, loadWindowState, saveWindowState, createWindow, setupFileLogging };
