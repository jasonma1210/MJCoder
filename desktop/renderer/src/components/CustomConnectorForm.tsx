// 「自定义连接器」页面（渲染在生态中心·连接器页签内，作为页面级视图而非嵌套浮层）
//
// 为什么是页面级视图而不是弹窗：此前 Agent 面板里的删除确认用「面板内 fixed inset-0 覆盖层」
// 造成过「铺满整页 + 按钮点不到」的真实事故。这里改成在同一滚动容器内切换视图，天然没有层叠问题。
//
// 链路：本地校验（lib/customConnector.ts）→ 通过后交主进程 mcp:connect。
// 主进程只在**握手成功**后才持久化（fail-closed），因此「校验通过 → 连上 → 自动保存在本地」
// 是同一个动作的结果，无需额外的保存接口，也不会出现「保存了但连不上」的假成功。
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { IconAlert, IconCheck, IconGlobe, IconPlug } from './icons';
import {
  emptyDraft, validateCustomConnector,
  type CustomDraft, type Transport,
} from '../lib/customConnector';

interface Props {
  /** 已存在的服务名（已保存 ∪ 已连接），用于查重，避免同名覆盖旧配置 */
  existingNames: string[];
  /** 配置文件路径（主进程回传），供「打开配置文件」使用 */
  configPath?: string;
  onCancel: () => void;
  /** 连接成功：宿主刷新「本机服务」区并切回列表 */
  onSaved: (name: string) => void;
}

const INPUT = 'w-full h-9 px-3 rounded-lg border border-border bg-surface text-sm outline-none focus:border-accent';
const AREA = 'w-full px-3 py-2 rounded-lg border border-border bg-surface text-xs outline-none focus:border-accent font-mono leading-relaxed';

