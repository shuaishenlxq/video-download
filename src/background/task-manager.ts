// ============ 下载任务管理器（F-301/302/303/305/306/307/308 编排中枢）============
import type { DownloadTask, MediaItem, Settings, TrackProgress } from '../shared/types';
import { MSG, STORAGE_KEYS, send, type MergeResult } from '../shared/messages';
import { buildFilename } from '../shared/naming';
import { getSettings, saveSettings } from './settings';
import { downloadQueue } from './tasks/queue';
import { SegmentPool, type FetchErr } from './tasks/queue';
import { putSegment, getSegment, deleteTaskSegments, cleanupOrphans } from './tasks/segments';
import { splitFmp4Parts } from './sites/dash-nolist';
import { resolveOutputProfile, extFromUrl } from './output-profile';
import { rememberDesiredFilename } from './download-namer';
import { ensureRefererRule, removeRefererRule } from './dnr';

/** 收集需要挂 Referer 规则的域名：页面域 + 各媒体请求域（跨 CDN 场景必需） */
function refererDomains(siteDomain: string, urls: (string | undefined)[]): string[] {
  const set = new Set<string>([siteDomain].filter(Boolean) as string[]);
  for (const u of urls) {
    if (!u) continue;
    try {
      set.add(new URL(u).hostname);
    } catch { /* ignore */ }
  }
  return [...set];
}
import { sendToOffscreen } from './offscreen-manager';
import { notifyTaskDone } from './notify';
import { log, sanitizeUrl, sanitizePath } from './logger';
import { canMergeInBrowser, detectDeviceMemoryGb } from './memory';
import { routeEngine, getEngineStatus } from './engine';
import { deriveIconState } from './icon-state';
import { formatBytes } from '../shared/format';

const tasks = new Map<string, DownloadTask>();
const queue = downloadQueue({ maxConcurrentTasks: 2, maxProcessingTasks: 1 });
const running = new Map<string, { pause: boolean; cancel: boolean; resumeDeps?: () => Promise<void> }>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// ---------- 持久化（SW 休眠对策：状态只放 storage，不放内存）----------
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: [...tasks.values()] });
    await updateBadge();
  }, 400); // IX-03 进度节流
}

export async function restoreTasks(): Promise<void> {
  const o = await chrome.storage.local.get(STORAGE_KEYS.TASKS);
  const saved = (o[STORAGE_KEYS.TASKS] as DownloadTask[] | undefined) ?? [];
  for (const t of saved) {
    // E-013：浏览器重启后 下载中/排队 → 已暂停，不自动续传
    if (t.stage === 'downloading' || t.stage === 'queued' || t.stage === 'decrypting' || t.stage === 'merging') {
      t.stage = 'paused';
      t.errorMessage = '浏览器重启导致任务中断';
    }
    tasks.set(t.id, t);
  }
  await cleanupOrphans(new Set(tasks.keys()));
}

async function updateBadge(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const tabTasks = [...tasks.values()].filter((t) => t.tabId === tab.id);
  const items = await getTabItems(tab.id);
  const state = deriveIconState({ items, tasks: tabTasks });
  const iconMap: Record<string, string> = { gray: 'gray', idle: 'idle', ring: 'ring', locked: 'locked' };
  const sizes = [16, 32, 48, 128];
  await chrome.action.setIcon({
    tabId: tab.id,
    path: Object.fromEntries(sizes.map((s) => [s, `icons/${iconMap[state.icon]}${s}.png`])),
  });
  await chrome.action.setBadgeText({ tabId: tab.id, text: state.badge ?? '' });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: state.icon === 'locked' ? '#98A2AE' : '#17A184' });
}

async function getTabItems(tabId: number): Promise<MediaItem[]> {
  const key = `${STORAGE_KEYS.TAB_STATE_PREFIX}${tabId}`;
  const o = await chrome.storage.local.get(key);
  return (o[key] as { items: MediaItem[] } | undefined)?.items ?? [];
}

// ---------- 任务创建（E-021 重复查重 / F-307 命名 / F-401 引擎路由）----------
export async function createTask(
  media: MediaItem,
  opts: { variantId?: string; audioTrackId?: string; convert?: boolean; presetId?: string; index?: number } = {}
): Promise<{ ok: boolean; taskId?: string; error?: string; existingTaskId?: string }> {
  // E-021：同一媒体已有任务 → 聚焦既有任务
  for (const t of tasks.values()) {
    if (t.mediaId === media.id && !['done', 'canceled'].includes(t.stage)) {
      return { ok: false, error: '该视频已在下载队列中', existingTaskId: t.id };
    }
  }
  const s = getSettings();
  const variant = media.variants.find((v) => v.id === opts.variantId) ?? media.variants[0];
  const audioTrack = media.tracks.find((t) => t.trackId === opts.audioTrackId) ?? media.tracks.find((t) => t.type === 'audio');

  const isDashDual = media.protocol === 'dash' && !!audioTrack;
  const engine = routeEngine('merge');
  const segCount = variant?.segmentCount ?? 1;

  // 命名（F-307）：批量序号仅在批量下载时传入
  // 输出档案（容器/扩展名/MIME）由策略决定：音频走音频策略、视频与原逻辑等价（见 output-profile.ts）
  // 注意：扩展名只认已知媒体类型——很多站点用 .txt/.jpg 伪装媒体直链防盗链，盲取 URL 扩展名会产出「xxx.txt」
  const rawExt = media.protocol === 'progressive' ? extFromUrl(media.masterUrl) : 'mp4';
  const profile = resolveOutputProfile(media, {
    protocol: media.protocol,
    masterUrl: media.masterUrl,
    sourceExt: rawExt,
    sourceMime: (media as { mime?: string }).mime,
    audioOutput: s.audioOutput,
  });
  const filename = buildFilename(s.namingTemplate, {
    title: media.title,
    site: media.siteDomain,
    resolution: variant?.resolution,
    quality: variant?.qualityLabel,
    bitrate: variant?.bandwidth ? Math.round(variant.bandwidth / 1000) : undefined,
    durationSec: media.durationSec,
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    time: new Date().toTimeString().slice(0, 8).replace(/:/g, ''),
    index: opts.index,
    ext: profile.ext,
  });

  const task: DownloadTask = {
    id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    mediaId: media.id,
    tabId: media.tabId,
    title: media.title,
    siteDomain: media.siteDomain,
    protocol: media.protocol,
    variantId: variant?.id,
    audioTrackId: audioTrack?.trackId,
    stage: 'queued',
    engine,
    completedSegments: 0,
    totalSegments: isDashDual ? segCount + (audioTrack?.segmentUrls?.length ?? 0) : segCount,
    bytes: 0,
    totalBytes: variant?.sizeEstimate ?? null,
    speedBps: 0,
    etaSec: null,
    trackProgress: isDashDual
      ? [
          { trackId: media.tracks.find((t) => t.type === 'video')?.trackId ?? 'v', type: 'video', status: 'pending', completedSegments: 0, totalSegments: segCount, bytes: 0 },
          { trackId: audioTrack!.trackId, type: 'audio', status: 'pending', completedSegments: 0, totalSegments: audioTrack?.segmentUrls?.length ?? 0, bytes: 0 },
        ]
      : undefined,
    retryCount: 0,
    completedSegmentIndexes: [],
    outputFilename: filename,
    outputContainer: profile.container,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pageUrl: media.pageUrl,
    convertAfterDownload: opts.convert,
    convertPresetId: opts.presetId,
  };
  tasks.set(task.id, task);
  log.info(
    'downloader',
    `任务创建：${filename}`,
    `引擎=${engine} 协议=${media.protocol} 类型=${profile.kind} 容器=${profile.container} 分片=${task.totalSegments}`
  );

  // 大文件内存通道提示（F-301 规则 3）由 UI 层在创建前确认；这里只执行
  queue.acquire(() => runTask(task.id)).catch((e) => log.error('downloader', `任务调度异常 ${task.id}`, String(e)));
  schedulePersist();
  return { ok: true, taskId: task.id };
}

