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
    name: 'search_plugins',
    description: '在公网插件源中搜索可安装的插件：npm registry 的 MCP Server 与 GitHub 的技能仓库。返回名称、版本、简介、来源与安装方式。安装请用 install_plugin（会弹审批卡请用户确认）。',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: '搜索关键词，例如 "github mcp"、"代码审查 skill"' },
      types: { type: 'array', items: { type: 'string', enum: ['mcp', 'skill'] }, description: '限定插件类型，缺省两者都搜' },
    }, required: ['query'] },
  }},
  { type: 'function', function: {
    name: 'install_plugin',
    description: '安装网络插件（会弹审批卡请用户确认，拒绝即中止）。kind=mcp：从 npm 安装 MCP Server（pkg 为包名，装完自动连接，工具立即可用）；kind=skill：从 GitHub 仓库安装 SKILL.md 技能（url 为仓库地址，下一轮对话生效）。安装 MCP 前应先用 search_plugins 确认准确包名。',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['mcp', 'skill'], description: '插件类型' },
      pkg: { type: 'string', description: 'npm 包名（kind=mcp 必填）' },
      url: { type: 'string', description: 'Git 仓库地址（kind=skill 必填）' },
      name: { type: 'string', description: '自定义安装名（可选）' },
      ref: { type: 'string', description: 'Git 分支或 tag（可选）' },
    }, required: ['kind'] },
  }},
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
  // 多 Agent 编排（对话内自动触发）：整组并行执行，阻塞至收尾，返回聚合结果
  { type: 'function', function: {
    name: 'orchestrate_task',
    description: '把一个可拆解为多个子任务的目标交给多 Agent 编排系统：自动拆解为 DAG、多个独立 Agent 并行执行（各自拥有完整工具集）、失败自动重试与重规划。适用于：用户要求多个角色/多件事并行处理、目标可自然拆分为互不依赖的子任务（如多视角审查、多模块改造）。会阻塞直到整组完成，返回聚合结果与人话总结。',
    parameters: { type: 'object', properties: {
      goal: { type: 'string', description: '总体目标（自包含：写清楚对象、范围、验收标准，禁止引用对话上下文）' },
      max_agents: { type: 'number', description: '并行 Agent 数上限 1-8（默认 4，主流大模型服务均支持）。并发出问题时可调小（如 1 个串行）重试' },
    }, required: ['goal'] },
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
- 多 Agent 并行编排（orchestrate_task）：当用户要求多角色/多任务并行，或目标可拆为互不依赖的
  子任务时，主动调用它把目标转交编排系统并行执行；返回的聚合结果由你向用户转述，
  若结果提示并发出问题，调小 max_agents 重试并用平实的语言告知用户

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
  'orchestrate_task',
]);

// 子代理可用工具：只读探索集（不做任何修改）
const SUBAGENT_TOOL_NAMES = ['read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_diff', 'git_log'];
const SUBAGENT_TOOLS = BASE_TOOLS.filter((t) => SUBAGENT_TOOL_NAMES.includes(t.function.name));
const SUBAGENT_DEFAULT_BUDGET = 50000;

// token 预算闸的自动压缩救援次数上限（每次救援清零窗口重新计数）
// 真机复盘：单次救援对文件密集型审查任务不够（逐文件读源码单窗口仍打满），
// 放宽到 3 次（累计消耗上限 ≈ 4 × tokenBudget），仍保留失控烧 token 的硬防线。
const TOKEN_RESCUE_MAX = 3;
// 预判式触发比例（复盘文档 P1-2 采纳）：窗口消耗达预算 70% 即压缩，
// 而非等超限后溢出一轮才救——省下溢出轮的无效消耗；触闸后仍受 TOKEN_RESCUE_MAX 约束。
const TOKEN_COMPACTION_TRIGGER = 0.7;

// 需要透传审批档位的工具（主进程审批中心据此判定是否询问）
const APPROVAL_TOOLS = new Set(['shell', 'write_file', 'edit_file', 'apply_patch', 'git_commit', 'git_add', 'install_plugin']);

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
  orchestrate_task: 'orchestrateTask',
  search_plugins: 'searchPlugins',
  install_plugin: 'installPlugin',
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
      // 结构化摘要模板（复盘文档 P1-2 采纳）：固定四段式，细节（文件路径/函数名/结论）
      // 必须保留——LLM 需要更多细节时按路径按需重读，平衡 token 消耗与信息完整性
      messages: [{ role: 'user', content: `将以下对话历史压缩为一份结构化摘要，严格按此格式输出（300 字以内）：
【已完成】列出已完成的工作与验证结果（一句话一项）
【关键发现】重要结论、发现的文件路径/函数名/关键变量，后续轮次必须能凭此定位
【待办】当前进行到哪一步、接下来要做什么（含断点位置）
【约束】用户原始需求中不可丢失的约束

对话历史：
${transcript}` }],
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

