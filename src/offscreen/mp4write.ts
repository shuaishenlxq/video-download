// ============ ISO-BMFF box 写入工具（fMP4 拍平需要重建 moov）============
// 注意：不接受可变参数展开——样本数量可达十万级，spread 会爆栈。
// 统一使用数组入参 + 预分配缓冲。

export function u8(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}
export function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v);
  return b;
}
export function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
export function u64(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v));
  return b;
}

/** 高效生成 u32 数组载荷（无展开，无中间数组） */
export function u32Array(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i]! >>> 0);
  return out;
}

export function type4(t: string): Uint8Array {
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) b[i] = t.charCodeAt(i);
  return b;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 通用 box：size(4) + type(4) + payload */
export function writeBox(type: string, parts: Uint8Array[]): Uint8Array {
  const body = concatBytes(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, 8 + body.length);
  out.set(type4(type), 4);
  out.set(body, 8);
  return out;
}

/** full box：size + type + version(1) + flags(3) + payload */
export function writeFullBox(type: string, version: number, flags: number, parts: Uint8Array[]): Uint8Array {
  return writeBox(type, [u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...parts]);
}
