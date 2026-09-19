// ============ 网络层嗅探（F-101：观察型监听，顶层注册）============
import type { MediaHint } from '../shared/types';
import { addHint, bumpFiltered, pageTitle, upsertItem } from './tab-store';
import { getSettings, admitDomain } from './settings';
import { classifyHint } from './media-store';
import { Logger, sanitizeUrl, log } from './logger';
import { enqueueParse } from './analyzer';
import { NoListAggregator } from './sites/dash-nolist';
import { makeNoListItem } from './sites/dash-nolist-item';

/** 嗅探准入：黑名单直接丢弃（F-101 规则 7）；类型/体积过滤计入 filteredCount（空态成因判定用） */
export async function admitAndDispatch(hint: MediaHint): Promise<void> {
  const s = getSettings();
  let host = '';
  try {
    host = new URL(hint.url).hostname;
  } catch {
    return;
  }
  if (admitDomain(s, host) === 'deny') return; // 命中黑名单：根本不会被检测

  // F-502 过滤维度（决定是否纳入嗅探，区别于列表筛选）
  const kind = classifyHint(hint);
  if (kind === 'progressive' || kind === 'blob') {
    const isAudio = /\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i.test(hint.url) || hint.mime?.startsWith('audio/');
    if (s.sniffType === 'video' && isAudio) return bumpFiltered(hint.tabId);
    if (s.sniffType === 'audio' && !isAudio) return bumpFiltered(hint.tabId);
    if (s.sniffMinSizeMb != null && hint.size != null && hint.size < s.sniffMinSizeMb * 1024 * 1024) return bumpFiltered(hint.tabId);
    if (s.sniffMaxSizeMb != null && hint.size != null && hint.size > s.sniffMaxSizeMb * 1024 * 1024) return bumpFiltered(hint.tabId);
    const ext = (hint.url.split('?')[0]!.split('.').pop() ?? '').toLowerCase();
    if (!hint.mime && ext && !s.sniffExtensions.includes(ext) && kind === 'progressive') return bumpFiltered(hint.tabId);
  }

  log.info('sniffer', `检测到媒体线索 ${sanitizeUrl(hint.url)}`, `来源=${hint.source} tab=${hint.tabId}`);
  const r = await addHint(hint, pageTitle(hint.tabId));
  // 网络层发现的清单同样要进入解析队列（F-103 前置：F-101 或 F-102 已发现清单地址）
  if (r?.item && (r.item.protocol === 'hls' || r.item.protocol === 'dash')) {
    enqueueParse(r.item);
  }
}

// 60 秒去重窗口（F-101 规则 5）
const recent = new Map<string, number>();
function dedupKey(url: string, tabId: number): string {
  return `${tabId}:${url.split('?')[0]}`;
}
function seenRecently(url: string, tabId: number, now: number): boolean {
  const k = dedupKey(url, tabId);
  const t = recent.get(k);
  if (t && now - t < 60_000) return true;
  recent.set(k, now);
  if (recent.size > 500) {
    for (const [kk, tt] of recent) if (now - tt > 60_000) recent.delete(kk);
  }
  return false;
}

/** 请求是否可能为媒体：URL 扩展名 → MIME → Content-Range（优先级链，F-101 规则 2） */
export function looksLikeMedia(url: string, mime: string | undefined, hasContentRange: boolean): boolean {
  if (/\.m3u8(\?|$)|\.mpd(\?|$)/i.test(url)) return true;
  if (/\.(mp4|webm|mov|mkv|flv|ts|m4s|mp3|m4a|aac|ogg)(\?|$)/i.test(url)) return true;
  if (mime) {
    const m = mime.toLowerCase();
    if (m.startsWith('video/') || m.startsWith('audio/') || m.includes('mpegurl') || m.includes('dash+xml')) return true;
  }
  if (hasContentRange) return true;
  return false;
}

// ---------- 无清单 DASH 聚合（B 站等：分片 URL 反推轨道 → 合成可下载条目）----------
const noListAgg = new NoListAggregator((tabId, item) => {
  void (async () => {
    try {
      // 页面域优先实时查询（事件记录可能缺失），Referer 与黑名单判断都依赖它
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      let host = '';
      try {
        host = tab?.url ? new URL(tab.url).hostname : '';
      } catch { /* ignore */ }
      if (!host) host = hostOfPage(tabId) ?? '';
      const media = makeNoListItem(tabId, item, {
        pageTitle: tab?.title || pageTitle(tabId) || '未命名视频',
        siteDomain: host,
        pageUrl: host ? `https://${host}/` : undefined,
      });
      await upsertItem(media);
      log.info('sniffer', `无清单 DASH 轨道就绪：${media.title}`, `视频轨=${item.video?.codecId ?? '-'} 音频轨=${item.audio?.codecId ?? '-'}`);
    } catch (e) {
      log.warn('sniffer', '无清单 DASH 条目构建失败', String(e));
    }
  })();
});

/** 记录最近一次页面导航所属域（用于条目 siteDomain / Referer） */
const tabHost = new Map<number, string>();
export function noteTabHost(tabId: number, host: string): void {
  tabHost.set(tabId, host);
  if (tabHost.size > 500) tabHost.clear();
}
function hostOfPage(tabId: number): string | undefined {
  return tabHost.get(tabId);
}
export function clearNoListTab(tabId: number): void {
  noListAgg.clearTab(tabId);
  tabHost.delete(tabId);
}

/** webRequest 观察型监听注册（必须在 SW 顶层同步调用） */
export function registerNetworkSniffer(): void {
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      void handleCompleted(details);
    },
    filter,
    ['responseHeaders']
  );
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      void handleCompleted(details);
    },
    filter,
    ['responseHeaders']
  );
}

interface WebRequestDetails {
  tabId: number;
  frameId: number;
  url: string;
  statusCode: number;
  responseHeaders?: { name: string; value?: string }[];
  method: string;
}

function header(d: WebRequestDetails, name: string): string | undefined {
  return d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
}

async function handleCompleted(d: WebRequestDetails): Promise<void> {
  try {
    // 规则 3：非 2xx/3xx 不产生线索
    if (d.tabId < 0) return;
    if (d.statusCode < 200 || d.statusCode >= 400) return;
    if (d.method === 'OPTIONS') return;
    const mime = header(d, 'content-type')?.split(';')[0];
    const hasRange = !!header(d, 'content-range') || d.statusCode === 206;
    const lenRaw = header(d, 'content-length');
    const size = lenRaw ? Number(lenRaw) : null;

    // 无清单 DASH（B 站等）：分片 URL 直接喂聚合器，由聚合结果生成可下载条目
    if (noListAgg.add(d.tabId, d.url)) return;

    if (!looksLikeMedia(d.url, mime, hasRange)) return;
    const now = Date.now();
    if (seenRecently(d.url, d.tabId, now)) return;

    await admitAndDispatch({
      url: d.url,
      mime,
      size: Number.isFinite(size as number) ? size : null,
      tabId: d.tabId,
      frameId: d.frameId,
      source: 'network',
      isBlob: false,
      detectedAt: now,
    });
  } catch (e) {
    log.warn('sniffer', '网络线索处理异常', String(e));
  }
}
