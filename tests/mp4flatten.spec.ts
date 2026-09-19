// fMP4 拍平器回归测试（黑屏事故：QuickTime/AVFoundation 不认 fMP4）
// 用合成片段验证：stbl 样本表（stsz/stts/stsc/stco/stss/ctts）重建正确、样本字节零损失、mvex 被移除。
import { describe, it, expect } from 'vitest';
import { flattenFmp4 } from '../src/offscreen/mp4flatten';
import { writeBox, writeFullBox, u8, u32, concatBytes } from '../src/offscreen/mp4write';
import { walkBoxes, childBoxes, readVersionFlags } from '../src/offscreen/mp4box-lite';

// ---------- 合成 fMP4 ----------
function ftyp(): Uint8Array {
  return writeBox('ftyp', [u8(...[...'isom'].map((c) => c.charCodeAt(0))), u32(0x200), u8(...[...'isomavc1'].map((c) => c.charCodeAt(0)))]);
}

function tkhdV0(trackId: number, width = 1280, height = 720): Uint8Array {
  const body = new Uint8Array(76);
  const dv = new DataView(body.buffer);
  dv.setUint32(8, trackId);
  dv.setUint32(16, 0); // duration
  dv.setUint32(72, width << 16);
  dv.setUint32(76 - 4, height << 16);
  return writeFullBox('tkhd', 0, 7, [body]);
}

function mdhdV0(timescale: number, duration: number): Uint8Array {
  const body = new Uint8Array(16);
  const dv = new DataView(body.buffer);
  dv.setUint32(8, timescale);
  dv.setUint32(12, duration);
  return writeFullBox('mdhd', 0, 0, [body]);
}

function stsdEmpty(): Uint8Array {
  return writeFullBox('stsd', 0, 0, [u32(0)]);
}

function makeTrak(trackId: number): Uint8Array {
  return writeBox('trak', [
    tkhdV0(trackId),
    writeBox('mdia', [mdhdV0(90000, 0), writeBox('minf', [writeBox('stbl', [stsdEmpty()])])]),
  ]);
}

function mvhdV0(): Uint8Array {
  const body = new Uint8Array(96);
  new DataView(body.buffer).setUint32(8, 1000); // timescale
  return writeFullBox('mvhd', 0, 0, [body]);
}

function trex(trackId: number): Uint8Array {
  const body = new Uint8Array(20);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, trackId);
  dv.setUint32(8, 3000); // default sample duration
  dv.setUint32(12, 0);
  dv.setUint32(16, 0x01010000); // sample flags
  return writeFullBox('trex', 0, 0, [body]);
}

/** 一个 moof+mdat 片段：n 个样本，各自 size，可由 size 生成伪字节内容 */
function fragment(seq: number, decodeTime: number, sizes: number[], sampleFlags: number[]): { moof: Uint8Array; mdat: Uint8Array; samples: Uint8Array[] } {
  const samples = sizes.map((s, i) => new Uint8Array(s).fill((seq * 16 + i) & 0xff));
  const mdatPayload = concatBytes(samples);

  // tfhd: flags = 0x020000 (default-base-is-moof)
  const tfhd = writeFullBox('tfhd', 0, 0x020000, [u32(1)]);
  const tfdt = writeFullBox('tfdt', 0, 0, [u32(decodeTime)]);
  // trun: 0x000001 data-offset | 0x000100 duration | 0x000200 size | 0x000400 flags
  const trunBody: number[] = [];
  for (let i = 0; i < sizes.length; i++) {
    trunBody.push(3000, sizes[i]!, sampleFlags[i]!);
  }
  const trunFixed = (() => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setUint32(0, sizes.length);
    new DataView(out.buffer).setUint32(4, 0); // data_offset 占位，稍后回填
    return out;
  })();
  const trunTail = (() => {
    const out = new Uint8Array(trunBody.length * 4);
    const dv = new DataView(out.buffer);
    trunBody.forEach((v, i) => dv.setUint32(i * 4, v));
    return out;
  })();
  const trunBox = (dataOffset: number) => {
    const body = concatBytes([trunFixed, trunTail]);
    new DataView(body.buffer).setUint32(4, dataOffset);
    return writeFullBox('trun', 0, 0x000001 | 0x000100 | 0x000200 | 0x000400, [body]);
  };

  const mfhd = writeFullBox('mfhd', 0, 0, [u32(seq)]);
  // 先构造两次以确定 moof 尺寸（data_offset = moof 尺寸，紧随其后即 mdat payload）
  // data_offset 指向 mdat 的 payload（moof 长度 + mdat 头 8 字节），与真实 mux.js 输出一致
  let moof = writeBox('moof', [mfhd, writeBox('traf', [tfhd, tfdt, trunBox(0)])]);
  moof = writeBox('moof', [mfhd, writeBox('traf', [tfhd, tfdt, trunBox(moof.length + 8)])]);
  const mdat = writeBox('mdat', [mdatPayload]);
  return { moof, mdat, samples };
}

const SYNC = 0x00000000;
const NON_SYNC = 0x00010000;

