// ============ MediaSniff 共享类型定义（对齐 PRD 字段表）============

// ---------- 嗅探 ----------
/** 媒体线索：F-101 网络层 / F-102 页面层 的统一输出 */
export interface MediaHint {
  url: string;
  mime?: string;
  size?: number | null;
  tabId: number;
  frameId: number;
  source: 'network' | 'page';
  hookType?: 'fetch' | 'xhr' | 'mse' | 'dom';
  isBlob: boolean;
  parentManifest?: string;
  detectedAt: number;
  pageTitle?: string;
  posterUrl?: string;
  pageTitleSource?: string;
}

export type EncryptionType = 'none' | 'aes128' | 'sampleaes' | 'drm';
export type Protocol = 'progressive' | 'hls' | 'dash';

/** 清晰度变体（F-202） */
export interface Variant {
  id: string;
  resolution?: string; // 1920x1080
  qualityLabel?: string; // 1080p
  bandwidth?: number; // bps
  codecs?: string;
  playlistUrl: string;
  sizeEstimate?: number | null; // bytes
  durationSec?: number | null;
  segmentCount?: number;
  avgSegmentDur?: number;
  recommended?: boolean;
}

/** DASH 分离轨道（F-303） */
export interface TrackRef {
  trackId: string;
  type: 'video' | 'audio';
  bandwidth?: number;
  lang?: string;
  codecs?: string;
  playlistUrl: string;
  initUrl?: string;
  segmentUrls?: string[];
  /** 无清单 DASH（如 B 站）：整条轨在一个 URL 里（init + 媒体片段），下载时全量 GET 再拆分 */
  singleUrl?: string;
  durationSec?: number | null;
  sizeEstimate?: number | null;
}

export type MediaStatus =
  | 'hint' // 线索中
  | 'parsing' // 解析中
  | 'ready' // 可下载
  | 'ready_encrypted' // 可下载（AES-128）
  | 'protected' // 不可下载（DRM / SAMPLE-AES）
  | 'parse_failed' // 解析失败
  | 'unsupported'; // 直播等本期不支持

/** 归并后的媒体条目（F-104/F-105） */
export interface MediaItem {
  id: string; // 去重键哈希
  tabId: number;
  type: 'video' | 'audio';
  status: MediaStatus;
  protocol: Protocol;
  title: string;
  masterUrl: string; // 清单地址或渐进式直链
  variants: Variant[];
  tracks: TrackRef[]; // DASH 双轨
  durationSec: number | null;
  sizeEstimate: number | null; // bytes，估算需标注
  sizeIsEstimate: boolean;
  resolution?: string;
  encryption: EncryptionType;
  downloadable: boolean; // 由 encryption 推导，不得手工写入
  live: boolean;
  thumbnailUrl?: string;
  pageUrl?: string;
  siteDomain: string;
  detectedAt: number;
  parseError?: string;
  /** 不可下载原因（E-018 DRM / E-019 blob / E-020 直播） */
  blockedReason?: 'drm' | 'blob' | 'live' | 'sampleaes';
  /** 运行时统计：已归属分片线索数 */
  segmentHintCount?: number;
  dedupKey?: string;
}

// ---------- 下载任务 ----------
export type TaskStage = 'queued' | 'downloading' | 'decrypting' | 'merging' | 'transcoding' | 'done' | 'failed' | 'paused' | 'canceled';
export type EngineUsed = 'browser' | 'local';

export interface TrackProgress {
  trackId: string;
  type: 'video' | 'audio';
  status: 'pending' | 'downloading' | 'done' | 'failed';
  completedSegments: number;
  totalSegments: number;
  bytes: number;
}

export interface DownloadTask {
  id: string;
  mediaId: string;
  tabId: number;
  title: string;
  siteDomain: string;
  protocol: Protocol;
  variantId?: string; // 选中的变体
  audioTrackId?: string; // DASH 音轨选择
  stage: TaskStage;
  engine: EngineUsed;
  // 进度
  completedSegments: number;
  totalSegments: number;
  bytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSec: number | null;
  // DASH 双轨
  trackProgress?: TrackProgress[];
  audioMissing?: boolean;
  partialSuccess?: boolean;
  durationMismatchSec?: number;
  // 续传（F-305）
  retryCount: number;
  completedSegmentIndexes: number[];
  // 结果
  outputFilename?: string;
  outputContainer?: string;
  downloadedFilePath?: string;
  errorMessage?: string;
  errorCode?: string;
  missingSegments?: number;
  // 元信息
  createdAt: number;
  updatedAt: number;
  headers?: Record<string, string>;
  pageUrl?: string;
  convertAfterDownload?: boolean;
  convertPresetId?: string;
  /** 直链备份（媒体条目失联时的重试依据，F-305 失败不丢成本） */
  sourceUrl?: string;
  /**
   * 媒体条目快照（首跑时冻结：含分片 URL / 加密信息 / 双轨数据）。
   * 刷新扩展会清空 storage.session 里的媒体条目，快照保证任务自足可续传可重合并。
   */
  mediaSnapshot?: MediaItem;
}

