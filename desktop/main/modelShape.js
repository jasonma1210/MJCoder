// 模型参数的两种形状 —— 全项目唯一转换事实来源
//
// 事故背景（2026-10-15 真机）：自动 DAG（orchestrate_task）的每个子任务第 1 轮即崩，
// 报 `Cannot read properties of undefined (reading 'id')`。根因是本项目里 model 对象
// 存在两套形状，且各调用链手抄转换、逐步漂移：
//
//   扁平形 { providerId, isGlobal, baseUrl, model, cwd? }
//     —— 模型设置/定时任务/编排器/聊天通道（chatStreamOnce、scheduledAgentChat）使用
//   嵌套形 { provider: { id, isGlobal, base_url }, model: { model_id, context_window } }
//     —— agent-core 的 runAgent / compactHistory / decomposeTask 使用
//
// 定时任务路径在 main.js 里手写过一次扁平→嵌套转换，Worker 路径（workerPool.js）漏了，
// 直接把 resolveTaskModel() 的扁平对象喂给 runAgent → model.provider 为 undefined
// → 第 3 方看不懂的 TypeError，被引擎当成「模型调用失败」记日志后降级。
//
// 修法：转换逻辑只此一份，三条调用链统一引用；任何形状都能进，出参形状由调用点决定。
// 新增调用链时只需 require 本模块，不复写转换——从结构上杜绝再次漂移。

// P0-1⑦: 默认窗口统一由 main/modelWindows.js 拥有（此前本文件写死 128000）。
// 「两侧错配代价不对称」——低估只早压（浪费 token），高估则压缩永不触发（直接击穿上下文）
// → 表外未知模型取 32768；主力模型由映射表覆盖，不靠这个默认值兜。
const { DEFAULT_CONTEXT_WINDOW, resolveWindow } = require('./modelWindows');

