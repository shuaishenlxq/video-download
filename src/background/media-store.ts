// ============ 媒体条目归并去重（F-104，纯逻辑，store 由调用方注入）============
import type { MediaHint, MediaItem } from '../shared/types';

export type StoredMediaItem = MediaItem;

export type MediaStore = Map<string, StoredMediaItem>; // key = dedupKey

const VOLATILE_PARAMS = ['_t', '_ts', 'token', 'expire', 'expires', 'sign', 'signature', 'auth_key'];

/** URL 归一化：剥易变参数（F-104 规则 5） */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (VOLATILE_PARAMS.includes(p.toLowerCase())) u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return url;
  }
}

const MANIFEST_EXT = /\.(m3u8|mpd)(\?|$)/i;
const SEGMENT_EXT = /\.(ts|m4s)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|flv|m4v)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i;

export function classifyHint(hint: Pick<MediaHint, 'url' | 'mime'>): 'manifest' | 'segment' | 'progressive' | 'blob' {
  if (hint.url.startsWith('blob:')) return 'blob';
  if (MANIFEST_EXT.test(hint.url)) return 'manifest';
  if (hint.mime) {
    const m = hint.mime.toLowerCase();
    if (m.includes('mpegurl') || m.includes('dash+xml')) return 'manifest';
    if (SEGMENT_EXT.test(hint.url) || m.includes('mp2t')) return 'segment';
    if (m.startsWith('video/') || m.startsWith('audio/')) return 'progressive';
  }
  if (SEGMENT_EXT.test(hint.url)) return 'segment';
  if (VIDEO_EXT.test(hint.url) || AUDIO_EXT.test(hint.url)) return 'progressive';
  // Content-Range 分片由调用方在 hint.mime 之外补充判断；默认不归类
  return 'progressive';
}

function dirOf(url: string): string {
  const i = url.lastIndexOf('/');
  return i > 0 ? url.slice(0, i + 1) : url;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    return name.replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 100) || u.hostname;
  } catch {
    return '未命名媒体';
  }
}

function isVideoHint(hint: MediaHint): boolean {
  if (AUDIO_EXT.test(hint.url)) return false;
  if (hint.mime?.startsWith('audio/')) return false;
  return true;
}

export interface MergeResult {
  created: boolean;
  item?: StoredMediaItem;
  dedupKey: string;
  /** 分片线索未归属任何清单（暂存等待清单出现） */
  pendingOnly?: boolean;
}

/** 分片暂存池：目录前缀 → 数量（不产生列表条目）。与 store 同生命周期（按 tab 维护） */
export type PendingSegments = Map<string, number>;

export interface MediaContext {
  store: MediaStore;
  pending: PendingSegments;
}

export function createContext(): MediaContext {
  return { store: new Map(), pending: new Map() };
}

export function mergeHint(hint: MediaHint, ctx: MediaContext, now: number): MergeResult {
  const { store, pending } = ctx;
  const kind = classifyHint(hint);
  const normalized = normalizeUrl(hint.url);

  if (kind === 'blob') {
    // E-019：blob 内存流，记录但不可直链下载
    const key = normalized;
    const existing = store.get(key);
    if (existing) return { created: false, item: existing, dedupKey: key };
    const item = makeItem(hint, key, now, { protocol: 'progressive', downloadable: false, blockedReason: 'blob' });
    store.set(key, item);
    return { created: true, item, dedupKey: key };
  }

  if (kind === 'manifest') {
    const key = normalized;
    let item = store.get(key);
    let created = false;
    if (!item) {
      created = true;
      const isDash = /\.mpd(\?|$)/i.test(hint.url) || hint.mime?.includes('dash+xml');
      item = makeItem(hint, key, now, {
        protocol: isDash ? 'dash' : 'hls',
        status: 'parsing',
        title: titleFromUrl(hint.url),
      });
      store.set(key, item);
      // 吸收同前缀的暂存分片（规则 2：清单为条目主体）
      const dir = dirOf(normalized);
      for (const [pdir, count] of [...pending.entries()]) {
        if (pdir.startsWith(dir) || dir.startsWith(pdir)) {
          item.segmentHintCount = (item.segmentHintCount ?? 0) + count;
          pending.delete(pdir);
        }
      }
    }
    return { created, item, dedupKey: key };
  }

  if (kind === 'segment') {
    // 已有清单条目：找路径前缀匹配（规则 1）
    const dir = dirOf(normalized);
    for (const item of store.values()) {
      if (item.protocol === 'hls' || item.protocol === 'dash') {
        const mdir = dirOf(item.masterUrl);
        if (dir.startsWith(mdir) || mdir.startsWith(dir)) {
          item.segmentHintCount = (item.segmentHintCount ?? 0) + 1;
          return { created: false, item, dedupKey: item.dedupKey ?? '' , pendingOnly: false };
        }
      }
    }
    // parentManifest 线索（MSE 反推）：预创建解析中条目
    if (hint.parentManifest) {
      const mkey = normalizeUrl(hint.parentManifest);
      let item = store.get(mkey);
      let created = false;
      if (!item) {
        created = true;
        const isDash = /\.mpd(\?|$)/i.test(hint.parentManifest);
        item = makeItem(hint, mkey, now, {
          protocol: isDash ? 'dash' : 'hls',
          status: 'parsing',
          title: titleFromUrl(hint.parentManifest),
        });
        store.set(mkey, item);
      }
      item.segmentHintCount = (item.segmentHintCount ?? 0) + 1;
      return { created, item, dedupKey: mkey };
    }
    // 无主分片：暂存（规则 2：宁可等清单，不出噪音条目）
    pending.set(dir, (pending.get(dir) ?? 0) + 1);
    return { created: false, dedupKey: normalized, pendingOnly: true };
  }

  // progressive：直接成条
  const key = normalized;
  const existing = store.get(key);
  if (existing) {
    // 更新体积等补充信息
    if (hint.size && !existing.sizeEstimate) existing.sizeEstimate = hint.size;
    return { created: false, item: existing, dedupKey: key };
  }
  const item = makeItem(hint, key, now, {});
  store.set(key, item);
  return { created: true, item, dedupKey: key };
}

function makeItem(
  hint: MediaHint,
  dedupKey: string,
  now: number,
  over: Partial<MediaItem>
): StoredMediaItem {
  const type: 'video' | 'audio' = isVideoHint(hint) ? 'video' : 'audio';
  return {
    id: hashKey(dedupKey),
    tabId: hint.tabId,
    type,
    status: 'ready',
    protocol: 'progressive',
    title: hint.pageTitleSource ? cleanTitle(hint.pageTitleSource) : titleFromUrl(hint.url),
    masterUrl: hint.url,
    variants: [],
    tracks: [],
    durationSec: null,
    sizeEstimate: hint.size ?? null,
    sizeIsEstimate: false,
    encryption: 'none',
    downloadable: true,
    live: false,
    siteDomain: hostOf(hint.url),
    detectedAt: now,
    dedupKey,
    ...over,
  };
}

export function cleanTitle(raw: string): string {
  return raw
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 去重键哈希：简单稳定的 32 位 FNV-1a 十六进制（无 crypto 依赖，纯逻辑可测） */
export function hashKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
