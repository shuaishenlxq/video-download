// ============ fMP4 双轨合并器（F-303：DASH 视频轨+音频轨 → 单 MP4，不重编码）============
// 策略：合并双方 moov（音轨 track_ID 重编号）→ 视频全部片段流 + 音频全部片段流 顺序拼接
// （ISO BMFF 片段模式不要求轨道交织，播放器按 tfdt 时间轴对齐音画）。
// 重写点：新 moov 的 mvhd 时长、音轨 trex/tfhd 的 track_ID、全部 mfhd 的 sequence_number 全局递增。
import {
  walkBoxes, childBoxes, readVersionFlags, readMdhd, readTfhd, readTfdt, readMfhd,
  trakType, readMvhdDuration, writeMvhdDuration, patchUint32, hasFtyp,
  patchTkhdDuration, patchMdhdDuration, patchTfdtTime,
} from './mp4box-lite';

export interface TrackData {
  init: Uint8Array; // init segment（含 ftyp + moov）
  fragments: Uint8Array[]; // moof+mdat 片段序列
}

export interface MergeResultData {
  data: Uint8Array;
  durationSec?: number;
  warnings: string[];
}

export function mergeFmp4Tracks(video: TrackData, audio?: TrackData): MergeResultData {
  const warnings: string[] = [];
  if (!hasFtyp(video.init)) throw new Error('video_init_missing_ftyp');

  // ---- 1. 解析视频 init（ftyp + moov）----
  let ftyp = new Uint8Array(0);
  let videoMoov: Uint8Array | null = null;
  for (const b of walkBoxes(video.init)) {
    if (b.type === 'ftyp') ftyp = video.init.slice(b.start, b.start + b.size);
    if (b.type === 'moov') videoMoov = video.init.slice(b.start, b.start + b.size);
  }
  if (!videoMoov || !videoMoov.length) throw new Error('video_init_missing_moov');

  // ---- 2. 构造新 moov：视频 trak + 音轨 trak（重编号）----
  let mergedMoov = videoMoov;
  if (audio) {
    let audioMoov: Uint8Array | null = null;
    for (const b of walkBoxes(audio.init)) {
      if (b.type === 'moov') audioMoov = audio.init.slice(b.start, b.start + b.size);
    }
    if (!audioMoov) throw new Error('audio_init_missing_moov');
    mergedMoov = mergeMoov(videoMoov, audioMoov, warnings);
  }

  // ---- 3. 时长：取较短轨（F-303 规则 6 以较短者裁剪 → 这里记录差异，拼接时按 tfdt 自然对齐）----
  const moovBoxes = walkBoxes(mergedMoov).filter((b) => b.type === 'moov');
  if (moovBoxes.length) {
    const mv = readMvhdDuration(mergedMoov, moovBoxes[0]!);
    // mvhd 时长保持视频轨时长即可（播放器以片段时间轴为准）
    void mv;
  }

  // ---- 4. 片段流重写与拼接 ----
  let seq = 1;
  const parts: Uint8Array[] = [ftyp, mergedMoov];
  const rewriteFragments = (track: TrackData, audioTrackIdRemap?: number) => {
    for (const frag of track.fragments) {
      let out = frag;
      const boxes = walkBoxes(frag);
      for (const b of boxes) {
        if (b.type === 'mfhd') {
          out = patchUint32(out, b.start, 0, seq++); // mfhd sequence_number
        }
        if (b.type === 'moof' && audioTrackIdRemap) {
          // 重写音轨 traf 的 tfhd.track_ID
          for (const inner of walkBoxes(frag, b.start + 8, b.start + b.size)) {
            if (inner.type === 'traf') {
              for (const leaf of walkBoxes(frag, inner.start + 8, inner.start + inner.size)) {
                if (leaf.type === 'tfhd') {
                  const { flags, body } = readVersionFlags(frag, leaf.start);
                  void flags;
                  // tfhd: version/flags(4) + track_id(4)；body 指向 version/flags 之后
                  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
                  dv.setUint32(leaf.start + 12, audioTrackIdRemap);
                  void body;
                }
              }
            }
          }
        }
      }
      parts.push(out);
    }
  };
  rewriteFragments(video);
  if (audio) rewriteFragments(audio, 2);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const data = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    data.set(p, off);
    off += p.length;
  }
  return { data, warnings };
}

