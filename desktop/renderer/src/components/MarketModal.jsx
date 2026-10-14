// 插件市场（M6 / P3）：浏览、搜索、git 一键安装、已安装列表、权限面板
// 安全口径：未签名包安装会被主进程拒绝；安装时展示权限预扣，运行审批仍走主进程审批矩阵
import { useState, useEffect, useMemo } from 'react';
import { market, TYPE_LABELS, PERMISSION_LABELS, signatureLabel } from '../lib/market';
import InlineAlert from './InlineAlert';
import { confirm } from './feedback';
import { IconAlert, IconDownload, IconPuzzle, IconRefresh, IconSearch, IconX } from './icons';

const TYPE_FILTERS = [
  { id: '', label: '全部' },
  { id: 'mcp', label: 'MCP 服务' },
  { id: 'skill', label: '技能包' },
  { id: 'prompt', label: '提示词模板' },
];

const SORTS = [
  { id: 'downloads', label: '按热度' },
  { id: 'newest', label: '按更新' },
  { id: 'name', label: '按名称' },
];

export default function MarketModal({ onClose, onInstalled, embedded = false }) {
  // ST3：embedded=true 时由设置页内嵌渲染（仅内容区，无全屏遮罩）
  const [tab, setTab] = useState('browse'); // browse | installed
  const [plugins, setPlugins] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [type, setType] = useState('');
  const [sort, setSort] = useState('downloads');
  const [gitUrl, setGitUrl] = useState('');
  const [detail, setDetail] = useState(null); // 权限面板展开的插件
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadBrowse() {
    const res = await market.refreshIndex();
    if (!res.ok) setError(res.error || '市场索引拉取失败');
    const s = await market.search({ q: keyword, type, sort });
    if (s.ok) setPlugins(s.plugins || []);
    else setError(s.error || '插件列表加载失败');
  }

  async function loadInstalled() {
    const res = await market.listInstalled();
    if (res.ok) setInstalled(res.plugins || []);
    else setError(res.error || '已安装插件加载失败');
  }

  useEffect(() => { loadBrowse(); loadInstalled(); }, []);
  useEffect(() => {
    if (tab !== 'browse') return;
    const t = setTimeout(() => { market.search({ q: keyword, type, sort }).then((s) => s.ok && setPlugins(s.plugins || [])); }, 200);
    return () => clearTimeout(t);
  }, [keyword, type, sort]);

  const filteredHint = useMemo(() => {
    const total = plugins.length;
    if (!keyword && !type) return `共 ${total} 个插件`;
    return `筛选出 ${total} 个插件`;
  }, [plugins, keyword, type]);

  async function openDetail(plugin) {
    if (detail && detail.name === plugin.name) { setDetail(null); return; }
    const res = await market.inspect(plugin.name);
    if (res.ok) setDetail(res.plugin);
    else setError(res.error || '插件详情读取失败');
  }

  // 安装：市场条目一键装 / git 地址手动装（两种入口共用同一安装通道）
  async function install(source, name) {
    setBusy(name);
    setError('');
    setNotice('');
    const res = await market.installFromGit({ url: source, name });
    if (res.ok) {
      setNotice(`已安装 ${res.plugin?.name || name}，权限见下方预扣清单`);
      setDetail(res.plugin);
      setGitUrl('');
      await Promise.all([loadInstalled(), tab === 'browse' ? loadBrowse() : Promise.resolve()]);
      if (typeof onInstalled === 'function') onInstalled(res.plugin);
    } else {
      setError(`安装失败：${(res.errors || [res.error]).filter(Boolean).join('；')}`);
    }
    setBusy('');
  }

  async function installFromGitForm() {
    const url = gitUrl.trim();
    if (!url) { setError('请填写 git 仓库地址'); return; }
    await install(url, url.split('/').pop().replace(/\.git$/, ''));
  }

  async function toggleEnabled(plugin) {
    const res = await market.setEnabled({ name: plugin.name, enabled: !plugin.enabled });
    if (res.ok) await loadInstalled();
    else setError(res.error || '操作失败');
  }

  async function remove(plugin) {
    // A2：卸载需确认
    const ok = await confirm({
      title: '卸载插件',
      message: `确定卸载「${plugin.name}」吗？其本地文件将被删除，相关功能随即失效。`,
      danger: true,
      confirmLabel: '卸载',
    });
    if (!ok) return;
    const res = await market.uninstall({ name: plugin.name });
    if (res.ok) { setNotice(`已卸载 ${plugin.name}`); await loadInstalled(); }
    else setError(res.error || '卸载失败');
  }

  const installedNames = new Set(installed.map((p) => p.name));

  const content = (
    <div className={embedded ? 'bg-surface border border-border rounded-2xl flex flex-col max-h-[72vh]' : 'bg-surface border border-border rounded-2xl w-[820px] max-h-[86vh] flex flex-col'}>
      {/* 头部 */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <IconPuzzle size={16} className="text-accent" />
          插件市场
        </h3>
        {!embedded && (
          <button onClick={onClose} className="text-text2 hover:text-text"><IconX size={16} /></button>
        )}
      </div>

        {/* 页签 */}
        <div className="flex gap-1 px-5 pt-3">
          {[['browse', '浏览市场'], ['installed', '已安装']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`h-9 inline-flex items-center px-3.5 rounded-lg text-sm ${tab === id ? 'bg-accent text-white' : 'text-text2 hover:bg-hover'}`}>
              {label}
            </button>
          ))}
          {tab === 'browse' && (
            <button onClick={loadBrowse} className="ml-auto h-8 w-8 inline-flex items-center justify-center text-text2 hover:text-text rounded-lg" title="刷新索引">
              <IconRefresh size={14} />
            </button>
          )}
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
          {error && <InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert>}
          {notice && <InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert>}

          {tab === 'browse' && (
            <>
              {/* 搜索与过滤 */}
              <div className="flex items-center gap-2 mb-3">
                <div className="flex-1 h-8 flex items-center gap-2 bg-bg border border-border rounded-lg px-3">
                  <IconSearch size={14} className="text-text2" />
                  <input value={keyword} onChange={(e) => setKeyword(e.target.value)}
                    placeholder="搜索插件名称、描述或标签"
                    className="flex-1 bg-transparent outline-none text-sm" />
                </div>
                <select value={sort} onChange={(e) => setSort(e.target.value)}
                  className="h-8 bg-bg border border-border rounded-lg px-2 text-sm">
                  {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-1 mb-4">
                {TYPE_FILTERS.map((f) => (
                  <button key={f.id} onClick={() => setType(f.id)}
                    className={`h-8 inline-flex items-center px-3 rounded-lg text-xs ${type === f.id ? 'bg-accent text-white' : 'text-text2 hover:bg-hover'}`}>
                    {f.label}
                  </button>
                ))}
                <span className="ml-auto text-xs text-text2">{filteredHint}</span>
              </div>

              {/* git 手动装 */}
              <div className="bg-bg border border-border rounded-2xl px-4 py-3 mb-4">
                <div className="text-xs text-text2 mb-2">从 git 仓库安装（未签名包将被拒绝）</div>
                <div className="flex gap-2">
                  <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && installFromGitForm()}
                    placeholder="https://github.com/your-org/your-plugin.git"
                    className="flex-1 h-8 bg-transparent border border-border rounded-lg px-3 text-sm outline-none" />
                  <button onClick={installFromGitForm} disabled={busy === gitUrl.trim() || !gitUrl.trim()}
                    className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm bg-accent text-white hover:opacity-90 disabled:opacity-40">
                    {busy ? '安装中' : '安装'}
                  </button>
                </div>
              </div>

              {/* 插件卡片 */}
              {plugins.length === 0 ? (
                <p className="text-sm text-text2 py-8 text-center">暂无匹配插件</p>
              ) : plugins.map((p) => {
                const sig = signatureLabel(p);
                const expanded = detail && detail.name === p.name;
                return (
                  <div key={p.name} className="bg-bg border border-border rounded-2xl px-4 py-3 mb-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{p.name}</span>
                          <span className="text-xs text-text2">v{p.version}</span>
                          <span className="text-xs px-1.5 py-[3px] leading-none rounded bg-hover text-text2">{TYPE_LABELS[p.type] || p.type}</span>
                        </div>
                        <p className="text-xs text-text2 mt-1 line-clamp-2">{p.description || '（无描述）'}</p>
                        <div className="flex items-center gap-3 mt-1.5">
                          <span className={`text-xs ${sig.cls}`}>{sig.text}</span>
                          <span className="text-xs text-text2">下载 {p.downloads || 0}</span>
                          {p.author && <span className="text-xs text-text2">{p.author}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => openDetail(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover">
                          权限
                        </button>
                        <button onClick={() => install(p.source, p.name)}
                          disabled={busy === p.name || installedNames.has(p.name)}
                          className="h-8 inline-flex items-center justify-center gap-1 px-3 rounded-lg text-sm bg-accent text-white hover:opacity-90 disabled:opacity-40">
                          <IconDownload size={14} />
                          {installedNames.has(p.name) ? '已安装' : (busy === p.name ? '安装中' : '安装')}
                        </button>
                      </div>
                    </div>
                    {expanded && <PermissionPanel plugin={p} />}
                  </div>
                );
              })}
            </>
          )}

          {tab === 'installed' && (
            installed.length === 0 ? (
              <p className="text-sm text-text2 py-8 text-center">尚未安装任何插件</p>
            ) : installed.map((p) => (
              <div key={p.name} className="bg-bg border border-border rounded-2xl px-4 py-3 mb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.name}</span>
                      <span className="text-xs text-text2">v{p.version}</span>
                      <span className="text-xs px-1.5 py-[3px] leading-none rounded bg-hover text-text2">{TYPE_LABELS[p.type] || p.type}</span>
                      <span className={`text-xs ${p.enabled ? 'text-success' : 'text-text2'}`}>{p.enabled ? '已启用' : '已停用'}</span>
                    </div>
                    <p className="text-xs text-text2 mt-1">{p.description || '（无描述）'}</p>
                    <p className="text-xs text-text2 mt-1 font-mono break-all">来源：{p.source || '（本地）'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => openDetail(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover">
                      权限
                    </button>
                    <button onClick={() => toggleEnabled(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover">
                      {p.enabled ? '停用' : '启用'}
                    </button>
                    <button onClick={() => remove(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover text-danger">
                      卸载
                    </button>
                  </div>
                </div>
                {detail && detail.name === p.name && <PermissionPanel plugin={p} />}
              </div>
            ))
          )}
        </div>
    </div>
  );

  // ST3：内嵌模式只渲染内容区，由宿主（设置页）提供滚动容器
  if (embedded) return content;
  return (
    <div className="fixed inset-0 bg-overlay flex items-center justify-center z-settings">
      {content}
    </div>
  );
}

// 权限面板：安装预扣清单。运行期每次触发对应级别操作仍会走审批矩阵（实扣）
function PermissionPanel({ plugin }) {
  const perms = Array.isArray(plugin.permissions) ? plugin.permissions : [];
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex items-center gap-1.5 text-xs text-text2 mb-2">
        <IconAlert size={13} />
        安装授权为预扣：以下范围在你确认安装后生效；运行期每次调用仍会走审批矩阵
      </div>
      {perms.length === 0 ? (
        <p className="text-xs text-warn">该插件未声明任何权限：所有受限操作在运行期默认拒绝</p>
      ) : (
        <ul className="space-y-1">
          {perms.map((p, i) => {
            const scope = Array.isArray(p.scope) ? p.scope : (p.scope == null ? ['*'] : [p.scope]);
            return (
              <li key={`${p.level}-${i}`} className="text-xs flex items-start gap-2">
                <span className="text-accent">{PERMISSION_LABELS[p.level] || p.level}</span>
                <span className="text-text2 break-all">
                  {scope.includes('*') ? '全部' : scope.join('、')}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}