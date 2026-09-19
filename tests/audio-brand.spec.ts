// 品牌修正单元测试：纯音频 MP4 的 ftyp 品牌必须被改成 M4A 族（Chrome 内容嗅探据此判音频）
import { describe, it, expect } from 'vitest';

// 从 offscreen 源码逻辑等价复刻（该函数非导出：以行为契约测试其规则）
const VIDEO_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'msdh', 'msix'];
function preferAudioBrand(head: Uint8Array): boolean {
  if (head.byteLength < 16) return false;
  const fourcc = (o: number) => String.fromCharCode(head[o]!, head[o + 1]!, head[o + 2]!, head[o + 3]!);
  if (fourcc(4) !== 'ftyp') return false;
  const boxSize = (head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!;
  if (boxSize < 16 || boxSize > head.byteLength) {
    if (fourcc(8) !== 'M4A ') {
      head[8] = 0x4d; head[9] = 0x34; head[10] = 0x41; head[11] = 0x20;
      return true;
    }
    return false;
  }
  let changed = false;
  const setM4A = (o: number) => {
    head[o] = 0x4d; head[o + 1] = 0x34; head[o + 2] = 0x41; head[o + 3] = 0x20;
    changed = true;
  };
  if (VIDEO_BRANDS.includes(fourcc(8))) setM4A(8);
  for (let o = 16; o + 4 <= boxSize; o += 4) {
    if (VIDEO_BRANDS.includes(fourcc(o))) setM4A(o);
  }
  return changed;
}

function makeFtyp(major: string, compat: string[], minor = 0): Uint8Array {
  const size = 16 + compat.length * 4;
  const b = new Uint8Array(size);
  new DataView(b.buffer).setUint32(0, size);
  b.set(new TextEncoder().encode('ftyp'), 4);
  b.set(new TextEncoder().encode(major), 8);
  new DataView(b.buffer).setUint32(12, minor);
  compat.forEach((c, i) => b.set(new TextEncoder().encode(c), 16 + i * 4));
  return b;
}

describe('preferAudioBrand：纯音频 MP4 的品牌修正', () => {
  it('mp42 主品牌 + 视频族兼容品牌 → 全部改为 M4A', () => {
    const head = makeFtyp('mp42', ['mp42', 'isom', 'avc1']);
    const changed = preferAudioBrand(head);
    const dec = (o: number) => String.fromCharCode(head[o]!, head[o + 1]!, head[o + 2]!, head[o + 3]!);
    expect(changed).toBe(true);
    expect(dec(8)).toBe('M4A ');
    expect(dec(16)).toBe('M4A ');
    expect(dec(20)).toBe('M4A ');
    expect(dec(24)).toBe('M4A ');
  });

  it('已是 M4A 品牌 → 不重复改写', () => {
    const head = makeFtyp('M4A ', ['M4A ']);
    expect(preferAudioBrand(head)).toBe(false);
  });

  it('非 ftyp 数据（如 TS 流）→ 原样不动', () => {
    const head = new Uint8Array([0x47, 0x40, 0x11, 0x10, 0x00, 0x42, 0xf0, 0x25, 1, 2, 3, 4, 5, 6, 7, 8]);
    const copy = Uint8Array.from(head);
    expect(preferAudioBrand(head)).toBe(false);
    expect(Array.from(head)).toEqual(Array.from(copy));
  });

  it('ftyp 跨分片（尺寸超出当前头）→ 至少修正主品牌', () => {
    const head = makeFtyp('mp42', ['mp42']).slice(0, 16); // 截断，boxSize 指向更长
    new DataView(head.buffer).setUint32(0, 24); // 声称 24 字节，但只有 16
    expect(preferAudioBrand(head)).toBe(true);
    expect(String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!)).toBe('M4A ');
  });
});
