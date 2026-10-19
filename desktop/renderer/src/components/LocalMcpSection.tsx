// 生态中心「本机服务」区（统一入口重构 T2；T3 删设置页 McpTab 后此为唯一入口）
// 承接原 SettingsModal McpTab 核心能力：已连接/已保存服务器列表（断开·重连）、
// 手动添加表单（stdio/http）、JSON 原始编辑（开发者通道，经 mcp:setConfig 整体覆盖
// 持久化配置并重连）。市场预设入口不迁移——生态中心目录本身即市场。
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useMcpStatus, type McpServerState } from '../hooks/useMcpStatus';
import Switch from './ui/Switch';
import Button from './ui/Button';
import Dot from './ui/Dot';
import {
  IconAlert, IconCheck, IconChevronDown, IconEdit, IconPlus,
  IconRefresh, IconX,
} from './icons';

interface ServerRow {
  name: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  toolCount?: number;
  // 期 2：三层治理档位（auto-start / whitelist / manual），由主进程落盘时打入
  tier?: string;
}

// 期 2：治理配置（档位 profile / 文件能力 fsMode / 沙盒网络开关）
interface Governance {
  profile: 'normal' | 'developer';
  fsMode: 'read-only' | 'read-write';
  sandboxNetwork: boolean;
}

interface Props {
  // 外部（配置弹窗连接成功）触发刷新
  refreshSignal?: number;
}

// 五态：ok / fail / connecting / saved 由「列表 + 本地操作」派生，
// crashed 只来自主进程广播的 mcp_status（P0-5④ 新建的消费链路）
type ConnState = McpServerState;

// 期 2：档位徽章样式（性冷淡风——auto-start/whitelist 中性色，manual 用 danger 提示高危）
const TIER_CLASS: Record<string, string> = {
  'auto-start': 'border-border text-text2',
  whitelist: 'border-border text-text2',
  manual: 'border-danger text-danger',
};
// 期 2：档位 → i18n key 后缀
const TIER_KEY: Record<string, string> = {
  'auto-start': 'tierAutoStart',
  whitelist: 'tierWhitelist',
  manual: 'tierManual',
};
// 期 2：开发者档额外自动启动的 git 服务名（与主进程 DEVELOPER_AUTO_START_NAMES 对齐）
const GIT_NAMES = new Set(['git', 'git-mcp']);

