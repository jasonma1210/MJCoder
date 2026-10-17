// T2-1：项目与工作区域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：目录/文件选择对话框 / 本地项目工作区（~/Documents/.MJCoder）/ 项目探测 /
//       Git Worktree 隔离工作区 / DiffReview 磁盘快照（撤销出口）/ 粘贴文件落盘。
//
// 依赖注入：initProjectIpc({ getMainWindow, runGit })
//   - dialog 以主窗口为 parent，mainWindow 归属 main.js；
//   - runGit 来自工具执行层（main/tools/exec.js），保持同一实现。
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const workspace = require('../workspace');
const worktree = require('../worktree');
const guard = require('./payloadGuard');

// X14：粘贴落盘的单文件上限（base64 字符数 ≈ 文件字节数 ×4/3）。无路径附件（粘贴图片等）
// 只能走 IPC 传全文，不设上限等于让一次 IPC 把关不严的内存放大到渲染层与主进程两侧。
const MAX_UPLOAD_BASE64 = 128 * 1024 * 1024;

let deps = null;

// ── 项目探测（git 分支/远端/文件数/技术栈标记）──
const LANG_MARKERS = {
  'package.json': 'Node.js', 'Cargo.toml': 'Rust', 'pom.xml': 'Java', 'build.gradle': 'Java',
  'go.mod': 'Go', 'requirements.txt': 'Python', 'pyproject.toml': 'Python', 'Gemfile': 'Ruby',
};

// ── A2：DiffReview 放弃修改前的磁盘快照（撤销出口）──
// 快照落 userData/backup/<snapshotId>/，保持相对路径结构；不写入用户项目目录
const backupRoot = () => path.join(app.getPath('userData'), 'backup');