// ---------- 设置（F-501~505） ----------
export type DomainFilterMode = 'blacklist' | 'whitelist' | 'all';
export type SaveMode = 'default' | 'ask' | 'fixed';
export type ConflictPolicy = 'rename' | 'overwrite' | 'skip';
export type ThemeMode = 'system' | 'light' | 'dark';

/** 转换预设（F-404/F-405 摘要级规格，执行依赖本地引擎） */
export interface ConvertPreset {
  id: string;
  name: string;
  container: string; // mp4 / mkv / webm / mp3
  videoCodec?: string; // h264 / copy
  audioCodec?: string; // aac / copy
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  resolution?: string; // 1920x1080 / source
  builtin?: boolean;
}

export interface ConvertRule {
  id: string;
  matchExt?: string;
  matchDomain?: string;
  presetId: string;
  enabled: boolean;
}

export interface Settings {
  // F-501 通用
  language: 'zh-CN';
  theme: ThemeMode;
  /** 音频输出格式：original=保留原始容器（m4a/mp3…）；mp3=统一转码为 MP3（有损，兼容性最好） */
  audioOutput: 'original' | 'mp3';
  // F-502 嗅探
  sniffType: 'all' | 'video' | 'audio';
  sniffMinSizeMb: number | null;
  sniffMaxSizeMb: number | null;
  sniffExtensions: string[];
  domainFilterMode: DomainFilterMode;
  blacklist: string[];
  whitelist: string[];
  // F-503 下载
  maxConcurrentTasks: number; // 1-5 默认 2
  segmentConcurrency: number; // 1-8 默认 4
  segmentTimeoutSec: number; // 默认 20
  maxSegmentRetry: number; // 默认 3
  maxMissingSegments: number; // 默认 2
  namingTemplate: string; // 默认 {title}-{resolution}
  saveMode: SaveMode;
  subDirectory: string; // 默认 MediaSniff
  fixedDirectory?: string;
  conflictPolicy: ConflictPolicy;
  quickDownload: boolean; // 默认 false（易误触）
  notifyOnComplete: boolean; // 默认 true
  largeFileThresholdMb: number; // 默认 200
  // F-504 转换
  convertPresets: ConvertPreset[];
  convertRules: ConvertRule[];
  defaultPresetId?: string;
  // F-506
  complianceConfirmedVersion: string | null;
}

export function defaultSettings(): Settings {
  return {
    language: 'zh-CN',
    theme: 'system',
    // 默认 MP3：纯音频 MP4 容器会被 Chrome 按内容判成 video/mp4 并强改扩展名（各版本行为不一，实测不可控）；
    // MP3 是裸音频流无歧义，且兼容性最广。想保留原始格式的用户可在设置里改回。
    audioOutput: 'mp3',
    sniffType: 'all',
    sniffMinSizeMb: null,
    sniffMaxSizeMb: null,
    sniffExtensions: ['mp4', 'webm', 'flv', 'mkv', 'ts', 'mp3', 'm4a', 'aac', 'mov', 'm4s'],
    domainFilterMode: 'blacklist',
    blacklist: [],
    whitelist: [],
    maxConcurrentTasks: 2,
    segmentConcurrency: 4,
    segmentTimeoutSec: 20,
    maxSegmentRetry: 3,
    maxMissingSegments: 2,
    namingTemplate: '{title}-{resolution}',
    saveMode: 'default',
    subDirectory: 'MediaSniff',
    conflictPolicy: 'rename',
    quickDownload: false,
    notifyOnComplete: true,
    largeFileThresholdMb: 200,
    convertPresets: [
      { id: 'preset-mp4-1080p', name: 'MP4 通用 1080p', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoBitrateKbps: 4500, audioBitrateKbps: 192, resolution: '1920x1080', builtin: true },
      { id: 'preset-mp4-source', name: 'MP4 原画质', container: 'mp4', videoCodec: 'copy', audioCodec: 'copy', builtin: true },
      { id: 'preset-mp3', name: 'MP3 音频提取', container: 'mp3', audioCodec: 'mp3', audioBitrateKbps: 320, builtin: true },
    ],
    convertRules: [],
    complianceConfirmedVersion: null,
  };
}

// ---------- 引擎（F-401） ----------
export type LocalEngineStatus = 'ready' | 'installed_unregistered' | 'not_installed' | 'version_mismatch';
export type BrowserEngineStatus = 'ready' | 'loading' | 'unavailable';
export const LOCAL_ENGINE_VERSION = '1.0.0';

export interface EngineStatus {
  browser: BrowserEngineStatus;
  local: LocalEngineStatus;
  localVersion?: string;
  capabilities: {
    remux: boolean;
    trackMerge: boolean;
    segmentMerge: boolean;
    aesDecrypt: boolean;
    transcode: boolean; // 需本地引擎
    localFileConvert: boolean; // 需本地引擎
  };
}

// ---------- 日志（§7） ----------
export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
export interface LogEntry {
  t: number;
  level: LogLevel;
  module: 'sniffer' | 'analyzer' | 'downloader' | 'processor' | 'engine' | 'storage' | 'ui';
  msg: string;
  detail?: string;
}

// ---------- Popup 状态快照 ----------
export interface TabState {
  tabId: number;
  items: MediaItem[];
  filteredCount: number;
  protectedCount: number;
  parsingCount: number;
}