// ---------- 任务状态流转 ----------
function setStage(task: DownloadTask, stage: DownloadTask['stage'], errorMessage?: string, errorCode?: string): void {
  task.stage = stage;
  task.updatedAt = Date.now();
  if (errorMessage !== undefined) task.errorMessage = errorMessage;
  if (errorCode !== undefined) task.errorCode = errorCode;
  log.info('downloader', `阶段切换：${stage}`, `任务=${task.id}`);
  schedulePersist();
}

function updateProgress(task: DownloadTask): void {
  const elapsed = (Date.now() - task.createdAt) / 1000;
  if (elapsed > 1 && task.bytes > 0) {
    task.speedBps = task.bytes / elapsed;
    if (task.totalBytes) task.etaSec = Math.max(0, (task.totalBytes - task.bytes) / Math.max(task.speedBps, 1));
  }
  schedulePersist();
}

  // ---------- 任务执行主体 ----------
  async function runTask(taskId: string): Promise<void> {
    const task = tasks.get(taskId);
    if (!task || task.stage === 'canceled') return;
  const ctrl = { pause: false, cancel: false };
  running.set(taskId, ctrl);
  const signal = { get aborted() { return ctrl.cancel || ctrl.pause; } };

  try {
    // 媒体条目优先取实时数据；失联（刷新扩展清空 session）时回退任务快照（F-305 失败不丢成本）
    let media = (await findMedia(task.mediaId, task.tabId)) ?? task.mediaSnapshot;
    if (!media && task.completedSegmentIndexes.length > 0) {
      // 存量任务恢复：无快照但 IDB 有分片 → 构造最小条目壳，走孤儿合并路径
      media = {
        id: task.mediaId,
        tabId: task.tabId,
        type: 'video',
        status: 'ready',
        protocol: task.protocol,
        title: task.title,
        masterUrl: task.sourceUrl ?? '',
        variants: [{ id: task.variantId ?? 'default', playlistUrl: '' }],
        tracks: [],
        durationSec: null,
        sizeEstimate: null,
        sizeIsEstimate: false,
        encryption: 'none',
        downloadable: true,
        live: false,
        siteDomain: task.siteDomain,
        detectedAt: task.createdAt,
      };
      task.mediaSnapshot = media;
      schedulePersist();
      log.warn('downloader', '任务无快照，启用孤儿合并模式', `已保留分片 ${task.completedSegmentIndexes.length} 个`);
    }
    if (!media) {
      setStage(task, 'failed', '媒体条目已不存在且任务无快照，无法续传（请回到播放页重新发起下载）', 'media_gone');
      return;
    }
    // 首跑冻结快照：分片 URL / 加密信息 / 双轨数据随任务持久化（storage.local 不受扩展刷新影响）
    if (!task.mediaSnapshot) {
      task.mediaSnapshot = JSON.parse(JSON.stringify(media)) as MediaItem;
      task.sourceUrl = media.masterUrl;
      schedulePersist();
    }
    const s = getSettings();
    setStage(task, 'downloading');

    if (task.protocol === 'progressive') {
      await runDirect(task, media, s, ctrl, signal);
    } else if (task.protocol === 'hls') {
      await runHls(task, media, s, ctrl, signal);
    } else if (task.protocol === 'dash') {
      await runDash(task, media, s, ctrl, signal);
    }
  } catch (e) {
    const err = e as FetchErr;
    // 失败不丢用户成本：保留已下载分片（F-305 规则 6）
    task.retryCount = (task.retryCount ?? 0);
    setStage(task, 'failed', humanizeError(err), err.statusCode ? String(err.statusCode) : err.message);
    log.error('downloader', `任务失败：${task.title}`, `${task.errorCode} · 已保留 ${task.completedSegmentIndexes.length} 个分片`);
  } finally {
    running.delete(taskId);
    schedulePersist();
  }
}