function register() {
  // ── 目录选择 / 文件选择对话框 ──
  ipcMain.handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog(deps.getMainWindow(), { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || r.filePaths.length === 0) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(deps.getMainWindow(), { properties: ['openFile', 'multiSelections'] });
    if (r.canceled || r.filePaths.length === 0) return { ok: false };
    return { ok: true, paths: r.filePaths };
  });

  // ── 本地项目工作区（~/Documents/.MJCoder，隐藏目录；项目目录按 日期+随机数 创建）──
  ipcMain.handle('project:workspaceInfo', async () => {
    try {
      const { root, created } = await workspace.ensureWorkspaceRoot(
        app.getPath('documents'), app.getPath('home'),
      );
      return { ok: true, root, created };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('project:create', async (_, { name } = {}) => {
    try {
      // X14：name 参与创建 ~/Documents/.MJCoder 下的项目目录——允许缺省（自动命名），
      // 但类型与长度必须守（工作区层会按它拼路径）
      guard.assertStrings({ name }, { name: { max: 120, optional: true, allowEmpty: true } });
      const proj = await workspace.createProject({
        docsDir: app.getPath('documents'), homeDir: app.getPath('home'), name,
      });
      return { ok: true, ...proj };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('tool:probeProject', async (_, { path: p }) => {
    const proj = { path: p, name: path.basename(p || ''), branch: '', remote: '', fileCount: 0, languages: [] };
    if (!p) return proj;
    try {
      const branch = await deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], p);
      if (!branch.error && branch.stdout.trim()) proj.branch = branch.stdout.trim();
      const remote = await deps.runGit(['remote', 'get-url', 'origin'], p);
      if (!remote.error && remote.stdout.trim()) proj.remote = remote.stdout.trim();
      const entries = await fsp.readdir(p, { withFileTypes: true });
      proj.fileCount = entries.filter(e => e.isFile()).length;
      proj.languages = Object.keys(LANG_MARKERS).filter(m => entries.some(e => e.name === m)).map(m => LANG_MARKERS[m]);
    } catch (e) {
      console.warn('[probe] 项目探测失败:', p, e.message);
    }
    return proj;
  });

  // ── Git Worktree 隔离工作区（对标 Codex Worktree 模式）──
  ipcMain.handle('worktree:create', async (_, { path: projectPath, taskTitle } = {}) => {
    try {
      // X14：projectPath 会作为 git worktree add 的仓库根、taskTitle 进新分支名——
      // 路径允许空格（assertStrings 而非 assertTokens），类型与长度在边界守
      guard.assertStrings(
        { path: projectPath, taskTitle },
        { path: 4096, taskTitle: { max: 200, optional: true, allowEmpty: true } },
      );
      return { ok: true, ...(await worktree.createWorktree(projectPath, taskTitle)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('worktree:list', async (_, { path: projectPath }) => {
    try {
      const root = await worktree.repoRoot(projectPath);
      if (!root) return { ok: true, list: [], isRepo: false };
      return { ok: true, isRepo: true, list: await worktree.listWorktrees(root, root) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('worktree:promote', async (_, { path: worktreePath }) => {
    try {
      return { ok: true, ...(await worktree.promoteToBranch(worktreePath)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('worktree:sync', async (_, { path: worktreePath }) => {
    try {
      return { ok: true, ...(await worktree.syncToLocal(worktreePath)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('worktree:remove', async (_, { path: worktreePath } = {}) => {
    try {
      // X14：移除 worktree 会删目录——路径形状在边界守，是否真的是本仓库的 worktree
      // 仍由 worktree.removeWorktree 判（业务语义）
      guard.assertStrings({ path: worktreePath }, { path: 4096 });
      return { ok: true, ...(await worktree.removeWorktree(worktreePath)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('backup:create', async (_, { cwd, files } = {}) => {
    try {
      // X14：cwd/files 决定把哪些文件复制进快照目录——files 既有「单文件字符串」也有「批量数组」
      // 两种调用形态，别的一律拒绝；批量上限防一次 IPC 触发上万次 copyFile
      guard.assertStrings({ cwd }, { cwd: 4096 });
      if (files !== undefined && files !== null && typeof files !== 'string' && !Array.isArray(files)) {
        throw new Error('files 必须是字符串或数组');
      }
      if (Array.isArray(files)) guard.assertArray({ files }, 'files', { max: 5000 });
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
      if (!cwd || list.length === 0) return { ok: false, error: '缺少项目目录或文件列表' };
      const snapshotId = `snap-${Date.now()}`;
      const dir = path.join(backupRoot(), snapshotId);
      let snapshotted = 0;
      for (const rel of list) {
        const abs = path.join(cwd, rel);
        try {
          const stat = await fsp.stat(abs);
          if (!stat.isFile()) continue;
          const dest = path.join(dir, rel);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(abs, dest);
          snapshotted += 1;
        } catch (e) {
          // 单文件快照失败不阻断（如新建未保存文件），放弃操作本身仍继续
          console.warn(`[backup] 跳过 ${rel}:`, e.message);
        }
      }
      await fsp.writeFile(path.join(dir, '.meta.json'), JSON.stringify({ cwd, files: list, createdAt: Date.now() }));
      return { ok: true, snapshotId, dir, count: snapshotted };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('backup:restore', async (_, { snapshotId } = {}) => {
    try {
      // X14：snapshotId 拼成快照目录路径（下方另有字符白名单净化）——边界先守类型与长度
      guard.assertStrings({ snapshotId }, { snapshotId: 100 });
      const dir = path.join(backupRoot(), String(snapshotId).replace(/[^a-zA-Z0-9-]/g, ''));
      const meta = JSON.parse(await fsp.readFile(path.join(dir, '.meta.json'), 'utf8'));
      let restored = 0;
      for (const rel of meta.files) {
        const src = path.join(dir, rel);
        try {
          const dest = path.join(meta.cwd, rel);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(src, dest);
          restored += 1;
        } catch (e) {
          console.warn(`[backup] 恢复跳过 ${rel}:`, e.message);
        }
      }
      return { ok: true, restored };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // A12：粘贴/无路径文件落盘（渲染层 ArrayBuffer → userData/uploads）
  ipcMain.handle('files:saveUpload', async (_, { name, dataBase64 } = {}) => {
    try {
      // X14：落盘前先守形状与体积上限（无路径附件只能整段走 IPC，历史上没有上限）
      guard.assertStrings(
        { name, dataBase64 },
        { name: { max: 200, optional: true, allowEmpty: true }, dataBase64: MAX_UPLOAD_BASE64 },
      );
      const dir = path.join(app.getPath('userData'), 'uploads');
      await fsp.mkdir(dir, { recursive: true });
      const safeName = String(name || 'file').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
      const dest = path.join(dir, `${Date.now()}-${safeName}`);
      await fsp.writeFile(dest, Buffer.from(String(dataBase64 || ''), 'base64'));
      return { ok: true, path: dest };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function initProjectIpc(d) {
  deps = d;
  register();
}

module.exports = { initProjectIpc };
