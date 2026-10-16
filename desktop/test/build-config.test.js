// 打包配置守卫（2026-10-15）
//
// 背景：本地「先打包再跑测试」会整片红——
//   electron-builder 启动时 @electron/rebuild 把 better-sqlite3 重编成 **Electron ABI**，
//   之后 `npm test` 里所有用真实 better-sqlite3 的套件（taskStore/workerPool/sqljsDb/
//   sqlite-electron-probe）直接 ERR_DLOPEN_FAILED。
//   开发版复现不了（dev 走的是 Node ABI），CI 也复现不了（测试 job 与发布 job 各自
//   全新 npm ci，互不影响），所以只有本地连续操作时才暴露。
//
// 结论（依据 main/db/index.js 的驱动选择）：
//   打包版 openDbAsync(isPackaged=true) **一律 sql.js(WASM)，不加载任何原生模块**
//   （真机事故：原生模块在主进程 NAPI 注册时 SIGSEGV，无法用子进程金丝雀兜底）；
//   better-sqlite3 只是 optionalDependencies，仅服务 dev 与测试。
//   → 打包期没有任何原生模块需要重编，`npmRebuild: false` 是正解，
//     既保住本地测试基线，也省掉每次构建的原生编译时间。
//
// 本测试的作用是**防止这个结论被悄悄推翻**：若将来有人给运行时依赖引入真正的原生模块，
// 必须显式处理（re-enable rebuild 或改用 WASM 替代），此测试会失败并说明原因。
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// ── 1. 打包期不得重编原生模块 ──
check('build.npmRebuild = false（保住本地 npm test 基线 + 省掉原生编译）',
  pkg.build.npmRebuild === false, String(pkg.build.npmRebuild));

// ── 2. 前置条件：运行时依赖里确实没有原生模块（结论的前提，一旦变化本测试要失败）──
// 原生模块的判定：包内带 .node 预编译产物或依赖 node-gyp。逐一核对已知原生包名单。
const KNOWN_NATIVE = ['better-sqlite3', 'sqlite3', 'keytar', 'node-sass', 'sharp', 'canvas', 'bcrypt', 'grpc', 'cpu-features'];
const runtimeDeps = Object.keys(pkg.dependencies || {});
const nativeInRuntime = runtimeDeps.filter((d) => KNOWN_NATIVE.includes(d));
check('运行时依赖不含原生模块（npmRebuild:false 的前提成立）',
  nativeInRuntime.length === 0, nativeInRuntime.join(',') || `deps=${runtimeDeps.join(',')}`);
check('better-sqlite3 仍是 optionalDependencies（没装也能跑这一保证不被破坏）',
  !!(pkg.optionalDependencies && pkg.optionalDependencies['better-sqlite3']),
  JSON.stringify(pkg.optionalDependencies || {}));
check('better-sqlite3 不在运行时 dependencies（否则 packaged 也会尝试加载原生模块）',
  !(pkg.dependencies || {})['better-sqlite3']);

// ── 3. packaged 必须走 sql.js(WASM)：配置层与代码层双向确认 ──
check('asarUnpack 仍解包 sql.js 的 WASM（打包版唯一 DB 引擎必须可加载）',
  Array.isArray(pkg.build.asarUnpack) && pkg.build.asarUnpack.some((p) => /sql-wasm\.wasm/.test(p)),
  JSON.stringify(pkg.build.asarUnpack));
const dbSrc = fs.readFileSync(path.join(root, 'main', 'db', 'index.js'), 'utf8');
check('代码层：packaged 一律 sql.js、不加载原生模块（与 npmRebuild:false 一致）',
  /isPackaged/.test(dbSrc) && /打包版一律 sql\.js/.test(dbSrc));
check('代码层：MJ_DB_DRIVER 仍可强制指定驱动（排障逃生口未被拆掉）',
  /MJ_DB_DRIVER/.test(dbSrc));

// ── 4. 发布目标必须与真实仓库一致（曾因写成 MJCode 导致自动更新 404）──
check('publish.owner/repo 指向真实仓库 jasonma1210/MJCoder',
  pkg.build?.publish?.owner === 'jasonma1210' && pkg.build?.publish?.repo === 'MJCoder',
  `${pkg.build?.publish?.owner}/${pkg.build?.publish?.repo}`);

// ── 5. 打包链本身未被顺手改坏 ──
check('build 脚本 = renderer 构建 + electron-builder', /build --prefix renderer && electron-builder/.test(pkg.scripts.build || ''));
check('三平台产物配置齐全（dmg / nsis / AppImage）',
  pkg.build?.mac?.target === 'dmg' && pkg.build?.win?.target === 'nsis' && pkg.build?.linux?.target === 'AppImage');
check('ecosystem 目录随包分发（连接器/数字员工目录依赖）',
  Array.isArray(pkg.build?.extraResources) && pkg.build.extraResources.some((r) => /ecosystem/.test(r.from || '')));
check('files 白名单含 main/agent-core/renderer.dist（三者缺一即白屏或无引擎）',
  ['main/**/*', 'agent-core/**/*', 'renderer/dist/**/*'].every((f) => pkg.build.files.includes(f)));
// A1/B1 门禁：shared/ 是跨宿主共享逻辑（不可信内容管道、沙箱说明）；shared-ipc/ 是 IPC 契约。
// 二者任一缺失都会让打包版**静默**失去安全能力（检测规则加载失败 → 拒绝启动运行），
// 因此在打包配置层钉住，避免「改 files 白名单时顺手删掉」。
check('files 白名单含 shared/（不可信内容管道与沙箱说明依赖，缺失会导致运行时拒绝启动）',
  pkg.build.files.includes('shared/**/*'));
check('files 白名单含 shared-ipc/（IPC 契约依赖）',
  pkg.build.files.includes('shared-ipc/**/*'));

// ── 6. 打包期不静默破坏测试链：测试脚本不得依赖打包产物 ──
check('npm test 不依赖 release/ 产物（保证本地任意顺序下测试基线一致）',
  !/release\/|\.dmg/.test(pkg.scripts.test || ''));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);