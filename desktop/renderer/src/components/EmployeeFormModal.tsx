// 数字员工表单（P1-7a UI 侧）
//
// 缺口：生态中心里数字员工此前是**只读生态资产**——能列、能「招募」开会话，但没有任何
// 新建/编辑入口（主进程侧也只有 ecosystem:employees / ecosystem:employeeRuntime）。
// 本组件补上写入侧的 UI：新建 / 编辑 / 删除，走主进程 ecosystem:employeeCreate /
// employeeUpdate / employeeDelete（由 main/ipc/ecosystem.js + main/rbac.js 提供）。
//
// 三条实现约束：
//   ① 通道不存在时不崩：preload 若尚未暴露这三个方法（并行开发期），用可选链探测后
//      给明确文案（employeeBridgeMissing），而不是 TypeError 白屏。
//   ② 字段边界与主进程同源：id 落盘前 slug 化（只允许 [a-z0-9-]，防路径穿越），
//      system_prompt 上限 12000 字符（与 agent-core 的 slice 同值，不放大攻击面）。
//   ③ 提示「保存后可能不生效」：system_prompt 会过注入检测，命中特征时引擎不注入角色设定
//      （见 P1-7b），所以文案里直说，避免用户以为「保存了却没生效」是 bug。
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { Input, TextArea } from './ui/Input';
import { confirm } from './feedback';

/** 与 main/ipc/ecosystem.js 的 EMPLOYEE_PROMPT_MAX_CHARS 同值 */
const PROMPT_MAX_CHARS = 12000;
/** 与 main/ecosystem.js 的 ROLE_TOOL_ALIASES 键集同源（新增别名须同步两处） */
const TOOL_ALIASES = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'web', 'browser'] as const;
type ToolAlias = typeof TOOL_ALIASES[number];

const TOOL_LABEL_KEY: Record<ToolAlias, string> = {
  read: 'settings.employeeToolRead',
  write: 'settings.employeeToolWrite',
  edit: 'settings.employeeToolEdit',
  bash: 'settings.employeeToolBash',
  grep: 'settings.employeeToolGrep',
  glob: 'settings.employeeToolGlob',
  web: 'settings.employeeToolWeb',
  browser: 'settings.employeeToolBrowser',
};

export interface EmployeeDraft {
  id?: string;
  name?: string;
  display_name?: string;
  system_prompt?: string;
  tools?: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 传入 = 编辑模式；不传 = 新建 */
  employee?: EmployeeDraft | null;
  /** 保存成功（新建或更新） */
  onSaved?: (payload: { id: string; name: string; created: boolean }) => void;
  /** 删除成功 */
  onDeleted?: (id: string) => void;
}

// id 落到 `employees/<id>.json`，因此只允许路径安全的字符集（防 `../` 穿越）
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

