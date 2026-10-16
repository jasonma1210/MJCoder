import { useEffect, useState } from 'react';
import { api, humanizeError } from '../lib/api';
import CreateProjectForm from './CreateProjectForm';
import InlineAlert from './InlineAlert';
import { IconCheck, IconCpu, IconGlobe, IconShield, IconZap } from './icons';
import { useI18n } from '../i18n';

// 顶层常量只存 i18n key，渲染时经 t() 求值（避免模块加载冻结译文）
// B5（2026-10-16）：新增「安全默认档」步骤——新用户面对「审批档 × 沙箱档」组合
// （4×3）无从判断，选择一个安全起点比让用户自己试错更划算。
const STEPS = ['onboarding.stepWelcome', 'onboarding.stepModel', 'onboarding.stepSafety', 'onboarding.stepProject', 'onboarding.stepFirstTask', 'onboarding.stepStart'];

// 安全档预置：显式写出「允许什么 / 阻止什么」，而不是只给一个名字
const SAFETY_PRESETS = [
  {
    id: 'safe',
    nameKey: 'onboarding.safetySafeName',
    descKey: 'onboarding.safetySafeDesc',
    patch: { approval_mode: 'on-request', sandbox_policy: 'workspace-write' },
  },
  {
    id: 'readonly',
    nameKey: 'onboarding.safetyReadonlyName',
    descKey: 'onboarding.safetyReadonlyDesc',
    patch: { approval_mode: 'on-request', sandbox_policy: 'read-only' },
  },
  {
    id: 'auto',
    nameKey: 'onboarding.safetyAutoName',
    descKey: 'onboarding.safetyAutoDesc',
    patch: { approval_mode: 'auto-safe', sandbox_policy: 'workspace-write' },
  },
];

