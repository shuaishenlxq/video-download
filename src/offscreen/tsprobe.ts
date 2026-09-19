// ============ MPEG-TS 流类型探测（合并前的编码诊断）============
// mux.js 仅支持 H.264/AAC；HEVC 等流会静默不产出。此处解析 PAT/PMT 识别真实编码，
// 把「静默产出空」变成「明确的不支持报告」。

export interface TsProbeResult {
  streamTypes: number[]; // PMT 中声明的 stream_type 值
  video: 'h264' | 'hevc' | 'mpeg2' | 'unknown';
  audio: 'aac' | 'ac3' | 'mp3' | 'unknown';
}

const TS_PACKET = 188;

/** 常见 stream_type（ISO 13818-1 / 23008-2） */
export const STREAM_TYPE = {
  H264: 0x1b,
  HEVC: 0x24,
  HEVC_SUBSET: 0x25,
  MPEG2_VIDEO: 0x02,
  AAC_ADTS: 0x0f,
  AAC_LATM: 0x11,
  AC3: 0x81,
  MP3: 0x03,
} as const;

export function probeTsStreamTypes(data: Uint8Array, maxPackets = 400): TsProbeResult {
  const types = new Set<number>();
  // 1. 对齐 sync byte
  let start = data.findIndex((b) => b === 0x47);
  if (start < 0 || start + TS_PACKET > data.length) {
    return { streamTypes: [], video: 'unknown', audio: 'unknown' };
  }
  const pmtPids = new Set<number>();
  let packets = 0;
  let p = start;

  while (p + TS_PACKET <= data.length && packets < maxPackets) {
    if (data[p] !== 0x47) {
      p += 1; // 重新对齐
      continue;
    }
    packets++;
    const pid = ((data[p + 1]! & 0x1f) << 8) | data[p + 2]!;
    const pusi = (data[p + 1]! & 0x40) !== 0;
    const afc = (data[p + 3]! & 0x30) >> 4;
    let payload = p + 4;
    if (afc & 0x02) {
      const afLen = data[p + 4]!;
      payload += 1 + afLen;
    }
    if (afc & 0x01 && pusi && payload < p + TS_PACKET) {
      const pointer = data[payload]!;
      payload += 1 + pointer;
    }
    if (payload >= p + TS_PACKET) {
      p += TS_PACKET;
      continue;
    }

    if (pid === 0x0000 && data[payload] === 0x00) {
      // PAT：program_number(16) 后 3 字节中低 13 位为 program_map_PID
      const secLen = ((data[payload + 1]! & 0x0f) << 8) | data[payload + 2]!;
      const end = payload + 3 + secLen - 4; // 去掉 CRC
      let q = payload + 8;
      while (q + 2 <= end) {
        const programNumber = (data[q]! << 8) | data[q + 1]!;
        const mapPid = ((data[q + 2]! & 0x1f) << 8) | data[q + 3]!;
        if (programNumber !== 0 && mapPid > 0) pmtPids.add(mapPid);
        q += 4;
      }
    } else if (pmtPids.has(pid) && data[payload] === 0x02) {
      // PMT：program_info_length 后的 ES loop
      const secLen = ((data[payload + 1]! & 0x0f) << 8) | data[payload + 2]!;
      const end = payload + 3 + secLen - 4;
      const pcrPidAndInfo = payload + 8;
      const infoLen = ((data[pcrPidAndInfo + 2]! & 0x0f) << 8) | data[pcrPidAndInfo + 3]!;
      let q = pcrPidAndInfo + 4 + infoLen;
      while (q + 5 <= end) {
        types.add(data[q]!);
        const esInfoLen = ((data[q + 3]! & 0x0f) << 8) | data[q + 4]!;
        q += 5 + esInfoLen;
      }
    }
    p += TS_PACKET;
  }

  const arr = [...types];
  const video = arr.includes(STREAM_TYPE.H264)
    ? 'h264'
    : arr.includes(STREAM_TYPE.HEVC) || arr.includes(STREAM_TYPE.HEVC_SUBSET)
      ? 'hevc'
      : arr.includes(STREAM_TYPE.MPEG2_VIDEO)
        ? 'mpeg2'
        : 'unknown';
  const audio = arr.includes(STREAM_TYPE.AAC_ADTS) || arr.includes(STREAM_TYPE.AAC_LATM)
    ? 'aac'
    : arr.includes(STREAM_TYPE.AC3)
      ? 'ac3'
      : arr.includes(STREAM_TYPE.MP3)
        ? 'mp3'
        : 'unknown';
  return { streamTypes: arr, video, audio };
}

/** 是否可被浏览器内引擎（mux.js）转封装 */
export function isTransmuxable(p: TsProbeResult): boolean {
  return p.video === 'h264' && (p.audio === 'aac' || p.audio === 'unknown');
}

export function codecLabel(p: TsProbeResult): string {
  const v = { h264: 'H.264', hevc: 'HEVC (H.265)', mpeg2: 'MPEG-2', unknown: '未知' }[p.video];
  const a = { aac: 'AAC', ac3: 'AC3', mp3: 'MP3', unknown: '未知' }[p.audio];
  return `${v} + ${a}`;
}