// ── Phase 3-3：长输出摘要化（PASS 折叠 + 头尾保留 + 原文落盘）──
// 背景：npm test / grep / 大文件读取动辄上万字进 prompt，其中大量是逐用例 PASS 行，
// 每轮重复读取上下文时反复计费——这是长任务 token 滚动增大的主因之一。
// 策略：超阈值 → 先折叠连续 PASS 行 → 头尾保留，完整原文落盘临时文件，
// 模型需要细节时按落盘路径 read_file 按需取回（而非一次性全量进上下文）。
export const TOOL_OUTPUT_SAVE_THRESHOLD = 8000;
export const TOOL_OUTPUT_HEAD = 2500;
export const TOOL_OUTPUT_TAIL = 3500;
export const PASS_COLLAPSE_RUN = 20;

// 折叠连续「通过用例」行（✓/✅/PASS/ok/通过…）：超过 maxRun 连续命中 → 中段折叠为一行汇总
export function collapsePassLines(text, maxRun = PASS_COLLAPSE_RUN) {
  const lines = String(text ?? '').split('\n');
  const isPass = (l) => /^\s*(✓|✅|✔|PASS\b|ok\b|通过[:：]?)/i.test(l);
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > maxRun) {
      out.push(run[0]);
      out.push(`……（另有 ${run.length - 2} 行通过用例日志已折叠，均 PASS）……`);
      out.push(run[run.length - 1]);
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const l of lines) {
    if (isPass(l)) run.push(l);
    else { flush(); out.push(l); }
  }
  flush();
  return out.join('\n');
}

