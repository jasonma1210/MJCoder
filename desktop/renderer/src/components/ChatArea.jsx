import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import { runAgent, BUILTIN_SKILL_IDS, decomposeTask, looksLargeTask } from '../lib/agent';
import { compactHistory } from '../../../agent-core/index.js';
import InlineAlert from './InlineAlert';
import { toast } from './feedback';
import ComposerControls from './ComposerControls';
import AgentDock from './AgentDock';
import ContextRing, { contextUsageOf } from './ContextRing';
import { getModelConfig, modelKeyOf, effectiveContextWindow } from '../lib/modelConfig';
import { projectDisplayName } from '../lib/projectName';
import PlusMenu from './PlusMenu';
import WorktreeBar from './WorktreeBar';
import { useVoice } from '../hooks/useVoice';
import { IconArrowUp, IconBot, IconCopy, IconCpu, IconFile, IconFolder, IconGitBranch, IconHammer, IconMic, IconPlus, IconPlug, IconRefresh, IconSearch, IconSpinner, IconSquare, IconTerminal, IconWrench, IconX, IconZap } from './icons';

const QUICK_ACTIONS = [
  { Icon: IconSearch, title: '探索并理解代码', prompt: '帮我分析这个项目的结构和代码' },
  { Icon: IconHammer, title: '构建新功能、应用或工具', prompt: '帮我构建一个新功能' },
  { Icon: IconRefresh, title: '审查代码并提出改进', prompt: '帮我审查代码，找出问题并提出改进建议' },
  { Icon: IconWrench, title: '修复问题和错误', prompt: '帮我修复一个 bug' },
];

// C1：消息窗口大小 —— 历史全量在 state，渲染只取最近 N 条，避免长会话 DOM 爆炸
const MSG_WINDOW = 50;

