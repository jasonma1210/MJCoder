// M5 / T5-2 + T5-6：团队总线消息的**展示口径单一事实来源**。
//
// 两个消费者：团队详情页（TeamsPage）与对话内团队事件流（TeamRunStream）。
// 如果各自维护一份 KIND_LABEL / SYS_LABEL，新增一种系统留痕时必然只改一处，
// 表现为「详情页显示中文、对话卡显示裸 key」——所以口径必须收敛到这里。
//
// 只存 i18n key、不存文案：渲染时经 t() 求值，切语言即时生效；
// 落库的 summary 是面向模型的中性机器文本，界面不直接渲染它（系统消息走 payload.sys 翻译）。

// 消息种类 → i18n key（未知种类回落 system，fail-closed）
export const KIND_LABEL = {
  assign: 'teams.msgKindAssign',
  handoff: 'teams.msgKindHandoff',
  question: 'teams.msgKindQuestion',
  report: 'teams.msgKindReport',
  artifact_ref: 'teams.msgKindArtifactRef',
  system: 'teams.msgKindSystem',
};

// 生命周期系统广播子类 → i18n key
export const SYS_LABEL = {
  teamCreated: 'teams.msgSysTeamCreated',
  memberAdded: 'teams.msgSysMemberAdded',
  leadSet: 'teams.msgSysLeadSet',
  leadCreated: 'teams.msgSysLeadCreated',
  teamArchived: 'teams.msgSysTeamArchived',
  memberSessionReset: 'teams.msgSysMemberSessionReset',
  // M5 / T5-10：中断留痕（三主体矩阵统一写 system 消息，见 main/teamInterrupt.js）
  interrupt: 'teams.msgSysInterrupt',
};

/** 消息种类标签 key：未知种类回落 system（绝不渲染裸 kind 字符串） */
export function kindKey(kind) {
  return KIND_LABEL[String(kind || '')] || KIND_LABEL.system;
}

/**
 * 消息正文：系统广播按 payload.sys 翻译 + 追加对象名/理由；其余直接展示 summary。
 *
 * T5-10：中断留痕必须带上理由（Lead 中断要求理由非空，§9.2）——若只展示对象名，
 * 「为什么被打断」在界面上永久丢失，审计价值归零。理由由渲染层原样展示，不二次改写。
 */
export function messageText(t, m) {
  const sys = m && m.payload ? m.payload.sys : null;
  if (sys && SYS_LABEL[sys]) {
    const parts = [t(SYS_LABEL[sys])];
    if (m.payload && m.payload.name) parts.push(m.payload.name);
    if (m.payload && m.payload.reason) parts.push(m.payload.reason);
    return parts.join(' · ');
  }
  return (m && m.summary) || '';
}
