import { useState, useEffect } from 'react';
import { useI18n } from '../i18n';

const MAX_PREVIEW_LINES = 1000;

// R4：轻量语法高亮（无第三方依赖）—— 字符串/注释/数字/关键字四类，
// 逐行正则切分，不支持跨行块注释（预览场景够用）；行数上限同步降为 1000。
const TOKEN_RE = /("(?:[^"\\\n]|\\.)*|'(?:[^'\\\n]|\\.)*|`(?:[^`\\]|\\.)*|\/\/[^\n]*|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'import', 'export', 'from', 'default', 'class', 'extends', 'new', 'try', 'catch', 'finally', 'throw', 'async', 'await',
  'yield', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'static', 'get', 'set', 'null', 'undefined', 'true', 'false',
  'def', 'elif', 'lambda', 'pass', 'with', 'as', 'not', 'and', 'or', 'None', 'True', 'False', 'self', 'print',
  'package', 'func', 'type', 'struct', 'interface', 'go', 'defer', 'chan', 'select', 'range',
  'public', 'private', 'protected', 'void', 'int', 'string', 'bool', 'float', 'double', 'enum', 'impl', 'fn', 'pub', 'use', 'mod',
]);

export function highlightLine(line) {
  if (!line) return ' ';
  const parts = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  let n = 0;
  while ((m = TOKEN_RE.exec(line)) !== null && n < 200) { // 单行 token 上限，防极端行长卡顿
    if (m.index > last) parts.push({ text: line.slice(last, m.index) });
    const t = m[0];
    let cls = null;
    if (t.startsWith('//') || t.startsWith('#')) cls = 'text-text2 italic';
    else if (t.startsWith('"') || t.startsWith("'") || t.startsWith('`')) cls = 'text-success';
    else if (/^\d/.test(t)) cls = 'text-info';
    else if (KEYWORDS.has(t)) cls = 'text-accent font-medium';
    parts.push(cls ? { text: t, cls } : { text: t });
    last = m.index + t.length;
    n += 1;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts.map((p, i) => (p.cls
    ? <span key={i} className={p.cls}>{p.text}</span>
    : <span key={i}>{p.text}</span>));
}

// 代码视图：文件树点击文件的只读预览 + 一键跳转 IDE
// 嵌入右侧常驻面板渲染（embedded=true 时不套遮罩与定位容器）
export default function CodeView({ filePath, projectPath, embedded = false }) {
  const { t } = useI18n();
  const [state, setState] = useState({ loading: true, content: '', totalLines: 0, error: '' });
  const [copied, setCopied] = useState(false);
  const [ideMsg, setIdeMsg] = useState('');

  useEffect(() => {
    if (!filePath) return;
    setState({ loading: true, content: '', totalLines: 0, error: '' });
    window.mjcode.readFile({ path: filePath, offset: 0, limit: MAX_PREVIEW_LINES })
      .then((r) => {
        if (r && typeof r.content === 'string') {
          setState({ loading: false, content: r.content, totalLines: r.totalLines || 0, error: '' });
        } else {
          setState({ loading: false, content: '', totalLines: 0, error: t('codeView.readFailed') });
        }
      })
      .catch((err) => setState({ loading: false, content: '', totalLines: 0, error: err.message || t('codeView.readFailed') }));
  }, [filePath, t]);

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(state.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('[codeView] copy failed:', err);
    }
  }

  async function openInIDE() {
    setIdeMsg('');
    try {
      const r = await window.mjcode.openInIDE({ path: filePath });
      if (r?.ok) setIdeMsg(r.ide === 'editor' ? t('codeView.openedInEditor', { cmd: r.cmd }) : t('codeView.openedWithSystem'));
      else setIdeMsg(r?.error || t('codeView.openFailed'));
    } catch (err) {
      setIdeMsg(err.message || t('codeView.openFailed'));
    }
  }

  const relPath = projectPath && filePath.startsWith(projectPath)
    ? filePath.slice(projectPath.length + 1)
    : filePath;
  const lines = state.content.split('\n');
  const truncated = state.totalLines > MAX_PREVIEW_LINES;

  return (
    <div className={embedded ? 'flex-1 min-h-0 flex flex-col' : 'fixed inset-0 z-drawer flex justify-end'}>
      <div
        className={embedded
          ? 'flex-1 min-h-0 flex flex-col bg-bg'
          : 'w-[min(560px,80vw)] h-full bg-bg border-l border-border flex flex-col shadow-[var(--shadow-pop)]'}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border shrink-0">
          <span className="text-sm font-medium truncate flex-1 font-mono" title={filePath}>{relPath}</span>
          <span className="text-xs text-text2">{t('codeView.lineCount', { n: state.totalLines })}</span>
        </div>

        {/* 操作栏 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          <button onClick={openInIDE} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">
            {t('codeView.openInIde')}
          </button>
          <button onClick={copyContent} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">
            {copied ? t('codeView.copied') : t('codeView.copyContent')}
          </button>
          {ideMsg && <span className="text-xs text-text2">{ideMsg}</span>}
        </div>

        {/* 内容 */}
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {state.loading && <p className="text-text2 text-sm">{t('codeView.loading')}</p>}
          {state.error && <p className="text-danger text-sm">{state.error}</p>}
          {!state.loading && !state.error && (
            <pre className="text-code leading-[18px] font-mono whitespace-pre">
              {lines.map((line, i) => (
                <div key={i} className="flex">
                  <span className="w-10 shrink-0 select-none text-right pr-3 text-text2">{i + 1}</span>
                  <span className="whitespace-pre-wrap break-all">{highlightLine(line)}</span>
                </div>
              ))}
            </pre>
          )}
          {truncated && (
            <p className="text-text2 text-xs mt-3">
              {t('codeView.truncated', { max: MAX_PREVIEW_LINES, total: state.totalLines })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