// 声明值优先；未声明时按 (providerKind, modelId) 查映射表，最后才落默认档。
// 为什么转换层就要查：Worker / 定时任务 / 编排组的模型对象是扁平形
// （main.js 的 resolveTaskModel 只产 { providerId, isGlobal, baseUrl, model }），
// 若一律补默认档，128K 的主模型在 Worker 里会被按 32K 提前压缩 4 倍。
function windowOf({ declared, providerId, baseUrl, modelId }) {
  const d = Number(declared) > 0 ? Number(declared) : 0;
  if (d > 0) return d;
  const resolved = resolveWindow({ providerId, baseUrl, modelId });
  return Number(resolved?.window) > 0 ? Number(resolved.window) : DEFAULT_CONTEXT_WINDOW;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 判定是否为嵌套形（以 provider 子对象存在为准；扁平形的顶层 providerId 与之互斥）
function isNested(m) {
  return isPlainObject(m) && isPlainObject(m.provider);
}

/**
 * 任一形状 → 嵌套形（agent-core runAgent 的契约）。
 * @param {object} m  扁平形或嵌套形
 * @returns {{provider: {id: string, isGlobal: boolean, base_url: string}, model: {model_id: string, context_window: number}}}
 * @throws 形状不可用（缺 providerId 或 model_id）时抛明确错误，而不是让下游抛
 *         `Cannot read properties of undefined`。
 */
function toAgentModel(m) {
  if (!isPlainObject(m)) {
    throw new Error('模型参数无效：需要对象，实为 ' + typeof m);
  }
  if (isNested(m)) {
    // 已是嵌套形：只补齐缺省字段，不动原值
    return {
      provider: {
        id: m.provider.id ?? '',
        isGlobal: !!m.provider.isGlobal,
        base_url: m.provider.base_url || '',
      },
      model: {
        model_id: m.model?.model_id ?? '',
        context_window: windowOf({
          declared: m.model?.context_window,
          providerId: m.provider.id,
          baseUrl: m.provider.base_url,
          modelId: m.model?.model_id ?? '',
        }),
        // P0-3②: 思考强度必须随形状转换带上——否则 Worker / 定时任务 / 编排组
        // 恒为服务端默认（引擎侧已按 model.model.reasoning_effort 下发，缺这里就断链）
        reasoning_effort: m.model?.reasoning_effort || m.model?.reasoningEffort || '',
        // B1-B-02（F-003）：能力位必须随形状转换带上——与上面 reasoning_effort 踩的是
        // **同一个洞**（P0-3② 已修过一次，caps 又踩了一遍）。本函数重建对象时只挑字段，
        // 不带上就等于把能力声明抹掉，于是下面三条链路全部断链：
        //   · Worker（workerPool 用 toAgentModel(resolveModel()) 作为子任务模型）
        //   · 定时任务（scheduler 通道同样经本函数转嵌套形）
        //   · 编排组（orchestrator / orchestrate_task 的 resolveModel 结果）
        // 后果：用户把某模型标为「不支持 tool calling」，主对话按能力门裁剪了工具，
        // 这三条链路却仍是全量工具——同一个开关在两条路径上结论相反（引擎侧
        // resolveSupportsToolCall 只能读到传进来的东西，转换层不搬它就恒为缺省 true）。
        // 只在来源确实声明过 caps 时才带（不造空对象：空对象会被下游读成「已声明但无字段」）。
        ...(isPlainObject(m.model?.caps) ? { caps: { ...m.model.caps } } : {}),
      },
    };
  }
  const modelId = String(m.model || '');
  if (!modelId) {
    throw new Error('模型参数无效：缺少 model（扁平形需提供 model 字段，嵌套形需提供 model.model_id）');
  }
  return {
    provider: {
      id: m.providerId ?? '',
      isGlobal: !!m.isGlobal,
      base_url: m.baseUrl || '',
    },
    model: {
      model_id: modelId,
      context_window: windowOf({
        declared: m.contextWindow ?? m.context_window,
        providerId: m.providerId,
        baseUrl: m.baseUrl || m.base_url,
        modelId,
      }),
      // P0-3②: 扁平形的思考强度字段名有两种历史写法（reasoning_effort / reasoningEffort）
      reasoning_effort: m.reasoning_effort || m.reasoningEffort || '',
      // B1-B-02（F-003）：扁平形的工具调用能力位同样必须随转换带上（理由见嵌套形分支）。
      // 扁平侧有**两种历史写法**，都要认（与 reasoning_effort 的双写法同理）：
      //   · m.caps —— localStore 的 providerModel 条目（{ caps: { supportsToolCall: false } }）
      //   · m.supportsToolCall —— ~/.mjcode/models.json 的扁平条目（modelsFile.serializeProviders
      //     把非默认能力实心化成顶层 supportsToolCall:false）
      // 只吞对象/布尔两种形状，其余（字符串 "false" 之类）不猜——宁可缺省也不误判。
      ...(isPlainObject(m.caps)
        ? { caps: { ...m.caps } }
        : (typeof m.supportsToolCall === 'boolean' ? { caps: { supportsToolCall: m.supportsToolCall } } : {})),
    },
  };
}

/**
 * 任一形状 → 扁平形（聊天通道 chatStreamOnce / scheduledAgentChat 的契约）。
 */
function toChatRequest(m) {
  if (!isPlainObject(m)) return { providerId: '', isGlobal: false, baseUrl: '', model: '' };
  if (isNested(m)) {
    return {
      providerId: m.provider.id ?? '',
      isGlobal: !!m.provider.isGlobal,
      baseUrl: m.provider.base_url || '',
      model: m.model?.model_id ?? '',
    };
  }
  return {
    providerId: m.providerId ?? '',
    isGlobal: !!m.isGlobal,
    baseUrl: m.baseUrl || '',
    model: m.model ?? '',
  };
}

/**
 * 校验 agent-core 收到的 model 是否可用，不可用时抛**可诊断**的错误。
 * 目的是把 `Cannot read properties of undefined (reading 'id')` 这类无信息量的
 * TypeError 挡在入口，换成指明缺哪个字段、期望哪种形状的消息。
 */
function assertAgentModel(m) {
  if (!isPlainObject(m)) {
    throw new Error('模型参数无效：需要对象，实为 ' + typeof m);
  }
  if (!isPlainObject(m.model) || !m.model.model_id) {
    throw new Error('模型参数形状错误：缺少 model.model_id（期望嵌套形 { provider:{id,base_url}, model:{model_id} }）');
  }
  if (!isPlainObject(m.provider)) {
    throw new Error('模型参数形状错误：缺少 provider 对象（期望嵌套形 { provider:{id,base_url}, model:{model_id} }；'
      + '若为扁平形 { providerId, baseUrl, model }，请先用 toAgentModel() 转换）');
  }
  return true;
}

// ── T5-7：per-agent 模型绑定的**引用串**编解码（军团成员 model 字段的唯一事实来源）──
//
// 为什么存「引用串」而不是 provider/model 快照对象：
//   · 供应商会被改名、换 Key、整条删除，快照会变成指向已不存在资源的死引用；
//   · 只存 id 才能做到「解析不到就安静回落默认模型」——与渲染层 threadModels 同一纪律。
// 为什么放在本文件：本文件已是「模型形状的唯一转换处」，绑定串与模型形状同层同源最省心。
// 复合键分隔符沿用仓库既有约定（main/scheduledGuard.js 的 `${handlerKey}::${cmd}`）。
const MODEL_REF_JOIN = '::';
// 上限与 shared-ipc/contract.mjs 的 rolePreset.model schema 同值（改一处必须同步另一处）
const MODEL_REF_MAX = 160;
const MODEL_REF_PROVIDER_MAX = 30; // 160 - 2 - 128（modelId 上限 128）
const MODEL_REF_MODEL_MAX = 128;

function refStr(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * {providerId, modelId} → `providerId::modelId`；任一侧缺失/含分隔符/超长 → null。
 * fail-closed：宁可存 null（= 用默认模型），也不存一条解析不出来的脏引用。
 */
function encodeModelRef(ref) {
  if (!isPlainObject(ref)) return null;
  const pid = refStr(ref.providerId);
  const mid = refStr(ref.modelId);
  if (!pid || !mid) return null;
  // 分隔符两侧都不能含：否则拼出的串切分点不唯一，无法无损还原
  if (pid.includes(MODEL_REF_JOIN) || mid.includes(MODEL_REF_JOIN)) return null;
  if (pid.length > MODEL_REF_PROVIDER_MAX || mid.length > MODEL_REF_MODEL_MAX) return null;
  const s = pid + MODEL_REF_JOIN + mid;
  return s.length > MODEL_REF_MAX ? null : s;
}

/**
 * `providerId::modelId` → {providerId, modelId}；结构不合法 → null（**绝不抛**，调用方回落默认模型）。
 * 按第一个分隔符切分：编码时已保证 providerId 不含分隔符，故切分无损。
 */
function decodeModelRef(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s || s.length > MODEL_REF_MAX) return null;
  const i = s.indexOf(MODEL_REF_JOIN);
  if (i <= 0) return null;
  const providerId = s.slice(0, i);
  const modelId = s.slice(i + MODEL_REF_JOIN.length);
  if (!providerId || !modelId) return null;
  if (providerId.includes(MODEL_REF_JOIN) || modelId.includes(MODEL_REF_JOIN)) return null;
  return { providerId, modelId };
}

/**
 * 边界归一（**唯一**的模型绑定清洗点）：接受两种自然入参——
 *   · 引用串（落库形态，`providerId::modelId`）
 *   · 引用对象（渲染层选择器的天然形态，{providerId, modelId}）
 * 统一产出 canonical 引用串；任何解析不出的输入 → null（= 用默认模型）。
 * 两种入参都收在此处，是为了让「什么能落库」只有一个判据，下游不得各自解释格式。
 */
function canonicalizeModelRef(v) {
  if (v == null || v === '') return null;
  if (isPlainObject(v)) return encodeModelRef(v);
  return encodeModelRef(decodeModelRef(refStr(v)));
}

/**
 * 引用串 → **扁平形**模型对象（本模块既有形状契约；要喂 agent-core 请再经 toAgentModel）；
 * 解析不到返回 null（供应商/模型已被删除 ⇒ 调用方回落默认模型）。
 * providers 取自主进程本机供应商列表（localStore.listProviders）：`{ id, base_url, models:[{modelId, caps?}] }`。
 * id 一律按字符串比较（本机是自增数字、服务端是 's…' 串，两种都合法）。
 */
function resolveModelRef(ref, providers) {
  const d = decodeModelRef(refStr(ref));
  if (!d) return null;
  const list = Array.isArray(providers) ? providers : [];
  const p = list.find((x) => x && refStr(x.id) === d.providerId);
  if (!p) return null;
  const models = Array.isArray(p.models) ? p.models : [];
  const m = models.find((x) => x && refStr(x.modelId != null ? x.modelId : x.model_id) === d.modelId);
  if (!m) return null;
  return {
    providerId: d.providerId,
    isGlobal: !!p.isGlobal,
    baseUrl: p.base_url || '',
    model: d.modelId,
    // 只在本机确实声明过 caps 时才带（不造空对象：空对象会被下游读成「已声明但无字段」）
    ...(isPlainObject(m.caps) ? { caps: { ...m.caps } } : {}),
  };
}

module.exports = {
  toAgentModel, toChatRequest, assertAgentModel, isNested, DEFAULT_CONTEXT_WINDOW,
  MODEL_REF_MAX, encodeModelRef, decodeModelRef, canonicalizeModelRef, resolveModelRef,
};
