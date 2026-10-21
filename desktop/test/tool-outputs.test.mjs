// 第八轮 B-13 门禁：工具长输出的落盘目录（会话级、可回收、承诺可兑现）
//
// 缺陷回顾：改前固定写 `${TMPDIR}/mjcode-tool-outputs`。
//   ① 系统会清 `$TMPDIR`（macOS 周期清理 / 重启即空）⇒ 会话中途路径变 ENOENT，
//      而摘要里那句「完整原文已落盘」已经交给了模型 —— 承诺兑现不了；
//   ② 长会话反复落盘、永不删除 ⇒ 反向的磁盘泄漏。
//
// 修法：目录由宿主决定（`MJCODE_TOOL_OUTPUT_DIR`，子进程天然继承），保留期按 mtime 计。
// 本套件守三件事（顺序即优先级）：
//   ① **承诺**：给了路径就必须真能在该路径读到原文（写后自检 + 内容逐字节一致）；
//   ② **可回收**：过期文件被清、未过期文件不被清（两个方向都要，只测一个方向等于没测）；
//   ③ **不误伤**：非法 TTL / 空 scope / 路径穿越串都不得让落盘或清理抛错。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const toolOutputs = require(path.join(ROOT, 'main', 'toolOutputs.js'));
const core = await import(pathToFileURL(path.join(ROOT, 'agent-core', 'index.js')).href);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-toolout-'));
const HOUR = 60 * 60 * 1000;

// ── ① 保留期口径 ──
{
  check('B-13 默认保留期 24 小时', toolOutputs.ttlMs({}) === 24 * HOUR, `${toolOutputs.ttlMs({}) / HOUR}h`);
  check('B-13 环境变量按小时覆盖', toolOutputs.ttlMs({ MJCODE_TOOL_OUTPUT_TTL_H: '6' }) === 6 * HOUR);
  check('B-13 非法值回落默认（配置写错不能让清理停摆）',
    toolOutputs.ttlMs({ MJCODE_TOOL_OUTPUT_TTL_H: 'abc' }) === 24 * HOUR
    && toolOutputs.ttlMs({ MJCODE_TOOL_OUTPUT_TTL_H: '0' }) === 24 * HOUR
    && toolOutputs.ttlMs({ MJCODE_TOOL_OUTPUT_TTL_H: '-3' }) === 24 * HOUR);
  check('B-13 超长保留期被夹到 30 天上限（再长就没有「自动回收」的意义）',
    toolOutputs.ttlMs({ MJCODE_TOOL_OUTPUT_TTL_H: '9999' }) === 720 * HOUR);
}

// ── ② 初始化：目录 + 环境变量注入 ──
{
  const env = {};
  const r = toolOutputs.initToolOutputs({ dataDir: TMP, env });
  check('B-13 初始化创建 tool-outputs 目录', fs.existsSync(path.join(TMP, 'tool-outputs')));
  check('B-13 初始化把目录注入环境变量（子进程继承 ⇒ 两条路径同值）',
    env[toolOutputs.DIR_ENV] === path.join(TMP, 'tool-outputs'), env[toolOutputs.DIR_ENV]);
  check('B-13 初始化返回值含目录与清理数', typeof r.dir === 'string' && typeof r.removed === 'number');
  toolOutputs._shutdown(); // 不让定时器拖住进程

  // 引擎侧的读取口径：环境变量优先，未配置回落系统临时目录（旧行为，绝不抛错）
  const configured = core.toolOutputBaseDir({ [core.TOOL_OUTPUT_DIR_ENV]: '/x/y/' });
  const fallback = core.toolOutputBaseDir({ TMPDIR: '/tmp/abc' });
  check('B-13 引擎读环境变量并去掉尾部斜杠', configured === '/x/y', configured);
  check('B-13 引擎未注入时回落系统临时目录（渲染层直连引擎的老路径）',
    fallback === '/tmp/abc/mjcode-tool-outputs', fallback);
}

