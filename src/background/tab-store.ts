// ============ 标签页媒体集合存储（F-107）============
// 持久化到 storage.local（而非 session）：session 在**扩展刷新/更新时会被清空**，
// 导致用户刷新扩展后已嗅探到的媒体全部消失（真实事故）。导航清空由 clearTab 显式负责，
// 语义与 session 等价；启动时按 TTL 清理陈旧条目。
import type { MediaHint, MediaItem, TabState } from '../shared/types';
import { STORAGE_KEYS } from '../shared/messages';
import { createContext, mergeHint, type MediaContext, type MergeResult } from './media-store';

interface TabEntry extends MediaContext {
  filteredCount: number;
  protectedCount: number;
  pageTitle?: string;
}

const tabs = new Map<number, TabEntry>();

function key(tabId: number): string {
  return `${STORAGE_KEYS.TAB_STATE_PREFIX}${tabId}`;
}

const TTL_MS = 12 * 60 * 60 * 1000; // 12 小时：超期条目在 SW 启动时清理

async function persist(tabId: number): Promise<void> {
  const e = tabs.get(tabId);
  if (!e) return;
  const state: TabState & { savedAt: number } = {
    tabId,
    items: [...e.store.values()],
    filteredCount: e.filteredCount,
    protectedCount: e.protectedCount,
    parsingCount: [...e.store.values()].filter((i) => i.status === 'parsing').length,
    savedAt: Date.now(),
  };
  try {
    await chrome.storage.local.set({ [key(tabId)]: state });
  } catch { /* 配额满时忽略（E-010 上限保护） */ }
}

export async function addHint(hint: MediaHint, pageTitle?: string): Promise<MergeResult | null> {
  let entry = tabs.get(hint.tabId);
  if (!entry) {
    entry = { ...createContext(), filteredCount: 0, protectedCount: 0, pageTitle };
    tabs.set(hint.tabId, entry);
  }
  if (pageTitle) entry.pageTitle = pageTitle;
  const r = mergeHint(hint, entry, hint.detectedAt);
  await persist(hint.tabId);
  return r.created || r.item ? r : null;
}

/** 直接写入/更新一个条目（无清单 DASH 适配用：条目由网络层聚合而来，不走 hint 归并） */
export async function upsertItem(item: MediaItem): Promise<void> {
  let entry = tabs.get(item.tabId);
  if (!entry) {
    entry = { ...createContext(), filteredCount: 0, protectedCount: 0 };
    tabs.set(item.tabId, entry);
  }
  const k = item.dedupKey ?? item.id;
  const existing = entry.store.get(k);
  entry.store.set(k, { ...(existing ?? {}), ...item, dedupKey: k });
  if (!item.downloadable) entry.protectedCount++;
  await persist(item.tabId);
}

export async function updateItem(item: MediaItem): Promise<void> {
  const entry = tabs.get(item.tabId);
  if (!entry) return;
  const key = item.dedupKey ?? item.id;
  const existing = entry.store.get(key);
  entry.store.set(key, { ...(existing ?? {}), ...item, dedupKey: key });
  if (!item.downloadable) entry.protectedCount++;
  await persist(item.tabId);
}

export function getItem(tabId: number, mediaId: string): MediaItem | undefined {
  const entry = tabs.get(tabId);
  if (!entry) return undefined;
  for (const item of entry.store.values()) if (item.id === mediaId) return item;
  return undefined;
}

export function pageTitle(tabId: number): string | undefined {
  return tabs.get(tabId)?.pageTitle;
}

export function bumpFiltered(tabId: number): void {
  const e = tabs.get(tabId);
  if (!e) return;
  e.filteredCount++;
  persist(tabId).catch(() => {});
}

/** 页面导航/刷新：清空该 tab 媒体集合（F-106 规则 3） */
export async function clearTab(tabId: number): Promise<void> {
  tabs.delete(tabId);
  try {
    await chrome.storage.local.remove(key(tabId));
  } catch { /* ignore */ }
}

/** SW 冷启动恢复：从 local 读回（含 TTL 清理与失效标签页清理） */
export async function restore(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const stale: string[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(STORAGE_KEYS.TAB_STATE_PREFIX)) continue;
      const state = v as TabState & { savedAt?: number };
      if (!state.savedAt || now - state.savedAt > TTL_MS) {
        stale.push(k);
        continue;
      }
      const entry: TabEntry = {
        store: new Map(state.items.map((i) => [i.dedupKey ?? i.id, i])),
        pending: new Map(),
        filteredCount: state.filteredCount,
        protectedCount: state.protectedCount,
      };
      tabs.set(state.tabId, entry);
    }
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch { /* ignore */ }
}
