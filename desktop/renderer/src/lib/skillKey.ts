// 技能键归一化（2026-10-16，用户实测反馈修复）
// 背景：技能键有三个来源且形态不一——
//   内置技能 id 用下划线（code_review，BUILTIN_SKILL_IDS/引擎 prompt 技能）；
//   磁盘技能 dir/frontmatter.name 用连字符（code-review，~/.mjcode/skills/<dir>）；
//   生态目录条目 id 与落盘 slug 通常一致但历史上混入过下划线形态。
// 启用集（mj_enabled_skills）三者混存，导致「+」菜单与生态中心互相看不见对方
// 启用的技能（用户实测：生态中心 13 个已启用，+ 菜单默认只有 2 个）。
// 归一化规则：小写 + 下划线/空白 → 连字符。两侧键都经 normSkillKey 后再比对。

export function normSkillKey(key: string | null | undefined): string {
  return String(key || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/** 归一化匹配：key 是否命中 keys 集合中的任一项（两侧都归一化） */
export function skillKeyIn(key: string | null | undefined, keys: Array<string | null | undefined>): boolean {
  const k = normSkillKey(key);
  if (!k) return false;
  return keys.some((x) => normSkillKey(x) === k);
}

/** 从一组候选键中返回命中启用集的那一个（无命中返回 null）——用于过滤函数返回原始键 */
export function matchSkillKey(candidates: Array<string | null | undefined>, enabledSet: Set<string>): string | null {
  for (const c of candidates) {
    if (c && enabledSet.has(normSkillKey(c))) return String(c);
  }
  return null;
}

/** 把键集合整体归一化为 Set（供多次匹配复用） */
export function normSkillKeySet(keys: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const n = normSkillKey(k);
    if (n) out.add(n);
  }
  return out;
}
