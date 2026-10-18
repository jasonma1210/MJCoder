// 定时任务的「成败判定」纯函数模块（零依赖 electron，可单测直调）
//
// 为什么单独成模块：判定从「有没有抛异常」长到现在有四条并列的规则（未完成措辞 / 引擎闸门 /
// 零文件写入 / 交付校验降级），继续堆在 scheduler.js 里既顶行数门禁，也没法单独构造输入做
// 优先级断言。这里只做**事实判定**，不碰 store、不发 IPC、不读时钟。
//
// 判定来源与强度（由强到弱，命中即失败，文案取第一个命中的）：
//   ① detectUnfinished —— 模型嘴上说做不到（措辞猜测，只在零工具调用时生效，见下）
//   ② detectExhausted  —— 引擎自己报告「没做完」（闸门事实，与工具调用次数无关）
//   ③ 零文件写入       —— stats.writes === 0（**确定性事实**：任务要求落文件，却一次都没写成功）
//   ④ 交付校验降级     —— V 层判不出 / guardrail FLAG（概率判定，最后兜底）
//
// ③ 的位置刻意在 ① ② 之后：模型如果说了「无法完成」，用户要知道的是「它自己放弃了」，
// 而不是「没产出文件」——后者只是前者的结果。这条优先级有单测钉住。
const { isProviderRefusal } = require('./providerErrors');

// 假成功识别（2026-10-17 事故）：定时任务因宿主漏注入 web 工具，模型回了一整段「无法完成…如实说明」，
// 而 runTask 只在**抛异常**时判 failed，于是这条任务在 UI 上显示「成功」——
// 用户看到的是「成功了，但内容是说做不到」。这是比失败更坏的信号。
//
// 判定刻意保守：只有在**全程没调用过任何工具**且输出明确自述做不到时才判负。
// 有工具调用说明真干了活，结尾一句「部分数据缺失」不该推翻整轮结论。
const FAIL_MARKERS = [
  /无法完成/, /未能完成/, /无法获取/, /不具备/, /工具.{0,12}不存在/, /全部失败/, /没有任何(工具|结果)/,
  /unable to (complete|access|fetch)/i, /not available/i, /cannot complete/i, /no tools? (available|found)/i,
];
function detectUnfinished(output, toolCalls = 0) {
  const text = String(output || '').trim();
  if (!text) return '执行器返回空结果（模型未产出任何内容）';
  // 供应商安全拒答的原文曾被记成 success（真机历史）。它与工具调用次数无关——拒答=没干活
  if (isProviderRefusal(text)) return '供应商以内容安全拒绝了本次请求（不是程序错误），本次没有产出——原文见运行输出';
  if (toolCalls > 0) return '';
  const hit = FAIL_MARKERS.find((re) => re.test(text));
  return hit ? `模型未调用任何工具且自述无法完成（命中「${String(hit).replace(/^\/|\/$/g, '')}」）——请检查任务所需能力是否已配置` : '';
}

// 引擎自己写的「未完成」收尾（熔断/预算耗尽）。与 FAIL_MARKERS 刻意分开：
// FAIL_MARKERS 是**措辞猜测**（模型嘴上说做不到），且只在零工具调用时生效；
// 这里是引擎给出的事实陈述（它确实因为闸门停了），**与工具调用次数无关**。
// 实测事故：抓 50 条新闻的任务被上下文闸停下，输出写着「任务尚未完成」，
// 但卡片显示绿色「成功」——因为 detectUnfinished 见到 toolCalls>0 就直接放行。
const EXHAUSTED_MARKERS = [
  /任务未完全完成/, /上下文已到模型窗口/, /单任务 token 预算已用尽/,
  /单任务执行轮次预算已用尽/, /整任务已运行超过/,
];
function detectExhausted(output) {
  const text = String(output || '');
  const hit = EXHAUSTED_MARKERS.find((re) => re.test(text));
  return hit ? `引擎报告任务未完成（命中「${String(hit).replace(/^\/|\/$/g, '')}」）——已产出部分结果，详见运行输出` : '';
}

