// 内置（prompt 型）技能清单——2026-10-16 自 LocalSkillsSection.tsx 提取共享。
// 背景（用户实测反馈）：内置技能（BUILTIN_SKILL_IDS，引擎 prompt 技能）此前只在
// 生态中心「本地技能」区可见，「+」菜单技能面板根本不渲染它们——用户启用了也选不到。
// id 用下划线形态（与 agent-core BUILTIN_SKILL_IDS 一致）；匹配一律经 lib/skillKey 归一化。
export interface BuiltinSkill {
  id: string;
  nameKey: string;   // i18n key（中文名）
  descKey: string;   // i18n key（中文描述）
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { id: 'code_review', nameKey: 'settings.skillCodeReview', descKey: 'settings.skillCodeReviewDesc' },
  { id: 'gen_docs', nameKey: 'settings.skillGenDocs', descKey: 'settings.skillGenDocsDesc' },
  { id: 'gen_tests', nameKey: 'settings.skillGenTests', descKey: 'settings.skillGenTestsDesc' },
  { id: 'git_commit', nameKey: 'settings.skillGitCommit', descKey: 'settings.skillGitCommitDesc' },
  { id: 'deep_research', nameKey: 'settings.skillDeepResearch', descKey: 'settings.skillDeepResearchDesc' },
  { id: 'latex_compile', nameKey: 'settings.skillLatexCompile', descKey: 'settings.skillLatexCompileDesc' },
  { id: 'latex_doctor', nameKey: 'settings.skillLatexDoctor', descKey: 'settings.skillLatexDoctorDesc' },
];
