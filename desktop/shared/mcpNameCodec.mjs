// MCP 工具名「拼名 / 反解」编解码器 —— 跨宿主单一事实来源（第八轮 F-005 / B1-B-05）
//
// ── 缺陷（改前，可确定性复现） ────────────────────────────────────────────────
//   拼名（shared/mcpToolDefs.mjs）与反解（agent-core/index.js）此前各写一份**朴素拼接**：
//     拼：`mcp__${server}__${tool}`
//     解：把工具名按 `__` 切分 → `server = 第 2 段`、`tool = 其余各段拼回`
//   二者**不是互逆函数**——只要 server 名里含 `__`（用户可自由命名，入口只校验长度 ≤120）：
//     server=`my__svc`, tool=`x` → 名称 `mcp__my__svc__x`
//     切分后为空段/`my`/`svc`/`x` → server=`my`、tool=`svc__x`
//   结果：调用被路由到 **另一个服务**（同名前缀或根本不存在），工具名也错了，
//   全程不报错、不告警 —— 模型看到工具 A，实际执行落到 B 上。
//
// ── 修法：分隔符唯一化 ───────────────────────────────────────────────────────
//   反解歧义的根因不是「没做转义」，而是**分隔符 `__` 由用户可控字符组成**。
//   本模块把「服务名片段」编码成一个**绝不含 `_`** 的字节串：
//     · `[A-Za-z0-9-]` 原样保留；
//     · 其余一律按 UTF-8 逐字节写成 `%XX`（大写十六进制）。
//   于是 `_` → `%5F`、`%` → `%25`（`%` 本身不在安全集，天然被转义，顺序问题消失），
//   空格 → `%20`、中文 → `%E4%B8%AD`…… 服务名片段内**不可能出现 `_`**，
//   因此 `mcp__<片段>__<工具名>` 里第一个 `__` 就是唯一分隔符 —— 反解可逆且无歧义。
//   工具名片段**不编码**（工具名由 MCP server 自己给出，含 `__` 也无所谓：它在分隔符之后，
//   是「剩余全部」，不参与切分决策）。
//
// ── 硬约束：安全名零迁移 ────────────────────────────────────────────────────
//   匹配 `^[A-Za-z0-9-]+$` 的服务名原样返回（`filesystem` / `time` / `fetch` / `github` …）。
//   即：**已落盘配置、已缓存的工具清单、已写进提示词前缀的工具名逐字节不变**，
//   不存在「升级后旧配置全废」的迁移成本；只有本来就不可靠的名字（含 `__` / 空格 / 非 ASCII）
//   才改变拼写，而那些名字在改前**本身就是坏的**。
//
// ── 旧格式兼容 ──────────────────────────────────────────────────────────────
//   `decodeToolName` 必须能解改前产出的名字（如 `mcp__filesystem__read`）：
//   片段里没有 `%` 时按字面量返回，**不因为「没有编码痕迹」而拒绝**。
//   片段里有 `%` 但不构成合法 `%XX` 序列（如服务名真的叫 `%weird%`）时同样按字面量处理。
//   已知不可消除的歧义（改前就已存在，非本模块引入）：改前产出的 `mcp__my__svc__x`
//   在字节上无法与 server=`my`, tool=`svc__x` 区分——名字里没有留下编码痕迹；
//   这类名字只能靠**重新连接后重新拼名**修正（新拼名为 `mcp__my%5F%5Fsvc__x`）。
//
// ── 已知限制（本轮不修，需 B2 定阈值后补） ──────────────────────────────────
//   编码后长度会膨胀：ASCII 安全字符 1:1，而**每个被转义字节 → 3 字符**（`%XX`）。
//   UTF-8 下中文 1 字符 = 3 字节 = **9 字符**（实测：8 字中文服务名 8 → 72；120 字 → 1080）。
//   模型供应商对 `function.name` 有长度上限（本仓库 main/mcpClient.js 对**工具名**段限 128），
//   服务名段当前**没有**编码后长度校验（入口只校验原始 name ≤ 120 字符），因此超长中文服务名
//   可能在供应商侧被 400 拒绝。改前这种情况是「含非 ASCII 直接被拒」，现在至少能连上、
//   只在极长时触顶 —— 故本轮**不擅自加拒绝规则**（会误伤现有中文命名配置），留待 B2 统一
//   定「编码后全名长度预算」后补校验。
//
// ── 零依赖 ──────────────────────────────────────────────────────────────────
//   不用 `Buffer`（渲染层经 Vite 打包，无 Node 内建），只用 `TextEncoder` / `TextDecoder`
//   （Node ≥11 与所有浏览器均为全局）。与 shared/untrustedContent.mjs、shared/mcpToolDefs.mjs
//   同构：**主进程（CJS，动态 import）与渲染层（ESM，静态 import）共用同一份实现**。

