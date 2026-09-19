// ============ Offscreen Document（F-402 浏览器内重封装合并 + 落盘）============
// SW 无 DOM/createObjectURL；本上下文负责：读 IDB 分片 → 重封装/合并 → Blob → objectURL → chrome.downloads
import muxjs from 'mux.js';
import { send } from '../shared/messages';
import type { MergeHlsRequest, MergeDashRequest, MergeResult } from '../shared/messages';
import { mergeFmp4Tracks, concatFmp4, validateMergedMp4, repairTfdtTimelines, finalizeDuration } from './mp4merge';
import { probeTsStreamTypes, isTransmuxable, codecLabel } from './tsprobe';
import { mimeForFilename } from '../shared/mime';
import { flattenFmp4 } from './mp4flatten';

// 简易日志转发（offscreen 无 Logger，用 console 供 SW 调试期观察）
function logFallback(ordered: { buf: ArrayBuffer }[]): void {
  console.warn(`[mediasniff] TS 转封装产出为空，降级原始拼接：${ordered.length} 片`, );
}

// ---------- IDB（与后台同库同 store）----------
const DB_NAME = 'ms-segments';
const STORE = 'seg';
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getAllSegments(taskId: string, indexes: number[]): Promise<Map<number, ArrayBuffer>> {
  const db = await openDb();
  const out = new Map<number, ArrayBuffer>();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    for (const i of indexes) {
      const key = `${taskId}#${String(i).padStart(8, '0')}`;
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result) out.set(i, req.result as ArrayBuffer);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return out;
}
async function deleteTaskSegments(taskId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(IDBKeyRange.bound(`${taskId}#`, `${taskId}#\uffff`));
    tx.oncomplete = () => resolve();
  });
}

// ---------- AES-128 逐片解密（F-304，offscreen 上下文有 crypto.subtle）----------
async function fetchKey(keyUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(keyUrl, { credentials: 'include' });
  if (!res.ok) throw new Error(`key_http_${res.status}`);
  return res.arrayBuffer();
}

function ivFromHexOrSequence(ivHex: string | undefined, mediaSequence: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(new ArrayBuffer(16));
  if (ivHex) {
    const bytes = ivHex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
    bytes.slice(0, 16).forEach((b, i) => (iv[i] = b));
  } else {
    // 缺省 IV = Media Sequence Number 的 16 字节大端
    const dv = new DataView(iv.buffer);
    dv.setUint32(12, mediaSequence);
  }
  return iv;
}

async function decryptAes128(data: ArrayBuffer, key: ArrayBuffer, iv: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
  try {
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  } catch {
    // 部分流填充不规范：去尾后按无填充重试一次（截断到最后一个完整块）
    const blocks = Math.floor(data.byteLength / 16) * 16;
    if (blocks > 0 && blocks !== data.byteLength) {
      return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data.slice(0, blocks));
    }
    throw new Error('decrypt_failed');
  }
}

