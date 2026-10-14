import { useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconChevronRight, IconCpu, IconCheck, IconPlus } from './icons';
import { REASONING_EFFORT_OPTIONS, CONTEXT_WINDOW_OPTIONS, modelKeyOf, getModelConfig, setModelConfig } from '../lib/modelConfig';

// 模型选择器（对标 WorkBuddy 双栏 popover）：
// 左栏：按 provider 分组的模型列表（勾选态）+ 底部「配置自定义模型」入口
// 右栏：当前模型的详情 —— 思考强度 / 上下文窗口，点行展开二级选项面板（选中项带勾选标记）
// 反馈修复：setModelConfig 只写 localStorage 不触发渲染，必须用 cfgVer 计数器强制刷新，
// 否则选项高亮永远不动（真机事故：点击无任何反馈）
export default function ModelSelector({ providers, selected, onSelect }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null); // 右栏展示的模型（点列表即切换，同时选中）
  const [expanded, setExpanded] = useState(null); // 'reasoning' | 'context' | null
  const [cfgVer, setCfgVer] = useState(0); // 配置写入计数器 → 强制重渲染让高亮即时生效
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setExpanded(null); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 每次展开面板时，右栏回到当前选中模型
  useEffect(() => {
    if (open) { setDetail(selected); setExpanded(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (providers.length === 0) {
    return <span className="text-text2 text-xs">未配置模型 → 点设置添加</span>;
  }

  const valueOf = (p, m) => `${p.isGlobal ? 'g' : p.source || 'u'}:${p.id}/${m.id}`;
  const dKey = detail ? modelKeyOf(detail.provider, detail.model) : null;
  const cfg = cfgVer >= 0 && detail ? getModelConfig(dKey) : null;
  const reasoning = cfg?.reasoning_effort || '';
  const ctxWin = cfg?.context_window || 0;
  const labelOf = (opts, v) => opts.find((o) => o.value === v)?.label || '默认';

  function choose(p, m) {
    onSelect({ provider: p, model: m });
    setDetail({ provider: p, model: m });
    setExpanded(null);
  }

  function updateCfg(patch) {
    setModelConfig(dKey, patch);
    setCfgVer((v) => v + 1); // 关键：触发重渲染，否则 localStorage 写入不可见
  }

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        onClick={() => setOpen((v) => !v)}
        className="bg-surface border border-border rounded px-2 py-1 text-xs text-text outline-none hover:border-accent flex items-center gap-1 max-w-[220px]"
        aria-expanded={open}
        aria-label="选择模型"
      >
        <span className="truncate">
          {selected ? `${selected.provider.name} / ${selected.model.display_name || selected.model.model_id}` : '选择模型...'}
        </span>
        <IconChevronDown size={11} className="text-text2 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-2 w-[460px] bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] z-palette overflow-hidden flex">
          {/* 左栏：模型列表 */}
          <div className="w-[180px] shrink-0 border-r border-border flex flex-col">
            <div className="flex-1 min-h-0 max-h-72 overflow-y-auto py-1">
              {providers.map((p) => (
                <div key={`${p.isGlobal ? 'g' : p.source || 'u'}:${p.id}`}>
                  <div className="px-3 pt-2 pb-1 text-[10px] text-text2 uppercase tracking-wider flex items-center gap-1.5">
                    <IconCpu size={11} />
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0">{p.isGlobal ? '共享' : p.source === 'local' ? '本机' : '私有'}</span>
                  </div>
                  {(p.models || []).length === 0 && (
                    <div className="px-3 py-1 text-[11px] text-text2">（无模型）</div>
                  )}
                  {(p.models || []).map((m) => {
                    const active = selected && String(selected.model.id) === String(m.id) && !!selected.provider.isGlobal === !!p.isGlobal && String(selected.provider.id) === String(p.id);
                    return (
                      <button key={valueOf(p, m)} onClick={() => choose(p, m)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs ${active ? 'bg-accent-soft text-accent' : 'hover:bg-hover text-text'}`}>
                        <span className="flex-1 truncate">{m.display_name || m.model_id}</span>
                        {active && <IconCheck size={12} className="shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            {/* 底部入口：打开设置管理自定义模型 */}
            <button
              onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('mjcode:open-settings')); }}
              className="shrink-0 border-t border-border px-3 py-2 text-left text-xs text-text2 hover:text-text hover:bg-hover flex items-center gap-1.5">
              <IconPlus size={12} />
              配置自定义模型
            </button>
          </div>

          {/* 右栏：模型详情 + 配置行（点行展开二级选项面板） */}
          {detail ? (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="px-3.5 pt-3 pb-2 border-b border-border">
                <div className="text-sm font-medium text-text truncate">
                  {detail.model.display_name || detail.model.model_id}
                </div>
                <div className="text-[11px] text-text2 mt-0.5 truncate" title={detail.model.model_id}>
                  {detail.provider.name} · {detail.model.model_id}
                </div>
              </div>

              {/* 思考强度 */}
              <ConfigRow
                label="思考强度"
                value={labelOf(REASONING_EFFORT_OPTIONS, reasoning)}
                expanded={expanded === 'reasoning'}
                onToggle={() => setExpanded(expanded === 'reasoning' ? null : 'reasoning')}
                options={REASONING_EFFORT_OPTIONS}
                picked={reasoning}
                onPick={(v) => { updateCfg({ reasoning_effort: v }); setExpanded(null); }}
                title={reasoning ? `请求携带 reasoning_effort=${reasoning}` : '不携带思考参数，跟随服务端默认'}
              />
              {/* 上下文窗口 */}
              <ConfigRow
                label="上下文窗口"
                value={labelOf(CONTEXT_WINDOW_OPTIONS, ctxWin)}
                expanded={expanded === 'context'}
                onToggle={() => setExpanded(expanded === 'context' ? null : 'context')}
                options={CONTEXT_WINDOW_OPTIONS}
                picked={ctxWin}
                onPick={(v) => { updateCfg({ context_window: v }); setExpanded(null); }}
                title={ctxWin ? `上下文用量按 ${labelOf(CONTEXT_WINDOW_OPTIONS, ctxWin)} 计算` : '按模型自带上下文计算'}
              />
              <div className="mt-auto px-3.5 py-2 text-[10px] text-text2">
                配置按模型分别保存，仅对本机生效
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-text2 py-10">
              在左侧选择一个模型
            </div>
          )}
        </div>
      )}
    </span>
  );
}

// 配置行：label + 当前值 + 右箭头；点击展开垂直选项列表（对标 WorkBuddy 二级面板）
function ConfigRow({ label, value, expanded, onToggle, options, picked, onPick, title }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        title={title}
        className={`w-full flex items-center px-3.5 py-2.5 text-xs ${expanded ? 'bg-hover' : 'hover:bg-hover'}`}
      >
        <span className="text-text">{label}</span>
        <span className="ml-auto text-text2">{value}</span>
        <IconChevronRight size={12}
          className={`ml-1.5 text-text2 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className="pb-1.5">
          {options.map((o) => {
            const active = o.value === picked;
            return (
              <button key={String(o.value)} onClick={() => onPick(o.value)}
                className={`w-full flex items-center px-6 py-1.5 text-xs ${active ? 'bg-accent-soft text-accent' : 'text-text hover:bg-hover'}`}>
                <span className="flex-1 text-left">{o.label}</span>
                {active && <IconCheck size={12} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
