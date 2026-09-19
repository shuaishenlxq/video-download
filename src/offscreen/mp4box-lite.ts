// ============ 极简 ISO-BMFF(box) 解析/重写工具（F-402 / F-303 fMP4 双轨合并的基座）============
// 只解析合并所需的最小 box 集合：moov/mvhd/trak/tkhd/mdhd/hdlr/trex/mvex/mfhd/tfhd/tfdt/trun/ftyp。

export interface BoxHeader {
  type: string;
  start: number;
  size: number; // 含 header
}

export function walkBoxes(buf: Uint8Array, start = 0, end = buf.length): BoxHeader[] {
  const out: BoxHeader[] = [];
  let p = start;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4]!, buf[p + 5]!, buf[p + 6]!, buf[p + 7]!);
    let headerSize = 8;
    if (size === 1) {
      // largesize
      size = Number(dv.getBigUint64(p + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - p; // 到文件尾
    }
    if (size < headerSize || p + size > end) break;
    out.push({ type, start: p, size });
    p += size;
  }
  return out;
}

export function findBox(buf: Uint8Array, path: string[]): BoxHeader | undefined {
  let scope = { start: 0, end: buf.length };
  let found: BoxHeader | undefined;
  for (const seg of path) {
    found = undefined;
    for (const b of walkBoxes(buf, scope.start, scope.end)) {
      if (b.type === seg) {
        found = b;
        break;
      }
    }
    if (!found) return undefined;
    scope = { start: found.start + 8, end: found.start + found.size };
  }
  return found;
}

export function childBoxes(buf: Uint8Array, container: BoxHeader): BoxHeader[] {
  return walkBoxes(buf, container.start + 8, container.start + container.size);
}

// ---------- 字段读取 ----------
export function readVersionFlags(buf: Uint8Array, boxStart: number): { version: number; flags: number; body: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const vf = dv.getUint32(boxStart + 8);
  return { version: vf >>> 24, flags: vf & 0xffffff, body: boxStart + 12 };
}

/** mdhd/tkhd 的 timescale 与 duration（v0/v1 兼容） */
export function readMdhd(buf: Uint8Array, mdhd: BoxHeader): { timescale: number; duration: number } {
  const { version, body } = readVersionFlags(buf, mdhd.start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (version === 1) {
    return { timescale: dv.getUint32(body + 16), duration: Number(dv.getBigUint64(body + 20)) };
  }
  return { timescale: dv.getUint32(body + 8), duration: dv.getUint32(body + 12) };
}

export function readTfhd(buf: Uint8Array, tfhd: BoxHeader): { trackId: number; baseDataOffset?: bigint; sampleDuration?: number } {
  const { flags, body } = readVersionFlags(buf, tfhd.start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = body;
  const trackId = dv.getUint32(p);
  p += 4;
  let baseDataOffset: bigint | undefined;
  if (flags & 0x000001) {
    baseDataOffset = dv.getBigUint64(p);
    p += 8;
  }
  let sampleDuration: number | undefined;
  if (flags & 0x000008) {
    sampleDuration = dv.getUint32(p);
    p += 4;
  }
  return { trackId, baseDataOffset, sampleDuration };
}

export function readTfdt(buf: Uint8Array, tfdt: BoxHeader): { version: number; baseMediaDecodeTime: number } {
  const { version, body } = readVersionFlags(buf, tfdt.start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { version, baseMediaDecodeTime: version === 1 ? Number(dv.getBigUint64(body)) : dv.getUint32(body) };
}

export function readMfhd(buf: Uint8Array, mfhd: BoxHeader): number {
  const { body } = readVersionFlags(buf, mfhd.start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getUint32(body);
}

/** trak 类型判定：读 hdlr handler_type */
export function trakType(buf: Uint8Array, trak: BoxHeader): 'video' | 'audio' | 'other' {
  for (const mdia of childBoxes(buf, trak).filter((b) => b.type === 'mdia')) {
    const hdlr = childBoxes(buf, mdia).find((b) => b.type === 'hdlr');
    if (!hdlr) continue;
    // hdlr 布局：size+type(8) + version/flags(4) + pre_defined(4) + handler_type(4) + reserved(12) + name
    const tPos = hdlr.start + 16;
    const t = String.fromCharCode(buf[tPos]!, buf[tPos + 1]!, buf[tPos + 2]!, buf[tPos + 3]!);
    if (t === 'vide') return 'video';
    if (t === 'soun') return 'audio';
  }
  return 'other';
}

/** moov 时长读取/改写（mvhd） */
export function readMvhdDuration(buf: Uint8Array, moov: BoxHeader): { timescale: number; duration: number } {
  const mvhd = childBoxes(buf, moov).find((b) => b.type === 'mvhd')!;
  const { version, body } = readVersionFlags(buf, mvhd.start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (version === 1) return { timescale: dv.getUint32(body + 16), duration: Number(dv.getBigUint64(body + 20)) };
  return { timescale: dv.getUint32(body + 8), duration: dv.getUint32(body + 12) };
}

export function writeMvhdDuration(buf: Uint8Array, moov: BoxHeader, duration: number): Uint8Array {
  const mvhd = childBoxes(buf, moov).find((b) => b.type === 'mvhd')!;
  const out = new Uint8Array(buf);
  const { version, body } = readVersionFlags(buf, mvhd.start);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (version === 1) dv.setBigUint64(body + 20, BigInt(duration));
  else dv.setUint32(body + 12, Math.min(duration, 0xffffffff));
  return out;
}

/** tkhd duration 偏移：v0 = body+16(u32)，v1 = body+32(u64) */
export function patchTkhdDuration(buf: Uint8Array, tkhd: BoxHeader, duration: number): void {
  const { version, body } = readVersionFlags(buf, tkhd.start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (version === 1) dv.setBigUint64(body + 32, BigInt(duration));
  else dv.setUint32(body + 16, Math.min(duration, 0xffffffff));
}

/** mdhd duration 偏移：v0 = body+16(u32)，v1 = body+24(u64)（与 readMdhd 对应） */
export function patchMdhdDuration(buf: Uint8Array, mdhd: BoxHeader, duration: number): void {
  const { version, body } = readVersionFlags(buf, mdhd.start);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (version === 1) dv.setBigUint64(body + 20, BigInt(duration));
  else dv.setUint32(body + 12, Math.min(duration, 0xffffffff));
}

/** 就地重写 tfdt.baseMediaDecodeTime（v0 u32 / v1 u64），返回新 buffer（复制后写） */
export function patchTfdtTime(buf: Uint8Array, tfdt: BoxHeader, newTime: number): Uint8Array {
  const out = new Uint8Array(buf);
  const { version, body } = readVersionFlags(out, tfdt.start);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (version === 1) dv.setBigUint64(body, BigInt(newTime));
  else dv.setUint32(body, newTime);
  return out;
}

/** 重写 box 内指定偏移的 uint32（用于 mfhd sequence / tfhd track_id / trex track_id） */
export function patchUint32(buf: Uint8Array, boxStart: number, fieldOffsetFromBody: number, value: number): Uint8Array {
  const out = new Uint8Array(buf);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(boxStart + 12 + fieldOffsetFromBody, value);
  return out;
}

/** 校验 ftyp 存在（F-302 规则 7 输出校验） */
export function hasFtyp(buf: Uint8Array): boolean {
  return walkBoxes(buf, 0, Math.min(buf.length, 64)).some((b) => b.type === 'ftyp');
}
