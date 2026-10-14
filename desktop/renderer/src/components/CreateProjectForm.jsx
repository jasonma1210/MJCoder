import { useEffect, useState } from 'react';
import { IconFolder, IconFolderPlus } from './icons';

// 创建项目表单（首启向导与项目切换弹窗共用）
// 默认：在 ~/Documents/.MJCoder 下新建项目目录，未命名时按「日期+随机数」命名（如 20261013-4821）
// 备选：添加本地文件夹，直接使用已有目录
export default function CreateProjectForm({ onCreated, onCancel, busy = false, hint = '' }) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [firstRun, setFirstRun] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  // 首次进入时确保工作区根目录存在（隐藏目录 .MJCoder）
  useEffect(() => {
    let cancelled = false;
    window.mjcode.getWorkspaceInfo?.()
      .then((r) => {
        if (cancelled || !r?.ok) return;
        setRoot(r.root);
        setFirstRun(r.created);
      })
      .catch((e) => console.warn('[project] 工作区信息获取失败:', e));
    return () => { cancelled = true; };
  }, []);

  async function create() {
    if (busy || creating) return;
    setCreating(true);
    setError('');
    try {
      const r = await window.mjcode.createProject({ name: name.trim() });
      if (!r?.ok) { setError(r?.error || '创建失败'); return; }
      onCreated?.({ path: r.path, name: r.name });
    } catch (e) {
      setError(`创建项目目录失败：${e.message}`);
    } finally {
      setCreating(false);
    }
  }

  // 添加本地文件夹：使用系统对话框选定的已有目录
  async function addLocalFolder() {
    if (busy) return;
    setError('');
    const r = await window.mjcode.pickDirectory();
    if (!r?.ok) return;
    const leaf = r.path.split('/').filter(Boolean).pop() || r.path;
    onCreated?.({ path: r.path, name: leaf });
  }

  const disabled = busy || creating;

  return (
    <div>
      {/* 项目名称 */}
      <div className="mb-5">
        <label className="block text-sm text-text2 mb-2">项目名称</label>
        <div className="flex items-center gap-3 bg-bg border border-border rounded-2xl px-4 h-14 focus-within:border-accent">
          <IconFolder size={18} className="text-text2 shrink-0" />
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            placeholder="输入项目名称"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-text2"
          />
        </div>
        <p className="text-xs text-text2 mt-2">
          {hint || (root
            ? `将新建到 ${root}，不填名称时按 日期+随机数 命名`
            : '将新建到用户文档下的隐藏目录 .MJCoder，不填名称时按 日期+随机数 命名')}
        </p>
        {firstRun && <p className="text-xs text-accent mt-1">已为本机创建工作区目录 .MJCoder</p>}
      </div>

      {/* 当前设备本地工作目录 */}
      <div className="mb-2">
        <label className="block text-sm text-text2 mb-2">当前设备本地工作目录</label>
        <button
          onClick={addLocalFolder}
          disabled={disabled}
          className="w-full flex items-center gap-3 bg-bg border border-border rounded-2xl px-4 h-14 text-left hover:bg-hover disabled:opacity-50"
        >
          <IconFolderPlus size={18} className="text-text2 shrink-0" />
          <span className="text-sm text-text2">添加本地文件夹</span>
        </button>
      </div>

      {error && <p className="text-xs text-danger mt-3">{error}</p>}

      <div className="flex justify-end gap-3 mt-6">
        {onCancel && (
          <button onClick={onCancel} disabled={creating}
            className="px-5 py-2.5 rounded-xl text-sm border border-border hover:bg-hover disabled:opacity-50">取消</button>
        )}
        <button onClick={create} disabled={disabled}
          className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm disabled:opacity-50">
          {creating ? '创建中...' : '创建项目'}
        </button>
      </div>
    </div>
  );
}