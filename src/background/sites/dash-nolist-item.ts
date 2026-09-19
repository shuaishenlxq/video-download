// ============ 无清单 DASH 条目构建（聚合结果 → MediaItem）============
import type { MediaItem, TrackRef } from '../../shared/types';
import type { NoListItem } from './dash-nolist';

export interface NoListContext {
  pageTitle: string;
  siteDomain: string;
  pageUrl?: string;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 把聚合出的轨道合成为一条可下载的 DASH 媒体条目 */
export function makeNoListItem(tabId: number, agg: NoListItem, ctx: NoListContext): MediaItem {
  const dedupKey = `nolist:${agg.groupId}`;
  const tracks: TrackRef[] = [];
  if (agg.video) {
    tracks.push({
      trackId: `v${agg.video.codecId}`,
      type: 'video',
      playlistUrl: agg.video.url,
      singleUrl: agg.video.url,
      sizeEstimate: null,
    });
  }
  if (agg.audio) {
    tracks.push({
      trackId: `a${agg.audio.codecId}`,
      type: 'audio',
      playlistUrl: agg.audio.url,
      singleUrl: agg.audio.url,
      sizeEstimate: null,
    });
  }
  const dual = !!(agg.video && agg.audio);
  return {
    id: hash(`${tabId}:${dedupKey}`),
    tabId,
    type: 'video',
    status: 'ready',
    protocol: 'dash',
    title: ctx.pageTitle,
    masterUrl: agg.video?.url ?? agg.audio?.url ?? '',
    variants: [],
    tracks,
    durationSec: null,
    sizeEstimate: null,
    sizeIsEstimate: true,
    encryption: 'none',
    downloadable: !!agg.video,
    live: false,
    siteDomain: ctx.siteDomain,
    pageUrl: ctx.pageUrl,
    detectedAt: Date.now(),
    dedupKey,
  } as MediaItem & { pageUrl?: string; dualTrack?: boolean };
}

export { NoListItem };
