// ============ Offscreen Document 管家（MV3：SW 无 DOM/createObjectURL）============
const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  const has = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (has.length > 0) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: '媒体合并封装与文件落盘需要 createObjectURL 与 Blob 组装能力',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function sendToOffscreen<T = unknown>(type: string, payload: unknown): Promise<T> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type, payload }) as Promise<T>;
}