export default function CustomConnectorForm({ existingNames, configPath, onCancel, onSaved }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CustomDraft>(() => emptyDraft());
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'fail'>('idle');
  const [errMsg, setErrMsg] = useState('');
  // 仅在用户尝试提交后展示校验错误，避免「刚打开就一片红」
  const [touched, setTouched] = useState(false);

  const result = useMemo(() => validateCustomConnector(draft, existingNames), [draft, existingNames]);
  const set = (patch: Partial<CustomDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    setTouched(true);
    setErrMsg('');
    const v = validateCustomConnector(draft, existingNames);
    if (!v.ok || !v.payload) { setStatus('idle'); return; }
    setStatus('saving');
    try {
      const r = (await window.mjcode?.mcpConnect?.(v.payload)) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) {
        setStatus('ok');
        // 连接态变化 → 工具集变化，通知 App 重建 MCP 工具集
        window.dispatchEvent(new CustomEvent('mjcode:mcp-tools-dirty'));
        onSaved(v.payload.name);
      } else {
        setStatus('fail');
        setErrMsg(String(r?.error || t('ecosystem.custom.connectFailed')));
      }
    } catch (e) {
      setStatus('fail');
      setErrMsg(e instanceof Error ? e.message : t('ecosystem.custom.connectFailed'));
    }
  }

  async function openConfig() {
    if (!configPath) return;
    try { await window.mjcode?.openPath?.({ path: configPath }); } catch (e) { /* 打不开不影响主流程 */ }
  }

  const busy = status === 'saving';
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      {/* 头部：返回 + 标题 + 动作 */}
      <div className="flex items-center gap-3">
        <button onClick={onCancel} className="text-xs text-text2 hover:text-text shrink-0">
          {t('ecosystem.custom.back')}
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{t('ecosystem.custom.title')}</div>
          <div className="text-xs text-text2 mt-0.5">{t('ecosystem.custom.subtitle')}</div>
        </div>
        <button onClick={onCancel} className="h-8 px-3 rounded-lg border border-border text-xs text-text2 hover:bg-hover shrink-0">
          {t('ecosystem.custom.cancel')}
        </button>
        <button onClick={save} disabled={busy || !result.ok}
          className="h-8 px-4 rounded-lg bg-accent-solid text-on-accent text-xs hover:brightness-110 disabled:opacity-40 shrink-0">
          {busy ? t('ecosystem.custom.saving') : t('ecosystem.custom.save')}
        </button>
      </div>

      {/* 配置文件路径：与 WorkBuddy 的「配置 MCP」页一致，明确告诉用户保存在哪 */}
      {configPath && (
        <div className="mt-3 flex items-center gap-2 text-xs text-text2">
          <span className="shrink-0">{t('ecosystem.custom.configPathLabel')}</span>
          <span className="font-mono truncate">{configPath}</span>
          <button onClick={openConfig} className="text-accent hover:underline shrink-0">
            {t('ecosystem.custom.openConfig')}
          </button>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <div>
          <label className="text-xs text-text2 block mb-1">{t('ecosystem.custom.nameLabel')}</label>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })}
            placeholder="my-mcp-server" className={INPUT} />
          <p className="text-xs text-text2 mt-1">{t('ecosystem.custom.nameHint')}</p>
        </div>

        <div>
          <label className="text-xs text-text2 block mb-1">{t('ecosystem.custom.transportLabel')}</label>
          <div className="flex gap-2">
            {(['stdio', 'http'] as Transport[]).map((tp) => (
              <button key={tp} onClick={() => set({ transport: tp })}
                className={`h-9 px-4 rounded-lg border text-xs ${draft.transport === tp ? 'border-accent text-accent' : 'border-border text-text2 hover:bg-hover'}`}>
                {tp === 'stdio' ? t('ecosystem.custom.transportStdio') : t('ecosystem.custom.transportHttp')}
              </button>
            ))}
          </div>
        </div>

        {draft.transport === 'stdio' ? (
          <>
            <div>
              <label className="text-xs text-text2 block mb-1">{t('ecosystem.custom.commandLabel')}</label>
              <input value={draft.command} onChange={(e) => set({ command: e.target.value })}
                placeholder="npx" className={`${INPUT} font-mono`} />
            </div>
            <div>
              <label className="text-xs text-text2 block mb-1">{t('ecosystem.custom.argsLabel')}</label>
              <textarea rows={3} value={draft.args} onChange={(e) => set({ args: e.target.value })}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'} className={AREA} />
            </div>
            <div>
              <label className="text-xs text-text2 block mb-1">{t('ecosystem.custom.envLabel')}</label>
              <textarea rows={3} value={draft.env} onChange={(e) => set({ env: e.target.value })}
                placeholder={'API_KEY=xxxx\nBASE_URL=https://example.com'} className={AREA} />
              <p className="text-xs text-text2 mt-1">{t('ecosystem.custom.envHint')}</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="text-xs text-text2 block mb-1">{t('ecosystem.custom.urlLabel')}</label>
              <input value={draft.url} onChange={(e) => set({ url: e.target.value })}
                placeholder="https://mcp.example.com/mcp" className={`${INPUT} font-mono`} />
            </div>
            <div>
              <label className="text-xs text-text2 block mb-1">{t('ecosystem.custom.headersLabel')}</label>
              <textarea rows={3} value={draft.headers} onChange={(e) => set({ headers: e.target.value })}
                placeholder={'Authorization: Bearer xxxx'} className={AREA} />
              <p className="text-xs text-text2 mt-1">{t('ecosystem.custom.headersHint')}</p>
            </div>
          </>
        )}

        {/* 校验结果：提交后（touched）或已有连接结果时展示 */}
        {touched && result.issues.length > 0 && (
          <ul className="text-xs text-danger space-y-1">
            {result.issues.map((it, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <IconAlert size={12} className="shrink-0 mt-0.5" />
                <span>{t(it.key, it.params)}</span>
              </li>
            ))}
          </ul>
        )}

        {status === 'ok' && (
          <p className="inline-flex items-center gap-1.5 text-xs text-success">
            <IconCheck size={13} /> {t('ecosystem.custom.savedOk', { name: draft.name })}
          </p>
        )}
        {status === 'fail' && (
          <p className="inline-flex items-center gap-1.5 text-xs text-danger break-all">
            <IconAlert size={13} /> {errMsg || t('ecosystem.custom.connectFailed')}
          </p>
        )}
        {status === 'idle' && !touched && (
          <p className="inline-flex items-center gap-1.5 text-xs text-text2">
            <IconPlug size={12} /> {t('ecosystem.custom.saveNote')}
          </p>
        )}
      </div>

      {/* 帮助：把「怎么拿到配置」说清楚，避免用户在此页卡住 */}
      <div className="mt-4 pt-3 border-t border-border flex items-center gap-2">
        <IconGlobe size={12} className="text-text2 shrink-0" />
        <span className="text-xs text-text2">{t('ecosystem.custom.help')}</span>
      </div>
    </div>
  );
}
