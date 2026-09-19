import { describe, it, expect } from 'vitest';
import { mergeHint, createContext, normalizeUrl } from '../src/background/media-store';
import type { MediaHint, MediaItem } from '../src/shared/types';

const now = Date.now();
function hint(partial: Partial<MediaHint>): MediaHint {
  return {
    url: 'https://cdn.example.com/video.mp4',
    tabId: 1,
    frameId: 0,
    source: 'network',
    isBlob: false,
    detectedAt: now,
    ...partial,
  };
}

describe('normalizeUrl（F-104 规则 5）', () => {
  it('剥离易变参数 _t/_ts/token/expire，保留业务参数', () => {
    expect(normalizeUrl('https://c.com/v.mp4?token=abc&_t=123&id=1')).toBe('https://c.com/v.mp4?id=1');
    expect(normalizeUrl('https://c.com/v.mp4')).toBe('https://c.com/v.mp4');
  });
});

describe('mergeHint：渐进式直链', () => {
  it('新 URL 创建条目', () => {
    const ctx = createContext();
    const r = mergeHint(hint({}), ctx, now);
    expect(r.created).toBe(true);
    expect(ctx.store.size).toBe(1);
    const item = [...ctx.store.values()][0] as MediaItem;
    expect(item.protocol).toBe('progressive');
    expect(item.type).toBe('video');
    expect(item.downloadable).toBe(true);
  });
  it('同 URL 重复线索只更新不重建', () => {
    const ctx = createContext();
    mergeHint(hint({}), ctx, now);
    const r = mergeHint(hint({ detectedAt: now + 1000 }), ctx, now + 1000);
    expect(r.created).toBe(false);
    expect(ctx.store.size).toBe(1);
  });
  it('blob: 地址标记不可直链（E-019）', () => {
    const ctx = createContext();
    const r = mergeHint(hint({ url: 'blob:https://x.com/abc', isBlob: true }), ctx, now);
    const item = r.item!;
    expect(item.downloadable).toBe(false);
    expect(item.blockedReason).toBe('blob');
  });
});

describe('mergeHint：清单归并（F-104 规则 1/2/6）', () => {
  it('分片线索并入清单条目，不单独成条', () => {
    const ctx = createContext();
    const master = mergeHint(
      hint({ url: 'https://c.com/master.m3u8', source: 'page', hookType: 'fetch' }),
      ctx,
      now
    );
    expect(master.created).toBe(true);
    const seg1 = mergeHint(hint({ url: 'https://c.com/seg-1.ts' }), ctx, now + 1);
    const seg2 = mergeHint(hint({ url: 'https://c.com/seg-2.ts' }), ctx, now + 2);
    expect(seg1.created).toBe(false);
    expect(seg2.created).toBe(false);
    expect(ctx.store.size).toBe(1);
  });
  it('分片 URL 归属清单并计数', () => {
    const ctx = createContext();
    mergeHint(hint({ url: 'https://c.com/vod/master.m3u8' }), ctx, now);
    const r = mergeHint(hint({ url: 'https://c.com/vod/seg-001.ts' }), ctx, now + 1);
    expect(r.created).toBe(false);
    const item = [...ctx.store.values()][0] as MediaItem;
    expect(item.segmentHintCount).toBe(1);
  });
  it('未关联清单的分片先暂存，清单出现后并入（规则 2 清单优先）', () => {
    const ctx = createContext();
    const seg = mergeHint(hint({ url: 'https://c.com/vod/seg-001.ts' }), ctx, now);
    expect(seg.created).toBe(false);
    expect(seg.pendingOnly).toBe(true);
    expect(ctx.store.size).toBe(0);
    const master = mergeHint(hint({ url: 'https://c.com/vod/master.m3u8' }), ctx, now + 1);
    expect(master.created).toBe(true);
    expect(ctx.store.size).toBe(1);
    const item = [...ctx.store.values()][0] as MediaItem;
    expect(item.segmentHintCount).toBe(1);
  });
});

describe('DASH 双轨归并（F-104 规则 3）', () => {
  it('同 Period 轨道分片经由 parentManifest 汇入同一条目', () => {
    const ctx = createContext();
    const v = mergeHint(
      hint({ url: 'https://c.com/dash/v1/seg-1.m4s', parentManifest: 'https://c.com/dash/m.mpd' }),
      ctx,
      now
    );
    expect(v.created).toBe(true);
    const a = mergeHint(
      hint({ url: 'https://c.com/dash/a1/seg-1.m4s', parentManifest: 'https://c.com/dash/m.mpd' }),
      ctx,
      now + 1
    );
    // 音轨分片并入既有清单条目，不新建
    expect(a.created).toBe(false);
    expect(ctx.store.size).toBe(1);
    const item = [...ctx.store.values()][0] as MediaItem;
    expect(item.segmentHintCount).toBe(2);
  });
});

describe('条目顺序稳定性（F-104 规则 7）', () => {
  it('条目保持首检时间，新增不重建', () => {
    const ctx = createContext();
    const r1 = mergeHint(hint({ url: 'https://c.com/a.m3u8' }), ctx, now);
    mergeHint(hint({ url: 'https://c.com/b.mp4' }), ctx, now + 10);
    expect(r1.item!.detectedAt).toBe(now);
    expect(ctx.store.size).toBe(2);
  });
});
