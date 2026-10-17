// P0-1③: provider × modelId → 上下文窗口「事实表」（渲染层 TS 版）
//
// 与 main/modelWindows.js **数据必须逐字节等值**：渲染层不能 require 主进程 .js，
// 双份是无奈之举 → 由 test/model-windows-parity.test.mjs 深比较（数据 + resolveWindow 行为矩阵）锁死漂移。
// 改表时两边同改：任何一侧单独变更都会让 parity 套件立刻变红。
//
// ⚠️ 两处取值有意偏离施工单（anthropic 200K 而非 1M、gpt-4.1 用官方 1,047,576）已由主理人裁决批准，
// 完整理由写在 main/modelWindows.js 表头注释里 —— 改表前先读那段，别"按施工单改回去"。
//
// 事实依据与取舍同主进程版（H-1）：默认档 32768（表外未知模型）、Ollama 探测失败 4096、
// Ollama 禁止写死窗口、必须按 (providerKind, modelId) 二元组查表。

export const DEFAULT_CONTEXT_WINDOW = 32768;
export const OLLAMA_UNKNOWN_NUM_CTX = 4096;

export const MODEL_WINDOWS: Record<string, number> = {
  'openai:gpt-4o': 128000,
  'openai:gpt-4o-mini': 128000,
  'openai:gpt-4.1': 1047576,
  'openai:gpt-4.1-mini': 1047576,
  'openai:gpt-4.1-nano': 1047576,
  'openai:gpt-5': 400000,
  'openai:gpt-5-mini': 400000,
  'openai:o3': 200000,
  'openai:o4-mini': 200000,
  'openai:gpt-4-turbo': 128000,
  'deepseek:deepseek-chat': 131072,
  'deepseek:deepseek-reasoner': 131072,
  'qwen:qwen3-8b': 131072,
  'qwen:qwen3-14b': 131072,
  'qwen:qwen3-32b': 131072,
  'gemini:gemini-2.5-pro': 1048576,
  'gemini:gemini-2.5-flash': 1048576,
};

export interface ModelFamily {
  kind: string;
  prefixes: string[];
  window: number;
}

export const MODEL_FAMILIES: ModelFamily[] = [
  { kind: 'anthropic-api', prefixes: ['claude-'], window: 200000 },
  { kind: 'bedrock', prefixes: ['claude-', 'anthropic.claude'], window: 200000 },
  { kind: 'deepseek', prefixes: ['deepseek-'], window: 131072 },
  { kind: 'qwen', prefixes: ['qwen3-'], window: 131072 },
  { kind: 'gemini', prefixes: ['gemini-'], window: 1048576 },
];

export const PROVIDER_KINDS = ['openai', 'deepseek', 'anthropic-api', 'bedrock', 'qwen', 'gemini', 'ollama'];

const KIND_ALIASES: Record<string, string> = {
  openai: 'openai', 'azure-openai': 'openai', azure: 'openai',
  deepseek: 'deepseek',
  anthropic: 'anthropic-api', 'anthropic-api': 'anthropic-api',
  bedrock: 'bedrock', aws: 'bedrock',
  qwen: 'qwen', dashscope: 'qwen', aliyun: 'qwen',
  gemini: 'gemini', google: 'gemini',
  ollama: 'ollama',
};

const HOST_RULES: { kind: string; tokens: string[] }[] = [
  { kind: 'ollama', tokens: ['11434', 'ollama'] },
  { kind: 'anthropic-api', tokens: ['api.anthropic.com'] },
  { kind: 'bedrock', tokens: ['bedrock'] },
  { kind: 'deepseek', tokens: ['deepseek.com'] },
  { kind: 'qwen', tokens: ['dashscope.aliyuncs.com', 'api.qwen.com'] },
  { kind: 'gemini', tokens: ['generativelanguage.googleapis.com'] },
  { kind: 'openai', tokens: ['api.openai.com', 'openai.azure.com'] },
];

function hostOf(baseUrl?: string): string {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    const m = raw.replace(/^[a-z]+:\/\//i, '').match(/^([^/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

export function providerKindOf(opts: { providerId?: string | number; baseUrl?: string } = {}): string {
  const host = hostOf(opts.baseUrl);
  if (host) {
    for (const rule of HOST_RULES) {
      if (rule.tokens.some((tk) => host.includes(tk))) return rule.kind;
    }
  }
  const pid = String(opts.providerId == null ? '' : opts.providerId).trim().toLowerCase();
  if (pid && KIND_ALIASES[pid]) return KIND_ALIASES[pid];
  return 'unknown';
}

export function normalizeModelId(modelId?: string | number | null): string {
  let id = String(modelId == null ? '' : modelId).trim().toLowerCase();
  if (!id) return '';
  id = id.replace(/^models\//, '');
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  const colon = id.indexOf(':');
  if (colon > 0) id = id.slice(0, colon);
  return id;
}

export interface ResolvedWindow {
  window: number;
  confirmed: boolean;
  source: 'table' | 'default' | 'ollama-probe';
}

/** 解析上下文窗口（三态返回，供 P1-12 的「未确认」警示使用） */
export function resolveWindow(opts: {
  providerId?: string | number;
  baseUrl?: string;
  modelId?: string | number | null;
  probedNumCtx?: number;
} = {}): ResolvedWindow {
  const kind = providerKindOf({ providerId: opts.providerId, baseUrl: opts.baseUrl });
  const id = normalizeModelId(opts.modelId);

  // Ollama：表内禁止写死（H-1）；只有探测值可信，缺失按官方最小档并标未确认
  if (kind === 'ollama') {
    const probed = Number(opts.probedNumCtx) > 0 ? Math.floor(Number(opts.probedNumCtx)) : 0;
    if (probed > 0) return { window: probed, confirmed: true, source: 'ollama-probe' };
    return { window: OLLAMA_UNKNOWN_NUM_CTX, confirmed: false, source: 'default' };
  }

  const exact = id ? MODEL_WINDOWS[kind + ':' + id] : 0;
  if (exact > 0) return { window: exact, confirmed: true, source: 'table' };

  if (id) {
    for (const fam of MODEL_FAMILIES) {
      if (fam.kind !== kind) continue;
      if (fam.prefixes.some((p) => id.startsWith(p))) {
        return { window: fam.window, confirmed: true, source: 'table' };
      }
    }
  }
  return { window: DEFAULT_CONTEXT_WINDOW, confirmed: false, source: 'default' };
}
