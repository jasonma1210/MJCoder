import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { IconArrowUp, IconX } from './icons';
import { useI18n } from '../i18n';

// 侧边对话（对标 WorkBuddy 预览栏「侧边对话」）：一个独立于主线会话的轻量聊天通道。
//
// 复用主进程 model:chat 直连通道（与设置页「测试连接」同源），通过 streamTag='sidechat'
// 让主进程把流式 token 打上标签发回——渲染层只认该 tag 的 delta，与主线/后台运行的
// 流式输出互不串显（ChatArea 的 onDelta 处理器对未知 tag 直接丢弃，零改动）。
//
// 差异：本通道不走工具/审批/沙箱（纯问答），适合「顺手问模型一句」而不污染任务会话。

const STREAM_TAG = 'sidechat';
const MAX_MESSAGES = 100;

type Role = 'user' | 'assistant';
interface ChatMsg {
  id: string;
  role: Role;
  content: string;
  streaming?: boolean;
  error?: boolean;
}

interface SideChatModel {
  provider: { id: number | string; isGlobal?: boolean; base_url?: string };
  model: { model_id: string; display_name?: string };
}

interface SideChatPanelProps {
  model?: SideChatModel | null;
}

export default function SideChatPanel({ model }: SideChatPanelProps) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 流式订阅：仅接收 streamTag=STREAM_TAG 的 delta（主进程按 tag 分流）
  useEffect(() => {
    if (!window.mjcode?.onDelta) return undefined;
    const off = window.mjcode.onDelta((payload: unknown) => {
      const isObj = payload && typeof payload === 'object';
      const tag = isObj ? (payload as { tag?: string }).tag : null;
      if (tag !== STREAM_TAG) return;
      const text = isObj ? String((payload as { text?: string }).text || '') : String(payload || '');
      if (!text) return;
      setMessages((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        if (i >= 0 && next[i].role === 'assistant' && next[i].streaming) {
          next[i] = { ...next[i], content: next[i].content + text };
        }
        return next;
      });
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 新消息滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const mj = window.mjcode;
    if (!mj?.chat) return;
    if (!model?.provider?.id || !model?.model?.model_id) return;
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const aid = `${uid}-a`;
    const history = messages
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: 'user', content: text });
    const userMsg: ChatMsg = { id: uid, role: 'user', content: text };
    const assistantMsg: ChatMsg = { id: aid, role: 'assistant', content: '', streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg].slice(-MAX_MESSAGES));
    setInput('');
    setBusy(true);
    try {
      const r = (await mj.chat({
        providerId: model.provider.id,
        isGlobal: !!model.provider.isGlobal,
        baseUrl: model.provider.base_url || '',
        model: model.model.model_id,
        messages: history,
        streamTag: STREAM_TAG,
      })) as { content?: string } | undefined;
      setMessages((prev) => prev.map((m) =>
        m.id === aid ? { ...m, content: r?.content || m.content || t('rightPane.sideChatEmptyReply'), streaming: false } : m,
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) => prev.map((m) =>
        m.id === aid ? { ...m, content: message, streaming: false, error: true } : m,
      ));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function stop() {
    try { window.mjcode?.abortChat?.(); } catch { /* 无视 */ }
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }

  const noModel = !model?.provider?.id || !model?.model?.model_id;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 h-9 border-b border-border">
        <span className="text-caption text-text2 truncate flex-1">{t('rightPane.sideChatHint')}</span>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="shrink-0 text-text2 hover:text-text p-0.5"
            title={t('rightPane.sideChatClear')} aria-label={t('rightPane.sideChatClear')}
          >
            <IconX size={11} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
        {messages.length === 0 && (
          <div className="text-text2 text-xs py-4 text-center leading-relaxed">{t('rightPane.sideChatEmpty')}</div>
        )}
        {noModel && messages.length === 0 && (
          <div className="text-warn text-xs py-2 text-center">{t('rightPane.sideChatNoModel')}</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[88%] rounded-2xl px-3 py-1.5 text-xs whitespace-pre-wrap break-words ${
              m.role === 'user' ? 'bg-accent-solid text-on-accent' : m.error ? 'bg-danger-bg text-danger' : 'bg-surface text-text'
            }`}>
              {m.content || (m.streaming ? '…' : '')}
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-t border-border">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || noModel}
          placeholder={noModel ? t('rightPane.sideChatNoModel') : t('rightPane.sideChatPlaceholder')}
          className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-text2 disabled:opacity-50"
        />
        {busy ? (
          <button
            onClick={stop}
            className="shrink-0 px-2 h-7 rounded-lg bg-surface text-text2 hover:text-text text-xs"
            title={t('rightPane.sideChatStop')} aria-label={t('rightPane.sideChatStop')}
          >
            {t('rightPane.sideChatStop')}
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim() || noModel}
            className="shrink-0 p-1 rounded-lg bg-accent-solid text-on-accent disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('rightPane.sideChatSend')} aria-label={t('rightPane.sideChatSend')}
          >
            <IconArrowUp size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
