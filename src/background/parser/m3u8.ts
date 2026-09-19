// ============ HLS m3u8 解析器（F-103）============
import type { Variant } from '../../shared/types';
import { resolutionOf } from '../../shared/format';

export interface EncryptionInfo {
  method: 'none' | 'aes128' | 'sampleaes';
  keyUrl?: string;
  ivHex?: string;
}

export interface MediaSegment {
  index: number; // 全局序号 = mediaSequence + 行序
  url: string;
  durationSec: number;
  byterange?: { length: number; offset: number };
}

export type ParseM3u8Result =
  | { type: 'master'; variants: Variant[] }
  | {
      type: 'media';
      segments: MediaSegment[];
      durationSec: number;
      live: boolean;
      encryption: EncryptionInfo;
      mediaSequence: number;
      avgSegmentDur: number;
      targetDuration: number;
    }
  | { type: 'error'; reason: string };

function resolveUrl(base: string, rel: string): string {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

function attrs(line: string): Record<string, string> {
  // 解析 KEY=VALUE,"带引号值" 属性串
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out[m[1]!] = (m[2] ?? '').replace(/^"|"$/g, '');
  }
  return out;
}

export function parseM3u8(text: string, baseUrl: string): ParseM3u8Result {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (!lines[0]?.startsWith('#EXTM3U')) return { type: 'error', reason: 'missing #EXTM3U' };

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): ParseM3u8Result {
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attrs(line.slice('#EXT-X-STREAM-INF:'.length));
    // 下一非注释行为 playlist URL
    let url = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j]!.startsWith('#')) {
        url = lines[j]!;
        break;
      }
    }
    if (!url) continue;
    const res = a['RESOLUTION'] ?? undefined;
    const q = resolutionOf(res);
    variants.push({
      id: `${res ?? a['BANDWIDTH'] ?? url}-${variants.length}`,
      resolution: res,
      qualityLabel: q.label,
      bandwidth: a['BANDWIDTH'] ? Number(a['BANDWIDTH']) : undefined,
      codecs: a['CODECS'] || undefined,
      playlistUrl: resolveUrl(baseUrl, url),
    });
  }
  if (!variants.length) return { type: 'error', reason: 'no variants in master playlist' };
  // F-103 规则 4：分辨率（像素总数）降序，缺失按带宽降序兜底
  variants.sort((x, y) => {
    const px = (resolutionOf(x.resolution).pixels || 0) - (resolutionOf(y.resolution).pixels || 0);
    if (px !== 0) return -px;
    return (y.bandwidth ?? 0) - (x.bandwidth ?? 0);
  });
  return { type: 'master', variants };
}

function parseMedia(lines: string[], baseUrl: string): ParseM3u8Result {
  const segments: MediaSegment[] = [];
  let durationSec = 0;
  let mediaSequence = 0;
  let targetDuration = 0;
  let live = true;
  let enc: EncryptionInfo = { method: 'none' };
  let pendingDur: number | null = null;
  let pendingByterange: MediaSegment['byterange'] | undefined;
  let nextIfSequenceOnly = false;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]);
      nextIfSequenceOnly = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      live = false;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrs(line.slice('#EXT-X-KEY:'.length));
      const method = (a['METHOD'] ?? 'none').toUpperCase();
      if (method === 'AES-128') {
        enc = { method: 'aes128', keyUrl: a['URI'] ? resolveUrl(baseUrl, a['URI']) : undefined, ivHex: a['IV']?.replace(/^0[xX]/, '') };
      } else if (method === 'SAMPLE-AES') {
        enc = { method: 'sampleaes' }; // F-110：不支持，标记不可下载
      } else {
        enc = { method: 'none' };
      }
    } else if (line.startsWith('#EXTINF:')) {
      pendingDur = Number((line.split(':', 2)[1] ?? '0').split(',')[0]);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const m = line.split(':')[1]!.match(/^(\d+)(?:@(\d+))?$/);
      if (m) pendingByterange = { length: Number(m[1]), offset: Number(m[2] ?? 0) };
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(baseUrl, line);
      const dur = pendingDur ?? 0;
      segments.push({
        index: mediaSequence + segments.length,
        url,
        durationSec: dur,
        byterange: pendingByterange,
      });
      durationSec += dur;
      pendingDur = null;
      // BYTERANGE 未显式给 offset 时接续上一分片（规范行为，MVP 记录 length）
      pendingByterange = undefined;
    }
  }
  void nextIfSequenceOnly;
  if (!segments.length) return { type: 'error', reason: 'no segments in media playlist' };
  return {
    type: 'media',
    segments,
    durationSec,
    live,
    encryption: enc,
    mediaSequence,
    avgSegmentDur: durationSec / segments.length,
    targetDuration,
  };
}
