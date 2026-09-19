// validateMergedMp4 的轨道感知校验测试（真实站点 tfdt_regression 误报事故回归）
// 事故：视频/音频双轨时间轴交叉（v:0,3600,7200 / a:0,2048,4096），全局单调检查误判合法文件失败。
import { describe, it, expect } from 'vitest';
import { validateMergedMp4 } from '../src/offscreen/mp4merge';

// ---------- 合成 fMP4：moof{ mfhd, traf{ tfhd(trackId), tfdt(time) } } ----------
function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}
function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const size = 8 + children.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let off = 8;
  for (const c of children) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
function fullBox(type: string, versionFlags: number, payload: Uint8Array): Uint8Array {
  return box(type, u32(versionFlags), payload);
}
function moof(seq: number, trackId: number, decodeTime: number): Uint8Array {
  const mfhd = fullBox('mfhd', 0, u32(seq));
  const tfhd = fullBox('tfhd', 0x020000, u32(trackId)); // default-base-is-moof
  const tfdt = fullBox('tfdt', 0x000000, u32(decodeTime)); // version 0 + u32 time
  const traf = box('traf', tfhd, tfdt);
  return box('moof', mfhd, traf);
}
function ftyp(): Uint8Array {
  return box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1]));
}

function assemble(frags: Uint8Array[]): Uint8Array {
  const all = [ftyp(), ...frags];
  const total = all.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of all) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}

describe('validateMergedMp4：轨道感知的 tfdt 校验', () => {
  it('双轨交叉时间轴（视频 0/9000/18000 + 音频 0/2048/4096）→ 合法通过', () => {
    const frags = [
      moof(1, 1, 0), moof(2, 2, 0),
      moof(3, 1, 9000), moof(4, 2, 2048),
      moof(5, 1, 18000), moof(6, 2, 4096),
    ];
    const r = validateMergedMp4(assemble(frags), 6);
    expect(r.ok).toBe(true);
  });

  it('同轨道时间回退 → tfdt_regression_trackN', () => {
    const frags = [
      moof(1, 1, 0),
      moof(2, 1, 9000),
      moof(3, 1, 4500), // 同轨回退
    ];
    const r = validateMergedMp4(assemble(frags), 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tfdt_regression_track1');
  });

  it('DASH 顺序双轨（视频全部片段后接音频从 0 开始）→ 合法通过', () => {
    const frags = [
      moof(1, 1, 0), moof(2, 1, 9000), moof(3, 1, 18000),
      moof(4, 2, 0), moof(5, 2, 2048), // 音轨从头开始，独立时间轴
    ];
    const r = validateMergedMp4(assemble(frags), 5);
    expect(r.ok).toBe(true);
  });

  it('无 ftyp → 拒绝', () => {
    const frags = [moof(1, 1, 0)];
    const total = frags.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const f of frags) {
      out.set(f, off);
      off += f.length;
    }
    expect(validateMergedMp4(out, 1).reason).toBe('no_ftyp');
  });

  it('片段数缺失 >10% → fragment_count', () => {
    const frags = [moof(1, 1, 0), moof(2, 1, 9000)];
    const r = validateMergedMp4(assemble(frags), 10);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('fragment_count');
  });
});

// ---------- 终修函数（黑屏/28h 时长事故回归）----------
import { repairTfdtTimelines, finalizeDuration } from '../src/offscreen/mp4merge';
import { readMvhdDuration, readMdhd } from '../src/offscreen/mp4box-lite';

describe('repairTfdtTimelines：批间时间轴重置修补', () => {
  it('第二批 tfdt 重置回 0 → 自动补偏移恢复单调', () => {
    const frags = [
      moof(1, 1, 0), moof(2, 1, 9000), moof(3, 1, 18000),
      moof(4, 1, 0), moof(5, 1, 9000), // flush 后重置
    ];
    const { data, repaired } = repairTfdtTimelines(assemble(frags));
    expect(repaired).toBe(2);
    const v = validateMergedMp4(data, 0);
    expect(v.ok).toBe(true);
  });

  it('正常连续时间轴 → 不修补', () => {
    const frags = [moof(1, 1, 0), moof(2, 1, 9000), moof(3, 1, 18000)];
    const { repaired } = repairTfdtTimelines(assemble(frags));
    expect(repaired).toBe(0);
  });
});

