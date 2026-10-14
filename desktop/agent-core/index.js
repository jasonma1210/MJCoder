// mj-code-agent-core：headless Agent 引擎（从 Electron 渲染层抽离）
// 工具调用循环：用户消息 → LLM → tool_calls → 执行 → 结果回传 → LLM → ... 直至完成
// 引擎内部零 window / 零 Electron 依赖：所有工具与模型调用经 toolHandlers 注入；
// 未提供 toolHandlers 时回落 globalThis.window.mjcode（兼容旧调用方）。

// ── node:fs 惰性获取（仅 sessionDir 落盘时需要）──
// 渲染层经 Vite 打包：这里不写静态 import，用 process.getBuiltinModule 同步获取，
// 失败时动态 import 兜底（@vite-ignore 避免 Vite 解析 node: 前缀）。
let _fsModule;
function getNodeFs() {
  if (_fsModule !== undefined) return _fsModule;
  try {
    _fsModule = globalThis.process?.getBuiltinModule?.('node:fs') || null;
  } catch {
    _fsModule = null;
  }
  return _fsModule;
}
async function ensureNodeFs() {
  if (getNodeFs()) return getNodeFs();
  try {
    const m = await import(/* @vite-ignore */ 'node:' + 'fs');
    _fsModule = m.default || m;
  } catch {
    _fsModule = null;
  }
  return _fsModule;
}

export const BASE_TOOLS = [
  { type: 'function', function: {
    name: 'shell', description: '在项目目录执行 shell 命令（git/npm/ls/cat/build/test 等）',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: { type: 'string', description: '工作目录（可选）' },
    }, required: ['command'] },
  }},
  { type: 'function', function: {
    name: 'read_file', description: '读取文件内容。相对路径以当前项目目录为基准',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '文件路径，相对路径以当前项目目录为基准' },
      offset: { type: 'number', description: '起始行号（可选）' },
      limit: { type: 'number', description: '读取行数（可选）' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'write_file', description: '写入文件（创建或覆盖）',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    }, required: ['path', 'content'] },
  }},
  { type: 'function', function: {
    name: 'edit_file', description: '搜索并替换文件中的文本',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '文件路径' },
      search: { type: 'string', description: '要查找的精确文本' },
      replace: { type: 'string', description: '替换文本' },
    }, required: ['path', 'search', 'replace'] },
  }},
  { type: 'function', function: {
    name: 'apply_patch', description: '应用 unified diff 格式的补丁',
    parameters: { type: 'object', properties: {
      patch: { type: 'string', description: 'diff -u 格式的补丁内容' },
    }, required: ['patch'] },
  }},
  { type: 'function', function: {
    name: 'list_dir', description: '列出目录内容。相对路径以当前项目目录为基准',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '目录路径，相对路径以当前项目目录为基准' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'grep', description: '在文件中搜索文本',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: '搜索模式' },
      path: { type: 'string', description: '搜索目录' },
    }, required: ['pattern'] },
  }},
  { type: 'function', function: {
    name: 'glob', description: '按文件名模式查找文件',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: '文件名模式（如 *.js）' },
      path: { type: 'string', description: '搜索目录' },
    }, required: ['pattern'] },
  }},
  // Git
  { type: 'function', function: {
    name: 'git_status', description: '查看 git 工作区状态',
    parameters: { type: 'object', properties: {} },
  }},
  { type: 'function', function: {
    name: 'git_diff', description: '查看 git 变更差异',
    parameters: { type: 'object', properties: {
      staged: { type: 'boolean', description: '是否查看暂存区' },
    } },
  }},
  { type: 'function', function: {
    name: 'git_log', description: '查看 git 提交历史',
    parameters: { type: 'object', properties: {
      count: { type: 'number', description: '条数（默认10）' },
    } },
  }},
  { type: 'function', function: {
    name: 'git_commit', description: '提交变更到 git',
    parameters: { type: 'object', properties: {
      message: { type: 'string', description: '提交信息' },
    }, required: ['message'] },
  }},
  // 子代理
  { type: 'function', function: {
    name: 'spawn_subagent', description: '启动子代理处理独立子任务，适合并行探索或复杂任务分解',
    parameters: { type: 'object', properties: {
      objective: { type: 'string', description: '子代理的目标描述' },
      task_type: { type: 'string', description: '任务类型: explore/implement/review/test' },
    }, required: ['objective'] },
  }},
];

const SKILL_PROMPTS = {
  code_review: `\n\n## 代码审查技能\n当审查代码时：\n1. 检查潜在 bug 和边界条件\n2. 检查安全漏洞\n3. 检查性能问题\n4. 检查代码风格一致性\n5. 给出具体改进建议`,
  gen_docs: `\n\n## 文档生成技能\n生成文档时：\n1. 说明功能用途\n2. 列出主要接口/函数\n3. 给出使用示例\n4. 标注参数和返回值`,
  gen_tests: `\n\n## 测试生成技能\n生成测试时：\n1. 覆盖正常路径\n2. 覆盖边界情况\n3. 覆盖错误处理\n4. 使用 arrange-act-assert 模式`,
  git_commit: `\n\n## Git 提交技能\n生成提交信息时：\n1. 使用祈使句\n2. 首行不超过 50 字\n3. 详细说明变更原因\n4. 遵循 Conventional Commits 格式`,
};

