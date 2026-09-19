// ============ 清单解析编排（F-103）+ 元数据补全（F-105）============
import type { MediaItem, MediaHint, Variant, TrackRef, EncryptionType } from '../shared/types';
import { parseM3u8 } from './parser/m3u8';
import { parseMpd, expandSegments } from './parser/mpd';
import { updateItem, getItem, pageTitle } from './tab-store';
import { getSettings } from './settings';
import { hostOf } from './media-store';
import { log, sanitizeUrl } from './logger';

export { sanitizeUrl };

/** 带凭证抓取清单（F-103 规则 6：Cookie 由浏览器会话携带；Referer 由 DNR 规则补，见 dnr.ts） */
export async function fetchManifest(url: string, pageUrl?: string): Promise<string> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw Object.assign(new Error(`manifest_http_${res.status}`), { statusCode: res.status });
  const text = await res.text();
  if (!text.trim()) throw new Error('manifest_empty');
  return text;
}

/** 解析队列：并发 3，防抖避免页面加载时风暴 */
const pending = new Map<string, Promise<void>>();

export function enqueueParse(item: MediaItem, pageUrl?: string): void {
  if (pending.has(item.id)) return;
  const p = doParse(item, pageUrl).finally(() => pending.delete(item.id));
  pending.set(item.id, p);
}

async function doParse(item: MediaItem, pageUrl?: string): Promise<void> {
  try {
    if (item.protocol === 'hls') await parseHls(item, pageUrl);
    else if (item.protocol === 'dash') await parseDash(item, pageUrl);
    // progressive：无清单可解析，直接 ready
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    // E-001 / E-002：解析失败降级为仅记录地址，保留直接下载入口
    const updated = getItem(item.tabId, item.id) ?? item;
    updated.status = 'parse_failed';
    updated.parseError = err.statusCode ? `HTTP ${err.statusCode}` : '格式非法';
    await updateItem(updated);
    log.warn('analyzer', `清单解析失败 ${sanitizeUrl(item.masterUrl)}`, `${updated.parseError}，可尝试直接下载`);
  }
}

async function parseHls(item: MediaItem, pageUrl?: string): Promise<void> {
  const text = await fetchManifest(item.masterUrl, pageUrl);
  const r = parseM3u8(text, item.masterUrl);
  if (r.type === 'error') throw new Error('bad_playlist');
  if (r.type === 'master') {
    // 主清单：变体填充；每个变体的媒体清单惰性解析（选中/下载时再深入）
    const updated = getItem(item.tabId, item.id) ?? item;
    updated.variants = r.variants;
    updated.status = 'ready';
    updated.encryption = 'none';
    updated.downloadable = true;
    updated.title = deriveTitle(updated, pageUrl);
    updated.sizeEstimate = null;
    await updateItem(updated);
    log.info('analyzer', `HLS 主清单解析完成 ${sanitizeUrl(item.masterUrl)}`, `变体=${r.variants.length}`);
    // 逐变体预解析媒体清单以获得时长/加密（限制并发 2）
    await probeVariants(updated, pageUrl);
    return;
  }
  // 媒体清单直接命中（无主清单）
  const updated = getItem(item.tabId, item.id) ?? item;
  applyMediaPlaylist(updated, {
    segments: r.segments,
    durationSec: r.durationSec,
    encryption: r.encryption,
    live: r.live,
    playlistUrl: item.masterUrl,
    avgSegmentDur: r.avgSegmentDur,
  });
  updated.title = deriveTitle(updated, pageUrl);
  await updateItem(updated);
  log.info('analyzer', `HLS 媒体清单解析完成 ${sanitizeUrl(item.masterUrl)}`, `分片=${r.segments.length} 时长=${Math.round(r.durationSec)}s 加密=${r.encryption.method}`);
}

