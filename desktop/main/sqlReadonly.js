// SQL 只读判定 —— 单一事实来源（从 approval.js 抽出，2026-10-21）
//
// 抽出的直接原因：为落地 D-801（toolLevel 兜底改 L3）向 approval.js 补了方向说明注释，
// 使该文件 798 → 811 行、越过 800 行软档。按本项目纪律「先拆再合入、白名单只减不增」，
// 把一块**纯函数**搬出来，而不是给 approval.js 加白名单、也不是把注释删薄充数。
//
// 为什么这块值得独立成一个模块：
//   两个消费方必须用同一份判定，否则就是「审批层以为只读、执行层却照跑」的错位：
//     · approval.toolLevel('sqlite', …)：只读语句不弹卡，写语句按 L3；
//     · nativeTools.toolSqlite：action=query 只接受只读语句（sql.js 的 all()/step() 对
//       DELETE/UPDATE 同样会真实执行，只按 action 分流等于给模型留了绕过审批的口子）。
//   把「同一份判定」放进一个有名字的模块，比让它散在 approval.js 中部更容易被后来者找到。
//
// 语义与抽走前**逐字等价**（搬家，不是改造）：
//   剥掉前导空白与 SQL 注释后，首关键字落在只读白名单内才算只读；空语句一律判非只读
//   （fail-closed —— 空语句没有可判定的语义，按最保守侧处理）。

'use strict';

const READONLY_SQL_RE = /^(select|pragma|explain|with|values)\b/i;

function stripLeadingSqlNoise(sql) {
  let s = String(sql || '');
  for (;;) {
    const next = s.replace(/^\s+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '');
    if (next === s) return s;
    s = next;
  }
}

function isReadonlySql(sql) {
  const s = stripLeadingSqlNoise(sql);
  if (!s) return false; // 空语句一律按「非只读」保守处理（fail-closed）
  return READONLY_SQL_RE.test(s);
}

module.exports = { isReadonlySql, READONLY_SQL_RE };
