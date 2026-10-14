import { useState, useEffect } from 'react';
import { api, loadFeatures, setApiBase } from '../lib/api';
import MarketModal from './MarketModal';
import TeamSpace from './TeamSpace';
import EcosystemModal from './EcosystemModal';
import { confirm } from './feedback';
import InlineAlert from './InlineAlert';
import { IconAlert, IconCheck, IconChevronDown, IconClock, IconCpu, IconGitBranch, IconGlobe, IconPalette, IconPlug, IconPlus, IconPuzzle, IconRefresh, IconSearch, IconSettings, IconUser, IconX, IconZap } from './icons';
import THEMES from '../lib/themes.json';
import ACCENT_CHOICES from '../lib/accentColors.json';

// 权限档位统一常量源（A10）：Composer 与设置页共用，禁止各自维护值域
import { APPROVAL_MODES, SANDBOX_MODES, migrateApprovalMode } from '../constants/approval';
import { getLinkOpenMode, setLinkOpenMode } from '../lib/linkOpen';

const BUILTIN_SKILLS = [
  { id: 'code_review', name: '代码审查', desc: '审查代码质量、找出潜在问题' },
  { id: 'gen_docs', name: '文档生成', desc: '根据代码生成 README 和注释' },
  { id: 'gen_tests', name: '测试生成', desc: '为函数生成单元测试用例' },
  { id: 'git_commit', name: 'Git 提交', desc: '根据变更生成规范的提交信息' },
];

// 导航分组对齐 WorkBuddy：设置（外观与模型）/ 功能（能力开关与集成）/ 账户与安全（数据与更新）
// 顺序纪律：每个 id 必须在正文里有对应实现——曾经 browser / git 只登记在导航里、
// 正文没有分支，点进去只有标题和空白（「假可用」比不显示入口更伤信任）。
const NAV = [
  { group: '设置', items: [
    { id: 'general', icon: <IconSettings size={16} />, label: '通用' },
    { id: 'appearance', icon: <IconPalette size={16} />, label: '外观' },
    { id: 'models', icon: <IconCpu size={16} />, label: '模型配置' },
    { id: 'account', icon: <IconUser size={16} />, label: '账户与更新' },
  ]},
  { group: '功能', items: [
    { id: 'skills', icon: <IconZap size={16} />, label: '技能' },
    { id: 'plugins', icon: <IconPuzzle size={16} />, label: '插件市场' },
    { id: 'ecosystem', icon: <IconUser size={16} />, label: '生态中心' },
    { id: 'mcp', icon: <IconPlug size={16} />, label: 'MCP 服务' },
    { id: 'browser', icon: <IconGlobe size={16} />, label: '浏览器与链接' },
    { id: 'git', icon: <IconGitBranch size={16} />, label: 'Git 与 GitHub' },
    { id: 'teamspace', icon: <IconGitBranch size={16} />, label: '团队空间' },
  ]},
];

// 链接打开方式：设置项必须真正生效——预览栏里的 Markdown 链接按此策略分发，
// 否则「设置里能选、行为上没区别」等于假开关。
export const LINK_OPEN_OPTIONS = [
  { id: 'smart', name: '智能打开', desc: 'http/https 链接交给系统浏览器；本地文件路径在应用内预览' },
  { id: 'system', name: '始终用系统浏览器', desc: '所有链接一律交给系统默认浏览器打开' },
  { id: 'copy', name: '只复制链接', desc: '不打开任何链接，仅复制到剪贴板（避免误触跳转）' },
];