export default function ChatArea({
  thread, selectedModel, project, onNewMessage, mcpTools = [], enabledSkills = [], onOpenProjectPicker, initialPrompt, onPromptConsumed, approvalSettings, agentsMd = null,
  providers = [], onSelectModel, onApprovalChange, onThreadStatus, onAgentFilesChange,
  onThreadCreated,
  // 「本次使用中主动选择」的项目（App 层 selectProject 时置位）：
  // 欢迎页据此决定能否围绕该项目生成个性化建议与副标题——
  // 重启后残留的上次项目不算数，否则新建任务页整个都在说上一个任务
  projectPicked = false,
}) {
  const [messages, setMessages] = useState([]);
  const [windowStart, setWindowStart] = useState(0); // C1：窗口起点（顶部隐藏条数），长会话只渲染最近 MSG_WINDOW 条
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [reasoningText, setReasoningText] = useState(''); // 推理模型思考流（不落库）
  const [toolCalls, setToolCalls] = useState([]);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const [modelWarning, setModelWarning] = useState(false);
  const [fileSkills, setFileSkills] = useState([]);
  const [memories, setMemories] = useState([]);
  const [ambient, setAmbient] = useState([]);
  const [queued, setQueued] = useState([]); // 运行中排队的指令（下一轮自动执行）
  // P0-A：上一轮失败输入，供「重试本轮」一键重放（瞬时错误重试耗尽后，失败可挽回）
  const [lastFailed, setLastFailed] = useState(null); // { text }
  // 大任务拆分（token 效率）：plan=待用户确认的拆分卡片；planReport=分步完成报告
  const [plan, setPlan] = useState(null);           // { tasks:[{title,prompt}], reason }
  const [planReport, setPlanReport] = useState(null); // { title, index, total, next:{title,prompt}|null }
  const [decomposing, setDecomposing] = useState(false);
  const [compacting, setCompacting] = useState(false); // 上下文压缩中
  const [planMode, setPlanMode] = useState(false); // 规划模式：只出计划，不改动文件
  // 上下文窗口：模型自带字段优先，其次用户在模型配置 popover 里设置的值，最后 128K 兜底
  const contextUsage = contextUsageOf(
    messages,
    effectiveContextWindow(selectedModel?.provider, selectedModel?.model) || 128000,
  );
  const agentFilesRef = useRef(new Set()); // 本轮 Agent 改动的文件（供 Diff 面板「上一轮」筛选）
  // messagesRef：send 是 async 且常被 setTimeout/旧闭包调用（queue 接力、steer 补发），
  // 闭包里的 messages 是「调用方那次渲染」的值——queue 的下一轮会缺上一轮 assistant 回复，
  // 模型看不到自己刚说过什么。统一以 ref 读最新消息历史。
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // steer 补发：steer() 中止当前轮后 30ms 内 loading 仍是 true，直接 send 会被
  // `if (loading) return` 静默吞掉（对标 Codex 的「运行中引导」随机失效的根因）。
  // 改为挂到 ref，由本轮结束路径（finally）负责补发。
  const steerPendingRef = useRef(null);
  const [runMode, setRunMode] = useState('local'); // local | worktree（对标 Codex 运行模式）
  const [worktree, setWorktree] = useState(null); // 隔离工作区 { path, branch }
  const [modeMsg, setModeMsg] = useState(''); // 模式切换提示
  // A4：会话级扩展状态（数字员工 / 技能 / 连接器），随线程持久化、重开可恢复
  const EMPTY_EXTRAS = { expert: null, skillIds: [], mcpServers: [] };
  const [sessionExtras, setSessionExtras] = useState(EMPTY_EXTRAS);
  const [plusOpen, setPlusOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false); // A12：拖拽悬停提示
  // A5：语音录入状态机
  const voice = useVoice({ onText: (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)) });
  // 实际执行目录：隔离工作区就绪时用 worktree 路径，否则用项目目录
  const cwd = (runMode === 'worktree' && worktree?.path) ? worktree.path : (project?.path || '');

  // 首启向导带入的首任务提示词
  useEffect(() => {
    if (initialPrompt) {
      setInput(initialPrompt);
      onPromptConsumed?.();
    }
  }, [initialPrompt]);

  // 加载已启用的文件技能内容（~/.mjcode/skills）
  useEffect(() => {
    let cancelled = false;
    const builtin = new Set(BUILTIN_SKILL_IDS);
    const fileIds = (enabledSkills || []).filter((id) => !builtin.has(id));
    if (fileIds.length === 0 || !window.mjcode?.getSkill) { setFileSkills([]); return; }
    Promise.all(fileIds.map(async (id) => {
      try {
        const r = await window.mjcode.getSkill({ name: id });
        return r.ok ? { name: id, content: r.content } : null;
      } catch (err) {
        console.warn('[chat] 技能加载失败:', id, err);
        return null;
      }
    })).then((list) => { if (!cancelled) setFileSkills(list.filter(Boolean)); });
    return () => { cancelled = true; };
  }, [enabledSkills]);

  // 项目规范 AGENTS.md 由 App 层按项目路径加载后传入（此处不再重复探测）

  // 两阶段记忆 POC（stage2）：按项目加载历史沉淀，注入 system prompt
  useEffect(() => {
    if (!project?.path || !window.mjcode?.localListMemories) { setMemories([]); return; }
    window.mjcode.localListMemories({ projectPath: project.path, limit: 5 })
      .then((list) => setMemories((list || []).map((m) => m.content)))
      .catch((err) => console.warn('[chat] 记忆加载失败:', err));
  }, [project?.path]);

  // ambient 建议 POC：基于项目真实状态生成欢迎页建议
  // 只对「本次主动选择」的项目生成：重启后残留的上次项目不生成——
  // 否则用户要新建别的任务，欢迎页却整个在说上一个项目（真机反馈）
  useEffect(() => {
    if (!projectPicked || !project?.path || !window.mjcode?.gitStatus) { setAmbient([]); return; }
    (async () => {
      const tips = [];
      try {
        const st = await window.mjcode.gitStatus({ cwd: project.path });
        const lines = (st.stdout || '').trim().split('\n').filter(Boolean);
        if (lines.length > 0) tips.push(`总结当前 ${lines.length} 个文件的未提交变更`);
        const lang = project.languages?.[0];
        if (lang) tips.push(`审查这个 ${lang} 项目的代码质量并给出改进建议`);
        tips.push(`梳理 ${projectDisplayName(project)} 的项目结构，生成模块说明`);
      } catch (err) {
        console.warn('[chat] ambient 建议生成失败:', err);
      }
      setAmbient(tips.slice(0, 3));
    })();
  }, [projectPicked, project?.path, project?.branch]);

  // P1-G：切会话旧消息残留串显——thread.id 变化即清空，拉取完成前不渲染上一个会话的消息；
  // 并用请求序号防竞态（A→B→A 快速切换时，先发的旧响应晚到会覆盖新会话内容）
  const msgReqRef = useRef(0);
  // 真机事故根因：新会话首条消息时 thread?.id 从 undefined → 真实 id，本 effect 触发，
  // 下面的 abortRef.abort() 把刚启动的运行当场掐死（「已停止」+ 0 tokens，必现）。
  // 修复：用 prevThreadIdRef 区分「新建会话（undefined→id）」与「真实切换（id→不同 id）」，
  // 仅后者才需要中止在途运行与清理会话级状态。
  const prevThreadIdRef = useRef(null);
  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = thread?.id || null;
    const isCreatingThread = !prevId && !!thread?.id; // 新建会话 ≠ 切换会话
    if (thread?.id) {
      const reqId = ++msgReqRef.current;
      setLastFailed(null); // 切换会话：失败重试上下文不跨会话
      setMessages([]);     // 先清空：异步拉取期间禁止显示旧会话消息（串显根因）
      setToolCalls([]);
      setWindowStart(0);
      api.messages(thread.id).then((list) => {
        if (reqId !== msgReqRef.current) return; // 已被更新的切换取代，丢弃迟到响应
        // C1：全量拉取仅落 state，首屏只渲染最近 MSG_WINDOW 条（顶部「加载更早消息」展开）
        setMessages(list);
        setWindowStart(Math.max(0, (list || []).length - MSG_WINDOW));
      }).catch((err) => {
        if (reqId === msgReqRef.current) console.warn('[chat] 消息加载失败:', err);
      });
    } else { setMessages([]); setToolCalls([]); setWindowStart(0); }
    // 会话级状态不得跨会话残留（ChatArea 常驻挂载不卸载，残留会串显/误生效）：
    //   流式文本属于上一个会话，切走后 runAgent 仍在跑，必须一并中止并清空，
    //   否则旧会话的流式输出会打在新会话的消息区上；planMode 残留会让新会话
    //   莫名变成「只读规划」（写工具全被移除），用户完全无感知。
    //   注意：新建会话（undefined→id）不在此列：那一步正在进行的是「本会话自己的首条消息」。
    if (isCreatingThread) return;
    abortRef.current?.abort();
    if (window.mjcode?.abortChat) window.mjcode.abortChat();
    setStreamingText('');
    setReasoningText('');
    setPlan(null);
    setPlanReport(null);
    setPlanMode(false);
  }, [thread?.id]);

  // A4：sessionExtras 按线程持久化（localStorage，线程切换时恢复）
  useEffect(() => {
    if (!thread?.id) { setSessionExtras({ expert: null, skillIds: [], mcpServers: [] }); return; }
    try {
      const saved = JSON.parse(localStorage.getItem(`mj_extras_${thread.id}`));
      setSessionExtras(saved && typeof saved === 'object' ? { expert: null, skillIds: [], mcpServers: [], ...saved } : { expert: null, skillIds: [], mcpServers: [] });
    } catch (e) {
      console.warn('[chat] 会话扩展状态解析失败:', e);
      setSessionExtras({ expert: null, skillIds: [], mcpServers: [] });
    }
  }, [thread?.id]);

  useEffect(() => {
    if (!thread?.id) return;
    try { localStorage.setItem(`mj_extras_${thread.id}`, JSON.stringify(sessionExtras)); } catch (e) { /* ignore */ }
  }, [sessionExtras, thread?.id]);

  // C2：生态中心「在当前会话启用」事件（与 PlusMenu 共用 sessionExtras 通道）
  useEffect(() => {
    const onExpert = (e) => { if (e.detail) setSessionExtras((prev) => ({ ...prev, expert: e.detail })); };
    const onSkill = (e) => {
      const id = e.detail?.id || e.detail?.dir || e.detail?.name;
      if (!id) return;
      setSessionExtras((prev) => ({
        ...prev,
        skillIds: prev.skillIds.includes(id) ? prev.skillIds : [...prev.skillIds, id],
      }));
    };
    window.addEventListener('mjcode:enable-expert', onExpert);
    window.addEventListener('mjcode:enable-skill', onSkill);
    return () => {
      window.removeEventListener('mjcode:enable-expert', onExpert);
      window.removeEventListener('mjcode:enable-skill', onSkill);
    };
  }, []);

  // 切换项目时清空一切与上一个项目/任务绑定的状态。
  // 否则隔离工作区会指向旧项目的副本，Agent 把改动写进错误目录。
  useEffect(() => {
    setWorktree(null);
    setRunMode('local');
    setModeMsg('');
    setToolCalls([]);
    setStreamingText('');
    setQueued([]);
    setCompacting(false);
    agentFilesRef.current = new Set();
    onAgentFilesChange?.([]);
  }, [project?.path]);

  // C3：智能滚底 —— 仅当用户已在底部附近（<80px）才跟随；上翻历史时不再被强制拽回，
  // 由悬浮的「回到底部」按钮接管（stickToBottomRef 在 onScroll 中维护）
  const stickToBottomRef = useRef(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowJumpBottom(!nearBottom);
  }
  useEffect(() => {
    if (stickToBottomRef.current) scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, streamingText, toolCalls.length]);

  useEffect(() => {
    if (!window.mjcode?.onDelta) return;
    // 返回 cleanup，避免 StrictMode 重复注册导致流式文本翻倍
    const off = window.mjcode.onDelta((delta) => setStreamingText((prev) => prev + delta));
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 推理模型思考流：mimo / DeepSeek-R 系在 content 之前输出 reasoning_content，
  // 实时展示（灰色折叠区），消除「思考中...长时间无输出」的慢错觉
  useEffect(() => {
    if (!window.mjcode?.onReasoning) return;
    const off = window.mjcode.onReasoning((chunk) => setReasoningText((prev) => (prev || '') + chunk));
    return () => { if (typeof off === 'function') off(); };
  }, []);

  function stop() {
    abortRef.current?.abort();
    if (window.mjcode?.abortChat) window.mjcode.abortChat();
  }

  // Esc 快捷停止生成
  useEffect(() => {
    if (!loading) return;
    const onKey = (e) => { if (e.key === 'Escape') stop(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading]);

  // 文件树点击文件 → 插入路径引用到输入框
  useEffect(() => {
    const onInsert = (e) => {
      const p = e.detail;
      if (!p) return;
      setInput((prev) => (prev ? `${prev}\n@${p}` : `@${p}`));
    };
    window.addEventListener('mjcode:insert-path', onInsert);
    return () => window.removeEventListener('mjcode:insert-path', onInsert);
  }, []);

  // A12：拖拽/粘贴文件 → 路径引用（Electron ≥32 需经 preload webUtils 解析路径）
  async function ingestFiles(fileList) {
    const paths = [];
    for (const f of Array.from(fileList || [])) {
      const p = window.mjcode?.getPathForFile?.(f) || f.path || '';
      if (p) { paths.push(p); continue; }
      // 无路径（粘贴图片等）：经主进程落盘到 userData/uploads
      try {
        const buf = await f.arrayBuffer();
        const r = await window.mjcode.saveUpload?.({ name: f.name || `image-${Date.now()}.png`, dataBase64: arrayBufferToBase64(buf) });
        if (r?.ok) paths.push(r.path);
      } catch (err) {
        console.warn('[chat] 文件落盘失败:', err);
      }
    }
    if (paths.length) {
      setInput((prev) => (prev ? `${prev}\n${paths.map((p) => `@${p}`).join('\n')}` : paths.map((p) => `@${p}`).join('\n')));
    }
    return paths.length;
  }

  // Ctrl+M 按住说话（对标 Codex）：按下开始、松开结束
  // 注意只用 Ctrl：Cmd+M 是 macOS 最小化窗口的系统快捷键，不可劫持
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (!e.repeat && voice.state === 'idle') voice.start();
      }
    };
    const onKeyUp = (e) => {
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (voice.state === 'recording') voice.stop();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
    // 只依赖 start/stop（useCallback 稳定，仅状态机切换时重建）：
    // 依赖 [voice] 的话 elapsed 每 250ms 变一次，监听会跟着每 250ms 卸载重挂
  }, [voice.start, voice.stop]);

  async function pickFiles() {
    try {
      const r = await window.mjcode.pickFiles();
      if (r.ok && r.paths?.length) {
        setInput((prev) => (prev ? `${prev}\n${r.paths.map(p => `@${p}`).join('\n')}` : r.paths.map(p => `@${p}`).join('\n')));
      }
    } catch (err) {
      console.warn('[chat] 文件选择失败:', err);
    }
  }

  async function send(text, forcedThread, opts = {}) {
    const content = text || input;
    if (!content.trim()) return;
    // steer 补发路径（opts.force）在本轮已 abort 之后运行，不与旧轮并发，可绕过 loading 检查；
    // 其余常规路径维持「运行中不发新请求」的语义
    if (loading && !opts.force) return;
    if (!selectedModel) { setModelWarning(true); return; }
    setModelWarning(false);
    // 真正进入执行段：拆分卡片使命已结束（无论按步骤执行还是发新指令），必须收起，
    // 否则用户在执行过程中仍看到「待确认」的拆分卡片，误以为还没开始
    setPlan(null);

    // 大任务拆分闸门（token 效率）：本地启发式命中后只花一次小规划调用，
    // 结果交用户在拆分卡片中确认；确认前不执行。任何异常都 fail-open 按原样执行。
    if (!opts.skipDecompose && !plan
        && localStorage.getItem('mj_auto_decompose') !== '0'
        && looksLargeTask(content)) {
      setDecomposing(true);
      try {
        const r = await decomposeTask({
          messages: [...messages, { role: 'user', content }],
          model: selectedModel,
        });
        if (r?.decompose && r.tasks.length >= 2) {
          setPlan({ tasks: r.tasks, reason: r.reason || '' });
          setDecomposing(false);
          return; // 等用户在拆分卡片中选择要执行的步骤
        }
      } catch (err) {
        console.warn('[chat] 任务拆分分析失败，按原样执行:', err);
      }
      setDecomposing(false);
    }

    // 自动创建会话（项目路径用于「项目 → 会话」归属）
    // Bug1：未选项目时允许直接发送（不自动创建日期文件夹）；项目由用户在项目弹窗中主动创建/选择
    let currentThread = forcedThread || thread;
    let effectiveProject = project;
    if (!currentThread) {
      currentThread = await api.createThread({
        provider_id: selectedModel.provider?.id,
        model_id: selectedModel.model?.id,
        provider_name: selectedModel.provider?.name,
        model_name: selectedModel.model?.model_id,
        cwd: effectiveProject?.path || cwd,
        project_path: effectiveProject?.path || '',
        title: content.slice(0, 50),
      });
      onNewMessage();
      // 关键：把新会话设为当前会话，否则 ChatArea 仍渲染欢迎页，
      // 首条消息与流式输出全部不可见，必须手动再点一次列表（真机事故）
      onThreadCreated?.(currentThread);
    }

    const userMsg = { role: 'user', content };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setLastFailed(null);
    setLoading(true);
    setToolCalls([]);
    onThreadStatus?.('running');
    await api.sendMessage(currentThread.id, userMsg);

    // 以 ref 读最新历史：queue 接力 / steer 补发经由旧闭包调用时，
    // 闭包 messages 缺上一轮 assistant 回复，模型看不到自己刚说过什么
    const history = [...messagesRef.current, userMsg];
    // A4：数字员工注入 system prompt（仅本轮生效，不写入消息历史）；会话级技能并入启用列表
    const expertPrompt = sessionExtras?.expert ? buildExpertPrompt(sessionExtras.expert) : null;
    const runHistory = expertPrompt ? [{ role: 'system', content: expertPrompt }, ...history] : history;
    const runSkills = [...new Set([...(enabledSkills || []), ...(sessionExtras?.skillIds || [])])];
    abortRef.current = new AbortController();

    try {
      // Fix3：按模型 key 读取用户在 popover 里配置的思考强度，注入本轮请求
      const mc = getModelConfig(modelKeyOf(selectedModel?.provider, selectedModel?.model));
      const runModel = mc?.reasoning_effort
        ? { ...selectedModel, model: { ...selectedModel.model, reasoning_effort: mc.reasoning_effort } }
        : selectedModel;
      // P0-B / PM-L1：未选项目（无 cwd）时强制只读——防止工具落主进程目录且无沙箱保护
      const noProject = !effectiveProject?.path && !cwd;
      await runAgent({
        messages: runHistory,
        model: runModel,
        mcpTools,
        enabledSkills: runSkills,
        signal: abortRef.current.signal,
        // 兜底建目录后 render 闭包中的 cwd 已过期：优先用本轮解析出的项目路径
        cwd: effectiveProject?.path || cwd,
        agentsMd,
        skills: fileSkills,
        memories,
        // 规划模式强制沙箱降级为只读（双保险：工具已移除 + 沙箱禁写）
        sandboxPolicy: planMode || noProject ? 'read-only' : (thread?.sandbox_policy || approvalSettings?.sandbox_policy || 'workspace-write'),
        approvalMode: thread?.approval_mode || approvalSettings?.approval_mode || 'on-request',
        planMode,
        conversationId: thread?.id ? String(thread.id) : 'local',
        onMessage: async (msg) => {
          // 中间轮 assistant（含 tool_calls）与 tool 结果消息全量持久化
          try {
            await api.sendMessage(currentThread.id, {
              role: msg.role,
              content: msg.content,
              tool_calls: msg.tool_calls || null,
              tool_call_id: msg.tool_call_id || null,
              tokens_input: msg.tokens_input || 0,
              tokens_output: msg.tokens_output || 0,
            });
          } catch (err) {
            console.warn('[chat] 中间消息持久化失败:', err);
          }
        },
        onStream: () => { setStreamingText(''); setReasoningText(''); },
        onToolCall: (tc) => {
          setToolCalls((prev) => [...prev, tc]);
          for (const f of agentFilesOf(tc)) agentFilesRef.current.add(f);
        },
        onDone: async (finalText, usage, aborted) => {
          // Bugfix：即时中止收尾时 finalText 为空串（引擎真实结果尚未返回），
          // 不再拼出 "\n\n（已停止）" 的空尾消息，直接显示「（已停止）」
          const content = aborted
            ? (finalText ? `${finalText}\n\n（已停止）` : '（已停止）')
            : finalText;
          const assistantMsg = {
            role: 'assistant',
            content,
            model_name: selectedModel.model.model_id,
            // 底部 token 明细（参考 WorkBuddy：模型名 + 消耗量）+ 时间戳
            tokens_input: usage?.prompt_tokens || 0,
            tokens_output: usage?.completion_tokens || 0,
            created_at: Date.now(),
          };
          setMessages((m) => [...m, assistantMsg]);
          await api.sendMessage(currentThread.id, {
            ...assistantMsg,
            tokens_input: usage?.prompt_tokens || 0,
            tokens_output: usage?.completion_tokens || 0,
          });
          // 两阶段记忆 POC（stage1）：会话完成即留存原始记忆
          if (project?.path && window.mjcode?.localAddMemory && !aborted) {
            try {
              window.mjcode.localAddMemory({
                projectPath: project.path,
                content: `问「${content.slice(0, 80)}」→ 结论：${finalText.slice(0, 200)}`,
              });
            } catch (err) { console.warn('[chat] 记忆留存失败:', err); }
          }
          onNewMessage();
          onAgentFilesChange?.([...agentFilesRef.current]);
          agentFilesRef.current = new Set();
          if (!aborted) {
            onThreadStatus?.('done');
            // 分步完成报告：本步结果 + 是否继续下一步（下一步由用户在输入框决定发送）
            if (opts.planStep) {
              const ps = opts.planStep;
              setPlanReport({
                title: ps.title,
                index: ps.index,
                total: ps.total,
                next: ps.tasks[ps.index + 1] || null,
                tokens: { in: usage?.prompt_tokens || 0, out: usage?.completion_tokens || 0 },
                model: selectedModel.model.model_id,
              });
            }
            // queue：排队指令在本轮结束后自动接力执行（对标 Codex Tab 排队）
            setQueued((q) => {
              const next = q[0];
              if (next) setTimeout(() => send(next, currentThread), 0);
              return q.slice(1);
            });
          } else {
            // 用户中止后线程状态必须收敛：不设的话侧栏永远显示「运行中」徽标
            onThreadStatus?.('idle');
          }
        },
      });
    } catch (err) {
      const msg = String(err.message || '').startsWith('KEY_MISSING')
        ? '模型凭证未加载，请在本机模型设置中重新填写 API Key'
        : err.message;
      // 此前错误消息不带 model_name → meta 行整体隐藏，用户侧三样全缺（模型/耗时/token）无从判断
      setMessages((m) => [...m, { role: 'assistant', content: `**错误**: ${msg}`, model_name: selectedModel?.model?.model_id || '' }]);
      // P0-A：失败可挽回——记录本次输入，用户可一键「重试本轮」（历史已保留，无需手动重打）
      setLastFailed({ text: content });
      onThreadStatus?.('idle');
    }
    abortRef.current = null;
    setStreamingText('');
    setReasoningText('');
    setLoading(false);
    // steer 补发：本轮已完全退出（无并发 run），用 messagesRef 拿到的最新历史重开一轮。
    // 不能在 steer() 里直接 send——那时 loading 仍为 true，请求会被运行中检查静默吞掉。
    const pendingSteer = steerPendingRef.current;
    steerPendingRef.current = null;
    if (pendingSteer) setTimeout(() => send(pendingSteer, undefined, { force: true }), 0);
  }

  // steer（对标 Codex 运行中按 Enter）：立刻中止当前轮并用新指令重开
  // 价值：方向偏了立即纠偏，比等它跑完再重来便宜得多。
  // 补发改由 send 结束路径执行（steerPendingRef）——此处 loading 仍为 true，
  // 直接 send 会被 `if (loading && !opts.force) return` 静默吞掉，引导看似点了没反应。
  function steer(text) {
    const t = String(text || '').trim();
    if (!t) return;
    abortRef.current?.abort();
    if (window.mjcode?.abortChat) window.mjcode.abortChat();
    setQueued([]);
    steerPendingRef.current = t;
  }

  // queue（对标 Codex 运行中按 Tab）：排队到下一轮，不打断当前轮
  function queueNext(text) {
    const t = String(text || '').trim();
    if (!t) return;
    setQueued((q) => [...q, t]);
  }

  // /clear：清空当前对话上下文
  function clearContext() {
    abortRef.current?.abort();
    setMessages([]);
    setWindowStart(0);
    setToolCalls([]);
    setStreamingText('');
  }

  // /plan 开关：进入规划模式后禁用全部写工具，Agent 只能读与规划
  function enablePlanMode() {
    setPlanMode(true);
    setInput((v) => (v.trim() ? `${v}（规划模式：先给出实施计划，不要修改任何文件，等我确认后再执行）` : '/plan '));
  }

  // 切换运行模式：进入隔离工作区时按需创建 worktree 副本
  async function switchMode(next) {
    if (next === runMode) return;
    setModeMsg('');
    if (next !== 'worktree') { setRunMode('local'); return; }
    setRunMode('worktree');
    if (!project?.path) { setModeMsg('请先选择项目'); setRunMode('local'); return; }
    if (worktree?.path) return;
    setModeMsg('正在创建隔离工作区…');
    try {
      const r = await window.mjcode.createWorktree({
        path: project.path,
        taskTitle: thread?.title || project.name,
      });
      if (!r?.ok) { setModeMsg(r?.error || '创建隔离工作区失败'); setRunMode('local'); return; }
      setWorktree({ path: r.path, branch: r.branch });
      setModeMsg(`已在 ${r.branch} 创建隔离副本，Agent 的改动不影响主目录`);
    } catch (err) {
      setModeMsg(`创建隔离工作区失败：${err.message}`);
      setRunMode('local');
    }
  }

  // /compact：把早期对话摘要化，保留最近若干轮（对标 Codex 的上下文压缩）
  // P2-6 收口：压缩结果落库（本地模式整体替换消息表），重进会话不再回到压缩前；
  // 在线模式服务端无替换路由，降级为仅当前窗口生效并如实提示
  async function compactContext() {
    if (compacting || !selectedModel || messages.length === 0) return;
    setCompacting(true);
    try {
      const convo = messages.map((m) => ({ role: m.role, content: m.content || '' }));
      const compacted = await compactHistory(convo, selectedModel, window.mjcode.chat);
      if (compacted.length >= convo.length) return;
      setMessages(compacted);
      setWindowStart(0);
      if (thread?.id) {
        try {
          const r = await api.replaceMessages(thread.id, compacted);
          if (r?.ok) toast({ message: '上下文已压缩并保存，重进会话仍生效' });
          else if (r?.error) toast({ message: `压缩结果未持久化：${r.error}` });
        } catch (err) {
          // 在线模式等无替换通道：仅当前窗口生效（静默降级，不打断压缩流程）
          console.warn('[chat] 压缩结果持久化不可用（仅当前窗口生效）:', err?.message);
        }
      }
    } catch (err) {
      console.warn('[chat] 上下文压缩失败:', err);
      toast({ message: `上下文压缩失败：${err?.message || '未知错误'}` });
    } finally {
      setCompacting(false);
    }
  }

  // 欢迎页
  if (!thread) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <h1 className="text-4xl font-semibold text-center mb-3">我们要构建什么？</h1>
        {/* 副标题 = 项目入口（真机反馈：新建任务页找不到「选择目录/创建项目」入口）。
            只在本轮主动选择过项目时才说「在 X 中」——重启后残留的上次项目
            不是用户的选择，不得当默认事实展示（空态不得伪装成已选） */}
        <p className="text-text2 text-sm mb-12">
          {project?.path && projectPicked ? (
            <>在 {projectDisplayName(project)} 中 · </>
          ) : (
            <>告诉 MJ Coder 你想做什么 · </>
          )}
          <button onClick={onOpenProjectPicker}
            className="text-accent hover:underline underline-offset-2">
            {project?.path && projectPicked ? '切换项目' : '打开或创建项目'}
          </button>
        </p>

        <div className="grid grid-cols-4 gap-4 max-w-3xl mb-12">
          {/* C5：固定 8 槽位（ambient 不足用默认建议补齐），避免 4+3 排列不齐 */}
          {(() => {
            const DEFAULT_TIPS = ['总结这个项目的整体架构与关键模块', '找出代码中潜在的性能与安全问题'];
            const slots = [...ambient];
            for (const tip of DEFAULT_TIPS) {
              if (slots.length >= 8 - QUICK_ACTIONS.length) break;
              if (!slots.includes(tip)) slots.push(tip);
            }
            return (
              <>
                {slots.map((tip) => (
                  <button key={tip} onClick={() => send(tip)}
                    className="border border-accent/40 rounded-2xl p-5 text-left hover:bg-hover transition-colors">
                    <div className="mb-3 text-accent"><IconZap size={22} /></div>
                    <div className="text-sm text-text leading-snug">{tip}</div>
                  </button>
                ))}
                {QUICK_ACTIONS.map((q) => (
                  <button key={q.title} onClick={() => send(q.prompt)}
                    className="border border-border rounded-2xl p-5 text-left hover:bg-hover hover:border-accent transition-colors">
                    <div className="mb-3 text-accent"><q.Icon size={22} /></div>
                    <div className="text-sm text-text leading-snug">{q.title}</div>
                  </button>
                ))}
              </>
            );
          })()}
        </div>

        {modelWarning && (
          <div className="max-w-3xl w-full mx-auto mb-4">
            <InlineAlert type="warn" onDismiss={() => setModelWarning(false)}>
              尚未选择模型。请在输入框下方的模型选择器中选择，或在「设置 → 模型配置」中添加。
            </InlineAlert>
          </div>
        )}

        {/* P1-H：隔离工作区收口条（合并回主目录/提升为分支/清理）——worktree 只建不收的断链修复 */}
        <WorktreeBar
          worktree={runMode === 'worktree' ? worktree : null}
          onClosed={() => { setWorktree(null); setRunMode('local'); }}
          onMsg={(m) => setModeMsg(m)}
        />
        {/* WorkBuddy 式 Agent 运行胶囊：在役数字员工一览（点击展开流程与强制关闭） */}
        <AgentDock />
        <Composer
          input={input} setInput={setInput} onSend={send} onStop={stop} onPickFiles={pickFiles}
          loading={loading} selectedModel={selectedModel} project={project}
          onOpenProjectPicker={onOpenProjectPicker} agentsMd={agentsMd}
          providers={providers} onSelectModel={onSelectModel}
          approval={approvalSettings} onApprovalChange={onApprovalChange}
          onSteer={steer} onQueue={queueNext} onClear={clearContext} queuedCount={queued.length} queued={queued} onQueueRemove={(i) => setQueued((q) => q.filter((_, j) => j !== i))}
          onCompact={compactContext} compacting={compacting}
          contextUsage={contextUsage} onPlanMode={enablePlanMode} planMode={planMode}
          runMode={runMode} onModeChange={switchMode} worktreeInfo={worktree} modeMsg={modeMsg}
          decomposing={decomposing} plan={plan} onPlanChange={setPlan}
          planReport={planReport} onPlanReportChange={setPlanReport}
          cwd={cwd} lastFailed={lastFailed} onLastFailedChange={setLastFailed}
          workspaceBound={!!thread}
          extras={sessionExtras} onExtrasChange={setSessionExtras}
          plusOpen={plusOpen} onPlusOpenChange={setPlusOpen}
          voice={voice} onDropFiles={ingestFiles} messages={messages}
          connectedServers={[...new Set((mcpTools || []).map((t) => String(t.function?.name || '').split('__')[1]).filter(Boolean))]}
        />
      </div>
    );
  }

  // 对话页
  //布局要点：消息区必须 min-h-0。
  // flex 子项默认 min-height:auto，内容多高容器就被撑多高，overflow-y-auto 失效，
  // 表现为「聊得越多，输入框被顶得越往下直到看不见」。
  // C1：窗口切片渲染；起点落在 tool 消息上时向前回退，避免切断 assistant(tool_calls) 与结果的配对
  let effStart = windowStart;
  while (effStart > 0 && effStart < messages.length && messages[effStart].role === 'tool') effStart -= 1;
  const visibleMessages = messages.slice(effStart);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* C3：滚动视口包裹层（relative），承载悬浮的「回到底部」按钮 */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-4" onScroll={handleScroll}>
        {effStart > 0 && (
          <div className="flex justify-center mb-3">
            <button onClick={() => setWindowStart(Math.max(0, effStart - MSG_WINDOW))}
              className="text-xs text-text2 hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-hover">
              加载更早消息（还有 {effStart} 条）
            </button>
          </div>
        )}
        {renderMessages(visibleMessages)}
        {toolCalls.map((tc, i) => (
          <div key={`tool-${i}`} className="mb-2 ml-2">
            <div className="bg-surface border border-border rounded-lg px-3 py-2 text-xs font-mono flex items-center gap-2">
              <IconTerminal size={13} className={tc.result?.error ? 'text-danger shrink-0' : 'text-accent shrink-0'} />
              <span className={tc.result?.error ? 'text-danger' : 'text-accent'}>{toolNameCN(tc.name)}</span>
              <span className="text-text2 truncate">{JSON.stringify(tc.args).slice(0, 120)}</span>
            </div>
            {/* 工具失败原因必须可见：agent-core 失败时返回 { error: message } */}
            {tc.result?.error && (
              <OutputBlock className="mt-1 text-xs text-danger bg-danger-bg border border-danger p-2 rounded whitespace-pre-wrap" text={tc.result.error} />
            )}
            {tc.result?.stdout && <OutputBlock className="mt-1 text-xs bg-surface border border-border p-2 rounded whitespace-pre-wrap" text={tc.result.stdout} />}
            {tc.result?.stderr && <OutputBlock className="mt-1 text-xs text-danger bg-danger-bg border border-border p-2 rounded whitespace-pre-wrap" text={tc.result.stderr} max={300} />}
          </div>
        ))}
        {/* 推理模型思考流：实时可见（灰色小字，可折叠），消除「假慢」 */}
        {loading && reasoningText && (
          <details className="mb-3 max-w-3xl" open>
            <summary className="text-xs text-text2 cursor-pointer select-none">
              思考中… <span className="text-text2/70">（{reasoningText.length} 字，点击折叠）</span>
            </summary>
            <pre className="mt-1 text-xs text-text2 bg-surface border border-border rounded-lg p-2 whitespace-pre-wrap max-h-40 overflow-y-auto">{reasoningText}</pre>
          </details>
        )}
        {streamingText && (
          <div className="mb-4 max-w-3xl">
            <div className="text-xs text-text2 mb-1">MJ Coder <span className="animate-pulse">▋</span></div>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
          </div>
        )}
        {loading && !streamingText && !reasoningText && toolCalls.length === 0 && <div className="text-text2 text-sm">思考中...</div>}
      </div>
      {/* C3：用户上翻历史时出现，点击回底并恢复跟随 */}
      {showJumpBottom && (
        <button
          onClick={() => {
            stickToBottomRef.current = true;
            const el = scrollRef.current;
            el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            setShowJumpBottom(false);
          }}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 text-xs px-3 py-1.5 rounded-full bg-raise border border-border shadow-[var(--shadow-pop)] text-text2 hover:text-text"
        >
          回到底部
        </button>
      )}
      </div>
      {/* Composer 容器必须 shrink-0：否则会被上方消息区挤压，输入框被推出可视区*/}
      <div className="px-6 pb-4 shrink-0">
        {modelWarning && (
          <div className="max-w-3xl w-full mx-auto mb-3">
            <InlineAlert type="warn" onDismiss={() => setModelWarning(false)}>
              尚未选择模型。请在输入框下方的模型选择器中选择，或在「设置 → 模型配置」中添加。
            </InlineAlert>
          </div>
        )}
        {/* P1-H：隔离工作区收口条（合并回主目录/提升为分支/清理）——worktree 只建不收的断链修复 */}
        <WorktreeBar
          worktree={runMode === 'worktree' ? worktree : null}
          onClosed={() => { setWorktree(null); setRunMode('local'); }}
          onMsg={(m) => setModeMsg(m)}
        />
        {/* WorkBuddy 式 Agent 运行胶囊：在役数字员工一览（点击展开流程与强制关闭） */}
        <AgentDock />
        <Composer
          input={input} setInput={setInput} onSend={send} onStop={stop} onPickFiles={pickFiles}
          loading={loading} selectedModel={selectedModel} project={project}
          onOpenProjectPicker={onOpenProjectPicker} agentsMd={agentsMd}
          providers={providers} onSelectModel={onSelectModel}
          approval={approvalSettings} onApprovalChange={onApprovalChange}
          onSteer={steer} onQueue={queueNext} onClear={clearContext} queuedCount={queued.length} queued={queued} onQueueRemove={(i) => setQueued((q) => q.filter((_, j) => j !== i))}
          onCompact={compactContext} compacting={compacting}
          contextUsage={contextUsage} onPlanMode={enablePlanMode} planMode={planMode}
          runMode={runMode} onModeChange={switchMode} worktreeInfo={worktree} modeMsg={modeMsg}
          decomposing={decomposing} plan={plan} onPlanChange={setPlan}
          planReport={planReport} onPlanReportChange={setPlanReport}
          cwd={cwd} lastFailed={lastFailed} onLastFailedChange={setLastFailed}
          workspaceBound={!!thread}
          extras={sessionExtras} onExtrasChange={setSessionExtras}
          plusOpen={plusOpen} onPlusOpenChange={setPlusOpen}
          voice={voice} onDropFiles={ingestFiles} messages={messages}
          connectedServers={[...new Set((mcpTools || []).map((t) => String(t.function?.name || '').split('__')[1]).filter(Boolean))]}
        />
      </div>
    </div>
  );
}