/** 预解析变体媒体清单：拿时长/加密/分片数（F-103 规则 8 分片数预估） */
async function probeVariants(item: MediaItem, pageUrl?: string): Promise<void> {
  const concurrency = 2;
  const queue = [...item.variants];
  const worker = async () => {
    while (queue.length) {
      const v = queue.shift()!;
      try {
        const text = await fetchManifest(v.playlistUrl, pageUrl);
        const r = parseM3u8(text, v.playlistUrl);
        if (r.type !== 'media') continue;
        const segUrls = r.segments.map((s) => s.url);
        v.durationSec = r.durationSec;
        v.segmentCount = r.segments.length;
        v.avgSegmentDur = r.avgSegmentDur;
        v.sizeEstimate = null; // 体积由下载期实测校准
        (v as Variant & { segUrls?: string[] }).segUrls = segUrls;
        (v as Variant & { enc?: unknown }).enc = r.encryption;
        if (r.encryption.method === 'aes128') {
          item.encryption = 'aes128';
        } else if (r.encryption.method === 'sampleaes') {
          item.encryption = 'sampleaes';
          item.downloadable = false;
          item.blockedReason = 'sampleaes';
        }
      } catch {
        // 变体预解析失败不阻断（E-002），保留变体供直接下载尝试
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const updated = getItem(item.tabId, item.id) ?? item;
  updated.variants = [...item.variants];
  // 加密判定升级后重算可下载性（F-110 规则 4）
  applyDownloadable(updated);
  await updateItem(updated);
}

interface MediaPlaylistInfo {
  segments: { url: string; durationSec: number; index: number }[];
  durationSec: number;
  encryption: { method: string; keyUrl?: string; ivHex?: string };
  live: boolean;
  playlistUrl: string;
  avgSegmentDur: number;
}

function applyMediaPlaylist(item: MediaItem, info: MediaPlaylistInfo): void {
  item.variants = [
    {
      id: 'default',
      playlistUrl: info.playlistUrl,
      durationSec: info.durationSec,
      segmentCount: info.segments.length,
      avgSegmentDur: info.avgSegmentDur,
      recommended: true,
      ...(info.segments.length ? { sizeEstimate: null } : {}),
    } as Variant,
  ];
  (item.variants[0] as Variant & { segUrls?: string[] }).segUrls = info.segments.map((s) => s.url);
  (item.variants[0] as Variant & { enc?: unknown }).enc = info.encryption;
  item.durationSec = info.durationSec;
  item.live = info.live;
  if (info.live) {
    // E-020：直播流本期不支持下载
    item.status = 'unsupported';
    item.downloadable = false;
    item.blockedReason = 'live';
  } else if (info.encryption.method === 'aes128') {
    item.status = 'ready_encrypted';
    item.encryption = 'aes128';
    item.downloadable = true;
  } else if (info.encryption.method === 'sampleaes') {
    item.status = 'protected';
    item.encryption = 'sampleaes';
    item.downloadable = false;
    item.blockedReason = 'sampleaes';
  } else {
    item.status = 'ready';
    item.encryption = 'none';
    item.downloadable = true;
  }
}

async function parseDash(item: MediaItem, pageUrl?: string): Promise<void> {
  const text = await fetchManifest(item.masterUrl, pageUrl);
  const r = parseMpd(text, item.masterUrl);
  if (!r.ok) throw new Error('bad_mpd');
  const updated = getItem(item.tabId, item.id) ?? item;
  updated.live = r.doc.live;
  updated.durationSec = r.doc.durationSec;
  const videos = r.doc.representations.filter((x) => x.type === 'video');
  const audios = r.doc.representations.filter((x) => x.type === 'audio');

  if (r.doc.encryption === 'drm') {
    // F-110 / E-018：DRM 不可下载，不绕过
    updated.status = 'protected';
    updated.encryption = 'drm';
    updated.downloadable = false;
    updated.blockedReason = 'drm';
    updated.title = deriveTitle(updated, pageUrl);
    await updateItem(updated);
    log.info('analyzer', `DASH 含 DRM 保护 ${sanitizeUrl(item.masterUrl)}`, '标记不可下载');
    return;
  }

  // 变体 = 视频表示；音轨 = 音频表示（F-303）
  updated.variants = sortVariants(
    videos.map((v) => {
      const segs = expandSegments(v, item.masterUrl);
      return {
        id: v.id,
        resolution: v.resolution,
        qualityLabel: qualityOf(v.resolution),
        bandwidth: v.bandwidth,
        codecs: v.codecs,
        playlistUrl: item.masterUrl,
        durationSec: r.doc.durationSec,
        segmentCount: segs.segmentUrls.length,
        avgSegmentDur: segs.avgSegmentDur,
        ...(segs.initUrl ? {} : {}),
      } as Variant & { segUrls?: string[]; initUrl?: string };
    })
  );
  for (const [idx, v] of videos.entries()) {
    const segs = expandSegments(v, item.masterUrl);
    (updated.variants[idx] as Variant & { segUrls?: string[] }).segUrls = segs.segmentUrls;
    if (segs.initUrl) (updated.variants[idx] as Variant & { initUrl?: string }).initUrl = segs.initUrl;
  }
  updated.tracks = audios.map((a) => {
    const segs = expandSegments(a, item.masterUrl);
    return {
      trackId: a.id,
      type: 'audio' as const,
      bandwidth: a.bandwidth,
      lang: a.lang,
      codecs: a.codecs,
      playlistUrl: item.masterUrl,
      initUrl: segs.initUrl,
      segmentUrls: segs.segmentUrls,
      durationSec: r.doc.durationSec,
    } as TrackRef & { segmentUrls: string[] };
  });
  // 视频轨引用也挂到 track（供双轨下载）
  updated.tracks = [
    ...videos.slice(0, 1).map((v) => {
      const segs = expandSegments(v, item.masterUrl);
      return {
        trackId: v.id,
        type: 'video' as const,
        bandwidth: v.bandwidth,
        codecs: v.codecs,
        playlistUrl: item.masterUrl,
        initUrl: segs.initUrl,
        segmentUrls: segs.segmentUrls,
        durationSec: r.doc.durationSec,
      } as TrackRef & { segmentUrls: string[] };
    }),
    ...updated.tracks,
  ];
  updated.status = 'ready';
  updated.encryption = 'none';
  updated.downloadable = true;
  updated.title = deriveTitle(updated, pageUrl);
  await updateItem(updated);
  log.info('analyzer', `DASH 解析完成 ${sanitizeUrl(item.masterUrl)}`, `视频=${videos.length} 音频=${audios.length} 双轨=${videos.length > 0 && audios.length > 0}`);
}

function qualityOf(res?: string): string {
  const h = res?.match(/x(\d+)$/)?.[1];
  if (!h) return '';
  const height = Number(h);
  if (height >= 2160) return '4K';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  return `${height}p`;
}

function sortVariants(vs: Variant[]): Variant[] {
  return vs.sort((a, b) => {
    const pa = Number(a.resolution?.split('x')[1] ?? 0);
    const pb = Number(b.resolution?.split('x')[1] ?? 0);
    if (pa !== pb) return pb - pa;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });
}

/** 可下载性只由加密推导（F-110 数据要求） */
export function applyDownloadable(item: MediaItem): void {
  switch (item.encryption) {
    case 'none':
    case 'aes128':
      item.downloadable = !item.live;
      break;
    case 'sampleaes':
    case 'drm':
      item.downloadable = false;
      item.blockedReason = item.encryption === 'drm' ? 'drm' : 'sampleaes';
      break;
  }
}

/** 标题来源优先级链（F-105 规则 1） */
export function deriveTitle(item: MediaItem, pageUrl?: string): string {
  const s = getSettings();
  void s;
  const pt = item.tabId != null ? pageTitle(item.tabId) : undefined;
  const clean = (t: string) =>
    t
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s*[-_|]\s*(视频|高清|正版|官方|网站|官网|平台|APP|app).*$/u, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);

  if (pt) {
    const t = clean(pt);
    if (t) return t;
  }
  const fromUrl = decodeURIComponent(
    (() => {
      try {
        return new URL(item.masterUrl).pathname.split('/').pop() ?? '';
      } catch {
        return '';
      }
    })()
  ).replace(/\.[a-z0-9]{1,5}$/i, '');
  if (fromUrl) return clean(fromUrl);
  return `${hostOf(pageUrl ?? item.masterUrl)}-${new Date(item.detectedAt).toISOString().slice(0, 10)}`;
}

export function hintToItemTitle(hint: MediaHint): string {
  return hint.pageTitleSource ?? '';
}
