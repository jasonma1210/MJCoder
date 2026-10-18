import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import TeamSpace from './TeamSpace';
import EcosystemModal from './EcosystemModal';
import { confirm } from './feedback';
import InlineAlert from './InlineAlert';
import RecordReplayPanel from './RecordReplayPanel';
import UpdateSection from './UpdateSection';
import MemorySection from './MemorySection';
import { IconAlert, IconCheck, IconCpu, IconGitBranch, IconGlobe, IconPalette, IconSettings, IconUser, IconX } from './icons';
import Switch from './ui/Switch';
import Modal from './ui/Modal';
import THEMES from '../lib/themes.json';
import ACCENT_CHOICES from '../lib/accentColors.json';
import { applyAccent } from '../lib/color';

// 权限档位统一常量源（A10）：Composer 与设置页共用，禁止各自维护值域
import { APPROVAL_MODES, SANDBOX_MODES, migrateApprovalMode } from '../constants/approval';
import { getLinkOpenMode, setLinkOpenMode } from '../lib/linkOpen';
import { useI18n } from '../i18n';

// 导航分组对齐 WorkBuddy：设置（外观与模型）/ 功能（能力开关与集成）/ 账户与安全（数据与更新）
// 顺序纪律：每个 id 必须在正文里有对应实现——曾经 browser / git 只登记在导航里、
// 正文没有分支，点进去只有标题和空白（「假可用」比不显示入口更伤信任）。
const NAV = [
  { groupKey: 'settings.navGroupSettings', items: [
    { id: 'general', icon: <IconSettings size={16} />, labelKey: 'settings.tabGeneral' },
    { id: 'appearance', icon: <IconPalette size={16} />, labelKey: 'settings.tabAppearance' },
    { id: 'models', icon: <IconCpu size={16} />, labelKey: 'settings.tabModels' },
  ]},
  { groupKey: 'settings.navGroupFeatures', items: [
    { id: 'ecosystem', icon: <IconUser size={16} />, labelKey: 'settings.tabEcosystem' },
    { id: 'network', icon: <IconGlobe size={16} />, labelKey: 'settings.tabNetwork' },
    { id: 'browser', icon: <IconGlobe size={16} />, labelKey: 'settings.tabBrowser' },
    { id: 'git', icon: <IconGitBranch size={16} />, labelKey: 'settings.tabGit' },
    { id: 'teamspace', icon: <IconGitBranch size={16} />, labelKey: 'settings.tabTeamSpace' },
  ]},
];

// 链接打开方式：设置项必须真正生效——预览栏里的 Markdown 链接按此策略分发，
// 否则「设置里能选、行为上没区别」等于假开关。
export const LINK_OPEN_OPTIONS = [
  { id: 'smart', nameKey: 'settings.linkSmart', descKey: 'settings.linkSmartDesc' },
  { id: 'system', nameKey: 'settings.linkSystem', descKey: 'settings.linkSystemDesc' },
  { id: 'copy', nameKey: 'settings.linkCopy', descKey: 'settings.linkCopyDesc' },
];

// OS 级沙箱后端 → 标签。用于未就绪时如实告诉用户「本平台本该有哪种隔离」，
// 而不是笼统地说「你的系统不支持」（三平台后端清单见 main/sandbox.js 的 detectBackend）
// T3-2：渲染期经 t 解析，避免顶层常量冻结翻译
function sandboxBackendLabel(backend, t) {
  switch (backend) {
    case 'seatbelt': return t('settings.backendSeatbelt');
    case 'bubblewrap': return t('settings.backendBubblewrap');
    case 'windows-restricted-user': return t('settings.backendWindowsRestricted');
    case 'none': return t('settings.backendNone');
    default: return t('settings.backendUnknown');
  }
}