// ③ 零写入：无人值守任务的产物形态必须成事实。
//
// 真机事故的核心缺口：用户要「输出一份 md 文档」，trace 里是 5 次工具调用 / 0 次写文件，
// 最终 status 记成 success —— 没有任何东西能发现「产物形态不对」。
// stats 来自 agent-core/verifier.js 的确定性对账（不是关键词猜测）：
//   · writes      —— 成功写入的**写工具**条目数（write_file / edit_file / apply_patch）
//   · shellWrites —— 成功执行的 **shell 重定向写**（`cat > news.md`、`echo ... > x.md`）
// 两者任一 > 0 就算「有产出」：模型完全可能用 shell 重定向写文件，只认 writes 会把
// 「文件真的写了」判成「未产出文件」—— 这是比不判更糟的假失败。
//
// ⚠️ 只在**确实拿到 verify 数据**时判（两个口径都要满足）：
//   · hasVerify === false —— 调用方明确告知「本轮没有 V 层数据」（V 层未接线 / chat 通道 / 判定异常）；
//   · 两个计数里有一个不是有限数字 —— 没收到 ledger（no_ledger）/ level=off / verifier 不可用。
// 把「没数据」当成「没写文件」会造出新的假失败，这比漏判更伤用户信任。
const WRITES_UNKNOWN_HINT = '本轮没有可用的写入统计（V 层未接线或未收到工具台账）';
const isCount = (v) => typeof v === 'number' && Number.isFinite(v);

function detectNoWrite(writes, shellWrites, dir, hasVerify = null, expectsFile = true) {
  // 任务本来就不产出文件（只做 git 提交/只做汇报）时不许判：这是新的假失败，
  // 而且会连续触发 auto-pause 把任务停用 —— 比不判更糟。开关由用户在任务设置里给。
  if (expectsFile === false) return '';
  if (hasVerify === false) return ''; // 调用方已声明无 V 层数据
  if (isCount(writes) && writes > 0) return '';
  if (isCount(shellWrites) && shellWrites > 0) return ''; // shell 重定向写过文件，也算有产出
  // 任一计数未知（含 undefined / null / 非数字）→ 不判：宁可漏判，不可造出「文件写了却说没写」的假失败
  if (!isCount(writes) || !isCount(shellWrites)) return '';
  const where = String(dir || '').trim() || '（本次未解析到产物目录）';
  return `未产出文件：本轮未检测到文件产出（写入 0 次 / shell 重定向 0 次，模型只返回了文本）。产物目录：${where}。`
    + '请检查任务提示词是否明确要求写文件，或模型是否具备写工具（write_file 或 shell 重定向均可）。'
    + '如果这个任务本来就不产生文件（例如只做 git 提交、只做汇报），请在该任务设置里关闭「要求产出文件」。';
}

/**
 * judgeRun({ output, tools, writes, shellWrites, hasVerify, delivery, dir, expectsFile }) → { status, error }
 *   writes / shellWrites —— 成功写入次数与 shell 重定向写次数；非有限数字 = 未知（不参与判定）
 *   hasVerify —— false 表示调用方确认本轮没有 V 层数据（此时即使两个计数都是 0 也不判「未产出文件」）
 *   expectsFile —— false 表示任务不要求产出文件（默认 true）；关掉后零产出不判失败
 *   delivery  —— 主进程 V 层收尾结论 { downgrade, reason }
 * 任一条命中即 failed；多条件同时成立时取**第一个命中**的文案（顺序见文件头）。
 *
 * 为什么「零写入」排在「交付降级」之前：零写入是**可复核的事实**（trace/audit 里查得到），
 * L3 交付降级是**概率判定**（判不出来 / guardrail FLAG）。事实优先，才能避免用户看到
 * 「未通过交付校验：L3 判不出」这种不可行动的文案，而真正该修的是「根本没写文件」。
 */
function judgeRun({
  output = '', tools = 0, writes = null, shellWrites = null, hasVerify = null, delivery = null, dir = '', expectsFile = true,
} = {}) {
  const unfinished = detectUnfinished(output, tools);
  if (unfinished) return { status: 'failed', error: unfinished };
  const exhausted = detectExhausted(output);
  if (exhausted) return { status: 'failed', error: exhausted };
  const noWrite = detectNoWrite(writes, shellWrites, dir, hasVerify, expectsFile);
  if (noWrite) return { status: 'failed', error: noWrite };
  if (delivery && delivery.downgrade) {
    return { status: 'failed', error: `未通过交付校验：${String(delivery.reason || '未提供原因').slice(0, 300)}` };
  }
  return { status: 'success', error: '' };
}

module.exports = {
  judgeRun, detectUnfinished, detectExhausted, detectNoWrite,
  FAIL_MARKERS, EXHAUSTED_MARKERS, WRITES_UNKNOWN_HINT,
};
