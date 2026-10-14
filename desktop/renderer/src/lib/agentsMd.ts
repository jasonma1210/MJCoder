// AGENTS.md 项目规范加载（Codex 语义：从项目根逐级向上查找）
interface AgentsMd {
  path: string;
  content: string;
}

const MAX_DEPTH = 5;
const MAX_CONTENT = 400; // readFile 读取行数上限

export async function loadAgentsMd(cwd: string | undefined): Promise<AgentsMd | null> {
  if (!cwd || !window.mjcode?.readFile) return null;
  let dir = cwd.replace(/\/+$/, '');
  for (let i = 0; i < MAX_DEPTH; i++) {
    const filePath = `${dir}/AGENTS.md`;
    try {
      const r = (await window.mjcode.readFile({ path: filePath, limit: MAX_CONTENT })) as {
        content?: string;
      };
      if (r?.content) {
        return { path: filePath, content: r.content };
      }
    } catch {
      // 文件不存在或不可读，继续向上
    }
    const parent = dir.replace(/\/[^/]+$/, '');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
