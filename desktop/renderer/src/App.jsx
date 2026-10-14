import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import SettingsModal from './components/SettingsModal';
import LoginPage from './components/LoginPage';
import Dashboard from './components/Dashboard';
import ApprovalCard from './components/ApprovalCard';
import DiffReviewPanel from './components/DiffReviewPanel';
import ScheduledTasks from './components/ScheduledTasks';
import ProjectPicker from './components/ProjectPicker';
import Onboarding from './components/Onboarding';
import EcosystemModal from './components/EcosystemModal';
import FileTree from './components/FileTree';
import FileViewerPane from './components/FileViewerPane';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import RightPane, { PanelEmpty } from './components/RightPane';
import ArchiveModal from './components/ArchiveModal';
import { IconChart, IconFile, IconFolderOpen, IconPalette, IconSidebar } from './components/icons';
import { api, setLocalMode, isLocalMode } from './lib/api';
import { restoreMcpTools, mergeMcpTools } from './lib/mcpTools';
import { loadAgentsMd } from './lib/agentsMd';
import ipc from './lib/ipc';
import FeedbackHost, { confirm, toast } from './components/feedback';
import { projectDisplayName } from './lib/projectName';
import THEMES from './lib/themes.json';

const DEFAULT_PROJECT = { id: 'default', name: '默认项目', path: '' };

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch (e) {
    console.warn('[app] 本地数据解析失败:', key);
    return fallback;
  }
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('mj_token'));
  const [threads, setThreads] = useState([]);
  const [activeThread, setActiveThread] = useState(null);
  const [userProviders, setUserProviders] = useState([]);
  const [globalProviders, setGlobalProviders] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  // TH3：无本地偏好时跟随系统明暗（prefers-color-scheme），避免明室用户首启见黑屏
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('mj_theme');
    if (saved) return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  const [showEcosystem, setShowEcosystem] = useState(false); // 生态中心（侧栏一级导航，对标 Codex Plugins）
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [activeProject, setActiveProject] = useState(() => loadJSON('mj_active_project', DEFAULT_PROJECT));
  // Bug2 + P0-D：当前选中模型与项目目录实时推送主进程定时任务调度器
  // （到点执行时复用同一凭证/模型；项目目录决定 Agent 通道的 cwd 与沙箱档位：
  //   有项目 → workspace-write，无项目 → read-only）
  // 位置纪律：本 effect 的依赖数组同步求值，必须位于 activeProject 声明之后——
  //  曾因插在 selectedModel 之后（activeProject 之前）触发 TDZ：
  //  「Cannot access 'activeProject' before initialization」启动即白屏。
  useEffect(() => {
    if (!selectedModel?.provider || !selectedModel?.model) return;
    try {
      window.mjcode?.scheduledSetModel?.({
        providerId: selectedModel.provider.id,
        isGlobal: !!selectedModel.provider.isGlobal,
        baseUrl: selectedModel.provider.base_url || '',
        model: selectedModel.model.model_id,
        cwd: activeProject?.path || '',
      });
    } catch (e) { console.warn('[app] 定时任务执行模型推送失败:', e); }
  }, [selectedModel, activeProject]);
  const [projects, setProjects] = useState(() => loadJSON('mj_projects', []));
  // 是否为「本次使用中主动选择」的项目：欢迎页据此区分「用户有意在此工作」与
  // 「重启后残留的上次项目」。此前欢迎页把 activeProject（localStorage 恢复的上次项目）
  // 当默认事实展示——副标题「在 工作区 10-13 中」+ 围绕旧项目生成建议卡片，
  // 用户要新建别的项目时整个欢迎页都在说上一个任务（空态伪装成已选的同类问题）
  const [projectPicked, setProjectPicked] = useState(false);
  const [mcpTools, setMcpTools] = useState([]);
  // Bug3：启动时从主进程重建 MCP 工具集（重启后自动重连的服务不再丢工具）
  useEffect(() => { restoreMcpTools().then(setMcpTools); }, []);
  // A6：Skill 启用态持久化（此前 useState 初始值从不落盘，重启即重置）
  // 数组守卫：localStorage 曾被写入过非数组（如插件安装误把 plugin 对象存进来）时，
  // 不得原样进入 state，否则下游 enabledSkills.filter 崩溃且每次重启都崩
  const [enabledSkills, setEnabledSkills] = useState(() => {
    const v = loadJSON('mj_enabled_skills', ['code_review']);
    return Array.isArray(v) ? v : ['code_review'];
  });
  const setEnabledSkillsSafe = (next) => setEnabledSkills(Array.isArray(next) ? next : ['code_review']);
  useEffect(() => { localStorage.setItem('mj_enabled_skills', JSON.stringify(enabledSkills)); }, [enabledSkills]);
  // 大任务自动拆分开关（ChatArea 闸门同读 mj_auto_decompose；'0' = 关闭）
  const [autoDecompose, setAutoDecompose] = useState(() => localStorage.getItem('mj_auto_decompose') !== '0');
  useEffect(() => { localStorage.setItem('mj_auto_decompose', autoDecompose ? '1' : '0'); }, [autoDecompose]);
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('mj_onboarded') === '1');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [approvalSettings, setApprovalSettings] = useState(() => loadJSON('mj_approval_settings', { sandbox_policy: 'workspace-write', approval_mode: 'on-request' }));
  const [localMode, setLocalModeState] = useState(false);
  // 右侧预览栏：多文件标签（openedFiles 为打开顺序，activeFilePath 为当前标签）
  const [openedFiles, setOpenedFiles] = useState([]);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const closeAllFiles = () => { setOpenedFiles([]); setActiveFilePath(null); };
  const [paletteOpen, setPaletteOpen] = useState(false); // ⌘K 命令面板
  const [archiveOpen, setArchiveOpen] = useState(false); // A3：已归档会话管理
  const [agentsMd, setAgentsMd] = useState(null); // 项目规范（按项目路径缓存，避免面板切换重复探测）
  // 三栏布局状态（对标 Codex）：左侧栏与右侧常驻面板可独立折叠
  const [sidebarOpen, setSidebarOpen] = useState(() => loadJSON('mj_sidebar_open', true));
  const [paneOpen, setPaneOpen] = useState(() => loadJSON('mj_pane_open', false));
  const [paneTab, setPaneTab] = useState('diff'); // diff | files | preview
  const [agentFiles, setAgentFiles] = useState([]); // 本轮 Agent 改动的文件（Diff 面板「上一轮」筛选）
  // 连接态探测完成前不渲染登录页（P0：离线免账户直达，首帧不闪登录）
  const [probing, setProbing] = useState(() => !localStorage.getItem('mj_token'));

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // TH5：应用自定义强调色（内联变量优先于主题文件定义；未设置则回落主题色）
    const accent = localStorage.getItem('mj_accent');
    const root = document.documentElement;
    if (accent) {
      root.style.setProperty('--theme-accent', accent);
      root.style.setProperty('--sem-accent', accent);
    } else {
      root.style.removeProperty('--theme-accent');
      root.style.removeProperty('--sem-accent');
    }
    localStorage.setItem('mj_theme', theme);
  }, [theme]);

  // TH2：顶栏快捷换肤入口 —— 在主题列表中循环（点击循环，全部主题在 设置 → 外观）
  function cycleTheme() {
    const idx = THEMES.findIndex((t) => t.id === theme);
    setTheme(THEMES[(idx + 1) % THEMES.length].id);
  }

  // 审批档位持久化（沙箱策略 + 审批模式）
  useEffect(() => { localStorage.setItem('mj_approval_settings', JSON.stringify(approvalSettings)); }, [approvalSettings]);

  useEffect(() => {
    api.globalProviders()
      .then(setGlobalProviders)
      .catch((err) => console.warn('[app] 全局模型列表加载失败:', err));
  }, []);
  // 本地模式下同样需要刷新（本机模型保存后要立刻可选中）
  useEffect(() => { if (token || localMode) loadData(); }, [token, localMode]);

  // P1-F：401 登出闭环——服务端 401 时 api.request 已清 localStorage 并派发 auth-changed；
  // 此前无人监听该事件 → token 失效后仍是伪登录态，之后每个请求都 401（人类可读化后
  // 也只提示「登录状态已失效」却不回登录页）。此处回退登录页，由用户重登或走离线模式。
  useEffect(() => {
    const onAuthChanged = () => { setToken(null); setLocalModeState(false); };
    window.addEventListener('auth-changed', onAuthChanged);
    return () => window.removeEventListener('auth-changed', onAuthChanged);
  }, []);

  // 能力矩阵加载（冻结项集中判定）
  useEffect(() => { ipc.loadCaps(); }, []);

  // 全局快捷键（对齐 Codex）：
  //   ⌘K 命令面板 / ⌘N 新会话 / ⌘O 打开项目 / ⌘, 设置
  //   ⌘B 左侧栏 / ⌘⌥B 右侧面板 / ⌘P 搜索（打开命令面板的文件搜索）
  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); }
      else if (k === 'n') { e.preventDefault(); setActiveThread(null); resetView(); }
      else if (k === 'o') { e.preventDefault(); setShowProjectPicker(true); }
      else if (k === ',') { e.preventDefault(); setShowSettings(true); }
      else if (k === 'b') {
        e.preventDefault();
        if (e.altKey) { if (activeThreadRef.current) setPaneOpen((v) => !v); } // ⌘⌥B 右侧面板（任务作用域内）
        else setSidebarOpen((v) => !v);            // ⌘B 左侧栏
      } else if (k === 'p') {
        e.preventDefault();
        setPaletteOpen(true);                       // ⌘P 复用命令面板（文件搜索）
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 模型选择器底部入口：跨组件打开设置（CustomEvent，避免层层传 prop）
  useEffect(() => {
    const open = () => setShowSettings(true);
    window.addEventListener('mjcode:open-settings', open);
    return () => window.removeEventListener('mjcode:open-settings', open);
  }, []);

  // B3：右侧面板任务作用域 —— 无任务自动收起；切任务清空上一任务的文件视图与改动列表。
  // 此前 agentFiles/viewFile 为 App 级全局态且 RightPane 用 hidden 保活，
  // 导致未进入任何会话时仍显示上一任务的 diff/文件树/代码（跨任务数据泄漏）
  const activeThreadId = activeThread?.id || null;
  // 快捷键 effect 闭包是空的，用 ref 读取最新的任务态（⌘⌥B 需按作用域判断）
  const activeThreadRef = useRef(null);
  useEffect(() => { activeThreadRef.current = activeThread; }, [activeThread]);
  useEffect(() => {
    if (!activeThreadId) setPaneOpen(false);
    // 打开的文件标签属于「某个任务在看的文件」：切任务必须清空，
    // 否则新任务里还挂着上一任务的代码/文档内容（跨任务上下文泄漏）
    setOpenedFiles([]);
    setActiveFilePath(null);
    setAgentFiles([]);
  }, [activeThreadId]);

  // 打开文件到右侧预览栏（已在标签中则仅切换，不重复入栈）
  function openFileInPane(path) {
    if (!path) return;
    setOpenedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFilePath(path);
    setPaneTab('preview');
    setPaneOpen(true);
  }

  // 关闭单个标签：若关的是当前标签，激活相邻标签（优先右邻，其次左邻）
  function closeFileInPane(path) {
    const idx = openedFiles.indexOf(path);
    const next = openedFiles.filter((p) => p !== path);
    setOpenedFiles(next);
    if (activeFilePath === path) setActiveFilePath(next[idx] ?? next[idx - 1] ?? null);
  }

  // B3：选中会话 = 任务作用域的唯一事实源。
  // 会话归属哪个项目，右侧文件树/Diff 就显示哪个项目；不跟随上次手动选的项目
  function selectThread(t) {
    setActiveThread(t);
    resetView();
    const path = t?.project_path || t?.projectPath || '';
    if (path && path !== activeProject?.path) {
      const known = projects.find((p) => p.path === path);
      setActiveProject({
        id: path,
        name: known?.name || String(path).split('/').filter(Boolean).pop() || path,
        path,
        branch: known?.branch || '',
      });
    }
  }

  // 布局状态持久化
  useEffect(() => { localStorage.setItem('mj_sidebar_open', JSON.stringify(sidebarOpen)); }, [sidebarOpen]);
  useEffect(() => { localStorage.setItem('mj_pane_open', JSON.stringify(paneOpen)); }, [paneOpen]);

  // 离线检测（M3-1）：服务端不可达时进入本地模式；探测结束（或 2 秒兜底）后解锁首帧
  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; setProbing(false); } };
    const timer = setTimeout(finish, 2000); // 兜底：避免探测悬挂导致永久加载态
    if (!window.mjcode?.serverHealth) { finish(); return () => clearTimeout(timer); }
    // 服务端不可达 → 一律走本机数据层（本地优先：无论是否持有令牌）
    window.mjcode.serverHealth().then(async (r) => {
      if (!r?.online) await enterLocalMode();
    }).catch((err) => console.warn('[app] 健康探测失败:', err)).finally(finish);
    return () => clearTimeout(timer);
  }, []);

  async function enterLocalMode() {
    console.log('[app] 服务端不可达，进入离线模式（本地优先数据层）');
    setLocalMode(true);
    setLocalModeState(true);
    api.setLocalMode(true);
    const [t, p] = await Promise.all([window.mjcode.localThreads(), window.mjcode.localProviders()]);
    setThreads(t);
    const plist = p.map((x) => ({ ...x, models: x.modelId ? [{ id: x.id, model_id: x.modelId, display_name: x.modelId }] : [] }));
    setUserProviders(plist);
    if (plist.length > 0 && plist[0].models?.length > 0) {
      setSelectedModel({ provider: plist[0], model: plist[0].models[0] });
    }
  }

  // 项目状态持久化
  useEffect(() => { localStorage.setItem('mj_active_project', JSON.stringify(activeProject)); }, [activeProject]);
  useEffect(() => { localStorage.setItem('mj_projects', JSON.stringify(projects)); }, [projects]);

  // B1：项目列表落本机 localStore（首次启动时把 localStorage 存量迁移进去，去重）
  useEffect(() => {
    if (!localStoreReady()) return;
    window.mjcode.localProjects().then((saved) => {
      const savedPaths = new Set((saved || []).map((p) => p.path));
      const legacy = loadJSON('mj_projects', []);
      const needMigrate = legacy.filter((p) => p.path && !savedPaths.has(p.path));
      (async () => {
        for (const p of needMigrate) await window.mjcode.localAddProject({ path: p.path, name: p.name });
        const list = await window.mjcode.localProjects();
        if (Array.isArray(list) && list.length > 0) {
          setProjects(list.map((p) => ({ id: p.path, name: p.name, path: p.path, branch: '' })));
        }
      })();
    }).catch((err) => console.warn('[app] 项目列表本机加载失败:', err));
  }, []);

  // 切换项目后探测 git 分支（Composer 真实状态用）
  useEffect(() => {
    if (!activeProject?.path || !window.mjcode?.probeProject) return;
    window.mjcode.probeProject({ path: activeProject.path })
      .then((probe) => setActiveProject((prev) => (prev?.path === activeProject.path ? { ...prev, branch: probe.branch || '', languages: probe.languages || [] } : prev)))
      .catch((err) => console.warn('[app] 项目探测失败:', err));
  }, [activeProject?.path]);

  // AGENTS.md 项目规范：上提到 App 层按项目路径缓存
  // 原因：原先放在 ChatArea 内，切换「数据/定时任务」面板会卸载重挂 ChatArea，
  // 导致每次切换都重跑一次 5 级向上探测（既浪费，也刷主进程日志）
  useEffect(() => {
    if (!activeProject?.path) { setAgentsMd(null); return; }
    let cancelled = false;
    loadAgentsMd(activeProject.path)
      .then((r) => { if (!cancelled) setAgentsMd(r); })
      .catch((err) => console.warn('[app] AGENTS.md 加载失败:', err));
    return () => { cancelled = true; };
  }, [activeProject?.path]);

  const allProviders = [
    ...globalProviders.map(p => ({ ...p, isGlobal: true })),
    ...userProviders,
  ];

  // 服务端不可达时线程列表降级为本机，模型列表始终包含本机数据库条目（不因服务端失败中断）
  async function loadData() {
    const results = await Promise.allSettled([api.threads(), api.providers()]);
    const [t, p] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
    if (results[0].status === 'rejected') console.warn('[app] 线程列表加载失败:', results[0].reason?.message);
    if (results[1].status === 'rejected') console.warn('[app] 模型列表加载失败:', results[1].reason?.message);
    if (t) setThreads(t);
    if (p) {
      setUserProviders(p);
      if (!selectedModel && p.length > 0 && p[0].models?.length > 0) {
        setSelectedModel({ provider: p[0], model: p[0].models[0] });
      }
    }
    refreshSecrets();
  }

  // G4：消息级刷新 debounce —— 收发消息不再立即全量拉取 threads（600ms 合并），
  // 长列表下每条消息一次全量刷新会造成可感知卡顿
  const loadDataTimerRef = useRef(null);
  function scheduleLoadData() {
    clearTimeout(loadDataTimerRef.current);
    loadDataTimerRef.current = setTimeout(() => { loadData(); }, 600);
  }
  useEffect(() => () => clearTimeout(loadDataTimerRef.current), []);

  // 拉取模型凭证到主进程内存（渲染层不接触 Key）
  // 离线模式下服务端不可达，直接短路：既省掉无谓连接请求，也避免主进程日志噪音
  function refreshSecrets() {
    if (localMode) return;
    const t = localStorage.getItem('mj_token');
    if (!t || !window.mjcode?.getSecrets) return;
    window.mjcode.getSecrets({ token: t }).then((r) => {
      if (!r?.ok) console.warn('[app] 模型凭证加载失败:', r?.error);
    }).catch((err) => console.warn('[app] 模型凭证加载异常:', err?.message));
  }

  // 连接态探测中：渲染骨架，避免服务端不可达时首帧闪现登录页
  if (probing && !token && !localMode) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-text2 text-sm">
        正在检测本地服务…
      </div>
    );
  }

  // 登录门禁：离线免账户是差异化能力，登录页必须提供「跳过」出口
  if (!token && !localMode) {
    return (
      <LoginPage
        onLogin={(t) => { setToken(t); localStorage.setItem('mj_token', t); }}
        onSkip={enterLocalMode}
      />
    );
  }

  // 首启向导未完成时优先展示（登录后）
  if (!onboarded) {
    return (
      <Onboarding
        globalProviders={globalProviders}
        userProviders={userProviders}
        onProviderAdded={loadData}
        onProjectSelected={selectProject}
        onFinish={(prompt) => {
          localStorage.setItem('mj_onboarded', '1');
          setOnboarded(true);
          if (prompt) setInitialPrompt(prompt);
        }}
      />
    );
  }

  function resetView() {
    setShowDashboard(false);
    setShowScheduled(false);
  }

  // 选择/切换项目：写入最近项目列表（去重，最多保留 10 个）
  function selectProject(p) {
    const project = { id: p.path || 'default', name: p.name || p.path, path: p.path || '', branch: '' };
    setActiveProject(project);
    setProjectPicked(true); // 本次主动选择：欢迎页可以围绕该项目展示
    setActiveThread(null);
    // 切换项目必须清空预览标签：否则右侧预览栏仍显示上一个项目的文件内容，
    // 且 relPath 以新项目根目录为前缀计算，会显示错误的相对路径
    closeAllFiles();
    setAgentFiles([]);
    resetView();
    if (project.path) {
      setProjects((prev) => [project, ...prev.filter((x) => x.path !== project.path)].slice(0, 10));
      // B1：同步落本机项目表（失败不影响 UI）
      try { window.mjcode?.localAddProject?.({ path: project.path, name: project.name }); } catch (e) { console.warn('[app] 项目落本机失败:', e); }
    }
  }

  // 项目重命名：只改「显示名」，不动磁盘目录。
  // 目录名是会话归属（thread.projectPath）与沙箱授权（cwd）的标识，改磁盘名会让历史会话全部失联；
  // 而 20261013-1271 这类机器名对用户毫无意义，所以显示名必须与目录名解耦。
  async function renameProject(p, name) {
    const prevName = p.name;
    const apply = (n) => {
      setProjects((list) => list.map((x) => (x.path === p.path ? { ...x, name: n } : x)));
      if (activeProject?.path === p.path) setActiveProject((cur) => ({ ...cur, name: n }));
    };
    apply(name); // 乐观更新，失败回滚
    if (!localStoreReady()) { apply(prevName); toast({ message: '本机存储未就绪，重命名未生效' }); return; }
    const r = await window.mjcode.localRenameProject?.({ path: p.path, name });
    if (r && r.ok === false) { apply(prevName); toast({ message: r.error || '重命名失败' }); return; }
    toast({ message: `已重命名为「${name}」` });
  }

  function removeProject(p) {
    // A2 + B1：轻量确认，明确「不会删除磁盘文件」；说明其下会话去向
    confirm({
      title: '移除项目',
      message: `从列表移除「${projectDisplayName(p)}」？\n项目磁盘文件不受影响；其下的会话将归入「未归属项目」。`,
      danger: false,
      confirmLabel: '移除',
    }).then(async (ok) => {
      if (!ok) return;
      setProjects((prev) => prev.filter((x) => x.path !== p.path));
      if (localStoreReady()) window.mjcode.localRemoveProject?.({ path: p.path });
      if (activeProject?.path === p.path) setActiveProject(DEFAULT_PROJECT);
    });
  }

  // 「+」在指定项目中真正创建一条新会话（此前只切换项目，无可见会话产生）
  async function newThreadInProject(p) {
    selectProject(p);
    try {
      const t = await api.createThread({
        title: '新会话',
        cwd: p.path || '',
        project_path: p.path || '',
      });
      setActiveThread(t);
      loadData();
    } catch (err) {
      console.warn('[app] 在项目中新建会话失败:', err);
    }
  }

  // Bug1：取消「发消息自动创建日期文件夹」的兜底——未选项目时直接发送，
  // 项目创建/选择完全由用户在项目弹窗中主动完成（输入项目名或选择本地目录）

  // 本机数据层就绪探测（离线模式下项目落本机持久化；在线时保持 localStorage 快照）
  function localStoreReady() {
    return typeof window !== 'undefined' && typeof window.mjcode?.localProjects === 'function';
  }

  return (
    <div className="flex flex-col h-screen bg-bg text-text">
      <div className="flex flex-1 min-h-0">
      {sidebarOpen && (
      // P1-E：归档管理仅本地模式可用（服务端归档 API 未实现）；在线模式隐藏入口，
      // 此前点击直接弹英文错误（删除语义双轨分裂，服务端列后续）
      <Sidebar
        threads={threads}
        activeThread={activeThread}
        onSelect={selectThread}
        onNew={() => { setActiveThread(null); resetView(); }}
        onNewThread={newThreadInProject}
        onDelete={async (t) => {
          // A2：删除前确认；本地模式语义为归档，提供 5s 撤销（A3）
          const local = isLocalMode();
          const ok = await confirm({
            title: '删除会话',
            message: local
              ? `「${t.title || '新会话'}」将移入归档，可在侧栏「已归档」中恢复。`
              : `确定删除「${t.title || '新会话'}」吗？此操作不可恢复。`,
            danger: true,
            confirmLabel: '删除',
          });
          if (!ok) return;
          await api.deleteThread(t.id);
          setThreads(threads.filter((x) => x.id !== t.id));
          if (activeThread?.id === t.id) setActiveThread(null);
          if (local) {
            toast({
              message: '已删除会话',
              actionLabel: '撤销',
              onAction: async () => {
                const r = await api.restoreThread(t.id);
                if (r?.ok) loadData();
              },
            });
          }
        }}
        onRenameThread={async (t, title) => {
          // A1：重命名（本地 + 服务端双轨）
          const r = await api.renameThread(t.id, title);
          if (r?.ok) loadData();
          return r?.ok !== false;
        }}
        onAssignThread={async (t, projectPath) => {
          // B1：孤儿会话归组到项目（本地通道）
          const r = await api.setThreadProject(t.id, projectPath);
          if (r?.ok) loadData();
        }}
        onOpenArchive={localMode ? () => setArchiveOpen(true) : undefined}
        onOpenScheduled={() => { resetView(); setShowScheduled(true); }}
        onOpenEcosystem={() => setShowEcosystem(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onOpenSettings={() => setShowSettings(true)}
        projects={projects}
        activeProject={activeProject}
        onSelectProject={selectProject}
        onRemoveProject={removeProject}
        onRenameProject={renameProject}
        onOpenSearch={() => setPaletteOpen(true)}
      />
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center gap-3 px-3 h-12 shrink-0 border-b border-border">
          <button onClick={() => setSidebarOpen((v) => !v)}
            className="text-text2 hover:text-text text-xs px-2 py-1" title="显示/隐藏左侧栏（⌘B）">
            <IconSidebar size={15} />
          </button>
          <span className="text-xs text-text2 truncate" title={activeProject?.path || ''}>
            {activeProject?.path ? projectDisplayName(activeProject) : '未选择项目'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={cycleTheme}
              className="text-text2 hover:text-text px-1.5 py-1 rounded-lg" title={`主题：${THEMES.find((t) => t.id === theme)?.name || theme}（点击切换）`} aria-label="切换主题">
              <IconPalette size={15} />
            </button>
            {localMode && (
              <span className="text-xs px-2 py-1 rounded bg-warn-bg text-warn" title="服务端不可达，线程与消息保存在本机">
                离线模式
              </span>
            )}
            <button onClick={() => { if (activeThread) { setPaneTab('diff'); setPaneOpen(true); } }}
              disabled={!activeThread}
              className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed ${paneOpen && paneTab === 'diff' ? 'bg-surface text-text' : 'text-text2 hover:text-text'}`}
              title={activeThread ? '变更面板（⌘⌥B）' : '进入会话后可查看该任务的变更'}
            >变更</button>
            <button onClick={() => { if (activeThread) { setPaneTab('files'); setPaneOpen(true); } }}
              disabled={!activeThread}
              className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed ${paneOpen && paneTab === 'files' ? 'bg-surface text-text' : 'text-text2 hover:text-text'}`}
              title={activeThread ? '文件树（当前会话所属项目）' : '进入会话后可查看该任务的项目文件'}
            >文件</button>
            <button onClick={() => { if (activeThread) { setPaneTab('preview'); setPaneOpen(true); } }}
              disabled={!activeThread || openedFiles.length === 0}
              className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed ${paneOpen && paneTab === 'preview' ? 'bg-surface text-text' : 'text-text2 hover:text-text'}`}
              title={activeThread
                ? (openedFiles.length ? `预览已打开文件（${openedFiles.length}）` : '先在「文件」标签中打开文件')
                : '进入会话后可预览该任务的文件'}
            >预览</button>
            <button onClick={() => { resetView(); setShowDashboard(true); }}
              className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 ${showDashboard ? 'bg-accent text-white' : 'text-text2 hover:text-text'}`}>
              <IconChart size={14} /> 数据
            </button>
          </div>
        </header>
        {showDashboard && <Dashboard />}
        {showScheduled && <ScheduledTasks />}
        {/* 任务编排已并入对话流（orchestrate_task 工具 + AgentDock 胶囊），不再有独立面板入口 */}
        {/* E4：ChatArea 常驻挂载（数据/定时任务视图下用 hidden 隐藏而非卸载）。
            此前条件渲染会卸载 ChatArea，导致生态中心「在当前会话启用」的
            mjcode:enable-expert/skill 事件静默丢失；同时避免重挂载带来的
            消息重拉与 AGENTS.md 重复探测。contents 保持原 flex 布局不变。 */}
        <div className={showDashboard || showScheduled ? 'hidden' : 'contents'}>
          <ChatArea
            thread={activeThread}
            agentsMd={agentsMd}
            selectedModel={selectedModel}
            project={activeProject}
            projectPicked={projectPicked}
            providers={allProviders}
            onSelectModel={setSelectedModel}
            onApprovalChange={(patch) => setApprovalSettings((prev) => ({ ...prev, ...patch }))}
            onAgentFilesChange={setAgentFiles}
            onThreadStatus={(status) => {
              if (activeThread?.id) api.setThreadStatus(activeThread.id, status).then(() => loadData());
            }}
            onNewMessage={scheduleLoadData}
            onThreadCreated={(t) => setActiveThread(t)}
            onAutoProject={selectProject}
            mcpTools={mcpTools}
            enabledSkills={enabledSkills}
            onOpenProjectPicker={() => setShowProjectPicker(true)}
            initialPrompt={initialPrompt}
            onPromptConsumed={() => setInitialPrompt('')}
            approvalSettings={approvalSettings}
          />
        </div>
      </div>

      {/* 右侧常驻面板：变更 / 文件 / 代码（同屏可见，不再全屏模态） */}
      <RightPane
        open={paneOpen}
        tab={paneTab}
        onTab={setPaneTab}
        onClose={() => setPaneOpen(false)}
        diffPanel={<DiffReviewPanel projectPath={activeProject?.path} agentFiles={agentFiles} />}
        filesPanel={activeProject?.path
          ? <FileTree root={activeProject.path} onOpenFile={openFileInPane} />
          : <PanelEmpty icon={IconFolderOpen} title="尚未选择项目" hint="按 ⌘O 打开或创建项目" />}
        previewPanel={openedFiles.length
          ? <FileViewerPane
              files={openedFiles}
              active={activeFilePath}
              projectPath={activeProject?.path}
              onSelect={setActiveFilePath}
              onClose={closeFileInPane}
            />
          : <PanelEmpty icon={IconFile} title="未打开文件" hint="在「文件」标签中点击文件，或用 ⌘P 搜索文件" />}
      />

      {showEcosystem && (
        <EcosystemModal onClose={() => setShowEcosystem(false)} />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          providers={userProviders}
          onProvidersChange={loadData}
          theme={theme}
          onThemeChange={setTheme}
          globalProviders={globalProviders}
          onMcpToolsChange={(server, tools) => setMcpTools((prev) => mergeMcpTools(prev, server, tools))}
          onSkillsChange={setEnabledSkillsSafe}
          enabledSkills={enabledSkills}
          autoDecompose={autoDecompose}
          onAutoDecomposeChange={setAutoDecompose}
          approvalSettings={approvalSettings}
          onApprovalSettingsChange={setApprovalSettings}
          projectPath={activeProject?.path || ''}
        />
      )}
      {showProjectPicker && (
        <ProjectPicker
          open
          onClose={() => setShowProjectPicker(false)}
          onSelect={(p) => { selectProject(p); setShowProjectPicker(false); }}
          projects={projects}
          onSelectProject={(p) => { selectProject(p); setShowProjectPicker(false); }}
        />
      )}
      </div>
      <StatusBar
        localMode={localMode}
        threadCount={threads.length}
        projectPath={activeProject?.path || ''}
        modelName={selectedModel?.model?.display_name || selectedModel?.model?.model_id || ''}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        threads={threads}
        onSelectThread={selectThread}
        projectPath={activeProject?.path || ''}
        onOpenFile={openFileInPane}
        commands={[
          { label: '新建会话', hint: '⌘N', run: () => { setActiveThread(null); resetView(); } },
          { label: '打开项目', hint: '⌘O', run: () => setShowProjectPicker(true) },
          { label: '打开设置', hint: '⌘,', run: () => setShowSettings(true) },
          { label: '查看用量概览', run: () => { resetView(); setShowDashboard(true); } },
          { label: '打开变更面板', hint: '⌘⌥B', run: () => { if (activeThread) { setPaneTab('diff'); setPaneOpen(true); } } },
          { label: '打开文件树', run: () => { if (activeThread) { setPaneTab('files'); setPaneOpen(true); } } },
          { label: '显示/隐藏左侧栏', hint: '⌘B', run: () => setSidebarOpen((v) => !v) },
          { label: '打开定时任务', run: () => { resetView(); setShowScheduled(true); } },
          { label: `切换主题（当前：${THEMES.find((t) => t.id === theme)?.name || theme}）`, run: cycleTheme },
        ]}
      />
      {/* P1-D：审批挂起即置线程状态 awaiting_approval（侧栏徽标数据源）；决策后回到 running。
          此前全库无任何写入端，STATUS_META.awaiting_approval 与徽标渲染都是死代码。 */}
      <ApprovalCard
        onPendingChange={(pending) => {
          if (!activeThread?.id) return;
          api.setThreadStatus(activeThread.id, pending ? 'awaiting_approval' : 'running').then(() => loadData());
        }}
      />
      <FeedbackHost />
      {archiveOpen && (
        <ArchiveModal
          onClose={() => setArchiveOpen(false)}
          onChanged={() => { loadData(); }}
          onSelect={(t) => { setArchiveOpen(false); loadData().then(() => { selectThread(t); }); }}
        />
      )}
    </div>
  );
}