export const BUILTIN_SKILL_IDS = Object.keys(SKILL_PROMPTS);

const BASE_PROMPT = `你是 MJ Coder，一个专业的 AI 编程助手。你可以：
- 执行 shell 命令（shell，默认在当前项目目录执行）
- 读写文件（read_file/write_file/edit_file/apply_patch）
- 浏览和搜索代码（list_dir/grep/glob）
- 操作 Git（git_status/git_diff/git_log/git_commit，默认在当前项目目录）
- 启动子代理处理子任务（spawn_subagent）

工作原则：
1. 先探索代码库结构，理解项目后再动手
2. 使用工具实际执行操作，不要只描述
3. 修改文件后用 shell 命令验证
4. 中文回复，简洁直接
5. 危险操作（rm/sudo/git push）会需要用户确认
6. 所有工具的相对路径都以「当前项目目录」为基准解析。你只能访问当前项目内的文件；
   若任务涉及项目外的文件（如应用自身源码、其他工程），必须先用绝对路径，并明确告知用户路径不在当前项目内
7. 读取文件报「文件不存在」时，先确认你请求的路径是否属于当前项目，不要用同一个错误路径反复重试
8. 持续执行纪律：任务未完成时必须持续调用工具推进，严禁输出「正在重写/我接下来会…」之类的
   中间叙述后停止；每轮要么调用工具、要么在全部工作完成并验证后给出最终总结。
   中间进展用带工具调用的轮次简述即可，不要单独发一轮纯文本「汇报进度」`;

// 需要注入项目 cwd 的工具（LLM 未显式提供时）
// 读类（read_file/list_dir/grep/glob）与写类（write_file/edit_file）都必须在内：
// 否则相对路径会按主进程 CWD 解析，导致 ENOENT 或写错位置
const CWD_TOOLS = new Set([
  'shell', 'read_file', 'list_dir', 'grep', 'glob',
  'write_file', 'edit_file', 'apply_patch',
  'git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch', 'git_add',
]);

// 子代理可用工具：只读探索集（不做任何修改）
const SUBAGENT_TOOL_NAMES = ['read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_diff', 'git_log'];
const SUBAGENT_TOOLS = BASE_TOOLS.filter((t) => SUBAGENT_TOOL_NAMES.includes(t.function.name));
const SUBAGENT_DEFAULT_BUDGET = 50000;

// 需要透传审批档位的工具（主进程审批中心据此判定是否询问）
const APPROVAL_TOOLS = new Set(['shell', 'write_file', 'edit_file', 'apply_patch', 'git_commit', 'git_add']);

// 工具名 → toolHandlers / window.mjcode 上的方法名（camelCase）
const TOOL_HANDLER_NAMES = {
  shell: 'shell',
  read_file: 'readFile',
  write_file: 'writeFile',
  edit_file: 'editFile',
  apply_patch: 'applyPatch',
  list_dir: 'listDir',
  grep: 'grep',
  glob: 'glob',
  git_status: 'gitStatus',
  git_diff: 'gitDiff',
  git_log: 'gitLog',
  git_commit: 'gitCommit',
  git_add: 'gitAdd',
  git_branch: 'gitBranch',
};

// 粗略 token 估算：中日韩字符约 1 token/字，其余约 1 token/4 字符
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export function estimateMessagesTokens(msgs) {
  return msgs.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')) + 4, 0);
}

// P1-A：轮边界对齐——压缩切点不得落在工具轮中间
// 背景：此前的 keepTail 定长切片可能在「assistant(tool_calls) 与其 tool 结果」之间下刀，
// 尾部以孤儿 tool 消息开头（其 assistant 已被压缩掉）→ 服务端 400（长会话必踩）。
// 规则：切点必须落在非 tool 消息上；若落在 tool 消息上，向后移动到该轮工具结果之后。
export function alignCutToRoundBoundary(body, cut) {
  let k = Math.max(0, Math.min(Number(cut) || 0, body.length));
  while (k < body.length && body[k]?.role === 'tool') k += 1;
  return k;
}