// 长输出摘要化入口。仅处理纯字符串结果，或带 stdout/content 字段的对象结果；
// 其余结构原样返回（走既有 truncateToolResult 兜底）。fs 不可用时只折叠不落盘。
export async function summarizeToolOutput(result, toolName = 'tool') {
  const pick = (r) => {
    if (typeof r === 'string') return { obj: null, field: null, text: r };
    if (r && typeof r === 'object') {
      for (const f of ['stdout', 'content']) {
        if (typeof r[f] === 'string' && r[f].length > TOOL_OUTPUT_SAVE_THRESHOLD) {
          return { obj: r, field: f, text: r[f] };
        }
      }
    }
    return null;
  };
  const hit = pick(result);
  if (!hit) return result;

  const folded = collapsePassLines(hit.text);
  if (folded.length <= TOOL_OUTPUT_SAVE_THRESHOLD) {
    return hit.obj ? { ...hit.obj, [hit.field]: folded } : folded;
  }

  // 原文落盘（fs 可用时），供模型按需 read_file 取回
  let fullOutputPath = '';
  try {
    const fs = await ensureNodeFs();
    if (fs) {
      const dir = `${process.env.TMPDIR || process.env.TEMP || '/tmp'}/mjcode-tool-outputs`;
      fs.mkdirSync(dir, { recursive: true });
      fullOutputPath = `${dir}/${Date.now()}-${String(toolName).replace(/[^\w-]/g, '_')}.txt`;
      fs.writeFileSync(fullOutputPath, hit.text, 'utf8');
    }
  } catch (e) {
    console.warn('[agent] 长输出落盘失败（仅头尾保留）:', e.message);
    fullOutputPath = '';
  }

  const head = folded.slice(0, TOOL_OUTPUT_HEAD);
  const tail = folded.slice(-TOOL_OUTPUT_TAIL);
  const note = [
    `……[长输出摘要化：原文共 ${hit.text.length} 字符，仅保留折叠后头 ${head.length} + 尾 ${tail.length} 字符。`,
    fullOutputPath ? `完整原文已落盘：${fullOutputPath}（需要细节时用 read_file 读取该路径）` : '（当前环境无法落盘，如需更多内容请用 grep/offset 分段获取）',
    ']……',
  ].join(' ');
  const summarized = `${head}\n${note}\n${tail}`;
  return hit.obj ? { ...hit.obj, [hit.field]: summarized } : summarized;
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

// Phase 3-2：文件读取缓存门槛——内容小于该值的文件重复读取直接放行（小文件不值得缓存）
export const FILE_CACHE_MIN_CHARS = 4000;

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
  messages, model, onStream, onToolCall, onDone, onMessage, onSuspend, onBudget,
  mcpTools = [], enabledSkills = [], skills = [], maxRounds = 40, signal, cwd, agentsMd,
  approvalMode = 'on-request', conversationId, tools: customTools, systemPrompt: customSystemPrompt,
  sandboxPolicy, memories = [], chatRetryBaseMs = 1000,
  toolHandlers, sessionDir, planMode = false,
  maxTotalRounds = AGENT_HARD_ROUND_CAP, tokenBudget = 0,
  resumeContext = '',
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
  // 断点恢复注入（Phase 3-1）：上一任务因预算触顶暂停，恢复时把断点摘要放进 system——
  // 只进 system 消息不进持久化历史（与续期指令同语义），模型据此接续待办而非重读全部文件
  if (resumeContext) {
    systemPrompt += `\n\n## 断点恢复（上一任务因预算触顶暂停，以下是断点摘要）\n${String(resumeContext).slice(0, 6000)}\n\n请从「待办」处接续执行，已完成部分不要重做；需要细节时按摘要中的文件路径按需重读。`;
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
  let tokenRescues = 0; // token 超限后已执行的自动压缩救援次数（上限 TOKEN_RESCUE_MAX）
  let tokenWindowSpent = 0; // token 预算口径：当前窗口累计消耗（压缩救援后清零）
  let contextRescued = false; // 上下文超限（provider 400）压缩救援已尝试过
  let renewNotice = '';
  let suspendNoticed = false; // Phase 3-1：断点是否已通过 onSuspend 成功保存

  // ── 重复失败熔断：空转循环防线 ──
  // 真机反馈：「明明代码已经改完了，但一直在那边循环不结束」。
  // 根因不是轮次不够，而是**同一个失败操作被无限重试**：工具失败只回一句不可行动的错误
  // （如「未找到要替换的内容」），模型无从判断原因，只能原样再试一次，
  // 直到 120 轮硬顶耗尽——用户侧表现就是「改完了还卡着转好几分钟」。
  // 因此按「工具名 + 参数」签名统计连续失败：先旁路警示，达到硬阈值即熔断收尾并如实说明。
  const failStreak = new Map();
  let repeatFailTool = '';
  let repeatFailCount = 0;

  // Phase 3-2：run 内文件读取缓存——绝对路径 → { mtimeMs, size, len, round }。
  // 同一文件 mtime/size 未变时重复全量读取不再注入全文（长任务每轮重复读上下文
  // 是 token 滚动增大的主因）；带 offset/limit 的分段读取与 Stat 失败一律直读不缓存。
  const readFileCache = new Map();

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
    let result;
    try {
      result = await chatWithRetry(chatFn, {
        providerId: model.provider.id,
        isGlobal: !!model.provider.isGlobal,
        baseUrl: model.provider.base_url,
        messages: outbound,
        model: model.model.model_id,
        tools: allTools,
        reasoningEffort: model.model.reasoning_effort || '',
      }, signal, { baseMs: chatRetryBaseMs });
    } catch (err) {
      // 上下文超限救援：小上下文模型在长任务中容易打满 provider 侧限制返回 400，
      // 此前直穿 → 前面几十轮成果作废（真机表现「跑到一半突然停」）。识别后强制压缩一次续跑；
      // 已救援过仍超限才抛出（渲染层显示带模型名的错误消息，不再静默）。
      const msg = String(err?.message || err);
      if (!contextRescued && !signal?.aborted && /(\bAPI 400\b|context|length|too long|maximum|超出)/i.test(msg)) {
        contextRescued = true;
        console.warn(`[agent] 疑似上下文超限（${msg.slice(0, 200)}），强制压缩历史后重试`);
        convo = await compactHistory(convo, model, chatFn, { knownTokens: lastPromptTokens, force: true });
        continue;
      }
      console.error(`[agent] 模型调用失败终止运行：${msg.slice(0, 300)}（第 ${roundsUsed} 轮后）`);
      throw err;
    }

    if (result.aborted) { aborted = true; finalText = result.content || finalText; console.warn(`[agent] 运行中止：收到中止信号（第 ${roundsUsed} 轮后，窗口消耗 ${tokenWindowSpent} tokens）`); break; }
    const roundUsage = result.usage
      ? { prompt_tokens: result.usage.prompt_tokens || 0, completion_tokens: result.usage.completion_tokens || 0 }
      : null;
    if (roundUsage) {
      usage.prompt_tokens += roundUsage.prompt_tokens;
      usage.completion_tokens += roundUsage.completion_tokens;
      lastPromptTokens = roundUsage.prompt_tokens;
      tokenWindowSpent += roundUsage.prompt_tokens + roundUsage.completion_tokens;
    }
    // Phase 3-4：逐轮 token 用量上报（仪表盘数据源）——runner 侧缓存最新状态供渲染层轮询
    try {
      onBudget?.({
        round: roundsUsed, windowSpent: tokenWindowSpent, budget: tokenBudget,
        rescues: tokenRescues, rescueMax: TOKEN_RESCUE_MAX,
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        running: true,
      });
    } catch (e) { /* 仪表盘上报绝不影响主流程 */ }

    // P1-I：token 预算闸——窗口消耗达预算 70%（TOKEN_COMPACTION_TRIGGER）即预判式压缩续跑
    // （最多 TOKEN_RESCUE_MAX 次），救援用尽仍触闸才收尾。
    // 预算口径 = 当前窗口累计消耗（压缩救援后清零开新窗口），而非全程累计：
    // 事故复盘：原实现拿全程累计 usage 判闸——usage 单调递增且压缩后不清零，
    // 导致压缩救援后下一轮必然再次超限立即收尾，救援形同虚设（真机复现）。
    // 注意：压缩解决的是「上下文过长」，预算闸防的是「单任务失控烧 token」，
    // 两者独立；每轮都会重复读取上下文，长任务累计消耗会滚动增大属正常现象。
    // 真机迭代：单次救援不够——文件密集型审查任务（逐文件读源码）单窗口仍会打满，
    // 用户看到 470k/454k 熔断文案即第 2 次触闸。放宽为最多 3 次救援（累计上限
    // ≈ 4 × tokenBudget），仍保留失控烧 token 的硬防线；不设无限救援（成本失控风险）。
    if (tokenBudget > 0 && tokenWindowSpent > tokenBudget * TOKEN_COMPACTION_TRIGGER) {
      if (tokenRescues < TOKEN_RESCUE_MAX) {
        tokenRescues += 1;
        console.warn(`[agent] 单任务 token 窗口达预判阈值（${tokenWindowSpent} / 预算 ${tokenBudget} 的 ${TOKEN_COMPACTION_TRIGGER * 100}%），自动压缩后开启新预算窗口续跑（第 ${tokenRescues}/${TOKEN_RESCUE_MAX} 次救援）`);
        convo = await compactHistory(convo, model, chatFn, { knownTokens: lastPromptTokens, force: true });
        tokenWindowSpent = 0; // 新窗口：清零重算（usage 全程累计仍如实上报，不动）
        continue;
      }
      budgetExhausted = true; budgetKind = 'tokens';
      // Phase 3-1：预算熔断 = 暂停而非失败。挂起钩子（runner 侧落盘断点），
      // 保存成功后在收尾文案明示「断点已保存」，引导用户「继续」走断点恢复而非全量重放
      try {
        suspendNoticed = !!onSuspend?.({
          kind: 'tokens', summary: finalText, usage: { ...usage },
          roundsUsed, rescues: tokenRescues, windowSpent: tokenWindowSpent, budget: tokenBudget,
        });
      } catch (e) {
        console.warn('[agent] 断点保存钩子异常:', e.message);
      }
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
      console.warn(`[agent] 运行结束（正常收尾）：轮数=${roundsUsed}，累计 ${usage.prompt_tokens + usage.completion_tokens} tokens（窗口 ${tokenWindowSpent}）`);
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
          case 'read_file': {
            // Phase 3-2：run 内读取缓存。全文未变更的重复读取返回提示而非再次注入全文。
            const fs2 = await ensureNodeFs();
            const reqPath = String(toolArgs?.path || '');
            const isSegmented = toolArgs?.offset !== undefined || toolArgs?.limit !== undefined;
            let cacheAbs = null;
            let stat = null;
            if (fs2 && reqPath && !isSegmented) {
              try {
                cacheAbs = reqPath.startsWith('/') ? reqPath : `${cwd || '.'}/${reqPath}`;
                stat = fs2.statSync(cacheAbs);
                const prev = readFileCache.get(cacheAbs);
                if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size
                    && prev.len > FILE_CACHE_MIN_CHARS) {
                  toolResult = {
                    ok: true, path: cacheAbs, cached: true,
                    content: `（缓存命中：该文件自第 ${prev.round} 轮读取后未变更（mtime/size 一致，约 ${prev.len} 字符），完整内容已在上文中，本次不重复注入以节省上下文。如需重新查看请用 offset/limit 分段读取。）`,
                  };
                  break;
                }
              } catch { /* stat 失败照常直读 */ }
            }
            const readChannel = resolveChannel(toolHandlers, 'readFile');
            if (!readChannel) throw new Error('未知工具: read_file');
            toolResult = await readChannel(toolArgs, { signal });
            // 成功的全量大读取记录缓存锚点（后续同文件重复读取才会命中）
            try {
              if (fs2 && cacheAbs && stat && toolResult?.ok !== false
                  && typeof toolResult?.content === 'string'
                  && toolResult.content.length > FILE_CACHE_MIN_CHARS) {
                readFileCache.set(cacheAbs, {
                  mtimeMs: stat.mtimeMs, size: stat.size,
                  len: toolResult.content.length, round: roundsUsed,
                });
              }
            } catch { /* 缓存记录失败不影响结果返回 */ }
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
              // 第二参传运行上下文（signal 可用于长阻塞工具响应中止，如 orchestrate_task）
              toolResult = await channel(toolArgs, { signal });
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
      // Phase 3-3：超长输出先摘要化（PASS 折叠 + 头尾保留 + 原文落盘），再走截断兜底
      const toolContent = truncateToolResult(await summarizeToolOutput(toolResult, tc.function.name));
      const toolMsg = { role: 'tool', tool_call_id: tc.id, content: toolContent };
      convo.push(toolMsg);
      // tool 结果消息持久化（重进线程可完整重放工具链）
      await persistMessage?.(toolMsg);
    }
  }
  // 预算耗尽 / 熔断：如实告知未完成，引导用户「继续」接力（而非假装任务已结束）
  if (budgetExhausted) {
    console.warn(`[agent] 运行结束（${budgetKind} 熔断）：轮数=${roundsUsed}，累计 ${usage.prompt_tokens + usage.completion_tokens} tokens`);
    if (budgetKind === 'repeat') {
      finalText = `${finalText || ''}\n\n（已主动停止：工具 \`${repeatFailTool}\` 用相同参数连续失败 ${repeatFailCount} 次，`
        + '判定为无效重试而非任务不可完成，继续跑只会空转。请根据上述失败原因调整，或换个说法让我重新尝试。）'.trim();
    } else {
      const kindText = budgetKind === 'tokens' ? 'token 预算' : '执行轮次预算';
      const exhaustDetail = budgetKind === 'tokens'
        ? `（含每轮重复读取上下文的消耗，累计 ${usage.prompt_tokens + usage.completion_tokens} tokens，期间已自动压缩续跑 ${tokenRescues} 次；这是防失控上限，不是上下文放不下——上下文会自动压缩）`
        : '';
      finalText = `${finalText || '任务尚未完成。'}\n\n（单任务${kindText}已用尽${exhaustDetail}，任务未完全完成。发送「继续」让我接着执行。）`.trim();
      // Phase 3-1：断点保存成功 → 明示恢复语义（继续 = 断点摘要接续，不重读全部文件）
      if (suspendNoticed && budgetKind === 'tokens') {
        finalText += '\n\n（断点已保存：回复「继续」将从断点摘要接续执行，已完成部分不会重做。）';
      }
    }
  }
  // Phase 3-4：收尾时的最终用量快照（running=false，仪表盘定格显示）
  try {
    onBudget?.({
      round: roundsUsed, windowSpent: tokenWindowSpent, budget: tokenBudget,
      rescues: tokenRescues, rescueMax: TOKEN_RESCUE_MAX,
      promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
      running: false, budgetKind: budgetExhausted ? budgetKind : 'normal',
    });
  } catch (e) { /* 仪表盘上报绝不影响主流程 */ }
  onDone?.(finalText, usage, aborted);
  return finalText;
}