// ---------- HLS 合并：TS → fMP4（mux.js 流式转封装）或 fMP4 直拼 ----------
async function mergeHls(req: MergeHlsRequest): Promise<MergeResult> {
  const { taskId, segmentIndexes, inputFormat, outputFilename, encryption } = req;
  const segs = await getAllSegments(taskId, segmentIndexes);
  if (segs.size === 0) return { ok: false, error: 'no_segment_data' };

  // 密钥获取（AES-128）
  let keyBuf: ArrayBuffer | null = null;
  let iv: Uint8Array<ArrayBuffer> | null = null;
  if (encryption.method === 'aes128' && encryption.keyUrl) {
    keyBuf = await fetchKey(encryption.keyUrl);
    iv = ivFromHexOrSequence(encryption.ivHex, encryption.mediaSequenceBase);
  }

  // 解密
  const decrypted = new Map<number, ArrayBuffer>();
  for (const [i, buf] of segs) {
    if (keyBuf && iv) {
      decrypted.set(i, await decryptAes128(buf, keyBuf, iv));
    } else {
      decrypted.set(i, buf);
    }
  }

  const ordered = segmentIndexes.filter((i) => decrypted.has(i)).map((i) => ({ i, buf: decrypted.get(i)! }));

  if (inputFormat === 'fmp4') {
    // fMP4：init + fragments 直拼（F-302 规则 3）
    const initBuf = req.initUrl ? undefined : undefined; // init 由后台以 index -1 存入
    void initBuf;
    const init = decrypted.get(-1);
    const parts = ordered.map((o) => new Uint8Array(o.buf));
    const joined = concatFmp4(init ? new Uint8Array(init) : new Uint8Array(0), parts);
    const flatF = tryFlatten(joined);
    const v = validateMergedMp4(flatF.data, 0);
    if (!v.ok) return { ok: false, error: `merge_validation_failed:${v.reason}` };
    const rf = await saveOutput(taskId, flatF.data, outputFilename);
    rf.debug = { inputSegments: parts.length, outputFragments: parts.length, tfdtRepaired: 0, flattened: flatF.flattened, samples: flatF.samples };
    return rf;
  }

  // TS → fMP4：mux.js 流式转封装（不重编码）。注意 Transmuxer 在 mp4 命名空间下
  // 先探测流类型：mux.js 仅支持 H.264/AAC，遇到 HEVC 等会静默产出空——必须前置诊断
  const firstSeg = ordered[0] ? new Uint8Array(ordered[0]!.buf) : null;
  if (firstSeg && firstSeg[0] === 0x47) {
    const probe = probeTsStreamTypes(firstSeg);
    if (probe.video !== 'unknown' && !isTransmuxable(probe)) {
      return {
        ok: false,
        error: `unsupported_codec:${codecLabel(probe)} — 浏览器内引擎仅支持 H.264/AAC 转封装，该流需本地引擎转码（分片已保留）`,
      };
    }
  }
  // 分批 flush：每 64 片产出规整 fragment（全量攒一个巨型 fragment 会导致播放器时长/解码异常）
  const transmuxer = new muxjs.mp4.Transmuxer();
  const state: { init: Uint8Array | null } = { init: null };
  const chunks: Uint8Array[] = [];
  transmuxer.on('data', (segment) => {
    if (!state.init && segment.initSegment.byteLength) state.init = new Uint8Array(segment.initSegment);
    chunks.push(new Uint8Array(segment.data));
  });
  const BATCH = 64;
  for (let i = 0; i < ordered.length; i++) {
    transmuxer.push(new Uint8Array(ordered[i]!.buf));
    if ((i + 1) % BATCH === 0) transmuxer.flush();
  }
  transmuxer.flush();
  const initSegment = state.init;
  if (!initSegment || chunks.length === 0) {
    // H.264 流但转封装产出为空（时间戳/流异常）：降级保存原始 TS 拼接，仍可用 VLC/IINA 播放
    logFallback(ordered);
    const total = ordered.reduce((n, o) => n + o.buf.byteLength, 0);
    const raw = new Uint8Array(total);
    let off = 0;
    for (const o of ordered) {
      raw.set(new Uint8Array(o.buf), off);
      off += o.buf.byteLength;
    }
    return saveOutput(taskId, raw, outputFilename.replace(/\.mp4$/, '.ts'));
  }
  const total = initSegment.byteLength + chunks.reduce((n, c) => n + c.byteLength, 0);
  let merged: Uint8Array = new Uint8Array(total);
  merged.set(initSegment!, 0);
  let off = initSegment.byteLength;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  // 终修：批间 tfdt 连续性修补 + 时长写实（0xFFFFFFFF 占位 → 清单实测时长）
  const repaired = repairTfdtTimelines(merged);
  merged = repaired.data;
  const expectedDur = req.expectedDurationSec;
  let durWritten: number | undefined;
  if (expectedDur && expectedDur > 0) {
    merged = finalizeDuration(merged, expectedDur);
    durWritten = expectedDur;
  }
  const flat = tryFlatten(merged);
  const v = validateMergedMp4(flat.data, 0); // 分批产出片段数与分片数不再一一对应，仅 ftyp + 时间轴校验
  if (!v.ok) return { ok: false, error: `merge_validation_failed:${v.reason}` };
  const r = await saveOutput(taskId, flat.data, outputFilename);
  r.debug = {
    inputSegments: ordered.length,
    outputFragments: chunks.length,
    tfdtRepaired: repaired.repaired,
    durationSecWritten: durWritten,
    flattened: flat.flattened,
    samples: flat.samples,
  };
  return r;
}