function humanizeError(e: FetchErr): string {
  if (e.statusCode === 401 || e.statusCode === 403) return '访问凭证已失效（401），请刷新页面后重试';
  if (e.statusCode === 404) return '源文件不存在（404）';
  if (e.statusCode === 429 || e.statusCode === 503) return '站点限流，已多次自动降速仍失败';
  if (e.message === 'timeout') return '连接超时';
  if (e.message.includes('memory')) return '内存水位不足，建议安装本地处理引擎';
  return e.message || '未知错误';
}

/** 合并错误 → 用户可读文案（unsupported_codec 等诊断性错误） */
function mergeErrorText(r: MergeResult): { text: string; code: string } {
  const err = r.error ?? '未知错误';
  if (err.startsWith('unsupported_codec')) {
    return { text: `视频编码不受浏览器内引擎支持：${err.replace('unsupported_codec:', '')}`, code: 'unsupported_codec' };
  }
  const isValidation = err.startsWith('merge_validation_failed');
  return {
    text: isValidation ? `合并校验失败：${err}` : `合并处理失败：${err}`,
    code: isValidation ? 'merge_validation' : 'merge_failed',
  };
}

/** 从 IDB 首个分片探测输入格式（孤儿合并时无 URL 可判）：0x47 = MPEG-TS sync byte */
async function detectInputFormat(taskId: string, indexes: number[]): Promise<'ts' | 'fmp4'> {
  const first = indexes[0];
  if (first != null) {
    const buf = await getSegment(taskId, first).catch(() => undefined);
    if (buf && buf.byteLength > 0) return new Uint8Array(buf)[0] === 0x47 ? 'ts' : 'fmp4';
  }
  return 'ts';
}

async function findMedia(mediaId: string, tabId: number): Promise<MediaItem | undefined> {
  const items = await getTabItems(tabId);
  return items.find((i) => i.id === mediaId);
}

// ---------- 直下通道（F-301）----------
// 通道选择（PRD 9.5 + 实战修正）：
//   - downloads API 不允许 Referer 等受限头，且服务器 Content-Disposition 会覆盖其 filename 参数
//   - 因此「URL 扩展名非已知媒体类型」的伪装直链（常见于防盗链站点）强制走扩展内抓取 + blob 落盘，
//     blob URL 下载无 Content-Disposition，文件名完全可控
const KNOWN_DL_EXT = ['mp4', 'webm', 'mov', 'mkv', 'flv', 'm4v', 'ts', 'm4s', 'mp3', 'm4a', 'aac'];

function urlExt(url: string): string {
  return (url.split('?')[0]!.split('.').pop() ?? '').toLowerCase();
}

/** 是否需要强制走扩展内抓取通道（伪装扩展名 / 服务器会指定文件名） */
function needsFetchChannel(url: string): boolean {
  return !KNOWN_DL_EXT.includes(urlExt(url));
}

async function runDirect(task: DownloadTask, media: MediaItem, s: Settings, ctrl: { pause: boolean; cancel: boolean }, signal: { aborted: boolean }): Promise<void> {
  const referer = media.pageUrl ?? `https://${media.siteDomain}/`;
  const filename = pathFor(s, task.outputFilename ?? 'video.mp4');
  // 输出档案（与 createTask 同源）：决定兜底扩展名，音频不会被打成 .mp4
  const profile = resolveOutputProfile(media, {
    protocol: media.protocol,
    masterUrl: media.masterUrl,
    sourceExt: media.protocol === 'progressive' ? extFromUrl(media.masterUrl) : 'mp4',
    sourceMime: (media as { mime?: string }).mime,
    audioOutput: s.audioOutput,
  });
  const conflict = (s.conflictPolicy === 'overwrite'
    ? 'overwrite'
    : s.conflictPolicy === 'skip'
      ? 'prompt'
      : 'uniquify') as chrome.downloads.FilenameConflictAction;
  // 通道选择：
  //   1) URL 扩展名不可信（伪装直链）→ 必须走 blob 通道（规避服务端 Content-Disposition 覆盖文件名）
  //   2) **音频一律走 blob 通道**：Chrome 原生下载会按内容重新判定 MIME（M4A 是 MP4 容器 → 判成
  //      video/mp4）并把扩展名改成 .mp4；blob 通道由我们给出 MIME(audio/mp4) 与文件名(.m4a)，
  //      两者一致，Chrome 不再"纠正"。视频路径保持原行为不变。
  const forceFetch = needsFetchChannel(media.masterUrl) || profile.kind === 'audio';

  // 通道 A：原生下载（Cookie 自动携带，内存占用最低；仅用于扩展名可信的直链）
  let downloadId: number | null = null;
  if (!forceFetch) {
    try {
      let dlFilename = filename;
      // 兜底扩展名取自输出档案（音频 → m4a/mp3…，视频 → mp4，与原行为一致）
      if (!/\.(mp4|ts|webm|mkv|mov|flv|m4a|mp3|aac|ogg|oga|opus|flac|wav)$/i.test(dlFilename)) {
        dlFilename = dlFilename.replace(/\.[a-z0-9]{1,5}$/i, '') + '.' + profile.ext;
      }
      // 登记期望文件名：Chrome 会按 MIME 规范化扩展名（m4a 被判为 video/mp4 → 改成 .mp4），此处裁定回我们的名字
      rememberDesiredFilename(media.masterUrl, dlFilename);
      downloadId = await chrome.downloads.download({ url: media.masterUrl, filename: dlFilename, conflictAction: conflict, saveAs: s.saveMode === 'ask' });
      await trackDownloadProgress(task, downloadId, signal);
      setStage(task, 'done');
      task.downloadedFilePath = filename;
      log.info('downloader', `下载完成：${task.outputFilename}`, `通道=原生下载 · ${formatBytes(task.bytes)} · 保存模式=${s.saveMode}`);
      await notifyTaskDone(s, task.title);
      await afterComplete(task, s);
      return;
    } catch (e) {
      const err = e as FetchErr;
      const code = err.message ?? '';
      const retriable = /403|401|referer|forbidden|server/i.test(code);
      if (!retriable || signal.aborted) throw err;
      log.warn('downloader', `原生通道失败（${code}），切换扩展内抓取通道`, sanitizeUrl(media.masterUrl));
    }
  } else {
    log.info('downloader', `URL 扩展名不可信（.${urlExt(media.masterUrl)}），走扩展内抓取通道规避服务端文件名覆盖`, sanitizeUrl(media.masterUrl));
  }

  // 通道 B：扩展内抓取（DNR 补 Referer + offscreen 内存转存 + blob 落盘）
  const fetchRefererDomains = refererDomains(media.siteDomain, [media.masterUrl]);
  await ensureRefererRule(fetchRefererDomains, referer);
  try {
    // 传入输出档案的 MIME：音频必须是 audio/*，否则 Chrome 会按 video/mp4 把扩展名改回 .mp4
    // MIME 必须是输出档案的类型（音频 → audio/mp4）：实测 blob/downloads API 的最终扩展名取决于该 MIME，
    // 给成 audio/mp4 时 Chrome 保留 .m4a 且仍支持 filename 里的子目录（DOM 触发虽也能保名，但无法指定目录）。
    // 音频可选用「转 MP3」输出：MP3 是裸音频流、无容器歧义，可彻底规避 Chrome 按内容嗅探改扩展名
    // （M4A 属 MP4 容器 → 常被判成 video/mp4 → 落盘变 .mp4）。转码有损（AAC→MP3）。
    const useMp3 = profile.kind === 'audio' && profile.ext === 'mp3';
    let outName = filename;
    let outMime = profile.mime;
    if (useMp3) {
      outName = filename.replace(/\.[a-z0-9]{1,5}$/i, '') + '.mp3';
      outMime = 'audio/mpeg';
    }
    const r = await sendToOffscreen<MergeResult>('saveData', {
      url: media.masterUrl,
      filename: outName,
      taskId: task.id,
      mime: outMime,
      encode: useMp3 ? 'mp3' : undefined,
    });
    if (!r.ok) throw new Error(r.error ?? 'fetch_channel_failed');
    if (!r.blobUrl) throw new Error('fetch_channel_failed');
    await downloadBlobUrl(task, r.blobUrl, s, outName);
    setStage(task, 'done');
    task.bytes = r.sizeBytes ?? 0;
    task.downloadedFilePath = filename;
    log.info('downloader', `下载完成：${task.outputFilename}`, `通道=扩展内抓取（blob 落盘，文件名不受服务端影响） · ${formatBytes(task.bytes)}`);
    await notifyTaskDone(s, task.title);
    await afterComplete(task, s);
  } finally {
    await removeRefererRule(fetchRefererDomains);
  }
  void ctrl;
  void downloadId;
}