/** 工具名前缀（与 model 侧约定、历史实现一致，勿改）。 */
const MCP_PREFIX = 'mcp__';
/** 反解时服务名与工具名之间的分隔符。 */
const SEP = '__';

const utf8Encode = new TextEncoder();
const utf8Decode = new TextDecoder('utf-8', { fatal: true });

/** 安全字符集：ASCII 字母 / 数字 / 连字符。这些字符不进 `%XX`，保证安全名输出与输入逐字节相同。 */
function isSafeByte(b) {
  return (
    (b >= 0x30 && b <= 0x39) // 0-9
    || (b >= 0x41 && b <= 0x5a) // A-Z
    || (b >= 0x61 && b <= 0x7a) // a-z
    || b === 0x2d // -
  );
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9-]+$/;
const HEX2_RE = /^[0-9A-Fa-f]{2}$/;

function pct(b) {
  return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * 服务名 → 可逆编码片段（**绝不含 `_`**）。
 *
 * 安全名（`^[A-Za-z0-9-]+$`）原样返回 —— 这是零迁移硬约束，见文件头。
 * 其余按 UTF-8 字节逐个转义：`_`→`%5F`、`%`→`%25`、空格→`%20`、`中`→`%E4%B8%AD`。
 *
 * 注意：含孤立代理对（非法 Unicode）的字符串经 UTF-8 编码会变成 U+FFFD，**不可逆**；
 *   这类名字应在入口被拒（见 `isEncodedNameSafe` / `main/ipc/mcp.js` 的连接校验）。
 */
export function encodeServerSegment(server) {
  const s = server == null ? '' : String(server);
  if (SAFE_SEGMENT_RE.test(s)) return s; // 零迁移：安全名逐字节不变
  let out = '';
  for (const b of utf8Encode.encode(s)) {
    out += isSafeByte(b) ? String.fromCharCode(b) : pct(b);
  }
  return out;
}

/**
 * 编码片段 → 服务名（`encodeServerSegment` 的逆）。
 * 无 `%` → 旧格式，原样返回；`%` 后不是两位十六进制 / 解出非法 UTF-8 → 也按字面量原样返回
 * （宁可把「看似编码实则字面量」的名字当字面量，也不要凭空返回 null 把存量服务废掉）。
 */
function decodeServerSegment(seg) {
  if (!seg.includes('%')) return seg;
  const bytes = [];
  for (let i = 0; i < seg.length;) {
    const ch = seg[i];
    if (ch === '%') {
      const hex = seg.slice(i + 1, i + 3);
      if (!HEX2_RE.test(hex)) return seg; // 不是编码结果 → 字面量
      bytes.push(parseInt(hex, 16));
      i += 3;
      continue;
    }
    const code = seg.charCodeAt(i);
    if (code > 0x7f) return seg; // 旧格式可能含非 ASCII 字面量 → 字面量
    bytes.push(code);
    i += 1;
  }
  try {
    return utf8Decode.decode(Uint8Array.from(bytes));
  } catch {
    return seg; // 非法 UTF-8 → 字面量（保持旧格式可读，不拒绝）
  }
}

/**
 * 拼名：`mcp__<编码后的 server>__<tool>`。
 * 唯一事实来源 —— 任何地方需要「工具名长什么样」都必须调用本函数，不得再手写模板字符串。
 */
export function buildToolName(server, tool) {
  const t = tool == null ? '' : String(tool);
  return `${MCP_PREFIX}${encodeServerSegment(server)}${SEP}${t}`;
}

/**
 * 反解：完整工具名 → `{ server, tool }`；不是 `mcp__` 前缀或结构不完整时返回 `null`。
 *
 * 切分依据：服务名片段不含 `_`（编码保证），故 `rest` 中**第一个** `__` 即唯一分隔符。
 * 工具名含 `__` 也不歧义（分隔符之后是剩余全部）。
 */
export function decodeToolName(fullName) {
  const name = fullName == null ? '' : String(fullName);
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(SEP);
  if (sep < 0) return null; // 缺分隔符：不是本模块产出的形状
  const serverSeg = rest.slice(0, sep);
  const tool = rest.slice(sep + SEP.length);
  if (!serverSeg || !tool) return null; // 服务名或工具名为空 → 结构非法
  const server = decodeServerSegment(serverSeg);
  if (!server) return null;
  return { server, tool };
}

/**
 * 该完整工具名是否为**可唯一反解**的规范拼名（入口校验用）。
 * 判定 = 「反解后再拼回去，必须逐字节相同」：既排除结构非法，也排除非规范编码
 * （如小写十六进制 `%5f`、旧格式 `my__svc` 片段）。
 */
export function isEncodedNameSafe(fullName) {
  const name = fullName == null ? '' : String(fullName);
  const parsed = decodeToolName(name);
  if (!parsed) return false;
  return buildToolName(parsed.server, parsed.tool) === name;
}