/** 拍平为常规 MP4（QuickTime/AVFoundation 兼容）；失败则回退 fMP4（Chrome/VLC 仍可播） */
function tryFlatten(data: Uint8Array): { data: Uint8Array; flattened: boolean; samples?: number } {
  try {
    const r = flattenFmp4(data);
    return { data: r.data, flattened: true, samples: r.stats.samples };
  } catch (e) {
    console.warn('[mediasniff] flatten 失败，保留 fMP4 输出:', String(e));
    return { data, flattened: false };
  }
}

// ---------- DASH 双轨合并（F-303）----------
async function mergeDash(req: MergeDashRequest): Promise<MergeResult> {
  const { taskId, video, audio, outputFilename } = req;
  const videoInit = await getAllSegments(taskId, [-1]);
  const videoInitBuf = videoInit.get(-1);
  if (!videoInitBuf) return { ok: false, error: 'missing_video_init' };
  const vSegs = await getAllSegments(taskId, video.segmentIndexes);
  const videoTrack = {
    init: new Uint8Array(videoInitBuf),
    fragments: video.segmentIndexes.filter((i) => vSegs.has(i)).map((i) => new Uint8Array(vSegs.get(i)!)),
  };
  let audioTrack;
  if (audio && audio.segmentIndexes.length) {
    const audioInit = await getAllSegments(taskId, [-2]);
    const aSegs = await getAllSegments(taskId, audio.segmentIndexes);
    const audioInitBuf = audioInit.get(-2);
    audioTrack = {
      init: new Uint8Array(audioInitBuf ?? videoInitBuf),
      fragments: audio.segmentIndexes.filter((i) => aSegs.has(i)).map((i) => new Uint8Array(aSegs.get(i)!)),
    };
  }
  try {
    const merged = mergeFmp4Tracks(videoTrack, audioTrack);
    const repaired = repairTfdtTimelines(merged.data);
    const dur = (req as MergeDashRequest).expectedDurationSec;
    const durFixed = dur && dur > 0 ? finalizeDuration(repaired.data, dur) : repaired.data;
    const flatD = tryFlatten(durFixed);
    const v = validateMergedMp4(flatD.data, 0);
    if (!v.ok) return { ok: false, error: `merge_validation_failed:${v.reason}` };
    const rd = await saveOutput(taskId, flatD.data, outputFilename);
    rd.debug = { inputSegments: videoTrack.fragments.length + (audioTrack?.fragments.length ?? 0), outputFragments: 0, tfdtRepaired: repaired.repaired, flattened: flatD.flattened, samples: flatD.samples };
    return rd;
  } catch (e) {
    return { ok: false, error: `dual_track_merge_failed:${String(e)}` };
  }
}

// ---------- 落盘准备：Blob → objectURL（offscreen 无 chrome.downloads 权限，下载由 SW 执行）----------
// 关键：Blob 必须带正确 MIME —— 无 type 时 Chrome 判定为 text/plain 并自动把文件名改成 .txt
function blobToOutput(blob: Blob, filename: string): MergeResult {
  const url = URL.createObjectURL(blob);
  return { ok: true, blobUrl: url, filename, sizeBytes: blob.size };
}

async function saveOutput(taskId: string, data: Uint8Array, filename: string): Promise<MergeResult> {
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: mimeForFilename(filename) });
  void taskId;
  return blobToOutput(blob, filename);
}

