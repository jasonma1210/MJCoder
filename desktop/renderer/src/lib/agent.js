// Agent 引擎薄包装：真实引擎已抽离至 agent-core 包（headless 复用），
// 此处仅负责把渲染层工具通道（window.mjcode.*）组装成 toolHandlers 注入引擎。
import { runAgent as coreRunAgent, BASE_TOOLS, BUILTIN_SKILL_IDS, decomposeTask, looksLargeTask, parsePlanResponse } from '../../../agent-core/index.js';

export { BASE_TOOLS, BUILTIN_SKILL_IDS, decomposeTask, looksLargeTask, parsePlanResponse };

export function runAgent(options) {
  // 惰性解析：组件树渲染时 window.mjcode 可能尚未挂载，调用时再取
  const mj = () => globalThis.window?.mjcode;
  const requireChannel = (name) => (...args) => {
    const api = mj();
    if (!api || typeof api[name] !== 'function') throw new Error(`工具通道不可用: ${name}`);
    return api[name](...args);
  };
  const toolHandlers = {
    chat: requireChannel('chat'),
    shell: requireChannel('shell'),
    readFile: requireChannel('readFile'),
    writeFile: requireChannel('writeFile'),
    editFile: requireChannel('editFile'),
    applyPatch: requireChannel('applyPatch'),
    listDir: requireChannel('listDir'),
    grep: requireChannel('grep'),
    glob: requireChannel('glob'),
    gitStatus: requireChannel('gitStatus'),
    gitDiff: requireChannel('gitDiff'),
    gitLog: requireChannel('gitLog'),
    gitCommit: requireChannel('gitCommit'),
    gitAdd: (...args) => {
      const api = mj();
      if (api && typeof api.gitAdd === 'function') return api.gitAdd(...args);
      return { stdout: '', stderr: '', exitCode: 0, error: '当前版本不支持 gitAdd 通道' };
    },
    mcpCallTool: requireChannel('mcpCallTool'),
  };
  return coreRunAgent({ ...options, toolHandlers });
}
