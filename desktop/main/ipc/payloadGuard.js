// 写通道载荷校验（X14）
//
// 现状：168 条 IPC 通道里只有 `agent:run` + `tasks:*` 走 zod 契约，其余写通道直接解构
// 载荷（`async (_, { name, base_url }) => ...`）。后果有三类：
//   ① 类型漂移：`id` 传成对象/数组时，绑定到 SQL 参数后写进库的是 `[object Object]`；
//   ② 长度失控：超长 name/base_url 直接落库，读回来时撑爆 UI；
//   ③ 必填缺失：`addProvider({})` 也能写一条空记录，UI 侧表现为"多了一条空白服务"。
// 这些都不会崩，只会写脏数据——所以必须在**写之前**拦。
//
// 设计取舍：
//   · 不追求全覆盖（43 条写通道逐个补 schema 成本过高），只覆盖「写用户数据/凭证/调度」的高风险通道；
//   · 失败用 throw（沿用既有 `throw new Error('本地数据层未初始化')` 的约定），
//     而不是返回 `{ok:false}`——这些通道的成功返回值有的不是信封（如 provider 对象），
//     混入 `{ok:false}` 会让调用方解构出 undefined；
//   · 只校验形状与上限，不校验业务语义（URL 合法性等交给上层），避免误伤既有调用。
class PayloadError extends Error {
  constructor(message) {
    super(`载荷非法：${message}`);
    this.name = 'PayloadError';
    this.code = 'INVALID_PAYLOAD';
  }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 必须是普通对象（写通道的载荷都是对象；数组/标量一律拒绝） */
function assertObject(payload, label = 'payload') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PayloadError(`${label} 必须是对象（收到 ${typeOf(payload)}）`);
  }
  return payload;
}

/**
 * 字符串字段规则。spec 形如 { name: 200, api_key: { max: 4000, optional: true } }
 * - 默认必填、非空、去空格后不能为空串
 * - optional: true 允许缺省（undefined/null）
 * - allowEmpty: true 允许空串（如「暂不填 Key」）
 */
function assertStrings(payload, spec, label = 'payload') {
  assertObject(payload, label);
  for (const [key, raw] of Object.entries(spec)) {
    const opt = typeof raw === 'number' ? { max: raw } : raw;
    const { max = 500, optional = false, allowEmpty = false } = opt;
    const value = payload[key];
    if (value === undefined || value === null) {
      if (optional) continue;
      throw new PayloadError(`${key} 必填`);
    }
    if (typeof value !== 'string') {
      throw new PayloadError(`${key} 必须是字符串（收到 ${typeOf(value)}）`);
    }
    if (!allowEmpty && value.trim() === '') {
      throw new PayloadError(`${key} 不能为空`);
    }
    if (value.length > max) {
      throw new PayloadError(`${key} 超长（${value.length} > ${max}）`);
    }
  }
  return payload;
}

/** 数值型 id（本机 provider/model 用的是自增数字，允许数字字符串，但拒绝对象/数组） */
function assertIds(payload, keys, label = 'payload') {
  assertObject(payload, label);
  for (const key of keys) {
    const value = payload[key];
    // 空串必须显式拒绝：`Number('')` 是 0，会被当成合法 id 0
    if (value === undefined || value === null || value === '') throw new PayloadError(`${key} 必填`);
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new PayloadError(`${key} 必须是数字或纯数字字符串（收到 ${typeOf(value)}）`);
    }
  }
  return payload;
}

/**
 * 「id 有多种合法形态」的字段：数字（本机自增 id）或非空字符串（厂商名 / 's…' 前缀 / 全局 id）。
 *
 * 为什么不能直接用 assertStrings 或 assertIds（2026-10-18 用户实测）：
 *   定时任务卡片改模型报「载荷非法：providerId 必须是字符串（收到 number）」——
 *   本机 provider 的 id 是自增**数字**，用只收字符串的断言会把**合法主路径**整个拦掉。
 *   反向也不能用 assertIds：全局/服务端 provider 的 id 是字符串（见 main.js 里
 *   「providerId 不在此列：本机 provider 是数字 id、服务端是 's…' 前缀串，两种形态都合法」）。
 *   这与 2026-10-17 的 local:messages/add 事故同型：校验加严却没带正样本，把真实调用挡在门外。
 *
 * 语义：键缺省（undefined/null）视为「未提供」，由调用方决定是否回落；空串明确拒绝。
 * @param {object} payload
 * @param {string[]} keys
 * @param {string} [label]
 */
function assertIdLike(payload, keys, label = 'payload') {
  assertObject(payload, label);
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null) continue; // 未提供 ≠ 非法
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new PayloadError(`${key} 必须是有限数字（收到 ${value}）`);
      continue;
    }
    if (typeof value === 'string') {
      if (value.trim() === '') throw new PayloadError(`${key} 不能为空`);
      continue;
    }
    throw new PayloadError(`${key} 必须是数字或非空字符串（收到 ${typeOf(value)}）`);
  }
  return payload;
}

/** 标识符型（threadId/projectPath 这类不透明串）：非空、无空白、有上限 */
function assertTokens(payload, spec, label = 'payload') {
  assertObject(payload, label);
  for (const [key, raw] of Object.entries(spec)) {
    const opt = typeof raw === 'number' ? { max: raw } : raw;
    const { max = 512, optional = false } = opt;
    const value = payload[key];
    if (value === undefined || value === null || value === '') {
      if (optional) continue;
      throw new PayloadError(`${key} 必填`);
    }
    if (typeof value !== 'string') {
      throw new PayloadError(`${key} 必须是字符串（收到 ${typeOf(value)}）`);
    }
    if (/\s/.test(value)) throw new PayloadError(`${key} 不能包含空白字符`);
    if (value.length > max) throw new PayloadError(`${key} 超长（${value.length} > ${max}）`);
  }
  return payload;
}

/** 数组字段（如 messages 批量替换）：限长度上限，避免一次 IPC 撑爆内存 */
function assertArray(payload, key, { max, min = 0 } = {}, label = 'payload') {
  assertObject(payload, label);
  const value = payload[key];
  if (!Array.isArray(value)) throw new PayloadError(`${key} 必须是数组（收到 ${typeOf(value)}）`);
  if (value.length < min) throw new PayloadError(`${key} 至少 ${min} 项`);
  if (typeof max === 'number' && value.length > max) throw new PayloadError(`${key} 太多（${value.length} > ${max}）`);
  return payload;
}

/** 枚举字段（状态、角色这类闭集）：值必须命中白名单 */
function assertEnum(payload, key, values, label = 'payload') {
  assertObject(payload, label);
  const value = payload[key];
  if (!values.includes(value)) {
    throw new PayloadError(`${key} 取值非法（收到 ${JSON.stringify(value)}，应为 ${values.join(' / ')}）`);
  }
  return payload;
}

module.exports = {
  PayloadError,
  assertObject,
  assertStrings,
  assertIds,
  // 「数字或非空字符串」的 id（providerId 两种形态都合法，见函数上方注释）
  assertIdLike,
  assertTokens,
  assertArray,
  assertEnum,
};
