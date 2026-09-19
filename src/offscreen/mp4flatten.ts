// ============ fMP4 → 常规 MP4 拍平（flatten）============
// 背景：mux.js 产出的是 fragment MP4（适合 MSE 流式播放），而 macOS QuickTime/AVFoundation
// 对本地 fMP4 文件支持很差（黑屏、时长错误）。拍平 = 把分片里的样本信息重建回 moov 的
// stbl 样本表（stts/ctts/stsc/stsz/stco/stss），移除 mvex，产出任何播放器都认的普通 MP4。
// 语义仍是「容器重封装」：样本字节原样搬运，不重新编码。
import { walkBoxes, childBoxes, readVersionFlags, readTfhd, readTfdt, readMdhd, readMvhdDuration, writeMvhdDuration, patchTkhdDuration, patchMdhdDuration, type BoxHeader } from './mp4box-lite';
import { writeBox, writeFullBox, u32, u32Array, concatBytes } from './mp4write';

interface SampleRef {
  offset: number; // 原文件中的绝对偏移
  size: number;
  duration: number;
  ctsOffset: number;
  sync: boolean;
}

interface TrackSamples {
  trackId: number;
  samples: SampleRef[];
}

interface TrakInfo {
  trackId: number;
  timescale: number;
  trakBytes: Uint8Array;
  stbl: BoxHeader;
}

interface TrexDefaults {
  duration: number;
  size: number;
  flags: number;
}

export interface FlattenStats {
  tracks: number;
  samples: number;
  fragments: number;
}

export interface FlattenResult {
  data: Uint8Array;
  stats: FlattenStats;
}

interface TrunInfo {
  sampleCount: number;
  dataOffset?: number;
  firstSampleFlags?: number;
  entries: { duration?: number; size?: number; flags?: number; ctsOffset?: number }[];
  version: number;
}

