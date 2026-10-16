// @ts-nocheck -- T2-2 存量代码原样搬移（零行为变更）；渐进 TS 路线下补全类型属后续任务（T0-3 门禁只约束新文件扩展名）
import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from './feedback';
import { useI18n } from '../i18n'; // T3-2：i18n
import { IconCopy, IconCpu, IconSpinner } from './icons';
import { ToolTraceGroup } from './tools/ToolTrace';

// T2-2：消息流域（自主进程 ChatArea.jsx 原样搬移，行为不变）——
// 窗口切片（C1）/ 智能滚底（C3）/ 轮次重放（T1-2）/ 本轮概览（T1-5）/ 运行态轨迹与思考流。
// 滚动跟随状态经 useMessageWindow 下沉；windowStart 归 ChatArea（切会话重置在其 effects 中）。

// C1：窗口切片步长（条）。ChatArea 首屏初始化与 MessageStream「加载更早」共用同一口径。
export const MSG_WINDOW = 50;

// C3：智能滚底 hook——仅当用户已在底部附近（<80px）才跟随；上翻历史时不再被强制拽回，
// 由悬浮的「回到底部」按钮接管（stickToBottomRef 在 onScroll 中维护）。
function useMessageWindow({ messages, streamingText, toolCallsCount }) {
  const scrollRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowJumpBottom(!nearBottom);
  }
  function jumpToBottom() {
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowJumpBottom(false);
  }
  useEffect(() => {
    if (stickToBottomRef.current) scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, streamingText, toolCallsCount]);
  return { scrollRef, handleScroll, showJumpBottom, jumpToBottom };
}

export default function MessageStream({
  messages, windowStart, onLoadEarlier,
  loading, toolCalls, reasoningText, streamingText,
  runSummary, runUsage, runStartedAt, contextUsage, model,
  onOpenFile,
}) {
  const { t } = useI18n();
  const { scrollRef, handleScroll, showJumpBottom, jumpToBottom } = useMessageWindow({ messages, streamingText, toolCallsCount: toolCalls.length });
  // 布局要点：消息区必须 min-h-0。
  // flex 子项默认 min-height:auto，内容多高容器就被撑多高，overflow-y-auto 失效，
  // 表现为「聊得越多，输入框被顶得越往下直到看不见」。
  // C1：窗口切片渲染；起点落在 tool 消息上时向前回退，避免切断 assistant(tool_calls) 与结果的配对
  let effStart = windowStart;
  while (effStart > 0 && effStart < messages.length && messages[effStart].role === 'tool') effStart -= 1;
  const visibleMessages = messages.slice(effStart);
  return (
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-4" onScroll={handleScroll}>
        {effStart > 0 && (
          <div className="flex justify-center mb-3">
            <button onClick={() => onLoadEarlier(effStart)}
              className="text-xs text-text2 hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-hover">
              {t('message.loadEarlier', { n: effStart })}
            </button>
          </div>
        )}
        {/* 最后一轮的逐条消息 meta 仅在「底部收尾条不会渲染」时展示（有收尾条即由其统一承载，
            避免同一组数字重复出现两次）；历史轮始终保留 meta，避免历史消息丢失模型/耗时信息。 */}
        {renderMessages(visibleMessages, !!runSummary || !!loading, onOpenFile)}
        {/* T1-5：本轮概览卡——运行中实时（耗时/消耗/上下文/模型），结束态转固定收尾条 */}
        <RunFooter
          summary={runSummary}
          live={loading ? {
            startedAt: runStartedAt,
            tokensIn: runUsage ? runUsage.tokensIn : 0,
            tokensOut: runUsage ? runUsage.tokensOut : 0,
            contextUsage,
            model,
          } : null}
        />
        {/* T1-1+T1-2：运行态工具轨迹——语义化卡片 + 折叠分组（进行中的一轮默认展开） */}
        {toolCalls.length > 0 && (
          <ToolTraceGroup calls={toolCalls} label={t('message.thisRound')} defaultOpen />
        )}
        {/* T1-5：推理模型思考流——Markdown 渐进渲染（与正文一致的排版），默认展开可折叠 */}
        {loading && reasoningText && (
          <details className="mb-3 max-w-3xl" open>
            <summary className="text-xs text-text2 cursor-pointer select-none">{t('message.thinking')}</summary>
            <div className="mt-1 text-xs text-text2 max-h-40 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoningText}</ReactMarkdown>
            </div>
          </details>
        )}
        {streamingText && (
          <div className="mb-4 max-w-3xl">
            <div className="text-xs text-text2 mb-1">MJ Coder <span className="animate-pulse">▋</span></div>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
          </div>
        )}
        {/* T1-5：统一加载态——spinner + 文案，与工具卡/概览卡的运行中徽标同一视觉语言 */}
        {loading && !streamingText && !reasoningText && toolCalls.length === 0 && (
          <div className="flex items-center gap-1.5 text-text2 text-sm">
            <IconSpinner size={14} className="animate-spin" />
            {t('message.thinking')}
          </div>
        )}
      </div>
      {/* C3：用户上翻历史时出现，点击回底并恢复跟随 */}
      {showJumpBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 text-xs px-3 py-1.5 rounded-full bg-raise border border-border shadow-[var(--shadow-pop)] text-text2 hover:text-text"
        >
          {t('message.jumpBottom')}
        </button>
      )}
      </div>
  );
}