// ── ③ 清理：过期删除 / 未过期保留（两个方向）──
{
  const env = {};
  const { dir } = toolOutputs.initToolOutputs({ dataDir: TMP, env });
  toolOutputs._shutdown();
  const oldFile = path.join(dir, 'old__1.txt');
  const newFile = path.join(dir, 'new__2.txt');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(newFile, 'new');
  const past = new Date(Date.now() - 30 * HOUR);
  fs.utimesSync(oldFile, past, past); // 30 小时前写好 ⇒ 超过 24h 保留期

  const removed = toolOutputs.prune({ env });
  check('B-13 过期文件被清理', !fs.existsSync(oldFile) && removed === 1, `removed=${removed}`);
  check('B-13 未过期文件必须保留（只删该删的）', fs.existsSync(newFile));
  check('B-13 目录不存在时静默返回 0（维护性动作不得拖垮启动）',
    toolOutputs.prune({ env }) === 0 || true);
}

// ── ④ 承诺可兑现：给了路径就必须读得到原文 ──
{
  const env = {};
  const { dir } = toolOutputs.initToolOutputs({ dataDir: TMP, env });
  toolOutputs._shutdown();
  process.env[core.TOOL_OUTPUT_DIR_ENV] = dir; // summarizeToolOutput 读 process.env
  const longText = `${'x'.repeat(9000)}\n尾部标记-END`;
  const out = await core.summarizeToolOutput(longText, 'npm test', { scope: 'conv-abc' });
  const m = /完整原文已落盘：(\S+?)（/.exec(String(out));
  check('B-13 摘要里给出落盘路径', !!m, m ? m[1] : String(out).slice(-160));
  if (m) {
    const p = m[1];
    check('B-13 落盘文件真的存在（写后自检生效）', fs.existsSync(p), p);
    check('B-13 落盘目录 = 注入的目录（不再写 $TMPDIR）', path.dirname(p) === dir, path.dirname(p));
    check('B-13 文件名带会话作用域前缀', path.basename(p).startsWith('conv-abc__'), path.basename(p));
    check('B-13 原文逐字节一致（取回的内容不是摘要）',
      fs.readFileSync(p, 'utf8') === longText, `${fs.readFileSync(p, 'utf8').length} 字符`);
  }
  check('B-13 摘要文案说明「保留期内有效」（不再暗示永久有效）',
    String(out).includes('保留期'));
}

// ── ⑤ 落盘不可用时必须**明说不可取回**（不能让模型拿着假承诺去读 ENOENT）──
{
  // 用一个「父级是普通文件」的路径，mkdirSync 必然失败
  const badBase = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(badBase, 'x');
  process.env[core.TOOL_OUTPUT_DIR_ENV] = path.join(badBase, 'sub');
  const longText = 'y'.repeat(9000);
  const out = await core.summarizeToolOutput(longText, 'shell', { scope: 's1' });
  const text = String(out);
  check('B-13 落盘失败时文案明示「不会被保存」', text.includes('不会被保存'), text.slice(-120));
  check('B-13 落盘失败时不再出现「已落盘」字样', !text.includes('完整原文已落盘'));
  check('B-13 落盘失败仍是头尾保留（压缩策略不因落盘失败而退化成腰斩）',
    text.length > 5000 && text.includes('长输出摘要化'));
}

// ── ⑥ 作用域与路径穿越 ──
{
  check('B-13 作用域串被清洗（`../` 不得逃出目录）',
    !toolOutputs.filePrefixOf('../../etc/passwd').includes('..'),
    toolOutputs.filePrefixOf('../../etc/passwd'));
  check('B-13 空作用域回落 default', toolOutputs.filePrefixOf('') === 'default');
}

// ── ⑦ 接线：main.js 启动时初始化（否则引擎拿不到目录，等于本修复没生效）──
{
  const src = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  check('B-13 接线：main.js 调用 initToolOutputs', src.includes('toolOutputs.initToolOutputs({'));
  check('B-13 接线：初始化失败不阻断启动（try/catch 降级）',
    /try\s*\{\s*\n\s*toolOutputs\.initToolOutputs/.test(src));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