describe('finalizeDuration：0xFFFFFFFF 占位时长写实', () => {
  it('mvhd/mdhd/tkhd 三处时长按各自 timescale 写入', async () => {
    // 构造带 mvhd(timescale=1000, duration=0xFFFFFFFF) + trak(tkhd+mdhd(timescale=90000)) 的 moov
    function fullBox(type: string, vf: number, payload: Uint8Array): Uint8Array {
      return box(type, u32(vf), payload);
    }
    const mvhd = fullBox('mvhd', 0, new Uint8Array(76)); // v0: 20 + creation/mod/ts/dur + rate/volume/... + next
    // 写 timescale 与占位 duration
    const mvhdBodyOff = 12; // ver/flags(4)+creation(4)+mod(4) 后是 timescale
    new DataView(mvhd.buffer).setUint32(mvhdBodyOff + 8, 1000); // body 内偏移 8 = timescale
    new DataView(mvhd.buffer).setUint32(mvhdBodyOff + 12, 0xffffffff); // duration
    const tkhd = fullBox('tkhd', 0, new Uint8Array(72));
    const mdhd = fullBox('mdhd', 0, new Uint8Array(16));
    // v0 mdhd body: creation(+0) mod(+4) timescale(+8) duration(+12)
    new DataView(mdhd.buffer).setUint32(12 + 8, 90000);
    new DataView(mdhd.buffer).setUint32(12 + 12, 0xffffffff);
    const trak = box('trak', tkhd, box('mdia', mdhd));
    const moov = box('moov', mvhd, trak);
    const data = new Uint8Array(ftyp().length + moov.length);
    data.set(ftyp(), 0);
    data.set(moov, ftyp().length);

    const out = finalizeDuration(data, 100); // 100 秒
    const moovB = out.slice(ftyp().length);
    const boxes = [{ start: 0, size: moovB.length }];
    void boxes;
    // 用公开 API 校验
    const { walkBoxes, childBoxes } = await import('../src/offscreen/mp4box-lite');
    const moovBox = walkBoxes(moovB)[0]!;
    const { timescale, duration } = readMvhdDuration(moovB, moovBox);
    expect(duration).toBe(100 * 1000);
    const trakB = childBoxes(moovB, moovBox).find((b) => b.type === 'trak')!;
    const mdia = childBoxes(moovB, trakB).find((b) => b.type === 'mdia')!;
    const mdhdB = childBoxes(moovB, mdia).find((b) => b.type === 'mdhd')!;
    expect(readMdhd(moovB, { ...mdhdB, start: mdhdB.start }).duration).toBe(100 * 90000);
  });
});

// ---------- Blob MIME（.txt 事故终局：无 type 的 Blob 被 Chrome 判为 text/plain 并改名）----------
import { mimeForFilename } from '../src/shared/mime';

describe('mimeForFilename：落盘 Blob 的 MIME 必须与扩展名一致', () => {
  it('视频/音频扩展名映射', () => {
    expect(mimeForFilename('a.mp4')).toBe('video/mp4');
    expect(mimeForFilename('a.ts')).toBe('video/mp2t');
    expect(mimeForFilename('a.mkv')).toBe('video/x-matroska');
    expect(mimeForFilename('a.m4a')).toBe('audio/mp4');
    expect(mimeForFilename('a.mp3')).toBe('audio/mpeg');
  });
  it('未知扩展名兜底 video/mp4（绝不落到 text/plain）', () => {
    expect(mimeForFilename('a.bin')).toBe('video/mp4');
    expect(mimeForFilename('noext')).toBe('video/mp4');
  });
});

// ---------- trakType：hdlr handler_type 偏移（真实站点音轨丢失事故）----------
import { trakType } from '../src/offscreen/mp4box-lite';

describe('trakType：轨道类型探测', () => {
  function hdlr(handlerType: string): Uint8Array {
    const payload = new Uint8Array(20);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 0); // version/flags
    dv.setUint32(4, 0); // pre_defined
    for (let i = 0; i < 4; i++) payload[8 + i] = handlerType.charCodeAt(i);
    return box('hdlr', payload);
  }
  function trak(handlerType: string): Uint8Array {
    return box('trak', box('mdia', hdlr(handlerType)));
  }

  it('正确识别视频/音频轨（偏移不可错位）', () => {
    const v = trak('vide');
    const a = trak('soun');
    expect(trakType(v, { start: 0, size: v.length } as never)).toBe('video');
    expect(trakType(a, { start: 0, size: a.length } as never)).toBe('audio');
  });

  it('未知 handler 归为 other', () => {
    const t = trak('meta');
    expect(trakType(t, { start: 0, size: t.length } as never)).toBe('other');
  });
});

// ---------- tkhd 字段偏移（音轨重编号事故：track_ID 写到 duration 上）----------
import { renumberTrak } from '../src/offscreen/mp4merge';

describe('renumberTrak：track_ID 重编号不得越界写到 duration', () => {
  function tkhd(version: number, trackId: number, duration: number): Uint8Array {
    // fullbox + creation/modification + track_ID + reserved + duration
    const body = new Uint8Array(version === 1 ? 32 : 20);
    const dv = new DataView(body.buffer);
    let p = version === 1 ? 16 : 8; // 跳 creation/modification
    dv.setUint32(p, trackId);
    p += 4;
    p += 4; // reserved
    if (version === 1) dv.setBigUint64(p, BigInt(duration));
    else dv.setUint32(p, duration);
    return box('tkhd', u32((version << 24) | 7), body);
  }

  it('v0：track_ID 被改写、duration 保持原值', () => {
    const trak = box('trak', tkhd(0, 1, 999999));
    const out = renumberTrak(trak, 2);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const tkhdStart = 8;
    expect(dv.getUint32(tkhdStart + 20)).toBe(2); // track_ID
    expect(dv.getUint32(tkhdStart + 28)).toBe(999999); // duration 未被污染
  });

  it('v1：track_ID 被改写、duration 保持原值', () => {
    const trak = box('trak', tkhd(1, 1, 888888));
    const out = renumberTrak(trak, 2);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    // tkhd v1: start+12(跳过 size/type/vf) +16(creation/mod) = track_ID; +24 = duration
    expect(dv.getUint32(8 + 12 + 16)).toBe(2);
    expect(Number(dv.getBigUint64(8 + 12 + 24))).toBe(888888);
  });
});
