import { useState } from 'react';
import { api, humanizeError } from '../lib/api';
import CreateProjectForm from './CreateProjectForm';
import InlineAlert from './InlineAlert';
import { IconCheck, IconCpu, IconGlobe, IconZap } from './icons';

const STEPS = ['欢迎', '配置模型', '创建项目', '第一个任务', '开始使用'];

// 首启 5 步向导（对标 Codex setup-codex 流程）
export default function Onboarding({ globalProviders, userProviders, onFinish, onProviderAdded, onProjectSelected }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');

  // 模型步骤状态（本地优先：默认填自己的 Key，凭证存本机）
  const [mode, setMode] = useState('custom'); // global | custom
  const [selectedGlobal, setSelectedGlobal] = useState(null);
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', model_id: '' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  // 首任务状态
  const [suggestions, setSuggestions] = useState([]);
  const [chosen, setChosen] = useState('');

  function next() { setError(''); setStep((s) => Math.min(s + 1, STEPS.length - 1)); }
  function back() { setError(''); setStep((s) => Math.max(s - 1, 0)); }

  // 测试模型连接（主进程直连，Key 不经过渲染层）
  async function testConnection({ providerId, isGlobal, baseUrl, modelId }) {
    setTesting(true);
    setTestResult('');
    try {
      const r = await window.mjcode.chat({
        providerId, isGlobal, baseUrl,
        messages: [{ role: 'user', content: 'ping，回复 OK 两个字' }],
        model: modelId,
      });
      setTestResult(r.aborted ? '连接被中断' : `连接成功：${(r.content || '').slice(0, 40)}`);
      return true;
    } catch (err) {
      const msg = String(err.message || '');
      setTestResult(msg.startsWith('KEY_MISSING') ? '凭证未加载，请重试' : `连接失败：${msg.slice(0, 120)}`);
      return false;
    } finally {
      setTesting(false);
    }
  }

  // 保存模型配置：写入 App 内置本机数据库（主进程 localStore + safeStorage 加密），不经过任何服务器
  async function submitCustomProvider() {
    if (!form.name || !form.base_url || !form.api_key || !form.model_id) {
      setError('请填写服务名称、接口地址、API Key 与模型 ID');
      return;
    }
    try {
      const provider = await window.mjcode.localAddProvider({
        name: form.name, base_url: form.base_url, api_key: form.api_key, model_id: form.model_id,
      });
      await onProviderAdded?.(); // 触发 App 刷新本机 providers
      const ok = await testConnection({ providerId: provider.id, isGlobal: false, baseUrl: form.base_url, modelId: form.model_id });
      if (!ok) { setError('已保存到本机，但连接测试未通过，请检查接口地址、Key 与模型 ID'); return; }
      next();
    } catch (err) {
      setError(`保存到本机数据库失败：${humanizeError(err)}`);
    }
  }

  async function confirmGlobal() {
    if (!selectedGlobal) { setError('请选择一个服务器共享模型'); return; }
    const ok = await testConnection({
      providerId: selectedGlobal.providerId, isGlobal: true,
      baseUrl: selectedGlobal.baseUrl, modelId: selectedGlobal.modelId,
    });
    if (!ok) { setError('连接测试未通过，请更换模型或联系管理员'); return; }
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
      if (probeRes.branch) tips.push(`查看当前分支 ${probeRes.branch} 的未提交变更并总结`);
      tips.push(`阅读 ${probeRes.name} 的 README 与主要源码，给我一份项目结构说明`);
      if (probeRes.languages?.length) tips.push(`检查这个 ${probeRes.languages[0]} 项目的依赖配置，指出可以升级或存在风险的项`);
      setSuggestions(tips);
    } catch (err) {
      console.warn('[onboarding] 项目探测失败:', err);
    }
  }

  function finish() {
    onFinish?.(chosen);
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      {/* 进度条 */}
      <div className="flex items-center gap-2 px-8 py-6">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-xs ${i === step ? 'text-text' : i < step ? 'text-accent' : 'text-text2'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center border text-[10px] ${
                i < step ? 'border-accent bg-accent text-white' : i === step ? 'border-accent text-accent' : 'border-border'
              }`}>
                {i < step ? <IconCheck size={12} /> : i + 1}
              </span>
              {label}
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
              <h1 className="text-3xl font-semibold mb-3">今天想交付什么？</h1>
              <p className="text-text2 text-sm mb-8">MJ Coder 是本地优先的 AI 编程助手。接下来用 4 步完成准备：配置模型 → 选择项目 → 发出第一个任务。</p>
              <button onClick={next} className="bg-accent text-white px-6 py-2.5 rounded-xl text-sm">开始配置</button>
            </div>
          )}

          {/* 步骤 2：配置模型 */}
          {step === 1 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">配置模型</h2>
              <p className="text-text2 text-sm mb-6">
                填入你自己的 API Key，凭证经系统加密保存在本机数据库（密钥不出本机）；也可选择服务器共享模型（免填 Key）。
              </p>
              <div className="grid grid-cols-2 gap-3 mb-5">
                <button onClick={() => { setMode('global'); setTestResult(''); }}
                  className={`border rounded-2xl p-4 text-left ${mode === 'global' ? 'border-accent' : 'border-border hover:bg-hover'}`}>
                  <IconGlobe size={20} className="mb-2 text-accent" />
                  <div className="text-sm font-medium">服务器共享模型</div>
                  <div className="text-xs text-text2 mt-1">管理员统一配置，无需 Key</div>
                </button>
                <button onClick={() => { setMode('custom'); setTestResult(''); }}
                  className={`border rounded-2xl p-4 text-left ${mode === 'custom' ? 'border-accent' : 'border-border hover:bg-hover'}`}>
                  <IconCpu size={20} className="mb-2 text-accent" />
                  <div className="text-sm font-medium">我的 API Key</div>
                  <div className="text-xs text-text2 mt-1">任意 OpenAI 兼容端点，仅存本机</div>
                </button>
              </div>

              {mode === 'global' ? (
                globalProviders.length === 0 ? (
                  <InlineAlert type="warn">服务器端暂无共享模型，请切换到「我的 API Key」或联系管理员。</InlineAlert>
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
                    {testResult && <InlineAlert type={testResult.startsWith('连接成功') ? 'info' : 'error'}>{testResult}</InlineAlert>}
                    <div className="flex justify-between pt-2">
                      <button onClick={back} className="text-text2 text-sm hover:text-text">上一步</button>
                      {/* O1：共享模型不可用/测试不过时同样允许跳过 */}
                      <div className="flex items-center gap-3">
                        <button onClick={next} className="text-text2 text-sm hover:text-text">跳过，稍后配置</button>
                        <button onClick={confirmGlobal} disabled={!selectedGlobal || testing}
                          className="bg-accent text-white px-5 py-2 rounded-lg text-sm disabled:opacity-50">{testing ? '测试中...' : '测试并继续'}</button>
                      </div>
                    </div>
                  </div>
                )
              ) : (
                <div className="space-y-2">
                  <input placeholder="服务名称（如 DeepSeek）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <input placeholder="接口地址（如 https://api.deepseek.com/v1）" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <input placeholder="API Key" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  <input placeholder="模型 ID（如 deepseek-chat）" value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                  {testResult && <InlineAlert type={testResult.startsWith('连接成功') ? 'info' : 'error'}>{testResult}</InlineAlert>}
                  <div className="flex justify-between pt-2">
                    <button onClick={back} className="text-text2 text-sm hover:text-text">上一步</button>
                    {/* O1：无 Key 的用户不允许被卡死在模型步骤——先跳过，进入后可随时在设置中补配 */}
                    <div className="flex items-center gap-3">
                      <button onClick={next} className="text-text2 text-sm hover:text-text">跳过，稍后配置</button>
                      <button onClick={submitCustomProvider} disabled={testing}
                        className="bg-accent text-white px-5 py-2 rounded-lg text-sm disabled:opacity-50">{testing ? '测试中...' : '保存并测试'}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 步骤 3：创建 / 选择项目 */}
          {step === 2 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">创建项目</h2>
              <p className="text-text2 text-sm mb-6">MJ Coder 将在项目目录中执行命令、读写文件与 Git 操作。</p>
              <CreateProjectForm onCreated={acceptProject} />
              <div className="flex justify-between mt-4">
                <button onClick={back} className="text-text2 text-sm hover:text-text">上一步</button>
                {/* 本地优先：无项目也必须能走完向导（问答/纯对话不需要项目目录）。
                    此前此步只有「创建项目」一条路，不想建项目的用户被流程锁死 */}
                <button onClick={next} className="text-text2 text-sm hover:text-text">跳过，暂不创建项目</button>
              </div>
            </div>
          )}

          {/* 步骤 4：第一个任务 */}
          {step === 3 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">第一个任务</h2>
              <p className="text-text2 text-sm mb-6">选一个建议开始，或直接进入自己输入。</p>
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
                <button onClick={back} className="text-text2 text-sm hover:text-text">上一步</button>
                <button onClick={finish} className="bg-accent text-white px-5 py-2 rounded-lg text-sm">{chosen ? '用这个任务开始' : '直接进入'}</button>
              </div>
            </div>
          )}

          {/* 步骤 5：完成 */}
          {step === 4 && (
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-accent/15 flex items-center justify-center mx-auto mb-4">
                <IconCheck size={28} className="text-accent" />
              </div>
              <h2 className="text-2xl font-semibold mb-2">准备就绪</h2>
              <p className="text-text2 text-sm mb-8">模型与项目已配置完成。去构建点什么吧。</p>
              <button onClick={finish} className="bg-accent text-white px-6 py-2.5 rounded-xl text-sm">进入 MJ Coder</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