function Composer({
  input, setInput, onSend, onStop, onPickFiles, loading, selectedModel, project,
  onOpenProjectPicker, agentsMd, providers, onSelectModel, approval, onApprovalChange,
  onSteer, onQueue, onClear, queuedCount, queued = [], onQueueRemove, contextUsage, onCompact, compacting,
  onPlanMode, planMode, modeMsg,
  // 大任务拆分 / 未选项目只读边界 / 失败重试：三者状态归 ChatArea 所有，经 props 传入。
  // 位置纪律：这些 JSX 曾直接引用父组件的局部变量（decomposing / plan / planReport /
  //   cwd / lastFailed / send / thread）→ 渲染 Composer 即 "decomposing is not defined" 白屏。
  //  Composer 是独立 function 组件，拿不到父组件的词法作用域，只能走 props。
  decomposing = false, plan = null, onPlanChange, planReport = null, onPlanReportChange,
  cwd = '', lastFailed = null, onLastFailedChange,
  // 是否已进入某个会话（= 真的身处当前工作区）。
  // false 时状态行不显示项目/分支/上下文环：新建任务页不得把「上次打开的项目」当已选事实展示。
  workspaceBound = false,
  runMode, onModeChange, worktreeInfo,
  extras, onExtrasChange, plusOpen, onPlusOpenChange, voice, onDropFiles, messages = [], connectedServers = [],
}) {
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);   // 指针悬停在输入框上
  const [winDrag, setWinDrag] = useState(false);     // 文件拖进应用窗口（任意位置）
  const taRef = useRef(null);
  const expert = extras?.expert || null;
  const voiceActive = voice?.state === 'recording' || voice?.state === 'transcribing';
  // 会话级徽标是否非空：全空时整行不渲染，避免留一条空白行把输入框往下推
  const hasTaskBadges = Boolean(
    planMode || expert
    || (extras?.skillIds || []).length > 0
    || (extras?.mcpServers || []).length > 0,
  );

  // C10：Composer 自适应高度（1 行起步，最多 8 行，超出内部滚动）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const lineHeight = 20;
    ta.style.height = `${Math.min(ta.scrollHeight, lineHeight * 8 + 16)}px`;
    ta.style.overflowY = ta.scrollHeight > lineHeight * 8 + 16 ? 'auto' : 'hidden';
  }, [input]);

  // 斜杠命令（对标 Codex）：输入 / 唤起，选中后填入输入框等待补充参数
  const matches = input.startsWith('/')
    ? SLASH_COMMANDS.filter((c) => c.key.startsWith(input.slice(1).toLowerCase()))
    : [];

  function pickSlash(cmd) {
    if (cmd.pending) return; // C8：未实现命令不可选
    setInput(cmd.key + ' ');
    setSlashOpen(false);
    if (cmd.key === '/clear') onClear?.();
    if (cmd.key === '/compact') onCompact?.();
    if (cmd.key === '/plan') onPlanMode?.();
  }

  async function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const n = await onDropFiles?.(e.dataTransfer?.files);
    if (n === 0 && e.dataTransfer?.files?.length) {
      // 能力边界诚实呈现：路径解析全部失败时不静默吞掉
      setInput((prev) => `${prev}\n（无法读取拖入文件的本地路径）`);
    }
  }

  // 全窗口拖拽入参（真机反馈：只能拖到输入框那一小块，拖到消息区毫无反应）。
  // 两个必须处理的点：
  //   ① dragover 必须 preventDefault，否则 Electron 会用被拖文件的路径导航整个页面 → 白屏
  //   ② 输入框自身的落点已处理过的事件（defaultPrevented=true）不能重复入参
  // 计数法处理 dragenter/dragleave：子元素间移动会成对触发，只按深度归零才收起蒙层
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onEnter = (e) => { if (!hasFiles(e)) return; depth += 1; setWinDrag(true); };
    const onOver = (e) => { if (!hasFiles(e)) return; e.preventDefault(); };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setWinDrag(false);
    };
    const onDrop = async (e) => {
      if (!hasFiles(e)) return;
      const alreadyHandled = e.defaultPrevented; // 输入框落点先行处理过
      e.preventDefault();
      depth = 0;
      setWinDrag(false);
      if (alreadyHandled) return;
      const files = e.dataTransfer?.files;
      const n = await onDropFiles?.(files);
      if (n === 0 && files?.length) {
        setInput((prev) => `${prev}${prev ? '\n' : ''}（无法读取拖入文件的本地路径）`);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onDropFiles, setInput]);

  async function handlePaste(e) {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      const n = await onDropFiles?.(files);
      const hasImage = Array.from(files).some((f) => f.type?.startsWith('image/'));
      if (hasImage) {
        setInput((prev) => `${prev}${prev ? '\n' : ''}（提示：当前模型暂不支持图片理解，图片已按路径引用）`);
      }
      if (n === 0) setInput((prev) => `${prev}${prev ? '\n' : ''}（无法读取粘贴内容的本地路径）`);
    }
  }

  return (
    <div className="max-w-3xl w-full mx-auto">
      {/* 全窗口拖拽蒙层：拖到对话区任意位置都能入参（拖不进输入框时不再毫无反馈）。
          pointer-events-none：落点判定交给下方真实元素与 window 监听，蒙层本身不吞事件 */}
      {winDrag && !dragOver && (
        <div className="fixed inset-0 z-drawer flex items-center justify-center pointer-events-none">
          <div className="bg-surface border-2 border-dashed border-accent rounded-2xl px-6 py-4 text-sm text-text shadow-[var(--shadow-pop)]">
            松开以把文件加入对话
          </div>
        </div>
      )}

      {/* 任务状态行：项目 / 分支 / 上下文 / 会话级徽标（A4） */}
      {/* 产品逻辑（真机反馈，已重复多次）：项目 / 分支 / 上下文环都是「本会话运行在哪个工作区」的
          事实陈述，只在已进入某个会话（= 真的在当前工作区里）时才有意义。
          新建任务页此前把上次打开的项目名（如 20261013-1271）当常驻信息挂着，
          等于把内部标识伪装成用户的选择——空态不得伪装成已选。
          未进入会话时整行不渲染；项目本身仍会随首条消息自动携带（send 用 project prop）。 */}
      {workspaceBound && (
        <div className="flex items-center gap-3 px-4 pb-2 text-xs text-text2">
          {project?.path && (
            <button onClick={onOpenProjectPicker} className="hover:text-text truncate max-w-[200px] flex items-center gap-1"
              title={`切换项目目录（${project.path}）`}>
              <IconFolder size={13} />
              {projectDisplayName(project)}
            </button>
          )}
          {project?.path && (
            <span className="truncate flex items-center gap-1" title={project.branch ? `分支：${project.branch}` : '当前目录不是 Git 仓库'}>
              <IconGitBranch size={13} />
              {project.branch || '非 Git'}
            </span>
          )}
          {contextUsage && (
            <ContextRing usage={contextUsage} onClick={onCompact} compacting={compacting} />
          )}
        </div>
      )}
      {hasTaskBadges && (
      <div className="flex items-center gap-3 px-4 pb-2 text-xs text-text2">
        {planMode && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-info-bg text-info shrink-0" title="规划模式：写工具已移除，只输出计划">
            规划模式
          </span>
        )}
        {expert && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-bg text-accent shrink-0 flex items-center gap-1"
            title={`数字员工：${expert.mission || ''}（点击移除）`}>
            <IconBot size={11} />
            {expert.title_cn || expert.name}
            <button onClick={() => onExtrasChange?.({ ...extras, expert: null })} aria-label="移除数字员工" className="hover:opacity-70">
              <IconX size={10} />
            </button>
          </span>
        )}
        {(extras?.skillIds || []).length > 0 && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-bg text-accent shrink-0 flex items-center gap-1"
            title={`会话级技能：${extras.skillIds.join('、')}（点击移除）`}>
            <IconZap size={11} />
            {extras.skillIds.length} 技能
            <button onClick={() => onExtrasChange?.({ ...extras, skillIds: [] })} aria-label="移除会话级技能" className="hover:opacity-70">
              <IconX size={10} />
            </button>
          </span>
        )}
        {(extras?.mcpServers || []).length > 0 && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-bg text-accent shrink-0 flex items-center gap-1"
            title={`会话级连接器：${extras.mcpServers.join('、')}（点击移除）`}>
            <IconPlug size={11} />
            {extras.mcpServers.length} 连接
            <button onClick={() => onExtrasChange?.({ ...extras, mcpServers: [] })} aria-label="移除会话级连接器" className="hover:opacity-70">
              <IconX size={10} />
            </button>
          </span>
        )}
        {/* AGENTS.md 属于「当前工作区」事实，同样只在会话内显示 */}
        {workspaceBound && agentsMd && (
          <span className="truncate flex items-center gap-1 text-accent" title={`项目规范：${agentsMd.path}`}>
            <IconFile size={13} /> AGENTS.md
          </span>
        )}
      </div>
      )}

      {modeMsg && (
        <div className="mb-1.5 text-[11px] text-text2 px-4 truncate" title={modeMsg}>{modeMsg}</div>
      )}

      {/* A5：录音条（波形 + 计时 + 停止） */}
      {voiceActive && (
        <div className="mb-1.5 mx-1 rounded-xl border border-danger bg-danger-bg px-3 py-2 flex items-center gap-3">
          <span className="text-xs text-danger font-medium shrink-0">
            {voice.state === 'recording' ? '录音中' : '转写中…'}
          </span>
          {voice.state === 'recording' && (
            <span className="flex items-end gap-0.5 h-4 flex-1" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="w-1 rounded-sm bg-danger transition-all duration-150"
                  style={{ height: `${6 + Math.round((voice.level || 0) * 10 * ((i % 2) + 1))}px` }} />
              ))}
            </span>
          )}
          <span className="text-xs text-danger tabular-nums shrink-0">{voice.elapsed}s</span>
          {voice.state === 'recording' && (
            <button onClick={() => voice.stop()} className="text-xs text-danger underline shrink-0">点击停止</button>
          )}
          <button onClick={() => voice.cancel()} className="text-xs text-text2 hover:text-text shrink-0" aria-label="取消录音">
            <IconX size={13} />
          </button>
        </div>
      )}
      {voice?.error && (
        <div className="mb-1.5 mx-1">
          <InlineAlert type="error" onDismiss={voice.clearError}>
            {voice.error.message}{voice.error.hint ? `：${voice.error.hint}` : ''}
          </InlineAlert>
        </div>
      )}

      {/* 大任务拆分（token 效率）：分析中提示 */}
      {decomposing && (
        <div className="mb-2 px-4 text-xs text-text2 flex items-center gap-2">
          <IconSpinner size={12} className="animate-spin" /> 正在分析任务规模，判断是否需要拆分…
        </div>
      )}

      {/* 拆分卡片：待用户确认，确认前不执行 */}
      {plan && (
        <div className="mb-2 mx-1 rounded-2xl border border-accent bg-accent-bg p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium text-accent">任务较大，可拆分为 {plan.tasks.length} 步</span>
            <button onClick={() => onPlanChange?.(null)} className="text-text2 hover:text-text" aria-label="关闭拆分"><IconX size={14} /></button>
          </div>
          {plan.reason && <p className="text-xs text-text2 mb-2">{plan.reason}</p>}
          <div className="space-y-1.5">
            {plan.tasks.map((t, i) => (
              <div key={i} className="flex items-center gap-2 bg-surface border border-border rounded-xl px-3 py-2">
                <span className="text-xs text-text2 shrink-0 tabular-nums">{i + 1}/{plan.tasks.length}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{t.title}</div>
                  <div className="text-xs text-text2 truncate" title={t.prompt}>{t.prompt}</div>
                </div>
                <button
                  onClick={() => {
                    const ps = { title: t.title, index: i, total: plan.tasks.length, tasks: plan.tasks };
                    onPlanChange?.(null);
                    onPlanReportChange?.(null);
                    // onSend 即 ChatArea 的 send(text, forcedThread, opts)：
                    //   不传 forcedThread 即回落到当前 thread（send 内部 forcedThread || thread）
                    onSend?.(t.prompt, undefined, { skipDecompose: true, planStep: ps });
                  }}
                  className="h-7 shrink-0 inline-flex items-center justify-center px-3 rounded-lg bg-accent text-white text-xs hover:opacity-90">执行</button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-2 gap-2">
            <span className="text-[11px] text-text2">每步完成后会报告结果，由你决定是否继续下一步</span>
            <button onClick={() => { onPlanChange?.(null); onSend?.(input, undefined, { skipDecompose: true }); }}
              className="text-xs text-text2 hover:text-text underline shrink-0">不拆分，直接执行原任务</button>
          </div>
        </div>
      )}

      {/* 分步完成报告：结果 + 下一步由用户输入框决定 */}
      {planReport && (
        <div className="mb-2 mx-1 rounded-2xl border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-sm font-medium">第 {planReport.index + 1}/{planReport.total} 步「{planReport.title}」已完成</span>
            <span className="text-xs text-text2 shrink-0" title="本步 token 消耗">
              模型 {planReport.model} · 消耗 {(planReport.tokens.in + planReport.tokens.out).toLocaleString()} tokens（输入 {planReport.tokens.in.toLocaleString()} / 输出 {planReport.tokens.out.toLocaleString()}）
            </span>
          </div>
          {planReport.next ? (
            <>
              <p className="text-xs text-text2 mt-1">下一步：{planReport.index + 2}/{planReport.total} {planReport.next.title}</p>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => {
                    setInput(planReport.next.prompt);
                    onPlanReportChange?.(null);
                    requestAnimationFrame(() => taRef.current?.focus());
                  }}
                  className="h-7 inline-flex items-center px-3 rounded-lg bg-accent text-white text-xs hover:opacity-90">填入输入框，确认后发送</button>
                <button onClick={() => onPlanReportChange?.(null)} className="text-xs text-text2 hover:text-text underline">暂不继续</button>
              </div>
            </>
          ) : (
            <p className="text-xs text-text2 mt-1">全部 {planReport.total} 步已完成。</p>
          )}
        </div>
      )}

      {/* P0-B：未选项目时明示只读边界（沙箱已强制 read-only，此处告知用户） */}
      {!loading && !cwd && (
        <p className="mb-1.5 mx-1 text-[11px] text-warn">未选择项目：Agent 只能读取，无法写入或改动文件</p>
      )}
      {/* P0-A：失败可重试（瞬时错误重试耗尽后，一键重放上一轮输入） */}
      {lastFailed && !loading && (
        <div className="mb-1.5 mx-1 flex items-center justify-between gap-2">
          <span className="text-[11px] text-text2 truncate">上一轮执行失败（可能是网络或服务波动），对话历史已保留</span>
          <button
            onClick={() => { const t = lastFailed.text; onLastFailedChange?.(null); onSend?.(t); }}
            className="shrink-0 h-7 inline-flex items-center px-3 rounded-lg border border-border text-xs hover:bg-hover"
          >重试本轮</button>
        </div>
      )}

      {/* 任务控制台（A12：拖拽悬停转 accent + 遮罩；preventDefault 阻断 Electron 默认导航） */}
      <div
        className={`bg-surface border rounded-2xl p-3 focus-within:border-accent relative ${dragOver ? 'border-accent border-dashed' : 'border-border'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 rounded-2xl bg-accent-bg flex items-center justify-center text-xs text-accent z-10 pointer-events-none">
            松开以添加到对话
          </div>
        )}
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            setSlashOpen(v.startsWith('/'));
            setSlashIdx(0);
          }}
          onKeyDown={(e) => {
            if (slashOpen && matches.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % matches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + matches.length) % matches.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(matches[slashIdx]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              // 运行中：Enter = 当轮引导（steer），不新起一轮
              if (loading && onSteer) { onSteer(input); setInput(''); return; }
              onSend();
            }
            if (e.key === 'Tab' && loading && input.trim()) {
              // 运行中：Tab = 排队到下一轮（queue）
              e.preventDefault();
              onQueue?.(input);
              setInput('');
            }
          }}
          onPaste={handlePaste}
          placeholder={expert
            ? `与 ${expert.title_cn || expert.name} 协作中…`
            : (loading ? '运行中：Enter 当轮引导 / Tab 排队到下一轮…' : '输入你想做什么，@文件路径 引用项目文件，/ 唤起命令...')}
          className="w-full bg-transparent outline-none text-sm resize-none"
          rows="1"
        />

        {slashOpen && matches.length > 0 && (
          <div className="absolute left-3 right-3 bottom-full mb-2 bg-raise border border-border rounded-xl overflow-hidden shadow-[var(--shadow-menu)] max-h-56 overflow-y-auto">
            {matches.map((c, i) => (
              <button
                key={c.key}
                onClick={() => pickSlash(c)}
                className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${i === slashIdx ? 'bg-hover' : 'hover:bg-hover'} ${c.pending ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className="font-mono text-accent shrink-0">{c.key}</span>
                <span className="text-text2 truncate">{c.hint}</span>
                {c.pending && (
                  <span className="text-[10px] text-text2 ml-auto shrink-0">（即将支持）</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* A4："+" 扩展菜单 */}
        {plusOpen && (
          <PlusMenu
            open={plusOpen}
            onClose={() => onPlusOpenChange?.(false)}
            onPickFiles={onPickFiles}
            messages={messages}
            runMode={runMode}
            onModeChange={onModeChange}
            hasProject={!!project?.path}
            extras={extras}
            onExtrasChange={onExtrasChange}
            onVoiceStart={() => voice?.start?.()}
            connectedServers={connectedServers}
          />
        )}

        <div className="flex items-center justify-between mt-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => onPlusOpenChange?.(!plusOpen)}
              className={`shrink-0 transition-transform duration-150 ${plusOpen ? 'rotate-45 text-text' : 'text-text2 hover:text-text'}`}
              title="添加（文件 / 模式 / 数字员工 / 技能 / 连接器 / 语音）"
              aria-label="添加"
              aria-expanded={plusOpen}
            >
              <IconPlus size={18} />
            </button>
            <button
              onClick={() => (voice.state === 'recording' ? voice.stop() : voice.state === 'transcribing' ? undefined : voice.start())}
              disabled={voice.state === 'transcribing'}
              className={`shrink-0 ${voice.state === 'recording' ? 'text-danger' : 'text-text2 hover:text-text'}`}
              title={voice.state === 'recording' ? '停止录音（Ctrl+M）' : '语音输入（Ctrl+M 按住说话）'}
              aria-label="语音输入"
            >
              <IconMic size={17} />
            </button>
            <ComposerControls
              providers={providers}
              selectedModel={selectedModel}
              onSelectModel={onSelectModel}
              approval={approval}
              onApprovalChange={onApprovalChange}
              project={project}
              mode={runMode}
              onModeChange={onModeChange}
              worktreeInfo={worktreeInfo}
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* C9：排队指令可查看、可单条移除（此前只有计数徽标） */}
            {queuedCount > 0 && (
              <QueuedList queued={queued} onRemove={onQueueRemove} />
            )}
            {loading ? (
              <button onClick={onStop} title="停止生成（Esc）" aria-label="停止生成"
                className="bg-danger text-white rounded-full w-8 h-8 flex items-center justify-center">
                <IconSquare size={14} />
              </button>
            ) : (
              <button onClick={() => onSend()} disabled={!input.trim()} title="发送" aria-label="发送"
                className="bg-accent text-white rounded-full w-8 h-8 flex items-center justify-center disabled:opacity-50">
                <IconArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 斜杠命令表（对标 Codex /plan /review /status /compact 等）
const SLASH_COMMANDS = [
  { key: '/plan', hint: '规划模式：先出计划，确认后再执行' },
  { key: '/review', hint: '审查当前未提交变更', pending: true }, // C8：未实现命令禁用，消除假可用性
  { key: '/compact', hint: '压缩当前对话上下文' },
  { key: '/status', hint: '查看线程与上下文用量', pending: true },
  { key: '/init', hint: '在项目中生成 AGENTS.md 规范', pending: true },
  { key: '/clear', hint: '清空当前对话上下文' },
];

// A12：ArrayBuffer → base64（分块，粘贴图片落盘用）
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// A4：数字员工 system prompt 模板（使命 + 行业 + 审批策略）
function buildExpertPrompt(e) {
  if (!e) return '';
  const lines = [
    `你现在扮演数字员工「${e.title_cn || e.name}」，全程以此身份与用户协作。`,
    e.mission ? `使命：${e.mission}` : '',
    (e.industry || []).length ? `行业背景：${e.industry.join('、')}` : '',
    e.market_signal ? `专业视角：${e.market_signal}` : '',
    `审批策略偏好：${e.approval_policy === 'trusted' ? '完全信任（仍需遵守系统安全约束）' : e.approval_policy === 'safe-auto' || e.approval_policy === 'auto-safe' ? '安全自动' : '按需向用户确认'}`,
  ].filter(Boolean);
  return lines.join('\n');
}

// 从工具调用中提取被写入的文件路径（区分「AI 改的」与「我自己改的」）
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch']);
function agentFilesOf(tc) {
  if (!WRITE_TOOL_NAMES.has(tc?.name)) return [];
  if (tc.name === 'apply_patch') {
    const m = String(tc.args?.patch || '').match(/^\+\+\+ b\/(.+)$/m);
    return m ? [m[1].trim()] : [];
  }
  return tc.args?.path ? [String(tc.args.path)] : [];
}

function toolNameCN(name) {
  const map = {
    shell: '执行命令', read_file: '读取文件', write_file: '写入文件',
    edit_file: '编辑文件', list_dir: '浏览目录', grep: '搜索代码',
    apply_patch: '应用补丁', git_status: 'Git 状态', git_diff: 'Git 差异',
    git_log: 'Git 历史', git_commit: 'Git 提交',
  };
  return map[name] || name;
}

// C7：消息复制（hover 显示操作条，user/assistant 均支持；无状态组件，用 toast 反馈）
function CopyButton({ text }) {
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(text || ''));
          toast({ message: '已复制到剪贴板' });
        } catch (err) {
          console.warn('[chat] 复制失败:', err);
          toast({ message: '复制失败' });
        }
      }}
      className="opacity-0 group-hover:opacity-100 text-text2 hover:text-text shrink-0 p-1"
      title="复制内容" aria-label="复制消息内容"
    >
      <IconCopy size={13} />
    </button>
  );
}

// C9：排队指令列表（点击徽标展开，支持单条移除）
function QueuedList({ queued = [], onRemove }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-text2 hover:text-text"
        title={`已排队 ${queued.length} 条，将在下一轮执行（点击查看）`}>
        已排队 {queued.length}
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 w-72 max-w-[80vw] bg-raise border border-border rounded-xl shadow-[var(--shadow-menu)] z-palette py-1">
          {queued.map((q, i) => (
            <div key={`${i}-${q.slice(0, 8)}`} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border last:border-0">
              <span className="text-[10px] text-text2 shrink-0">{i + 1}.</span>
              <span className="flex-1 truncate" title={q}>{q}</span>
              <button onClick={() => onRemove?.(i)}
                className="text-text2 hover:text-danger shrink-0" aria-label="移除该排队指令" title="移除">
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// C6：工具输出展示块 —— 截断显示 + 「展开完整输出」（此前静默截断，排障看不到完整 stdout）
function OutputBlock({ text, className, max = 500 }) {
  const [expanded, setExpanded] = useState(false);
  const full = String(text || '');
  const truncated = full.length > max;
  return (
    <>
      <pre className={className}>{expanded ? full : full.slice(0, max)}{truncated && !expanded ? '…' : ''}</pre>
      {truncated && (
        <button onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-text2 hover:text-text mb-1">
          {expanded ? '收起输出' : `展开完整输出（共 ${full.length} 字）`}
        </button>
      )}
    </>
  );
}

// 历史消息重放：user 气泡 / assistant markdown / assistant+tool_calls 配对渲染 tool 卡片
// 兼容双轨字段：服务端 snake_case（tool_calls/model_name/tokens_input），
// 本机 localStore camelCase（toolCalls/modelName/tokensInput）——此前本地历史工具卡片不渲染
function renderMessages(messages) {
  // tool_call_id -> tool 消息内容 索引
  const toolResults = new Map();
  for (const m of messages) {
    if (m.role === 'tool') toolResults.set(m.tool_call_id || m.toolCallId, m);
  }

  return messages.map((m, i) => {
    if (m.role === 'tool') return null; // 由所属 assistant 消息渲染
    // C2：持久化消息用 id 作 key（下标在 /compact 重放后会漂移导致复用错节点）
    if (m.role === 'user') {
      return (
        <div key={m.id ?? `u-${i}`} className="mb-4 flex justify-end group">
          <div className="bg-surface rounded-2xl px-4 py-2 max-w-2xl">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
          </div>
          <div className="self-center ml-2"><CopyButton text={m.content} /></div>
        </div>
      );
    }
    // assistant
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : Array.isArray(m.toolCalls) ? m.toolCalls : [];
    // 底部 token 明细（参考 WorkBuddy：模型名 + 消耗量）；本地历史字段为 camelCase
    const modelName = m.model_name || m.modelName || '';
    const tokensIn = m.tokens_input ?? m.tokensInput ?? 0;
    const tokensOut = m.tokens_output ?? m.tokensOutput ?? 0;
    return (
      <div key={m.id ?? `a-${i}`} className="mb-4 max-w-3xl group">
        <div className="text-xs text-text2 mb-1 flex items-center gap-2">
          MJ Coder
          <CopyButton text={m.content} />
        </div>
        {m.content && <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>}
        {calls.map((tc, j) => {
          const tr = toolResults.get(tc.id);
          let result = null;
          try { result = tr ? JSON.parse(tr.content) : null; } catch (e) { result = tr ? { stdout: tr.content } : null; }
          return (
            <div key={j} className="mb-2">
              <div className="bg-surface border border-border rounded-lg px-3 py-2 text-xs font-mono flex items-center gap-2">
                <IconTerminal size={13} className={result?.error ? 'text-danger shrink-0' : 'text-accent shrink-0'} />
                <span className={result?.error ? 'text-danger' : 'text-accent'}>{toolNameCN(tc.function?.name)}</span>
                <span className="text-text2 truncate">{(tc.function?.arguments || '').slice(0, 120)}</span>
              </div>
              {/* 工具失败原因必须可见：agent-core 失败时返回 { error: message } */}
              {result?.error && (
                <OutputBlock className="mt-1 text-xs text-danger bg-danger-bg border border-danger p-2 rounded whitespace-pre-wrap" text={result.error} />
              )}
              {result?.stdout && <OutputBlock className="mt-1 text-xs bg-surface border border-border p-2 rounded whitespace-pre-wrap" text={result.stdout} />}
              {result?.stderr && <OutputBlock className="mt-1 text-xs text-danger bg-danger-bg border border-border p-2 rounded whitespace-pre-wrap" text={result.stderr} max={300} />}
              {!result && tr && (
                <OutputBlock className="mt-1 text-xs text-text2 bg-surface border border-border p-2 rounded whitespace-pre-wrap" text={tr.content} />
              )}
            </div>
          );
        })}
        {/* 底部明细：模型 + token 消耗 + 时间（参考 WorkBuddy，仅最终回复展示） */}
        {modelName && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text2" title={`输入 ${tokensIn.toLocaleString()} / 输出 ${tokensOut.toLocaleString()} tokens`}>
            <IconCpu size={11} className="shrink-0" />
            <span>共消耗 {(tokensIn + tokensOut).toLocaleString()} tokens</span>
            <span className="truncate">· {modelName}</span>
            {(m.created_at || m.createdAt) && (
              <span>· {new Date(m.created_at || m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </div>
        )}
      </div>
    );
  });
}
