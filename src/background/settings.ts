// ============ 设置存储（即时持久化，IX-10）============
import type { Settings } from '../shared/types';
import { defaultSettings } from '../shared/types';
import { STORAGE_KEYS } from '../shared/messages';

let cache: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  try {
    const o = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const saved = o[STORAGE_KEYS.SETTINGS] as Partial<Settings> | undefined;
    // E-023：读取失败/结构不兼容回退默认；E-028：迁移式合并
    cache = saved ? { ...defaultSettings(), ...saved } : defaultSettings();
  } catch {
    cache = defaultSettings();
  }
  return cache;
}

export function getSettings(): Settings {
  return cache ?? defaultSettings();
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const merged = { ...getSettings(), ...patch };
  cache = merged;
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  for (const l of listeners) l(merged);
  return merged;
}

export async function resetSettings(): Promise<Settings> {
  cache = defaultSettings();
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: cache });
  for (const l of listeners) l(cache);
  return cache;
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- 域名准入（F-109）----------
export type AdmitResult = 'allow' | 'deny';

export function admitDomain(s: Settings, hostname: string): AdmitResult {
  const match = (list: string[]): boolean =>
    list.some((d) => {
      const t = d.trim().toLowerCase();
      if (!t) return false;
      const h = hostname.toLowerCase();
      return h === t || (h.endsWith(`.${t}`) && !t.startsWith('*.'));
    });
  switch (s.domainFilterMode) {
    case 'all':
      return 'allow';
    case 'whitelist':
      return match(s.whitelist) ? 'allow' : 'deny';
    case 'blacklist':
    default:
      return match(s.blacklist) ? 'deny' : 'allow';
  }
}

/** 媒体 CDN 域名归属主域判定（F-109 规则 2：主域+子域一体匹配） */
export function domainMatches(list: string[], hostname: string): boolean {
  return admitDomain({ ...getSettings(), domainFilterMode: 'whitelist', whitelist: list }, hostname) === 'allow';
}