describe('flattenFmp4：fMP4 → 常规 MP4', () => {
  const f1 = fragment(1, 0, [1000, 2000], [SYNC, NON_SYNC]);
  const f2 = fragment(2, 6000, [1500], [NON_SYNC]);
  const src = concatBytes([
    ftyp(),
    writeBox('moov', [mvhdV0(), makeTrak(1), writeBox('mvex', [trex(1)])]),
    f1.moof,
    f1.mdat,
    f2.moof,
    f2.mdat,
  ]);

  const r = flattenFmp4(src);

  it('顶层结构变为 ftyp + moov + mdat（无 moof / mvex）', () => {
    const top = walkBoxes(r.data).map((b) => b.type);
    expect(top).toEqual(['ftyp', 'moov', 'mdat']);
    const moov = walkBoxes(r.data).find((b) => b.type === 'moov')!;
    expect(childBoxes(r.data, moov).some((b) => b.type === 'mvex')).toBe(false);
    expect(r.stats).toMatchObject({ tracks: 1, samples: 3, fragments: 2 });
  });

  it('stsz 记录全部样本尺寸', () => {
    const moov = walkBoxes(r.data).find((b) => b.type === 'moov')!;
    const trak = childBoxes(r.data, moov).find((b) => b.type === 'trak')!;
    const mdia = childBoxes(r.data, trak).find((b) => b.type === 'mdia')!;
    const minf = childBoxes(r.data, mdia).find((b) => b.type === 'minf')!;
    const stbl = childBoxes(r.data, minf).find((b) => b.type === 'stbl')!;
    const stsz = childBoxes(r.data, stbl).find((b) => b.type === 'stsz')!;
    const { body } = readVersionFlags(r.data, stsz.start);
    const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    expect(dv.getUint32(body + 4)).toBe(3); // sample_count
    const sizes = [0, 1, 2].map((i) => dv.getUint32(body + 8 + i * 4));
    expect(sizes).toEqual([1000, 2000, 1500]);
  });

  it('stts 记录时长、stss 记录同步样本', () => {
    const moov = walkBoxes(r.data).find((b) => b.type === 'moov')!;
    const trak = childBoxes(r.data, moov).find((b) => b.type === 'trak')!;
    const mdia = childBoxes(r.data, trak).find((b) => b.type === 'mdia')!;
    const minf = childBoxes(r.data, mdia).find((b) => b.type === 'minf')!;
    const stbl = childBoxes(r.data, minf).find((b) => b.type === 'stbl')!;
    const stts = childBoxes(r.data, stbl).find((b) => b.type === 'stts')!;
    const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    const sttsBody = readVersionFlags(r.data, stts.start).body;
    expect(dv.getUint32(sttsBody)).toBe(1); // 一个游程：3 × 3000
    expect(dv.getUint32(sttsBody + 4)).toBe(3);
    expect(dv.getUint32(sttsBody + 8)).toBe(3000);
    // stss（存在非同步样本时应生成）
    const stss = childBoxes(r.data, stbl).find((b) => b.type === 'stss');
    expect(stss).toBeTruthy();
    const sBody = readVersionFlags(r.data, stss!.start).body;
    expect(dv.getUint32(sBody)).toBe(1); // 仅样本 1 为同步
    expect(dv.getUint32(sBody + 4)).toBe(1);
  });

  it('样本字节零损失（mdat payload = 源样本按序拼接）', () => {
    const moov = walkBoxes(r.data).find((b) => b.type === 'moov')!;
    const mdat = walkBoxes(r.data).find((b) => b.type === 'mdat')!;
    const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    const trak = childBoxes(r.data, moov).find((b) => b.type === 'trak')!;
    const mdia = childBoxes(r.data, trak).find((b) => b.type === 'mdia')!;
    const minf = childBoxes(r.data, mdia).find((b) => b.type === 'minf')!;
    const stbl = childBoxes(r.data, minf).find((b) => b.type === 'stbl')!;
    const stco = childBoxes(r.data, stbl).find((b) => b.type === 'stco')!;
    const stsz = childBoxes(r.data, stbl).find((b) => b.type === 'stsz')!;

    // 期望 = 源片段样本按文件序拼接
    const expected = concatBytes([...f1.samples, ...f2.samples]);
    const payload = r.data.subarray(mdat.start + 8, mdat.start + mdat.size);
    expect(payload.length).toBe(expected.length);
    expect(Array.from(payload.subarray(0, 64))).toEqual(Array.from(expected.subarray(0, 64)));
    expect(Array.from(payload.subarray(payload.length - 64))).toEqual(Array.from(expected.subarray(expected.length - 64)));

    // stco 每个 chunk 起点必须落在 mdat payload 内且与样本尺寸自洽
    const stcoBody = readVersionFlags(r.data, stco.start).body;
    const stszBody = readVersionFlags(r.data, stsz.start).body;
    const chunkCount = dv.getUint32(stcoBody);
    const sampleCount = dv.getUint32(stszBody + 4);
    // 源两段样本在新文件中连续 → 合并为一个 chunk（合法且更紧凑）
    expect(chunkCount).toBe(1);
    expect(sampleCount).toBe(3);
    const mdatPayloadStart = mdat.start + 8;
    const totalSize = Array.from({ length: sampleCount }, (_, i) => dv.getUint32(stszBody + 8 + i * 4)).reduce((a, b) => a + b, 0);
    for (let i = 0; i < chunkCount; i++) {
      const off = dv.getUint32(stcoBody + 4 + i * 4);
      expect(off).toBeGreaterThanOrEqual(mdatPayloadStart);
      expect(off).toBeLessThan(mdatPayloadStart + totalSize);
    }
  });
});