/** blob: URL（offscreen 创建）→ chrome.downloads 落盘。offscreen 无 downloads API，必须由 SW 执行 */
async function downloadBlobUrl(task: DownloadTask, blobUrl: string, s: Settings, nameOverride?: string): Promise<void> {
  const conflict = (s.conflictPolicy === 'overwrite'
    ? 'overwrite'
    : s.conflictPolicy === 'skip'
      ? 'prompt'
      : 'uniquify') as chrome.downloads.FilenameConflictAction;
  // 兜底：无论上游命名如何，落盘扩展名必须是已知媒体类型（防伪装直链/历史快照污染）
  let filename = nameOverride ?? pathFor(s, task.outputFilename ?? task.title);
  const fallbackExt = extFromUrl(task.outputFilename ?? '') || 'mp4';
  if (!/\.(mp4|ts|webm|mkv|mov|flv|m4a|mp3|aac|ogg|oga|opus|flac|wav)$/i.test(filename)) {
    filename = filename.replace(/\.[a-z0-9]{1,5}$/i, '') + '.' + fallbackExt;
  }
  // 登记期望文件名：blob URL 是唯一键，事件命中后由我们裁定最终名字（避免被 MIME 规范化改扩展名）
  rememberDesiredFilename(blobUrl, filename);
  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename,
    conflictAction: conflict,
    saveAs: s.saveMode === 'ask',
  });
  await waitForDownloadComplete(downloadId, 10 * 60_000);
  // 落盘完成后释放 offscreen 的 blob 引用（失败不阻塞，offscreen 关闭时自动回收）
  void sendToOffscreen('revokeUrl', { url: blobUrl }).catch(() => {});
}

function waitForDownloadComplete(downloadId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), timeoutMs); // 超时不视为失败
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        cleanup();
        resolve();
      } else if (delta.state.current === 'interrupted') {
        cleanup();
        reject(new Error(`download_interrupted:${delta.error?.current ?? ''}`));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
    }
    chrome.downloads.onChanged.addListener(listener);
  });
}

function pathFor(s: Settings, filename: string): string {
  if (s.saveMode === 'default' && s.subDirectory) return `${s.subDirectory.replace(/[/\\]/g, '')}/${filename}`;
  return filename;
}

function trackDownloadProgress(task: DownloadTask, downloadId: number | null, signal: { aborted: boolean }): Promise<void> {
  if (downloadId == null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    type Delta = { id: number; bytesReceived?: { current: number }; totalBytes?: { current: number }; state?: { current: string; previous?: string }; error?: { current?: string } };
    const listener = (raw: chrome.downloads.DownloadDelta) => {
      const delta = raw as unknown as Delta;
      if (delta.id !== downloadId) return;
      if (delta.bytesReceived) {
        task.bytes = delta.bytesReceived.current;
        updateProgress(task);
      }
      if (delta.totalBytes?.current) task.totalBytes = delta.totalBytes.current;
      if (delta.state) {
        if (delta.state.current === 'complete') {
          cleanup();
          resolve();
        } else if (delta.state.current === 'interrupted') {
          cleanup();
          reject(new Error(`download_interrupted:${delta.error?.current ?? ''}`));
        }
      }
      if (signal.aborted) {
        // 暂停/取消：取消浏览器下载
        void chrome.downloads.cancel(downloadId).catch(() => {});
      }
    };
    function cleanup() {
      chrome.downloads.onChanged.removeListener(listener);
      clearInterval(poll);
    }
    chrome.downloads.onChanged.addListener(listener);
    // 兜底轮询（onChanged 可能丢事件）
    const poll = setInterval(async () => {
      try {
        const [d] = await chrome.downloads.search({ id: downloadId });
        if (!d) return;
        task.bytes = d.bytesReceived;
        if (d.totalBytes > 0) task.totalBytes = d.totalBytes;
        updateProgress(task);
        if (d.state === 'complete') {
          cleanup();
          resolve();
        } else if (d.state === 'interrupted') {
          cleanup();
          reject(new Error(`download_interrupted:${d.error ?? ''}`));
        }
      } catch { /* ignore */ }
    }, 800);
  });
}