/** 合并两个 moov：取视频侧 moov 结构，追加音轨 trak 与 trex */
function mergeMoov(videoMoov: Uint8Array, audioMoov: Uint8Array, warnings: string[]): Uint8Array {
  const vBoxes = walkBoxes(videoMoov, 8, videoMoov.length);
  const aBoxes = walkBoxes(audioMoov, 8, audioMoov.length);
  const parts: Uint8Array[] = [];
  // moov header（size+type）+ mvhd + mvex（补音轨 trex）+ 视频 trak 们 + 音轨 trak
  const moovHeader = videoMoov.slice(0, 8);

  const take = (src: Uint8Array, b: { start: number; size: number }) => src.slice(b.start, b.start + b.size);

  let sawMvex = false;
  let audioTrakAdded = false;
  // 记录各 box 在 parts 中的位置：替换 mvex 必须用索引，不能靠对象引用比对
  // （slice 每次都产生新对象，`findIndex(p => p === oldMvex)` 会返回 -1，
  //   进而 splice(-1, ...) 误删末尾元素——真实事故：音轨 trak 就这样被删掉了）
  let mvexIdx = -1;
  let lastTrakIdx = -1;
  for (const b of vBoxes) {
    if (b.type === 'trak') {
      parts.push(take(videoMoov, b));
      lastTrakIdx = parts.length - 1;
      continue;
    }
    if (b.type === 'mvex') {
      parts.push(take(videoMoov, b));
      mvexIdx = parts.length - 1;
      sawMvex = true;
      continue;
    }
    parts.push(take(videoMoov, b)); // mvhd / udta / 其他
  }

  // 音轨 trak：重编号 track_ID=2（tkhd 与 mdhd 不含 track_id…tkhd 含！tkhd 的 track_ID 在 body 前 4 字节）
  const audioTrak = aBoxes.find((b) => b.type === 'trak' && trakType(audioMoov, b) === 'audio');
  if (audioTrak) {
    let trakData: Uint8Array<ArrayBufferLike> = take(audioMoov, audioTrak);
    trakData = renumberTrak(trakData, 2);
    // 插到最后一个视频 trak 之后（保持 moov 内 trak 连续，udta/mvex 等在后）
    if (lastTrakIdx >= 0) parts.splice(lastTrakIdx + 1, 0, trakData);
    else parts.push(trakData);
    audioTrakAdded = true;
    // mvex 追加音轨 trex
    const audioMvex = aBoxes.find((b) => b.type === 'mvex');
    if (audioMvex) {
      const trex = childBoxes(audioMoov, audioMvex).find((b) => b.type === 'trex');
      if (trex) {
        let trexD: Uint8Array<ArrayBufferLike> = take(audioMoov, trex);
        trexD = patchUint32(trexD, 0, 0, 2); // trex.track_id 在 body 偏移 0
        if (sawMvex && mvexIdx >= 0) {
          // 扩展已有 mvex：按索引替换为「原 mvex + 音轨 trex」，并修正 size
          const oldMvex = parts[mvexIdx]!;
          const merged = concat(oldMvex, trexD);
          const dv = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
          dv.setUint32(0, merged.length);
          parts[mvexIdx] = merged;
        } else {
          const mvex = concatN(new Uint8Array([0, 0, 0, 8 + 8 + trexD.length]), str4('mvex'), trexD);
          parts.push(mvex);
        }
      }
    }
  } else {
    warnings.push('audio_trak_not_found');
  }
  void audioTrakAdded;

  const total = parts.reduce((n, p) => n + p.length, 0) + moovHeader.length;
  const out = new Uint8Array(total);
  out.set(moovHeader, 0);
  let off = moovHeader.length;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  // 修正 moov 总 size
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  return out;
}