// MCP 市场目录（借鉴 TRAE：添加 ∨ → 从市场添加）。内置官方 server 预设；
// TODO(backend)：市场目录切换为云端接口，可随时更新推荐列表。
// git 能力统一经 MCP 调用（mcp-server-git），DiffReview 面板的内置 git IPC 仅作 UI 兜底。
const MCP_PRESETS = [
  { name: 'playwright', label: 'Playwright', desc: '浏览器自动化：页面操作、截图、表单填写与端到端测试。', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  { name: 'fetch', label: 'Fetch 网页抓取', desc: '抓取网页并转为 Markdown，供模型阅读引用。', command: 'npx', args: ['-y', 'mcp-server-fetch'] },
  { name: 'git', label: 'Git 版本管理', desc: '标准 mcp-server-git：仓库状态、diff、提交与分支操作（需已安装 uv/uvx）。', command: 'uvx', args: ['mcp-server-git', '--repository', '.'] },
  { name: 'filesystem', label: 'Filesystem 文件系统', desc: '受控目录内的文件读写、搜索与目录树。', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
  { name: 'memory', label: 'Memory 知识记忆', desc: '基于知识图谱的持久记忆，跨会话记住实体与关系。', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { name: 'context7', label: 'Context7 文档检索', desc: '检索主流框架/库的最新官方文档与用法示例。', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  { name: 'sequential-thinking', label: 'Sequential Thinking', desc: '结构化分步思考工具，提升复杂任务推理质量。', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
];

const SANDBOX_OPTIONS = SANDBOX_MODES;

// OS 级沙箱后端 → 中文名。用于未就绪时如实告诉用户「本平台本该有哪种隔离」，
// 而不是笼统地说「你的系统不支持」（三平台后端清单见 main/sandbox.js 的 detectBackend）
const SANDBOX_BACKEND_LABEL = {
  seatbelt: 'macOS Seatbelt',
  bubblewrap: 'Linux bubblewrap',
  'windows-restricted-user': 'Windows 受限专用用户',
  none: '当前平台无可用后端',
};

const APPROVAL_OPTIONS = APPROVAL_MODES;

export default function SettingsModal({
  onClose, providers, onProvidersChange,
  theme, onThemeChange, globalProviders, onMcpToolsChange, onSkillsChange,
  approvalSettings, onApprovalSettingsChange,
  enabledSkills,
  autoDecompose, onAutoDecomposeChange,
  projectPath = '',
}) {
  const [tab, setTab] = useState('general');
  const [search, setSearch] = useState('');
  // ST3：插件/生态已内嵌到对应 Tab，弹窗态状态移除
  const [newP, setNewP] = useState({ name: '', base_url: '', api_key: '' });
  const [addPError, setAddPError] = useState(''); // ST4：添加服务前置校验错误
  const [accentVer, setAccentVer] = useState(0); // TH5：强调色变更触发重渲染
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '' });
  const [mcpStatus, setMcpStatus] = useState({});
  // A6：启用态改受控（App 层持有并持久化），移除本组件的独立本地 state（两态漂移根因）
  const [diskSkills, setDiskSkills] = useState([]);
  // 桌面端功能开关（fail-closed）：协同冻结时隐藏团队空间入口
  const [flags, setFlags] = useState(null);
  // 生态技能（skills.json 私有目录 → SKILL.md 安装）
  const [catalog, setCatalog] = useState([]);
  const [installMsg, setInstallMsg] = useState('');
  const sandbox = approvalSettings?.sandbox_policy || 'workspace-write';
  // P0-F：沙箱能力状态（无 OS 级沙箱时明示兜底边界）
  const [sandboxStatus, setSandboxStatus] = useState(null);
  // 服务端地址（设置-通用）：打包版唯一可行的服务端数据入口（dev 时本地 3001 已在跑）
  const [serverBaseInput, setServerBaseInput] = useState('');
  const [serverBaseCur, setServerBaseCur] = useState('');
  const [serverBaseMsg, setServerBaseMsg] = useState('');
  useEffect(() => {
    window.mjcode?.serverBase?.().then((r) => {
      setServerBaseCur(r?.base || '');
      setServerBaseInput(r?.base || '');
    }).catch(() => {});
  }, []);
  // A10：读取时迁移遗留值（auto → auto-safe、always-ask → always）
  const approvalMode = migrateApprovalMode(approvalSettings?.approval_mode);

  // TH5：强调色备选（null = 跟随主题默认）；色值常量在 lib/accentColors.js
  // （ui-conventions 基线：组件文件零十六进制硬编码色）
  function setAccent(color) {
    try {
      if (color) localStorage.setItem('mj_accent', color);
      else localStorage.removeItem('mj_accent');
      const root = document.documentElement;
      if (color) {
        root.style.setProperty('--theme-accent', color);
        root.style.setProperty('--sem-accent', color);
      } else {
        root.style.removeProperty('--theme-accent');
        root.style.removeProperty('--sem-accent');
      }
      setAccentVer((v) => v + 1);
    } catch (e) { console.warn('[settings] 强调色设置失败:', e); }
  }

  function changeSkills(next) {
    onSkillsChange?.(next);
  }

  // Esc 关闭设置：主窗口无系统标题栏，Esc 是唯一「不用找按钮」的退出路径
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    window.mjcode?.getFlags?.()
      .then((r) => { if (r?.ok) setFlags(r.flags); })
      .catch((err) => console.warn('[settings] 功能开关加载失败:', err));
  }, []);

  useEffect(() => {
    window.mjcode?.sandboxStatus?.()
      .then((r) => { if (r?.ok) setSandboxStatus(r); })
      .catch((err) => console.warn('[settings] 沙箱状态加载失败:', err));
  }, []);

  // 战略收敛：collab 冻结时隐藏团队空间导航项
  const nav = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !(i.id === 'teamspace' && flags && flags.collab === false)) }))
    .filter((g) => g.items.length > 0);

  // 进入技能页时加载磁盘技能（~/.mjcode/skills）与生态技能目录
  async function refreshDiskSkills() {
    if (window.mjcode?.listSkills) {
      try {
        const r = await window.mjcode.listSkills();
        if (r.ok) setDiskSkills(r.skills);
      } catch (err) {
        console.warn('[settings] 技能列表加载失败:', err);
      }
    }
  }

  useEffect(() => {
    if (tab !== 'skills') return;
    refreshDiskSkills();
    if (window.mjcode?.ecosystemSkills) {
      window.mjcode.ecosystemSkills()
        .then((r) => { if (r?.ok) setCatalog(r.skills || []); })
        .catch((err) => console.warn('[settings] 生态技能目录加载失败:', err));
    }
  }, [tab]);

  async function installCatalogSkill(id) {
    setInstallMsg('');
    try {
      const r = await window.mjcode.installEcosystemSkill({ id });
      if (r?.ok) {
        setInstallMsg(`已安装为 SKILL.md：~/.mjcode/skills/${r.dir}`);
        const lr = await window.mjcode.listSkills();
        if (lr.ok) setDiskSkills(lr.skills);
      } else {
        setInstallMsg(r?.error || '安装失败');
      }
    } catch (err) {
      setInstallMsg(err.message || '安装失败');
    }
  }

  async function importExternalSkills() {
    setInstallMsg('');
    try {
      const picked = await window.mjcode.pickDirectory();
      if (!picked?.ok) return;
      const r = await window.mjcode.importSkillsFromDir({ dir: picked.path });
      if (r?.ok) {
        setInstallMsg(`扫描到 ${r.found} 个 SKILL.md，安装 ${r.installed.length} 个${r.failed.length ? `，失败 ${r.failed.length} 个` : ''}`);
        const lr = await window.mjcode.listSkills();
        if (lr.ok) setDiskSkills(lr.skills);
      } else {
        setInstallMsg(r?.error || '导入失败');
      }
    } catch (err) {
      setInstallMsg(err.message || '导入失败');
    }
  }

  // ST4：接口地址必须是合法 http(s) URL（此前任意字符串都能提交，填错只能等调用时报错）
  function isValidHttpUrl(s) {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }

  async function addProvider() {
    if (!newP.name || !newP.base_url) { setAddPError('名称与接口地址必填'); return; }
    const url = newP.base_url.trim();
    if (!isValidHttpUrl(url)) { setAddPError('接口地址需为完整 URL（以 http:// 或 https:// 开头）'); return; }
    if (!newP.api_key || !String(newP.api_key).trim()) { setAddPError('API Key 必填'); return; }
    setAddPError('');
    try {
      await api.addProvider({ ...newP, base_url: url });
      setNewP({ name: '', base_url: '', api_key: '' });
      onProvidersChange();
    } catch (err) {
      // 此前裸 await：主进程报错（如打包版 safeStorage 不可用）时 Promise 静默失败，UI 毫无反馈
      setAddPError(`保存失败：${err?.message || '未知错误'}`);
    }
  }

  return (
    <div className="fixed inset-0 bg-bg z-settings flex">
      {/* 左侧导航 */}
      <div className="w-[280px] border-r border-border flex flex-col">
        {/* 交通灯安全区（真机反馈「设置页顶部还没修复」的根因）：
            主窗口是 titleBarStyle: 'hiddenInset'，macOS 的红/黄/绿三灯悬浮在
            窗口左上角（约 78x38）并且永远盖在网页内容之上。
            设置浮层铺满整窗，原先把「← 返回应用」放在这里 → 按钮被交通灯压住，
            看不清也点不到。现在整块留空并设为可拖拽区，功能入口全部下移。 */}
        <div className="h-11 shrink-0" style={{ WebkitAppRegion: 'drag' }} />
        <div className="px-4 pb-4 flex flex-col flex-1 min-h-0">
          <input placeholder="搜索设置项..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm mb-4 outline-none shrink-0" />
          <div className="flex-1 min-h-0 overflow-y-auto">
            {nav.map((group) => {
              const items = group.items.filter(i => !search || i.label.includes(search));
              if (!items.length) return null;
              return (
                <div key={group.group} className="mb-4">
                  <div className="text-xs text-text2 px-2 mb-1">{group.group}</div>
                  {items.map((item) => (
                    <button key={item.id} onClick={() => setTab(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-0.5 ${tab === item.id ? 'bg-surface text-text' : 'text-text2 hover:bg-hover'}`}>
                      <span className="shrink-0">{item.icon}</span> {item.label}
                    </button>
                  ))}
                </div>
              );
            })}
            {nav.every(g => !g.items.filter(i => !search || i.label.includes(search)).length) && (
              <p className="text-xs text-text2 px-2 py-3">没有匹配「{search}」的设置项</p>
            )}
          </div>
        </div>
      </div>

      {/* 右侧内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-8 relative">
        {/* 顶部拖拽条 + 关闭：窗口无系统标题栏，设置页必须自带关闭出口；
            放在右侧内容区顶端，既避开交通灯，也不占用导航栏的高度 */}
        <div className="absolute top-0 left-0 right-0 h-11 flex items-center justify-end px-6"
          style={{ WebkitAppRegion: 'drag' }}>
          <button onClick={onClose}
            className="text-text2 hover:text-text p-1.5 rounded-lg hover:bg-hover"
            style={{ WebkitAppRegion: 'no-drag' }}
            title="关闭设置（Esc）" aria-label="关闭设置">
            <IconX size={16} />
          </button>
        </div>
        <h1 className="text-2xl font-semibold mb-8 mt-8">
          {nav.flatMap(g => g.items).find(i => i.id === tab)?.label || '设置'}
        </h1>

        {/* 通用 */}
        {tab === 'general' && (
          <>
            <Section title="沙箱策略">
              {SANDBOX_OPTIONS.map((o) => (
                <OptionRow key={o.id} name={o.name} desc={o.desc} selected={sandbox === o.id} warn={o.id === 'full-access'}
                  onSelect={() => onApprovalSettingsChange?.({ ...approvalSettings, sandbox_policy: o.id })} />
              ))}
              {sandboxStatus && !sandboxStatus.available && (
                <div className="mt-3">
                  <InlineAlert type="warn">
                    <p className="font-medium">当前系统未就绪 OS 级沙箱（{SANDBOX_BACKEND_LABEL[sandboxStatus?.backend] || '未知后端'}）</p>
                    {sandboxStatus?.hint && <p className="mt-1 text-text2">{sandboxStatus.hint}</p>}
                    <p className="mt-1 text-text2">已启用命令级硬拦截兜底：危险命令（递归删除、sudo、git push、reset --hard、管道执行远程脚本等）会被直接拒绝，审批通过也无法绕过。这并非 OS 级隔离，请勿在此环境执行不受控代码。</p>
                  </InlineAlert>
                </div>
              )}
            </Section>
            <Section title="审批模式">
              {APPROVAL_OPTIONS.map((o) => (
                <OptionRow key={o.id} name={o.name} desc={o.desc} selected={approvalMode === o.id} warn={o.id === 'never'}
                  onSelect={async () => {
                    // 第 8 节：档位 = never 需二次确认（自动执行有数据丢失风险）
                    if (o.id === 'never' && approvalMode !== 'never') {
                      const ok = await confirm({
                        title: '切换到自动执行',
                        message: '该档位下所有工具调用（含写文件与命令执行）都将自动执行，不再弹出确认。确定开启吗？',
                        danger: true,
                        confirmLabel: '开启自动执行',
                      });
                      if (!ok) return;
                    }
                    onApprovalSettingsChange?.({ ...approvalSettings, approval_mode: o.id });
                  }} />
              ))}
            </Section>
            <p className="text-text2 text-xs">新建对话将快照当前档位；审批中的「始终允许」规则保存在本机。</p>
            <ApprovalRulesSection />
            <Section title="大任务拆分">
              <div className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <div className="text-sm">检测到大任务时自动拆分</div>
                  <p className="text-xs text-text2 mt-0.5">用一次小规划调用把多文件/多功能点任务拆成若干步骤，由你确认后分步执行；每步完成后报告消耗并让你决定是否继续，省去大任务跑偏后的返工 token。</p>
                </div>
                <Toggle on={autoDecompose} onChange={() => onAutoDecomposeChange?.(!autoDecompose)} />
              </div>
            </Section>
            <Section title="服务端地址">
              <p className="text-xs text-text2 mb-2">本地优先：会话、本机模型、任务编排不依赖服务端；服务端仅提供登录、共享模型与团队数据。打包版默认指向本机 3001，若服务端部署在远端请在此填写（以 http:// 或 https:// 开头）。</p>
              <div className="flex items-center gap-2">
                <input value={serverBaseInput} onChange={(e) => setServerBaseInput(e.target.value)}
                  placeholder="http://localhost:3001/api"
                  className="flex-1 bg-surface border border-border rounded-lg px-3 py-1.5 text-sm font-mono outline-none focus:border-accent" />
                <button
                  onClick={async () => {
                    setServerBaseMsg('');
                    try {
                      const r = await window.mjcode.serverBase({ base: serverBaseInput });
                      setServerBaseCur(r.base);
                      setApiBase(r.base);
                      loadFeatures();
                      setServerBaseMsg('已保存并生效（当前地址：' + r.base + '，来源：' + r.source + '）');
                    } catch (err) {
                      setServerBaseMsg(err?.message || '保存失败');
                    }
                  }}
                  className="bg-accent text-white px-3 py-1.5 rounded-lg text-xs shrink-0"
                >保存并测试</button>
              </div>
              {serverBaseMsg && <p className="text-xs text-text2 mt-1">{serverBaseMsg}</p>}
              {serverBaseCur && <p className="text-xs text-text2 mt-1">当前生效：{serverBaseCur}</p>}
            </Section>
          </>
        )}

        {/* 外观 */}
        {tab === 'appearance' && (
          <>
            <Section title="主题">
              {/* TH4：三色条组合预览（bg/surface/accent）+ hover 实时预览，离开未选中的自动恢复 */}
              <div className="grid grid-cols-5 gap-3">
                {THEMES.map((t) => (
                  <button key={t.id}
                    onClick={() => onThemeChange(t.id)}
                    onMouseEnter={(e) => document.documentElement.setAttribute('data-theme', t.id)}
                    onMouseLeave={(e) => document.documentElement.setAttribute('data-theme', theme)}
                    className={`p-3 rounded-xl border-2 text-center ${theme === t.id ? 'border-accent' : 'border-border'}`}>
                    <div className="w-12 h-12 rounded-lg mx-auto mb-2 border border-border overflow-hidden flex" title={`${t.swatch?.bg || t.color} / ${t.swatch?.accent || ''}`}>
                      <span className="w-1/3 h-full" style={{ background: t.swatch?.bg || t.color }} />
                      <span className="w-1/3 h-full" style={{ background: t.swatch?.surface || t.color }} />
                      <span className="w-1/3 h-full" style={{ background: t.swatch?.accent || t.color }} />
                    </div>
                    <div className="text-xs">{t.name}</div>
                  </button>
                ))}
              </div>
              <p className="text-text2 text-xs mt-2">悬停卡片可在整个界面上实时预览；顶栏调色板图标与 ⌘K「切换主题」可快速切换。</p>
            </Section>
            {/* TH5：强调色（覆盖主题 accent，持久化于 mj_accent） */}
            <Section title="强调色">
              <div className="flex items-center gap-2.5 flex-wrap">
                {ACCENT_CHOICES.map((a) => {
                  const c = a.value;
                  const current = accentVer >= 0 ? localStorage.getItem('mj_accent') : null;
                  const active = (c || null) === (current || null);
                  return (
                    <button key={c || 'default'} onClick={() => setAccent(c)}
                      title={a.label}
                      className={`w-8 h-8 rounded-full border-2 flex items-center justify-center ${active ? 'border-accent' : 'border-border'}`}
                      style={c ? { background: c } : undefined}>
                      {active && <IconCheck size={14} className={c ? 'text-white' : 'text-accent'} />}
                      {!c && <span className="text-[9px] text-text2">默认</span>}
                    </button>
                  );
                })}
              </div>
              <p className="text-text2 text-xs mt-2">覆盖当前主题的强调色，对所有界面即时生效；选「默认」恢复主题自带配色。</p>
            </Section>
          </>
        )}

        {/* 模型配置 */}
        {tab === 'models' && <ModelsTab
          providers={providers}
          onProvidersChange={onProvidersChange}
          globalProviders={globalProviders}
          newP={newP} setNewP={setNewP}
          addProvider={addProvider}
          addPError={addPError}
        />}

        {/* MCP */}
        {tab === 'mcp' && <McpTab
          mcpStatus={mcpStatus} setMcpStatus={setMcpStatus}
          mcpForm={mcpForm} setMcpForm={setMcpForm}
          onMcpToolsChange={onMcpToolsChange}
        />}

        {/* 技能 */}
        {tab === 'skills' && (
          <>
            <Section title="内置技能">
              {BUILTIN_SKILLS.map((s) => {
                const enabled = enabledSkills.includes(s.id);
                return (
                  <div key={s.id} className="py-3 border-b border-border last:border-0 flex items-center justify-between">
                    <div>
                      <div className="text-sm">{s.name}</div>
                      <div className="text-xs text-text2">{s.desc}</div>
                    </div>
                    <Toggle on={enabled} onChange={() => {
                      changeSkills(enabled ? enabledSkills.filter(id => id !== s.id) : [...enabledSkills, s.id]);
                    }} />
                  </div>
                );
              })}
            </Section>
            <Section title="文件技能（~/.mjcode/skills）">
              {diskSkills.length === 0 ? (
                <div className="py-4">
                  <p className="text-text2 text-sm">尚未发现技能文件</p>
                  <p className="text-text2 text-xs mt-2 leading-relaxed">
                    在 <code className="text-accent">~/.mjcode/skills/&lt;名称&gt;/SKILL.md</code> 放置带 frontmatter（name/description）的技能文件即可被识别与启用。
                  </p>
                </div>
              ) : diskSkills.map((s) => {
                const enabled = enabledSkills.includes(s.dir);
                return (
                  <div key={s.dir} className="py-3 border-b border-border last:border-0 flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-mono">{s.name}</div>
                      <div className="text-xs text-text2 mt-0.5">{s.description || '（无描述）'}</div>
                    </div>
                    <Toggle on={enabled} onChange={() => {
                      changeSkills(enabled ? enabledSkills.filter(id => id !== s.dir) : [...enabledSkills, s.dir]);
                    }} />
                  </div>
                );
              })}
            </Section>
            <Section title="生态技能（SKILL.md 标准格式）">
              <div className="py-3">
                <div className="text-xs text-text2 mb-2 leading-relaxed">
                  兼容 Claude Code / Codex 的 SKILL.md 技能标准：生态目录技能一键物化安装，或直接导入任意技能仓库目录（自动扫描 SKILL.md）。
                </div>
                <div className="flex gap-2 mb-2">
                  <button onClick={importExternalSkills} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">
                    从文件夹导入
                  </button>
                  {installMsg && <span className="text-xs text-text2 self-center">{installMsg}</span>}
                </div>
                {catalog.length === 0 ? (
                  <p className="text-text2 text-xs">生态技能目录为空（ecosystem/skills.json 未找到）。</p>
                ) : catalog.map((s) => {
                  const installed = diskSkills.some((d) => d.dir === s.id || d.name === s.id);
                  return (
                    <div key={s.id} className="py-2 border-b border-border last:border-0 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm truncate">{s.display_name || s.name}</div>
                        <div className="text-xs text-text2 truncate">{s.description || '（无描述）'}</div>
                      </div>
                      {installed ? (
                        <span className="text-xs text-text2 shrink-0">已安装</span>
                      ) : (
                        <button onClick={() => installCatalogSkill(s.id)} className="text-xs px-3 py-1 rounded-lg bg-accent text-white shrink-0">安装</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          </>
        )}

        {/* 账户：更新与审计 */}
        {tab === 'account' && <AccountTab flags={flags} />}

        {/* 生态中心（M7）：ST3 直接内嵌目录列表，去掉「入口页 → 弹窗」两层嵌套 */}
        {tab === 'ecosystem' && (
          <EcosystemModal embedded />
        )}

        {/* 团队空间（P5）：看板 + 共享审批；战略收敛后默认冻结（flags.collab === false 时隐藏） */}
        {flags?.collab !== false && tab === 'teamspace' && <TeamSpace spaceId="default" />}

        {/* 插件市场（M6）：ST3 直接内嵌市场列表，去掉两层嵌套 */}
        {/* onInstalled 不能把 onSkillsChange（App 的 setEnabledSkills）直接透传：
            MarketModal 会以 (plugin) => 回调，无参调用会让 enabledSkills 变成 plugin 对象，
            ChatArea 里 enabledSkills.filter 立即崩溃，且被持久化、重启后仍崩（真机事故）。
            插件安装与「启用技能列表」是两条数据通道，这里不需要联动。 */}
        {tab === 'plugins' && (
          <MarketModal embedded onInstalled={() => { /* 插件安装与技能启用列表解耦 */ }} />
        )}

        {/* 浏览器与链接：链接打开策略（真正生效）+ 计算机使用（CUA）能力边界 */}
        {tab === 'browser' && <BrowserTab flags={flags} />}

        {/* Git 与 GitHub：环境只读探测 + 集成状态 + 审批边界说明 */}
        {tab === 'git' && <GitTab projectPath={projectPath} />}
      </div>
    </div>
  );
}

// 浏览器与链接（真机反馈：此页此前只有导航项、点进去是空白）
// 内容 = 「链接怎么打开」+「能不能操作界面」两件事的真实开关与能力边界
function BrowserTab({ flags }) {
  const [linkMode, setLinkMode] = useState(getLinkOpenMode);
  const [cua, setCua] = useState(null);

  useEffect(() => {
    window.mjcode?.cuaStatus?.()
      .then((r) => setCua(r))
      .catch((err) => { console.warn('[settings] CUA 状态探测失败:', err); setCua({ available: false, message: '状态探测失败' }); });
  }, []);

  return (
    <>
      <Section title="链接打开方式">
        {LINK_OPEN_OPTIONS.map((o) => (
          <OptionRow key={o.id} name={o.name} desc={o.desc} selected={linkMode === o.id}
            onSelect={() => { setLinkMode(o.id); setLinkOpenMode(o.id); }} />
        ))}
        <p className="text-text2 text-xs mt-2">
          该设置即时生效，影响预览栏内 Markdown 文档里的链接点击行为。
        </p>
      </Section>

      <Section title="应用内浏览">
        <p className="text-text2 text-sm">
          本应用不内嵌浏览器内核：网页内容一律交给系统浏览器打开，避免在编码工作台里引入第二套渲染与 cookie 体系。
          需要抓取网页内容时，请用 MCP 连接器（如 fetch / Playwright）经 Agent 调用，结果会以文本形式回到对话里。
        </p>
      </Section>

      <Section title="计算机使用（界面自动化）">
        {!cua && <p className="text-text2 text-sm">正在检测权限…</p>}
        {cua && (
          <div className="py-2">
            <div className="flex items-center gap-2">
              <span className={`text-sm ${cua.granted ? 'text-success' : 'text-warn'}`}>
                {cua.available === false ? '当前系统不支持' : (cua.granted ? '辅助功能权限已授予' : '缺少辅助功能权限')}
              </span>
              {cua.available === false && flags?.cua === false && (
                <span className="text-xs text-text2">（功能开关已关闭）</span>
              )}
            </div>
            {cua.message && <p className="text-text2 text-xs mt-1">{cua.message}</p>}
            <p className="text-text2 text-xs mt-2">
              界面自动化只能由 Agent 在会话中发起，且每一次操作都会先弹出审批卡片；设置页不提供「一键全权放行」。
            </p>
          </div>
        )}
      </Section>
    </>
  );
}

// Git 与 GitHub（真机反馈：此页此前只有导航项、点进去是空白）
// 只读探测：git 是否可用、当前仓库/全局署名、gh CLI 的安装与登录状态。
// 刻意不做「在这里改全局 git config」——写用户级配置属于危险操作，应由用户在终端显式执行。
function GitTab({ projectPath }) {
  const [cfg, setCfg] = useState(null);
  const [gh, setGh] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, g] = await Promise.all([
          window.mjcode?.gitConfig?.({ cwd: projectPath || '' }),
          window.mjcode?.githubStatus?.(),
        ]);
        if (cancelled) return;
        setCfg(c || null);
        setGh(g || null);
      } catch (err) {
        console.warn('[settings] Git 环境探测失败:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  const name = cfg?.repoName || cfg?.globalName || '';
  const email = cfg?.repoEmail || cfg?.globalEmail || '';
  const scoped = cfg?.repoName ? '仓库级' : (cfg?.globalName ? '全局' : '');

  function Row({ label, value, hint, tone }) {
    return (
      <div className="flex items-start justify-between gap-4 py-2 border-b border-border last:border-0">
        <div className="min-w-0">
          <div className="text-sm">{label}</div>
          {hint && <div className="text-xs text-text2 mt-0.5 break-all">{hint}</div>}
        </div>
        <div className={`text-sm shrink-0 ${tone || 'text-text2'}`}>{value}</div>
      </div>
    );
  }

  return (
    <>
      <Section title="Git 环境">
        {!cfg && <p className="text-text2 text-sm">正在检测…</p>}
        {cfg && (
          <>
            <Row label="Git 可执行文件" value={cfg.available ? '已安装' : '未找到'} tone={cfg.available ? 'text-success' : 'text-danger'}
              hint={cfg.version || '未检测到 git 命令，请先安装 Git 后再使用变更面板与工作树能力'} />
            <Row label="提交署名" value={name ? `${name}${scoped ? `（${scoped}）` : ''}` : '未配置'}
              tone={name ? 'text-text2' : 'text-warn'}
              hint={name
                ? (email || '（未配置邮箱）')
                : '未配置 user.name：现在提交会失败。请在终端执行 git config --global user.name "你的名字"'} />
            <Row label="检测目录" value="" hint={cfg.cwd} />
          </>
        )}
      </Section>

      <Section title="GitHub 集成（gh CLI）">
        {!gh && <p className="text-text2 text-sm">正在检测…</p>}
        {gh && (
          <>
            <Row label="GitHub CLI" value={gh.available ? '已安装' : '未安装'} tone={gh.available ? 'text-success' : 'text-warn'} />
            {gh.available && (
              <Row label="登录状态" value={gh.authed ? '已登录' : '未登录'} tone={gh.authed ? 'text-success' : 'text-warn'} />
            )}
            {gh.hint && <p className="text-xs text-text2 mt-2">{gh.hint}</p>}
            <p className="text-text2 text-xs mt-2">
              登录后可在变更面板里一键创建 Pull Request；创建动作属于对外写操作，会先弹审批卡片。
            </p>
          </>
        )}
      </Section>

      <Section title="写操作边界">
        <p className="text-text2 text-sm">
          本页只做只读探测：不修改全局 git 配置，也不代替你登录。需要写配置请显式在终端执行，
          避免设置页变成「静默改用户环境」的后门。
        </p>
        <p className="text-text2 text-xs mt-2">
          会话内的 git 写操作（commit / checkout / restore）走审批中心，档位在「通用」页配置；
          Diff 面板的「撤销」依赖本地磁盘快照，不依赖 git 状态。
        </p>
      </Section>
    </>
  );
}

// B2：模型配置页 —— 供应商可编辑（name/base_url/换 Key）+ 测试连接（延迟可见）
// 多模型：模型条目可增可删，「+ 添加模型」默认收起（修复已添加仍常驻输入框的逻辑混乱）
function ModelsTab({ providers, onProvidersChange, globalProviders, newP, setNewP, addProvider, addPError = '' }) {
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', base_url: '' });
  const [keyPid, setKeyPid] = useState(null);
  const [keyValue, setKeyValue] = useState('');
  const [testStatus, setTestStatus] = useState({}); // id -> { ok, latencyMs, error, testing }
  const [addFormPid, setAddFormPid] = useState(null);
  const [addForm, setAddForm] = useState({ pid: null, model_id: '', display_name: '' });

  async function submitAddModel() {
    if (!addForm.pid || !addForm.model_id.trim()) return;
    try {
      await api.addProviderModel(addForm.pid, { model_id: addForm.model_id.trim(), display_name: addForm.display_name.trim() });
      setAddFormPid(null);
      setAddForm({ pid: null, model_id: '', display_name: '' });
      onProvidersChange();
    } catch (err) {
      setTestStatus((s) => ({ ...s, [addForm.pid]: { ok: false, error: err.message } }));
    }
  }

  async function saveEdit(p) {
    try {
      await api.updateProvider(p.id, { name: editForm.name, base_url: editForm.base_url });
      setEditingId(null);
      onProvidersChange();
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err.message } }));
    }
  }

  async function saveKey(p) {
    if (!keyValue.trim()) return;
    try {
      await api.updateProvider(p.id, { api_key: keyValue.trim() });
      setKeyPid(null);
      setKeyValue('');
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err.message } }));
    }
  }

  async function testConn(p) {
    setTestStatus((s) => ({ ...s, [p.id]: { testing: true } }));
    try {
      const r = await api.testConnection(p.id, p.base_url);
      setTestStatus((s) => ({ ...s, [p.id]: { ok: r?.ok, latencyMs: r?.latencyMs, error: r?.error } }));
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err?.message || '测试请求失败' } }));
    }
  }

  return (
    <>
      <Section title="我的模型服务">
        {providers.map((p) => {
          const isServer = String(p.id).startsWith('s');
          const st = testStatus[p.id];
          const editing = editingId === p.id;
          return (
            <div key={p.id} className="py-3 border-b border-border last:border-0">
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="flex-1 bg-bg border border-border rounded px-2 py-1 text-sm" placeholder="名称" />
                    <input value={editForm.base_url} onChange={(e) => setEditForm({ ...editForm, base_url: e.target.value })}
                      className="flex-[2] bg-bg border border-border rounded px-2 py-1 text-sm font-mono" placeholder="接口地址" />
                    <button onClick={() => saveEdit(p)} className="bg-accent text-white px-3 rounded text-xs py-1">保存</button>
                    <button onClick={() => setEditingId(null)} className="text-text2 text-xs">取消</button>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-hover text-text2">{isServer ? '共享' : '本机'}</span>
                    <span className="ml-auto flex items-center gap-2 shrink-0">
                      {!isServer && (
                        <>
                          <button onClick={() => { setEditingId(p.id); setEditForm({ name: p.name, base_url: p.base_url }); }}
                            className="text-text2 hover:text-text text-xs">编辑</button>
                          <button onClick={() => { setKeyPid(keyPid === p.id ? null : p.id); setKeyValue(''); }}
                            className="text-text2 hover:text-text text-xs">更换 Key</button>
                          <button onClick={() => testConn(p)} className="text-text2 hover:text-text text-xs">测试连接</button>
                        </>
                      )}
                      <button onClick={async () => {
                        // A2：删除需确认（加密 Key 不可逆销毁）
                        const ok = await confirm({
                          title: '删除模型服务',
                          message: `确定删除「${p.name}」吗？其 API Key 将被销毁且不可恢复。`,
                          danger: true,
                          confirmLabel: '删除',
                        });
                        if (!ok) return;
                        try {
                          await api.deleteProvider(p.id);
                          onProvidersChange();
                        } catch (err) {
                          setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err?.message || '删除失败' } }));
                        }
                      }} className="text-danger text-xs">删除</button>
                    </span>
                  </>
                )}
              </div>
              {!editing && <div className="text-xs text-text2 mt-1 font-mono">{p.base_url}</div>}
              {st?.testing && <div className="text-xs text-text2 mt-1">测试中…</div>}
              {st && !st.testing && (st.ok
                ? <div className="text-xs text-success mt-1">连接正常 · {st.latencyMs}ms</div>
                : <div className="text-xs text-danger mt-1">连接失败{st.latencyMs ? `（${st.latencyMs}ms）` : ''}：{st.error || '未知错误'}</div>)}
              {keyPid === p.id && (
                <div className="flex gap-2 mt-2">
                  <input type="password" value={keyValue} onChange={(e) => setKeyValue(e.target.value)}
                    placeholder="输入新的 API Key（本机加密保存）"
                    className="flex-1 bg-bg border border-border rounded px-2 py-1 text-xs" />
                  <button onClick={() => saveKey(p)} className="bg-accent text-white px-3 rounded text-xs">保存 Key</button>
                </div>
              )}
              {p.models?.length > 0 && (
                <div className="mt-2 space-y-1">
                  {p.models.map((m) => {
                    const mid = m.model_id || m.modelId;
                    return (
                      <div key={m.id ?? mid} className="flex items-center gap-1.5 pl-4 text-xs text-text2 group">
                        <span className="w-1 h-1 rounded-full bg-text2 shrink-0" />
                        <span className="truncate">{m.display_name || mid}</span>
                        {!isServer && (
                          <button
                            onClick={async () => {
                              const ok = await confirm({
                                title: '删除模型条目',
                                message: `从「${p.name}」移除「${m.display_name || mid}」？不影响服务本身与 Key。`,
                                danger: true,
                                confirmLabel: '移除',
                              });
                              if (!ok) return;
                              try {
                                await api.removeProviderModel(p.id, mid);
                                onProvidersChange();
                              } catch (err) {
                                setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err.message } }));
                              }
                            }}
                            className="ml-auto text-text2 hover:text-danger opacity-0 group-hover:opacity-100 shrink-0"
                            title="移除此模型条目"
                            aria-label={`移除模型 ${m.display_name || mid}`}
                          >
                            <IconX size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 添加模型：默认收起（修复「已添加模型仍常驻输入框」的逻辑混乱） */}
              {!isServer && (
                addFormPid === p.id ? (
                  <div className="flex gap-2 mt-2">
                    <input placeholder="模型 ID（如 mimo-v2.6-pro）" value={addForm.pid === p.id ? addForm.model_id : ''}
                      onChange={(e) => setAddForm({ pid: p.id, model_id: e.target.value, display_name: addForm.display_name })}
                      className="flex-1 bg-surface border border-border rounded px-2 py-1 text-xs" />
                    <input placeholder="显示名（可选）" value={addForm.pid === p.id ? addForm.display_name : ''}
                      onChange={(e) => setAddForm({ ...addForm, display_name: e.target.value })}
                      className="w-28 bg-surface border border-border rounded px-2 py-1 text-xs" />
                    <button onClick={submitAddModel} className="bg-accent text-white px-3 rounded text-xs">添加</button>
                    <button onClick={() => { setAddFormPid(null); setAddForm({ pid: null, model_id: '', display_name: '' }); }}
                      className="text-text2 text-xs">取消</button>
                  </div>
                ) : (
                  <button onClick={() => { setAddFormPid(p.id); setAddForm({ pid: p.id, model_id: '', display_name: '' }); }}
                    className="mt-2 ml-4 text-xs text-accent hover:opacity-80 border border-dashed border-border rounded px-2 py-1">
                    + 添加模型
                  </button>
                )
              )}
            </div>
          );
        })}
      </Section>
      <Section title="添加模型服务">
        <Input placeholder="名称（如 DeepSeek）" value={newP.name} onChange={(e) => setNewP({ ...newP, name: e.target.value })} />
        <Input placeholder="接口地址（https:// 开头）" value={newP.base_url} onChange={(e) => setNewP({ ...newP, base_url: e.target.value })} />
        <Input placeholder="API Key" type="password" value={newP.api_key} onChange={(e) => setNewP({ ...newP, api_key: e.target.value })} />
        {addPError && <p className="text-xs text-danger mt-1">{addPError}</p>}
        <button onClick={addProvider} className="bg-accent text-white px-4 py-2 rounded-lg text-sm mt-2">添加服务</button>
      </Section>
      <Section title="服务器模型">
        {(!globalProviders || globalProviders.length === 0) ? (
          <p className="text-text2 text-sm py-3">服务器端暂无预设模型</p>
        ) : globalProviders.map((p) => (
          <div key={p.id} className="py-3 border-b border-border last:border-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-hover text-text2">共享</span>
              <span className="text-[10px] text-text2 ml-auto">由服务端管理，本机只读</span>
            </div>
            <div className="text-xs text-text2 mt-1 font-mono">{p.base_url}</div>
            {p.models?.length > 0 && (
              <div className="mt-2 space-y-1">
                {p.models.map((m) => {
                  const mid = m.model_id || m.modelId;
                  return (
                    <div key={m.id ?? mid} className="flex items-center gap-1.5 pl-4 text-xs text-text2">
                      <span className="w-1 h-1 rounded-full bg-text2 shrink-0" />
                      <span className="truncate">{m.display_name || mid}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </Section>
    </>
  );
}

// B3：MCP 页 —— 加载时读已连接列表与持久化配置（此前重启后 UI 全丢），逐 server 展示状态
// 工具定义构造与合并统一走 lib/mcpTools.js（Bug3：启动恢复 + 多 server 合并）

// TRAE 风格 MCP 管理页：本地/云端页签 + 服务器行（彩色头像/状态徽章/开关）+「添加 ∨」
// 下拉（从市场添加 / 手动添加）+ MCP 市场弹窗（搜索 + 卡片 + 一键添加）。
function McpTab({ mcpStatus, setMcpStatus, mcpForm, setMcpForm, onMcpToolsChange }) {
  const [connected, setConnected] = useState([]);   // 已连接：[{ name, toolCount }]
  const [saved, setSaved] = useState([]);           // 已保存配置：[{ name, command, args }]
  const [scope, setScope] = useState('local');      // local | cloud（云端托管待后端）
  const [addOpen, setAddOpen] = useState(false);    // 「添加 ∨」下拉
  const [marketOpen, setMarketOpen] = useState(false); // MCP 市场弹窗
  const [manualOpen, setManualOpen] = useState(false); // 手动添加表单
  const [marketKw, setMarketKw] = useState('');

  async function loadServers() {
    try {
      const list = await window.mjcode.mcpListServers?.();
      setConnected(Array.isArray(list) ? list : []);
    } catch (err) {
      console.warn('[settings] MCP 连接列表加载失败:', err);
    }
    try {
      const cfg = await window.mjcode.mcpGetConfig?.();
      if (cfg?.ok) setSaved(cfg.servers || []);
    } catch (err) {
      console.warn('[settings] MCP 配置加载失败:', err);
    }
  }

  useEffect(() => { loadServers(); }, []);

  async function connect(payload) {
    setMcpStatus((s) => ({ ...s, [payload.name]: '连接中...' }));
    try {
      const r = await window.mjcode.mcpConnect(payload);
      setMcpStatus((s) => ({ ...s, [payload.name]: r.ok ? `已连接 · ${r.toolCount} 个工具` : `连接失败：${r.error || '未知错误'}` }));
      if (r.ok && r.tools && onMcpToolsChange) onMcpToolsChange(payload.name, r.tools);
      await loadServers();
      return r;
    } catch (err) {
      setMcpStatus((s) => ({ ...s, [payload.name]: `连接失败：${err.message}` }));
      return { ok: false };
    }
  }

  async function disconnect(name) {
    await window.mjcode.mcpDisconnect({ name });
    setMcpStatus((s) => ({ ...s, [name]: '已断开' }));
    await loadServers();
  }

  // 行合并：持久化配置 ∪ 实时连接态；状态推导 ok / fail / connecting / saved
  const rowMap = new Map();
  for (const s of saved) rowMap.set(s.name, { ...s, toolCount: 0 });
  for (const c of connected) rowMap.set(c.name, { ...(rowMap.get(c.name) || { name: c.name }), toolCount: c.toolCount || 0 });
  const rows = [...rowMap.values()];
  const statusOf = (name) => {
    if (connected.some((c) => c.name === name)) return 'ok';
    const st = mcpStatus[name] || '';
    if (st.includes('连接失败')) return 'fail';
    if (st.includes('连接中')) return 'connecting';
    return 'saved';
  };

  const marketFiltered = MCP_PRESETS.filter((p) => {
    const kw = marketKw.trim().toLowerCase();
    return !kw || p.name.includes(kw) || p.label.toLowerCase().includes(kw) || p.desc.toLowerCase().includes(kw);
  });

  return (
    <Section title="MCP Servers 管理">
      <p className="text-xs text-text2 -mt-1 mb-3">管理你的 MCP 服务器，启用后即可为会话扩展新的工具能力。git 能力也统一经 MCP（mcp-server-git）调用。</p>

      {/* 顶栏：本地/云端页签 + 刷新 + 添加（TRAE 同款布局） */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-hover">
          {[['local', '本地'], ['cloud', '云端']].map(([id, label]) => (
            <button key={id} onClick={() => setScope(id)}
              className={`h-7 px-3 inline-flex items-center rounded-md text-xs ${scope === id ? 'bg-surface text-text border border-border' : 'text-text2 hover:text-text'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex items-center gap-1.5">
          <button onClick={loadServers} title="刷新列表"
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-border hover:bg-hover text-text2 hover:text-text">
            <IconRefresh size={13} />
          </button>
          <button onClick={() => setAddOpen((v) => !v)}
            className="h-8 inline-flex items-center gap-1.5 px-3 rounded-lg bg-accent text-white text-xs hover:opacity-90">
            <IconPlus size={13} /> 添加 <IconChevronDown size={12} />
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} />
              <div className="absolute right-0 top-9 z-20 w-40 py-1 rounded-xl bg-surface border border-border shadow-[var(--shadow-pop)]">
                <button onClick={() => { setAddOpen(false); setMarketOpen(true); }}
                  className="w-full h-8 px-3 flex items-center text-xs hover:bg-hover text-left">从市场添加</button>
                <button onClick={() => { setAddOpen(false); setManualOpen(true); }}
                  className="w-full h-8 px-3 flex items-center text-xs hover:bg-hover text-left">手动添加</button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 服务器行（本地） */}
      {scope === 'local' && (
        rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-text2">
            还没有 MCP 服务器。点击右上角「添加」，从市场一键添加或手动配置。
          </div>
        ) : rows.map((s) => {
          const st = statusOf(s.name);
          const isConnected = st === 'ok';
          return (
            <div key={s.name} className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
              <span className={`w-8 h-8 rounded-lg inline-flex items-center justify-center text-sm font-semibold shrink-0 ${mcpAvatarCls(s.name)}`}>
                {(s.name[0] || 'M').toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm flex items-center gap-2">
                  <span className="truncate">{s.name}</span>
                  {st === 'ok' && (
                    <span className="text-xs text-success inline-flex items-center gap-1 shrink-0"><IconCheck size={12} /> 已连接{s.toolCount ? ` · ${s.toolCount} 工具` : ''}</span>
                  )}
                  {st === 'fail' && (
                    <span className="text-xs text-danger inline-flex items-center gap-1 shrink-0">
                      <IconAlert size={12} /> 连接失败
                      <button onClick={() => connect({ name: s.name, command: s.command, args: s.args || [] })} className="underline hover:opacity-80">重试</button>
                    </span>
                  )}
                  {st === 'connecting' && <span className="text-xs text-text2 shrink-0">连接中…</span>}
                  {st === 'saved' && <span className="text-xs text-text2 shrink-0">未连接</span>}
                </div>
                {s.command && (
                  <div className="text-xs text-text2 font-mono truncate mt-0.5">{s.command} {(s.args || []).join(' ')}</div>
                )}
              </div>
              <Toggle on={isConnected} onChange={() => (isConnected ? disconnect(s.name) : connect({ name: s.name, command: s.command, args: s.args || [] }))} />
            </div>
          );
        })
      )}

      {/* 云端占位（HTTP/SSE 托管待后端支持） */}
      {scope === 'cloud' && (
        <div className="py-10 text-center text-sm text-text2">
          云端 MCP 托管即将上线：远程 HTTP/SSE 服务、统一配额与团队共享将在后端版本提供。
        </div>
      )}

      {/* MCP 市场（从市场添加） */}
      {marketOpen && (
        <div className="fixed inset-0 z-settings flex items-center justify-center bg-overlay" onClick={() => setMarketOpen(false)}>
          <div className="w-[540px] max-h-[72vh] bg-bg border border-border rounded-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold">MCP 市场</h3>
              <button onClick={() => setMarketOpen(false)} className="text-text2 hover:text-text"><IconX size={16} /></button>
            </div>
            <div className="px-5 py-3 border-b border-border">
              <div className="h-8 flex items-center gap-2 px-3 rounded-lg border border-border">
                <IconSearch size={14} className="text-text2" />
                <input value={marketKw} onChange={(e) => setMarketKw(e.target.value)} placeholder="搜索 MCP 服务器"
                  className="flex-1 bg-transparent text-sm outline-none" />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
              {marketFiltered.length === 0 && <p className="text-sm text-text2 text-center py-6">暂无匹配的 MCP 服务器</p>}
              {marketFiltered.map((p) => {
                const added = saved.some((s) => s.name === p.name);
                const st = statusOf(p.name);
                return (
                  <div key={p.name} className="flex items-center gap-3 py-3 border-b border-border last:border-0">
                    <span className={`w-9 h-9 rounded-lg inline-flex items-center justify-center text-sm font-semibold shrink-0 ${mcpAvatarCls(p.name)}`}>
                      {p.name[0].toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm flex items-center gap-2">
                        <span className="truncate">{p.label}</span>
                        {st === 'ok' && <span className="text-xs text-success inline-flex items-center gap-0.5 shrink-0"><IconCheck size={12} /></span>}
                        {st === 'fail' && <span className="text-xs text-danger inline-flex items-center gap-0.5 shrink-0"><IconAlert size={12} /></span>}
                        <span className="text-[10px] px-1.5 py-[2px] leading-none rounded bg-hover text-text2 shrink-0">Local</span>
                      </div>
                      <p className="text-xs text-text2 mt-0.5 line-clamp-2">{p.desc}</p>
                    </div>
                    {added ? (
                      <span className="text-xs text-text2 shrink-0 px-2">已添加</span>
                    ) : (
                      <button onClick={() => connect(p)} disabled={statusOf(p.name) === 'connecting'}
                        title="添加并连接"
                        className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-border hover:bg-hover shrink-0 disabled:opacity-40">
                        <IconPlus size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-2.5 border-t border-border text-xs text-text2">
              连接失败多因本机缺少运行时（npx/uvx）或包首次下载超时，可稍后重试。
            </div>
          </div>
        </div>
      )}

      {/* 手动添加 */}
      {manualOpen && (
        <div className="mt-3 p-3 rounded-xl border border-border bg-surface">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text2">手动添加本地 stdio 服务器</span>
            <button onClick={() => setManualOpen(false)} className="text-text2 hover:text-text"><IconX size={14} /></button>
          </div>
          <Input placeholder="名称（如 my-server）" value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} />
          <Input placeholder="启动命令（如 npx / uvx）" value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} />
          <Input placeholder="参数（空格分隔，如 -y @org/pkg-mcp）" value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} />
          <button
            onClick={async () => {
              const r = await connect({ name: mcpForm.name, command: mcpForm.command, args: mcpForm.args.split(' ').filter(Boolean) });
              if (r?.ok) setManualOpen(false);
            }}
            disabled={!mcpForm.name || !mcpForm.command}
            className="h-8 inline-flex items-center justify-center px-4 rounded-lg bg-accent text-white text-sm mt-1 disabled:opacity-40">连接并保存</button>
          <p className="text-xs text-text2 mt-2">远程 URL（HTTP/SSE）接入将随云端 MCP 托管一并支持。</p>
        </div>
      )}
    </Section>
  );
}

// 服务器头像配色：按名称哈希从语义色板中取色，同名单稳定
const MCP_AVATAR_CLS = [
  'bg-accent/15 text-accent',
  'bg-[var(--sem-success-bg)] text-success',
  'bg-[var(--sem-warn-bg)] text-warn',
  'bg-[var(--sem-info-bg)] text-info',
];
function mcpAvatarCls(name) {
  const h = [...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return MCP_AVATAR_CLS[h % MCP_AVATAR_CLS.length];
}

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <h2 className="text-base font-semibold mb-3">{title}</h2>
      <div className="bg-surface border border-border rounded-2xl px-5">{children}</div>
    </div>
  );
}

// A7：已授权规则列表 —— 「始终允许」必须可见可撤销（此前授予后全应用无任何管理界面）
const RULE_LEVEL_META = {
  L1: { label: '危险命令', cls: 'text-danger' },
  L2: { label: '文件写入', cls: 'text-warn' },
  L3: { label: 'MCP 工具', cls: 'text-info' },
};

function ApprovalRulesSection() {
  const [rules, setRules] = useState([]);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    if (!window.mjcode?.listApprovalRules) return;
    try {
      const r = await window.mjcode.listApprovalRules();
      if (r?.ok) setRules(r.rules || []);
    } catch (err) {
      console.warn('[settings] 审批规则加载失败:', err);
    }
    setLoaded(true);
  }

  useEffect(() => { load(); }, []);

  async function revoke(rule) {
    if (!window.mjcode?.deleteApprovalRule) return;
    const r = await window.mjcode.deleteApprovalRule({ id: rule.id });
    if (r?.ok) load();
  }

  return (
    <Section title="已授权规则（始终允许）">
      {!loaded ? (
        <p className="text-text2 text-xs py-3">加载中…</p>
      ) : rules.length === 0 ? (
        <p className="text-text2 text-xs py-3">
          暂无规则。在审批弹窗中选择「始终允许」后，对应工具与范围会出现在这里，可随时撤销。
        </p>
      ) : (
        rules.map((rule) => {
          const meta = RULE_LEVEL_META[rule.level] || RULE_LEVEL_META.L2;
          return (
            <div key={rule.id} className="py-3 border-b border-border last:border-0 flex items-center gap-3">
              <span className={`text-xs shrink-0 ${meta.cls}`}>{meta.label}</span>
              <span className="text-xs font-mono shrink-0">{rule.tool}</span>
              <span className="text-xs text-text2 truncate flex-1 font-mono" title={rule.pattern}>
                {rule.pattern || '（全部）'}
              </span>
              {rule.createdAt && (
                <span className="text-[10px] text-text2 shrink-0">{new Date(rule.createdAt).toLocaleString('zh-CN')}</span>
              )}
              <button onClick={() => revoke(rule)} className="text-xs text-danger shrink-0">撤销</button>
            </div>
          );
        })
      )}
    </Section>
  );
}

// 账户页：版本更新 + 审计日志
function AccountTab({ flags }) {
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateError, setUpdateError] = useState('');
  // P1-N：检查失败/发现新版本时的手动下载兜底链接（由主进程 build.publish 推导）
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState('');
  const [logs, setLogs] = useState([]);
  const [logsError, setLogsError] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindMsg, setBindMsg] = useState('');
  const [bindErr, setBindErr] = useState('');
  const [mpEnabled, setMpEnabled] = useState(false);
  // ST6：审计日志按动作类型筛选 + 分页展示（此前 100 条堆在一个滚动容器里无任何筛选）
  const [actionFilter, setActionFilter] = useState('');
  const [shown, setShown] = useState(50);

  // 小程序控制面默认停用（M6 + 战略收敛）：桌面端开关与服务端开关双重 fail-closed
  useEffect(() => {
    loadFeatures().then((f) => {
      const desktopEnabled = flags ? flags.miniprogram === true : false;
      setMpEnabled(desktopEnabled && !!f.miniprogram);
    }).catch(() => setMpEnabled(false));
  }, [flags]);

  async function confirmBind() {
    setBindMsg(''); setBindErr('');
    const code = bindCode.trim().toUpperCase();
    if (!code) { setBindErr('请输入小程序展示的绑定码'); return; }
    try {
      const r = await api.confirmMpBind(code);
      if (r && r.ok) setBindMsg('绑定成功，小程序端已可登录查看云端任务');
      else setBindErr('确认失败，请检查绑定码是否正确或是否已过期');
    } catch (err) {
      setBindErr(err.message || '确认失败');
    }
  }

  useEffect(() => {
    if (!window.mjcode?.onUpdaterStatus) return;
    const off = window.mjcode.onUpdaterStatus((d) => {
      const map = {
        checking: '正在检查更新...',
        available: `发现新版本 ${d.version || ''}`,
        'up-to-date': '已是最新版本',
        downloading: `下载中 ${d.percent || 0}%`,
        downloaded: '更新已就绪，重启后安装',
        error: `检查失败：${d.message || '未知错误'}`,
      };
      setUpdateStatus(map[d.status] || d.status);
      setUpdateError('');
      // P1-N：error/available 态携带手动下载链接（自动更新链路失败时的降级出口）
      setUpdateDownloadUrl((d.status === 'error' || d.status === 'available') ? (d.downloadUrl || '') : '');
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  async function check() {
    setUpdateStatus('检查中...');
    setUpdateError('');
    try {
      const r = await window.mjcode.checkUpdates();
      if (!r.ok) {
        setUpdateError(r.error || '检查失败');
        setUpdateDownloadUrl(r.downloadUrl || ''); // P1-N：手动检查失败同样给降级链接
      }
    } catch (err) {
      setUpdateError(err.message);
    }
  }

  async function install() {
    try { await window.mjcode.installUpdate(); } catch (err) { setUpdateError(err.message); }
  }

  async function loadLogs() {
    setLogsError('');
    try {
      setLogs(await api.auditLog());
    } catch (err) {
      console.warn('[settings] 审计日志加载失败:', err);
      setLogsError('审计日志加载失败');
    }
  }

  useEffect(() => { loadLogs(); }, []);

  return (
    <>
      {/* P1-F：退出登录入口（仅在线登录态显示）。此前 401 只会清 localStorage 却无主动
          退出出口，用户只能手动清数据。退出后本机数据保留，可重登或走离线模式。 */}
      {localStorage.getItem('mj_token') && (
        <Section title="账户">
          <div className="py-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">退出登录</div>
              <div className="text-xs text-text2 mt-1">退出后本机数据仍保留，可重新登录或以离线模式继续使用。</div>
            </div>
            <button
              onClick={() => { localStorage.removeItem('mj_token'); window.dispatchEvent(new Event('auth-changed')); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-danger text-danger hover:bg-danger-bg"
            >
              退出登录
            </button>
          </div>
        </Section>
      )}
      <Section title="版本更新">
        <div className="py-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">检查更新</div>
            <div className="text-xs text-text2 mt-1">自动更新仅在打包发布后可用（需在构建配置中设置发布仓库）</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={check} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">检查更新</button>
            {updateStatus === '更新已就绪，重启后安装' && (
              <button onClick={install} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white">重启安装</button>
            )}
          </div>
        </div>
        {(updateStatus || updateError) && (
          <div className="pb-3 text-xs text-text2">
            {updateError || updateStatus}
            {/* P1-N：手动下载兜底——自动更新失败时用户可自行前往 Releases 页下载 */}
            {updateDownloadUrl && (
              <a href={updateDownloadUrl} target="_blank" rel="noreferrer"
                className="ml-2 text-accent underline" title={updateDownloadUrl}>
                手动下载最新版本
              </a>
            )}
          </div>
        )}
      </Section>
      {mpEnabled && (
      <Section title="设备绑定（微信小程序）">
        <div className="py-4">
          <div className="text-sm font-medium">关联微信小程序</div>
          <div className="text-xs text-text2 mt-1 mb-3">
            在微信小程序「MJ Code 控制台」点击微信登录后，会显示一组 8 位绑定码。在此输入该绑定码并确认，即可将该小程序绑定到当前桌面账户，之后可在手机上查看与审批云端任务。
          </div>
          <div className="flex items-center gap-2">
            <input
              value={bindCode}
              onChange={(e) => setBindCode(e.target.value)}
              placeholder="输入 8 位绑定码"
              maxLength={8}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-bg text-sm font-mono tracking-widest uppercase"
            />
            <button onClick={confirmBind} className="text-xs px-3 py-2 rounded-lg bg-accent text-white">确认绑定</button>
          </div>
          {bindMsg && <div className="pb-1 mt-2 text-xs text-success">{bindMsg}</div>}
          {bindErr && <div className="pb-1 mt-2 text-xs text-danger">{bindErr}</div>}
        </div>
      </Section>
      )}
      <Section title="审计日志（最近 100 条）">
        {logsError ? (
          <p className="text-text2 text-sm py-4">{logsError}</p>
        ) : logs.length === 0 ? (
          <p className="text-text2 text-sm py-4">暂无记录。工具执行（命令/文件写入/Git/MCP）将在此留存脱敏审计。</p>
        ) : (
          <>
            {/* ST6：动作类型筛选（客户端过滤，选项由现有记录去重生成） */}
            <div className="flex items-center gap-2 pb-2">
              <select value={actionFilter}
                onChange={(e) => { setActionFilter(e.target.value); setShown(50); }}
                className="bg-bg border border-border rounded-lg px-2 py-1 text-xs">
                <option value="">全部动作（{logs.length} 条）</option>
                {[...new Set(logs.map((l) => l.action))].sort().map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              {actionFilter && (
                <span className="text-xs text-text2">筛选出 {logs.filter((l) => l.action === actionFilter).length} 条</span>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {logs.filter((l) => !actionFilter || l.action === actionFilter).slice(0, shown).map((l) => (
                <div key={l.id} className="py-2 border-b border-border last:border-0 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-accent">{l.action}</span>
                    {l.approval_result && l.approval_result !== 'auto' && (
                      <span className={l.approval_result === 'denied' ? 'text-danger' : 'text-warn'}>{l.approval_result}</span>
                    )}
                    <span className="text-text2 ml-auto">{new Date(l.created_at).toLocaleString('zh-CN')}</span>
                  </div>
                  {l.target && <div className="text-text2 font-mono mt-0.5 truncate" title={l.target}>{l.target}</div>}
                  {l.detail && <div className="text-text2 mt-0.5">{l.detail}</div>}
                </div>
              ))}
              {logs.filter((l) => !actionFilter || l.action === actionFilter).length > shown && (
                <button onClick={() => setShown((v) => v + 50)}
                  className="w-full py-2 text-xs text-text2 hover:text-text">
                  加载更多（还有 {logs.filter((l) => !actionFilter || l.action === actionFilter).length - shown} 条）
                </button>
              )}
            </div>
          </>
        )}
      </Section>
    </>
  );
}

function OptionRow({ name, desc, selected, warn, onSelect }) {
  return (
    <button onClick={onSelect}
      className="w-full text-left py-4 border-b border-border last:border-0 flex items-start gap-3 hover:bg-hover -mx-5 px-5">
      <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${selected ? 'border-accent' : 'border-border'}`}>
        {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
      </span>
      <span className="flex-1">
        <span className="text-sm font-medium flex items-center gap-2">
          {name}
          {warn && <IconAlert size={14} className="text-danger" />}
        </span>
        <span className="block text-xs text-text2 mt-1 leading-relaxed">{desc}</span>
      </span>
    </button>
  );
}

function Toggle({ on, onChange }) {
  // ST8：关闭态轨道由 bg-text2（灰字灰底难辨）改为 bg-hover + 边框
  return (
    <button onClick={onChange} role="switch" aria-checked={on} className={`w-11 h-6 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-hover border border-border'} relative`}>
      <div className={`absolute w-5 h-5 rounded-full bg-white top-0.5 transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

function Input({ placeholder, value, onChange, type = 'text' }) {
  return (
    <input placeholder={placeholder} value={value} onChange={onChange} type={type}
      className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm my-1 outline-none focus:border-accent" />
  );
}