// ---------- HLS 管线（F-302/304/305）----------
async function runHls(task: DownloadTask, media: MediaItem, s: Settings, ctrl: { pause: boolean; cancel: boolean }, signal: { aborted: boolean }): Promise<void> {
  const variant = media.variants.find((v) => v.id === task.variantId) ?? media.variants[0];
  const ext = variant as typeof variant & { segUrls?: string[]; enc?: { method: string; keyUrl?: string; ivHex?: string } } | undefined;
  let segUrls = ext?.segUrls ?? [];
  let enc = ext?.enc ?? { method: 'none' };

  // 孤儿合并兜底：无清单 URL 但 IDB 里有已下分片（快照修复前的存量任务）→ 跳过下载直接合并
  let orphanMerge = false;
  if (!segUrls.length) {
    if (task.completedSegmentIndexes.length > 0) {
      orphanMerge = true;
      log.warn('downloader', '清单 URL 不可用，基于已保留分片直接尝试合并', `分片 ${task.completedSegmentIndexes.length} 个`);
    } else {
      setStage(task, 'failed', '分片列表为空（清单可能已过期），请刷新页面后重试', 'no_segments');
      return;
    }
  }
  const encUnknown = orphanMerge; // 存量任务无加密信息，按未加密尝试

  // 分片状态：续传跳过已完成（F-305 规则 3）
  const doneSet = new Set(task.completedSegmentIndexes);
  const todo = orphanMerge ? [] : segUrls.map((_, i) => i).filter((i) => !doneSet.has(i));

  const hlsRefererDomains = refererDomains(media.siteDomain, [
    ...(segUrls ?? []).slice(0, 3),
  ]);
  await ensureRefererRule(hlsRefererDomains, media.pageUrl ?? `https://${media.siteDomain}/`);
  let concurrency = s.segmentConcurrency;
  try {
    const pool = new SegmentPool(concurrency, s.segmentTimeoutSec, s.maxSegmentRetry, async (i: number) => {
      if (ctrl.cancel) throw cancelErr();
      const res = await fetch(segUrls[i]!, { credentials: 'include', signal: toAbortSignal(ctrl) });
      if (!res.ok) {
        const e = new Error(`http_${res.status}`) as FetchErr;
        e.statusCode = res.status;
        throw e;
      }
      const buf = await res.arrayBuffer();
      await putSegment(task.id, i, buf);
      task.bytes += buf.byteLength;
      task.completedSegments = doneSet.size + poolSnapshot.completed;
      updateProgress(task);
      return 'ok' as const;
    });
    const poolSnapshot = { completed: 0 };

    const result = await withPauseResume(
      () => pool.run(todo, { maxMissingSegments: s.maxMissingSegments, signal: { get aborted() { return ctrl.cancel || ctrl.pause; } } }),
      () => poolSnapshot.completed,
      (n) => (poolSnapshot.completed = n),
      ctrl,
      task
    );

    // E-004 自适应降速信号
    if (result.throttled > 2 && concurrency > 1) {
      concurrency = Math.max(1, concurrency - 1);
      log.warn('downloader', `触发站点限流，分片并发 ${concurrency + 1} → ${concurrency}`);
    }

    if (result.abortReason === 'credential') {
      setStage(task, 'failed', '访问凭证已失效（401），请刷新页面后重试', '401');
      return;
    }
    if (result.abortReason === 'missing') {
      setStage(task, 'failed', `缺失 ${result.missing.length} 个分片，文件可能不完整`, 'missing');
      task.missingSegments = result.missing.length;
      return;
    }
    if (ctrl.cancel) {
      setStage(task, 'canceled');
      await deleteTaskSegments(task.id);
      return;
    }
    if (ctrl.pause) {
      saveCompleted(task, result);
      setStage(task, 'paused');
      return;
    }

    saveCompleted(task, result);
    // 缺失片 ≤ 阈值继续（E-006）
    if (result.missing.length > 0 && result.missing.length <= s.maxMissingSegments) {
      log.warn('downloader', `缺失 ${result.missing.length} 个分片，继续合并（文件可能不完整）`);
    }

    // ---- 合并阶段（处理槽位互斥）----
    const release = await queue.acquireProcessing();
    try {
      // F-402 内存水位前置拦截（E-008）
      const sizeMb = task.bytes / (1024 * 1024);
      const memCheck = canMergeInBrowser(sizeMb, detectDeviceMemoryGb());
      if (!memCheck.ok) {
        setStage(task, 'failed', `文件较大（${formatBytes(task.bytes)}），浏览器内合并有崩溃风险，建议安装本地处理引擎`, 'memory');
        log.warn('downloader', `内存水位不足：峰值估算 ${Math.round(memCheck.peakMb)}MB > 水位 ${Math.round(memCheck.watermarkMb)}MB`, '已保留全部分片');
        return;
      }
      setStage(task, 'merging');
      // 合并输入：孤儿合并用已保留分片索引；正常流程用完整清单
      const mergeIndexes = orphanMerge
        ? [...task.completedSegmentIndexes].sort((a, b) => a - b)
        : segUrls.map((_, i) => i);
      const inputFormat =
        orphanMerge || !segUrls[0]
          ? await detectInputFormat(task.id, mergeIndexes)
          : /\.ts(\?|$)/i.test(segUrls[0]) || !segUrls[0]!.includes('m4s')
            ? ('ts' as const)
            : ('fmp4' as const);
      const mergeReq = {
        taskId: task.id,
        segmentIndexes: mergeIndexes,
        segmentUrls: segUrls,
        encryption: {
          method: !encUnknown && enc.method === 'aes128' ? ('aes128' as const) : ('none' as const),
          keyUrl: enc.keyUrl,
          ivHex: enc.ivHex,
          mediaSequenceBase: 0,
        },
        inputFormat,
        outputFilename: task.outputFilename!,
        expectedDurationSec: media.durationSec ?? undefined,
      };
      if (orphanMerge) {
        log.warn('downloader', '存量任务无加密信息，按未加密流合并（若源为 AES 加密流，产物将不可播，需重下）');
      }
      const r = await sendToOffscreen<MergeResult>('mergeHls', mergeReq);
      if (!r.ok || !r.blobUrl) {
        // E-009：保留分片，提供重新合并
        const { text, code } = mergeErrorText(r);
        setStage(task, 'failed', text, code);
        log.error('processor', `合并失败：${task.title}`, r.error);
        return;
      }
      await downloadBlobUrl(task, r.blobUrl, s);
      setStage(task, 'done');
      if (r.filename) task.outputFilename = r.filename; // 降级直存时扩展名可能变为 .ts
      task.bytes = r.sizeBytes ?? task.bytes;
      // 产物已落盘 → 分片缓存立即清理（磁盘成本归零；失败/暂停时仍保留以支持重试与续传）
      await deleteTaskSegments(task.id);
      const dbg = r.debug;
      log.info(
        'downloader',
        `合并完成：${task.outputFilename}`,
        `引擎=浏览器内 · ${formatBytes(task.bytes)} · 输入 ${dbg?.inputSegments ?? '?'} 片 → ${dbg?.outputFragments ?? '?'} fragment · tfdt 修补 ${dbg?.tfdtRepaired ?? 0} 处${dbg?.durationSecWritten ? ` · 时长写入 ${Math.round(dbg.durationSecWritten)}s` : ''}${dbg?.flattened ? ` · 已拍平常规 MP4（${dbg.samples ?? '?'} 样本，全播放器兼容）` : ' · 保持 fMP4（建议 VLC 播放）'}`
      );
      await notifyTaskDone(s, task.title);
      await afterComplete(task, s);
    } finally {
      release();
    }
  } finally {
    await removeRefererRule(hlsRefererDomains);
  }
  void signal;
}

