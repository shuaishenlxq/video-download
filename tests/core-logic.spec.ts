import { describe, it, expect } from 'vitest';
import { SegmentPool, downloadQueue } from '../src/background/tasks/queue';
import { estimatePeakMemoryMb, memoryWatermarkMb, canMergeInBrowser } from '../src/background/memory';
import { deriveIconState } from '../src/background/icon-state';
import type { MediaItem } from '../src/shared/types';

describe('SegmentPool（F-305/F-306 分片调度）', () => {
  it('并发额度约束：同时最多 concurrency 个在飞', async () => {
    const pool = new SegmentPool(4, 20, 3, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'ok' as const;
    });
    const result = await pool.run(Array.from({ length: 10 }, (_, i) => i));
    expect(result.completed).toHaveLength(10);
    expect(result.failed).toHaveLength(0);
    expect(result.maxInFlight).toBeLessThanOrEqual(4);
  });
  it('指数退避重试：500ms 起步翻倍封顶 8s（用注入时钟压缩验证逻辑）', async () => {
    let calls = 0;
    const delays: number[] = [];
    const pool = new SegmentPool(1, 20, 3, async () => {
      calls++;
      if (calls < 3) throw new Error('timeout');
      return 'ok' as const;
    }, { backoffBaseMs: 500, backoffCapMs: 8000, sleep: async (ms) => { delays.push(ms); } });
    await pool.run([1]);
    expect(delays).toEqual([500, 1000]);
    expect(calls).toBe(3);
  });
  it('错误分流：401/403 不重试（E-005）', async () => {
    let calls = 0;
    const pool = new SegmentPool(1, 20, 3, async () => {
      calls++;
      const e = new Error('401') as Error & { statusCode?: number };
      e.statusCode = 401;
      throw e;
    });
    const r = await pool.run([1]);
    expect(calls).toBe(1);
    expect(r.failed).toEqual([1]);
    expect(r.abortReason).toBe('credential');
  });
  it('缺失分片 ≤ 阈值继续，> 阈值中止（E-006）', async () => {
    const pool = new SegmentPool(2, 20, 1, async (i: number) => {
      if (i === 2 || i === 5) {
        const e = new Error('404') as Error & { statusCode?: number };
        e.statusCode = 404;
        throw e;
      }
      return 'ok' as const;
    });
    // 缺失 2 片 = maxMissingSegments(2) → 允许继续
    const r = await pool.run([1, 2, 3, 4, 5, 6], { maxMissingSegments: 2 });
    expect(r.missing).toEqual([2, 5]);
    expect(r.abortReason).toBeUndefined();
    // 缺失 3 片 > 2 → 中止
    const pool2 = new SegmentPool(2, 20, 1, async (i: number) => {
      if (i === 2 || i === 5 || i === 7) {
        const e = new Error('404') as Error & { statusCode?: number };
        e.statusCode = 404;
        throw e;
      }
      return 'ok' as const;
    });
    const r2 = await pool2.run([1, 2, 3, 4, 5, 6, 7], { maxMissingSegments: 2 });
    expect(r2.abortReason).toBe('missing');
  });
});

describe('downloadQueue（F-306 任务并发）', () => {
  it('任务并发上限默认 2，FIFO 排队', async () => {
    const q = downloadQueue({ maxConcurrentTasks: 2, maxProcessingTasks: 1 });
    const running: number[] = [];
    let peak = 0;
    const make = (id: number) => async () => {
      running.push(id);
      peak = Math.max(peak, running.length);
      await new Promise((r) => setTimeout(r, 20));
      running.splice(running.indexOf(id), 1);
    };
    await Promise.all([q.acquire(make(1)), q.acquire(make(2)), q.acquire(make(3)), q.acquire(make(4))]);
    expect(peak).toBe(2);
  });
  it('处理槽位互斥：合并阶段全局仅 1 个（E-022）', async () => {
    const q = downloadQueue({ maxConcurrentTasks: 3, maxProcessingTasks: 1 });
    const order: string[] = [];
    const processing = async (id: string) => {
      const release = await q.acquireProcessing();
      order.push(`${id}+`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`${id}-`);
      release();
    };
    await Promise.all([processing('a'), processing('b'), processing('c')]);
    // 同一时刻只有一个在处理区
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]!.endsWith('+')).toBe(true);
      expect(order[i + 1]!.endsWith('-')).toBe(true);
    }
  });
});

describe('内存水位（F-402 规则 3）', () => {
  it('水位 = 设备内存 GB × 1024 × 25%', () => {
    expect(memoryWatermarkMb(16)).toBe(16 * 1024 * 0.25);
    expect(memoryWatermarkMb(8)).toBe(8 * 1024 * 0.25);
  });
  it('峰值估算 = 体积 × 1.6（双缓冲系数）', () => {
    expect(estimatePeakMemoryMb(1000)).toBeCloseTo(1600, 1);
  });
  it('超水位拒绝浏览器内合并并要求引导本地引擎', () => {
    // 16GB 设备：水位 4096MB；1.6GB 媒体 → 峰值 2.56GB → 可合并
    expect(canMergeInBrowser(1.6 * 1024, 16).ok).toBe(true);
    // 8GB 设备：水位 2048MB；2GB 媒体 → 峰值 3.2GB → 拒绝（E-008）
    const r = canMergeInBrowser(2 * 1024, 8);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestLocalEngine).toBe(true);
  });
});

function item(p: Partial<MediaItem>): MediaItem {
  return {
    id: '1', tabId: 1, type: 'video', status: 'ready', protocol: 'progressive',
    title: 't', masterUrl: 'https://c.com/v.mp4', variants: [], tracks: [],
    durationSec: null, sizeEstimate: null, sizeIsEstimate: false,
    encryption: 'none', downloadable: true, live: false, siteDomain: 'c.com', detectedAt: 1,
    ...p,
  };
}

describe('图标状态机（F-106 四态 + 任务中）', () => {
  it('无媒体 → gray 无角标', () => {
    const s = deriveIconState({ items: [], tasks: [] });
    expect(s).toEqual({ icon: 'gray', badge: null });
  });
  it('解析中 → detecting 无角标', () => {
    const s = deriveIconState({ items: [item({ status: 'parsing' })], tasks: [] });
    expect(s.icon).toBe('idle');
    expect(s.badge).toBe(null);
  });
  it('有可下载 → idle + 数字角标，超 9 显示 9+', () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ id: String(i) }));
    const s = deriveIconState({ items, tasks: [] });
    expect(s.icon).toBe('idle');
    expect(s.badge).toBe('9+');
    const s2 = deriveIconState({ items: items.slice(0, 3), tasks: [] });
    expect(s2.badge).toBe('3');
  });
  it('全部 DRM → locked（E-018）', () => {
    const s = deriveIconState({ items: [item({ downloadable: false, blockedReason: 'drm' })], tasks: [] });
    expect(s.icon).toBe('locked');
    expect(s.badge).toBe(null);
  });
  it('有进行中任务 → ring 图标 + 角标叠加', () => {
    const s = deriveIconState({
      items: [item({})],
      tasks: [{ id: '1', stage: 'downloading' } as never],
    });
    expect(s.icon).toBe('ring');
    expect(s.badge).toBe('1');
  });
});