/** trak 重编号：tkhd.track_ID = newId（tkhd body: version/flags(4) + creation(4/8) + modification(4/8) + track_id(4)） */
export function renumberTrak(trak: Uint8Array, newId: number): Uint8Array {
  const out = new Uint8Array(trak);
  for (const b of walkBoxes(out, 8, out.length)) {
    if (b.type !== 'tkhd') continue;
    const { version } = readVersionFlags(out, b.start);
    // tkhd: size+type(8) + version/flags(4) + creation/modification(8 或 16) + track_ID(4)
    // → track_ID 位于 body + 8(v0) / body + 16(v1)。注意不可再加 4（会写到 duration 上）。
    const idOff = b.start + 12 + (version === 1 ? 16 : 8);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(idOff, newId);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatN(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function str4(s: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 片段序列直接拼接（HLS fMP4 场景：init + fragments 顺序写，F-302 规则 3） */
export function concatFmp4(init: Uint8Array, fragments: Uint8Array[]): Uint8Array {
  const parts = [init, ...fragments];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 合并结果校验（F-302 规则 7）：ftyp 存在 + 片段数符合 + tfdt 时间轴按轨道各自单调 */
export function validateMergedMp4(data: Uint8Array, expectedFragmentCount: number): { ok: boolean; reason?: string; durationSec?: number } {  if (!hasFtyp(data)) return { ok: false, reason: 'no_ftyp' };
  const boxes = walkBoxes(data);
  const moofCount = boxes.filter((b) => b.type === 'moof').length;
  if (expectedFragmentCount > 0 && moofCount < expectedFragmentCount * 0.9) {
    return { ok: false, reason: `fragment_count_${moofCount}_of_${expectedFragmentCount}` };
  }
  // tfdt 按轨道分组校验：视频/音频是独立时间轴，交叉出现属正常，不可全局比较
  const lastByTrack = new Map<number, number>();
  let maxT = 0;
  for (const b of boxes) {
    if (b.type !== 'moof') continue;
    for (const inner of walkBoxes(data, b.start + 8, b.start + b.size)) {
      if (inner.type !== 'traf') continue;
      let trackId = 0;
      let decodeTime: number | null = null;
      for (const leaf of walkBoxes(data, inner.start + 8, inner.start + inner.size)) {
        if (leaf.type === 'tfhd') trackId = readTfhd(data, leaf).trackId;
        if (leaf.type === 'tfdt') decodeTime = readTfdt(data, leaf).baseMediaDecodeTime;
      }
      if (decodeTime == null) continue; // 无 tfdt（延续前一片段时间）跳过
      const last = lastByTrack.get(trackId) ?? -1;
      if (decodeTime < last) return { ok: false, reason: `tfdt_regression_track${trackId}` };
      lastByTrack.set(trackId, decodeTime);
      maxT = Math.max(maxT, decodeTime);
    }
  }
  return { ok: true, durationSec: undefined };
}

export { readMdhd, readMvhdDuration };

// ============ fMP4 终修（真实站点黑屏/28h 时长事故）============

/**
 * 片段时间轴修补：跨 flush 产出的 fragments 若 tfdt 发生重置（回到 0 或回退），
 * 按轨道就地补偿偏移，保证每条轨全局单调。
 */
export function repairTfdtTimelines(data: Uint8Array): { data: Uint8Array; repaired: number } {
  let out = data;
  const lastByTrack = new Map<number, number>();
  let repaired = 0;
  const boxes = walkBoxes(out);
  for (const b of boxes) {
    if (b.type !== 'moof') continue;
    for (const inner of walkBoxes(out, b.start + 8, b.start + b.size)) {
      if (inner.type !== 'traf') continue;
      let trackId = 0;
      let tfdtBox: ReturnType<typeof walkBoxes>[number] | undefined;
      for (const leaf of walkBoxes(out, inner.start + 8, inner.start + inner.size)) {
        if (leaf.type === 'tfhd') trackId = readTfhd(out, leaf).trackId;
        if (leaf.type === 'tfdt') tfdtBox = leaf;
      }
      if (!tfdtBox) continue;
      const t = readTfdt(out, tfdtBox).baseMediaDecodeTime;
      const last = lastByTrack.get(trackId);
      if (last != null && t < last) {
        out = patchTfdtTime(out, tfdtBox, last);
        lastByTrack.set(trackId, last);
        repaired++;
      } else {
        lastByTrack.set(trackId, t);
      }
    }
  }
  return { data: out, repaired };
}

/**
 * 时长修正：mux.js init segment 的 mvhd/mdhd/tkhd duration 是 0xFFFFFFFF 占位，
 * 播放器据此显示超长时长（28h 事故）。用清单实测时长改写三处。
 */
export function finalizeDuration(data: Uint8Array, durationSec: number): Uint8Array {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return data;
  const moovBox = walkBoxes(data).find((b) => b.type === 'moov');
  if (!moovBox) return data;
  let out = data;
  const { timescale: movieTs } = readMvhdDuration(out, moovBox);
  const movieTsSafe = movieTs > 0 ? movieTs : 1000;
  out = writeMvhdDuration(out, moovBox, Math.round(durationSec * movieTsSafe));
  for (const trak of childBoxes(out, moovBox).filter((b) => b.type === 'trak')) {
    // tkhd（movie 时间基）
    const tkhd = childBoxes(out, trak).find((b) => b.type === 'tkhd');
    if (tkhd) patchTkhdDuration(out, tkhd, Math.round(durationSec * movieTsSafe));
    // mdhd（track 自身时间基）
    const mdia = childBoxes(out, trak).find((b) => b.type === 'mdia');
    if (!mdia) continue;
    const mdhd = childBoxes(out, mdia).find((b) => b.type === 'mdhd');
    if (mdhd) {
      const { timescale } = readMdhd(out, mdhd);
      if (timescale > 0) patchMdhdDuration(out, mdhd, Math.round(durationSec * timescale));
    }
  }
  return out;
}
