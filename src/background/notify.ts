// ============ 系统通知（F-503 开关 + 6.5 多任务合并）============
import type { Settings } from '../shared/types';

let recentCompletions: { title: string; t: number }[] = [];

export async function notifyTaskDone(settings: Settings, title: string): Promise<void> {
  if (!settings.notifyOnComplete) return;
  const now = Date.now();
  recentCompletions = recentCompletions.filter((r) => now - r.t < 2000);
  recentCompletions.push({ title, t: now });

  // 多任务同时完成：合并为一条汇总（6.5）
  if (recentCompletions.length >= 3) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/idle128.png',
      title: '媒探 MediaSniff',
      message: `${recentCompletions.length} 个下载已完成`,
    });
    recentCompletions = [];
    return;
  }
  setTimeout(() => {
    if (recentCompletions.length === 1) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/idle128.png',
        title: '下载完成',
        message: title,
      });
      recentCompletions = recentCompletions.filter((r) => r.title !== title);
    } else if (recentCompletions.length >= 3) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/idle128.png',
        title: '媒探 MediaSniff',
        message: `${recentCompletions.length} 个下载已完成`,
      });
      recentCompletions = [];
    }
  }, 1600);
}
