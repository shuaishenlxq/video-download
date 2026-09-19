// ============ 浏览器环境 shim：无扩展上下文时兜底，便于 UI 开发与预览 ============
// 仅影响普通浏览器打开 popup 的场景；真实扩展环境中 chrome API 原生存在，此模块不生效。
type StorageChange = Record<string, unknown>;

interface ShimStorage {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(obj: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export function installChromeShim(): void {
  const w = window as unknown as { chrome?: { runtime?: { id?: string } } };
  if (w.chrome?.runtime?.id !== undefined) return;

  // 演示模式：?demo=1 时返回样例数据（供 UI 开发预览）
  const demo = location.search.includes('demo');
  const demoItems = demo
    ? [
        {
          id: 'a1', tabId: 1, type: 'video', status: 'ready', protocol: 'dash',
          title: '第一讲-环境搭建.mp4', masterUrl: 'https://example.com/master.mpd',
          variants: [], tracks: [
            { trackId: 'v', type: 'video' as const, playlistUrl: '', segmentUrls: ['s1', 's2'] },
            { trackId: 'a', type: 'audio' as const, playlistUrl: '', segmentUrls: ['s1', 's2'] },
          ],
          durationSec: 5025, sizeEstimate: 428 * 1024 * 1024, sizeIsEstimate: true,
          resolution: '1920x1080', encryption: 'aes128', downloadable: true, live: false,
          siteDomain: 'example.com', detectedAt: Date.now(),
        },
        {
          id: 'a2', tabId: 1, type: 'video', status: 'ready', protocol: 'hls',
          title: '第二讲-配置文件详解.mp4', masterUrl: 'https://example.com/720p/index.m3u8',
          variants: [
            { id: 'v1', resolution: '1920x1080', qualityLabel: '1080p', bandwidth: 4500000, playlistUrl: '', durationSec: 3130, recommended: true },
            { id: 'v2', resolution: '1280x720', qualityLabel: '720p', bandwidth: 2500000, playlistUrl: '', durationSec: 3130 },
            { id: 'v3', resolution: '854x480', qualityLabel: '480p', bandwidth: 1000000, playlistUrl: '', durationSec: 3130 },
          ],
          tracks: [], durationSec: 3130, sizeEstimate: 186 * 1024 * 1024, sizeIsEstimate: true,
          resolution: '1280x720', encryption: 'none', downloadable: true, live: false,
          siteDomain: 'example.com', detectedAt: Date.now() - 1000,
        },
        {
          id: 'a3', tabId: 1, type: 'audio', status: 'ready', protocol: 'progressive',
          title: '背景音乐-开场曲.m4a', masterUrl: 'https://example.com/bgm.m4a',
          variants: [], tracks: [], durationSec: 192, sizeEstimate: 7.4 * 1024 * 1024, sizeIsEstimate: false,
          encryption: 'none', downloadable: true, live: false,
          siteDomain: 'example.com', detectedAt: Date.now() - 2000,
        },
        {
          id: 'a4', tabId: 1, type: 'video', status: 'protected', protocol: 'dash',
          title: '加密课程-第5讲.mp4', masterUrl: 'https://example.com/drm.mpd',
          variants: [], tracks: [], durationSec: 2700, sizeEstimate: 310 * 1024 * 1024, sizeIsEstimate: true,
          resolution: '1920x1080', encryption: 'drm', downloadable: false, live: false, blockedReason: 'drm',
          siteDomain: 'example.com', detectedAt: Date.now() - 3000,
        },
      ]
    : [];
  const demoTasks = demo
    ? [
        { id: 't1', mediaId: 'a1', tabId: 1, title: '第一讲-环境搭建.mp4', siteDomain: 'example.com', protocol: 'hls', stage: 'downloading', engine: 'browser', completedSegments: 48, totalSegments: 124, bytes: 248 * 1024 * 1024, totalBytes: 428 * 1024 * 1024, speedBps: 4.4 * 1024 * 1024, etaSec: 43, retryCount: 0, completedSegmentIndexes: [], createdAt: Date.now(), updatedAt: Date.now() },
        { id: 't2', mediaId: 'a2', tabId: 1, title: '第二讲-配置文件详解.mp4', siteDomain: 'example.com', protocol: 'hls', stage: 'merging', engine: 'browser', completedSegments: 186, totalSegments: 186, bytes: 186 * 1024 * 1024, totalBytes: null, speedBps: 0, etaSec: null, retryCount: 0, completedSegmentIndexes: [], createdAt: Date.now(), updatedAt: Date.now() },
        { id: 't3', mediaId: 'a3', tabId: 1, title: '第三讲-依赖管理.mp4', siteDomain: 'example.com', protocol: 'progressive', stage: 'done', engine: 'browser', completedSegments: 1, totalSegments: 1, bytes: 186 * 1024 * 1024, totalBytes: 186 * 1024 * 1024, speedBps: 0, etaSec: null, retryCount: 0, completedSegmentIndexes: [], outputFilename: '第三讲-依赖管理-1280x720.mp4', createdAt: Date.now(), updatedAt: Date.now() },
        { id: 't4', mediaId: 'a4', tabId: 1, title: '加密课程-第5讲.mp4', siteDomain: 'example.com', protocol: 'hls', stage: 'failed', engine: 'browser', completedSegments: 312, totalSegments: 420, bytes: 0, totalBytes: null, speedBps: 0, etaSec: null, retryCount: 1, completedSegmentIndexes: Array.from({ length: 312 }, (_, i) => i), errorMessage: '访问凭证已失效（401）', errorCode: '401', createdAt: Date.now(), updatedAt: Date.now() },
      ]
    : [];

  const storageChangeListeners = new Set<(c: StorageChange, area: string) => void>();
  const memStore: Record<'local' | 'session', Record<string, unknown>> = { local: {}, session: {} };

  const makeStorage = (area: 'local' | 'session'): ShimStorage => ({
    get: async (keys?: string | string[] | null) => {
      const store = memStore[area] ?? {};
      if (keys == null) return { ...store };
      const out: Record<string, unknown> = {};
      const list = typeof keys === 'string' ? [keys] : keys;
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      memStore[area] = { ...(memStore[area] ?? {}), ...obj };
      for (const l of storageChangeListeners) l(obj, area);
    },
    remove: async (keys: string | string[]) => {
      const store = { ...(memStore[area] ?? {}) };
      for (const k of typeof keys === 'string' ? [keys] : keys) delete store[k];
      memStore[area] = store;
      for (const l of storageChangeListeners) l({}, area);
    },
  });

  const messageListeners = new Set<(msg: unknown, sender: unknown, respond: (r?: unknown) => void) => void>();
  void messageListeners;

  const shim = {
    runtime: {
      id: 'shim-dev',
      sendMessage: async (msg: { type?: string }) => {
        if (msg?.type === 'getSettings') return { settings: {} };
        if (msg?.type === 'queryTabState')
          return demo
            ? { items: demoItems, filteredCount: 0, protectedCount: 1, parsingCount: 0, tabUrl: 'https://example.com/course', pageTitle: '示例课程' }
            : { items: [], filteredCount: 0, protectedCount: 0, parsingCount: 0 };
        if (msg?.type === 'listTasks') return { tasks: demoTasks };
        if (msg?.type === 'queryLogs')
          return demo
            ? {
                entries: [
                  { t: Date.now() - 61000, level: 'WARN', module: 'downloader', msg: '分片 #142 超时，第 2 次重试', detail: '任务：第一讲-环境搭建.mp4' },
                  { t: Date.now() - 48000, level: 'WARN', module: 'downloader', msg: '触发站点限流，并发 4 → 3' },
                  { t: Date.now() - 22000, level: 'ERROR', module: 'processor', msg: '合并校验失败：时长偏差 18%', detail: '数据已保留，可重新合并' },
                  { t: Date.now() - 10000, level: 'INFO', module: 'sniffer', msg: '检测到清单 example.com/video/***' },
                ],
              }
            : { entries: [] };
        return { ok: false, error: 'shim' };
      },
      onMessage: {
        addListener: (l: never) => messageListeners.add(l),
        removeListener: (l: never) => messageListeners.delete(l),
      },
      getURL: (p: string) => p,
    },
    storage: {
      local: makeStorage('local'),
      session: makeStorage('session'),
      onChanged: {
        addListener: (l: (c: StorageChange, area: string) => void) => storageChangeListeners.add(l),
        removeListener: (l: (c: StorageChange, area: string) => void) => storageChangeListeners.delete(l),
      },
    },
  };
  (window as unknown as Record<string, unknown>).chrome = shim;
}
