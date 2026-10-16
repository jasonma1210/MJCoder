import { useState, useEffect, useCallback } from 'react';
import { IconCheck, IconChevronRight, IconFileDiff, IconGitBranch, IconRefresh } from './icons';
import { confirm, countConfirm, toast } from './feedback';
import { useI18n } from '../i18n';

// 按文件分组的 diff 审查面板：逐文件接受（git add）/ 放弃修改（checkout 还原）
// 嵌入右侧常驻面板渲染，不再使用全屏模态（对标 Codex 的 Review Pane）
// A2：放弃 = gitCheckout 销毁磁盘工作，必须确认 + 落快照 + 5s 可撤销
// R1：文件默认折叠为统计行，点击展开 hunk —— 大变更（几百文件）不再全量渲染卡死
export default function DiffReviewPanel({ projectPath, agentFiles = [] }) {
  const { t } = useI18n();
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
      console.warn('[diffReview] load failed:', err);
      setError(err.message || t('diff.loadFailed'));
    }
  }, [projectPath, t]);

  useEffect(() => { load(); }, [load]);

  async function accept(file) {
    setBusy(true);
    try {
      const r = await window.mjcode.gitAdd({ cwd: projectPath, files: file.path });
      setNotice(r.error ? t('diff.acceptFailed', { error: r.error }) : t('diff.stagedFile', { path: file.path }));
    } catch (err) { setNotice(t('diff.acceptFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  // 放弃修改前对当前文件落快照；失败不阻断（提示用户无撤销出口）
  async function snapshot(files) {
    try {
      const r = await window.mjcode.createBackup?.({ cwd: projectPath, files });
      if (r?.ok) return r.snapshotId;
      console.warn('[diffReview] snapshot failed:', r?.error);
      return null;
    } catch (err) {
      console.warn('[diffReview] snapshot failed:', err);
      return null;
    }
  }

  async function reject(file) {
    // 文案改「放弃修改」并明确后果；快照默认保留，5s 内可撤销
    const ok = await confirm({
      title: t('diff.discard'),
      message: t('diff.discardMessage', { path: file.path, add: file.added, del: file.removed }),
      danger: true,
      confirmLabel: t('diff.discard'),
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
        setNotice(t('diff.discardFailed', { error: r.error }));
      } else {
        setNotice(t('diff.discardedFile', { path: file.path }));
        if (snapshotId) offerUndo(snapshotId, [file.path]);
      }
    } catch (err) { setNotice(t('diff.discardFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  function offerUndo(snapshotId, files) {
    toast({
      message: t('diff.undone'),
      actionLabel: t('diff.undo'),
      onAction: async () => {
        const r = await window.mjcode.restoreBackup?.({ snapshotId });
        if (r?.ok) {
          setNotice(t('diff.restoredFromSnapshot', { n: r.restored }));
          await load();
        } else {
          setNotice(t('diff.snapshotRestoreFailed', { error: r?.error || t('diff.unknownError') }));
        }
      },
    });
  }

  // V24：批量操作回执必须诚实——逐项收集结果，部分失败不得报「全部成功」。
  // 成功 N 项、失败 M 项时明确列出失败文件路径（回执区单行展示，超 5 个折叠计数）。
  function batchNotice(okCount, failures, okKey, partialKey) {
    if (failures.length === 0) return t(okKey, { n: okCount });
    const shown = failures.slice(0, 5).map((f) => f.path).join('; ');
    const list = failures.length > 5
      ? `${shown} ${t('diff.moreFiles', { n: failures.length })}`
      : shown;
    return t(partialKey, { ok: okCount, n: failures.length, list });
  }

  async function acceptAll() {
    setBusy(true);
    // V24：逐文件暂存并收集结果（此前整批一次 gitAdd，部分失败被 r.error 吞成
    // 「全部接受失败」，成功的那部分文件状态对用户不可见）
    const failures = []; // { path, error }
    for (const f of files) {
      try {
        const r = await window.mjcode.gitAdd({ cwd: projectPath, files: f.path });
        if (r.error) failures.push({ path: f.path, error: r.error });
      } catch (err) {
        failures.push({ path: f.path, error: err.message });
      }
    }
    setNotice(batchNotice(files.length - failures.length, failures, 'diff.stagedCount', 'diff.acceptAllPartial'));
    setBusy(false);
    await load();
  }

  async function rejectAll() {
    // 「全部放弃」：输入文件数量二次确认 + 快照 + 5s 可撤销
    const list = files.map((f) => f.path).slice(0, 8).join('\n');
    const more = files.length > 8 ? `\n${t('diff.moreFiles', { n: files.length })}` : '';
    const ok = await countConfirm({
      title: t('diff.discardAllTitle'),
      message: t('diff.discardAllMessage', { n: files.length, list, more }),
      danger: true,
      count: files.length,
      confirmLabel: t('diff.discardAll'),
    });
    if (!ok) return;
    setBusy(true);
    const allPaths = files.map((f) => f.path);
    const snapshotId = await snapshot(allPaths);
    // V24：逐项收集结果——部分失败不算全部成功，回执明确「成功 N 项、失败 M 项」
    const failures = []; // { path, error }
    try {
      // R2：批量取全量 staged 集合，暂存文件先批量取消暂存再逐文件还原
      // （还原阶段逐文件执行以定位失败项；此前批量 gitCheckout 失败时无法区分
      //  哪些文件已销毁、哪些仍带着改动，回执却统一报「全部成功」）
      const staged = await window.mjcode.gitStatus({ cwd: projectPath });
      const stagedLines = (staged.stdout || '').split('\n').filter((l) => l.trim());
      const stagedPaths = new Set(stagedLines.map((l) => l.slice(3).trim()));
      const toUnstage = allPaths.filter((p) => stagedPaths.has(p));
      if (toUnstage.length > 0) await window.mjcode.gitRestoreStaged({ cwd: projectPath, files: toUnstage });
    } catch (err) {
      console.warn('[diffReview] batch unstage failed (per-file checkout still attempted):', err);
    }
    for (const p of allPaths) {
      try {
        const r = await window.mjcode.gitCheckout({ cwd: projectPath, files: p });
        if (r.error) failures.push({ path: p, error: r.error });
      } catch (err) {
        failures.push({ path: p, error: err.message });
      }
    }
    const okCount = allPaths.length - failures.length;
    setNotice(batchNotice(okCount, failures, 'diff.discardedCount', 'diff.discardAllPartial'));
    if (okCount > 0 && snapshotId) offerUndo(snapshotId, allPaths.filter((p) => !failures.some((f) => f.path === p)));
    setBusy(false);
    await load();
  }

  // P0-E：创建 PR —— 打开内嵌表单（预填标题/正文），提交经 gh CLI 创建
  async function openPr() {
    setPrError('');
    setPrResult(null);
    setPrForm({
      title: t('diff.prTitlePrefill', { n: files.length }),
      body: files.map((f) => t('diff.prBodyLine', { path: f.path, add: f.added, del: f.removed })).join('\n'),
      base: '',
      draft: true,
    });
    setPrOpen(true);
    try {
      const st = await window.mjcode?.githubStatus?.();
      if (st && !st.available) setPrError(st.hint || t('diff.ghMissing'));
      else if (st && !st.authed) setPrError(st.hint || t('diff.ghNotAuthed'));
    } catch (err) { setPrError(err.message || t('diff.ghStatusFailed')); }
  }

  async function submitPr() {
    if (!prForm.title.trim()) { setPrError(t('diff.prTitleRequired')); return; }
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
        toast({ message: t('diff.prCreated') });
      } else {
        setPrError(r?.error || t('diff.createFailed'));
      }
    } catch (err) { setPrError(err.message || t('diff.createFailed')); }
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
      setNotice(r.error ? t('diff.revertFailed', { error: r.error }) : t('diff.hunkDiscarded'));
    } catch (err) { setNotice(t('diff.revertFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <h3 className="font-semibold text-xs flex items-center gap-2">
          <IconFileDiff size={14} />
          {t('diff.changesHeader', { n: visible.length })}
          <span className="text-success text-xs">+{totalAdd}</span>
          <span className="text-danger text-xs">−{totalDel}</span>
        </h3>
        <button onClick={load} className="text-text2 hover:text-text p-1" title={t('diff.refresh')} aria-label={t('diff.refreshAria')}>
          <IconRefresh size={14} />
        </button>
        <button
          onClick={() => setLastTurnOnly((v) => !v)}
          disabled={agentSet.size === 0}
          title={agentSet.size === 0 ? t('diff.noAgentChanges') : t('diff.lastTurnTitle')}
          className={`text-[11px] px-2 py-1 rounded-md ${lastTurnOnly ? 'bg-accent text-white' : 'text-text2 hover:text-text'} disabled:opacity-40`}
        >
          {t('diff.lastTurn')}
        </button>
      </div>

      {notice && <div className="px-4 py-2 text-xs text-accent border-b border-border shrink-0">{notice}</div>}

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {error ? (
          <p className="text-danger text-sm text-center py-10">{error}</p>
        ) : !projectPath ? (
          <p className="text-text2 text-sm text-center py-10">{t('diff.noProject')}</p>
        ) : visible.length === 0 ? (
          <p className="text-text2 text-sm text-center py-10">{lastTurnOnly ? t('diff.agentNoChange') : t('diff.noUncommitted')}</p>
        ) : (
          <div className="space-y-3">
            {visible.map((f) => {
              const isOpen = expandedFiles.has(f.path);
              return (
                <div key={f.path} className="border border-border rounded-xl overflow-hidden">
                  <div
                    onClick={() => toggleFile(f.path)}
                    className="flex items-center justify-between px-3 py-2 bg-bg cursor-pointer select-none hover:bg-hover"
                    title={isOpen ? t('diff.collapse') : t('diff.expand')}
                  >
                    <span className="text-xs font-mono truncate flex items-center gap-1.5" title={f.path}>
                      <IconChevronRight size={12} className={`shrink-0 text-text2 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      {f.path}
                    </span>
                    <span className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-success text-xs">+{f.added}</span>
                      <span className="text-danger text-xs">−{f.removed}</span>
                      <button onClick={(e) => { e.stopPropagation(); reject(f); }} disabled={busy} title={t('diff.discardFileTitle')}
                        className="text-xs px-2 py-1 rounded border border-border hover:bg-hover disabled:opacity-50">{t('diff.discard')}</button>
                      <button onClick={(e) => { e.stopPropagation(); accept(f); }} disabled={busy} title={t('diff.stageFileTitle')}
                        className="text-xs px-2 py-1 rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1">
                        <IconCheck size={12} /> {t('diff.accept')}
                      </button>
                    </span>
                  </div>
                  {/* R1：默认折叠，展开才渲染 hunk 行 */}
                  {isOpen && (f.hunks?.length ? f.hunks : [{ header: '', lines: f.lines }]).map((h, hi) => (
                  <div key={hi} className="border-t border-border first:border-t-0">
                    <div className="flex items-center gap-2 px-3 py-1 bg-hover">
                      <span className="text-[10px] font-mono text-text2 truncate flex-1">{h.header || t('diff.wholeChange')}</span>
                      <button
                        onClick={() => rejectHunk(f, h)}
                        disabled={busy || !h.header}
                        title={h.header ? t('diff.revertHunkTitle') : t('diff.noHunkRevert')}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-hover disabled:opacity-40"
                      >
                        {t('diff.revertHunk')}
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
              <span className="text-success shrink-0">{t('diff.prCreated')}</span>
              <a href={prResult.url} target="_blank" rel="noreferrer" className="text-accent underline truncate">{prResult.url}</a>
              <button onClick={() => { navigator.clipboard?.writeText?.(prResult.url)?.catch?.(() => {}); toast({ message: t('diff.linkCopied') }); }}
                className="ml-auto shrink-0 h-8 inline-flex items-center px-3 rounded-lg border border-border hover:bg-hover text-xs">{t('diff.copyLink')}</button>
            </div>
          ) : (
            <>
              <input value={prForm.title} onChange={(e) => setPrForm({ ...prForm, title: e.target.value })}
                placeholder={t('diff.prTitlePlaceholder')}
                className="w-full h-8 px-3 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent" />
              <textarea value={prForm.body} onChange={(e) => setPrForm({ ...prForm, body: e.target.value })}
                placeholder={t('diff.prBodyPlaceholder')} rows="3"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent resize-none" />
              <div className="flex items-center gap-2">
                <input value={prForm.base} onChange={(e) => setPrForm({ ...prForm, base: e.target.value })}
                  placeholder={t('diff.prBasePlaceholder')}
                  className="flex-1 h-8 px-3 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent" />
                <label className="flex items-center gap-1.5 text-xs text-text2 shrink-0">
                  <input type="checkbox" checked={prForm.draft} onChange={(e) => setPrForm({ ...prForm, draft: e.target.checked })} />
                  {t('diff.draft')}
                </label>
              </div>
              {prError && <p className="text-danger text-xs">{prError}</p>}
              <div className="flex items-center gap-2">
                <button onClick={submitPr} disabled={prBusy}
                  className="h-8 inline-flex items-center px-3 rounded-lg bg-accent text-white text-xs hover:opacity-90 disabled:opacity-50">{prBusy ? t('diff.creating') : t('diff.createPr')}</button>
                <button onClick={() => setPrOpen(false)}
                  className="h-8 inline-flex items-center px-3 rounded-lg border border-border text-xs hover:bg-hover">{t('diff.cancel')}</button>
              </div>
            </>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <span className="text-xs text-text2">{t('diff.reviewHint')}</span>
          <div className="flex gap-2">
            {/* P0-E：diff 的「交付」出口——经本机 gh CLI 创建 PR */}
            <button onClick={openPr} disabled={busy || !projectPath}
              title={projectPath ? t('diff.createPrTitle') : t('diff.needProject')}
              className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover disabled:opacity-50 flex items-center gap-1">
              <IconGitBranch size={12} /> {t('diff.createPr')}
            </button>
            <button onClick={rejectAll} disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover disabled:opacity-50">{t('diff.discardAll')}</button>
            <button onClick={acceptAll} disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white hover:opacity-90 disabled:opacity-50">{t('diff.acceptAll')}</button>
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
