// ============ 下载落盘命名裁定（F-307 兜底）============
// 问题：Chrome 在下载落盘时会**按内容重新判定 MIME**，并据此规范化扩展名。
//   M4A 本质是 MP4 容器 → Chrome 判成 video/mp4 → 把我们传入的 `.m4a` 强改回 `.mp4`
//   （实测下载记录：original_mime_type=audio/mp4，mime_type=video/mp4）
//   这发生在 `downloads.download({filename})` 之后，因此传参阶段做任何事都无效。
//
// 解法：用 `chrome.downloads.onDeterminingFilename` —— 该事件在 Chrome 决定文件名之后、
//   真正落盘之前触发，扩展可通过 suggest() 给出**最终权威文件名**（不被 MIME 规范化覆盖）。
//   我们对「刚发起下载的 URL」登记期望文件名，事件命中即裁定，未登记则放行默认行为。

import { log } from './logger';

const TTL_MS = 60_000;
const MAX_ENTRIES = 32;

interface Desired {
  filename: string;
  at: number;
}

const desired = new Map<string, Desired>();

/** 下载发起前登记期望文件名（相对下载目录的路径，如 MediaSniff/歌名.m4a） */
export function rememberDesiredFilename(url: string, filename: string): void {
  const now = Date.now();
  desired.set(url, { filename, at: now });
  if (desired.size > MAX_ENTRIES) {
    for (const [k, v] of desired) {
      if (now - v.at > TTL_MS || desired.size > MAX_ENTRIES) desired.delete(k);
    }
  }
}

function take(url: string): string | undefined {
  const d = desired.get(url);
  if (!d) return undefined;
  if (Date.now() - d.at > TTL_MS) {
    desired.delete(url);
    return undefined;
  }
  desired.delete(url); // 一次性使用
  return d.filename;
}

/** 注册命名裁定（MV3：必须在 SW 顶层同步调用） */
export function installDownloadNamer(): void {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const want = take(item.url);
    if (!want) {
      suggest(); // 未登记：沿用 Chrome 默认（含其 MIME 规范化结果）
      return;
    }
    // 已登记：以我们的名字为准，并避免覆盖同名文件
    // 记录「Chrome 原本要用什么名字」用于诊断（Chrome 会按内容把 m4a 判成 video/mp4 → 改回 .mp4）
    try {
      const proposed = item.filename ?? '';
      const chosenBase = want.split('/').pop() ?? want;
      if (!proposed.endsWith(chosenBase)) {
        log.info('downloader', '落盘命名裁定：已覆盖 Chrome 的 MIME 规范化', `Chrome 拟用 ${proposed.split('/').pop() ?? proposed} → 裁定为 ${chosenBase}（MIME ${item.mime}）`);
      }
    } catch { /* 诊断失败不影响裁定 */ }
    suggest({ filename: want, conflictAction: 'uniquify' });
  });
}
