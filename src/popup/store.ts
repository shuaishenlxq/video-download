// ============ Popup 数据层：chrome.runtime 消息 + storage.onChanged 实时刷新 ============
import { useEffect, useState, useCallback, useRef } from 'react';
import type { MediaItem, DownloadTask, Settings, LogEntry, EngineStatus, TabState } from '../shared/types';
import { MSG, send } from '../shared/messages';
import { defaultSettings } from '../shared/types';

export interface TabStateWithMeta extends TabState {
  tabUrl?: string;
  pageTitle?: string;
}

const EMPTY_STATE: TabStateWithMeta = { tabId: -1, items: [], filteredCount: 0, protectedCount: 0, parsingCount: 0 };

export function useTabState(): TabStateWithMeta {
  const [state, setState] = useState<TabStateWithMeta>(EMPTY_STATE);
  const refresh = useCallback(async () => {
    try {
      // ?tabId= 覆盖（调试/测试用）：查指定标签页而非当前激活页
      const override = new URLSearchParams(location.search).get('tabId');
      const s = await send<TabStateWithMeta>(MSG.QUERY_TAB_STATE, override ? { tabId: Number(override) } : undefined);
      setState(s ?? EMPTY_STATE);
    } catch {
      /* SW 冷启动中，稍后由 storage 事件驱动 */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('tab:'))) void refresh();
    };
    chrome.storage.onChanged.addListener(onStorage);
    // 侧边栏常驻：切换标签页 / 页面导航时都要重新查询当前页媒体
    const onActivated = (): void => void refresh();
    const onUpdated = (_id: number, info: { status?: string }): void => {
      if (info.status === 'complete' || info.status === 'loading') void refresh();
    };
    try {
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.windows?.onFocusChanged?.addListener(onActivated);
    } catch { /* 无 tabs 权限时忽略 */ }
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      try {
        chrome.tabs.onActivated.removeListener(onActivated);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.windows?.onFocusChanged?.removeListener(onActivated);
      } catch { /* ignore */ }
    };
  }, [refresh]);
  return state;
}

export function useTasks(): DownloadTask[] {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const refresh = useCallback(async () => {
    try {
      const r = await send<{ tasks: DownloadTask[] }>('listTasks');
      setTasks(r.tasks ?? []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    void refresh();
    const listener = (_c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') void refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);
  return tasks;
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => Promise<void>] {
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  useEffect(() => {
    void (async () => {
      try {
        const r = await send<{ settings: Settings }>(MSG.GET_SETTINGS);
        // 合并默认值：旧版本/异常数据缺字段时兜底（E-023）
        if (r.settings) setSettings({ ...defaultSettings(), ...r.settings });
      } catch { /* ignore */ }
    })();
  }, []);
  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    try {
      const r = await send<{ settings: Settings }>(MSG.SET_SETTINGS, patch);
      if (r.settings) setSettings({ ...defaultSettings(), ...r.settings });
    } catch { /* ignore */ }
  }, []);
  return [settings, update];
}

export function useLogs(): [LogEntry[], (f?: { level?: string; keyword?: string }) => Promise<void>, () => Promise<void>] {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const query = useCallback(async (f?: { level?: string; keyword?: string }) => {
    try {
      const r = await send<{ entries: LogEntry[] }>(MSG.QUERY_LOGS, f);
      setLogs(r.entries ?? []);
    } catch { /* ignore */ }
  }, []);
  const clear = useCallback(async () => {
    await send(MSG.CLEAR_LOGS);
    setLogs([]);
  }, []);
  return [logs, query, clear];
}

export function useEngine(): [EngineStatus | null, () => Promise<void>] {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const probe = useCallback(async () => {
    try {
      const r = await send<{ engine: EngineStatus }>(MSG.PROBE_ENGINE);
      setEngine(r.engine);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    void probe();
  }, [probe]);
  return [engine, probe];
}

// ---------- Toast（IX-08：成功 2s / 失败 4s 带操作）----------
export interface ToastMsg {
  text: string;
  kind: 'ok' | 'err';
  action?: { label: string; fn: () => void };
}

export function useToast(): [ToastMsg | null, (text: string, kind?: 'ok' | 'err', action?: ToastMsg['action']) => void] {
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, kind: 'ok' | 'err' = 'ok', action?: ToastMsg['action']) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ text, kind, action });
    timer.current = setTimeout(() => setToast(null), kind === 'ok' ? 2000 : 4000);
  }, []);
  return [toast, show];
}

// ---------- 二次确认（IX-07：仅五处使用）----------
export interface ConfirmState {
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
}

export function useConfirm(): [ConfirmState | null, (s: ConfirmState) => void, () => void] {
  const [state, setState] = useState<ConfirmState | null>(null);
  const open = useCallback((s: ConfirmState) => setState(s), []);
  const close = useCallback(() => setState(null), []);
  return [state, open, close];
}
