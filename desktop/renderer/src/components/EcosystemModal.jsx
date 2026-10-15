// 生态中心（M7）：50 数字员工 / 100 MCP 连接器 / 100 Skill 目录 —— 下载模型
// 目录只负责「下载」：技能经主进程 skills:installEcosystem 物化到 ~/.mjcode/skills；
// 数字员工 / 连接器进入本地下载清单（lib/ecosystemLocal.js，后期统一迁自有后端）。
// 会话输入框「+」菜单只展示已下载或内置的资产，目录本身不再直接「在当前会话启用」。
// 数据经主进程 ecosystem:* IPC 读取本地 ecosystem 资产；TODO(backend)：切换为后端接口。
import { useState, useEffect } from 'react';
import { IconAlert, IconCheck, IconDownload, IconGlobe, IconPuzzle, IconRefresh, IconSearch, IconUser, IconX, IconPlug } from './icons';
import {
  isEmployeeDownloaded, downloadEmployee,
  isConnectorDownloaded, downloadConnector,
} from '../lib/ecosystemLocal';
import { fetchEcosystemRemote, getEcosystemApiBase, setEcosystemApiBase } from '../lib/ecosystemApi';

// 数字员工默认审批策略文案（与主进程 approval_policy 对齐）
const APPROVAL_LABELS = {
  'on-request': '按需审批',
  'auto-safe': '安全自动',
  'safe-auto': '安全自动',
  trusted: '完全信任',
  always: '始终允许',
};

// MCP 权限级别中文
const PERMISSION_LABELS = {
  filesystem: '文件系统',
  network: '网络',
  shell: '系统命令',
};

// E1：目录分页（此前 100 员工/100 连接器/100 技能全量 grid 渲染，数据量大即卡顿）
const PAGE_SIZE = 12;

function bridge() {
  return (typeof window !== 'undefined' && window.mjcode) || null;
}

