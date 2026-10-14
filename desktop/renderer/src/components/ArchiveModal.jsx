import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { confirm, toast } from './feedback';
import InlineAlert from './InlineAlert';
import { IconX } from './icons';

// A3：已归档会话管理 —— 本地「删除」的真实语义是归档，必须提供恢复/彻底删除出口
// （对标 Codex Settings → Archived Threads）
export default function ArchiveModal({ onClose, onChanged, onSelect }) {
  const [list, setList] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setList(await api.archivedThreads());
    } catch (err) {
      setError(err.message || '归档列表加载失败');
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function restore(t) {
    const r = await api.restoreThread(t.id);
    if (r?.ok) {
      toast({ message: `已恢复「${t.title || '新会话'}」` });
      onChanged?.();
      onSelect?.(t);
      load();
    } else {
      setError(r?.error || '恢复失败');
    }
  }

  async function purge(t) {
    const ok = await confirm({
      title: '彻底删除会话',
      message: `「${t.title || '新会话'}」及其全部消息将被永久删除，无法恢复。`,
      danger: true,
      confirmLabel: '永久删除',
    });
    if (!ok) return;
    const r = await api.purgeThread(t.id);
    if (r?.ok) {
      onChanged?.();
      load();
    } else {
      setError(r?.error || '删除失败');
    }
  }

  return (
    <div className="fixed inset-0 z-settings flex items-center justify-center bg-overlay" onMouseDown={onClose}>
      <div
        className="w-[560px] max-w-[calc(100vw-2rem)] max-h-[70vh] flex flex-col rounded-2xl bg-bg border border-border shadow-[var(--shadow-modal)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">已归档会话</h2>
            <p className="text-xs text-text2 mt-0.5">删除会话会先进入此处，可恢复或彻底删除</p>
          </div>
          <button onClick={onClose} className="text-text2 hover:text-text" aria-label="关闭"><IconX size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {error && <div className="mb-3"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}
          {loading ? (
            <p className="text-text2 text-sm text-center py-8">加载中…</p>
          ) : list.length === 0 ? (
            <p className="text-text2 text-sm text-center py-8">暂无归档会话</p>
          ) : (
            list.map((t) => (
              <div key={t.id} className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{t.title || '新会话'}</div>
                  <div className="text-xs text-text2 mt-0.5">
                    {new Date(t.updatedAt || t.createdAt || Date.now()).toLocaleString('zh-CN')}
                  </div>
                </div>
                <button onClick={() => restore(t)} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover shrink-0">
                  恢复
                </button>
                <button onClick={() => purge(t)} className="text-xs px-3 py-1.5 rounded-lg border border-border text-danger hover:bg-hover shrink-0">
                  彻底删除
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