// C7：消息复制（hover 显示操作条，user/assistant 均支持；无状态组件，用 toast 反馈）
function CopyButton({ text }) {
  const { t } = useI18n();
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(text || ''));
          toast({ message: t('message.copied') });
        } catch (err) {
          console.warn('[chat] copy failed:', err);
          toast({ message: t('message.copyFailed') });
        }
      }}
      className="opacity-0 group-hover:opacity-100 text-text2 hover:text-text shrink-0 p-1"
      title={t('message.copyTitle')} aria-label={t('message.copyAria')}
    >
      <IconCopy size={13} />
    </button>
  );
}

// 本轮概览卡（T1-5：RunFooter 与 Token 仪表盘整合，WorkBuddy 式固定收尾）：
// · live 模式（运行中）：运行中徽标 + 实时耗时 + 本轮已消耗 + 上下文用量 + 模型，每秒刷新；
// · 结束态：状态（正常结束/任务暂停/已停止/失败）+ 耗时 + 共消耗 + 模型 + 结束时间。
// 与单条消息的 meta 小字互补：meta 随消息滚动，此卡永远挂在最后一屏可见。
export function RunFooter({ summary, live }) {
  // 组件内已有局部变量 t（定时器），i18n 译函数改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!summary && !live) return null;
  const fmtDur = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
  };
  const chip = 'inline-flex items-center gap-1 text-[11px] text-text2 bg-surface border border-border rounded-lg px-3 py-1.5 gap-x-3 gap-y-1 flex-wrap';
  // 运行中概览：实时数据流（startedAt/usage/contextUsage 由调用方每轮渲染传入最新值）
  if (live) {
    const total = (live.tokensIn || 0) + (live.tokensOut || 0);
    return (
      <div className="mb-4 max-w-3xl">
        <div className={chip}>
          <span className="inline-flex items-center gap-1 text-accent">
            <IconSpinner size={11} className="animate-spin" />
            {tr('message.running')}
          </span>
          {live.startedAt > 0 && <span>{tr('message.elapsed', { dur: fmtDur(Date.now() - live.startedAt) })}</span>}
          {total > 0 && <span title={tr('message.tokensTitle', { in: (live.tokensIn || 0).toLocaleString(), out: (live.tokensOut || 0).toLocaleString() })}>{tr('message.roundTokens', { n: total.toLocaleString() })}</span>}
          {live.contextUsage && (
            <span title={tr('message.contextTitle', { used: live.contextUsage.used, total: live.contextUsage.total })}>
              {tr('message.contextPercent', { pct: Math.round(live.contextUsage.ratio * 100) })}
            </span>
          )}
          {live.model && <span className="truncate">· {live.model}</span>}
        </div>
      </div>
    );
  }
  const STATUS = {
    done: { label: tr('message.statusDone'), cls: 'text-success', dot: 'bg-success' },
    aborted: { label: tr('message.statusAborted'), cls: 'text-warn', dot: 'bg-warn' },
    suspended: { label: tr('message.statusSuspended'), cls: 'text-warn', dot: 'bg-warn' },
    error: { label: tr('message.statusError'), cls: 'text-danger', dot: 'bg-danger' },
  };
  const st = STATUS[summary.status] || STATUS.done;
  const total = (summary.tokensIn || 0) + (summary.tokensOut || 0);
  return (
    <div className="mb-4 max-w-3xl">
      <div className={chip}>
        <span className={`inline-flex items-center gap-1 ${st.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full inline-block ${st.dot}`} />
          {st.label}
        </span>
        {summary.durationMs > 0 && <span>{tr('message.duration', { dur: fmtDur(summary.durationMs) })}</span>}
        {total > 0 && (
          <span title={tr('message.tokensTitle', { in: (summary.tokensIn || 0).toLocaleString(), out: (summary.tokensOut || 0).toLocaleString() })}>
            {tr('message.totalTokens', { n: total.toLocaleString() })}
          </span>
        )}
        {summary.model && <span className="truncate">· {summary.model}</span>}
        {summary.endedAt && <span>· {new Date(summary.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
      </div>
    </div>
  );
}

// 历史消息重放：user 气泡 / assistant markdown / assistant+tool_calls 配对渲染工具轨迹
// 兼容双轨字段：服务端 snake_case（tool_calls/model_name/tokens_input），
// 本机 localStore camelCase（toolCalls/modelName/tokensInput）
// T1-2：轨迹按轮次分组——user 消息开启一轮，同轮多次工具调用聚合并列、可折叠；
// 当前轮（最后一轮）默认展开，历史轮折叠为一行摘要。effStart 回退已保证切片
// 不会切断 assistant(tool_calls) 与 tool 结果的配对，分组天然成立。

// 助手正文里的「文件提及」→ 可点击打开（右侧预览栏）。
// 判定规则（纯字符串，不探磁盘）：含路径分隔符，或扩展名在已知代码/文档白名单内。
// 之所以要白名单而不能只看「有点号」：`v1.0.0`、`3.14` 这类版本号/数字会被误判成文件。
const CODE_EXT = new Set([
  'md', 'markdown', 'mdx', 'txt', 'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'env', 'conf',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql',
  'csv', 'tsv', 'log', 'lock', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'xlsx', 'pptx',
]);

function isFilePathLike(text: string): boolean {
  const s = String(text || '').trim();
  if (!s || s.length > 200 || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  const m = s.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!m) return false;
  const ext = m[1].toLowerCase();
  if (CODE_EXT.has(ext)) return true;
  // 带目录的路径即使扩展名不在白名单也当作文件（如 docs/build.out）
  return /[\\/]/.test(s);
}

/** 正文内联代码 / 本地链接 → 可点击的文件 chip（点击在右侧预览栏打开） */
function FileRefChip({ text, onOpenFile }: { text: string; onOpenFile?: (p: string) => void }) {
  const { t } = useI18n();
  const clickable = !!onOpenFile && isFilePathLike(text);
  const base = 'rounded px-1.5 py-0.5 text-[11px] border';
  if (!clickable) {
    return (
      <code className={`${base} bg-hover border-border text-text2 font-mono`}>{text}</code>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenFile?.(text)}
      title={t('message.openFileHint')}
      className={`${base} bg-accent/10 border-accent/40 text-accent font-mono hover:bg-accent/20 cursor-pointer`}
    >
      {text}
    </button>
  );
}

/** markdown 渲染器的自定义节点：只改「行内代码」与「本地链接」，其余保持默认语义 */
function markdownComponents(onOpenFile?: (p: string) => void) {
  return {
    // 代码块（带 language-* className）与多行代码不处理，仅处理行内代码
    code: ({ className, children, ...rest }: { className?: string; children?: ReactNode }) => {
      const raw = String(children ?? '').replace(/\n$/, '');
      if (className || raw.includes('\n')) {
        return (
          <code className={`${className || ''} font-mono`} {...rest}>{children}</code>
        );
      }
      return <FileRefChip text={raw} onOpenFile={onOpenFile} />;
    },
    // 本地相对链接（非 http/mailto/#）同样走文件打开
    a: ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => {
      const h = String(href || '');
      if (onOpenFile && h && !/^(https?:|mailto:|#|\/\/)/i.test(h) && isFilePathLike(h)) {
        return (
          <button type="button" onClick={() => onOpenFile(h)} className="text-accent underline hover:opacity-80">
            {children}
          </button>
        );
      }
      return <a href={href} {...rest}>{children}</a>;
    },
  };
}

// 轮次块：一轮的 user 气泡 + 工具轨迹组 + assistant 回复（含 meta）。折叠状态本组件持有。
function RoundBlock({ round, user, assistants, toolResults, isLast, suppressMeta = false, onOpenFile }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(isLast);
  const calls = [];
  for (const m of assistants) {
    const cs = Array.isArray(m.tool_calls) ? m.tool_calls : Array.isArray(m.toolCalls) ? m.toolCalls : [];
    for (const tc of cs) calls.push(tc);
  }
  const firstReply = assistants.find((m) => m.content);
  // 本轮「答复」所在的消息下标：末条有正文的 assistant（工具调用轮里正文只出现在最后一条）。
  // 执行体流程要贴在它上方 —— 贴到首条 assistant 会跑到本轮最顶端、与答复脱节（用户实测反馈）。
  let answerIdx = -1;
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    if (String(assistants[i]?.content || '').trim()) { answerIdx = i; break; }
  }
  if (answerIdx === -1 && assistants.length) answerIdx = assistants.length - 1;
  const md = markdownComponents(onOpenFile);
  const userPreview = String(user?.content || '').replace(/\s+/g, ' ').slice(0, 60);
  const replyPreview = String(firstReply?.content || '').replace(/\s+/g, ' ').slice(0, 60);
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-2 select-none">
        <span className="text-[11px] text-text2/80 shrink-0">{t('message.round', { n: round })}</span>
        {calls.length > 0 && (
          <span className="text-[10px] text-text2 bg-hover rounded px-1.5 py-0.5 shrink-0">{t('message.callCount', { n: calls.length })}</span>
        )}
        <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-text2 hover:text-text shrink-0"
          title={open ? t('message.collapseRound') : t('message.expandRound')}>
          {open ? t('message.collapse') : t('message.expand')}
        </button>
        <div className="flex-1 border-t border-border" />
      </div>
      {!open ? (
        <button onClick={() => setOpen(true)}
          className="w-full text-left text-xs text-text2 hover:text-text truncate" title={userPreview}>
          {userPreview || replyPreview || t('message.round', { n: round })}
          {calls.length > 0 && <span className="text-text2/70">{t('message.withToolCalls', { n: calls.length })}</span>}
        </button>
      ) : (
        <>
          {user && (
            <div className="mb-4 flex justify-end">
              <div className="bg-surface rounded-2xl px-4 py-2 max-w-2xl">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{user.content}</ReactMarkdown>
              </div>
              <div className="self-center ml-2"><CopyButton text={user.content} /></div>
            </div>
          )}
          {/* 本轮的执行体流程（工具轨迹组）改为渲染在「MJ Coder」标签下方、正文之前
              （见下方 map 内 k === 0 分支）——此前排在整轮消息之上，与回复正文分离，
              用户需要上下对照才能确认「这一轮到底做了什么」。 */}
          {assistants.map((m, k) => {
            // 底部 token 明细（参考 WorkBuddy：模型名 + 消耗量）；本地历史字段为 camelCase
            const modelName = m.model_name || m.modelName || '';
            const tokensIn = m.tokens_input ?? m.tokensInput ?? 0;
            const tokensOut = m.tokens_output ?? m.tokensOutput ?? 0;
            return (
              <div key={m.id ?? `a-${k}`} className="mb-4 max-w-3xl">
                <div className="text-xs text-text2 mb-1 flex items-center gap-2">
                  MJ Coder
                  <CopyButton text={m.content} />
                </div>
                {/* 本轮执行体流程：紧贴「答复」上方（模型标签之下、正文之上），
                    先看「这一轮做了什么」再看结论。用 label 明示归属，避免用户找不到它在哪。 */}
                {k === answerIdx && calls.length > 0 && (
                  <ToolTraceGroup calls={calls} toolResults={toolResults} label={t('toolTrace.roundExecTrace')} />
                )}
                {m.content && <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{m.content}</ReactMarkdown>}
                {/* 底部明细：模型 + token 消耗 + 时间。
                    条件放宽：任一信息存在即展示——此前 modelName 为空时整行隐藏，
                    中间消息（有 token 无模型名）与历史消息一律不可见，用户侧「结束信息全缺」。
                    suppressMeta：当轮已有底部 RunFooter（状态/耗时/共消耗/模型/时间）时隐藏本行，
                    避免同一组数字在页面上重复出现两次（用户实测反馈）。 */}
                {!suppressMeta && (modelName || tokensIn + tokensOut > 0 || m.created_at || m.createdAt) && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text2" title={t('message.tokensTitle', { in: tokensIn.toLocaleString(), out: tokensOut.toLocaleString() })}>
                    <IconCpu size={11} className="shrink-0" />
                    <span>{t('message.totalTokens', { n: (tokensIn + tokensOut).toLocaleString() })}</span>
                    {modelName && <span className="truncate">· {modelName}</span>}
                    {(m.created_at || m.createdAt) && (
                      <span>· {new Date(m.created_at || m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {/* 兜底：本轮只有工具调用、没有任何 assistant 消息时，轨迹组仍需可见 */}
          {answerIdx === -1 && calls.length > 0 && (
            <ToolTraceGroup calls={calls} toolResults={toolResults} label={t('toolTrace.roundExecTrace')} />
          )}
        </>
      )}
    </div>
  );
}

export function renderMessages(messages, suppressLastMeta = false, onOpenFile) {
  // tool_call_id -> tool 消息内容 索引
  const toolResults = new Map();
  for (const m of messages) {
    if (m.role === 'tool') toolResults.set(m.tool_call_id || m.toolCallId, m);
  }
  // 切轮：user 消息开新一轮；tool 消息由所属 assistant 经 Map 配对渲染，不独立成轮
  const rounds = [];
  let cur = null;
  for (const m of messages) {
    if (m.role === 'tool') continue;
    if (m.role === 'user') { cur = { user: m, assistants: [] }; rounds.push(cur); continue; }
    if (!cur) { cur = { user: null, assistants: [] }; rounds.push(cur); } // 切片起点落在 assistant 上
    cur.assistants.push(m);
  }
  return rounds.map((r, i) => (
    <RoundBlock
      key={r.user?.id ?? `r-${i}`}
      round={i + 1}
      user={r.user}
      assistants={r.assistants}
      toolResults={toolResults}
      isLast={i === rounds.length - 1}
      suppressMeta={suppressLastMeta && i === rounds.length - 1}
      onOpenFile={onOpenFile}
    />
  ));
}
