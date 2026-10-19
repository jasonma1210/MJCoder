// G1（多模态输入）接线门禁（2026-10-19）
//
// 缺陷形态：拖入截图后，主对话通道只拿到 `@` 路径文本引用，视觉模型看不到图像像素
//   （仅能读到文件名），「看着截图回答」名存实亡。
// 修法：附件里的图片按模型能力读成 data URL，拼进本轮 user 消息的 `image_url` 内容部件；
//   落库与界面展示仍是文本 @path（DB content 恒为字符串，不引入 schema 变更）。
//
// 本套件锁两段链：
//   ① 主进程读图通道：file:preview 的 forModel 语义 —— 固定内联 base64、栅格图白名单、
//      视觉体积上限（svg 明确拒绝）；
//   ② 渲染层装配：按 supportsImages 门控 → 读图 → 组装 `image_url` 部件 → 只用于运行
//      上下文（持久化/展示仍走文本 userMsg）；再经引擎透传到出站 body 不丢部件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runAgent } from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const { handleFilePreview } = require('../main/tools/previewTool.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-vision-'));
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==',
  'base64',
);
const pngPath = path.join(tmp, 'shot.png');
fs.writeFileSync(pngPath, PNG_1PX);
const svgPath = path.join(tmp, 'icon.svg');
fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const txtPath = path.join(tmp, 'note.txt');
fs.writeFileSync(txtPath, 'hi');

// ── ① 主进程读图通道（forModel 语义）─────────────
{
  const r = await handleFilePreview({ path: pngPath, forModel: true });
  check('forModel=true 对 png 返回 base64 data URL',
    r?.ok === true && typeof r.dataUrl === 'string'
    && r.dataUrl.startsWith('data:image/png;base64,') && r.mime === 'image/png');
  check('返回体带 kind=image（供调用方判形态）', r?.kind === 'image');
}
check('forModel=true 拒绝 svg（脚本载体，非视觉输入）', await (async () => {
  const r = await handleFilePreview({ path: svgPath, forModel: true });
  return r?.ok === false && /不支持的视觉输入格式/.test(r.error || '');
})());
check('forModel=true 拒绝非图片扩展名', await (async () => {
  const r = await handleFilePreview({ path: txtPath, forModel: true });
  return r?.ok === false && /不支持的视觉输入格式/.test(r.error || '');
})());
check('forModel=true 对目录返回结构化拒绝（不抛错）', await (async () => {
  const r = await handleFilePreview({ path: tmp, forModel: true });
  return r?.ok === false && !!r.error;
})());
// 回归：普通预览（无 forModel）行为不变——小图仍内联 `${mime}` dataUrl
check('回归：普通预览对 png 仍返回 dataUrl（未改原路径）', await (async () => {
  const r = await handleFilePreview({ path: pngPath });
  return r?.ok === true && typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/png;base64,');
})());

// ── ② 源码接线（两处最易漏的环节）───────────────
const preview = read('main/tools/previewTool.js');
check('previewTool 声明视觉白名单与体积上限',
  /MODEL_IMAGE_MIME/.test(preview) && /MODEL_IMAGE_MAX_BYTES/.test(preview));
check('previewTool 有 forModel 分流（早于旧 preview 的流式分流）',
  /if \(forModel\) return await readForModel\(/.test(preview)
  && preview.indexOf('if (forModel)') < preview.indexOf('if (st.size > PREVIEW_INLINE_MAX)'));
check('保留原预览态 data URL 形态（big-payload 门禁依赖 `${mime}`）',
  /dataUrl: `data:\$\{mime\};base64/.test(preview));

const hook = read('renderer/src/hooks/useAgentRun.ts');
const vision = read('renderer/src/lib/visionInput.ts');
check('useAgentRun 经独立模块装配（护 800 行门禁）', /from '\.\.\/lib\/visionInput'/.test(hook));
check('visionInput 按 supportsImages 门控读取图片',
  /supportsImages === true/.test(vision) && /isImage/.test(vision));
check('visionInput 组装 OpenAI 兼容 image_url 部件',
  /type: 'image_url', image_url: \{ url: r\.dataUrl \}/.test(vision));
check('读图走既有 file:preview 通道（forModel:true，无新 IPC）',
  /previewFile\?\.\(\{ path: a\.path, forModel: true \}\)/.test(vision));
check('部件只进「运行上下文」（history），持久化/展示仍用文本 userMsg',
  /const history = \[\.\.\.messagesRef\.current, runUserMsg\]/.test(hook)
  && /api\.sendMessage\(currentThread\.id, userMsg\)/.test(hook));

// ── ③ 引擎透传：数组 content 不被打回字符串 ──────
const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.example.com/v1' },
  model: { id: 1, model_id: 'vision-model', context_window: 128000 },
};
let outbound = null;
await runAgent({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '看这张图\n@/tmp/shot.png' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }],
  model,
  maxRounds: 1,
  toolHandlers: {
    chat: async (payload) => {
      outbound = payload.messages;
      return { content: '好的', usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  },
  onMessage: () => {},
  onDone: () => {},
});
{
  const last = Array.isArray(outbound) ? outbound[outbound.length - 1] : null;
  check('出站 body 保留数组 content（未被 normalize 打回字符串）',
    last?.role === 'user' && Array.isArray(last.content));
  check('image_url 部件原样透传到模型请求',
    Array.isArray(last?.content) && last.content.some((c) => c.type === 'image_url' && c.image_url?.url?.startsWith('data:image/png;base64,')));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }

console.log(`\nvision-input-wiring: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
