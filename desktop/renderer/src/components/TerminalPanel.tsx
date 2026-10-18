import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { IconTerminal, IconX } from './icons';
import { useI18n } from '../i18n';

// 命令终端（对标 Codex 右栏「终端」）。
//
// 能力边界必须说清楚：主进程没有 PTY，本面板是**逐条命令执行器**——
// 每次输入一行命令，经与 Agent 完全相同的 shell 通道执行（审批 / 沙箱 / 审计三道闸一并生效），
// 因此不支持 vim、top、REPL 这类需要交互的应用。这是有意的取舍：
// 复用既有安全链路，而不是为了「像终端」而给渲染层开一条绕过审批的裸执行口。
//
// 与 Agent 工具调用的差别只有一个：命令由用户直接输入，不经过模型。

const MAX_ENTRIES = 200;

interface TerminalPanelProps {
  cwd?: string;
}

interface ShellResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  denied?: boolean;
  blocked?: boolean;
  error?: string;
}

interface Entry {
  id: string;
  command: string;
  running?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  denied?: boolean;
  error?: string;
  ms?: number;
}

export default function TerminalPanel({ cwd }: TerminalPanelProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新输出滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // 切换项目：清空历史（上一个项目 cwd 下的输出留着会误导）
  useEffect(() => { setEntries([]); setHistory([]); setHistIdx(-1); }, [cwd]);

  async function run(command: string) {
    const cmd = command.trim();
    if (!cmd || busy) return;
    const mj = window.mjcode;
    if (!mj?.shell) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setEntries((prev) => [...prev, { id, command: cmd, running: true }].slice(-MAX_ENTRIES));
    setHistory((prev) => [...prev.filter((h) => h !== cmd), cmd].slice(-50));
    setHistIdx(-1);
    setInput('');
    setBusy(true);
    const started = Date.now();
    try {
      const r = await mj.shell({ command: cmd, cwd: cwd || undefined, timeout: 120000 }) as ShellResult | undefined;
      setEntries((prev) => prev.map((e) => (e.id === id ? {
        ...e,
        running: false,
        stdout: r?.stdout || '',
        stderr: r?.stderr || '',
        exitCode: typeof r?.exitCode === 'number' ? r.exitCode : null,
        denied: !!r?.denied || !!r?.blocked,
        error: r?.error || '',
        ms: Date.now() - started,
      } : e)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, running: false, error: message, ms: Date.now() - started } : e)));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); run(input); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      const next = Math.min(history.length - 1, histIdx + 1);
      setHistIdx(next);
      setInput(history[history.length - 1 - next] || '');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx <= 0) { setHistIdx(-1); setInput(''); return; }
      const next = histIdx - 1;
      setHistIdx(next);
      setInput(history[history.length - 1 - next] || '');
    }
  }

  const shortCwd = cwd ? cwd.split('/').filter(Boolean).slice(-1)[0] : '';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 h-9 border-b border-border">
        <IconTerminal size={12} className="text-text2 shrink-0" />
        <span className="text-caption text-text2 truncate" title={cwd || ''}>{shortCwd || t('rightPane.terminalNoCwd')}</span>
        <span className="ml-auto shrink-0 text-caption text-text2">{t('rightPane.terminalHintShort')}</span>
        {entries.length > 0 && (
          <button
            onClick={() => setEntries([])}
            className="shrink-0 text-text2 hover:text-text p-1"
            title={t('rightPane.terminalClear')}
            aria-label={t('rightPane.terminalClear')}
          >
            <IconX size={11} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 py-2 font-mono text-code leading-relaxed">
        {entries.length === 0 && (
          <div className="text-text2 py-3 text-center">{t('rightPane.terminalEmpty')}</div>
        )}
        {entries.map((e) => (
          <div key={e.id} className="mb-2">
            <div className="flex items-start gap-1">
              <span className="shrink-0 text-accent select-none">$</span>
              <span className="break-all">{e.command}</span>
            </div>
            {e.running && <div className="text-text2 pl-3">{t('rightPane.terminalRunning')}</div>}
            {!e.running && e.denied && (
              <div className="text-warn pl-3 whitespace-pre-wrap break-all">{e.error || t('rightPane.terminalDenied')}</div>
            )}
            {!e.running && !e.denied && e.error && (
              <div className="text-danger pl-3 whitespace-pre-wrap break-all">{e.error}</div>
            )}
            {!e.running && e.stdout && (
              <div className="pl-3 whitespace-pre-wrap break-all text-text">{e.stdout}</div>
            )}
            {!e.running && e.stderr && (
              <div className="pl-3 whitespace-pre-wrap break-all text-danger">{e.stderr}</div>
            )}
            {!e.running && !e.denied && (
              <div className={`pl-3 text-caption ${e.exitCode === 0 || e.exitCode === null ? 'text-text2' : 'text-warn'}`}>
                {t('rightPane.terminalExit', { code: e.exitCode === null ? '?' : (e.exitCode ?? '?'), ms: e.ms || 0 })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 flex items-center gap-2 px-2 py-2 border-t border-border">
        <span className="shrink-0 text-accent font-mono text-code select-none">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          placeholder={t('rightPane.terminalPlaceholder')}
          className="flex-1 min-w-0 bg-transparent font-mono text-code outline-none placeholder:text-text2 disabled:opacity-50"
        />
      </div>
    </div>
  );
}