export default function SettingsModal({
  onClose, providers, onProvidersChange,
  theme, onThemeChange, globalProviders, onSkillsChange,
  approvalSettings, onApprovalSettingsChange,
  enabledSkills,
  autoDecompose, onAutoDecomposeChange,
  projectPath = '',
}) {
  const { locale, setLocale, t } = useI18n();
  const [tab, setTab] = useState('general');
  const [search, setSearch] = useState('');
  // ST3：插件/生态已内嵌到对应 Tab，弹窗态状态移除
  const [newP, setNewP] = useState({ name: '', base_url: '', api_key: '' });
  const [addPError, setAddPError] = useState(''); // ST4：添加服务前置校验错误
  const [accentVer, setAccentVer] = useState(0); // TH5：强调色变更触发重渲染
  // 桌面端功能开关（fail-closed）：协同冻结时隐藏团队空间入口
  const [flags, setFlags] = useState(null);
  const sandbox = approvalSettings?.sandbox_policy || 'workspace-write';
  // P0-F：沙箱能力状态（无 OS 级沙箱时明示兜底边界）
  const [sandboxStatus, setSandboxStatus] = useState(null);
  // A10：读取时迁移遗留值（auto → auto-safe、always-ask → always）
  const approvalMode = migrateApprovalMode(approvalSettings?.approval_mode);

  // TH5：强调色备选（null = 跟随主题默认）；色值常量在 lib/accentColors.js
  // （ui-conventions 基线：组件文件零十六进制硬编码色）
  // 2026-10-17：改写统一走 lib/color.applyAccent —— 必须 hex + rgb 双写，
  // 否则换色后所有 `bg-accent/10`、`border-accent/40` 会重新失效。
  function setAccent(color) {
    try {
      if (color) localStorage.setItem('mj_accent', color);
      else localStorage.removeItem('mj_accent');
      applyAccent(color);
      setAccentVer((v) => v + 1);
    } catch (e) { console.warn('[settings] failed to apply accent color:', e); }
  }

  // Esc 关闭设置：主窗口无系统标题栏，Esc 是唯一「不用找按钮」的退出路径。
  // P1-9⑤ 换壳后该职责移交给 ui/Modal（它同时带焦点陷阱与「别的对话框正在接管键盘时让路」
  // 的判断）——此处不再自挂 window 监听，否则命令式 confirm 弹窗里按 Esc 会把设置页一起关掉。

  useEffect(() => {
    window.mjcode?.getFlags?.()
      .then((r) => { if (r?.ok) setFlags(r.flags); })
      .catch((err) => console.warn('[settings] failed to load feature flags:', err));
  }, []);

  useEffect(() => {
    window.mjcode?.sandboxStatus?.()
      .then((r) => { if (r?.ok) setSandboxStatus(r); })
      .catch((err) => console.warn('[settings] failed to load sandbox status:', err));
  }, []);

  // 战略收敛：collab 冻结时隐藏团队空间导航项
  const nav = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !(i.id === 'teamspace' && flags && flags.collab === false)) }))
    .filter((g) => g.items.length > 0);

  // ST4：接口地址必须是合法 http(s) URL（此前任意字符串都能提交，填错只能等调用时报错）
  function isValidHttpUrl(s) {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }

  async function addProvider() {
    if (!newP.name || !newP.base_url) { setAddPError(t('settings.nameAndUrlRequired')); return; }
    const url = newP.base_url.trim();
    if (!isValidHttpUrl(url)) { setAddPError(t('settings.urlMustBeHttp')); return; }
    if (!newP.api_key || !String(newP.api_key).trim()) { setAddPError(t('settings.apiKeyRequired')); return; }
    setAddPError('');
    try {
      await api.addProvider({ ...newP, base_url: url });
      setNewP({ name: '', base_url: '', api_key: '' });
      onProvidersChange();
    } catch (err) {
      // 此前裸 await：主进程报错（如打包版 safeStorage 不可用）时 Promise 静默失败，UI 毫无反馈
      setAddPError(t('settings.saveFailedError', { error: err?.message || t('settings.unknownError') }));
    }
  }

  // 平台相关关闭按钮（用户要求按系统环境定义）：macOS 沿用交通灯语义（左上红点），
  // Windows/Linux 沿用窗口按钮语义（右上 X）。主窗口仍为 hiddenInset，浮窗化后
  // 系统交通灯回到背景窗口左上角，不再与设置页内容重叠，原拖拽安全区随之移除。
  // 关闭入口统一为右上角 X：此前 macOS 分支自绘了一枚 12px 红点模拟系统交通灯，
  // 既与窗口真实的交通灯（左上角、属于主窗口）语义重复，也和后端平台分支行为不一致。
  // 现在两个平台同一处、同一交互（Esc 亦可关闭）。

  return (
    <Modal open onClose={onClose} frameless
      ariaLabel={t('settings.navGroupSettings')}
      // 外壳类名刻意在本文件里写全（不在调用方「调参」）：settings-coverage.test.js
      // 对本文件有源码字符串断言（浮窗形态 + shadow-modal），且本文件保留自己的表头关闭按钮，
      // 因此这里是「只换外壳、内容与视觉零改动」——面板块仍是下面这层自带类。
      overlayClassName="fixed inset-0 z-settings flex items-center justify-center bg-overlay p-6">
      <div className="w-[min(920px,calc(100vw-3rem))] h-[min(680px,calc(100vh-3rem))] bg-bg border border-border rounded-2xl shadow-[var(--shadow-modal)] flex overflow-hidden relative">
        <button onClick={onClose}
          className="absolute top-3 right-3 z-10 text-text2 hover:text-text p-1.5 rounded-lg hover:bg-hover"
          title={t('settings.closeSettingsEsc')} aria-label={t('settings.closeSettings')}>
          <IconX size={16} />
        </button>

        {/* 左侧导航 */}
        <div className="w-[clamp(196px,24%,240px)] border-r border-border flex flex-col shrink-0">
          <div className="h-3 shrink-0" />
          <div className="px-4 pb-4 flex flex-col flex-1 min-h-0">
            <input placeholder={t('settings.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm mb-4 outline-none shrink-0" />
            <div className="flex-1 min-h-0 overflow-y-auto">
              {nav.map((group) => {
                const items = group.items.filter(i => !search || t(i.labelKey).includes(search));
                if (!items.length) return null;
                return (
                  <div key={group.groupKey} className="mb-4">
                    <div className="text-xs text-text2 px-2 mb-1">{t(group.groupKey)}</div>
                    {items.map((item) => (
                      <button key={item.id} onClick={() => setTab(item.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-0.5 ${tab === item.id ? 'bg-surface text-text' : 'text-text2 hover:bg-hover'}`}>
                        <span className="shrink-0">{item.icon}</span> {t(item.labelKey)}
                      </button>
                    ))}
                  </div>
                );
              })}
              {nav.every(g => !g.items.filter(i => !search || t(i.labelKey).includes(search)).length) && (
                <p className="text-xs text-text2 px-2 py-3">{t('settings.noSearchMatch', { q: search })}</p>
              )}
            </div>
          </div>
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-8">
          <h1 className="text-xl font-semibold mb-5">
            {t(nav.flatMap(g => g.items).find(i => i.id === tab)?.labelKey || 'settings.navGroupSettings')}
          </h1>

        {/* 通用 */}
        {tab === 'general' && (
          <>
            <Section title={t('settings.language')}>
              <div className="flex items-center justify-between gap-4 py-3">
                <p className="text-xs text-text2 min-w-0">{t('settings.languageDesc')}</p>
                <select value={locale} onChange={(e) => setLocale(e.target.value)}
                  className="bg-input border border-border rounded-lg px-3 py-1.5 text-sm outline-none shrink-0">
                  <option value="zh-CN">简体中文</option>{/* i18n-literal */}
                  <option value="en-US">English</option>{/* i18n-literal */}
                </select>
              </div>
            </Section>
            <Section title={t('settings.sandboxPolicy')}>
              {SANDBOX_MODES.map((o) => (
                <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)} selected={sandbox === o.id} warn={o.id === 'full-access'}
                  onSelect={async () => {
                    // P1-3 修复（2026-10-17）：full-access 一次性关停四层守卫（OS 沙箱 /
                    // 写白名单 / 受保护路径 carve-out / 非沙箱执行审批联动），此前无二次确认——
                    // 而 never 档（自动执行）有确认，治理强度倒挂：更危险的选择反而更易触发。
                    // 现与 never 档同强度：confirm({ danger: true }) 二次确认，文案走 i18n。
                    if (o.id === 'full-access' && sandbox !== 'full-access') {
                      const ok = await confirm({
                        title: t('settings.switchToFullAccessTitle'),
                        message: t('settings.switchToFullAccessMessage'),
                        danger: true,
                        confirmLabel: t('settings.enableFullAccessLabel'),
                      });
                      if (!ok) return;
                    }
                    onApprovalSettingsChange?.({ ...approvalSettings, sandbox_policy: o.id });
                  }} />
              ))}
              {sandboxStatus && !sandboxStatus.available && (
                <div className="mt-3">
                  <InlineAlert type="warn">
                    <p className="font-medium">{t('settings.sandboxNotReady', { backend: sandboxBackendLabel(sandboxStatus?.backend, t) })}</p>
                    {sandboxStatus?.hint && <p className="mt-1 text-text2">{sandboxStatus.hint}</p>}
                    <p className="mt-1 text-text2">{t('settings.sandboxFallbackNote')}</p>
                  </InlineAlert>
                </div>
              )}
            </Section>
            <Section title={t('settings.approvalMode')}>
              {APPROVAL_MODES.map((o) => (
                <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)} selected={approvalMode === o.id} warn={o.id === 'never'}
                  onSelect={async () => {
                    // 第 8 节：档位 = never 需二次确认（自动执行有数据丢失风险）
                    if (o.id === 'never' && approvalMode !== 'never') {
                      const ok = await confirm({
                        title: t('settings.switchToAutoTitle'),
                        message: t('settings.switchToAutoMessage'),
                        danger: true,
                        confirmLabel: t('settings.enableAutoLabel'),
                      });
                      if (!ok) return;
                    }
                    onApprovalSettingsChange?.({ ...approvalSettings, approval_mode: o.id });
                  }} />
              ))}
            </Section>
            {/* P2-7（第二轮审查：「修了却对用户不可见」的那一项）：
                主进程早已在放行动作完成后广播 `approval_notice`，但渲染层零消费方、
                设置页也没有开关 —— 机制全对、用户完全看不到。这里补上开关；
                提示的渲染挂在 feedback.jsx 的 FeedbackHost（项目统一提示出口）。 */}
            <Section title={t('settings.approvalNotice')}>
              <div className="flex items-start justify-between gap-3 py-2">
                <p className="text-xs text-text2 leading-relaxed flex-1">{t('settings.approvalNoticeDesc')}</p>
                <Switch
                  checked={approvalSettings?.approval_notice === true}
                  onChange={(v) => onApprovalSettingsChange?.({ ...approvalSettings, approval_notice: v })}
                  label={t('settings.approvalNotice')}
                />
              </div>
            </Section>
            <p className="text-text2 text-xs">{t('settings.approvalSnapshotNote')}</p>
            <ApprovalRulesSection />
            <Section title={t('settings.taskDecompose')}>
              <div className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <div className="text-sm">{t('settings.autoDecomposeLabel')}</div>
                  <p className="text-xs text-text2 mt-0.5">{t('settings.autoDecomposeDesc')}</p>
                </div>
                <Toggle on={autoDecompose} onChange={() => onAutoDecomposeChange?.(!autoDecompose)}
                  label={t('settings.autoDecomposeLabel')} />
              </div>
            </Section>
            <UpdateSection />
            {/* P0-2：记忆管理（统计/后台任务/列表/自动沉淀开关）——随常规设置页展示 */}
            <MemorySection projectPath={projectPath} />
          </>
        )}

        {/* 外观 */}
        {tab === 'appearance' && (
          <>
            <Section title={t('settings.themeTitle')}>
              {/* TH4：三色条组合预览（bg/surface/accent）+ hover 实时预览，离开未选中的自动恢复 */}
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(96px,1fr))]">
                {THEMES.map((th) => (
                  <button key={th.id}
                    onClick={() => onThemeChange(th.id)}
                    onMouseEnter={(e) => document.documentElement.setAttribute('data-theme', th.id)}
                    onMouseLeave={(e) => document.documentElement.setAttribute('data-theme', theme)}
                    className={`p-3 rounded-xl border-2 text-center ${theme === th.id ? 'border-accent' : 'border-border'}`}>
                    <div className="w-12 h-12 rounded-lg mx-auto mb-2 border border-border overflow-hidden flex" title={`${th.swatch?.bg || th.color} / ${th.swatch?.accent || ''}`}>
                      <span className="w-1/3 h-full" style={{ background: th.swatch?.bg || th.color }} />
                      <span className="w-1/3 h-full" style={{ background: th.swatch?.surface || th.color }} />
                      <span className="w-1/3 h-full" style={{ background: th.swatch?.accent || th.color }} />
                    </div>
                    <div className="text-xs">{t(th.nameKey)}</div>
                  </button>
                ))}
              </div>
              <p className="text-text2 text-xs mt-2">{t('settings.themePreviewNote')}</p>
            </Section>
            {/* TH5：强调色（覆盖主题 accent，持久化于 mj_accent） */}
            <Section title={t('settings.accentTitle')}>
              <div className="flex items-center gap-2.5 flex-wrap">
                {ACCENT_CHOICES.map((a) => {
                  const c = a.value;
                  const current = accentVer >= 0 ? localStorage.getItem('mj_accent') : null;
                  const active = (c || null) === (current || null);
                  return (
                    <button key={c || 'default'} onClick={() => setAccent(c)}
                      title={t(a.labelKey)}
                      className={`w-8 h-8 rounded-full border-2 flex items-center justify-center ${active ? 'border-accent' : 'border-border'}`}
                      style={c ? { background: c } : undefined}>
                      {active && <IconCheck size={14} className={c ? 'text-white' : 'text-accent'} />}
                      {!c && <span className="text-caption text-text2">{t('settings.accentDefault')}</span>}
                    </button>
                  );
                })}
              </div>
              <p className="text-text2 text-xs mt-2">{t('settings.accentNote')}</p>
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

        {/* 网络配置 */}
        {tab === 'network' && <NetworkTab />}

        {/* 生态中心（M7）：唯一管理入口（技能/MCP 已由设置页迁入，统一入口重构 T3） */}
        {tab === 'ecosystem' && (
          <EcosystemModal embedded enabledSkills={enabledSkills} onSkillsChange={onSkillsChange} />
        )}

        {/* 团队空间（P5）：看板 + 共享审批；战略收敛后默认冻结（flags.collab === false 时隐藏） */}
        {flags?.collab !== false && tab === 'teamspace' && <TeamSpace spaceId="default" />}

        {/* 插件市场入口已于 0.1.0-beta 移除：市场页从设置里整体下线，
            连接器/技能统一走侧栏「生态中心」（其目录 + 自定义连接器已覆盖同类需求）。 */}

        {/* 浏览器与链接：链接打开策略（真正生效）+ 计算机使用（CUA）能力边界 */}
        {tab === 'browser' && <BrowserTab flags={flags} />}

        {/* Git 与 GitHub：环境只读探测 + 集成状态 + 审批边界说明 */}
        {tab === 'git' && <GitTab projectPath={projectPath} />}
        </div>
      </div>
    </Modal>
  );
}

// 浏览器与链接（真机反馈：此页此前只有导航项、点进去是空白）
// 内容 = 「链接怎么打开」+「能不能操作界面」两件事的真实开关与能力边界
function BrowserTab({ flags }) {
  const { t } = useI18n();
  const [linkMode, setLinkMode] = useState(getLinkOpenMode);
  const [cua, setCua] = useState(null);

  useEffect(() => {
    window.mjcode?.cuaStatus?.()
      .then((r) => setCua(r))
      .catch((err) => { console.warn('[settings] CUA status probe failed:', err); setCua({ available: false, message: t('settings.probeFailed') }); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Section title={t('settings.linkOpenTitle')}>
        {LINK_OPEN_OPTIONS.map((o) => (
          <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)} selected={linkMode === o.id}
            onSelect={() => { setLinkMode(o.id); setLinkOpenMode(o.id); }} />
        ))}
        <p className="text-text2 text-xs mt-2">
          {t('settings.linkOpenNote')}
        </p>
      </Section>

      <Section title={t('settings.inAppBrowsingTitle')}>
        <p className="text-text2 text-sm">
          {t('settings.inAppBrowsingDesc')}
        </p>
      </Section>

      <Section title={t('settings.computerUseTitle')}>
        {!cua && <p className="text-text2 text-sm">{t('settings.detectingPermission')}</p>}
        {cua && (
          <div className="py-2">
            <div className="flex items-center gap-2">
              <span className={`text-sm ${cua.granted ? 'text-success' : 'text-warn'}`}>
                {cua.available === false ? t('settings.cuaUnsupported') : (cua.granted ? t('settings.cuaGranted') : t('settings.cuaMissingPermission'))}
              </span>
              {cua.available === false && flags?.cua === false && (
                <span className="text-xs text-text2">{t('settings.cuaFlagOff')}</span>
              )}
            </div>
            {cua.message && <p className="text-text2 text-xs mt-1">{cua.message}</p>}
            <p className="text-text2 text-xs mt-2">
              {t('settings.computerUseNote')}
            </p>
            {/* T4-6：操作录制与回放（权限授予后可用；数据仅存本机） */}
            <RecordReplayPanel granted={cua.granted && cua.available !== false} />
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
  const { t } = useI18n();
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
        console.warn('[settings] Git environment probe failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  const name = cfg?.repoName || cfg?.globalName || '';
  const email = cfg?.repoEmail || cfg?.globalEmail || '';
  const scoped = cfg?.repoName ? t('settings.gitScopeRepo') : (cfg?.globalName ? t('settings.gitScopeGlobal') : '');

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
      <Section title={t('settings.gitEnvTitle')}>
        {!cfg && <p className="text-text2 text-sm">{t('settings.detecting')}</p>}
        {cfg && (
          <>
            <Row label={t('settings.gitExecutable')} value={cfg.available ? t('settings.installed') : t('settings.notFound')} tone={cfg.available ? 'text-success' : 'text-danger'}
              hint={cfg.version || t('settings.gitMissingHint')} />
            <Row label={t('settings.commitSigning')} value={name ? (scoped ? t('settings.gitSignedAs', { name, scope: scoped }) : name) : t('settings.gitNotConfigured')}
              tone={name ? 'text-text2' : 'text-warn'}
              hint={name
                ? (email || t('settings.gitNoEmail'))
                : t('settings.gitNoUserHint')} />
            <Row label={t('settings.gitDetectDir')} value="" hint={cfg.cwd} />
          </>
        )}
      </Section>

      <Section title={t('settings.githubIntegrationTitle')}>
        {!gh && <p className="text-text2 text-sm">{t('settings.detecting')}</p>}
        {gh && (
          <>
            <Row label="GitHub CLI" value={gh.available ? t('settings.installed') : t('settings.ghNotInstalled')} tone={gh.available ? 'text-success' : 'text-warn'} />
            {gh.available && (
              <Row label={t('settings.loginStatus')} value={gh.authed ? t('settings.loggedIn') : t('settings.loggedOut')} tone={gh.authed ? 'text-success' : 'text-warn'} />
            )}
            {gh.hint && <p className="text-xs text-text2 mt-2">{gh.hint}</p>}
            <p className="text-text2 text-xs mt-2">
              {t('settings.githubNote')}
            </p>
          </>
        )}
      </Section>

      <Section title={t('settings.writeBoundaryTitle')}>
        <p className="text-text2 text-sm">
          {t('settings.writeBoundaryDesc')}
        </p>
        <p className="text-text2 text-xs mt-2">
          {t('settings.writeBoundaryNote')}
        </p>
      </Section>
    </>
  );
}

// B2：模型配置页 —— 供应商可编辑（name/base_url/换 Key）+ 测试连接（延迟可见）
// 多模型：模型条目可增可删，「+ 添加模型」默认收起（修复已添加仍常驻输入框的逻辑混乱）
function ModelsTab({ providers, onProvidersChange, globalProviders, newP, setNewP, addProvider, addPError = '' }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', base_url: '' });
  const [keyPid, setKeyPid] = useState(null);
  const [keyValue, setKeyValue] = useState('');
  const [testStatus, setTestStatus] = useState({}); // id -> { ok, latencyMs, error, testing }
  const [addFormPid, setAddFormPid] = useState(null);
  const [addForm, setAddForm] = useState({ pid: null, fileKey: null, model_id: '', display_name: '' });
  // 自定义模型配置文件（~/.mjcode/models.json，对标 WorkBuddy models.json）
  const [mf, setMf] = useState(null);

  async function loadModelsFile() {
    try {
      const s = await api.modelsFileStatus(); // 主进程按 mtime 热同步（文件保存即生效）
      setMf(s);
      if (s?.exists) onProvidersChange(); // 同步可能增删了 provider，刷新列表
    } catch { /* 通道不可用（旧版 preload）静默降级 */ }
  }
  useEffect(() => { loadModelsFile(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitAddModel() {
    if (!addForm.pid || !addForm.model_id.trim()) return;
    try {
      if (addForm.fileKey) {
        // file 来源：写回 ~/.mjcode/models.json（主进程随后按 mtime 热同步回流列表）
        await api.addFileProviderModel(addForm.fileKey, { model_id: addForm.model_id.trim(), display_name: addForm.display_name.trim() });
        loadModelsFile();
      } else {
        await api.addProviderModel(addForm.pid, { model_id: addForm.model_id.trim(), display_name: addForm.display_name.trim() });
      }
      setAddFormPid(null);
      setAddForm({ pid: null, fileKey: null, model_id: '', display_name: '' });
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
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err?.message || t('settings.testRequestFailed') } }));
    }
  }

  async function openModelsFile() {
    try {
      await api.modelsFileOpen(); // 不存在则先写模板并打开
      setTimeout(loadModelsFile, 600); // 等编辑器打开后刷新同步状态
    } catch (err) {
      console.warn('[settings] failed to open config file:', err);
    }
  }

  return (
    <>
      {/* WorkBuddy 式「自定义模型」文件入口（用户要求：配置文件路径放模型页，参考 WorkBuddy 样式）。
          路径内联可点击（打开/初始化文件）；文件保存后主进程按 mtime 自动同步，无需重启。 */}
      <div className="mb-3">
        <div className="text-sm font-semibold">{t('settings.customModelsTitle')}</div>
        <p className="text-xs text-text2 mt-1 leading-relaxed">
          {t('settings.modelsFileBefore')}{' '}
          <button onClick={openModelsFile}
            className="font-mono bg-hover text-accent px-1 rounded hover:underline align-baseline"
            title={t('settings.openConfigTitle')} aria-label={t('settings.openConfigAria')}>
            {mf?.path || '~/.mjcode/models.json'}
          </button>
          {' '}{t('settings.modelsFileAfter')}
          {mf && !mf.exists && t('settings.modelsFileNotCreated')}
        </p>
        {mf?.errors?.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {mf.errors.slice(0, 5).map((e, i) => (
              <p key={i} className="text-xs text-danger">{t('settings.parseWarn', { error: e.error })}</p>
            ))}
          </div>
        )}
        {mf?.exists && mf?.errors?.length === 0 && mf?.synced > 0 && (
          <p className="text-xs text-success mt-1">{t('settings.modelsSynced', { n: mf.synced })}</p>
        )}
        <div className="flex gap-3 mt-2">
          <button onClick={openModelsFile} className="text-xs text-accent hover:underline">
            {mf?.exists ? t('settings.openConfigFile') : t('settings.initConfigFile')}
          </button>
          <button onClick={loadModelsFile} className="text-xs text-text2 hover:text-text">{t('settings.resync')}</button>
        </div>
      </div>
      <Section title={t('settings.myModelsTitle')}>
        {providers.map((p) => {
          const isServer = String(p.id).startsWith('s');
          const isFile = p.source === 'file'; // ~/.mjcode/models.json 同步：文件是事实来源，UI 只读
          const st = testStatus[p.id];
          const editing = editingId === p.id;
          return (
            <div key={p.id} className="py-3 border-b border-border last:border-0">
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="flex-1 bg-input border border-border rounded px-2 py-1 text-sm" placeholder={t('settings.nameLabel')} />
                    <input value={editForm.base_url} onChange={(e) => setEditForm({ ...editForm, base_url: e.target.value })}
                      className="flex-[2] bg-input border border-border rounded px-2 py-1 text-sm font-mono" placeholder={t('settings.baseUrlLabel')} />
                    <button onClick={() => saveEdit(p)} className="bg-accent-solid text-on-accent px-3 rounded text-xs py-1">{t('settings.save')}</button>
                    <button onClick={() => setEditingId(null)} className="text-text2 text-xs">{t('settings.cancel')}</button>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="text-caption px-1.5 py-0.5 rounded bg-hover text-text2">{isFile ? t('settings.sourceFile') : (isServer ? t('settings.sourceShared') : t('settings.sourceLocal'))}</span>
                    <span className="ml-auto flex items-center gap-2 shrink-0">
                      {!isServer && !isFile && (
                        <>
                          <button onClick={() => { setEditingId(p.id); setEditForm({ name: p.name, base_url: p.base_url }); }}
                            className="text-text2 hover:text-text text-xs">{t('settings.edit')}</button>
                          <button onClick={() => { setKeyPid(keyPid === p.id ? null : p.id); setKeyValue(''); }}
                            className="text-text2 hover:text-text text-xs">{t('settings.changeKey')}</button>
                          <button onClick={() => testConn(p)} className="text-text2 hover:text-text text-xs">{t('settings.testConnection')}</button>
                        </>
                      )}
                      {isFile && (
                        <button onClick={() => testConn(p)} className="text-text2 hover:text-text text-xs">{t('settings.testConnection')}</button>
                      )}
                      <button onClick={async () => {
                        // A2：删除需确认。file 来源：删除动作写回配置文件（整组移除，可编辑文件恢复）；
                        // 本机/UI 来源：加密 Key 不可逆销毁
                        const ok = await confirm({
                          title: t('settings.deleteProviderTitle'),
                          message: isFile
                            ? t('settings.deleteProviderFileMsg', { name: p.name, count: p.models?.length || 0 })
                            : t('settings.deleteProviderMsg', { name: p.name }),
                          danger: true,
                          confirmLabel: t('settings.delete'),
                        });
                        if (!ok) return;
                        try {
                          if (isFile) {
                            await api.removeFileProvider(p.fileKey);
                            loadModelsFile(); // 刷新文件同步状态
                          } else {
                            await api.deleteProvider(p.id);
                          }
                          onProvidersChange();
                        } catch (err) {
                          setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err?.message || t('settings.deleteFailed') } }));
                        }
                      }} className="text-danger text-xs">{t('settings.delete')}</button>
                    </span>
                  </>
                )}
              </div>
              {!editing && <div className="text-xs text-text2 mt-1 font-mono">{p.base_url}</div>}
              {isFile && (
                <div className="text-caption text-text2 mt-0.5">{t('settings.fileManagedNote', { path: mf?.path || '~/.mjcode/models.json' })}</div>
              )}
              {st?.testing && <div className="text-xs text-text2 mt-1">{t('settings.testing')}</div>}
              {st && !st.testing && (st.ok
                ? <div className="text-xs text-success mt-1">{t('settings.connOk', { ms: st.latencyMs })}</div>
                : <div className="text-xs text-danger mt-1">{st.latencyMs
                    ? t('settings.connFailedMs', { ms: st.latencyMs, error: st.error || t('settings.unknownError') })
                    : t('settings.connFailed', { error: st.error || t('settings.unknownError') })}</div>)}
              {keyPid === p.id && (
                <div className="flex gap-2 mt-2">
                  <input type="password" value={keyValue} onChange={(e) => setKeyValue(e.target.value)}
                    placeholder={t('settings.newApiKeyPlaceholder')}
                    className="flex-1 bg-input border border-border rounded px-2 py-1 text-xs" />
                  <button onClick={() => saveKey(p)} className="bg-accent-solid text-on-accent px-3 rounded text-xs">{t('settings.saveKey')}</button>
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
                                title: t('settings.deleteModelTitle'),
                                message: isFile
                                  ? t('settings.deleteModelFileMsg', { provider: p.name, model: m.display_name || mid })
                                  : t('settings.deleteModelMsg', { provider: p.name, model: m.display_name || mid }),
                                danger: true,
                                confirmLabel: t('settings.remove'),
                              });
                              if (!ok) return;
                              try {
                                if (isFile) {
                                  await api.removeFileProviderModel(p.fileKey, mid);
                                  loadModelsFile();
                                } else {
                                  await api.removeProviderModel(p.id, mid);
                                }
                                onProvidersChange();
                              } catch (err) {
                                setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: err.message } }));
                              }
                            }}
                            className="ml-auto text-text2 hover:text-danger opacity-0 group-hover:opacity-100 shrink-0"
                            title={t('settings.removeModelTitle')}
                            aria-label={t('settings.removeModelAria', { name: m.display_name || mid })}
                          >
                            <IconX size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 添加模型：默认收起（修复「已添加模型仍常驻输入框」的逻辑混乱）；file 来源写回配置文件 */}
              {!isServer && (
                addFormPid === p.id ? (
                  <div className="flex gap-2 mt-2">
                    <input placeholder={t('settings.modelIdPlaceholder')} value={addForm.pid === p.id ? addForm.model_id : ''}
                      onChange={(e) => setAddForm({ pid: p.id, fileKey: p.fileKey || null, model_id: e.target.value, display_name: addForm.display_name })}
                      className="flex-1 bg-surface border border-border rounded px-2 py-1 text-xs" />
                    <input placeholder={t('settings.displayNamePlaceholder')} value={addForm.pid === p.id ? addForm.display_name : ''}
                      onChange={(e) => setAddForm({ ...addForm, display_name: e.target.value })}
                      className="w-28 bg-surface border border-border rounded px-2 py-1 text-xs" />
                    <button onClick={submitAddModel} className="bg-accent-solid text-on-accent px-3 rounded text-xs">{t('settings.add')}</button>
                    <button onClick={() => { setAddFormPid(null); setAddForm({ pid: null, fileKey: null, model_id: '', display_name: '' }); }}
                      className="text-text2 text-xs">{t('settings.cancel')}</button>
                  </div>
                ) : (
                  <button onClick={() => { setAddFormPid(p.id); setAddForm({ pid: p.id, fileKey: p.fileKey || null, model_id: '', display_name: '' }); }}
                    className="mt-2 ml-4 text-xs text-accent hover:opacity-80 border border-dashed border-border rounded px-2 py-1">
                    {t('settings.addModelButton')}
                  </button>
                )
              )}
            </div>
          );
        })}
      </Section>
      <Section title={t('settings.addProviderTitle')}>
        <Input placeholder={t('settings.providerNamePlaceholder')} value={newP.name} onChange={(e) => setNewP({ ...newP, name: e.target.value })} />
        <Input placeholder={t('settings.providerUrlPlaceholder')} value={newP.base_url} onChange={(e) => setNewP({ ...newP, base_url: e.target.value })} />
        <Input placeholder="API Key" type="password" value={newP.api_key} onChange={(e) => setNewP({ ...newP, api_key: e.target.value })} />
        {addPError && <p className="text-xs text-danger mt-1">{addPError}</p>}
        <button onClick={addProvider} className="bg-accent-solid text-on-accent px-4 py-2 rounded-lg text-sm mt-2">{t('settings.addService')}</button>
      </Section>
      <Section title={t('settings.serverModelsTitle')}>
        {(!globalProviders || globalProviders.length === 0) ? (
          <p className="text-text2 text-sm py-3">{t('settings.noServerModels')}</p>
        ) : globalProviders.map((p) => (
          <div key={p.id} className="py-3 border-b border-border last:border-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-caption px-1.5 py-0.5 rounded bg-hover text-text2">{t('settings.sourceShared')}</span>
              <span className="text-caption text-text2 ml-auto">{t('settings.serverManagedNote')}</span>
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

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <h2 className="text-base font-semibold mb-3">{title}</h2>
      <div className="bg-surface border border-border rounded-2xl px-5">{children}</div>
    </div>
  );
}

// ── 网络配置（web_search 提供方）──
// 目标：把「能力已建」变成「开箱可用」。此前 web_search 只认 env 变量且无 UI，
// 默认一调用就报 web_search_unconfigured。
// 交互：可同时启用多家（按序 failover，第一个成功者生效），也可只开一家；
//       DuckDuckGo 无需 Key，开箱可用。Key 仅存本机 localStore，不落审计/日志。
// T6（2026-10-17）：三层流式超时设置。
// 为什么不写死一个数字：推理模型（mimo）思考 3 分钟很常见，而快端点 30s 就出结果——
// 写死必然有一边被误杀。这里让用户按自己的供应商调。
// 校验在主进程（streamSettings.clampMs）：越界会**收敛**，保存后重新拉一次"生效值"回显，
// 这样用户能看见自己填的 5 秒被收到 10 秒，而不是以为没生效。
function StreamTimeoutSection() {
  const { t } = useI18n();
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState({ firstByte: '', idle: '', total: '' });
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  const applyView = (v) => {
    setView(v);
    setDraft({
      firstByte: String(Math.round(v.effective.firstByteMs / 1000)),
      idle: String(Math.round(v.effective.idleMs / 1000)),
      total: String(Math.round(v.effective.totalMs / 1000)),
    });
  };

  useEffect(() => {
    window.mjcode?.getStreamTimeouts?.().then((v) => { if (v) applyView(v); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setError('');
    try {
      const value = {
        firstByteMs: Math.round(Number(draft.firstByte) * 1000),
        idleMs: Math.round(Number(draft.idle) * 1000),
        totalMs: Math.round(Number(draft.total) * 1000),
      };
      await window.mjcode?.localSetPreference?.({ key: 'stream_timeouts', value });
      const v = await window.mjcode?.getStreamTimeouts?.();
      if (v) applyView(v);
      setFlash(t('settings.streamSaved'));
      setTimeout(() => setFlash(''), 2500);
    } catch (e) { setError(e.message || String(e)); }
  }

  if (!view) return null;
  const rows = [
    { key: 'firstByte', ms: 'firstByteMs', labelKey: 'settings.streamFirstByte' },
    { key: 'idle', ms: 'idleMs', labelKey: 'settings.streamIdle' },
    { key: 'total', ms: 'totalMs', labelKey: 'settings.streamTotal' },
  ];
  return (
    <Section title={t('settings.streamTimeoutTitle')}>
      <p className="py-2 text-xs text-text2">{t('settings.streamTimeoutDesc')}</p>
      {rows.map((r) => {
        const b = view.bounds[r.ms];
        const src = view.source[r.ms];
        return (
          <div key={r.key} className="py-3 border-b border-border last:border-0">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm">{t(r.labelKey)}</div>
                <div className="text-xs text-text2">
                  {t(`settings.streamSource_${src}`)} · {t('settings.streamRange', { min: Math.round(b.min / 1000), max: Math.round(b.max / 1000) })}
                </div>
              </div>
              <input
                type="number"
                value={draft[r.key]}
                min={Math.round(b.min / 1000)}
                max={Math.round(b.max / 1000)}
                onChange={(e) => { setDraft({ ...draft, [r.key]: e.target.value }); setFlash(''); }}
                className="w-24 bg-surface border border-border rounded-lg px-2 py-1 text-sm text-text text-right"
              />
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-3 pt-3">
        <button onClick={save} className="bg-accent-solid text-on-accent rounded-lg px-3 py-1.5 text-sm">
          {t('settings.streamSave')}
        </button>
        {flash && <span className="text-xs text-text2">{flash}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </Section>
  );
}

function NetworkTab() {
  const { t } = useI18n();
  const [meta, setMeta] = useState([]);
  const [providers, setProviders] = useState([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    window.mjcode?.webSearchGetConfig?.().then((r) => {
      if (r?.ok) { setMeta(r.meta || []); setProviders(r.config?.providers || []); }
      else setError(r?.error || t('settings.configLoadFailed'));
    }).catch((e) => setError(e.message || String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (id, patch) => {
    setProviders((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setSaved(false);
  };

  async function save() {
    setError('');
    try {
      const r = await window.mjcode.webSearchSetConfig(providers);
      if (r?.ok) { setProviders(r.config?.providers || providers); setSaved(true); setTimeout(() => setSaved(false), 2000); }
      else setError(r?.error || t('settings.saveFailed'));
    } catch (e) { setError(e.message || String(e)); }
  }

  const enabledCount = providers.filter((p) => p.enabled).length;

  return (
    <>
      {/* T6（2026-10-17）：三层流式超时——放在「网络」分区，因为它只在网络慢/供应商挂起时才有意义 */}
      <StreamTimeoutSection />
      <Section title={t('settings.searchProvidersTitle')}>
        <p className="py-3 text-xs text-text2">
          {t('settings.searchProvidersDesc')}
        </p>
        {meta.map((m) => {
          const p = providers.find((x) => x.id === m.id) || { id: m.id, enabled: false, apiKey: '', extra: {} };
          const extra = p.extra || {};
          const needsKey = m.requiresKey && !String(p.apiKey || '').trim();
          return (
            <div key={m.id} className="py-3 border-b border-border last:border-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm flex items-center gap-2">
                    {t(`search.${m.id}.label`)}
                    {m.requiresKey
                      ? <span className="text-caption text-warn">{t('settings.needsKey')}</span>
                      : <span className="text-caption text-text2">{t('settings.noKeyNeeded')}</span>}
                    {needsKey && p.enabled && <span className="text-caption text-danger">{t('settings.keyMissingSkip')}</span>}
                  </div>
                  <div className="text-xs text-text2">{t(`search.${m.id}.note`)}</div>
                  {m.docsUrl && (
                    <a href={m.docsUrl} onClick={(e) => { e.preventDefault(); window.mjcode?.openExternal?.({ url: m.docsUrl }); }}
                      className="text-xs text-accent hover:underline">{m.docsUrl}</a>
                  )}
                </div>
                <Toggle on={p.enabled} onChange={() => update(m.id, { enabled: !p.enabled })}
                  label={t(`search.${m.id}.label`)} />
              </div>
              {p.enabled && (
                <div className="mt-2 pl-0">
                  {m.requiresKey && (
                    <Input placeholder={m.keyPlaceholder || m.keyLabel} value={p.apiKey}
                      onChange={(e) => update(m.id, { apiKey: e.target.value })} />
                  )}
                  {(m.extraFields || []).map((f) => (
                    <Input key={f.id} placeholder={t(`search.${m.id}.${f.id}`)} value={extra[f.id] || ''}
                      onChange={(e) => update(m.id, { extra: { ...extra, [f.id]: e.target.value } })} />
                  ))}
                  {m.id === 'searxng' && (
                    <Input placeholder={t('settings.searxngEndpointPlaceholder')} value={extra.endpoint || ''}
                      onChange={(e) => update(m.id, { extra: { ...extra, endpoint: e.target.value } })} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Section>
      <div className="flex items-center gap-3">
        <button onClick={save}
          className="px-4 py-2 rounded-lg text-sm bg-accent-solid text-on-accent hover:brightness-110">{t('settings.saveNetworkConfig')}</button>
        {saved && <span className="text-xs text-success">{t('settings.networkSaved')}</span>}
        {enabledCount > 1 && <span className="text-xs text-text2">{t('settings.networkEnabledCount', { n: enabledCount })}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </>
  );
}

// A7：已授权规则列表 —— 「始终允许」必须可见可撤销（此前授予后全应用无任何管理界面）
const RULE_LEVEL_META = {
  L1: { labelKey: 'settings.ruleL1', cls: 'text-danger' },
  L2: { labelKey: 'settings.ruleL2', cls: 'text-warn' },
  L3: { labelKey: 'settings.ruleL3', cls: 'text-info' },
};

function ApprovalRulesSection() {
  const { t } = useI18n();
  const [rules, setRules] = useState([]);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    if (!window.mjcode?.listApprovalRules) return;
    try {
      const r = await window.mjcode.listApprovalRules();
      if (r?.ok) setRules(r.rules || []);
    } catch (err) {
      console.warn('[settings] failed to load approval rules:', err);
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
    <Section title={t('settings.approvedRulesTitle')}>
      {!loaded ? (
        <p className="text-text2 text-xs py-3">{t('settings.loading')}</p>
      ) : rules.length === 0 ? (
        <p className="text-text2 text-xs py-3">
          {t('settings.noRulesNote')}
        </p>
      ) : (
        rules.map((rule) => {
          const meta = RULE_LEVEL_META[rule.level] || RULE_LEVEL_META.L2;
          return (
            <div key={rule.id} className="py-3 border-b border-border last:border-0 flex items-center gap-3">
              <span className={`text-xs shrink-0 ${meta.cls}`}>{t(meta.labelKey)}</span>
              <span className="text-xs font-mono shrink-0">{rule.tool}</span>
              <span className="text-xs text-text2 truncate flex-1 font-mono" title={rule.pattern}>
                {rule.pattern || t('settings.ruleAllPatterns')}
              </span>
              {rule.createdAt && (
                <span className="text-caption text-text2 shrink-0">{new Date(rule.createdAt).toLocaleString('zh-CN')}</span>
              )}
              <button onClick={() => revoke(rule)} className="text-xs text-danger shrink-0">{t('settings.revoke')}</button>
            </div>
          );
        })
      )}
    </Section>
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

function Toggle({ on, onChange, label }) {
  // ST8：关闭态轨道由 bg-text2（灰字灰底难辨）改为 bg-hover + 边框 → 视觉与语义统一由
  // ui/Switch 承载（P1-9：role="switch" + aria-checked + 可访问名称 + 键盘切换）
  return <Switch checked={on} onChange={() => onChange()} label={label} />;
}

function Input({ placeholder, value, onChange, type = 'text' }) {
  return (
    <input placeholder={placeholder} value={value} onChange={onChange} type={type}
      className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm my-1 outline-none focus:border-accent" />
  );
}

