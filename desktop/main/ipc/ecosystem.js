// T2-1：生态与杂项 IPC 域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：功能开关查询 / 本机数据目录 / 版本号 / 协同（P4/P5 Yjs 本地快照，featureFlags 门控）/
//       SKILL.md 兼容层安装导入 / IDE 跳转 / 生态资产目录（M7）/ 网络配置（web_search 提供方）。
//
// 依赖注入：initEcosystemIpc({ getLocalStore, featureFlags, audit, getSkillsDir })
//   - localStore 在 whenReady 后初始化，经 getter；
//   - SKILLS_DIR 归属技能域（main.js），经 getter 注入；
//   - audit 经注入保持同源实现（审计域单点）。
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { LocalCollab, makeDocId } = require('../collab');
const skillCompat = require('../skillCompat');
const ideLib = require('../ide');
const ecosystemLib = require('../ecosystem');
const searchProviders = require('../webSearchProviders');
const guard = require('./payloadGuard');

const COLLAB_DIR = () => path.join(app.getPath('home'), '.mjcode', 'collab');
const ECOSYSTEM_DIR = () => path.join(app.getPath('userData'), 'ecosystem');

let deps = null;
let localCollab = null;
const getLocalCollab = () => {
  if (!localCollab) localCollab = new LocalCollab(COLLAB_DIR());
  return localCollab;
};

// 生态目录候选：userData/ecosystem（打包/用户目录）优先，回落仓库根 ecosystem/（开发模式）
function ecosystemDirCandidates() {
  const candidates = [ECOSYSTEM_DIR(), path.join(app.getAppPath(), '..', 'ecosystem')];
  return candidates.filter((d) => fs.existsSync(path.join(d, 'skills.json')));
}

// 读路径统一解析：userData 无资产时回落仓库根 ecosystem/（开发模式）
// 事故根因：四个读 IPC 只读 userData/ecosystem，而打包前该目录不存在 →
// 生态中心/PlusMenu 的数字员工、技能、连接器全部空载（数据本身 50/100/100 完好）
function resolveEcosystemDir() {
  const dirs = ecosystemDirCandidates();
  return dirs[0] || ECOSYSTEM_DIR();
}

