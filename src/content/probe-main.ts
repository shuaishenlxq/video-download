// ============ 页面主世界探针（F-102）============
// 运行于 MAIN world：观察页面自身的 fetch/XHR 请求，投递媒体地址给隔离世界。
//
// 【铁律】绝不触碰播放器内核：
//   ✗ 不包装 HTMLMediaElement.prototype.src（播放器检测到即拒绝播放——B 站黑屏事故）
//   ✗ 不包装 MediaSource.addSourceBuffer / SourceBuffer.appendBuffer / URL.createObjectURL
//     （MSE 路径被包装会让站点判定环境被篡改；且 MSE 的 blob 流本就无法下载，收益为零）
//   ✓ 只做「读」：包装 fetch / XHR.open 观察 URL，透传全部参数、返回值、异常与 this
//   ✓ blob: 地址改由隔离世界 DOM 扫描采集（video/audio 的 src 属性，零侵入）
(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__mediasniff_probe__) return;
  w.__mediasniff_probe__ = true;

  const MARK = '__mediasniff_hint__';
  const send = (h: Record<string, unknown>) => {
    try {
      window.postMessage({ [MARK]: true, hint: h }, '*');
    } catch { /* 静默 */ }
  };

  const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|mov|mkv|flv|ts|m4s|mp3|m4a|aac|ogg)(\?|$)/i;

  const seen = new Set<string>();
  const once = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 2000) seen.clear(); // 防内存膨胀
    return true;
  };

  /** 保持包装函数的原生特征（name/length/toString），降低被检测概率 */
  const disguise = <T extends (...args: never[]) => unknown>(wrapped: T, orig: T, name: string): T => {
    try {
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
      Object.defineProperty(wrapped, 'length', { value: orig.length, configurable: true });
      Object.defineProperty(wrapped, 'toString', { value: () => Function.prototype.toString.call(orig), configurable: true });
    } catch { /* 静默 */ }
    return wrapped;
  };

  // ---------- fetch 观察（纯透传）----------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = disguise(
      function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        try {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url && MEDIA_RE.test(url) && once(`f:${url}`)) {
            send({ url: String(url), source: 'page', hookType: 'fetch', isBlob: false });
          }
        } catch { /* 静默：观察逻辑绝不影响请求 */ }
        return origFetch.call(this, input, init);
      } as typeof fetch,
      origFetch,
      'fetch'
    );
    window.fetch = wrapped;
  }

  // ---------- XHR 观察（纯透传）----------
  const origOpen = XMLHttpRequest.prototype.open;
  if (typeof origOpen === 'function') {
    const wrappedOpen = disguise(
      function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        try {
          const u = String(url);
          if (MEDIA_RE.test(u) && once(`x:${u}`)) {
            send({ url: u, source: 'page', hookType: 'xhr', isBlob: false });
          }
        } catch { /* 静默 */ }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origOpen as any)(this, method, url, ...rest);
      } as typeof XMLHttpRequest.prototype.open,
      origOpen as unknown as typeof XMLHttpRequest.prototype.open,
      'open'
    );
    XMLHttpRequest.prototype.open = wrappedOpen;
  }
})();
