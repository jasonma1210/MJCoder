import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightLine } from './CodeView';
import { openLinkByMode, isHttpUrl } from '../lib/linkOpen';
import { toast } from './feedback';
import { IconAlert, IconCopy, IconFolderOpen, IconHammer, IconFile, IconSpinner } from './icons';

// 应用内文件预览（对标 WorkBuddy 右侧预览栏）：代码 / Markdown / 图片 / PDF / 音视频
//
// 分工（安全边界）：
//   - 主进程 file:preview 只对「白名单类型」读二进制并回 dataURL（图片/PDF/音视频，≤24MB），
//     其余一律只回元信息，正文走既有的 tool:readFile（UTF-8 + 行数上限）
//   - 未知扩展名：先按文本读，若内容含 NUL 字节则判定为二进制 → 降级为「不支持预览」+ 系统打开
//   - HTML 不执行：以源码形式展示（预览栏不该变成任意脚本的执行入口）
const TEXT_MAX_LINES = 3000;
const MD_EXT = new Set(['md', 'markdown', 'mdx']);

const MIME_LABEL = {
  pdf: 'PDF 文档',
  image: '图片',
  audio: '音频',
  video: '视频',
};

function extOf(p) {
  const base = String(p || '').split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function baseName(p) {
  return String(p || '').split('/').pop() || String(p || '');
}

function humanSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// Markdown 内的链接：默认行为在 Electron 里会「用链接导航当前窗口」——文档一点就白屏。
// 统一改走链接打开策略（设置页「浏览器与链接」），本地路径交给系统默认应用。
function MarkdownLink({ node, href, children, ...rest }) {
  async function onClick(e) {
    e.preventDefault();
    const url = String(href || '');
    if (url.startsWith('#')) return; // 文档内锚点：不做跨窗口跳转
    const r = await openLinkByMode(url);
    if (r === 'copied') { toast({ message: '链接已复制' }); return; }
    if (r === 'passthrough') {
      const target = isHttpUrl(url) ? null : url;
      if (!target) { toast({ message: '链接打开失败' }); return; }
      const res = await window.mjcode?.openPath?.({ path: target });
      if (res && res.ok === false) toast({ message: res.error || '打开失败' });
    }
  }
  return <button type="button" onClick={onClick} className="text-accent underline text-left">{children}</button>;
}

export default function FilePreview({ filePath, projectPath }) {
  const [meta, setMeta] = useState({ loading: true });
  const [text, setText] = useState({ content: '', totalLines: 0 });
  const ext = extOf(filePath);
  const isMd = MD_EXT.has(ext);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setMeta({ loading: true });
    setText({ content: '', totalLines: 0 });

    (async () => {
      // 第一步：问主进程这是什么类型（图片/PDF/音视频回 dataURL，文本只回元信息）
      const r = await window.mjcode.previewFile?.({ path: filePath, cwd: projectPath });
      if (cancelled) return;
      if (!r || r.ok === false) {
        setMeta({ loading: false, error: r?.error || '文件读取失败', kind: 'error' });
        return;
      }
      if (r.tooLarge) {
        setMeta({ loading: false, kind: r.kind, size: r.size, tooLarge: true, error: r.error });
        return;
      }
      setMeta({ loading: false, kind: r.kind, size: r.size, mime: r.mime, dataUrl: r.dataUrl });
      if (r.kind !== 'text') return;

      // 第二步：文本类再取正文（分页上限，避免超大文件把渲染进程卡死）
      const tr = await window.mjcode.readFile?.({ path: filePath, cwd: projectPath, offset: 0, limit: TEXT_MAX_LINES });
      if (cancelled) return;
      if (!tr || tr.ok === false) {
        setMeta({ loading: false, kind: 'error', error: tr?.error || '文件读取失败' });
        return;
      }
      const content = tr.content || '';
      // 未知扩展名可能其实是二进制（如 .bin / .db）：含 NUL 即判定二进制，不硬塞给代码高亮
      const looksBinary = !ext && /[\u0000\u0001\u0002\u0003]/.test(content.slice(0, 4096));
      setText({ content, totalLines: tr.totalLines || 0 });
      setMeta((prev) => ({ ...prev, kind: looksBinary ? 'binary' : 'text' }));
    })();

    return () => { cancelled = true; };
  }, [filePath, projectPath, ext]);

  async function openInSystem() {
    const r = await window.mjcode.openPath?.({ path: filePath });
    if (r && r.ok === false) toast({ message: r.error || '打开失败' });
  }

  async function openInEditor() {
    const r = await window.mjcode.openInIDE?.({ path: filePath });
    if (r && r.ok === false) toast({ message: r.error || '打开失败' });
  }

  async function revealInFinder() {
    const r = await window.mjcode.revealPath?.({ path: filePath });
    if (r && r.ok === false) toast({ message: r.error || '定位失败' });
  }

  async function copyContent() {
    try {
      const body = meta.kind === 'text' ? text.content : text.content || meta.dataUrl || '';
      await navigator.clipboard.writeText(body);
      toast({ message: '已复制到剪贴板' });
    } catch (err) {
      console.warn('[filePreview] 复制失败:', err);
      toast({ message: '复制失败' });
    }
  }

  const relPath = projectPath && filePath && filePath.startsWith(projectPath)
    ? filePath.slice(projectPath.length + 1)
    : filePath;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg">
      {/* 标题栏：相对路径 + 元信息 */}
      <div className="flex items-center gap-2 px-4 h-10 border-b border-border shrink-0">
        <IconFile size={14} className="text-text2 shrink-0" />
        <span className="text-xs font-medium truncate flex-1 font-mono" title={filePath}>{relPath}</span>
        {meta.kind === 'text' && text.totalLines > 0 && (
          <span className="text-[11px] text-text2 shrink-0">{text.totalLines} 行</span>
        )}
        {meta.size !== undefined && <span className="text-[11px] text-text2 shrink-0">{humanSize(meta.size)}</span>}
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border shrink-0">
        <button onClick={openInEditor} title="用系统已安装的编辑器打开该文件"
          className="text-[11px] px-2 py-1 rounded-lg border border-border hover:bg-hover flex items-center gap-1">
          <IconHammer size={12} /> 在编辑器中打开
        </button>
        <button onClick={openInSystem} title="用系统默认应用打开"
          className="text-[11px] px-2 py-1 rounded-lg border border-border hover:bg-hover">系统打开</button>
        <button onClick={revealInFinder} title="在文件管理器中定位"
          className="text-[11px] px-2 py-1 rounded-lg border border-border hover:bg-hover flex items-center gap-1">
          <IconFolderOpen size={12} /> 定位
        </button>
        <button onClick={copyContent} disabled={meta.kind === 'image' || meta.kind === 'pdf'}
          title={meta.kind === 'image' || meta.kind === 'pdf' ? '二进制内容不支持复制' : '复制文本内容'}
          className="text-[11px] px-2 py-1 rounded-lg border border-border hover:bg-hover flex items-center gap-1 disabled:opacity-40">
          <IconCopy size={12} /> 复制
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {meta.loading && (
          <div className="flex items-center gap-2 p-4 text-text2 text-xs">
            <IconSpinner size={13} className="animate-spin" /> 正在加载…
          </div>
        )}

        {!meta.loading && (meta.kind === 'error' || meta.tooLarge || meta.kind === 'binary') && (
          <div className="p-6 flex flex-col items-center gap-3 text-center">
            <IconAlert size={22} className="text-warn" />
            <p className="text-sm text-text">
              {meta.kind === 'binary' ? '该文件不是文本，无法在应用内预览' : (meta.error || '无法预览该文件')}
            </p>
            <p className="text-xs text-text2 max-w-md break-all">{filePath}</p>
            <div className="flex gap-2">
              <button onClick={openInSystem} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white hover:opacity-90">用系统应用打开</button>
              <button onClick={revealInFinder} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">在文件管理器中显示</button>
            </div>
          </div>
        )}

        {!meta.loading && meta.kind === 'image' && (
          <div className="p-4 flex items-center justify-center bg-surface min-h-full">
            {/* dataURL 由主进程按 mime 白名单生成，非任意路径 */}
            <img src={meta.dataUrl} alt={baseName(filePath)} className="max-w-full max-h-full object-contain rounded-lg" />
          </div>
        )}

        {!meta.loading && meta.kind === 'pdf' && (
          <iframe
            title={baseName(filePath)}
            src={meta.dataUrl}
            className="w-full h-full border-0 bg-surface"
          />
        )}

        {!meta.loading && meta.kind === 'audio' && (
          <div className="p-6">
            <p className="text-xs text-text2 mb-3">{MIME_LABEL.audio} · {baseName(filePath)}</p>
            <audio src={meta.dataUrl} controls className="w-full" />
          </div>
        )}

        {!meta.loading && meta.kind === 'video' && (
          <div className="p-4 flex items-center justify-center bg-surface min-h-full">
            <video src={meta.dataUrl} controls className="max-w-full max-h-full rounded-lg" />
          </div>
        )}

        {!meta.loading && meta.kind === 'text' && (isMd ? (
          // Markdown 渲染（与对话气泡同一套 react-markdown + GFM，表格/任务列表/代码块均支持）
          <div className="p-5 markdown-body text-sm leading-6">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>{text.content}</ReactMarkdown>
          </div>
        ) : (
          <pre className="text-xs leading-5 font-mono whitespace-pre p-3">
            {text.content.split('\n').map((line, i) => (
              <div key={i} className="flex">
                <span className="w-10 shrink-0 select-none text-right pr-3 text-text2">{i + 1}</span>
                <span className="whitespace-pre-wrap break-all">{highlightLine(line)}</span>
              </div>
            ))}
          </pre>
        ))}

        {!meta.loading && meta.kind === 'text' && meta.size > 0 && text.totalLines > TEXT_MAX_LINES && (
          <p className="text-text2 text-xs px-4 pb-4">
            仅显示前 {TEXT_MAX_LINES} 行（共 {text.totalLines} 行），完整内容请在编辑器中查看。
          </p>
        )}
      </div>
    </div>
  );
}