function register() {
  // 功能开关查询（渲染层据此隐藏入口）
  ipcMain.handle('app:flags', async () => ({ ok: true, flags: deps.featureFlags }));

  // 本机数据目录（状态条展示「数据保存在本机」的真实证据）
  ipcMain.handle('app:userDataPath', async () => ({ ok: true, path: app.getPath('userData') }));
  // 版本号动态下发（Sidebar 此前硬编码 v1.0.0，发版后永远显示旧版本）
  ipcMain.handle('app:version', async () => app.getVersion());

  if (deps.featureFlags.collab) {
    ipcMain.handle('collab:open', async (_, { docId } = {}) => {
      try {
        // X14：docId 决定落盘快照文件名（~/.mjcode/collab/<docId>.ydoc），非字符串会变成
        // "[object Object].ydoc" 这种孤儿文件；允许缺省（旧调用方），但类型与长度必须守
        guard.assertStrings({ docId }, { docId: { max: 200, optional: true, allowEmpty: true } });
        const lc = getLocalCollab();
        lc.open(String(docId || ''));
        return { ok: true, docId };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('collab:docId', async (_, { type, entityId } = {}) => ({ docId: makeDocId(type, entityId) }));

    ipcMain.handle('collab:persist', async (_, { docId } = {}) => {
      try {
        return getLocalCollab().persist(String(docId || ''));
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 推给服务端的增量：传服务端已确认的 stateVector（base64），缺省推全量
    ipcMain.handle('collab:encodePush', async (_, { docId, stateVector } = {}) => {
      try {
        return { ok: true, update: getLocalCollab().encodePush(String(docId || ''), stateVector) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('collab:applyUpdate', async (_, { docId, update } = {}) => {
      try {
        // X14：update 是服务端下发的 Yjs 增量（base64），直接 base64 解码后合并进本地文档——
        // 非字符串会在 Buffer.from 里静默变成垃圾，长度失控则一次 IPC 撑爆内存
        guard.assertStrings(
          { docId, update },
          { docId: { max: 200, optional: true, allowEmpty: true }, update: { max: 8 * 1024 * 1024, optional: true, allowEmpty: true } },
        );
        return { ok: true, ...getLocalCollab().applyServerUpdate(String(docId || ''), update) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('collab:listLocal', async () => ({ ok: true, docs: getLocalCollab().listLocalDocs() }));
    ipcMain.handle('collab:closeAll', async () => { getLocalCollab().closeAll(); return { ok: true }; });
  } else {
    console.log('[features] 协同模块已冻结（默认）。如需恢复设置 MJCODE_FEATURES=\'{"collab":true}\'');
  }

  // ── SKILL.md 兼容层 IPC（生态互通：生态目录安装 + 外部技能仓库导入）──
  ipcMain.handle('skills:installEcosystem', async (_, { id } = {}) => {
    try {
      // X14：id 用于在生态目录里查找并复制技能目录——非字符串会一路穿到路径拼接
      guard.assertStrings({ id }, { id: 200 });
      const dirs = ecosystemDirCandidates();
      if (dirs.length === 0) return { ok: false, error: '未找到生态技能目录（skills.json）' };
      const r = skillCompat.installCatalogSkill(dirs, deps.getSkillsDir(), id);
      if (r.ok) deps.audit('skill_install', r.name || id, `dir=${r.dir}`);
      return r;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skills:importFromDir', async (_, { dir } = {}) => {
    try {
      // X14：dir 是「从这个目录批量导入技能」的根——直接扫目录并复制进 skills 目录，
      // 路径含空格是常态（用 assertStrings 而非 assertTokens），但类型与非空必须守
      guard.assertStrings({ dir }, { dir: 1024 });
      const scan = skillCompat.importSkillsFromDir(dir);
      if (!scan.ok) return scan;
      const installed = [];
      const failed = [];
      for (const entry of scan.skills) {
        const r = skillCompat.installSkillToDir(deps.getSkillsDir(), entry, { overwrite: true });
        if (r.ok) installed.push({ dir: r.dir, name: r.name });
        else failed.push({ name: entry.name, error: r.error });
      }
      if (installed.length) deps.audit('skill_import', dir, `installed=${installed.length}`);
      return { ok: true, found: scan.skills.length, installed, failed };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IDE 跳转（代码视图一键跳转既有编辑器）──
  ipcMain.handle('app:openInIDE', async (_, { path: p } = {}) => {
    try {
      // X14：路径会作为 argv 交给编辑器进程——既有的存在性/类型检查保留，边界再补类型与长度上限
      guard.assertStrings({ path: p }, { path: 2048 });
      if (!p || typeof p !== 'string') return { ok: false, error: '缺少文件路径' };
      if (p.includes('..') && !path.isAbsolute(p)) return { ok: false, error: '非法路径' };
      const platform = process.platform;
      const candidates = ideLib.IDE_CANDIDATES[platform] || ideLib.IDE_CANDIDATES.linux;
      const whichCmd = platform === 'win32' ? 'where' : 'which';
      const available = await Promise.all(candidates.map((cmd) =>
        new Promise((resolve) => {
          execFile(whichCmd, [cmd], (err) => resolve(err ? null : cmd));
        })
      )).then((list) => list.filter(Boolean));
      const picked = ideLib.pickIde(platform, available);
      const args = [...(picked.args || []), p];
      const child = spawn(picked.cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      deps.audit('open_in_ide', p, `ide=${picked.ide}`);
      return { ok: true, ide: picked.ide, cmd: picked.cmd };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 生态资产目录（M7）：50 数字员工 / 100 MCP 连接器 / 100 Skill ──
  ipcMain.handle('ecosystem:summary', async () => {
    try {
      const all = ecosystemLib.loadEcosystem(resolveEcosystemDir());
      return { ok: true, stats: all.stats };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('ecosystem:employees', async (_, { category } = {}) => {
    try {
      let list = ecosystemLib.loadDigitalEmployees(resolveEcosystemDir());
      if (category) list = list.filter((e) => e.category === category);
      return { ok: true, employees: list };
    } catch (err) {
      return { ok: false, error: err.message, employees: [] };
    }
  });

  ipcMain.handle('ecosystem:connectors', async (_, { category } = {}) => {
    try {
      let list = ecosystemLib.loadMcpConnectors(resolveEcosystemDir());
      if (category) list = list.filter((c) => c.category === category);
      return { ok: true, connectors: list };
    } catch (err) {
      return { ok: false, error: err.message, connectors: [] };
    }
  });

  ipcMain.handle('ecosystem:skills', async () => {
    try {
      return { ok: true, skills: ecosystemLib.loadSkillCatalog(resolveEcosystemDir()) };
    } catch (err) {
      return { ok: false, error: err.message, skills: [] };
    }
  });

  // ── T4-3：数字员工运行时预设（角色模板 = 系统提示 + 工具子集 + 审批档）──
  // 映射与组装的单一事实来源在 main/ecosystem.js buildEmployeeRuntimePreset（纯函数可单测）
  ipcMain.handle('ecosystem:employeeRuntime', async (_, { id } = {}) => {
    try {
      const list = ecosystemLib.loadDigitalEmployees(resolveEcosystemDir());
      const emp = list.find((e) => e.id === id);
      if (!emp) return { ok: false, error: `数字员工不存在：${String(id || '')}` };
      const rolePreset = ecosystemLib.buildEmployeeRuntimePreset(emp);
      deps.audit('employee_runtime', emp.id, `tools=${rolePreset.toolNames.length} approval=${rolePreset.approvalMode} sandbox=${rolePreset.sandboxPolicy}`);
      return { ok: true, rolePreset };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 网络配置（web_search 提供方）：读写 + 元数据，见 设置 → 网络配置 ──
  // P0-20（2026-10-16）：接入 credentialCrypto 加密搜索 API Key，消除 local-data.json 明文 Key
  ipcMain.handle('websearch:getConfig', async () => ({
    ok: true,
    meta: searchProviders.SEARCH_PROVIDERS,
    config: searchProviders.loadSearchConfig(deps.getLocalStore(), deps.getCredentialCrypto?.()),
  }));
  ipcMain.handle('websearch:setConfig', async (_, { providers } = {}) => {
    try {
      // X14：providers 里带搜索 API Key（加密落库）——非数组会被 saveSearchConfig 静默当成
      // 「清空配置」，那是用户视角的配置丢失；显式缺省（undefined）仍按既有语义处理
      if (providers !== undefined) guard.assertArray({ providers }, 'providers', { max: 50 });
      // Key 属敏感凭证：审计只记启用了哪些提供方，绝不落 Key 本体
      const r = searchProviders.saveSearchConfig(deps.getLocalStore(), providers, deps.getCredentialCrypto?.());
      const enabled = r.providers.filter((p) => p.enabled).map((p) => p.id);
      deps.audit('settings', 'web_search providers', `enabled=${enabled.join(',') || '(none)'}`, 'ok');
      return { ok: true, config: r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function initEcosystemIpc(d) {
  deps = d; // { getLocalStore, featureFlags, audit, getSkillsDir }
  register();
}

module.exports = { initEcosystemIpc };
