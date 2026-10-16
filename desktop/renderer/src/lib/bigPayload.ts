// T3-1：大载荷句柄的渲染层消费端。
// 主进程把超限工具结果字段落盘后，IPC 事件里是 { __bigStr: id, bytes }（字符串）
// 或 { __bigJson: id, bytes }（对象/数组）。本模块提供：
//   · isBigRef：形状判别
//   · fetchBigChunk：分页拉取（preload bigPayloadFetch 通道）
//   · loadBigText：循环拉全量（带上限保护，供虚拟滚动一次性喂完整文本）
// 无 electron/主进程时（纯浏览器 dev 无 preload）一律降级为空结果，UI 显示「不可用」。
import { tGlobal } from '../i18n';

export type BigRef = { __bigStr: string; bytes: number } | { __bigJson: string; bytes: number };

export function isBigRef(v: unknown): v is BigRef {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.__bigStr === 'string' || typeof o.__bigJson === 'string';
}

export function bigRefId(ref: BigRef): string {
  return (ref as { __bigStr?: string }).__bigStr || (ref as { __bigJson?: string }).__bigJson || '';
}

type FetchResult = { ok: boolean; text?: string; offset?: number; total?: number; hasMore?: boolean; expired?: boolean; error?: string };

export async function fetchBigChunk(id: string, offset = 0, limit = 131072): Promise<FetchResult> {
  const fn = (window as unknown as { mjcode?: { bigPayloadFetch?: (p: object) => Promise<FetchResult> } }).mjcode?.bigPayloadFetch;
  if (!fn) return { ok: false, error: tGlobal('runtime.bigPayloadUnavailable') };
  try {
    return await fn({ id, offset, limit });
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// 全量装载上限：2MB 文本足够任何展示场景（超出部分截断并如实标注）
const LOAD_ALL_CAP = 2 * 1024 * 1024;

// 循环分页拉取全文（供虚拟滚动组件一次性喂入；页大小与主进程一致 128K 字符）
export async function loadBigText(id: string): Promise<{ ok: boolean; text?: string; truncated?: boolean; expired?: boolean; error?: string }> {
  let acc = '';
  let offset = 0;
  for (let page = 0; page < 64; page++) {
    const r = await fetchBigChunk(id, offset, 131072);
    if (!r.ok) return { ok: false, expired: r.expired, error: r.error };
    acc += r.text || '';
    if (!r.hasMore) return { ok: true, text: acc };
    offset += (r.text || '').length;
    if (offset >= LOAD_ALL_CAP) return { ok: true, text: acc, truncated: true };
  }
  return { ok: true, text: acc, truncated: true };
}