function readTrun(buf: Uint8Array, start: number, size: number): TrunInfo {
  const { version, flags, body } = readVersionFlags(buf, start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = body;
  const sampleCount = dv.getUint32(p);
  p += 4;
  let dataOffset: number | undefined;
  if (flags & 0x000001) {
    dataOffset = dv.getInt32(p);
    p += 4;
  }
  let firstSampleFlags: number | undefined;
  if (flags & 0x000004) {
    firstSampleFlags = dv.getUint32(p);
    p += 4;
  }
  const entries: TrunInfo['entries'] = [];
  for (let i = 0; i < sampleCount && p + 4 <= start + size; i++) {
    const e: TrunInfo['entries'][number] = {};
    if (flags & 0x000100) {
      e.duration = dv.getUint32(p);
      p += 4;
    }
    if (flags & 0x000200) {
      e.size = dv.getUint32(p);
      p += 4;
    }
    if (flags & 0x000400) {
      e.flags = dv.getUint32(p);
      p += 4;
    }
    if (flags & 0x000800) {
      e.ctsOffset = version > 0 ? dv.getInt32(p) : dv.getUint32(p);
      p += 4;
    }
    entries.push(e);
  }
  return { sampleCount, dataOffset, firstSampleFlags, entries, version };
}

function readTrexDefaults(buf: Uint8Array, moov: BoxHeader): Map<number, TrexDefaults> {
  const out = new Map<number, TrexDefaults>();
  const mvex = childBoxes(buf, moov).find((b) => b.type === 'mvex');
  if (!mvex) return out;
  for (const trex of childBoxes(buf, mvex).filter((b) => b.type === 'trex')) {
    const { body } = readVersionFlags(buf, trex.start);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    out.set(dv.getUint32(body), {
      duration: dv.getUint32(body + 8),
      size: dv.getUint32(body + 12),
      flags: dv.getUint32(body + 16),
    });
  }
  return out;
}

interface Parsed {
  raw: Uint8Array;
  ftyp: Uint8Array;
  moovBox: BoxHeader;
  mvhdBytes: Uint8Array;
  otherBytes: Uint8Array[];
  traks: TrakInfo[];
  stblBytes: Map<number, Uint8Array>;
  byTrack: Map<number, TrackSamples>;
  fragments: number;
}

/** 第一遍解析：收集轨道与样本（偏移为原文件绝对偏移） */
function parse(data: Uint8Array): Parsed {
  const top = walkBoxes(data);
  const ftypBox = top.find((b) => b.type === 'ftyp');
  const moovBox = top.find((b) => b.type === 'moov');
  if (!ftypBox || !moovBox) throw new Error('flatten_missing_ftyp_or_moov');

  const traks: TrakInfo[] = [];
  const usedIds = new Set<number>();
  for (const trak of childBoxes(data, moovBox).filter((b) => b.type === 'trak')) {
    const tkhd = childBoxes(data, trak).find((b) => b.type === 'tkhd');
    const mdia = childBoxes(data, trak).find((b) => b.type === 'mdia');
    const mdhd = mdia ? childBoxes(data, mdia).find((b) => b.type === 'mdhd') : undefined;
    const minf = mdia ? childBoxes(data, mdia).find((b) => b.type === 'minf') : undefined;
    const stbl = minf ? childBoxes(data, minf).find((b) => b.type === 'stbl') : undefined;
    if (!tkhd || !mdhd || !stbl) continue;
    const vf = readVersionFlags(data, tkhd.start);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let trackId = dv.getUint32(vf.body + (vf.version === 1 ? 16 : 8));
    // 防御：若 moov 内出现重复 track_ID（上游重编号失败时会发生），按出现顺序强制重编号，
    // 否则两条轨会被当成一条 → 样本表互相覆盖、音频丢失、时长串台（真实事故）。
    if (usedIds.has(trackId)) {
      let next = 1;
      while (usedIds.has(next)) next++;
      trackId = next;
    }
    usedIds.add(trackId);
    const { timescale } = readMdhd(data, mdhd);
    traks.push({ trackId, timescale: timescale || 1000, trakBytes: data.slice(trak.start, trak.start + trak.size), stbl });
  }
  if (!traks.length) throw new Error('flatten_no_traks');

  const trex = readTrexDefaults(data, moovBox);
  const byTrack = new Map<number, TrackSamples>();
  for (const t of traks) byTrack.set(t.trackId, { trackId: t.trackId, samples: [] });

  let fragments = 0;
  for (const b of top) {
    if (b.type !== 'moof') continue;
    fragments++;
    for (const traf of childBoxes(data, b).filter((x) => x.type === 'traf')) {
      let trackId = 0;
      let tfhdFlags = 0;
      let baseDataOffset: number | undefined;
      let defDur: number | undefined;
      let defSize: number | undefined;
      let defFlags: number | undefined;
      const truns: { start: number; size: number }[] = [];
      for (const leaf of childBoxes(data, traf)) {
        if (leaf.type === 'tfhd') {
          trackId = readTfhd(data, leaf).trackId;
          const vf = readVersionFlags(data, leaf.start);
          tfhdFlags = vf.flags;
          const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
          let p = vf.body + 4;
          if (vf.flags & 0x000001) {
            baseDataOffset = Number(dv.getBigUint64(p));
            p += 8;
          }
          if (vf.flags & 0x000002) p += 4;
          if (vf.flags & 0x000008) {
            defDur = dv.getUint32(p);
            p += 4;
          }
          if (vf.flags & 0x000010) {
            defSize = dv.getUint32(p);
            p += 4;
          }
          if (vf.flags & 0x000020) {
            defFlags = dv.getUint32(p);
            p += 4;
          }
        } else if (leaf.type === 'trun') {
          truns.push({ start: leaf.start, size: leaf.size });
        }
      }
      const track = byTrack.get(trackId);
      if (!track) continue;
      const d = trex.get(trackId);
      const dDur = defDur ?? d?.duration ?? 0;
      const dSize = defSize ?? d?.size ?? 0;
      const dFlags = defFlags ?? d?.flags ?? 0;

      let nextDataOffset: number | undefined;
      for (const t of truns) {
        const trun = readTrun(data, t.start, t.size);
        let cursor: number;
        if (trun.dataOffset != null) {
          const base = tfhdFlags & 0x000001 && baseDataOffset != null ? baseDataOffset : b.start;
          cursor = base + trun.dataOffset;
        } else if (nextDataOffset != null) {
          cursor = nextDataOffset;
        } else {
          cursor = b.start + b.size;
        }
        for (let s = 0; s < trun.sampleCount; s++) {
          const e = trun.entries[s] ?? {};
          const size = e.size ?? dSize;
          if (!size) throw new Error(`flatten_bad_sample_size_track${trackId}`);
          const flags = e.flags ?? (s === 0 && trun.firstSampleFlags != null ? trun.firstSampleFlags : dFlags);
          const sync = (flags & 0x00010000) === 0;
          track.samples.push({ offset: cursor, size, duration: e.duration ?? dDur, ctsOffset: e.ctsOffset ?? 0, sync });
          cursor += size;
        }
        nextDataOffset = cursor;
      }
    }
  }

  const mvhdBox = childBoxes(data, moovBox).find((b) => b.type === 'mvhd');
  const mvhdBytes = mvhdBox ? data.slice(mvhdBox.start, mvhdBox.start + mvhdBox.size) : new Uint8Array(0);
  const otherBytes = childBoxes(data, moovBox)
    .filter((b) => !['trak', 'mvex', 'mvhd'].includes(b.type))
    .map((b) => data.slice(b.start, b.start + b.size));

  const stblBytes = new Map<number, Uint8Array>();
  for (const t of traks) stblBytes.set(t.trackId, data.slice(t.stbl.start, t.stbl.start + t.stbl.size));
  return { raw: data, ftyp: data.slice(ftypBox.start, ftypBox.start + ftypBox.size), moovBox, mvhdBytes, otherBytes, traks, stblBytes, byTrack, fragments };
}

/** 第二遍：按目标 mdat 起点构建输出 */
function build(parsed: Parsed, moovSizeHint: number): { data: Uint8Array; moovSize: number; stats: FlattenStats } {
  const { ftyp, moovBox, mvhdBytes, otherBytes, traks, byTrack, fragments } = parsed;

  // 样本按原文件顺序搬运
  const all: SampleRef[] = [];
  for (const t of traks) all.push(...byTrack.get(t.trackId)!.samples);
  all.sort((a, b) => a.offset - b.offset);
  void moovBox;

  const mdatPayload = new Uint8Array(all.reduce((n, s) => n + s.size, 0));
  const newOff = new Map<SampleRef, number>();
  let off = 0;
  for (const s of all) {
    mdatPayload.set(parsed.raw.subarray(s.offset, s.offset + s.size), off);
    newOff.set(s, off);
    off += s.size;
  }

  const mdatHeaderSize = 8;
  const base = ftyp.length + moovSizeHint + mdatHeaderSize;

  const trackDurations = new Map<number, number>();
  const rebuiltTraks = traks.map((t) => {
    const samples = byTrack.get(t.trackId)!.samples;
    // 连续样本段 → chunk 表
    const chunks: { newOffset: number; count: number }[] = [];
    let curStart: number | null = null;
    let curCount = 0;
    let prevEnd = -1;
    for (const s of samples) {
      const no = newOff.get(s)!;
      if (curStart == null || no !== prevEnd) {
        if (curStart != null && curCount > 0) chunks.push({ newOffset: curStart, count: curCount });
        curStart = no;
        curCount = 1;
      } else curCount++;
      prevEnd = no + s.size;
    }
    if (curStart != null && curCount > 0) chunks.push({ newOffset: curStart, count: curCount });

    const built = buildStbl(parsed.stblBytes.get(t.trackId)!, samples, chunks, base);
    trackDurations.set(t.trackId, built.totalDuration);
    return rebuildTrakWithStbl(t.trakBytes, built.stbl);
  });

  let newMoov = writeBox('moov', [mvhdBytes, ...rebuiltTraks, ...otherBytes]);
  // 时长写实：DASH 轨道的 init 里 mvhd/mdhd duration 常为 0（时长由 sidx 声明），
  // 拍平成常规 MP4 后播放器只认 moov 时长 → 必须用样本累计时长回填，否则显示 0 且不播放。
  newMoov = applyDurations(newMoov, trackDurations);
  const mdat = writeBox('mdat', [mdatPayload]);
  const out = concatBytes([ftyp, newMoov, mdat]);
  const stats: FlattenStats = {
    tracks: traks.length,
    samples: all.length,
    fragments,
  };
  return { data: out, moovSize: newMoov.length, stats };
}

/** 生成新 stbl：沿用 stsd，重建 stts/ctts/stsc/stsz/stco/stss */
function buildStbl(stblBytes: Uint8Array, samples: SampleRef[], chunks: { newOffset: number; count: number }[], mdatBase: number): { stbl: Uint8Array; totalDuration: number } {
  const stblSelf = walkBoxes(stblBytes).find((b) => b.type === 'stbl');
  if (!stblSelf) throw new Error('flatten_stbl_missing');
  const stsd = childBoxes(stblBytes, stblSelf).find((b) => b.type === 'stsd');
  const stsdBytes = stsd ? stblBytes.slice(stsd.start, stsd.start + stsd.size) : writeFullBox('stsd', 0, 0, [u32(0)]);

  // stts：时长游程
  const sttsEntries: { count: number; delta: number }[] = [];
  for (const s of samples) {
    const last = sttsEntries[sttsEntries.length - 1];
    if (last && last.delta === s.duration) last.count++;
    else sttsEntries.push({ count: 1, delta: s.duration });
  }
  const sttsPayload = u32Array(sttsEntries.flatMap((e) => [e.count, e.delta]));
  const stts = writeFullBox('stts', 0, 0, [u32(sttsEntries.length), sttsPayload]);

  // ctts：仅当存在非零合成偏移
  const hasCts = samples.some((s) => s.ctsOffset !== 0);
  const ctts = hasCts
    ? (() => {
        const entries: { count: number; offset: number }[] = [];
        for (const s of samples) {
          const last = entries[entries.length - 1];
          if (last && last.offset === s.ctsOffset) last.count++;
          else entries.push({ count: 1, offset: s.ctsOffset });
        }
        return writeFullBox('ctts', 0, 0, [u32(entries.length), u32Array(entries.flatMap((e) => [e.count, e.offset]))]);
      })()
    : null;

  // stsc
  const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
  chunks.forEach((c, i) => {
    const last = stscEntries[stscEntries.length - 1];
    if (last && last.samplesPerChunk === c.count) return;
    stscEntries.push({ firstChunk: i + 1, samplesPerChunk: c.count });
  });
  const stsc = writeFullBox('stsc', 0, 0, [u32(stscEntries.length), u32Array(stscEntries.flatMap((e) => [e.firstChunk, e.samplesPerChunk, 1]))]);

  const stsz = writeFullBox('stsz', 0, 0, [u32(0), u32(samples.length), u32Array(samples.map((s) => s.size))]);
  const stco = writeFullBox('stco', 0, 0, [u32(chunks.length), u32Array(chunks.map((c) => mdatBase + c.newOffset))]);

  const syncIdx = samples.map((s, i) => (s.sync ? i + 1 : 0)).filter((n) => n > 0);
  const stss = syncIdx.length > 0 && syncIdx.length < samples.length
    ? writeFullBox('stss', 0, 0, [u32(syncIdx.length), u32Array(syncIdx)])
    : null;

  const totalDuration = samples.reduce((n, x) => n + x.duration, 0);
  return { stbl: writeBox('stbl', [stsdBytes, stts, ...(ctts ? [ctts] : []), stsc, stsz, stco, ...(stss ? [stss] : [])]), totalDuration };
}

/**
 * 用各轨样本累计时长回填 mvhd / tkhd / mdhd（unit: track timescale）。
 * 修复真实事故：B 站 DASH 轨道 init 时长为 0 → 合并产物「时长 0 秒、黑屏」。
 */
function applyDurations(moov: Uint8Array, trackDurations: Map<number, number>): Uint8Array {
  const moovBox = walkBoxes(moov).find((b) => b.type === 'moov');
  if (!moovBox) return moov;
  const { timescale: movieTs } = readMvhdDuration(moov, moovBox);
  const movieTsSafe = movieTs > 0 ? movieTs : 1000;
  let maxMovieDuration = 0;
  for (const trak of childBoxes(moov, moovBox).filter((b) => b.type === 'trak')) {
    const tkhd = childBoxes(moov, trak).find((b) => b.type === 'tkhd');
    const mdia = childBoxes(moov, trak).find((b) => b.type === 'mdia');
    if (!tkhd || !mdia) continue;
    const vf = readVersionFlags(moov, tkhd.start);
    const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    const trackId = dv.getUint32(vf.body + (vf.version === 1 ? 16 : 8));
    const trackDur = trackDurations.get(trackId);
    if (!trackDur) continue;
    const mdhd = childBoxes(moov, mdia).find((b) => b.type === 'mdhd');
    const trackTs = mdhd ? readMdhd(moov, mdhd).timescale : 0;
    if (mdhd && trackTs > 0) patchMdhdDuration(moov, mdhd, trackDur);
    const movieDuration = trackTs > 0 ? Math.round((trackDur / trackTs) * movieTsSafe) : trackDur;
    patchTkhdDuration(moov, tkhd, movieDuration);
    maxMovieDuration = Math.max(maxMovieDuration, movieDuration);
  }
  if (maxMovieDuration > 0) {
    const patched = writeMvhdDuration(moov, moovBox, maxMovieDuration);
    return patched;
  }
  return moov;
}

/** 用新 stbl 替换 trak → mdia → minf → stbl，保留其它 box 原样 */
function rebuildTrakWithStbl(trakBytes: Uint8Array, newStbl: Uint8Array): Uint8Array {
  const trakBox = walkBoxes(trakBytes).find((b) => b.type === 'trak');
  if (!trakBox) throw new Error('flatten_trak_missing');
  const rebuilt = childBoxes(trakBytes, trakBox)
    // 丢弃 edts/elst：DASH init 里的 edit list 时长常为 0（时长由 sidx 表达），
    // 拍平成常规 MP4 后 stbl 才是权威时间轴，保留 elst 会让播放器把时长裁成 0（真实事故：Chrome 只认 44ms）
    .filter((b) => b.type !== 'edts')
    .map((b) => {
    if (b.type !== 'mdia') return trakBytes.slice(b.start, b.start + b.size);
    const mdiaChildren = childBoxes(trakBytes, b).map((c) => {
      if (c.type !== 'minf') return trakBytes.slice(c.start, c.start + c.size);
      const minfChildren = childBoxes(trakBytes, c).map((m) => (m.type === 'stbl' ? newStbl : trakBytes.slice(m.start, m.start + m.size)));
      return writeBox('minf', minfChildren);
    });
    return writeBox('mdia', mdiaChildren);
  });
  return writeBox('trak', rebuilt);
}

/**
 * 主入口：fMP4 → 常规 MP4。
 * stco 依赖 moov 最终尺寸，故两遍构建：第一遍取尺寸，第二遍按准确 base 重建。
 */
export function flattenFmp4(data: Uint8Array): FlattenResult {
  const parsed = parse(data);
  const probe = build(parsed, 0);
  const result = build(parsed, probe.moovSize);
  return { data: result.data, stats: result.stats };
}