// ---------- 扩展内抓取落盘（F-301 通道 B）----------
// blob URL 下载不受服务端 Content-Disposition 影响，文件名完全可控；
// 流式读取 + Blob 分片累积（浏览器磁盘背板），避免大文件堆内存膨胀；按 8MB 节流上报进度。
/**
 * 纯音频 MP4 的品牌修正：把 ftyp 的 major/compatible brands 中的视频族品牌换成 M4A 族。
 *
 * 为什么需要：blob 下载时 Chrome **不看 blob 的 MIME，而是嗅探内容**，MP4 容器的判据就是 ftyp 品牌；
 * 品牌含 mp42/isom 等视频族时会被判成 video/mp4，进而把落盘扩展名强制改成 .mp4
 * （即使文件名给的是 .m4a）。改成 M4A 族后 Chrome 判为音频 → 保留 .m4a，
 * 且走扩展 API 通道（rel="download" 路径无法指定子目录，API 可以）。ffmpeg 输出纯音频 MP4 时同样标 M4A。
 */
const VIDEO_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'msdh', 'msix'];

function preferAudioBrand(head: Uint8Array): boolean {
  if (head.byteLength < 16) return false;
  const fourcc = (o: number) => String.fromCharCode(head[o]!, head[o + 1]!, head[o + 2]!, head[o + 3]!);
  if (fourcc(4) !== 'ftyp') return false;
  const boxSize = (head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!;
  const minorStart = 12;
  if (boxSize < 16 || boxSize > head.byteLength) {
    // ftyp 跨越当前分片：至少修正 major_brand
    if (fourcc(8) !== 'M4A ') {
      head[8] = 0x4d; head[9] = 0x34; head[10] = 0x41; head[11] = 0x20;
      return true;
    }
    return false;
  }
  let changed = false;
  const setM4A = (o: number) => {
    head[o] = 0x4d; head[o + 1] = 0x34; head[o + 2] = 0x41; head[o + 3] = 0x20; // 'M4A '
    changed = true;
  };
  if (VIDEO_BRANDS.includes(fourcc(8))) setM4A(8);
  void minorStart;
  for (let o = 16; o + 4 <= boxSize; o += 4) {
    if (VIDEO_BRANDS.includes(fourcc(o))) setM4A(o);
  }
  return changed;
}

async function saveViaFetch(url: string, filename: string, taskId?: string, mimeOverride?: string): Promise<MergeResult> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  const total = Number(res.headers.get('content-length') ?? 0);
  const respType = (res.headers.get('content-type') ?? '').split(';')[0] ?? '';
  // MIME 决策以「输出档案」为准（mimeOverride），不盲从服务端：
  // 实测 QQ音乐等站点的 m4a 直链返回 video/mp4，若照抄会导致 Chrome 把落盘扩展名改回 .mp4
  // （Chrome 依据 blob 的 MIME 规范化扩展名；audio/mp4 才能保住 .m4a）
  const mime = mimeOverride || (/^(video|audio)\//.test(respType) ? respType : mimeForFilename(filename));
  const reader = res.body?.getReader();
  if (!reader) {
    const blob = new Blob([await res.arrayBuffer()], { type: mime });
    return blobToOutput(blob, filename);
  }
  const parts: Blob[] = [];
  let received = 0;
  let lastReport = 0;
  let brandFixed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      // 音频档案：首个分片内含 ftyp → 就地改成 M4A 族品牌，避免 Chrome 按内容判成 video/mp4 后改扩展名
      if (!brandFixed && mime.startsWith('audio/')) {
        preferAudioBrand(value);
        brandFixed = true;
      }
      parts.push(new Blob([value]));
      received += value.byteLength;
      if (taskId && received - lastReport >= 8 * 1024 * 1024) {
        lastReport = received;
        void chrome.runtime
          .sendMessage({ target: 'sw', type: 'fetchProgress', payload: { taskId, bytes: received, total } })
          .catch(() => {});
      }
    }
  }
  const blob = new Blob(parts, { type: mime });
  return blobToOutput(blob, filename);
}

