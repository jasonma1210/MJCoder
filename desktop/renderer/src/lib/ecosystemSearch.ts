// 生态中心统一搜索匹配（纯函数，可单测）
//
// 背景（2026-10-16 用户反馈「连接器和技能都无法模糊搜索」）：
// 旧实现只匹配 name / display_name / vendor / category 四个字段，而目录里像
// 「软件」「知识库」「网络」这类词大多只出现在 description 或 capabilities 中
// → 搜这些词**恒为空**，用户感知即「搜索坏了」。
//
// 现规则：
//   ① 按空白**分词**，逐词 AND（每个词都要命中至少一个字段）——多词更精确也更符合直觉；
//   ② 匹配范围扩到各条目的全部可读字段（含数组与嵌套对象的取值，如 env_vars 的名称与标签）；
//   ③ 大小写不敏感，子串匹配（对中文即「模糊搜索」）。
//
// 注意：本模块只负责「该不该出现在结果里」，不负责排序或高亮。

type Rec = Record<string, unknown>;

/** 分词：按空白切分并小写化；无输入时返回空数组（调用方据此跳过过滤） */
export function searchTokens(keyword: unknown): string[] {
  return String(keyword ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** 把任意字段（含数组 / 嵌套对象）摊平成小写字符串数组；null / undefined / 空串剔除 */
export function haystack(fields: unknown): string[] {
  const flat: unknown[] = [];
  const walk = (v: unknown): void => {
    if (v == null || v === '') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.values(v as Rec).forEach(walk); return; }
    flat.push(v);
  };
  walk(fields);
  return flat.map((x) => String(x).toLowerCase());
}

/** 逐词 AND 匹配：每个词都要命中干草堆的某一项；tokens 为空时恒真（即不过滤） */
export function matchesTokens(fields: unknown, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = haystack(fields);
  return tokens.every((tk) => hay.some((h) => h.includes(tk)));
}

/** 连接器可搜字段（含 env_vars 的 name/label 与 permissions 的 level/scope） */
export function connectorFields(c: Rec): unknown[] {
  return [
    c.id, c.name, c.display_name, c.vendor, c.category, c.description,
    c.capabilities, c.tags, c.notes, c.transport, c.auth_type, c.auth_mode, c.maturity,
    c.env_vars, c.permissions,
  ];
}

/** 技能可搜字段 */
export function skillFields(s: Rec): unknown[] {
  return [s.id, s.name, s.display_name, s.category, s.description, s.tags, s.notes, s.tools_required];
}

/** 数字员工可搜字段 */
export function employeeFields(e: Rec): unknown[] {
  return [e.id, e.name, e.title_cn, e.title, e.category, e.industry, e.summary, e.description, e.tags, e.prompt];
}

/** 便捷入口：直接从条目对象判定（组件侧一行调用） */
export function entryMatches(kind: 'connector' | 'skill' | 'employee', entry: Rec, tokens: string[]): boolean {
  const fields = kind === 'connector' ? connectorFields(entry)
    : kind === 'skill' ? skillFields(entry)
      : employeeFields(entry);
  return matchesTokens(fields, tokens);
}
