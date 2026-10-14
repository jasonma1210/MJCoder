// P1-6：Aggregator v1——代码级结果聚合（纯函数，可单测）
// 双模式裁剪：本轮实现「代码聚合」；LLM 聚合模式按计划延后 P2。
// 职责：
//   1. 结构化结果合并：按任务序拼接结论/产物，非关键失败降级为 warnings
//   2. patch 冲突检测：多个子任务的补丁触碰同一文件 → 报冲突（不静默合并）
const { patchTargets } = require('../writeGuard');

// subResults: [{ taskId, title, ok, result, error, critical }]
// result 约定：Worker 产出 { summary: string, patches?: [{path, patch}], artifacts?: string[] }
function aggregateGroup(subResults) {
  const warnings = [];
  const failed = [];
  const merged = { summary: [], artifacts: [], patches: [] };
  for (const r of subResults) {
    if (r.ok) {
      const res = r.result && typeof r.result === 'object' ? r.result : { summary: String(r.result ?? '') };
      merged.summary.push({ taskId: r.taskId, title: r.title, text: String(res.summary || '').slice(0, 4000) });
      for (const a of res.artifacts || []) merged.artifacts.push({ taskId: r.taskId, path: String(a) });
      for (const p of res.patches || []) merged.patches.push({ taskId: r.taskId, path: String(p.path || ''), patch: String(p.patch || '') });
    } else if (r.critical) {
      failed.push({ taskId: r.taskId, title: r.title, error: r.error || '关键任务失败' });
    } else {
      warnings.push(`非关键任务「${r.title}」(${r.taskId}) 失败已降级：${String(r.error || 'unknown').slice(0, 200)}`);
    }
  }
  // patch 冲突检测：同一路径被 ≥2 个不同任务的补丁触碰 → 冲突（交由上层决定重跑/人工合并）
  const byPath = new Map();
  for (const p of merged.patches) {
    if (!byPath.has(p.path)) byPath.set(p.path, new Set());
    byPath.get(p.path).add(p.taskId);
  }
  const conflicts = [...byPath.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([path, ids]) => ({ path, taskIds: [...ids] }));
  // 兜底：即使未声明 patches，也可从 result_json 文本提取 unified diff 目标做冲突检测
  return { merged, warnings, failed, conflicts };
}

// 从子任务原始结果文本中提取 patch 目标（writeGuard 复用），用于冲突检测的防御性补充
function extractPatchTargetsFromText(text) {
  return patchTargets(String(text || ''));
}

module.exports = { aggregateGroup, extractPatchTargetsFromText };
