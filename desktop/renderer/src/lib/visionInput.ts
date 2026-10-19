// G1（多模态输入）：附件图片 → vision 内容部件（纯函数，无 React 依赖）。
//
// 为什么单独成模块：useAgentRun.ts 已贴 800 行 God File 门禁（max-lines.test.js
// 基线「只减不增」），读图装配属独立关注点，抽出同时便于单测直调。
//
// 形态：OpenAI 兼容通道统一的 `image_url` data URL 部件（本项目全部走
// `/chat/completions`，无原生 Anthropic 传输，故不做格式分流）。
// 门控：仅当模型声明支持图像（caps.supportsImages）时读取；单张失败逐张降级跳过，
// 不阻断整轮（图文混排丢一张图好过整轮失败）。

export interface AttachmentLike {
  path?: string;
  isImage?: boolean;
  name?: string;
}

export interface VisionPart {
  type: 'image_url';
  image_url: { url: string };
}

interface ModelLike {
  model?: {
    caps?: { supportsImages?: boolean };
    supportsImages?: boolean;
  };
}

export async function buildVisionParts(
  list: AttachmentLike[] | undefined,
  selectedModel: ModelLike | null | undefined,
): Promise<VisionPart[]> {
  const caps = selectedModel?.model?.caps;
  const supportsImages = caps?.supportsImages === true
    || selectedModel?.model?.supportsImages === true;
  if (!supportsImages || !Array.isArray(list) || list.length === 0) return [];
  const parts: VisionPart[] = [];
  for (const a of list) {
    if (!a?.isImage || !a?.path) continue;
    try {
      // 复用既有 file:preview 通道的 forModel 语义（主进程侧固定内联 base64 data URL）
      const r = await window.mjcode?.previewFile?.({ path: a.path, forModel: true }) as
        | { ok?: boolean; dataUrl?: string; error?: string }
        | undefined;
      if (r?.ok && r.dataUrl) parts.push({ type: 'image_url', image_url: { url: r.dataUrl } });
      else if (r?.error) console.warn(`[chat] image not sent with message (${a.path}): ${r.error}`);
    } catch (err) {
      console.warn('[chat] image read failed:', err);
    }
  }
  return parts;
}