export default function EcosystemModal({ onClose, embedded = false }) {
  // ST3：embedded=true 时由设置页内嵌渲染（仅内容区，无全屏遮罩）
  const [tab, setTab] = useState('employees'); // employees | connectors | skills
  const [employees, setEmployees] = useState([]);
  const [connectors, setConnectors] = useState([]);
  const [skills, setSkills] = useState([]);
  const [installedSkillIds, setInstalledSkillIds] = useState(() => new Set()); // 磁盘已安装技能（dir/name/id）
  const [stats, setStats] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null); // C2：详情展开
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState('');
  const [dlVer, setDlVer] = useState(0); // 下载清单版本：下载后 bump 触发按钮态刷新
  // 云端数据源（用户自有后端）：本地资产先兜底加载，云端命中字段即覆盖
  const [source, setSource] = useState('local'); // local | cloud | mixed
  const [srcOpen, setSrcOpen] = useState(false);
  const [apiBase, setApiBase] = useState(() => getEcosystemApiBase());

  // 关键词/分类/页签变化时回到第 1 页（避免停留在超出范围的页码）
  useEffect(() => { setPage(1); setExpandedId(null); }, [tab, keyword, category]);

  // 磁盘技能清单（用于技能「已下载」判定）
  async function refreshInstalledSkills() {
    const api = bridge();
    if (!api?.listSkills) return;
    try {
      const r = await api.listSkills();
      if (r?.ok) setInstalledSkillIds(new Set((r.skills || []).flatMap((d) => [d.dir, d.name].filter(Boolean))));
    } catch (e) { console.warn('[ecosystem] 磁盘技能加载失败:', e); }
  }

  async function loadAll() {
    // ① 本地 ecosystem 资产兜底加载（ecosystem:* IPC）
    const api = bridge();
    if (!api) {
      setError('主进程桥接未就绪');
    } else {
      try {
        const [emp, con, sk, sum] = await Promise.all([
          api.ecosystemEmployees({}),
          api.ecosystemConnectors({}),
          api.ecosystemSkills(),
          api.ecosystemSummary(),
        ]);
        if (emp && emp.ok) setEmployees(emp.employees || []); else setError((emp && emp.error) || '数字员工加载失败');
        if (con && con.ok) setConnectors(con.connectors || []); else setError((con && con.error) || '连接器加载失败');
        if (sk && sk.ok) setSkills(sk.skills || []); else setError((sk && sk.error) || '技能加载失败');
        if (sum && sum.ok) setStats(sum.stats);
      } catch (e) {
        setError(e.message || '生态数据加载失败');
      }
    }

    // ② 云端接口覆盖（用户自有后端）：命中的字段覆盖本地，全部未命中回退纯本地
    let cloudHit = 0;
    const remote = await fetchEcosystemRemote();
    if (remote) {
      if (remote.employees) { setEmployees(remote.employees); cloudHit += 1; }
      if (remote.connectors) { setConnectors(remote.connectors); cloudHit += 1; }
      if (remote.skills) { setSkills(remote.skills); cloudHit += 1; }
      if (remote.stats) { setStats(remote.stats); cloudHit += 1; }
      // 云端命中后，本地资产加载阶段的错误不再阻塞展示
      if (cloudHit > 0) setError('');
    }
    setSource(cloudHit === 4 ? 'cloud' : cloudHit > 0 ? 'mixed' : 'local');

    refreshInstalledSkills();
  }

  // 刻意「挂载时加载一次」：loadAll 内部读 keyword/type 等筛选 state，列入依赖会让
  // 每次输入都重新拉全量生态资产（100 技能 + 100 连接器），筛选应由本地 filtered
  // 计算完成。安装/下载后的刷新由各 handler 显式调用 loadAll()/refreshInstalledSkills()。
  useEffect(() => { loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 下载动作（目录页唯一入口；下载后在会话「+」菜单中选择） ──

  function handleDownloadEmployee(e) {
    downloadEmployee(e);
    setDlVer((v) => v + 1);
    setNotice(`已下载「${e.title_cn || e.name}」到本机。在会话输入框点「+」→ 数字员工 中选择使用。`);
  }

  function handleDownloadConnector(c) {
    downloadConnector(c);
    setDlVer((v) => v + 1);
    // 必填环境变量必须在使用前如实告知：否则用户连上后每个工具调用都报
    // 「missing API key」，表现为「装好了但完全不能用」——这是「能力已建」与
    // 「开箱可用」之间最典型的一道沟（2026-10-15 审查项）
    const required = (Array.isArray(c.env_vars) ? c.env_vars : []).filter((v) => v && v.required);
    const envHint = required.length
      ? `连接前需在 设置 → MCP 服务 中配置环境变量：${required.map((v) => v.name).join('、')}（点击连接器卡片可查看说明与申请入口）。`
      : '无需额外密钥，在 设置 → MCP 服务 中即可连接。';
    setNotice(`已下载「${c.display_name || c.name}」到本机。${envHint}`);
  }

  async function handleDownloadSkill(s) {
    setBusyId(s.id);
    try {
      await window.mjcode.installEcosystemSkill({ id: s.id });
      await refreshInstalledSkills();
      setDlVer((v) => v + 1);
      setNotice(`已下载技能「${s.display_name || s.name}」到本机。在会话输入框点「+」→ 技能 中启用。`);
    } catch (err) {
      setError(`技能下载失败：${err.message || '未知错误'}`);
    }
    setBusyId('');
  }

  const match = (text) => String(text || '').toLowerCase().includes(keyword.trim().toLowerCase());

  const empFiltered = employees.filter((e) =>
    (!category || e.category === category) &&
    (!keyword || match(e.title_cn) || match(e.name) || match(e.category) || (e.industry || []).some(match))
  );
  const conFiltered = connectors.filter((c) =>
    (!category || c.category === category) &&
    (!keyword || match(c.name) || match(c.display_name) || match(c.vendor) || match(c.category))
  );
  const skFiltered = skills.filter((s) =>
    (!keyword || match(s.display_name) || match(s.name) || match(s.category))
  );

  const empCategories = [...new Set(employees.map((e) => e.category).filter(Boolean))];
  const conCategories = [...new Set(connectors.map((c) => c.category).filter(Boolean))];

  // E1：当前页切片 + 分页信息（按当前 tab 取对应列表）
  const activeList = tab === 'employees' ? empFiltered : tab === 'connectors' ? conFiltered : skFiltered;
  const totalPages = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pageItems = activeList.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const content = (
    <div className={embedded ? 'bg-surface border border-border rounded-2xl flex flex-col max-h-[72vh]' : 'w-full max-w-4xl max-h-[85vh] rounded-2xl bg-bg border border-border flex flex-col overflow-hidden'}>
        {/* 顶栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-base font-semibold">生态中心</h2>
              <p className="text-xs text-text2 mt-0.5">
                数字员工、连接器与技能目录，下载到本机后使用
                {stats && `（${stats.employees || 0} 员工 / ${stats.connectors || 0} 连接器 / ${stats.skills || 0} 技能）`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* 数据源胶囊：云端接口 / 本地资产，点击配置接口地址 */}
            <div className="relative">
              <button onClick={() => setSrcOpen((v) => !v)}
                className={`h-7 inline-flex items-center gap-1 text-xs px-2.5 rounded-full border shrink-0 ${source === 'local' ? 'border-border text-text2 hover:text-text' : 'border-accent text-accent'}`}>
                <IconGlobe size={12} />
                {source === 'cloud' ? '云端' : source === 'mixed' ? '云端+本地' : '本地'}
              </button>
              {srcOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSrcOpen(false)} />
                  <div className="absolute right-0 top-8 z-20 w-72 p-3 rounded-xl bg-surface border border-border shadow-[var(--shadow-pop)]">
                    <div className="text-xs font-medium mb-1">生态数据源</div>
                    <p className="text-[11px] text-text2 leading-relaxed mb-2">
                      填入你的后端地址后，员工/连接器/技能/统计将优先从云端拉取（可随时在服务端更新），未配置或不可达时回退本地资产。
                    </p>
                    <input
                      value={apiBase}
                      onChange={(e) => setApiBase(e.target.value)}
                      placeholder="https://api.example.com"
                      className="w-full h-8 px-2.5 rounded-lg border border-border bg-bg text-xs outline-none focus:border-accent"
                    />
                    <div className="flex items-center justify-between mt-2">
                      <button onClick={() => { setEcosystemApiBase(''); setApiBase(''); loadAll(); }}
                        className="text-xs text-text2 hover:text-text">清除</button>
                      <button onClick={() => { setEcosystemApiBase(apiBase); loadAll(); }}
                        className="h-7 inline-flex items-center justify-center px-3 rounded-lg bg-accent text-white text-xs hover:opacity-90">保存并重新加载</button>
                    </div>
                  </div>
                </>
              )}
            </div>
            {!embedded && (
              <button onClick={onClose} className="text-text2 hover:text-text"><IconX size={16} /></button>
            )}
          </div>
        </div>

        {/* 分页签 */}
        <div className="flex items-center gap-1 px-5 pt-3">
          {[
            { id: 'employees', label: '数字员工', icon: <IconUser size={14} /> },
            { id: 'connectors', label: '连接器', icon: <IconPlug size={14} /> },
            { id: 'skills', label: '技能', icon: <IconPuzzle size={14} /> },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setCategory(''); }}
              className={`h-9 inline-flex items-center gap-1.5 px-3.5 rounded-t-lg text-sm ${tab === t.id ? 'bg-surface text-text border border-border border-b-transparent' : 'text-text2 hover:text-text'}`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* 搜索 + 分类 */}
        <div className="px-5 py-3 border-b border-border flex items-center gap-2">
          <div className="flex-1 h-8 flex items-center gap-2 px-3 rounded-lg border border-border">
            <IconSearch size={14} className="text-text2" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={tab === 'employees' ? '搜索岗位、行业、技能' : tab === 'connectors' ? '搜索连接器、厂商' : '搜索技能'}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <button onClick={loadAll} className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-border hover:bg-hover"><IconRefresh size={13} /></button>
        </div>

        {/* 分类筛选 */}
        {(tab === 'employees' || tab === 'connectors') && (
          <div className="px-5 py-2.5 border-b border-border flex flex-nowrap gap-1.5 overflow-x-auto">
            <button
              onClick={() => setCategory('')}
              className={`h-8 inline-flex items-center text-xs px-3 rounded-full border shrink-0 whitespace-nowrap ${!category ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}
            >
              全部
            </button>
            {(tab === 'employees' ? empCategories : conCategories).map((c) => (
              <button
                key={c}
                onClick={() => setCategory(category === c ? '' : c)}
                className={`h-8 inline-flex items-center text-xs px-3 rounded-full border shrink-0 whitespace-nowrap ${category === c ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {error && (
            <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-[var(--sem-danger-bg)] border border-danger text-xs text-danger">
              <IconAlert size={14} className="mt-0.5 shrink-0" />{error}
            </div>
          )}
          {notice && (
            <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-accent-bg border border-accent text-xs text-accent">
              <IconAlert size={14} className="mt-0.5 shrink-0" />{notice}
            </div>
          )}

          {/* 数字员工 */}
          {tab === 'employees' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {pageItems.map((e) => (
                <div key={e.id} className="p-3 rounded-xl bg-surface border border-border flex flex-col">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{e.title_cn || e.name}</div>
                      <div className="text-xs text-text2 mt-0.5">{e.category} · {e.mission || '待补充使命'}</div>
                    </div>
                    <span className="shrink-0 ml-2 text-[10px] px-1.5 py-[3px] leading-none rounded bg-accent/15 text-accent">
                      {APPROVAL_LABELS[e.approval_policy] || e.approval_policy}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(e.industry || []).map((ind) => (
                      <span key={ind} className="text-[10px] px-1.5 py-[3px] leading-none rounded bg-hover text-text2">{ind}</span>
                    ))}
                  </div>
                  {/* C2：详情展开 */}
                  {expandedId === `emp-${e.id}` && (
                    <div className="mt-2 pt-2 border-t border-border text-[11px] text-text2 leading-relaxed">
                      <p><span className="text-text">使命：</span>{e.mission || '待补充'}</p>
                      {e.market_signal && <p className="mt-1"><span className="text-text">市场信号：</span>{e.market_signal}</p>}
                      <p className="mt-1"><span className="text-text">审批策略：</span>{APPROVAL_LABELS[e.approval_policy] || e.approval_policy || '按需审批'}</p>
                      {(e.skills || []).length > 0 && <p className="mt-1"><span className="text-text">技能：</span>{e.skills.join('、')}</p>}
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-auto pt-3">
                    <button onClick={() => setExpandedId(expandedId === `emp-${e.id}` ? null : `emp-${e.id}`)}
                      className="h-8 inline-flex items-center justify-center text-xs px-3 rounded-lg border border-border hover:bg-hover text-text2">
                      {expandedId === `emp-${e.id}` ? '收起' : '查看详情'}
                    </button>
                    {isEmployeeDownloaded(e.id) ? (
                      <span className="h-8 inline-flex items-center justify-center gap-1 text-xs px-3 rounded-lg bg-success-bg text-success">
                        <IconCheck size={13} /> 已下载
                      </span>
                    ) : (
                      <button onClick={() => handleDownloadEmployee(e)}
                        className="h-8 inline-flex items-center justify-center gap-1 text-xs px-3 rounded-lg bg-accent text-white hover:opacity-90">
                        <IconDownload size={13} /> 下载
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {empFiltered.length === 0 && !error && (
                <p className="col-span-full text-center text-text2 text-sm py-8">暂无匹配的数字员工</p>
              )}
            </div>
          )}

          {/* 连接器 */}
          {tab === 'connectors' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {pageItems.map((c) => (
                <div key={c.id} className="p-3 rounded-xl bg-surface border border-border flex flex-col">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate flex items-center gap-1.5">
                        {c.display_name || c.name}
                        {c.official && <span className="text-[9px] px-1 py-[2px] leading-none rounded bg-[var(--sem-success-bg)] text-success shrink-0">官方</span>}
                      </div>
                      <div className="text-xs text-text2 mt-0.5">{c.vendor} · {c.category}</div>
                    </div>
                  </div>
                  <div className="text-[11px] text-text2 mt-1.5">{c.description}</div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(c.permissions || []).map((p, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-[3px] leading-none rounded bg-[var(--sem-warn-bg)] text-warn">
                        {PERMISSION_LABELS[p.level] || p.level}{p.scope && p.scope !== '*' ? `：${p.scope}` : ''}
                      </span>
                    ))}
                    {(c.permissions || []).length === 0 && (
                      <span className="text-[10px] px-1.5 py-[3px] leading-none rounded bg-hover text-text2">无额外权限</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-auto pt-3">
                    {isConnectorDownloaded(c.id) ? (
                      <span className="h-8 inline-flex items-center justify-center gap-1 text-xs px-3 rounded-lg bg-success-bg text-success">
                        <IconCheck size={13} /> 已下载
                      </span>
                    ) : (
                      <button onClick={() => handleDownloadConnector(c)}
                        className="h-8 inline-flex items-center justify-center gap-1 text-xs px-3 rounded-lg bg-accent text-white hover:opacity-90">
                        <IconDownload size={13} /> 下载
                      </button>
                    )}
                    <span className="text-[10px] text-text2">下载后在「+」→ 连接器 中查看</span>
                  </div>
                </div>
              ))}
              {conFiltered.length === 0 && !error && (
                <p className="col-span-full text-center text-text2 text-sm py-8">暂无匹配的连接器</p>
              )}
            </div>
          )}

          {/* 技能 */}
          {tab === 'skills' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {pageItems.map((s) => {
                // dlVer 参与判定读取以保持按钮态与下载动作同步刷新
                const installed = dlVer >= 0 && (installedSkillIds.has(s.id) || installedSkillIds.has(s.name));
                return (
                  <div key={s.id} className="p-3 rounded-xl bg-surface border border-border flex flex-col">
                    <div className="text-sm font-medium truncate">{s.display_name || s.name}</div>
                    <div className="text-xs text-text2 mt-0.5">{s.category}</div>
                    <div className="text-[11px] text-text2 mt-1.5 leading-relaxed">{s.description}</div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(s.tools_required || []).map((t) => (
                        <span key={t} className="text-[10px] px-1.5 py-[3px] leading-none rounded bg-hover text-text2">{t}</span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-auto pt-3">
                      {installed ? (
                        <span className="h-8 inline-flex items-center justify-center gap-1 text-xs px-3 rounded-lg bg-success-bg text-success">
                          <IconCheck size={13} /> 已下载
                        </span>
                      ) : (
                        <button onClick={() => handleDownloadSkill(s)} disabled={busyId === s.id}
                          className="h-8 inline-flex items-center justify-center gap-1 text-xs px-3 rounded-lg bg-accent text-white hover:opacity-90 disabled:opacity-50">
                          <IconDownload size={13} /> {busyId === s.id ? '下载中…' : '下载'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {skFiltered.length === 0 && !error && (
                <p className="col-span-full text-center text-text2 text-sm py-8">暂无匹配的技能</p>
              )}
            </div>
          )}

          {/* E1：分页器（列表超 PAGE_SIZE 时出现） */}
          {activeList.length > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-3 pt-4 text-xs text-text2">
              <button onClick={() => setPage(curPage - 1)} disabled={curPage <= 1}
                className="h-8 inline-flex items-center justify-center px-3 rounded-lg border border-border hover:bg-hover disabled:opacity-40">上一页</button>
              <span>第 {curPage} / {totalPages} 页 · 共 {activeList.length} 条</span>
              <button onClick={() => setPage(curPage + 1)} disabled={curPage >= totalPages}
                className="h-8 inline-flex items-center justify-center px-3 rounded-lg border border-border hover:bg-hover disabled:opacity-40">下一页</button>
            </div>
          )}
        </div>
    </div>
  );

  // ST3：内嵌模式只渲染内容区，由宿主（设置页）提供滚动容器
  if (embedded) return content;
  return (
    <div className="fixed inset-0 z-settings flex items-center justify-center bg-overlay">
      {content}
    </div>
  );
}
