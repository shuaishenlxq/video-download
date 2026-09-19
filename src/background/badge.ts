// ============ 工具栏角标（F-106：按当前激活标签页状态重绘）============
import type { MediaItem, DownloadTask } from '../shared/types';
import { deriveIconState } from './icon-state';
import { STORAGE_KEYS } from '../shared/messages';

export async function updateBadgeForActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const key = `${STORAGE_KEYS.TAB_STATE_PREFIX}${tab.id}`;
    const o = await chrome.storage.session.get([key, STORAGE_KEYS.TASKS]);
    const state = o[key] as { items: MediaItem[] } | undefined;
    const allTasks = (o[STORAGE_KEYS.TASKS] as DownloadTask[] | undefined) ?? [];
    const tabTasks = allTasks.filter((t) => t.tabId === tab.id);
    const s = deriveIconState({ items: state?.items ?? [], tasks: tabTasks });
    const sizes = [16, 32, 48, 128];
    await chrome.action.setIcon({
      tabId: tab.id,
      path: Object.fromEntries(sizes.map((sz) => [sz, `icons/${s.icon}${sz}.png`])),
    });
    await chrome.action.setBadgeText({ tabId: tab.id, text: s.badge ?? '' });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: s.icon === 'locked' ? '#98A2AE' : '#17A184' });
  } catch {
    // 标签页可能已关闭
  }
}