function slugify(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export default function EmployeeFormModal({ open, onClose, employee, onSaved, onDeleted }: Props) {
  const { t } = useI18n();
  const editingId = String(employee?.id || '');
  const isEdit = !!editingId;

  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  // 打开时用传入值重置（新建/编辑共用一套表单，避免两份状态互相污染）
  useEffect(() => {
    if (!open) return;
    setName(String(employee?.name || employee?.display_name || ''));
    setId(editingId);
    setIdTouched(!!editingId);
    setPrompt(String(employee?.system_prompt || ''));
    setTools(Array.isArray(employee?.tools) ? (employee?.tools as string[]).map(String) : []);
    setError('');
    setSaving(false);
    setBusy(false);
  }, [open, editingId, employee]);

  // 名称 → id 自动预览（用户手动改过 id 之后不再覆盖）
  const autoId = useMemo(() => slugify(name), [name]);
  useEffect(() => {
    if (!open || isEdit || idTouched) return;
    setId(autoId);
  }, [open, isEdit, idTouched, autoId]);

  const idInvalid = !!id && !ID_PATTERN.test(id);
  const nameMissing = !name.trim();

  function toggleTool(alias: ToolAlias) {
    setTools((prev) => (prev.includes(alias) ? prev.filter((x) => x !== alias) : [...prev, alias]));
  }

  async function save() {
    setError('');
    if (nameMissing) {
      setError(t('settings.employeeNameRequired'));
      return;
    }
    if (idInvalid || !id) {
      setError(t('settings.employeeIdInvalid'));
      return;
    }
    // 字段集（不含 id）：create/update 的公共部分
    const fields = {
      name: name.trim(),
      // P3（第二轮审查）：display_name 只在**用户确实改了 name** 时才同步。
      // 原来无条件 `display_name: name.trim()`，导致编辑任意字段保存都会把用户
      // 原有的别名静默覆写成 name（主进程 update 是 {...prev, ...patch} 合并，
      // 不传该字段就会保留原值）。
      ...(name.trim() !== String(employee?.name || '').trim() ? { display_name: name.trim() } : {}),
      system_prompt: prompt,
      tools,
    };
    // 载荷形状必须对齐主进程契约（main/ipc/ecosystem.js）：
    //   create → { employee: {...} }（handler 解构 `{ employee }`）
    //   update → { id, patch: {...} }（handler 解构 `{ id, patch }`，内置员工会被拒绝）
    // 形状错了不会崩，但会被 assertObject 挡成「保存失败」，所以这里逐字对齐。
    // 另外：直写 `window.mjcode?.xxx` 而不是先取 `const bridge = window.mjcode`——
    // test/bridge-parity.test.mjs 靠这个字面形态比对「渲染层调用面 vs preload 桥面」，
    // 中转变量会让门禁看不见这次调用（拼错方法名就无从拦住）。
    type SaveResult = { ok?: boolean; employee?: { id?: string }; error?: string };
    type CreateFn = (p: { employee: Record<string, unknown> }) => Promise<SaveResult>;
    type UpdateFn = (p: { id: string; patch: Record<string, unknown> }) => Promise<SaveResult>;
    const createFn = window.mjcode?.ecosystemEmployeeCreate as CreateFn | undefined;
    const updateFn = window.mjcode?.ecosystemEmployeeUpdate as UpdateFn | undefined;
    const fn = isEdit ? updateFn : createFn;
    if (typeof fn !== 'function') {
      // 并行开发期主进程可能还没暴露写入通道：明确告知，不静默失败
      setError(t('settings.employeeBridgeMissing'));
      return;
    }
    setSaving(true);
    try {
      const r = isEdit
        ? await updateFn!({ id: editingId, patch: fields })
        : await createFn!({ employee: { id, ...fields } });
      if (r?.ok) {
        const savedId = String(r.employee?.id || id);
        // 保存结果由宿主（生态中心）的 role="status" 提示区播报——这里立即关闭，
        // 弹窗内的 aria-live 只负责「保存中」这类过程态（关闭后会随组件一起卸载）
        onSaved?.({ id: savedId, name: name.trim(), created: !isEdit });
        onClose();
      } else {
        setError(t('settings.employeeSaveFailed', { error: r?.error || '' }));
      }
    } catch (e) {
      setError(t('settings.employeeSaveFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    type DeleteFn = (p: { id: string }) => Promise<{ ok?: boolean; error?: string }>;
    const fn = window.mjcode?.ecosystemEmployeeDelete as DeleteFn | undefined;
    if (typeof fn !== 'function') {
      setError(t('settings.employeeBridgeMissing'));
      return;
    }
    const ok = await confirm({
      title: t('settings.employeeDeleteTitle'),
      message: t('settings.employeeDeleteMsg', { name: name.trim() || editingId }),
      danger: true,
      confirmLabel: t('feedback.delete'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fn({ id: editingId });
      if (r?.ok) {
        onDeleted?.(editingId);
        onClose();
      } else {
        setError(t('settings.employeeSaveFailed', { error: r?.error || '' }));
      }
    } catch (e) {
      setError(t('settings.employeeSaveFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={isEdit ? t('settings.employeeEdit') : t('settings.employeeNew')}
      liveMessage={saving ? t('settings.employeeSaving') : ''}
      // 表单类弹窗不吃遮罩点击：误触关掉会丢掉刚写的 system_prompt
      closeOnOverlay={false}
      footer={(
        <>
          {isEdit && (
            <Button variant="danger" size="sm" onClick={remove} disabled={busy || saving}>
              {t('settings.employeeDelete')}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={saving || busy}>
            {t('settings.cancel')}
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={busy}>
            {saving ? t('settings.employeeSaving') : t('settings.employeeSave')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Input
          label={t('settings.employeeName')}
          placeholder={t('settings.employeeNamePh')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Input
          label={t('settings.employeeId')}
          value={id}
          onChange={(e) => { setIdTouched(true); setId(slugify(e.target.value)); }}
          // 编辑态不允许改 id：id 是落盘文件名，改名等于新建一个员工
          readOnly={isEdit}
          hint={t('settings.employeeIdHint')}
          error={idInvalid ? t('settings.employeeIdInvalid') : undefined}
          className="font-mono"
        />
        <TextArea
          label={t('settings.employeePrompt')}
          placeholder={t('settings.employeePromptPh')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={PROMPT_MAX_CHARS}
          showCount
          rows={8}
          hint={t('settings.employeePromptHint', { max: PROMPT_MAX_CHARS })}
        />
        <div>
          <div className="text-xs text-text2 mb-1">{t('settings.employeeTools')}</div>
          <div className="flex flex-wrap gap-1.5">
            {TOOL_ALIASES.map((alias) => {
              const on = tools.includes(alias);
              return (
                <Button
                  key={alias}
                  size="sm"
                  variant={on ? 'primary' : 'secondary'}
                  onClick={() => toggleTool(alias)}
                  aria-pressed={on}
                >
                  {t(TOOL_LABEL_KEY[alias])}
                </Button>
              );
            })}
          </div>
          <p className="text-caption text-text2 mt-1">{t('settings.employeeToolsHint')}</p>
        </div>
        {error && (
          <p className="text-caption text-danger leading-relaxed" role="alert">{error}</p>
        )}
      </div>
    </Modal>
  );
}