export default function LocalMcpSection({ refreshSignal }: Props) {
  const { t } = useI18n();
  const mcpStatus = useMcpStatus();
  const [open, setOpen] = useState(true);
  const [connected, setConnected] = useState<ServerRow[]>([]);
  const [saved, setSaved] = useState<ServerRow[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const [reconnectMsg, setReconnectMsg] = useState<Record<string, string>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonMsg, setJsonMsg] = useState('');
  const [form, setForm] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '' });
  // 期 2：治理配置（默认最保守档：normal / 读写 / 沙盒禁网）
  const [profile, setProfile] = useState<'normal' | 'developer'>('normal');
  // 期 3：能力降级开关（文件能力 fsMode / 沙盒网络开关）
  const [fsMode, setFsMode] = useState<'read-only' | 'read-write'>('read-write');
  const [sandboxNetwork, setSandboxNetwork] = useState(false);
  const [govMsg, setGovMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const list = (await window.mjcode?.mcpListServers?.()) as ServerRow[] | undefined;
      setConnected(Array.isArray(list) ? list : []);
    } catch (e) { console.warn('[local-mcp] listServers failed:', e); }
    try {
      const cfg = (await window.mjcode?.mcpGetConfig?.()) as { ok?: boolean; servers?: ServerRow[]; governance?: Governance } | undefined;
      if (cfg?.ok) {
        setSaved(cfg.servers || []);
        if (cfg.governance?.profile) setProfile(cfg.governance.profile);
        // 期 3：同步读取能力降级开关（缺省回最保守档，与 readGovernance 归一化一致）
        if (cfg.governance?.fsMode) setFsMode(cfg.governance.fsMode);
        setSandboxNetwork(cfg.governance?.sandboxNetwork === true);
      }
    } catch (e) { console.warn('[local-mcp] getConfig failed:', e); }
  }, []);

  useEffect(() => { load(); }, [load, refreshSignal]);

  // 期 2：切换治理档位并持久化。developer 档额外把 git 类纳入自动启动——
  // 切换后立即对「已保存但未连接」的 git 服务发起重连（复用 mcp:reconnect 的幂等语义），
  // 使档位变更即时生效，而非仅等下次启动。
  async function applyProfile(next: 'normal' | 'developer') {
    setProfile(next);
    setGovMsg('');
    try {
      const r = (await window.mjcode?.mcpGovernanceSet?.({ profile: next })) as
        { ok?: boolean; governance?: Governance; error?: string } | undefined;
      if (!r?.ok) { setGovMsg(r?.error || t('localMcp.govFailed')); return; }
      if (r.governance?.profile) setProfile(r.governance.profile);
      if (next === 'developer') {
        const connectedNames = new Set(connected.map((c) => c.name));
        for (const s of saved) {
          if (GIT_NAMES.has(s.name) && !connectedNames.has(s.name)) {
            setStatusMap((m) => ({ ...m, [s.name]: 'connecting' }));
            const rc = (await window.mjcode?.mcpReconnect?.({ name: s.name })) as { ok?: boolean } | undefined;
            setStatusMap((m) => ({ ...m, [s.name]: rc?.ok ? 'ok' : 'fail' }));
          }
        }
        window.dispatchEvent(new CustomEvent('mjcode:mcp-tools-dirty'));
      }
      await load();
    } catch (e) {
      setGovMsg(e instanceof Error ? e.message : String(e));
    }
  }

  // 期 3：能力降级开关切换（文件能力 fsMode / 沙盒网络 sandboxNetwork）。
  // 与档位 profile 共用 mcp:governance/set（部分更新语义，未提供字段保持原值）。
  // 二者只改变既有工具的运行期行为，不改变工具集，故无需 mjcode:mcp-tools-dirty。
  async function applyGovernance(partial: Partial<Pick<Governance, 'fsMode' | 'sandboxNetwork'>>) {
    setGovMsg('');
    // 乐观更新：先落 UI，失败则由回包/load 纠正
    if (partial.fsMode !== undefined) setFsMode(partial.fsMode);
    if (partial.sandboxNetwork !== undefined) setSandboxNetwork(partial.sandboxNetwork);
    try {
      const r = (await window.mjcode?.mcpGovernanceSet?.(partial)) as
        { ok?: boolean; governance?: Governance; error?: string } | undefined;
      if (!r?.ok) {
        setGovMsg(r?.error || t('localMcp.govFailed'));
        await load();
        return;
      }
      if (r.governance?.fsMode) setFsMode(r.governance.fsMode);
      setSandboxNetwork(r.governance?.sandboxNetwork === true);
    } catch (e) {
      setGovMsg(e instanceof Error ? e.message : String(e));
      await load();
    }
  }

  async function connect(s: ServerRow) {
    setStatusMap((m) => ({ ...m, [s.name]: 'connecting' }));
    try {
      const r = (await window.mjcode?.mcpConnect?.({
        name: s.name,
        transport: s.transport === 'http' ? 'http' : 'stdio',
        command: s.command, args: s.args || [], url: s.url,
      })) as { ok?: boolean } | undefined;
      setStatusMap((m) => ({ ...m, [s.name]: r?.ok ? 'ok' : 'fail' }));
      if (r?.ok) window.dispatchEvent(new CustomEvent('mjcode:mcp-tools-dirty'));
    } catch (e) {
      setStatusMap((m) => ({ ...m, [s.name]: 'fail' }));
    }
    await load();
  }

  async function disconnect(name: string) {
    await window.mjcode?.mcpDisconnect?.({ name });
    setStatusMap((m) => ({ ...m, [name]: 'saved' }));
    window.dispatchEvent(new CustomEvent('mjcode:mcp-tools-dirty'));
    await load();
  }

  // 崩溃态重连（P0-5④）：调既有 mcp:reconnect（env 由主进程从磁盘读，不经渲染层）。
  // 成功才撤下崩溃标记——失败时保持红色，否则「点了没反应」比不显示更糟。
  async function reconnect(name: string) {
    setReconnectMsg((m) => ({ ...m, [name]: '' }));
    setStatusMap((m) => ({ ...m, [name]: 'connecting' }));
    try {
      const r = (await window.mjcode?.mcpReconnect?.({ name })) as
        { ok?: boolean; error?: string } | undefined;
      if (r?.ok) {
        mcpStatus.clearCrashed(name);
        setStatusMap((m) => ({ ...m, [name]: 'ok' }));
        window.dispatchEvent(new CustomEvent('mjcode:mcp-tools-dirty'));
      } else {
        setStatusMap((m) => ({ ...m, [name]: 'fail' }));
        setReconnectMsg((m) => ({
          ...m,
          [name]: t('settings.mcpReconnectFailed', { error: r?.error || t('localMcp.connFailed') }),
        }));
      }
    } catch (e) {
      setStatusMap((m) => ({ ...m, [name]: 'fail' }));
      setReconnectMsg((m) => ({
        ...m,
        [name]: t('settings.mcpReconnectFailed', { error: e instanceof Error ? e.message : String(e) }),
      }));
    }
    await load();
  }

  // 行合并：持久化配置 ∪ 实时连接态
  const rowMap = new Map<string, ServerRow>();
  for (const s of saved) rowMap.set(s.name, { ...s, toolCount: 0 });
  for (const c of connected) rowMap.set(c.name, { ...(rowMap.get(c.name) || { name: c.name }), toolCount: c.toolCount || 0 });
  const rows = [...rowMap.values()];
  const statusOf = (name: string): ConnState => {
    const st = statusMap[name] || '';
    // connected 只用于推导派生态，**不能提前 return**：它是上一次 load() 的快照，
    // 崩溃后仍含该服务，提前 return 'ok' 会让崩溃标记永远不可见（P0-5④ 失效根因）。
    const derived: Exclude<ConnState, 'crashed'> =
      connected.some((c) => c.name === name) ? 'ok'
        : st === 'fail' ? 'fail' : st === 'connecting' ? 'connecting' : 'saved';
    // 崩溃覆盖：主进程上报过 crashed 且尚未重连成功 → 优先展示崩溃（连接列表可能还没刷新）
    return mcpStatus.resolve(name, derived);
  };

  // JSON 编辑：打开时从持久化配置生成（env 已被主进程剥离，编辑保存会丢 env——
  // 如实提示；带密钥的服务器请用手动添加/目录弹窗连接，JSON 通道管结构与 http url）
  function openJson() {
    setJsonText(JSON.stringify(saved, null, 2));
    setJsonMsg('');
    setJsonOpen(true);
  }
  async function saveJson() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setJsonMsg(t('localMcp.jsonInvalid'));
      return;
    }
    const r = (await window.mjcode?.mcpSetConfig?.({ servers: parsed })) as
      { ok?: boolean; saved?: number; dropped?: number } | undefined;
    if (r?.ok) {
      setJsonMsg(t('localMcp.jsonSaved', { saved: r.saved || 0, dropped: r.dropped || 0 }));
      // setConfig 会整体重连服务器：工具集随之变化，通知 App 重建
      window.dispatchEvent(new CustomEvent('mjcode:mcp-tools-dirty'));
      await load();
    } else {
      setJsonMsg(t('localMcp.jsonFailed'));
    }
  }

  const statusText: Record<ConnState, string> = {
    ok: t('localMcp.connected'),
    fail: t('localMcp.connFailed'),
    connecting: t('localMcp.connecting'),
    saved: t('localMcp.savedNotConnected'),
    crashed: t('settings.mcpCrashed'),
  };

  return (
    <div className="rounded-xl border border-border bg-surface">
      {/* 折叠头 */}
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left">
        <IconChevronDown size={13} className={`text-text2 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-sm font-medium">{t('localMcp.title')}</span>
        <span className="text-xs text-text2">{t('localMcp.count', { n: rows.length })}</span>
        <span className="flex-1" />
        {/* 期 2：治理档位选择器（普通用户 / 开发者）。developer 档额外自启 git 类服务。 */}
        <span className="h-7 inline-flex items-center gap-1 px-2 rounded-lg border border-border shrink-0">
          <span className="text-caption text-text2">{t('localMcp.profileLabel')}</span>
          {(['normal', 'developer'] as const).map((p) => (
            <span key={p} onClick={(e) => { e.stopPropagation(); if (p !== profile) applyProfile(p); }}
              className={`px-2 py-1 rounded-lg text-caption cursor-pointer ${profile === p ? 'bg-hover text-text' : 'text-text2 hover:text-text'}`}>
              {t(p === 'developer' ? 'localMcp.profileDeveloper' : 'localMcp.profileNormal')}
            </span>
          ))}
        </span>
        <span onClick={(e) => { e.stopPropagation(); load(); }}
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg border border-border hover:bg-hover text-text2 cursor-pointer">
          <IconRefresh size={12} />
        </span>
        <span onClick={(e) => { e.stopPropagation(); setManualOpen((v) => !v); }}
          className={`h-7 inline-flex items-center gap-1 px-3 rounded-lg border text-xs cursor-pointer ${manualOpen ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}>
          <IconPlus size={12} /> {t('localMcp.addManually')}
        </span>
        <span onClick={(e) => { e.stopPropagation(); if (jsonOpen) { setJsonOpen(false); } else { openJson(); } }}
          className={`h-7 inline-flex items-center gap-1 px-3 rounded-lg border text-xs cursor-pointer ${jsonOpen ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}>
          <IconEdit size={12} /> {t('localMcp.editJson')}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3">
          {govMsg && <div className="mb-3 text-caption text-danger leading-relaxed">{govMsg}</div>}
          {/* 期 3：能力降级开关（文件能力只读/读写、沙盒网络开/关）。
              统一用「标签 + 双段」形态，与折叠头的档位选择器保持同一视觉规则。
              只影响原生工具的运行期行为（sqlite 写 / sandbox_code_run 联网），不改变已连接服务。 */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-1">
              <span className="text-caption text-text2">{t('localMcp.fsModeLabel')}</span>
              <span className="h-7 inline-flex items-center gap-1 px-2 rounded-lg border border-border">
                {(['read-only', 'read-write'] as const).map((m) => (
                  <span key={m} onClick={() => { if (m !== fsMode) applyGovernance({ fsMode: m }); }}
                    className={`px-2 py-1 rounded-lg text-caption cursor-pointer ${fsMode === m ? 'bg-hover text-text' : 'text-text2 hover:text-text'}`}>
                    {t(m === 'read-only' ? 'localMcp.fsReadOnly' : 'localMcp.fsReadWrite')}
                  </span>
                ))}
              </span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-caption text-text2">{t('localMcp.sandboxNetLabel')}</span>
              <span className="h-7 inline-flex items-center gap-1 px-2 rounded-lg border border-border">
                {([false, true] as const).map((on) => (
                  <span key={String(on)} onClick={() => { if (on !== sandboxNetwork) applyGovernance({ sandboxNetwork: on }); }}
                    className={`px-2 py-1 rounded-lg text-caption cursor-pointer ${sandboxNetwork === on ? 'bg-hover text-text' : 'text-text2 hover:text-text'}`}>
                    {t(on ? 'localMcp.sandboxNetOn' : 'localMcp.sandboxNetOff')}
                  </span>
                ))}
              </span>
            </span>
          </div>
          {/* 手动添加表单 */}
          {manualOpen && (
            <div className="mb-3 p-3 rounded-lg border border-border bg-bg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text2">{t('localMcp.manualTitle')}</span>
                <button onClick={() => setManualOpen(false)} className="text-text2 hover:text-text"><IconX size={13} /></button>
              </div>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('localMcp.namePh')}
                className="w-full h-8 px-3 rounded-lg border border-border bg-surface text-xs outline-none focus:border-accent" />
              <div className="flex items-center gap-2">
                {(['stdio', 'http'] as const).map((v) => (
                  <button key={v} onClick={() => setForm({ ...form, transport: v })}
                    className={`px-3 py-1 rounded-lg text-xs border ${form.transport === v ? 'border-accent text-accent' : 'border-border text-text2 hover:bg-hover'}`}>
                    {v === 'stdio' ? t('localMcp.transportStdio') : t('localMcp.transportHttp')}
                  </button>
                ))}
              </div>
              {form.transport === 'stdio' ? (
                <>
                  <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
                    placeholder={t('localMcp.commandPh')}
                    className="w-full h-8 px-3 rounded-lg border border-border bg-surface text-xs outline-none focus:border-accent font-mono" />
                  <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })}
                    placeholder={t('localMcp.argsPh')}
                    className="w-full h-8 px-3 rounded-lg border border-border bg-surface text-xs outline-none focus:border-accent font-mono" />
                </>
              ) : (
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder={t('localMcp.urlPh')}
                  className="w-full h-8 px-3 rounded-lg border border-border bg-surface text-xs outline-none focus:border-accent font-mono" />
              )}
              <Button
                variant="primary"
                size="md"
                disabled={!form.name || (form.transport === 'http' ? !form.url : !form.command)}
                onClick={async () => {
                  await connect({
                    name: form.name,
                    transport: form.transport,
                    command: form.command || undefined,
                    args: form.args ? form.args.split(' ').filter(Boolean) : [],
                    url: form.url || undefined,
                  });
                  setManualOpen(false);
                  setForm({ name: '', transport: 'stdio', command: '', args: '', url: '' });
                }}
              >
                {t('localMcp.connectAndSave')}
              </Button>
            </div>
          )}

          {/* JSON 编辑抽屉 */}
          {jsonOpen && (
            <div className="mb-3 p-3 rounded-lg border border-border bg-bg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-text2">{t('localMcp.jsonHint')}</span>
                <button onClick={() => setJsonOpen(false)} className="text-text2 hover:text-text"><IconX size={13} /></button>
              </div>
              <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={10}
                className="w-full rounded-lg border border-border bg-surface p-3 text-xs font-mono outline-none focus:border-accent resize-y" />
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-text2">{jsonMsg}</span>
                <Button variant="primary" size="sm" onClick={saveJson}>
                  {t('localMcp.jsonSave')}
                </Button>
              </div>
            </div>
          )}

          {/* 服务器行 */}
          {rows.length === 0 ? (
            <p className="py-4 text-center text-xs text-text2">{t('localMcp.empty')}</p>
          ) : rows.map((s) => {
            const st = statusOf(s.name);
            const isConnected = st === 'ok';
            return (
              <div key={s.name} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-xs flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    {/* 期 2：三层治理档位徽章（auto-start / whitelist / manual） */}
                    {s.tier && TIER_KEY[s.tier] && (
                      <span className={`text-caption px-2 py-1 rounded-lg border shrink-0 ${TIER_CLASS[s.tier] || 'border-border text-text2'}`}>
                        {t(`localMcp.${TIER_KEY[s.tier]}`)}
                      </span>
                    )}
                    {st === 'ok' && <span className="text-caption text-success inline-flex items-center gap-1 shrink-0"><IconCheck size={10} /> {statusText.ok}{s.toolCount ? ` · ${s.toolCount}` : ''}</span>}
                    {st === 'fail' && <span className="text-caption text-danger inline-flex items-center gap-1 shrink-0"><IconAlert size={10} /> {statusText.fail}</span>}
                    {st === 'connecting' && <span className="text-caption text-text2 shrink-0">{statusText.connecting}</span>}
                    {st === 'saved' && <span className="text-caption text-text2 shrink-0">{statusText.saved}</span>}
                    {/* 崩溃态：红点 + 文案，视觉上与「连接失败」区分（失败是握手没成，崩溃是跑着挂掉） */}
                    {st === 'crashed' && (
                      <span className="text-caption text-danger inline-flex items-center gap-1 shrink-0">
                        <Dot size="sm" className="bg-danger" />
                        {statusText.crashed}
                      </span>
                    )}
                  </div>
                  {(s.command || s.url) && (
                    <div className="text-caption text-text2 font-mono truncate mt-1">
                      {s.transport === 'http' ? s.url : `${s.command || ''} ${(s.args || []).join(' ')}`}
                    </div>
                  )}
                  {st === 'crashed' && (
                    <div className="text-caption text-danger mt-1 leading-relaxed">{t('settings.mcpCrashHint')}</div>
                  )}
                  {reconnectMsg[s.name] && (
                    <div className="text-caption text-danger mt-1 leading-relaxed">{reconnectMsg[s.name]}</div>
                  )}
                </div>
                {st === 'crashed' && (
                  <Button variant="danger-ghost" size="sm" className="shrink-0" onClick={() => reconnect(s.name)} disabled={statusMap[s.name] === 'connecting'}>
                    {statusMap[s.name] === 'connecting' ? t('settings.mcpReconnecting') : t('settings.mcpReconnect')}
                  </Button>
                )}
                {st === 'fail' && (
                  <button onClick={() => connect(s)} className="text-xs text-accent hover:underline shrink-0">{t('localMcp.retry')}</button>
                )}
                {/* 开关：连接/断开（启用≠连接语义下，这里就是真实连接态） */}
                <Switch
                  checked={isConnected}
                  onChange={(next) => (next ? connect(s) : disconnect(s.name))}
                  label={t('settings.mcpServerToggle', { name: s.name })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
