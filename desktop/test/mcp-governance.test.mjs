// 期 2（2026-10-18）门禁：MCP 三层治理（auto-start / whitelist / manual）+ profile 分流
//
// 背景：期 1 只做了「预热白名单」这一层。期 2 把服务内在风险属性抽象为三层 tier，
//   并引入两套档位（normal / developer）驱动「启动时自动拉起哪些服务」。
//
// 本套件锁四件事：
//   ① classifyTier 分级：开箱即用 → auto-start；本地无密钥非刚需 → whitelist；带外部密钥/写外部系统 → manual；
//   ② autoStartConfigs 分流：normal 仅 auto-start；developer 额外纳入 git 类；manual 永不自启（架构红线）；
//   ③ readGovernance / normalizeProfile 归一化：非法值一律回落最保守档（fail-closed）；
//   ④ 源码接线门禁：连接落盘打 tier、getConfig 下发 governance、治理 IPC 注册、
//      preload 通道、main.js 注入 getLocalStore、渲染层档位选择器 + 徽章 + i18n 双语 key。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const {
  TIER, PROFILES, classifyTier, autoStartConfigs, normalizeProfile, readGovernance,
  isDeveloperAutoStart, isManualTarget,
} = require(path.join(ROOT, 'main/mcpPrewarm.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① classifyTier：三层分级 ──
{
  const autoStart = [
    { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/x'] },
    { name: 'time', command: 'uvx', args: ['mcp-server-time'] },
    { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] },
  ];
  for (const c of autoStart) check(`auto-start：${c.name}`, classifyTier(c) === TIER.AUTO_START, classifyTier(c));

  const whitelist = [
    { name: 'git', command: 'uvx', args: ['mcp-server-git'] },
    { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] },
    { name: 'desktop-commander', command: 'npx', args: ['-y', '@wonderwhy-er/desktop-commander'] },
    { name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' },
    { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  ];
  for (const c of whitelist) check(`whitelist：${c.name}`, classifyTier(c) === TIER.WHITELIST, classifyTier(c));

  // manual：带外部密钥 / 写入外部系统（云·消息·支付·第三方 API）
  const manual = [
    { name: 'aws', command: 'npx', args: ['-y', 'aws-mcp'] },
    { name: 'slack', command: 'npx', args: ['-y', 'server-slack'] },
    { name: 'stripe', command: 'npx', args: ['-y', 'stripe-mcp'] },
    { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    { name: 'notion', command: 'npx', args: ['-y', 'mcp-server-notion'] },
    { name: 'tavily', command: 'npx', args: ['-y', 'tavily-mcp'] },
  ];
  for (const c of manual) check(`manual：${c.name}`, classifyTier(c) === TIER.MANUAL, classifyTier(c));

  check('未知服务默认回落 whitelist（保守但不误伤）', classifyTier({ name: 'some-local-tool', command: 'node', args: ['x'] }) === TIER.WHITELIST);
  check('空对象安全', classifyTier({}) === TIER.WHITELIST);
  check('null 安全', classifyTier(null) === TIER.WHITELIST);
}

// ── ①b 重命名兜底：按启动包名判 manual，防重命名后误入白名单 ──
{
  check('manual 包名兜底（aws-mcp）', isManualTarget({ name: '我的云', command: 'npx', args: ['-y', 'aws-mcp'] }) === true);
  check('manual 包名兜底 → tier=manual', classifyTier({ name: '我的云', command: 'npx', args: ['-y', 'aws-mcp'] }) === TIER.MANUAL);
  check('git 属开发者自启名单', isDeveloperAutoStart({ name: 'git', command: 'uvx', args: ['mcp-server-git'] }) === true);
  check('git-mcp 属开发者自启名单', isDeveloperAutoStart({ name: 'git-mcp', transport: 'http', url: 'https://gitmcp.io/docs' }) === true);
}

// ── ② autoStartConfigs：profile 分流 + manual 永不自启 ──
{
  const all = [
    { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/x'] },
    { name: 'time', command: 'uvx', args: ['mcp-server-time'] },
    { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] },
    { name: 'git', command: 'uvx', args: ['mcp-server-git'] },
    { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] },
    { name: 'aws', command: 'npx', args: ['-y', 'aws-mcp'] },
    { name: 'slack', command: 'npx', args: ['-y', 'server-slack'] },
  ];
  const normal = autoStartConfigs(all, { profile: PROFILES.NORMAL }).map((c) => c.name);
  check('normal 档 = filesystem/time/fetch', JSON.stringify(normal) === JSON.stringify(['filesystem', 'time', 'fetch']), normal.join(','));

  const dev = autoStartConfigs(all, { profile: PROFILES.DEVELOPER }).map((c) => c.name);
  check('developer 档额外纳入 git', JSON.stringify(dev) === JSON.stringify(['filesystem', 'time', 'fetch', 'git']), dev.join(','));
  check('developer 档不含 playwright（非 git 白名单项）', !dev.includes('playwright'));
  check('manual（aws/slack）永不自动启动', !dev.includes('aws') && !dev.includes('slack'));
  check('缺省 profile 回落 normal', JSON.stringify(autoStartConfigs(all).map((c) => c.name)) === JSON.stringify(normal));
  check('非数组入参安全', autoStartConfigs(null, { profile: 'normal' }).length === 0);
  check('未知 profile 回落 normal', JSON.stringify(autoStartConfigs(all, { profile: 'hacker' }).map((c) => c.name)) === JSON.stringify(normal));
}

// ── ③ readGovernance / normalizeProfile：fail-closed 归一化 ──
{
  check('normalizeProfile：developer 保留', normalizeProfile('developer') === PROFILES.DEVELOPER);
  check('normalizeProfile：DEVELOPER 大小写归一', normalizeProfile('DEVELOPER') === PROFILES.DEVELOPER);
  check('normalizeProfile：未知回落 normal', normalizeProfile('admin') === PROFILES.NORMAL);
  check('normalizeProfile：null 回落 normal', normalizeProfile(null) === PROFILES.NORMAL);

  const def = readGovernance(null);
  check('readGovernance 缺省：profile=normal', def.profile === PROFILES.NORMAL);
  check('readGovernance 缺省：fsMode=read-write', def.fsMode === 'read-write');
  check('readGovernance 缺省：sandboxNetwork=false（fail-closed）', def.sandboxNetwork === false);

  const custom = readGovernance({ profile: 'developer', fsMode: 'read-only', sandboxNetwork: true });
  check('readGovernance 保留合法值', custom.profile === PROFILES.DEVELOPER && custom.fsMode === 'read-only' && custom.sandboxNetwork === true);

  const bad = readGovernance({ profile: 'x', fsMode: 'write-anywhere', sandboxNetwork: 'yes' });
  check('readGovernance 非法值回落最保守档', bad.profile === PROFILES.NORMAL && bad.fsMode === 'read-write' && bad.sandboxNetwork === false);
}

// ── ④ 源码接线门禁 ──
{
  const ipc = fs.readFileSync(path.join(ROOT, 'main/ipc/mcp.js'), 'utf8');
  check('连接落盘打 tier', /const tier = classifyTier\(\{ name, command, args, url \}\)/.test(ipc));
  check('setConfig 重算 tier', /tier: classifyTier\(\{ name: String\(s\.name\), command: s\.command, args: s\.args, url: s\.url \}\)/.test(ipc));
  check('getConfig 下发 governance', /governance: getGovernance\(\)/.test(ipc));
  check('getConfig 的 servers 补 tier（缺失时 classifyTier）', /tier: rest\.tier \|\| classifyTier\(rest\)/.test(ipc));
  check('治理读 IPC 注册', /ipcMain\.handle\('mcp:governance\/get'/.test(ipc));
  check('治理写 IPC 注册', /ipcMain\.handle\('mcp:governance\/set'/.test(ipc));
  check('治理经 getLocalStore 偏好读写', /store\.getPreference\(GOVERNANCE_PREF_KEY\)/.test(ipc) && /store\.setPreference\(GOVERNANCE_PREF_KEY, merged\)/.test(ipc));
  check('getGovernance 已导出', /getGovernance, mcpServers/.test(ipc));

  const preload = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
  check('preload 暴露 mcpGovernanceGet', /mcpGovernanceGet: \(\) => ipcRenderer\.invoke\('mcp:governance\/get'\)/.test(preload));
  check('preload 暴露 mcpGovernanceSet', /mcpGovernanceSet: \(payload\) => ipcRenderer\.invoke\('mcp:governance\/set', payload\)/.test(preload));

  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  check('main.js 向 initMcpIpc 注入 getLocalStore', /initMcpIpc\(\{[^}]*getLocalStore: \(\) => localStore/.test(main));

  const ui = fs.readFileSync(path.join(ROOT, 'renderer/src/components/LocalMcpSection.tsx'), 'utf8');
  check('渲染层有档位选择器', /applyProfile\(p\)/.test(ui) && /mcpGovernanceSet/.test(ui));
  check('渲染层有档位徽章', /TIER_KEY\[s\.tier\]/.test(ui) && /TIER_CLASS\[s\.tier\]/.test(ui));
  check('渲染层 developer 档即时拉起 git', /GIT_NAMES\.has\(s\.name\)/.test(ui));

  // i18n 双语 key 双向一致
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/zh-CN/localMcp.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/en-US/localMcp.json'), 'utf8'));
  const wantKeys = ['profileLabel', 'profileNormal', 'profileDeveloper', 'tierAutoStart', 'tierWhitelist', 'tierManual', 'govFailed'];
  check('zh-CN localMcp 档位/徽章 key 齐备', wantKeys.every((k) => typeof zh[k] === 'string' && zh[k]), wantKeys.filter((k) => !zh[k]).join(','));
  check('en-US localMcp 档位/徽章 key 齐备', wantKeys.every((k) => typeof en[k] === 'string' && en[k]), wantKeys.filter((k) => !en[k]).join(','));
}

console.log(`\nmcp-governance: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
