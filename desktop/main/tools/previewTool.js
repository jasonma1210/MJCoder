// main/tools/previewTool.js
// 文件预览单元（2026-10-16 自 tools/exec.js 拆出——exec.js 回归 800 行 God File 门禁）
// 职责：file:preview 的类型白名单 / 大小分流 / 流式协议（mjpreview://）/ dataUrl 内联。
const path = require('path');
const fsp = require('fs/promises');
const { resolveToolPath } = require('./execCwd');

// 预览白名单：只有可安全内联渲染的类型才读二进制进渲染层，
// 其余一律交给系统默认应用打开——避免把 4K 视频、数据库文件等读进内存撑爆渲染进程。
const PREVIEW_BINARY_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const PREVIEW_MAX_BYTES = 24 * 1024 * 1024; // 24MB：图片/PDF/音视频应用内预览上限
// T3-1：超过 256KB 的二进制不再 base64 进 IPC 消息体，改发 mjpreview:// 流式协议 URL
const PREVIEW_INLINE_MAX = 256 * 1024;
const MEDIA_KINDS = /^(image|audio|video)\//;

// G1（多模态输入）：视觉输入白名单——模型只能吃栅格图，且必须内联为 data URL
// （mjpreview:// 流式 URL 无法作为 image_url 传给供应商）。svg 排除：它是文本/脚本载体，
// 既非有效视觉输入，也带 XSS 面（一旦被当图片解码渲染即注入）。
const MODEL_IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic',
};
// 12MB：主流视觉模型单图上限区间（OpenAI 20MB / Gemini 20MB / Claude 5MB 取交集偏保守）；
// base64 会膨胀 ~33%，再大过 IPC 与供应商都可能被拒。
const MODEL_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

// G1：为模型读取图片——固定返回 data URL（不走 previewUrl 分流），并对格式/体积设闸。
async function readForModel(target, ext, st) {
  const mime = MODEL_IMAGE_MIME[ext];
  if (!mime) {
    return { ok: false, path: target, error: `不支持的视觉输入格式：${ext || '(无扩展名)'}（仅支持 png/jpg/jpeg/gif/webp/bmp/avif/heic）` };
  }
  if (st.size > MODEL_IMAGE_MAX_BYTES) {
    return {
      ok: false, path: target, tooLarge: true, size: st.size,
      error: `图片 ${(st.size / 1048576).toFixed(1)}MB，超出视觉输入上限 ${MODEL_IMAGE_MAX_BYTES / 1048576}MB，请压缩或裁剪后重试`,
    };
  }
  const buf = await fsp.readFile(target);
  return { ok: true, path: target, kind: 'image', size: st.size, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

function previewKindOfMime(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (MEDIA_KINDS.test(mime)) return mime.split('/')[0]; // image | audio | video
  return 'text';
}

// file:preview handler 实现（文本类只回元信息，正文由 tool:readFile 分页取）
// forModel=true 时切换为「视觉输入」语义：图片固定内联 base64 data URL（见 readForModel）。
async function handleFilePreview({ path: p, cwd, forModel } = {}) {
  const target = resolveToolPath(p, cwd);
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) return { ok: false, path: target, error: '这是目录，请用「打开文件夹」在系统中浏览' };
    const ext = path.extname(target).toLowerCase();
    if (forModel) return await readForModel(target, ext, st);
    const mime = PREVIEW_BINARY_MIME[ext];
    if (!mime) {
      // 未知扩展名：按文本处理（渲染层读到非法编码会自行降级为「不支持预览」）
      return { ok: true, path: target, kind: 'text', size: st.size, ext };
    }
    const kind = previewKindOfMime(mime);
    if (st.size > PREVIEW_MAX_BYTES) {
      return {
        ok: true, path: target, kind, size: st.size, tooLarge: true, mime,
        error: `文件 ${(st.size / 1048576).toFixed(1)}MB，超出应用内预览上限 ${PREVIEW_MAX_BYTES / 1048576}MB，请在系统应用中打开`,
      };
    }
    if (st.size > PREVIEW_INLINE_MAX) {
      // T3-1：大二进制走流式协议——字节由 Chromium 网络栈按需加载，不过 IPC 消息体。
      // 延迟 require：测试环境 stub 的 electron 无 protocol/net，小文件路径不触发。
      const { grantPreviewToken } = require('../previewScheme');
      return { ok: true, path: target, kind, size: st.size, mime, previewUrl: grantPreviewToken(target) };
    }
    const buf = await fsp.readFile(target);
    return { ok: true, path: target, kind, size: st.size, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, notFound: true, path: target, error: `文件不存在：${target}` };
    if (err.code === 'EACCES') return { ok: false, path: target, error: '没有读取权限' };
    return { ok: false, path: target, error: err.message };
  }
}

module.exports = { handleFilePreview, previewKindOfMime };