// 上下文压缩：超出上下文窗口 70% 时，将早期对话摘要化，保留 system + 最近若干轮
// P1-A 双档阈值：70% 常规摘要；85% 激进裁剪（保留更短尾部 + 注入压力告警）
// opts.knownTokens：调用方提供的真实 prompt_tokens（上一轮 usage），替代每轮全量重估（O(n²)）
// opts.force：token 预算超限时无视阈值强制压缩
export async function compactHistory(convo, model, chatFn, opts = {}) {
  const contextWindow = model?.model?.context_window || 128000;
  const est = typeof opts.knownTokens === 'number' ? opts.knownTokens : estimateMessagesTokens(convo);
  if (!opts.force && (est <= contextWindow * 0.7 || convo.length <= 8)) return convo;

  const aggressive = est > contextWindow * 0.85;
  const keepTail = aggressive ? 3 : 6;
  const head = convo.slice(0, 1); // system
  const body = convo.slice(1);
  if (body.length <= keepTail) return convo;
  const cut = alignCutToRoundBoundary(body, body.length - keepTail);
  if (cut <= 0 || cut >= body.length) return convo; // 无法安全切分（全是工具消息），放弃压缩
  const toCompact = body.slice(0, cut);
  const tail = body.slice(cut);

  const transcript = toCompact
    .map((m) => `${m.role}: ${(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).slice(0, 600)}`)
    .join('\n')
    .slice(0, 24000);

  try {
    const r = await chatFn({
      providerId: model.provider.id,
      isGlobal: !!model.provider.isGlobal,
      baseUrl: model.provider.base_url,
      messages: [{ role: 'user', content: `将以下对话历史压缩为一份摘要，保留：关键决策、涉及的文件路径、待办事项与用户偏好。300 字以内，直接输出摘要。\n\n${transcript}` }],
      model: model.model.model_id,
      reasoningEffort: model.model.reasoning_effort || '',
    });
    if (r?.content) {
      console.log(`[agent] 上下文压缩（${aggressive ? '激进' : '常规'}）：${est} → 摘要 ${estimateTokens(r.content)} tokens`);
      // 激进档追加压力告警：明确告知模型历史已深度裁剪，精确信息需重新核实，禁止凭记忆假设
      const summary = aggressive
        ? `[早期对话摘要·激进裁剪]\n${r.content}\n\n[上下文压力告警] 历史已被深度裁剪以控制上下文长度，早期细节可能缺失；如需精确信息请用 read_file/grep 重新核实，不要凭记忆假设。`
        : `[早期对话摘要]\n${r.content}`;
      // 防线：压缩结果也过 normalizeMessages，杜绝任何残留断链触发 400
      return normalizeMessages([head[0], { role: 'system', content: summary }, ...tail]);
    }
  } catch (err) {
    console.warn('[agent] 压缩失败，回落为截断最早消息:', err.message);
  }
  // 兜底：直接丢弃最早的旧消息（切点同样对齐轮边界；激进档丢 3/4，常规档丢 1/2）
  const drop = alignCutToRoundBoundary(body, Math.floor(toCompact.length * (aggressive ? 0.75 : 0.5)));
  if (drop <= 0 || drop >= body.length) return convo;
  return normalizeMessages([head[0], ...body.slice(drop)]);
}

