import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconBot, IconBranch, IconChevronRight, IconCheck, IconFile, IconFilePlus, IconMessage, IconMic,
  IconPlug, IconSearch, IconUser, IconX, IconZap,
} from './icons';
import { listDownloadedEmployees, listDownloadedConnectors } from '../lib/ecosystemLocal';

// A4：Composer "+" 扩展菜单（报告第 6 节完整交互规格）
// 一级：添加文件 / 从会话中引用 / 模式 / 数字员工 / 技能 / 连接器 / 语音输入
// 二级面板 C/D/E 对应数字员工 / 技能 / 连接器，动作写入会话级 sessionExtras（随线程持久化）
// 下载模型：此处只展示「已下载到本机」或「内置」的资产——
//   数字员工 = 本地下载清单（lib/ecosystemLocal）；技能 = 磁盘已安装（listSkills）；
//   连接器 = 内置预设（MCP_PRESETS）+ 已下载清单。目录浏览与下载统一在侧栏「生态中心」。
const MCP_PRESETS = [
  { name: 'playwright', label: 'Playwright 浏览器自动化', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  { name: 'fetch', label: '网页抓取 Fetch', command: 'npx', args: ['-y', 'mcp-server-fetch'] },
  { name: 'filesystem', label: '扩展文件系统', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
];

// 职业图标映射（禁止 emoji；生态未覆盖时回落 IconUser）
const ROLE_ICONS = [
  ['开发', IconBranch], ['设计', IconPaletteSafe], ['数据', IconChartSafe], ['运营', IconUser], ['产品', IconUser],
];
function IconPaletteSafe(props) { return <IconZap {...props} />; }
function IconChartSafe(props) { return <IconMessage {...props} />; }
function roleIcon(category) {
  const hit = ROLE_ICONS.find(([k]) => String(category || '').includes(k));
  return hit ? hit[1] : IconUser;
}

export default function PlusMenu({
  open, onClose, onPickFiles, messages = [], runMode, onModeChange, hasProject,
  extras, onExtrasChange, onVoiceStart, connectedServers = [],
}) {
  const [panel, setPanel] = useState(null); // null | refs | mode | experts | skills | connectors
  const [downloadedEmployees, setDownloadedEmployees] = useState([]); // 已下载数字员工（本地清单）
  const [downloadedConnectors, setDownloadedConnectors] = useState([]); // 已下载连接器（本地清单）
  const [skills, setSkills] = useState([]);      // 磁盘已安装技能（含生态下载物化结果）
  const [keyword, setKeyword] = useState('');
  const [connectErr, setConnectErr] = useState('');
  const rootRef = useRef(null);

  // 打开时加载本机资产（并行、各自容错）
  useEffect(() => {
    if (!open) { setPanel(null); setKeyword(''); setConnectErr(''); return; }
    // 本地下载清单（员工/连接器）同步读取
    setDownloadedEmployees(listDownloadedEmployees());
    setDownloadedConnectors(listDownloadedConnectors());
    (async () => {
      try {
        const r = await window.mjcode?.listSkills?.();
        if (r?.ok) setSkills(r.skills || []);
      } catch (e) { /* ignore */ }
    })();
  }, [open]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) onClose?.(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    // 非模态 popover 用捕获阶段监听，避免与 Composer 的 Esc 处理冲突
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  // 二级面板 A：会话中出现过的文件（tool_calls 参数路径 + 用户 @ 引用）
  const referencedFiles = useMemo(() => {
    const found = new Set();
    for (const m of messages) {
      if (m.role === 'user') {
        for (const match of String(m.content || '').matchAll(/@([^\s@]+\.[^\s@]+)/g)) found.add(match[1]);
      }
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of calls) {
        try {
          const args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || tc.args || {});
          if (args.path) found.add(String(args.path));
        } catch (e) { /* ignore */ }
      }
    }
    return [...found].slice(0, 30);
  }, [messages]);

  if (!open) return null;

  const kw = keyword.trim().toLowerCase();
  const matchText = (...texts) => !kw || texts.some((t) => String(t || '').toLowerCase().includes(kw));

  function insertRef(p) {
    window.dispatchEvent(new CustomEvent('mjcode:insert-path', { detail: p }));
    onClose?.();
  }

  function toggleSkill(id) {
    const cur = extras?.skillIds || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onExtrasChange?.({ ...extras, skillIds: next });
  }

  async function connectServer(payload) {
    setConnectErr('');
    try {
      const r = await window.mjcode.mcpConnect(payload);
      if (r?.ok) {
        const cur = extras?.mcpServers || [];
        if (!cur.includes(payload.name)) onExtrasChange?.({ ...extras, mcpServers: [...cur, payload.name] });
      } else {
        setConnectErr(r?.error || '连接失败');
      }
    } catch (err) {
      setConnectErr(err.message);
    }
  }

  const expert = extras?.expert || null;

  return (
    <div
      ref={rootRef}
      className="absolute left-0 bottom-full mb-2 w-[290px] bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] overflow-hidden z-palette"
      role="menu"
    >
      {!panel && (
        <div className="py-1.5">
          <MenuRow Icon={IconFilePlus} label="添加文件…" onClick={() => { onPickFiles?.(); onClose?.(); }} />
          <MenuRow Icon={IconMessage} label="从会话中引用" hasSub disabled={!hasProject}
            disabledReason="未打开项目，无法引用文件" onClick={() => setPanel('refs')} />
          <div className="my-1.5 border-t border-border" />
          <MenuRow Icon={IconBranch} label="模式" hasSub disabled={!hasProject}
            disabledReason="未打开项目，无法切换运行模式" onClick={() => setPanel('mode')} />
          <MenuRow Icon={IconBot} label="数字员工" hasSub badge={expert ? expert.title_cn || expert.name : null}
            onClick={() => setPanel('experts')} />
          <MenuRow Icon={IconZap} label="技能" hasSub
            badge={extras?.skillIds?.length ? `${extras.skillIds.length} 项` : null}
            onClick={() => setPanel('skills')} />
          <MenuRow Icon={IconPlug} label="连接器" hasSub
            badge={extras?.mcpServers?.length ? `${extras.mcpServers.length} 个` : null}
            onClick={() => setPanel('connectors')} />
          <div className="my-1.5 border-t border-border" />
          <MenuRow Icon={IconMic} label="语音输入" hint="Ctrl+M" onClick={() => { onVoiceStart?.(); onClose?.(); }} />
        </div>
      )}

      {panel === 'refs' && (
        <SubPanel title="从会话中引用" onBack={() => setPanel(null)}>
          {referencedFiles.length === 0 ? (
            <p className="text-text2 text-xs px-3 py-4">本会话尚无文件记录</p>
          ) : referencedFiles.filter((p) => matchText(p)).map((p) => (
            <button key={p} onClick={() => insertRef(p)} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-hover">
              <IconFile size={14} className="text-text2 shrink-0" />
              <span className="text-xs font-mono truncate">{p}</span>
            </button>
          ))}
        </SubPanel>
      )}

      {panel === 'mode' && (
        <SubPanel title="模式" onBack={() => setPanel(null)}>
          {[{ value: 'local', label: '本地模式', hint: '直接在项目目录修改' },
            { value: 'worktree', label: '隔离工作区', hint: '在 Git worktree 副本中修改，不影响主目录' }].map((o) => (
            <button key={o.value} onClick={() => { onModeChange?.(o.value); onClose?.(); }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-hover">
              <span className="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center"
                style={{ borderColor: runMode === o.value ? 'var(--theme-accent)' : 'var(--theme-border)' }}>
                {runMode === o.value && <span className="w-2 h-2 rounded-full bg-accent" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs">{o.label}</span>
                <span className="block text-[10px] text-text2 mt-0.5">{o.hint}</span>
              </span>
            </button>
          ))}
          <p className="text-[10px] text-text2 px-3 py-2 border-t border-border">沙箱与审批档位在输入框下方胶囊中调整</p>
        </SubPanel>
      )}

      {panel === 'experts' && (
        <SubPanel title="数字员工" onBack={() => setPanel(null)} keyword={keyword} setKeyword={setKeyword} searchPlaceholder="搜索岗位、行业">
          {expert && (
            <div className="mx-2 my-1.5 rounded-lg bg-accent-bg border border-accent/40 px-3 py-2 flex items-center gap-2">
              <IconBot size={14} className="text-accent shrink-0" />
              <span className="text-xs flex-1 truncate">当前：{expert.title_cn || expert.name}</span>
              <button onClick={() => onExtrasChange?.({ ...extras, expert: null })} className="text-text2 hover:text-text shrink-0" aria-label="停用数字员工">
                <IconX size={12} />
              </button>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {downloadedEmployees.filter((e) => matchText(e.title_cn, e.name, e.category, ...(e.industry || []))).slice(0, 30).map((e) => {
              const RoleIcon = roleIcon(e.category);
              return (
                <button key={e.id} onClick={() => { onExtrasChange?.({ ...extras, expert: e }); onClose?.(); }}
                  className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-hover border-b border-border last:border-0">
                  <span className="w-8 h-8 rounded-lg bg-accent-bg text-accent flex items-center justify-center shrink-0">
                    <RoleIcon size={15} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium truncate">{e.title_cn || e.name}</span>
                    <span className="block text-[10px] text-text2 truncate mt-0.5">{e.mission || e.category}</span>
                    <span className="block text-[10px] text-text2 mt-1">
                      {e.approval_policy === 'trusted' || e.approval_policy === 'always' ? '完全信任' : e.approval_policy === 'safe-auto' || e.approval_policy === 'auto-safe' ? '安全自动' : '按需审批'}
                    </span>
                  </span>
                </button>
              );
            })}
            {downloadedEmployees.length === 0 && (
              <p className="text-text2 text-xs px-3 py-4 leading-relaxed">
                尚未下载数字员工。前往侧栏「生态中心」浏览并下载，下载后在此选择。
              </p>
            )}
          </div>
        </SubPanel>
      )}

      {panel === 'skills' && (
        <SubPanel title="技能" onBack={() => setPanel(null)} keyword={keyword} setKeyword={setKeyword} searchPlaceholder="搜索技能">
          <div className="max-h-64 overflow-y-auto">
            {skills.filter((s) => matchText(s.name, s.description)).map((s) => {
              const on = extras?.skillIds?.includes(s.dir);
              return (
                <button key={s.dir} onClick={() => toggleSkill(s.dir)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-hover border-b border-border last:border-0">
                  <IconZap size={13} className={on ? 'text-accent shrink-0' : 'text-text2 shrink-0'} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs truncate">{s.name}</span>
                    <span className="block text-[10px] text-text2 truncate">{s.description || '（无描述）'}</span>
                  </span>
                  {on && <IconCheck size={13} className="text-accent shrink-0" />}
                </button>
              );
            })}
            {skills.length === 0 && (
              <p className="text-text2 text-xs px-3 py-4 leading-relaxed">
                尚未安装技能。前往侧栏「生态中心」下载，或在本机 ~/.mjcode/skills 放置 SKILL.md。
              </p>
            )}
            <p className="text-[10px] text-text2 px-3 py-2">添加到当前会话为临时启用，不改变设置页的全局开关</p>
          </div>
        </SubPanel>
      )}

      {panel === 'connectors' && (
        <SubPanel title="连接器" onBack={() => setPanel(null)} keyword={keyword} setKeyword={setKeyword} searchPlaceholder="搜索连接器">
          {connectErr && <p className="text-danger text-xs px-3 py-2">{connectErr}</p>}
          <div className="max-h-64 overflow-y-auto">
            {/* 内置预设：无需下载，点击即连接 */}
            {MCP_PRESETS.filter((c) => matchText(c.label, c.name)).map((c) => {
              const connected = connectedServers.includes(c.name);
              const inSession = extras?.mcpServers?.includes(c.name);
              return (
                <button key={c.name} onClick={() => connectServer(c)} disabled={connected}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-hover disabled:opacity-60 border-b border-border last:border-0">
                  <IconPlug size={13} className={inSession ? 'text-accent shrink-0' : 'text-text2 shrink-0'} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs truncate">{c.label}</span>
                    <span className="block text-[10px] text-text2 truncate font-mono">{c.command} {c.args.join(' ')}</span>
                  </span>
                  {inSession ? <IconCheck size={13} className="text-accent shrink-0" /> : connected ? <span className="text-[10px] text-success shrink-0">已连接</span> : null}
                </button>
              );
            })}
            {/* 已下载的生态连接器：展示待配置状态（目录数据无启动命令，需在设置中配置后连接） */}
            {downloadedConnectors.filter((c) => matchText(c.display_name, c.name, c.vendor)).map((c) => (
              <div key={c.id} className="w-full flex items-center gap-2 px-3 py-2 border-b border-border last:border-0">
                <IconPlug size={13} className="text-text2 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs truncate">{c.display_name || c.name}</span>
                  <span className="block text-[10px] text-text2 truncate">{c.vendor || c.category || '已下载'}</span>
                </span>
                <span className="text-[10px] text-text2 shrink-0" title="在 设置 → MCP 服务 中完成配置后即可连接">已下载 · 待配置</span>
              </div>
            ))}
            <p className="text-[10px] text-text2 px-3 py-2">更多连接器在侧栏「生态中心」下载；自定义服务在 设置 → MCP 服务 中配置</p>
          </div>
        </SubPanel>
      )}
    </div>
  );
}

function MenuRow({ Icon, label, hasSub, badge, hint, disabled, disabledReason, onClick }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className="w-full flex items-center gap-2.5 px-3 h-9 text-left hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
      role="menuitem"
    >
      <Icon size={15} className="text-text2 shrink-0" />
      <span className="text-[13px] flex-1 truncate">{label}</span>
      {badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-bg text-accent shrink-0">{badge}</span>}
      {hint && <span className="text-[10px] text-text2 shrink-0">{hint}</span>}
      {hasSub && !disabled && <IconChevronRight size={12} className="text-text2 shrink-0" />}
    </button>
  );
}

function SubPanel({ title, onBack, keyword, setKeyword, searchPlaceholder, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border">
        <button onClick={onBack} className="text-text2 hover:text-text shrink-0" aria-label="返回">
          <IconChevronRight size={13} className="rotate-180" />
        </button>
        <span className="text-xs font-medium flex-1 truncate">{title}</span>
      </div>
      {setKeyword && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <IconSearch size={13} className="text-text2 shrink-0" />
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-xs outline-none" />
        </div>
      )}
      {children}
    </div>
  );
}
