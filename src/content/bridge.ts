// ============ 隔离世界桥（F-102：线索中继 + DOM 扫描）============
// manifest 静态注入，all_frames。接收主世界探针的 postMessage 并中继给后台；
// 同时做 DOM 扫描（video/audio/source 的 src/currentSrc/poster）+ MutationObserver 增量。
(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__mediasniff_bridge__) return;
  w.__mediasniff_bridge__ = true;

  const MARK = '__mediasniff_hint__';
  const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|mov|mkv|flv|ts|m4s|mp3|m4a|aac|ogg)(\?|$)/i;

  const seen = new Set<string>();
  const once = (k: string): boolean => {
    if (seen.has(k)) return false;
    seen.add(k);
    if (seen.size > 1000) seen.clear();
    return true;
  };

  const relay = (hint: Record<string, unknown>): void => {
    try {
      chrome.runtime.sendMessage({ type: 'hint', payload: hint }).catch(() => {});
    } catch { /* 扩展上下文失效（刷新中）静默 */ }
  };

  // ---------- 主世界探针线索中继 ----------
  window.addEventListener(
    'message',
    (ev) => {
      if (ev.source !== window) return;
      const d = ev.data as { [k: string]: unknown } | null;
      if (!d || d[MARK] !== true) return;
      const h = d.hint as Record<string, unknown> | undefined;
      if (!h?.url) return;
      // MSE append 事实性消息（blob:mse-append:*）对列表无价值，仅统计，不中继
      if (typeof h.url === 'string' && h.url.startsWith('blob:mse-append:')) return;
      relay({ ...h, frameId: 0, detectedAt: Date.now() });
    },
    false
  );

  // ---------- DOM 扫描（F-102 规则 3/4）----------
  const scanElement = (el: HTMLMediaElement | HTMLSourceElement): void => {
    const src = (el as HTMLMediaElement).currentSrc || el.getAttribute('src') || '';
    if (!src) return;
    const isBlob = src.startsWith('blob:');
    if (!isBlob && !MEDIA_RE.test(src)) return;
    if (!once(`${src}:${el.tagName}`)) return;
    const poster = (el as HTMLMediaElement).getAttribute?.('poster') ?? undefined;
    const title = el.getAttribute('title') ?? el.getAttribute('aria-label') ?? undefined;
    const dur = el instanceof HTMLMediaElement && Number.isFinite(el.duration) ? el.duration : undefined;
    relay({
      url: src,
      source: 'page',
      hookType: 'dom',
      isBlob,
      posterUrl: poster,
      pageTitleSource: title ?? undefined,
      durationSec: dur,
      detectedAt: Date.now(),
    });
  };

  // 主动重扫：清空去重缓存后重新采集（供「未检测到媒体」时的重试）
  try {
    chrome.runtime.onMessage.addListener((msg: { type?: string } | undefined, _s, sendResponse) => {
      if (msg?.type !== 'mediasniff_rescan') return false;
      try {
        seen.clear();
        scanDocument();
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
      return true;
    });
  } catch { /* 扩展上下文失效时静默 */ }

  const scanDocument = (): void => {
    document.querySelectorAll<HTMLMediaElement>('video, audio').forEach(scanElement);
    document.querySelectorAll<HTMLSourceElement>('video source, audio source').forEach(scanElement);
  };

  if (document.documentElement) {
    scanDocument();
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLMediaElement || node instanceof HTMLSourceElement) scanElement(node);
          else if (node instanceof HTMLElement) {
            node.querySelectorAll?.('video, audio, video source, audio source').forEach((el) => {
              if (el instanceof HTMLMediaElement || el instanceof HTMLSourceElement) scanElement(el);
            });
          }
        }
        // src 属性变更
        for (const m2 of muts) {
          if (m2.type === 'attributes' && (m2.target instanceof HTMLMediaElement || m2.target instanceof HTMLSourceElement)) {
            scanElement(m2.target);
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }
})();
