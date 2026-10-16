// 任务编排写操作（tasks:*）的 IPC 请求契约 —— zod 运行时校验
//
// 为什么单独成文件（D2，2026-10-16）：
//   tasks:* 是**有副作用的写通道**（改任务状态、恢复被暂停的组、删除任务组）。此前这些
//   handler 直接解构 `{ groupId, taskId }`，畸形载荷（缺字段 / 类型错 / 多余字段注入）
//   会一路走到 store 层才炸，或在最坏情况下被当成「空 id」执行到意外分支。
//   这里把形状固化为 zod schema，主进程在**进入业务逻辑前**校验，不合法即拒绝（fail-closed）。
//
// 与 shared-ipc/contract.mjs 的关系：那个文件覆盖 agent 事件流（高频、只读）；本文件覆盖
// 任务写通道。两者同属 IPC 边界契约，后续可并入同一处，但合并前**不得**各自漂移。
//
// 主进程为 CJS（Electron 33 / Node 20 无法同步 require ESM），故经动态 import + ready 门消费，
// 与 shared-ipc/contract.mjs、shared/untrustedContent.mjs 同一模式。
import { z } from 'zod';

/** 任务组标识：非空字符串（group_id 由编排生成，不可能是空串） */
export const taskGroupRefSchema = z.object({
  groupId: z.string().min(1),
});

/** 子任务引用：组 + 任务双标识 */
export const taskRefSchema = z.object({
  groupId: z.string().min(1),
  taskId: z.string().min(1),
});

/**
 * 重试载荷：在 taskRef 之上增加「已核对副作用」的显式确认位。
 * confirmReview 缺省为 false —— 即默认**要求先核对**（安全默认值，不是宽松默认）。
 */
export const taskRetryPayloadSchema = taskRefSchema.extend({
  confirmReview: z.boolean().optional().default(false),
});

/** 任务组并发上限配置：正整数（上限由 workerPool 自身再钳制到 1..8） */
export const taskConfigPayloadSchema = z.object({
  maxConcurrent: z.number().int().positive().optional(),
});

/**
 * 统一校验入口：返回结构化结果，调用方据此拒绝执行（不抛异常，避免 handler 顶层崩溃）。
 * @param {import('zod').ZodTypeAny} schema
 * @param {unknown} payload
 * @returns {{ok: true, data: unknown} | {ok: false, error: string}}
 */
export function parseIpcPayload(schema, payload) {
  const r = schema.safeParse(payload === undefined ? {} : payload);
  if (r.success) return { ok: true, data: r.data };
  // 只暴露字段路径与原因，不回显整个载荷（避免把敏感/超长内容写进日志与 UI）
  const detail = r.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .slice(0, 5)
    .join('; ');
  return { ok: false, error: `IPC 载荷不合法：${detail}` };
}
