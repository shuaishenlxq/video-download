// ============ 消息协议（popup ↔ background ↔ offscreen）============
import type { Settings, TabState, DownloadTask, LogEntry, EngineStatus, MediaHint } from './types';

export const MSG = {
  // popup -> background
  QUERY_TAB_STATE: 'queryTabState',
  CREATE_TASK: 'createTask',
  TASK_COMMAND: 'taskCommand',
  GET_SETTINGS: 'getSettings',
  SET_SETTINGS: 'setSettings',
  QUERY_LOGS: 'queryLogs',
  CLEAR_LOGS: 'clearLogs',
  PROBE_ENGINE: 'probeEngine',
  RESCAN_TAB: 'rescanTab',
  ADD_BLACKLIST: 'addBlacklist',
  EXPORT_SETTINGS: 'exportSettings',
  IMPORT_SETTINGS: 'importSettings',
  RESET_SETTINGS: 'resetSettings',
  CONFIRM_COMPLIANCE: 'confirmCompliance',
  PARSE_RETRY: 'parseRetry',
  // background -> offscreen
  MERGE_HLS: 'mergeHls',
  MERGE_DASH: 'mergeDash',
  SAVE_DATA: 'saveData',
  OFFSCREEN_PING: 'offscreenPing',
} as const;

export interface CreateTaskPayload {
  mediaId: string;
  variantId?: string;
  audioTrackId?: string;
  convert?: boolean;
  presetId?: string;
}

export type TaskCommandKind =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry'
  | 'remove'
  | 'saveVideoOnly'
  | 'retryAudio'
  | 'remerge'
  | 'openFolder';

export interface MergeHlsRequest {
  taskId: string;
  segmentIndexes: number[];
  segmentUrls: string[]; // 供 IDB 索引
  encryption: { method: 'none' | 'aes128'; keyUrl?: string; ivHex?: string; mediaSequenceBase: number };
  inputFormat: 'ts' | 'fmp4';
  outputFilename: string;
  initUrl?: string; // fMP4
  /** 清单实测总时长（秒）：合并后写回 mvhd/mdhd/tkhd，替代 0xFFFFFFFF 占位 */
  expectedDurationSec?: number;
}

export interface MergeDashRequest {
  taskId: string;
  video: { initUrl?: string; segmentIndexes: number[] };
  audio?: { initUrl?: string; segmentIndexes: number[] };
  outputFilename: string;
  expectedDurationSec?: number;
}

export interface MergeResult {
  ok: boolean;
  filename?: string;
  sizeBytes?: number;
  /** offscreen 创建的 blob: URL（offscreen 无 chrome.downloads 权限，落盘由 SW 执行） */
  blobUrl?: string;
  error?: string;
  validation?: { containerOk: boolean; durationSec?: number; expectedDurationSec?: number };
  /** 合并过程诊断信息（写运行日志用） */
  debug?: { inputSegments: number; outputFragments: number; tfdtRepaired: number; durationSecWritten?: number; fallbackRawTs?: boolean; flattened?: boolean; samples?: number };
}

// storage keys
export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  TASKS: 'tasks',
  LOGS: 'logs',
  TAB_STATE_PREFIX: 'tab:',
  ENGINE: 'engine',
} as const;

// helper: 发消息的包装（popup/offscreen 侧）
export function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload }) as Promise<T>;
}
export type { Settings, TabState, DownloadTask, LogEntry, EngineStatus, MediaHint };