function saveCompleted(task: DownloadTask, result: { completed: number[] }): void {
  const set = new Set([...task.completedSegmentIndexes, ...result.completed]);
  task.completedSegmentIndexes = [...set].sort((a, b) => a - b);
  task.completedSegments = task.completedSegmentIndexes.length;
}

// ---------- DASH 双轨管线（F-303）----------
async function runDash(task: DownloadTask, media: MediaItem, s: Settings, ctrl: { pause: boolean; cancel: boolean }, signal: { aborted: boolean }): Promise<void> {
  let videoTrack = media.tracks.find((t) => t.type === 'video');
  let audioTrack = media.tracks.find((t) => t.type === 'audio' && (task.audioTrackId ? t.trackId === task.audioTrackId : true));
  // 音轨可能还没被网络层捕获（用户点下载太早，B 站往往先缓冲视频）→ 等待并取最新条目重试。
  // 窗口 12s：实测 B 站音频轨通常在视频开始播放后数秒内出现，留足余量避免无声产物。
  if (videoTrack && !audioTrack) {
    for (let i = 0; i < 6 && !audioTrack; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const fresh = (await getTabItems(media.tabId)).find((x) => x.id === media.id);
      if (fresh) {
        const fa = fresh.tracks.find((t) => t.type === 'audio' && (task.audioTrackId ? t.trackId === task.audioTrackId : true));
        if (fa) {
          audioTrack = fa;
          videoTrack = fresh.tracks.find((t) => t.type === 'video') ?? videoTrack;
          media = { ...media, tracks: fresh.tracks };
          log.info('downloader', '音轨补齐，改为双轨合并', `等待 ${(i + 1) * 2}s 后捕获到音频轨`);
        }
      }
    }
    if (!audioTrack) {
      log.warn('downloader', '等待 12s 仍未捕获到音轨，本次产出无声视频', '建议：让视频多播几秒、等列表显示「DASH 双轨」再下载，或刷新页面后重试');
    }
  }
  if (!videoTrack) {
    setStage(task, 'failed', '未找到视频轨数据', 'no_video_track');
    return;
  }
  const vExt = videoTrack as typeof videoTrack & { segmentUrls?: string[]; initUrl?: string };
  const aExt = audioTrack as typeof audioTrack & { segmentUrls?: string[]; initUrl?: string } | undefined;

  const dashRefererDomains = refererDomains(media.siteDomain, [
    vExt.singleUrl,
    aExt?.singleUrl,
    vExt.initUrl,
    aExt?.initUrl,
    ...(vExt.segmentUrls ?? []).slice(0, 3),
    ...(aExt?.segmentUrls ?? []).slice(0, 3),
  ]);
  await ensureRefererRule(dashRefererDomains, media.pageUrl ?? `https://${media.siteDomain}/`);
  try {
    const fetchSeg = async (url: string) => {
      const res = await fetch(url, { credentials: 'include', signal: toAbortSignal(ctrl) });
      if (!res.ok) {
        const e = new Error(`http_${res.status}`) as FetchErr;
        e.statusCode = res.status;
        throw e;
      }
      return res.arrayBuffer();
    };

    // ---- 无清单 DASH（B 站等）：整条轨在一个 URL 里，全量 GET 后拆成 init + 片段 ----
    // 单文件轨道下载：一次请求拿全量（B 站 CDN 支持不带 Range 的整文件 GET），
    // 拆出 init 存 -1/-2，媒体片段存 0..n / 1_000_000+i，随后复用双轨合并。
    const prepSingle = async (
      track: typeof vExt | typeof aExt,
      initIndex: number,
      baseIndex: number
    ): Promise<number> => {
      if (!track || !('singleUrl' in track) || !track.singleUrl) return 0;
      const buf = await fetchSeg(track.singleUrl);
      const { init, fragments } = splitFmp4Parts(new Uint8Array(buf));
      if (init.length) await putSegment(task.id, initIndex, init.buffer as ArrayBuffer);
      for (let i = 0; i < fragments.length; i++) {
        await putSegment(task.id, baseIndex + i, fragments[i]!.buffer as ArrayBuffer);
      }
      log.info('downloader', `单文件轨道已就绪：${track.type}`, `init ${Math.round(init.byteLength / 1024)}KB + ${fragments.length} 片段 · ${formatBytes(buf.byteLength)}`);
      return fragments.length;
    };

    const vSingleCount = await prepSingle(vExt, -1, 0);
    const aSingleCount = await prepSingle(aExt, -2, 1_000_000);
    if (vSingleCount > 0) vExt.segmentUrls = new Array(vSingleCount).fill(vExt.singleUrl);
    if (aSingleCount > 0) aExt!.segmentUrls = new Array(aSingleCount).fill(aExt!.singleUrl);
    const prepared = vSingleCount > 0;

    // init 段：视频存 -1，音频存 -2（offscreen 约定）
    if (!prepared && vExt.initUrl) await putSegment(task.id, -1, await fetchSeg(vExt.initUrl));
    if (!prepared && aExt?.initUrl) await putSegment(task.id, -2, await fetchSeg(aExt.initUrl));

    const totalV = vExt.segmentUrls?.length ?? 0;
    const totalA = aExt?.segmentUrls?.length ?? 0;
    const vBytesWeight = () => Math.max(1, Math.round((totalV) / Math.max(totalV + totalA, 1) * 100));

    const vSnap = { completed: 0, bytes: 0 };
    const aSnap = { completed: 0, bytes: 0, failed: false };

    const vPool = new SegmentPool(s.segmentConcurrency, s.segmentTimeoutSec, s.maxSegmentRetry, async (i: number) => {
      if (ctrl.cancel) throw cancelErr();
      const buf = await fetchSeg(vExt.segmentUrls![i]!);
      await putSegment(task.id, i, buf);
      vSnap.completed++;
      vSnap.bytes += buf.byteLength;
      task.bytes = vSnap.bytes + aSnap.bytes;
      task.completedSegments = vSnap.completed + aSnap.completed;
      updateProgress(task);
      return 'ok' as const;
    });

    // 音轨可选：失败时进入「部分成功」（E-026）
    const aPool = aExt?.segmentUrls?.length
      ? new SegmentPool(Math.max(1, s.segmentConcurrency - 2), s.segmentTimeoutSec, s.maxSegmentRetry, async (i: number) => {
          if (ctrl.cancel) throw cancelErr();
          const buf = await fetchSeg(aExt.segmentUrls![i]!);
          await putSegment(task.id, 1_000_000 + i, buf);
          aSnap.completed++;
          aSnap.bytes += buf.byteLength;
          task.bytes = vSnap.bytes + aSnap.bytes;
          task.completedSegments = vSnap.completed + aSnap.completed;
          updateProgress(task);
          return 'ok' as const;
        })
      : null;

    // 单文件轨道：片段已落 IDB，跳过下载循环（进度按整轨处理）
    if (prepared) {
      vSnap.completed = vSingleCount;
      aSnap.completed = aSingleCount;
      task.completedSegments = vSingleCount + aSingleCount;
      task.totalSegments = vSingleCount + aSingleCount;
      updateProgress(task);
    }

    const vPromise = prepared
      ? Promise.resolve({ abortReason: null as null, completed: vSingleCount, missing: [] as number[] })
      : withPauseResume(
      () => vPool.run((vExt.segmentUrls ?? []).map((_, i) => i), { maxMissingSegments: s.maxMissingSegments, signal: { get aborted() { return ctrl.cancel || ctrl.pause; } } }),
      () => vSnap.completed,
      (n) => (vSnap.completed = n),
      ctrl,
      task
    );
    const aPromise = prepared && aSingleCount > 0
      ? Promise.resolve({ completed: [], failed: [], missing: [], aborted: [], maxInFlight: 0, throttled: 0 })
      : aPool
      ? withPauseResume(
          () => aPool.run((aExt!.segmentUrls ?? []).map((_, i) => i), { maxMissingSegments: s.maxMissingSegments, signal: { get aborted() { return ctrl.cancel || ctrl.pause; } } }),
          () => aSnap.completed,
          (n) => (aSnap.completed = n),
          ctrl,
          task
        ).catch(() => {
          aSnap.failed = true; // E-026：音轨失败保留视频轨
          return { completed: [], failed: [], missing: [], aborted: [], maxInFlight: 0, throttled: 0 };
        })
      : null;

    await Promise.all(aPromise ? [vPromise, aPromise] : [vPromise]);
    if (ctrl.cancel) {
      setStage(task, 'canceled');
      await deleteTaskSegments(task.id);
      return;
    }
    if (ctrl.pause) {
      setStage(task, 'paused');
      return;
    }
    if (aSnap.failed) {
      // E-026 部分成功：给两个出口（UI 呈现）
      task.audioMissing = true;
      task.partialSuccess = true;
      setStage(task, 'failed', '音频轨下载失败：可仅保存视频（无声音）或重试音频轨', 'audio_track_failed');
      log.warn('downloader', `音频轨失败：${task.title}`, '视频轨已保留');
      return;
    }
    // 合并
    const release = await queue.acquireProcessing();
    try {
      const sizeMb = task.bytes / (1024 * 1024);
      const memCheck = canMergeInBrowser(sizeMb, detectDeviceMemoryGb());
      if (!memCheck.ok) {
        setStage(task, 'failed', `文件较大，建议安装本地处理引擎完成双轨合并`, 'memory');
        return;
      }
      setStage(task, 'merging');
      const r = await sendToOffscreen<MergeResult>('mergeDash', {
        taskId: task.id,
        video: { initUrl: vExt.initUrl, segmentIndexes: (vExt.segmentUrls ?? []).map((_, i) => i) },
        audio: aExt?.segmentUrls?.length ? { initUrl: aExt.initUrl, segmentIndexes: (aExt.segmentUrls ?? []).map((_, i) => 1_000_000 + i) } : undefined,
        outputFilename: task.outputFilename!,
        expectedDurationSec: media.durationSec ?? undefined,
      });
      if (!r.ok || !r.blobUrl) {
        // F-303 规则 7：降级分轨导出 + 显式告知
        setStage(task, 'failed', `双轨合并失败（${r.error}），可分别导出视频轨与音频轨`, 'dual_merge_failed');
        return;
      }
      await downloadBlobUrl(task, r.blobUrl, s);
      setStage(task, 'done');
      // 产物已落盘 → 分片缓存立即清理（含 init 段与音轨分片）
      await deleteTaskSegments(task.id);
      const dbgD = r.debug;
      log.info('downloader', `合并完成：${task.outputFilename}`, `DASH 双轨 · ${formatBytes(task.bytes ?? 0)} · tfdt 修补 ${dbgD?.tfdtRepaired ?? 0} 处 · 分片缓存已清理`);
      await notifyTaskDone(s, task.title);
      await afterComplete(task, s);
    } finally {
      release();
    }
  } finally {
    await removeRefererRule(dashRefererDomains);
  }
  void signal;
}