// 会话 JSONL 落盘：每条持久化消息同步追加写入 ${sessionDir}/session.jsonl
async function appendSessionRecord(sessionDir, msg) {
  if (!sessionDir) return;
  try {
    const fs = await ensureNodeFs();
    if (!fs) {
      console.warn('[agent-core] 会话落盘不可用：当前环境无 node:fs');
      return;
    }
    fs.mkdirSync(sessionDir, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      role: msg.role,
      content: msg.content ?? '',
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
      usage: {
        prompt_tokens: msg.tokens_input || 0,
        completion_tokens: msg.tokens_output || 0,
      },
      ...(msg.tokens_input !== undefined ? { tokens_input: msg.tokens_input } : {}),
      ...(msg.tokens_output !== undefined ? { tokens_output: msg.tokens_output } : {}),
    };
    fs.appendFileSync(`${sessionDir}/session.jsonl`, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn('[agent-core] 会话落盘失败:', err.message);
  }
}

/**
 * 归一化历史消息，修复两类会导致模型接口 400 的问题：
 *
 * ①字段命名不一致
 *    本机数据库的消息字段是驼峰（toolCallId / toolCalls，见 localStore.addMessage），
 *    而 OpenAI 兼容接口要求蛇形（tool_call_id / tool_calls）。
 *    重载历史线程后再发消息，驼峰字段原样透传 → 服务端报
 *    `400 Param Incorrect: tool_call_id is not set`。
 *
 * ② 工具调用链断裂
 *    assistant 消息带 tool_calls，就必须有对应 tool_call_id 的 tool 结果消息。
 *    中断（steer / Esc）或历史裁剪会造成 tool 消息缺失，
 *    服务端同样报tool_call_id 错误。
 *    这里为孤立的 tool_calls 补一条占位 tool 结果，保证链完整。
 *
 * 只做字段改名与补链，不改内容本身，避免污染用户上下文。
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const raw of messages || []) {
    if (!raw || typeof raw !== 'object') continue;
    // system / user / assistant：无需补字段
    if (raw.role !== 'tool') {
      const m = { role: raw.role, content: raw.content ?? '' };
      const calls = raw.tool_calls || raw.toolCalls;
      if (Array.isArray(calls) && calls.length) m.tool_calls = calls;
      out.push(m);
      continue;
    }
    // role === 'tool'
    const id = raw.tool_call_id || raw.toolCallId || null;
    if (!id) continue; // 没有 id 的 tool 消息本就是无效的，直接丢弃
    out.push({ role: 'tool', tool_call_id: id, content: raw.content ?? '' });
  }

  // 补链：为没有对应 tool 结果的 tool_calls 生成占位结果
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const answered = new Set();
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].role !== 'tool') break;      // 遇到非tool 消息即本轮结束
      if (out[j].tool_call_id) answered.add(out[j].tool_call_id);
    }
    for (const tc of m.tool_calls) {
      if (!tc?.id || answered.has(tc.id)) continue;
      // 插入占位结果，保持 id 顺序与 tool_calls 一致
      const insertAt = out.indexOf(m) + 1;
      const placeholder = {
        role: 'tool',
        tool_call_id: tc.id,
        content: '（该工具调用的结果在本次会话中不可用，可能因中断或历史裁剪而丢失）',
      };
      out.splice(insertAt, 0, placeholder);
      answered.add(tc.id);
      i = insertAt; // 跳过刚插入的位置
    }
  }
  return out;
}

// 解析调用通道：优先 toolHandlers，回落 window.mjcode（旧调用方兼容）
// 每次调用时惰性解析，保证旧测试中途替换 window.mjcode.mock 的行为不变
function resolveChannel(toolHandlers, camelName) {
  if (toolHandlers && typeof toolHandlers[camelName] === 'function') {
    return (args) => toolHandlers[camelName](args);
  }
  const mj = globalThis.window?.mjcode;
  if (mj && typeof mj[camelName] === 'function') {
    return (args) => mj[camelName](args);
  }
  return null;
}

// ── 大任务拆分（token 效率：一次小规划调用，替代多轮盲目执行后返工）──
// 触发由 looksLargeTask 本地启发式把关（零成本）；只有疑似大任务才花一次
// 纯文本规划调用。拆分结果交用户确认，未确认不执行（fail-open：任何异常都不拆）。
const DECOMPOSE_SYSTEM = `你是任务拆分器。判断用户任务是否「过大」：涉及多个文件/页面/功能点，一次对话难以可靠完成。
若需要拆分，只输出严格 JSON：
{"decompose":true,"reason":"一句话说明为何拆分","tasks":[{"title":"步骤标题（10 字内）","prompt":"可独立执行的具体指令，须包含用户原始需求的关键约束与验收标准"}]}
若不需要拆分，只输出：{"decompose":false,"reason":"一句话说明"}
规则：任务数 2-6；每个子任务可独立执行且有明确完成标准；保持用户原始约束不丢失；只输出 JSON，禁止任何解释文字。`;

// 本地启发式（零 token 成本）：宁可不拆也不误拆（fail-open）
// 中文信息密度高（40 字已可含多目标），下限取 40 而非 80
export function looksLargeTask(text) {
  const t = String(text || '').trim();
  if (t.length < 30) return false;
  const multiHits = (t.match(/多个|批量|全部|所有|整套|重构|重写|端到端|全流程|分别|依次|逐一|全套/g) || []).length;
  const sepCount = (t.match(/[、，,;；]|以及|并且|同时再/g) || []).length;
  const targetHits = (t.match(/页面|功能|模块|组件|接口|音效|动画|关卡|文件|目录|服务|按钮/g) || []).length;
  if (multiHits >= 1) return true;
  if (sepCount >= 2 && targetHits >= 2) return true;
  return targetHits >= 3 && t.length >= 60;
}

// 从模型输出提取拆分计划；任何解析失败都返回 { decompose:false }（不拆分）
export function parsePlanResponse(text) {
  const none = { decompose: false, reason: '', tasks: [] };
  try {
    const raw = String(text || '');
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return none;
    const j = JSON.parse(body.slice(start, end + 1));
    if (!j || j.decompose !== true) return none;
    const tasks = Array.isArray(j.tasks) ? j.tasks : [];
    const clean = tasks
      .filter((t) => t && typeof t.title === 'string' && typeof t.prompt === 'string' && t.prompt.trim())
      .slice(0, 6)
      .map((t) => ({ title: t.title.trim().slice(0, 40), prompt: t.prompt.trim() }));
    if (clean.length < 2) return none;
    return { decompose: true, reason: String(j.reason || '').slice(0, 200), tasks: clean };
  } catch (e) {
    return none;
  }
}

// 一次纯文本规划调用（不传 tools，输出即 JSON）。调用方负责把结果交用户确认。
export async function decomposeTask({ messages, model, toolHandlers, signal }) {
  const chatFn = (payload) => {
    const ch = resolveChannel(toolHandlers, 'chat');
    if (!ch) throw new Error('模型调用通道不可用：请提供 toolHandlers.chat');
    return ch(payload);
  };
  const userText = (messages || [])
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
    .slice(0, 4000);
  const res = await chatFn({
    providerId: model.provider.id,
    isGlobal: !!model.provider.isGlobal,
    baseUrl: model.provider.base_url,
    messages: [
      { role: 'system', content: DECOMPOSE_SYSTEM },
      { role: 'user', content: userText },
    ],
    model: model.model.model_id,
  });
  if (signal?.aborted) return { decompose: false, reason: '', tasks: [] };
  return parsePlanResponse(res?.content || '');
}

// ── 模型调用重试（P0-A：供应商瞬时错误不应摧毁整轮任务）──
// 背景：chatFn 抛错曾直接冒泡出 runAgent，第 20 轮的 40 轮成果全部作废。
// 策略：429/5xx/网络类错误指数退避重试（默认 3 次）；aborted 与客户端错误（400/401/403 等）直穿不重试。
export const CHAT_MAX_RETRIES = 3;

export function isRetryableChatError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const msg = String(err.message || err);
  if (/abort/i.test(msg)) return false;                              // 用户主动中止：直穿
  if (/KEY_MISSING/i.test(msg)) return false;                        // 凭证缺失重试无意义
  if (/\b4\d\d\b/.test(msg) && !/\b429\b/.test(msg)) return false;   // 其他 4xx 客户端错误不重试
  return /\b(429|500|502|503|504|529)\b/.test(msg)
    || /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|timeout|超时/i.test(msg);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// opts: { maxRetries, baseMs } —— baseMs 供测试注入 0 加速；生产默认 1000ms，指数退避 + 抖动，上限 8s
export async function chatWithRetry(chatFn, params, signal, opts = {}) {
  const maxRetries = opts.maxRetries ?? CHAT_MAX_RETRIES;
  const baseMs = opts.baseMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await chatFn(params);
    } catch (err) {
      if (signal?.aborted || !isRetryableChatError(err) || attempt >= maxRetries) throw err;
      const delay = Math.min(baseMs * 2 ** attempt, 8000) * (0.5 + Math.random() * 0.5);
      console.warn(`[agent] 模型调用失败（${err.message}），${Math.round(delay)}ms 后重试（${attempt + 1}/${maxRetries}）`);
      await sleep(delay);
    }
  }
}

// ── P1-B：工具结果截断（带标记 + 对象结果不在 JSON 中间下刀）──
// 背景：此前 JSON.stringify(result).slice(0, 15000) 静默截断，模型不知道结果被砍，
// 会把半截 JSON 当完整数据使用；对象结果更会在 JSON 中间下刀，结构直接损坏。
export const TOOL_RESULT_MAX_CHARS = 15000;

function clipText(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n……[已截断，共 ${s.length} 字符，仅显示前 ${max} 字符。请用 offset/limit 参数或 grep 续取剩余内容]`;
}

export function truncateToolResult(result, maxChars = TOOL_RESULT_MAX_CHARS) {
  if (typeof result === 'string') return clipText(result, maxChars);
  let json;
  try {
    json = JSON.stringify(result);
  } catch (e) {
    return clipText(String(result), maxChars); // 循环引用等不可序列化对象：降级为字符串裁剪
  }
  if (json.length <= maxChars) return json;
  // 对象结果：逐个裁剪最长的字符串字段（stdout/content/matches 等），保持 JSON 结构完整可解析
  const clone = { ...result };
  for (let guard = 0; guard < 32; guard++) {
    json = JSON.stringify(clone);
    if (json.length <= maxChars) return json;
    let worstKey = null;
    let worstLen = 0;
    for (const [k, v] of Object.entries(clone)) {
      if (typeof v === 'string' && v.length > worstLen) { worstKey = k; worstLen = v.length; }
    }
    if (!worstKey || worstLen < 200) break; // 没有可裁的长文本字段，退出循环走整体硬截
    clone[worstKey] = clipText(clone[worstKey], Math.max(200, Math.floor(worstLen / 2)));
  }
  json = JSON.stringify(clone);
  if (json.length <= maxChars) return json;
  return clipText(json, maxChars); // 字段裁无可裁：整体硬截（仍带标记）
}

// P1-I：轮次预算双闸——单任务总轮次硬顶（AGENT_HARD_ROUND_CAP）+ 可选单任务 token 预算
// 背景：原 maxRounds 硬顶对大任务过早收尾；续期指令以 user 角色 push 进 convo，
// 污染会话历史（重进线程时用户会看到一条自己没说过的话）。
export const AGENT_HARD_ROUND_CAP = 120;

// 重复失败熔断阈值：同一「工具名 + 参数」签名连续失败 2 次旁路警示、4 次强制收尾。
// 4 次的依据：一次失败可能是模型笔误，两次是巧合，三次以上几乎可以判定为
// 「模型不知道怎么纠正，只会原样重试」——此时再跑就是纯烧 token 与用户等待时间。
export const REPEAT_FAIL_WARN = 2;
export const REPEAT_FAIL_STOP = 4;

// 工具调用签名：用于识别「用同样的参数重试同一个操作」。
// 对象 key 排序后再序列化，避免模型换个 key 顺序就被当成新操作而绕过熔断。
export function toolSignature(name, args) {
  let body;
  try {
    body = JSON.stringify(sortKeysDeep(args ?? {}));
  } catch {
    body = String(args);
  }
  return `${name}|${String(body).slice(0, 600)}`;
}
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeysDeep(v[k]); return acc; }, {});
  }
  return v;
}

// 结构化失败判定：只认 ok === false 或显式 error 字段。
// 故意不把 shell 的 exitCode !== 0 算进来——「grep 没命中」「test 失败」都是正常控制流，
// 若算进去会让正常的「改代码 → 跑测试 → 再改」循环被误熔断。
export function isToolFailure(r) {
  if (!r) return true;
  if (r.ok === false) return true;
  if (typeof r.error === 'string' && r.error.length > 0) return true;
  return false;
}

export async function runAgent({
  messages, model, onStream, onToolCall, onDone, onMessage,
  mcpTools = [], enabledSkills = [], skills = [], maxRounds = 40, signal, cwd, agentsMd,
  approvalMode = 'on-request', conversationId, tools: customTools, systemPrompt: customSystemPrompt,
  sandboxPolicy, memories = [], chatRetryBaseMs = 1000,
  toolHandlers, sessionDir, planMode = false,
  maxTotalRounds = AGENT_HARD_ROUND_CAP, tokenBudget = 0,
}) {
  // 模型调用通道：toolHandlers.chat 优先，回落 window.mjcode.chat
  const chatFn = (payload) => {
    const channel = resolveChannel(toolHandlers, 'chat');
    if (!channel) throw new Error('模型调用通道不可用：请提供 toolHandlers.chat 或 window.mjcode.chat');
    return channel(payload);
  };
  // 会话持久化：onMessage 包装，先落盘再透传给调用方
  const persistMessage = onMessage || sessionDir
    ? async (m) => {
        if (sessionDir) await appendSessionRecord(sessionDir, m);
        onMessage?.(m);
      }
    : null;

  let systemPrompt = customSystemPrompt || BASE_PROMPT;
  for (const skillId of enabledSkills) {
    if (SKILL_PROMPTS[skillId]) systemPrompt += SKILL_PROMPTS[skillId];
  }
  // 文件技能（~/.mjcode/skills 的 SKILL.md）内容注入
  for (const s of skills) {
    if (s?.content) {
      systemPrompt += `\n\n## 技能：${s.name}\n${String(s.content).slice(0, 6000)}`;
    }
  }
  // AGENTS.md 项目规范注入（Codex 语义）
  if (agentsMd?.content) {
    systemPrompt += `\n\n## 项目规范（${agentsMd.path}）\n${agentsMd.content.slice(0, 8000)}`;
  }
  // 两阶段记忆 POC（stage2 注入：项目历史会话沉淀）
  if (Array.isArray(memories) && memories.length) {
    systemPrompt += `\n\n## 相关记忆（本项目历史会话沉淀）\n${memories.map((m) => `- ${String(m).slice(0, 300)}`).join('\n')}`;
  }

  let convo = [{ role: 'system', content: systemPrompt }, ...normalizeMessages(messages)];
  // 规划模式（对标 Codex /plan）：移除全部写工具，只保留读与规划能力
  // 双保险：工具层不给 + 系统提示约束 + 沙箱降级为 read-only
  const PLAN_MODE_BLOCKED = new Set(['write_file', 'edit_file', 'apply_patch', 'git_commit', 'git_add']);
  let allTools = [...(customTools || BASE_TOOLS), ...mcpTools];
  if (planMode) {
    allTools = allTools.filter((t) => !PLAN_MODE_BLOCKED.has(t.function?.name));
    convo[0] = {
      role: 'system',
      content: `${convo[0].content}\n\n## 规划模式\n当前处于规划模式：写文件、改代码、提交 Git 的工具已被移除。你只能读取与搜索代码，然后输出一份可执行的实施计划（分步骤、标注涉及文件），等待用户确认后再由后续轮次执行。`,
    };
  }
  let finalText = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let aborted = false;
  // P1-A：上一轮真实 prompt_tokens（替代每轮全量重估，O(n²) → 增量维护）
  let lastPromptTokens = null;

  // ── 防提前终止（P1-I：轮次 + token 双闸，续期指令旁路注入）──
  // 1) 轮次双闸：单段预算 maxRounds（耗尽自动续期最多 2 次）+ 单任务总轮次硬顶 maxTotalRounds，先到先收；
  // 2) token 预算（tokenBudget > 0 时启用）：超限先自动压缩续跑一次，仍超限才收尾；
  // 3) finish_reason=length（输出被截断）：从断点续跑最多 3 次。
  // 续期/截断指令一律拼到当轮 system 消息尾部（renewNotice），不写入 convo——避免污染会话历史。
  const roundCap = Math.max(1, Math.min(Number(maxTotalRounds) || AGENT_HARD_ROUND_CAP, AGENT_HARD_ROUND_CAP));
  let roundsUsed = 0;
  let budget = maxRounds;
  let budgetExtensions = 0;
  let lengthContinues = 0;
  let budgetExhausted = false;
  let budgetKind = 'rounds'; // 'rounds' | 'tokens' | 'repeat' —— 收尾文案区分触发闸门
  let tokenCompacted = false; // token 超限后是否已尝试过自动压缩
  let renewNotice = '';

  // ── 重复失败熔断：空转循环防线 ──
  // 真机反馈：「明明代码已经改完了，但一直在那边循环不结束」。
  // 根因不是轮次不够，而是**同一个失败操作被无限重试**：工具失败只回一句不可行动的错误
  // （如「未找到要替换的内容」），模型无从判断原因，只能原样再试一次，
  // 直到 120 轮硬顶耗尽——用户侧表现就是「改完了还卡着转好几分钟」。
  // 因此按「工具名 + 参数」签名统计连续失败：先旁路警示，达到硬阈值即熔断收尾并如实说明。
  const failStreak = new Map();
  let repeatFailTool = '';
  let repeatFailCount = 0;

  while (true) {
    if (budgetExhausted) break; // 熔断可能在上一轮的工具循环内触发
    if (signal?.aborted) { aborted = true; break; }
    if (roundsUsed >= roundCap) { budgetExhausted = true; budgetKind = 'rounds'; break; }
    if (budget <= 0) {
      if (budgetExtensions < 2) {
        budgetExtensions += 1;
        budget = maxRounds;
        renewNotice = '系统提示：执行轮次预算已续期。请继续完成未完成的任务，避免重复已完成的步骤；全部完成并验证后输出最终总结。';
      } else {
        budgetExhausted = true; budgetKind = 'rounds';
        break;
      }
    }
    budget -= 1;
    roundsUsed += 1;
    onStream?.('');
    const compacted = await compactHistory(convo, model, chatFn, { knownTokens: lastPromptTokens });
    // P1-I：续期/截断指令旁路注入——只进当轮请求的 system 消息，不进 convo
    const outbound = renewNotice && compacted[0]?.role === 'system'
      ? [{ ...compacted[0], content: `${compacted[0].content}\n\n${renewNotice}` }, ...compacted.slice(1)]
      : compacted;
    renewNotice = '';
    // P0-A：瞬时错误（429/5xx/网络）指数退避重试；aborted 与客户端错误直穿
    const result = await chatWithRetry(chatFn, {
      providerId: model.provider.id,
      isGlobal: !!model.provider.isGlobal,
      baseUrl: model.provider.base_url,
      messages: outbound,
      model: model.model.model_id,
      tools: allTools,
      reasoningEffort: model.model.reasoning_effort || '',
    }, signal, { baseMs: chatRetryBaseMs });

    if (result.aborted) { aborted = true; finalText = result.content || finalText; break; }
    const roundUsage = result.usage
      ? { prompt_tokens: result.usage.prompt_tokens || 0, completion_tokens: result.usage.completion_tokens || 0 }
      : null;
    if (roundUsage) {
      usage.prompt_tokens += roundUsage.prompt_tokens;
      usage.completion_tokens += roundUsage.completion_tokens;
      lastPromptTokens = roundUsage.prompt_tokens;
    }

    // P1-I：token 预算闸——超限先自动压缩续跑一次，仍超限才收尾
    if (tokenBudget > 0 && (usage.prompt_tokens + usage.completion_tokens) > tokenBudget) {
      if (!tokenCompacted) {
        tokenCompacted = true;
        console.warn(`[agent] 单任务 token 预算（${tokenBudget}）已用尽（${usage.prompt_tokens + usage.completion_tokens}），自动压缩后续跑`);
        convo = await compactHistory(convo, model, chatFn, { knownTokens: lastPromptTokens, force: true });
        continue;
      }
      budgetExhausted = true; budgetKind = 'tokens';
      break;
    }

    finalText = result.content;
    if (!result.tool_calls || result.tool_calls.length === 0) {
      // 输出被截断（finish_reason=length）：从断点续跑
      if (result.finish_reason === 'length' && lengthContinues < 3) {
        lengthContinues += 1;
        convo.push({ role: 'assistant', content: finalText || '' });
        renewNotice = '系统提示：上一条回复因长度限制被截断。请从中断处继续，不要重复已输出内容。';
        continue;
      }
      // 纯文本收尾视为本轮对话完成。「只说不做」由系统提示第 8 条（持续执行纪律）约束，
      // 不做无条件续跑：否则闲聊/正常总结每条都会多一轮请求，延迟与 token 翻倍。
      onDone?.(finalText, usage, aborted);
      return finalText;
    }

    const toolCalls = result.tool_calls.map(tc => ({
      id: tc.id, type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    convo.push({ role: 'assistant', content: result.content || '', tool_calls: toolCalls });
    // 中间轮 assistant 消息持久化（含该轮 usage）
    await persistMessage?.({ role: 'assistant', content: result.content || '', tool_calls: toolCalls, tokens_input: roundUsage?.prompt_tokens || 0, tokens_output: roundUsage?.completion_tokens || 0 });

    for (const tc of result.tool_calls) {
      if (signal?.aborted) { aborted = true; break; }
      if (budgetExhausted) break; // 本轮已触发熔断：不再执行同批剩余工具调用
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch (e) {
        console.warn('[agent] 工具参数解析失败:', tc.function.name, e.message);
      }
      // cwd 贯通：shell/git/apply_patch 类工具默认注入当前项目目录
      const toolArgs = { ...args };
      if (cwd && CWD_TOOLS.has(tc.function.name) && !toolArgs.cwd) {
        toolArgs.cwd = cwd;
      }
      // 审批档位 + 沙箱策略透传（主进程审批中心/Seatbelt 据此判定）
      if (approvalMode && APPROVAL_TOOLS.has(tc.function.name) && !toolArgs.approvalMode) {
        toolArgs.approvalMode = approvalMode;
        toolArgs.conversationId = conversationId || '';
      }
      // P0-B fail-safe：未显式指定沙箱策略时默认 read-only（由调用方显式提升），
      // 杜绝「调用方忘传 sandboxPolicy → 主进程回落 full-access 无隔离直跑」
      if (tc.function.name === 'shell' && !toolArgs.sandboxPolicy) {
        toolArgs.sandboxPolicy = sandboxPolicy || 'read-only';
      }
      let toolResult;
      try {
        switch (tc.function.name) {
          case 'spawn_subagent': {
            // 真子代理：只读工具子集 + 独立上下文 + token 预算（耗尽自动停止）
            const budget = Number(args.token_budget) > 0 ? Number(args.token_budget) : SUBAGENT_DEFAULT_BUDGET;
            const subCtl = new AbortController();
            let subTokens = 0;
            let exhausted = false;
            const parentContext = convo
              .filter((m) => m.role !== 'system')
              .slice(-6)
              .map((m) => `${m.role}: ${(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).slice(0, 800)}`)
              .join('\n');
            const subResult = await runAgent({
              messages: [{ role: 'user', content: `父代理上下文：\n${parentContext}\n\n你的目标：${args.objective}\n请用只读工具探索并给出结论。` }],
              model,
              cwd,
              signal: subCtl.signal,
              approvalMode,
              conversationId,
              sandboxPolicy: sandboxPolicy || 'read-only', // 子代理继承父级沙箱策略，缺省同样 fail-safe
              tools: SUBAGENT_TOOLS,
              maxRounds: 8,
              systemPrompt: `你是 MJ Coder 的子代理（任务类型：${args.task_type || 'explore'}）。\n目标：${args.objective}\n约束：只能使用只读工具探索与分析，不做任何修改；结论要具体、可执行，附文件路径与行号线索。`,
              toolHandlers,
              onMessage: (m) => {
                if (m.role === 'assistant') {
                  subTokens += (m.tokens_input || 0) + (m.tokens_output || 0);
                  if (subTokens > budget && !exhausted) {
                    exhausted = true;
                    subCtl.abort();
                  }
                }
              },
              onDone: () => {},
            });
            toolResult = {
              ok: true,
              objective: args.objective,
              task_type: args.task_type || 'explore',
              tokens_used: subTokens,
              budget_exhausted: exhausted,
              result: subResult || '（子代理未产出结论）',
            };
            break;
          }
          default: {
            if (tc.function.name.startsWith('mcp__')) {
              const parts = tc.function.name.split('__');
              const server = parts[1], toolName = parts.slice(2).join('__');
              const mcpChannel = resolveChannel(toolHandlers, 'mcpCallTool');
              if (!mcpChannel) throw new Error(`MCP 调用通道不可用（server=${server}）`);
              toolResult = await mcpChannel({ server, tool: toolName, arguments: args, approvalMode, conversationId: conversationId || '' });
            } else {
              const camelName = TOOL_HANDLER_NAMES[tc.function.name];
              const channel = camelName ? resolveChannel(toolHandlers, camelName) : null;
              if (!channel) throw new Error(`未知工具: ${tc.function.name}`);
              toolResult = await channel(toolArgs);
            }
          }
        }
      } catch (err) {
        toolResult = { error: err.message };
      }
      // 重复失败熔断：只统计「ok === false / 带 error」的结构化失败。
      // shell 那种 exitCode !== 0 不算（grep 没命中也是正常的控制流），避免误伤。
      const failKey = toolSignature(tc.function.name, toolArgs);
      if (isToolFailure(toolResult)) {
        const n = (failStreak.get(failKey) || 0) + 1;
        failStreak.set(failKey, n);
        if (n >= REPEAT_FAIL_STOP) {
          repeatFailTool = tc.function.name;
          repeatFailCount = n;
          budgetExhausted = true;
          budgetKind = 'repeat';
        } else if (n >= REPEAT_FAIL_WARN) {
          // 旁路注入（写 renewNotice 而非 convo）：不污染会话历史，用户重进线程看不到这条系统话
          renewNotice = `系统提示：工具 ${tc.function.name} 用完全相同的参数已连续失败 ${n} 次。`
            + '禁止再用同样的参数重试。请先换方式确认真实状态（例如用 read_file 读取文件当前内容），'
            + '或改用别的工具达成同一目标；如果该目标其实已经达成，直接输出最终总结结束任务。';
        }
      } else {
        failStreak.delete(failKey); // 同签名一旦成功即清零，正常重试不受影响
      }
      onToolCall?.({ name: tc.function.name, args: toolArgs, result: toolResult });
      // P1-B：截断带标记；对象结果逐字段裁剪保持 JSON 完整，不在中间下刀
      const toolContent = truncateToolResult(toolResult);
      const toolMsg = { role: 'tool', tool_call_id: tc.id, content: toolContent };
      convo.push(toolMsg);
      // tool 结果消息持久化（重进线程可完整重放工具链）
      await persistMessage?.(toolMsg);
    }
  }
  // 预算耗尽 / 熔断：如实告知未完成，引导用户「继续」接力（而非假装任务已结束）
  if (budgetExhausted) {
    if (budgetKind === 'repeat') {
      finalText = `${finalText || ''}\n\n（已主动停止：工具 \`${repeatFailTool}\` 用相同参数连续失败 ${repeatFailCount} 次，`
        + '判定为无效重试而非任务不可完成，继续跑只会空转。请根据上述失败原因调整，或换个说法让我重新尝试。）'.trim();
    } else {
      const kindText = budgetKind === 'tokens' ? 'token 预算' : '执行轮次预算';
      finalText = `${finalText || '任务尚未完成。'}\n\n（单任务${kindText}已用尽，任务未完全完成。发送「继续」让我接着执行。）`.trim();
    }
  }
  onDone?.(finalText, usage, aborted);
  return finalText;
}
