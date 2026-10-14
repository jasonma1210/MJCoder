import { useState, useEffect, useCallback } from 'react';
import { IconCheck, IconChevronRight, IconFileDiff, IconGitBranch, IconRefresh } from './icons';
import { confirm, countConfirm, toast } from './feedback';

// 按文件分组的 diff 审查面板：逐文件接受（git add）/ 放弃修改（checkout 还原）
// 嵌入右侧常驻面板渲染，不再使用全屏模态（对标 Codex 的 Review Pane）
// A2：放弃 = gitCheckout 销毁磁盘工作，必须确认 + 落快照 + 5s 可撤销
// R1：文件默认折叠为统计行，点击展开 hunk —— 大变更（几百文件）不再全量渲染卡死
export default function DiffReviewPanel({ projectPath, agentFiles = [] }) {
  const [files, setFiles] = useState([]);
  const [lastTurnOnly, setLastTurnOnly] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [expandedFiles, setExpandedFiles] = useState(() => new Set());
  // P0-E：创建 PR（gh CLI）——diff 审查的「交付」出口
  const [prOpen, setPrOpen] = useState(false);
  const [prForm, setPrForm] = useState({ title: '', body: '', base: '', draft: true });
  const [prBusy, setPrBusy] = useState(false);
  const [prError, setPrError] = useState('');
  const [prResult, setPrResult] = useState(null); // { url }

  function toggleFile(path) {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  const load = useCallback(async () => {
    if (!projectPath || !window.mjcode?.gitDiff) return;
    try {
      const r = await window.mjcode.gitDiff({ cwd: projectPath });
      if (r.error && !r.stdout) { setError(r.error); setFiles([]); return; }
      setError('');
      setFiles(parseDiff(r.stdout || ''));
    } catch (err) {
      console.warn('[diffReview] 加载失败:', err);
      setError(err.message || '获取变更失败');
    }
  }, [projectPath]);

  useEffect(() => { load(); }, [load]);

  async function accept(file) {
    setBusy(true);
    try {
      const r = await window.mjcode.gitAdd({ cwd: projectPath, files: file.path });
      setNotice(r.error ? `接受失败：${r.error}` : `已暂存 ${file.path}`);
    } catch (err) { setNotice(`接受失败：${err.message}`); }
    setBusy(false);
    await load();
  }

  // 放弃修改前对当前文件落快照；失败不阻断（提示用户无撤销出口）
  async function snapshot(files) {
    try {
      const r = await window.mjcode.createBackup?.({ cwd: projectPath, files });
      if (r?.ok) return r.snapshotId;
      console.warn('[diffReview] 快照失败:', r?.error);
      return null;
    } catch (err) {
      console.warn('[diffReview] 快照失败:', err);
      return null;
    }
  }

  async function reject(file) {
    // 文案改「放弃修改」并明确后果；快照默认保留，5s 内可撤销
    const ok = await confirm({
      title: '放弃修改',
      message: `放弃对「${file.path}」的修改（+${file.added}/−${file.removed}）？\n此操作不可通过 Git 找回，将先自动保留一份快照。`,
      danger: true,
      confirmLabel: '放弃修改',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const snapshotId = await snapshot([file.path]);
      // 已暂存文件先取消暂存再还原，保证精确还原
      const staged = await window.mjcode.gitStatus({ cwd: projectPath });
      const isStaged = (staged.stdout || '').split('\n').some((l) => l.trim().startsWith('M ') && l.includes(file.path));
      if (isStaged) await window.mjcode.gitRestoreStaged({ cwd: projectPath, files: file.path });
      const r = await window.mjcode.gitCheckout({ cwd: projectPath, files: file.path });
      if (r.error) {
        setNotice(`放弃失败：${r.error}`);
      } else {
        setNotice(`已放弃 ${file.path} 的修改`);
        if (snapshotId) offerUndo(snapshotId, [file.path]);
      }
    } catch (err) { setNotice(`放弃失败：${err.message}`); }
    setBusy(false);
    await load();
  }

  function offerUndo(snapshotId, files) {
    toast({
      message: '已放弃修改',
      actionLabel: '撤销',
      onAction: async () => {
        const r = await window.mjcode.restoreBackup?.({ snapshotId });
        if (r?.ok) {
          setNotice(`已从快照恢复 ${r.restored} 个文件`);
          await load();
        } else {
          setNotice(`快照恢复失败：${r?.error || '未知错误'}`);
        }
      },
    });
  }

  async function acceptAll() {
    setBusy(true);
    try {
      const r = await window.mjcode.gitAdd({ cwd: projectPath, files: files.map((f) => f.path) });
      setNotice(r.error ? `全部接受失败：${r.error}` : `已暂存 ${files.length} 个文件`);
    } catch (err) { setNotice(`全部接受失败：${err.message}`); }
    setBusy(false);
    await load();
  }

  async function rejectAll() {
    // 「全部放弃」：输入文件数量二次确认 + 快照 + 5s 可撤销
    const ok = await countConfirm({
      title: '全部放弃修改',
      message: `将放弃以下 ${files.length} 个文件的全部未提交修改，且不可通过 Git 找回：\n${files.map((f) => f.path).slice(0, 8).join('\n')}${files.length > 8 ? `\n…共 ${files.length} 个` : ''}\n\n放弃前将自动保留快照。`,
      danger: true,
      count: files.length,
      confirmLabel: '全部放弃',
    });
    if (!ok) return;
    setBusy(true);
    const allPaths = files.map((f) => f.path);
    const snapshotId = await snapshot(allPaths);
    try {
      // R2：批量执行 —— 一次 gitStatus 拿全量 staged 集合，再两次批量 git 操作
      // （此前逐文件 3 次 IPC，100 文件 = 300 次往返）
      const staged = await window.mjcode.gitStatus({ cwd: projectPath });
      const stagedLines = (staged.stdout || '').split('\n').filter((l) => l.trim());
      const stagedPaths = new Set(stagedLines.map((l) => l.slice(3).trim()));
      const toUnstage = allPaths.filter((p) => stagedPaths.has(p));
      if (toUnstage.length > 0) await window.mjcode.gitRestoreStaged({ cwd: projectPath, files: toUnstage });
      await window.mjcode.gitCheckout({ cwd: projectPath, files: allPaths });
      setNotice(`已放弃 ${files.length} 个文件的修改`);
      if (snapshotId) offerUndo(snapshotId, allPaths);
    } catch (err) { setNotice(`全部放弃失败：${err.message}`); }
    setBusy(false);
    await load();
  }

  // P0-E：创建 PR —— 打开内嵌表单（预填标题/正文），提交经 gh CLI 创建
  async function openPr() {
    setPrError('');
    setPrResult(null);
    setPrForm({
      title: `${files.length} 个文件的变更`,
      body: files.map((f) => `- ${f.path}（+${f.added}/−${f.removed}）`).join('\n'),
      base: '',
      draft: true,
    });
    setPrOpen(true);
    try {
      const st = await window.mjcode?.githubStatus?.();
      if (st && !st.available) setPrError(st.hint || '未检测到 GitHub CLI（gh）');
      else if (st && !st.authed) setPrError(st.hint || 'gh 未登录');
    } catch (err) { setPrError(err.message || 'GitHub 状态检测失败'); }
  }

  async function submitPr() {
    if (!prForm.title.trim()) { setPrError('PR 标题不能为空'); return; }
    setPrBusy(true);
    setPrError('');
    try {
      const r = await window.mjcode?.githubCreatePr?.({
        cwd: projectPath,
        title: prForm.title.trim(),
        body: prForm.body,
        base: prForm.base.trim(),
        draft: !!prForm.draft,
      });
      if (r?.ok && r.url) {
        setPrResult({ url: r.url });
        toast({ message: 'PR 已创建' });
      } else {
        setPrError(r?.error || '创建失败');
      }
    } catch (err) { setPrError(err.message || '创建失败'); }
    setPrBusy(false);
  }

  // Last turn：只看 Agent 本轮改动过的文件（区分「AI 改的」与「我自己改的」）
  // 路径归一：模型传给写工具的 path 可能是绝对路径，而 gitDiff 输出是仓库相对路径——
  // 不归一的话「上一轮」筛选恒为空集（agentSet.has(f.path) 永远 miss）
  const agentSet = new Set((agentFiles || []).map((p) => {
    const s = String(p || '');
    return projectPath && s.startsWith(`${projectPath}/`) ? s.slice(projectPath.length + 1) : s;
  }));
  const visible = lastTurnOnly && agentSet.size > 0
    ? files.filter((f) => agentSet.has(f.path))
    : files;

  const totalAdd = visible.reduce((s, f) => s + f.added, 0);
  const totalDel = visible.reduce((s, f) => s + f.removed, 0);

  // 还原单个代码块（最小粒度）
  async function rejectHunk(file, hunk) {
    setBusy(true);
    try {
      const r = await window.mjcode.gitApplyHunk({ cwd: projectPath, patch: hunkPatch(file.path, hunk) });
      setNotice(r.error ? `还原失败：${r.error}` : `已放弃该代码块的修改`);
    } catch (err) { setNotice(`还原失败：${err.message}`); }
    setBusy(false);
    await load();
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <h3 className="font-semibold text-xs flex items-center gap-2">
          <IconFileDiff size={14} />
          代码变更（{visible.length} 个文件）
          <span className="text-success text-xs">+{totalAdd}</span>
          <span className="text-danger text-xs">−{totalDel}</span>
        </h3>
        <button onClick={load} className="text-text2 hover:text-text p-1" title="刷新" aria-label="刷新变更">
          <IconRefresh size={14} />
        </button>
        <button
          onClick={() => setLastTurnOnly((v) => !v)}
          disabled={agentSet.size === 0}
          title={agentSet.size === 0 ? '本轮没有 Agent 改动记录' : '只看 Agent 本轮改动的文件'}
          className={`text-[11px] px-2 py-1 rounded-md ${lastTurnOnly ? 'bg-accent text-white' : 'text-text2 hover:text-text'} disabled:opacity-40`}
        >
          上一轮
        </button>
      </div>

      {notice && <div className="px-4 py-2 text-xs text-accent border-b border-border shrink-0">{notice}</div>}

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {error ? (
          <p className="text-danger text-sm text-center py-10">{error}</p>
        ) : !projectPath ? (
          <p className="text-text2 text-sm text-center py-10">尚未选择项目目录，请先在左侧打开项目</p>
        ) : visible.length === 0 ? (
          <p className="text-text2 text-sm text-center py-10">{lastTurnOnly ? 'Agent 本轮未改动文件' : '没有未提交的变更'}</p>
        ) : (
          <div className="space-y-3">
            {visible.map((f) => {
              const isOpen = expandedFiles.has(f.path);
              return (
                <div key={f.path} className="border border-border rounded-xl overflow-hidden">
                  <div
                    onClick={() => toggleFile(f.path)}
                    className="flex items-center justify-between px-3 py-2 bg-bg cursor-pointer select-none hover:bg-hover"
                    title={isOpen ? '点击折叠' : '点击查看改动'}
                  >
                    <span className="text-xs font-mono truncate flex items-center gap-1.5" title={f.path}>
                      <IconChevronRight size={12} className={`shrink-0 text-text2 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      {f.path}
                    </span>
                    <span className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-success text-xs">+{f.added}</span>
                      <span className="text-danger text-xs">−{f.removed}</span>
                      <button onClick={(e) => { e.stopPropagation(); reject(f); }} disabled={busy} title="放弃此文件的修改（先快照，可撤销）"
                        className="text-xs px-2 py-1 rounded border border-border hover:bg-hover disabled:opacity-50">放弃修改</button>
                      <button onClick={(e) => { e.stopPropagation(); accept(f); }} disabled={busy} title="暂存此文件的修改"
                        className="text-xs px-2 py-1 rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1">
                        <IconCheck size={12} /> 接受
                      </button>
                    </span>
                  </div>
                  {/* R1：默认折叠，展开才渲染 hunk 行 */}
                  {isOpen && (f.hunks?.length ? f.hunks : [{ header: '', lines: f.lines }]).map((h, hi) => (
                  <div key={hi} className="border-t border-border first:border-t-0">
                    <div className="flex items-center gap-2 px-3 py-1 bg-hover">
                      <span className="text-[10px] font-mono text-text2 truncate flex-1">{h.header || '整体改动'}</span>
                      <button
                        onClick={() => rejectHunk(f, h)}
                        disabled={busy || !h.header}
                        title={h.header ? '仅还原这个代码块' : '无法按块还原'}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-hover disabled:opacity-40"
                      >
                        还原此块
                      </button>
                    </div>
                    <pre className="text-xs font-mono p-3 overflow-x-auto max-h-56 leading-relaxed">
                      {h.lines.map((line, i) => {
                        let cls = 'text-text2';
                        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-success bg-success-bg';
                        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-danger bg-danger-bg';
                        else if (line.startsWith('@@')) cls = 'text-info';
                        return <div key={i} className={cls}>{line || ' '}</div>;
                      })}
                    </pre>
                  </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* P0-E：创建 PR 内嵌表单（gh CLI） */}
      {prOpen && files.length > 0 && (
        <div className="px-4 py-3 border-t border-border shrink-0 space-y-2">
          {prResult ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-success shrink-0">PR 已创建</span>
              <a href={prResult.url} target="_blank" rel="noreferrer" className="text-accent underline truncate">{prResult.url}</a>
              <button onClick={() => { navigator.clipboard?.writeText?.(prResult.url)?.catch?.(() => {}); toast({ message: '链接已复制' }); }}
                className="ml-auto shrink-0 h-8 inline-flex items-center px-3 rounded-lg border border-border hover:bg-hover text-xs">复制链接</button>
            </div>
          ) : (
            <>
              <input value={prForm.title} onChange={(e) => setPrForm({ ...prForm, title: e.target.value })}
                placeholder="PR 标题"
                className="w-full h-8 px-3 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent" />
              <textarea value={prForm.body} onChange={(e) => setPrForm({ ...prForm, body: e.target.value })}
                placeholder="PR 描述（支持 Markdown）" rows="3"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent resize-none" />
              <div className="flex items-center gap-2">
                <input value={prForm.base} onChange={(e) => setPrForm({ ...prForm, base: e.target.value })}
                  placeholder="base 分支（留空为默认分支）"
                  className="flex-1 h-8 px-3 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent" />
                <label className="flex items-center gap-1.5 text-xs text-text2 shrink-0">
                  <input type="checkbox" checked={prForm.draft} onChange={(e) => setPrForm({ ...prForm, draft: e.target.checked })} />
                  草稿
                </label>
              </div>
              {prError && <p className="text-danger text-xs">{prError}</p>}
              <div className="flex items-center gap-2">
                <button onClick={submitPr} disabled={prBusy}
                  className="h-8 inline-flex items-center px-3 rounded-lg bg-accent text-white text-xs hover:opacity-90 disabled:opacity-50">{prBusy ? '创建中…' : '创建 PR'}</button>
                <button onClick={() => setPrOpen(false)}
                  className="h-8 inline-flex items-center px-3 rounded-lg border border-border text-xs hover:bg-hover">取消</button>
              </div>
            </>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <span className="text-xs text-text2">逐文件审查后提交</span>
          <div className="flex gap-2">
            {/* P0-E：diff 的「交付」出口——经本机 gh CLI 创建 PR */}
            <button onClick={openPr} disabled={busy || !projectPath}
              title={projectPath ? '通过本机 GitHub CLI 创建 Pull Request' : '需先打开项目'}
              className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover disabled:opacity-50 flex items-center gap-1">
              <IconGitBranch size={12} /> 创建 PR
            </button>
            <button onClick={rejectAll} disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover disabled:opacity-50">全部放弃</button>
            <button onClick={acceptAll} disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white hover:opacity-90 disabled:opacity-50">全部接受</button>
          </div>
        </div>
      )}
    </div>
  );
}

// 解析 unified diff：按文件分组，并进一步拆分为 hunk（三级还原的最小粒度）
function parseDiff(stdout) {
  if (!stdout.trim()) return [];
  const chunks = stdout.split(/^diff --git /m).filter(Boolean);
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    const headerMatch = lines[0].match(/a\/.+ b\/(.+)$/);
    const path = headerMatch ? headerMatch[1] : lines[0].trim();
    const body = lines.slice(1);
    const added = body.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = body.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

    // 按 @@ 头切分代码块；每个块可独立反向 apply
    const hunks = [];
    let cur = null;
    for (const line of body) {
      if (line.startsWith('@@')) {
        cur = { header: line, lines: [line] };
        hunks.push(cur);
      } else if (cur) {
        cur.lines.push(line);
      }
    }

    return { path, added, removed, lines: body, hunks };
  });
}

// 还原单个代码块：反向应用该 hunk 的 patch
function hunkPatch(filePath, hunk) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    ...hunk.lines,
    '',
  ].join('\n');
}
