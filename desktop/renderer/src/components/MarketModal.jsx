// 插件市场（M6 / P3）：浏览、搜索、git 一键安装、已安装列表、权限面板
// 安全口径：未签名包安装会被主进程拒绝；安装时展示权限预扣，运行审批仍走主进程审批矩阵
import { useState, useEffect, useMemo } from 'react';
import { market, TYPE_LABELS, PERMISSION_LABELS, signatureLabel } from '../lib/market';
import InlineAlert from './InlineAlert';
import { confirm } from './feedback';
import Modal from './ui/Modal';
import { IconAlert, IconDownload, IconPuzzle, IconRefresh, IconSearch, IconX } from './icons';
import { useI18n } from '../i18n';

// labelKey 而非 label：顶层常量不持有求值结果，渲染时经 t() 取文案（切语言即时生效）
const TYPE_FILTERS = [
  { id: '', labelKey: 'market.filters.all' },
  { id: 'mcp', labelKey: 'market.filters.mcp' },
  { id: 'skill', labelKey: 'market.filters.skill' },
  { id: 'prompt', labelKey: 'market.filters.prompt' },
];

const SORTS = [
  { id: 'downloads', labelKey: 'market.sorts.downloads' },
  { id: 'newest', labelKey: 'market.sorts.newest' },
  { id: 'name', labelKey: 'market.sorts.name' },
];