// 首启 5 步向导（对标 Codex setup-codex 流程）
export default function Onboarding({ globalProviders, userProviders, onFinish, onProviderAdded, onProjectSelected, approvalSettings, onApprovalSettingsChange }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  // B5：安全默认档选择（默认「推荐安全档」）
  const [safetyChoice, setSafetyChoice] = useState('safe');

  // 模型步骤状态（本地优先：默认填自己的 Key，凭证存本机）
  const [mode, setMode] = useState('custom'); // global | custom
  const [selectedGlobal, setSelectedGlobal] = useState(null);
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', model_id: '' });
  const [testing, setTesting] = useState(false);
  // 连接测试结果：{ ok, text }（ok 决定告警类型，避免用译文前缀做状态判断）
  const [testResult, setTestResult] = useState(null);

  // 首任务状态
  const [suggestions, setSuggestions] = useState([]);
  const [chosen, setChosen] = useState('');

  function next() { setError(''); setStep((s) => Math.min(s + 1, STEPS.length - 1)); }
  function back() { setError(''); setStep((s) => Math.max(s - 1, 0)); }

  // B5：进入安全档步骤即落地推荐默认值——用户即使直接点「下一步」跳过选择，
  // 也带着安全起点离开向导（不做「看起来给了选择、实际没生效」的假交互）。
  useEffect(() => {
    if (step !== 2 || !onApprovalSettingsChange) return;
    const preset = SAFETY_PRESETS.find((p) => p.id === safetyChoice) || SAFETY_PRESETS[0];
    onApprovalSettingsChange({ ...(approvalSettings || {}), ...preset.patch });
    // 只依赖 step 与选择：approvalSettings 变化由父层回流，不重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, safetyChoice]);

  // 测试模型连接（主进程直连，Key 不经过渲染层）
  async function testConnection({ providerId, isGlobal, baseUrl, modelId }) {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.mjcode.chat({
        providerId, isGlobal, baseUrl,
        messages: [{ role: 'user', content: t('onboarding.pingPrompt') }],
        model: modelId,
      });
      setTestResult(r.aborted
        ? { ok: false, text: t('onboarding.connAborted') }
        : { ok: true, text: t('onboarding.connSuccess', { detail: (r.content || '').slice(0, 40) }) });
      return true;
    } catch (err) {
      const msg = String(err.message || '');
      setTestResult(msg.startsWith('KEY_MISSING')
        ? { ok: false, text: t('onboarding.credNotLoaded') }
        : { ok: false, text: t('onboarding.connFailed', { msg: msg.slice(0, 120) }) });
      return false;
    } finally {
      setTesting(false);
    }
  }

  // 保存模型配置：写入 App 内置本机数据库（主进程 localStore + safeStorage 加密），不经过任何服务器
  async function submitCustomProvider() {
    if (!form.name || !form.base_url || !form.api_key || !form.model_id) {
      setError(t('onboarding.fillRequired'));
      return;
    }
    try {
      const provider = await window.mjcode.localAddProvider({
        name: form.name, base_url: form.base_url, api_key: form.api_key, model_id: form.model_id,
      });
      await onProviderAdded?.(); // 触发 App 刷新本机 providers
      const ok = await testConnection({ providerId: provider.id, isGlobal: false, baseUrl: form.base_url, modelId: form.model_id });
      if (!ok) { setError(t('onboarding.savedButTestFailed')); return; }
      next();
    } catch (err) {
      setError(t('onboarding.saveFailed', { msg: humanizeError(err) }));
    }
  }

  async function confirmGlobal() {
    if (!selectedGlobal) { setError(t('onboarding.pickSharedModel')); return; }
    const ok = await testConnection({
      providerId: selectedGlobal.providerId, isGlobal: true,
      baseUrl: selectedGlobal.baseUrl, modelId: selectedGlobal.modelId,
    });
    if (!ok) { setError(t('onboarding.testFailedSwitch')); return; }
    next();
  }

  // 创建 / 选定项目后进入下一步，并基于内容生成首任务建议
  async function acceptProject(p) {
    onProjectSelected?.({ path: p.path, name: p.name });
    await previewDir(p.path);
    next();
  }

  async function previewDir(p) {
    if (!p) return;
    try {
      const probeRes = await window.mjcode.probeProject({ path: p });
      // 基于项目内容生成首任务建议
      const tips = [];
      if (probeRes.branch) tips.push(t('onboarding.tipBranch', { branch: probeRes.branch }));
      tips.push(t('onboarding.tipReadme', { name: probeRes.name }));
      if (probeRes.languages?.length) tips.push(t('onboarding.tipDeps', { lang: probeRes.languages[0] }));
      setSuggestions(tips);
    } catch (err) {
      console.warn('[onboarding] project probe failed:', err);
    }
  }

  function finish() {
    onFinish?.(chosen);
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      {/* 进度条 */}
      <div className="flex items-center gap-2 px-8 py-6">
        {STEPS.map((labelKey, i) => (
          <div key={labelKey} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-xs ${i === step ? 'text-text' : i < step ? 'text-accent' : 'text-text2'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center border text-[10px] ${
                i < step ? 'border-accent bg-accent text-white' : i === step ? 'border-accent text-accent' : 'border-border'
              }`}>
                {i < step ? <IconCheck size={12} /> : i + 1}
              </span>
              {t(labelKey)}
            </div>
            {i < STEPS.length - 1 && <div className={`w-8 h-px ${i < step ? 'bg-accent' : 'bg-border'}`} />}
          </div>
        ))}
      </div>

      <div className="flex-1 flex items-center justify-center px-8">
        <div className="w-full max-w-xl">
          {error && <div className="mb-4"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}

          {/* 步骤 1：欢迎 */}
          {step === 0 && (
            <div className="text-center">
              <h1 className="text-3xl font-semibold mb-3">{t('onboarding.welcomeHeading')}</h1>
              <p className="text-text2 text-sm mb-8">{t('onboarding.welcomeSub')}</p>
              <button onClick={next} className="bg-accent text-white px-6 py-2.5 rounded-xl text-sm">{t('onboarding.startSetup')}</button>
            </div>
          )}

          {/* 步骤 2：配置模型 */}
          {step === 1 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepModel')}</h2>
              <p className="text-text2 text-sm mb-6">
                {t('onboarding.modelSub')}
              </p>
              <div className="grid grid-cols-2 gap-3 mb-5">
                <button onClick={() => { setMode('global'); setTestResult(null); }}
                  className={`border rounded-2xl p-4 text-left ${mode === 'global' ? 'border-accent' : 'border-border hover:bg-hover'}`}>
                  <IconGlobe size={20} className="mb-2 text-accent" />
                  <div className="text-sm font-medium">{t('onboarding.sharedModel')}</div>
                  <div className="text-xs text-text2 mt-1">{t('onboarding.sharedModelDesc')}</div>
                </button>
                <button onClick={() => { setMode('custom'); setTestResult(null); }}
                  className={`border rounded-2xl p-4 text-left ${mode === 'custom' ? 'border-accent' : 'border-border hover:bg-hover'}`}>
                  <IconCpu size={20} className="mb-2 text-accent" />
                  <div className="text-sm font-medium">{t('onboarding.myKey')}</div>
                  <div className="text-xs text-text2 mt-1">{t('onboarding.myKeyDesc')}</div>
                </button>
              </div>

              {mode === 'global' ? (
                globalProviders.length === 0 ? (
                  <InlineAlert type="warn">{t('onboarding.noSharedModel')}</InlineAlert>
                ) : (
                  <div className="space-y-2">
                    {globalProviders.flatMap((p) => (p.models || []).map((m) => (
                      <button key={`${p.id}-${m.id}`}
                        onClick={() => setSelectedGlobal({ providerId: p.id, baseUrl: p.base_url, modelId: m.model_id, label: `${p.name} / ${m.display_name || m.model_id}` })}
                        className={`w-full flex items-center justify-between border rounded-xl px-4 py-3 text-left ${selectedGlobal?.modelId === m.model_id && selectedGlobal?.providerId === p.id ? 'border-accent' : 'border-border hover:bg-hover'}`}>
                        <span className="text-sm">{p.name} / {m.display_name || m.model_id}</span>
                        {selectedGlobal?.modelId === m.model_id && selectedGlobal?.providerId === p.id && <IconCheck size={16} className="text-accent" />}
                      </button>
                    )))}
                    {testResult && <InlineAlert type={testResult.ok ? 'info' : 'error'}>{testResult.text}</InlineAlert>}
                    <div className="flex justify-between pt-2">
                      <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                      {/* O1：共享模型不可用/测试不过时同样允许跳过 */}
                      <div className="flex items-center gap-3">
                        <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipConfigureLater')}</button>
                        <button onClick={confirmGlobal} disabled={!selectedGlobal || testing}
                          className="bg-accent text-white px-5 py-2 rounded-lg text-sm disabled:opacity-50">{testing ? t('onboarding.testing') : t('onboarding.testAndContinue')}</button>
                      </div>
                    </div>
                  </div>
                )
              ) : (
                <div className="space-y-2">
                  <input placeholder={t('onboarding.namePlaceholder')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <input placeholder={t('onboarding.urlPlaceholder')} value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <input placeholder="API Key" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <input placeholder={t('onboarding.modelIdPlaceholder')} value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  {testResult && <InlineAlert type={testResult.ok ? 'info' : 'error'}>{testResult.text}</InlineAlert>}
                  <div className="flex justify-between pt-2">
                    <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                    {/* O1：无 Key 的用户不允许被卡死在模型步骤——先跳过，进入后可随时在设置中补配 */}
                    <div className="flex items-center gap-3">
                      <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipConfigureLater')}</button>
                      <button onClick={submitCustomProvider} disabled={testing}
                        className="bg-accent text-white px-5 py-2 rounded-lg text-sm disabled:opacity-50">{testing ? t('onboarding.testing') : t('onboarding.saveAndTest')}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 步骤 3：安全默认档（B5）——给出「允许什么 / 阻止什么」的直白说明 */}
          {step === 2 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepSafety')}</h2>
              <p className="text-text2 text-sm mb-6">{t('onboarding.safetySub')}</p>
              <div className="space-y-2 mb-4">
                {SAFETY_PRESETS.map((p) => (
                  <button key={p.id} onClick={() => setSafetyChoice(p.id)}
                    className={`w-full flex items-start gap-3 border rounded-xl px-4 py-3 text-left ${safetyChoice === p.id ? 'border-accent' : 'border-border hover:bg-hover'}`}>
                    <IconShield size={16} className="text-accent shrink-0 mt-0.5" />
                    <span className="flex-1 min-w-0">
                      <span className="text-sm font-medium block">{t(p.nameKey)}</span>
                      <span className="text-xs text-text2 block mt-1 leading-relaxed">{t(p.descKey)}</span>
                    </span>
                    {safetyChoice === p.id && <IconCheck size={16} className="text-accent shrink-0 mt-0.5" />}
                  </button>
                ))}
              </div>
              <InlineAlert type="info">{t('onboarding.safetyNote')}</InlineAlert>
              <div className="flex justify-between mt-4">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                <button onClick={next} className="bg-accent text-white px-5 py-2 rounded-lg text-sm">{t('onboarding.continue')}</button>
              </div>
            </div>
          )}

          {/* 步骤 4：创建 / 选择项目 */}
          {step === 3 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepProject')}</h2>
              <p className="text-text2 text-sm mb-6">{t('onboarding.projectSub')}</p>
              <CreateProjectForm onCreated={acceptProject} />
              <div className="flex justify-between mt-4">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                {/* 本地优先：无项目也必须能走完向导（问答/纯对话不需要项目目录）。
                    此前此步只有「创建项目」一条路，不想建项目的用户被流程锁死 */}
                <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipProject')}</button>
              </div>
            </div>
          )}

          {/* 步骤 5：第一个任务 */}
          {step === 4 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepFirstTask')}</h2>
              <p className="text-text2 text-sm mb-6">{t('onboarding.firstTaskSub')}</p>
              <div className="space-y-2 mb-4">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => setChosen(s)}
                    className={`w-full flex items-center gap-3 border rounded-xl px-4 py-3 text-left text-sm ${chosen === s ? 'border-accent' : 'border-border hover:bg-hover'}`}>
                    <IconZap size={16} className="text-accent shrink-0" />
                    <span className="flex-1">{s}</span>
                    {chosen === s && <IconCheck size={16} className="text-accent" />}
                  </button>
                ))}
              </div>
              <div className="flex justify-between">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                <button onClick={finish} className="bg-accent text-white px-5 py-2 rounded-lg text-sm">{chosen ? t('onboarding.startWithTask') : t('onboarding.skipDirect')}</button>
              </div>
            </div>
          )}

          {/* 步骤 6：完成 */}
          {step === 5 && (
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-accent/15 flex items-center justify-center mx-auto mb-4">
                <IconCheck size={28} className="text-accent" />
              </div>
              <h2 className="text-2xl font-semibold mb-2">{t('onboarding.readyTitle')}</h2>
              <p className="text-text2 text-sm mb-8">{t('onboarding.readySub')}</p>
              <button onClick={finish} className="bg-accent text-white px-6 py-2.5 rounded-xl text-sm">{t('onboarding.enter')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