// ---------- 暂停/恢复包装：暂停后等待 resume 信号再续跑 ----------
async function withPauseResume<T>(
  start: () => Promise<T>,
  getDone: () => number,
  setDone: (n: number) => void,
  ctrl: { pause: boolean; cancel: boolean },
  task: DownloadTask
): Promise<T> {
  const p = start();
  // 轮询监控暂停（分片粒度）
  while (true) {
    await sleep(500);
    setDone(await Promise.resolve(getDone()));
    if (ctrl.cancel || !ctrl.pause) break;
    // 已暂停：更新阶段并等待
    if (task.stage !== 'paused') {
      setStage(task, 'paused');
      schedulePersist();
    }
  }
  if (task.stage === 'paused') setStage(task, 'downloading');
  return p;
}

function cancelErr(): Error {
  return Object.assign(new Error('canceled'), { statusCode: undefined });
}

function toAbortSignal(ctrl: { pause: boolean; cancel: boolean }): AbortSignal | undefined {
  if (!ctrl.pause && !ctrl.cancel) return undefined;
  const ac = new AbortController();
  // 无法反向注入——用轮询的 signal.aborted 检查兜底
  return ac.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 转码编排（F-403：依赖本地引擎，无引擎按 E-014 引导）----------
async function afterComplete(task: DownloadTask, s: Settings): Promise<void> {
  if (!task.convertAfterDownload) return;
  const engine = getEngineStatus();
  if (engine.local !== 'ready') {
    log.warn('downloader', `转码需要本地处理引擎（当前 ${engine.local}）`, '仅合并无需安装');
    task.errorMessage = '下载完成，但转码需要本地处理引擎';
    schedulePersist();
    return;
  }
  // 本地引擎转换属独立桌面程序职责（F-403 编排占位，通道已就绪）
  setStage(task, 'transcoding');
  task.errorMessage = '转码指令已发出（本地引擎处理中）';
  schedulePersist();
  void s;
}

// ---------- 任务命令（F-208：暂停/取消/重试/移除）----------
export async function taskCommand(taskId: string, cmd: string): Promise<{ ok: boolean; error?: string }> {
  const task = tasks.get(taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  const ctrl = running.get(taskId);
  switch (cmd) {
    case 'pause':
      if (ctrl) ctrl.pause = true;
      else setStage(task, 'paused');
      break;
    case 'resume':
      if (task.stage === 'paused') {
        queue.acquire(() => runTask(task.id)).catch(() => {});
      }
      break;
    case 'cancel':
      if (ctrl) ctrl.cancel = true;
      setStage(task, 'canceled');
      await deleteTaskSegments(taskId);
      break;
    case 'retry':
      // F-305：跳过已完成分片，重试不从头开始
      if (ctrl) ctrl.cancel = true;
      await sleep(100);
      task.stage = 'queued';
      task.retryCount = (task.retryCount ?? 0) + 1;
      queue.acquire(() => runTask(task.id)).catch(() => {});
      break;
    case 'remove':
      if (ctrl) ctrl.cancel = true;
      await deleteTaskSegments(taskId);
      tasks.delete(taskId);
      break;
    case 'saveVideoOnly':
      // E-026 出口 1：仅保存视频轨
      task.audioTrackId = undefined;
      task.stage = 'queued';
      queue.acquire(() => runTask(task.id)).catch(() => {});
      break;
    case 'retryAudio':
      // E-026 出口 2：重试音频轨
      task.stage = 'queued';
      task.partialSuccess = false;
      queue.acquire(() => runTask(task.id)).catch(() => {});
      break;
    case 'remerge':
      // E-009：重新合并
      task.stage = 'queued';
      queue.acquire(() => runTask(task.id)).catch(() => {});
      break;
    case 'openFolder': {
      // 打开下载文件夹（平台差异降级：失败静默）
      try {
        const [dl] = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
        if (dl?.id != null) chrome.downloads.show(dl.id);
      } catch { /* ignore */ }
      break;
    }
    default:
      return { ok: false, error: `未知命令 ${cmd}` };
  }
  schedulePersist();
  return { ok: true };
}

export function listTasks(): DownloadTask[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** 抓取通道进度上报（offscreen 每 8MB 一次） */
export function applyFetchProgress(taskId: string, bytes: number, total?: number): void {
  const task = tasks.get(taskId);
  if (!task) return;
  task.bytes = bytes;
  if (total && total > 0) task.totalBytes = total;
  updateProgress(task);
}

export { sanitizeUrl, sanitizePath };