// ---------- 音频转 MP3（浏览器内转码）----------
// 背景：M4A 属 MP4 容器，Chrome 落盘时按内容嗅探（ftyp 品牌）判成 video/mp4 并强制改扩展名
// →「嗅探到音频却存成 .mp4」。MP3 是裸音频流，无容器歧义，转 MP3 可彻底规避，且兼容性最广。
// 管线：fetch → 浏览器原生解码（AudioContext.decodeAudioData，省去手工解析 esds/AAC 配置）
//      → lamejs 编码 MP3 → blob(audio/mpeg) 交回 SW 走 downloads API（支持子目录）。
// 代价：AAC→MP3 有损二次编码；编码器随包内置（lame.min.js ≈150KB，MV3 禁止远端代码）。
declare const lamejs: {
  Mp3Encoder: new (
    channels: number,
    sampleRate: number,
    kbps: number
  ) => {
    encodeBuffer: (left: Int16Array, right?: Int16Array) => Int8Array;
    flush: () => Int8Array;
  };
};

const MP3_BITRATE_KBPS = 192;
const MP3_BLOCK = 1152; // MP3 帧样本数

function floatToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = Math.round(src[i]! * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** 抓取 + 转 MP3，返回 blob（MIME audio/mpeg）与头部字节（便于校验产物确为 MP3） */
async function saveAudioAsMp3(url: string, taskId?: string): Promise<MergeResult & { headHex?: string }> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  const srcBlob = await res.blob();
  const total = srcBlob.size;

  let audioBuf: AudioBuffer;
  try {
    const ac = new AudioContext();
    audioBuf = await ac.decodeAudioData(await srcBlob.arrayBuffer());
    await ac.close();
  } catch (e) {
    return { ok: false, error: `decode_failed:${String(e)}` };
  }

  const channels = Math.min(2, audioBuf.numberOfChannels);
  const sampleRate = audioBuf.sampleRate;
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, MP3_BITRATE_KBPS);
  const left = audioBuf.getChannelData(0);
  const right = channels > 1 ? audioBuf.getChannelData(1) : null;
  const totalSamples = left.length;
  const parts: Uint8Array[] = [];
  let encoded = 0;
  let lastReport = 0;

  for (let off = 0; off < totalSamples; off += MP3_BLOCK) {
    const l = floatToInt16(left.subarray(off, off + MP3_BLOCK));
    const r = right ? floatToInt16(right.subarray(off, off + MP3_BLOCK)) : undefined;
    const chunk = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (chunk.length) parts.push(new Uint8Array(chunk));
    encoded = off + MP3_BLOCK;
    if (taskId && encoded - lastReport >= sampleRate * 20) {
      lastReport = encoded;
      void chrome.runtime
        .sendMessage({
          target: 'sw',
          type: 'fetchProgress',
          payload: { taskId, bytes: Math.round((encoded / totalSamples) * total), total },
        })
        .catch(() => {});
    }
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(new Uint8Array(tail));

  const blob = new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const headHex = Array.from(head)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const out = blobToOutput(blob, 'audio.mp3');
  return { ...out, headHex };
}

// ---------- 消息入口 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type as string) {
        case 'offscreenPing':
          sendResponse({ ok: true });
          break;
        case 'mergeHls':
          sendResponse(await mergeHls(msg.payload as MergeHlsRequest));
          break;
        case 'mergeDash':
          sendResponse(await mergeDash(msg.payload as MergeDashRequest));
          break;
        case 'saveData': {
          const { url, filename, taskId, mime, encode } = msg.payload as {
            url: string;
            filename: string;
            taskId?: string;
            mime?: string;
            encode?: 'mp3';
          };
          if (encode === 'mp3') {
            const r = await saveAudioAsMp3(url, taskId);
            console.log('[mediasniff] mp3 转码：', r.ok ? `${r.sizeBytes ?? 0} 字节 head=${r.headHex ?? ''}` : r.error);
            sendResponse(r);
          } else {
            sendResponse(await saveViaFetch(url, filename, taskId, mime));
          }
          break;
        }
        case 'revokeUrl': {
          const { url } = msg.payload as { url: string };
          try { URL.revokeObjectURL(url); } catch { /* ignore */ }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown:${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) } satisfies MergeResult);
    }
  })();
  return true; // async response
});

void send;