export default function MarketModal({ onClose, onInstalled, embedded = false }) {
  const { t } = useI18n();
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
    if (!res.ok) setError(res.error || t('market.indexFetchFailed'));
    const s = await market.search({ q: keyword, type, sort });
    if (s.ok) setPlugins(s.plugins || []);
    else setError(s.error || t('market.listLoadFailed'));
  }

  async function loadInstalled() {
    const res = await market.listInstalled();
    if (res.ok) setInstalled(res.plugins || []);
    else setError(res.error || t('market.installedLoadFailed'));
  }

  // 刻意「挂载时加载一次」：loadBrowse 读 keyword/type/sort 等筛选 state，列入依赖会让
  // 每次输入/切筛选都重新请求；搜索本身由下方带 200ms 防抖的 effect 负责（其依赖含
  // keyword/type/sort）。安装/卸载后的刷新由各 handler 显式调用 loadInstalled()。
  useEffect(() => { loadBrowse(); loadInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (tab !== 'browse') return;
    const t = setTimeout(() => { market.search({ q: keyword, type, sort }).then((s) => s.ok && setPlugins(s.plugins || [])); }, 200);
    return () => clearTimeout(t);
    // P1-6：tab 必须列入依赖。此前遗漏 → 从其他 tab 切回「浏览」时 effect 不重跑，
    // 搜索结果停留在上次状态（甚至为空），用户看到的是过期的插件列表。
  }, [tab, keyword, type, sort]);

  const filteredHint = useMemo(() => {
    const total = plugins.length;
    if (!keyword && !type) return t('market.totalPlugins', { n: total });
    return t('market.filteredPlugins', { n: total });
  }, [plugins, keyword, type, t]);

  async function openDetail(plugin) {
    if (detail && detail.name === plugin.name) { setDetail(null); return; }
    const res = await market.inspect(plugin.name);
    if (res.ok) setDetail(res.plugin);
    else setError(res.error || t('market.detailLoadFailed'));
  }

  // 安装：市场条目一键装 / git 地址手动装（两种入口共用同一安装通道）
  async function install(source, name) {
    setBusy(name);
    setError('');
    setNotice('');
    const res = await market.installFromGit({ url: source, name });
    if (res.ok) {
      setNotice(t('market.installedNotice', { name: res.plugin?.name || name }));
      setDetail(res.plugin);
      setGitUrl('');
      await Promise.all([loadInstalled(), tab === 'browse' ? loadBrowse() : Promise.resolve()]);
      if (typeof onInstalled === 'function') onInstalled(res.plugin);
    } else {
      setError(t('market.installFailed', { errors: (res.errors || [res.error]).filter(Boolean).join(t('market.errSep')) }));
    }
    setBusy('');
  }

  async function installFromGitForm() {
    const url = gitUrl.trim();
    if (!url) { setError(t('market.gitUrlRequired')); return; }
    await install(url, url.split('/').pop().replace(/\.git$/, ''));
  }

  async function toggleEnabled(plugin) {
    const res = await market.setEnabled({ name: plugin.name, enabled: !plugin.enabled });
    if (res.ok) await loadInstalled();
    else setError(res.error || t('market.opFailed'));
  }

  async function remove(plugin) {
    // A2：卸载需确认
    const ok = await confirm({
      title: t('market.uninstallTitle'),
      message: t('market.uninstallMessage', { name: plugin.name }),
      danger: true,
      confirmLabel: t('market.uninstall'),
    });
    if (!ok) return;
    const res = await market.uninstall({ name: plugin.name });
    if (res.ok) { setNotice(t('market.uninstalledNotice', { name: plugin.name })); await loadInstalled(); }
    else setError(res.error || t('market.uninstallFailed'));
  }

  const installedNames = new Set(installed.map((p) => p.name));

  const content = (
    <div className={embedded ? 'bg-surface border border-border rounded-2xl flex flex-col max-h-[72vh]' : 'bg-surface border border-border rounded-2xl w-[820px] max-h-[86vh] flex flex-col'}>
      {/* 头部 */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <IconPuzzle size={16} className="text-accent" />
          {t('market.title')}
        </h3>
        {!embedded && (
          <button onClick={onClose} className="text-text2 hover:text-text"><IconX size={16} /></button>
        )}
      </div>

        {/* 页签 */}
        <div className="flex gap-1 px-5 pt-3">
          {[['browse', t('market.tabBrowse')], ['installed', t('market.tabInstalled')]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`h-9 inline-flex items-center px-4 rounded-lg text-sm ${tab === id ? 'bg-accent-solid text-on-accent' : 'text-text2 hover:bg-hover'}`}>
              {label}
            </button>
          ))}
          {tab === 'browse' && (
            <button onClick={loadBrowse} className="ml-auto h-8 w-8 inline-flex items-center justify-center text-text2 hover:text-text rounded-lg" title={t('market.refreshIndex')}>
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
                    placeholder={t('market.searchPlaceholder')}
                    className="flex-1 bg-transparent outline-none text-sm" />
                </div>
                <select value={sort} onChange={(e) => setSort(e.target.value)}
                  className="h-8 bg-bg border border-border rounded-lg px-2 text-sm">
                  {SORTS.map((s) => <option key={s.id} value={s.id}>{t(s.labelKey)}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-1 mb-4">
                {TYPE_FILTERS.map((f) => (
                  <button key={f.id} onClick={() => setType(f.id)}
                    className={`h-8 inline-flex items-center px-3 rounded-lg text-xs ${type === f.id ? 'bg-accent-solid text-on-accent' : 'text-text2 hover:bg-hover'}`}>
                    {t(f.labelKey)}
                  </button>
                ))}
                <span className="ml-auto text-xs text-text2">{filteredHint}</span>
              </div>

              {/* git 手动装 */}
              <div className="bg-bg border border-border rounded-2xl px-4 py-3 mb-4">
                <div className="text-xs text-text2 mb-2">{t('market.gitInstallHint')}</div>
                <div className="flex gap-2">
                  <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && installFromGitForm()}
                    placeholder="https://github.com/your-org/your-plugin.git"
                    className="flex-1 h-8 bg-transparent border border-border rounded-lg px-3 text-sm outline-none" />
                  <button onClick={installFromGitForm} disabled={busy === gitUrl.trim() || !gitUrl.trim()}
                    className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm bg-accent-solid text-on-accent hover:brightness-110 disabled:opacity-40">
                    {busy ? t('market.installing') : t('market.install')}
                  </button>
                </div>
              </div>

              {/* 插件卡片 */}
              {plugins.length === 0 ? (
                <p className="text-sm text-text2 py-8 text-center">{t('market.emptyBrowse')}</p>
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
                          <span className="text-xs px-2 py-[3px] leading-none rounded bg-hover text-text2">{TYPE_LABELS[p.type] ? t(TYPE_LABELS[p.type]) : p.type}</span>
                        </div>
                        <p className="text-xs text-text2 mt-1 line-clamp-2">{p.description || t('market.noDescription')}</p>
                        <div className="flex items-center gap-3 mt-2">
                          <span className={`text-xs ${sig.cls}`}>{t(sig.textKey, sig.vars)}</span>
                          <span className="text-xs text-text2">{t('market.downloadsCount', { n: p.downloads || 0 })}</span>
                          {p.author && <span className="text-xs text-text2">{p.author}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => openDetail(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover">
                          {t('market.permissions')}
                        </button>
                        <button onClick={() => install(p.source, p.name)}
                          disabled={busy === p.name || installedNames.has(p.name)}
                          className="h-8 inline-flex items-center justify-center gap-1 px-3 rounded-lg text-sm bg-accent-solid text-on-accent hover:brightness-110 disabled:opacity-40">
                          <IconDownload size={14} />
                          {installedNames.has(p.name) ? t('market.installed') : (busy === p.name ? t('market.installing') : t('market.install'))}
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
              <p className="text-sm text-text2 py-8 text-center">{t('market.emptyInstalled')}</p>
            ) : installed.map((p) => (
              <div key={p.name} className="bg-bg border border-border rounded-2xl px-4 py-3 mb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.name}</span>
                      <span className="text-xs text-text2">v{p.version}</span>
                      <span className="text-xs px-2 py-[3px] leading-none rounded bg-hover text-text2">{TYPE_LABELS[p.type] ? t(TYPE_LABELS[p.type]) : p.type}</span>
                      <span className={`text-xs ${p.enabled ? 'text-success' : 'text-text2'}`}>{p.enabled ? t('market.enabled') : t('market.disabled')}</span>
                    </div>
                    <p className="text-xs text-text2 mt-1">{p.description || t('market.noDescription')}</p>
                    <p className="text-xs text-text2 mt-1 font-mono break-all">{t('market.sourceLabel', { source: p.source || t('market.localSource') })}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => openDetail(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover">
                      {t('market.permissions')}
                    </button>
                    <button onClick={() => toggleEnabled(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover">
                      {p.enabled ? t('market.disable') : t('market.enable')}
                    </button>
                    <button onClick={() => remove(p)} className="h-8 inline-flex items-center justify-center px-3 rounded-lg text-sm border border-border hover:bg-hover text-danger">
                      {t('market.uninstall')}
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
  // （内嵌态不是对话框：不套 Modal，否则会给内嵌面板套一层焦点陷阱）
  if (embedded) return content;
  // P1-9⑤：外壳交给 ui/Modal（dialog 语义 + 焦点陷阱 + Esc + 关闭归还焦点）。
  // frameless = 只换外壳：content 自带 width/max-h/rounded/shadow，视觉零改动。
  return (
    <Modal open onClose={onClose} frameless ariaLabel={t('market.title')}>
      {content}
    </Modal>
  );
}

// 权限面板：安装预扣清单。运行期每次触发对应级别操作仍会走审批矩阵（实扣）
function PermissionPanel({ plugin }) {
  const { t } = useI18n();
  const perms = Array.isArray(plugin.permissions) ? plugin.permissions : [];
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex items-center gap-2 text-xs text-text2 mb-2">
        <IconAlert size={13} />
        {t('market.preinstallNote')}
      </div>
      {perms.length === 0 ? (
        <p className="text-xs text-warn">{t('market.noPermsWarning')}</p>
      ) : (
        <ul className="space-y-1">
          {perms.map((p, i) => {
            const scope = Array.isArray(p.scope) ? p.scope : (p.scope == null ? ['*'] : [p.scope]);
            return (
              <li key={`${p.level}-${i}`} className="text-xs flex items-start gap-2">
                <span className="text-accent">{PERMISSION_LABELS[p.level] ? t(PERMISSION_LABELS[p.level]) : p.level}</span>
                <span className="text-text2 break-all">
                  {scope.includes('*') ? t('market.filters.all') : scope.join(t('market.listSep'))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}