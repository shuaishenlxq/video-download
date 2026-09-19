// 「无清单 DASH」适配测试（B 站为代表：单文件轨道 + Range 分段）
import { describe, it, expect } from 'vitest';
import { parseNoListSegment, classifyTrack, NoListAggregator, splitFmp4Parts, hasVideoTrak } from '../src/background/sites/dash-nolist';

describe('parseNoListSegment：从分片 URL 反推轨道', () => {
  it('识别 B 站视频轨 / 音频轨', () => {
    const v = parseNoListSegment('https://b-baaaa8xx.edge.mountaintoys.cn:4483/upgcxcode/99/91/137649199/137649199_da2-1-100022.m4s?e=xxx&u=yyy');
    expect(v).toMatchObject({ codecId: 100022, type: 'video', groupId: '137649199/137649199_da2' });
    const a = parseNoListSegment('https://xy1.mcdn.bilivideo.cn:8082/v1/resource/upgcxcode/99/91/137649199/137649199_da2-1-30216.m4s?e=xxx');
    expect(a).toMatchObject({ codecId: 30216, type: 'audio', groupId: '137649199/137649199_da2' });
  });

  it('同一视频的视频轨与音频轨聚合键一致（仅 codecId 不同）', () => {
    const v = parseNoListSegment('https://h1.cdn/upgcxcode/1/2/999/999_x-1-100023.m4s')!;
    const a = parseNoListSegment('https://h2.cdn/upgcxcode/1/2/999/999_x-1-30280.m4s')!;
    expect(v.groupId).toBe(a.groupId);
    expect(v.type).not.toBe(a.type);
  });

  it('非该形态的 URL 返回 null（普通 mp4 / m3u8 不受影响）', () => {
    expect(parseNoListSegment('https://example.com/video.mp4')).toBeNull();
    expect(parseNoListSegment('https://example.com/index.m3u8?x=1')).toBeNull();
    expect(parseNoListSegment('not a url')).toBeNull();
  });

  it('轨道类型划分', () => {
    expect(classifyTrack(100022)).toBe('video');
    expect(classifyTrack(30216)).toBe('audio');
    expect(classifyTrack(30280)).toBe('audio');
  });
});

describe('NoListAggregator：轨道聚合', () => {
  it('视频+音频就绪后产出条目；重复 URL 不重复触发', async () => {
    const ready: string[] = [];
    const agg = new NoListAggregator((_t, item) => ready.push(`${item.video?.codecId}/${item.audio?.codecId}`));
    agg.add(1, 'https://h/upgcxcode/1/1/888/888_a-1-100022.m4s?sig1');
    expect(agg.add(1, 'https://h/upgcxcode/1/1/888/888_a-1-100022.m4s?sig1')).toBe(false); // 同轨同码率重复
    agg.add(1, 'https://h/upgcxcode/1/1/888/888_a-1-30216.m4s?sig2');
    await new Promise((r) => setTimeout(r, 1500));
    expect(ready).toEqual(['100022/30216']);
  });

  it('只观察到视频轨时也会产出（先给用户可下项，音轨后续补齐）', async () => {
    const ready: number[] = [];
    const agg = new NoListAggregator((_t, item) => ready.push(item.video!.codecId));
    agg.add(2, 'https://h/upgcxcode/2/2/777/777_b-1-100026.m4s');
    await new Promise((r) => setTimeout(r, 1500));
    expect(ready).toEqual([100026]);
  });

  it('同轨多清晰度保留 codecId 最大者', () => {
    const agg = new NoListAggregator(() => {});
    agg.add(3, 'https://h/upgcxcode/3/3/666/666_c-1-100022.m4s');
    agg.add(3, 'https://h/upgcxcode/3/3/666/666_c-1-100026.m4s');
    const snap = agg.snapshot(3);
    expect(snap[0]!.video!.codecId).toBe(100026);
  });

  it('clearTab 清理该标签页状态', async () => {
    const ready: string[] = [];
    const agg = new NoListAggregator((_t, i) => ready.push(i.groupId));
    agg.add(4, 'https://h/upgcxcode/4/4/555/555_d-1-100022.m4s');
    agg.clearTab(4);
    await new Promise((r) => setTimeout(r, 1500));
    expect(ready).toEqual([]);
  });
});

// ---------- 合成 fMP4 轨道文件（验证拆分）----------
function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, 8 + payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

describe('splitFmp4Parts：单文件轨道 → init + fragments', () => {
  it('ftyp+moov 归为 init，每个 moof+mdat 归为一个片段', () => {
    const ftyp = box('ftyp', new TextEncoder().encode('iso6'));
    const moov = box('moov', new TextEncoder().encode('vide'));
    const moof1 = box('moof', new Uint8Array(4));
    const mdat1 = box('mdat', new Uint8Array(8));
    const moof2 = box('moof', new Uint8Array(4));
    const mdat2 = box('mdat', new Uint8Array(16));
    const all = [ftyp, moov, moof1, mdat1, moof2, mdat2];
    const total = all.reduce((n, b) => n + b.length, 0);
    const data = new Uint8Array(total);
    let off = 0;
    for (const b of all) {
      data.set(b, off);
      off += b.length;
    }
    const r = splitFmp4Parts(data);
    expect(r.init.length).toBe(ftyp.length + moov.length);
    expect(r.fragments.length).toBe(2);
    expect(r.fragments[0]!.length).toBe(moof1.length + mdat1.length);
    expect(r.fragments[1]!.length).toBe(moof2.length + mdat2.length);
    expect(hasVideoTrak(r.init)).toBe(true);
  });

  it('真实 B 站结构：ftyp/free/moov/free/sidx 全归 init（不能因 free 提前截断）', () => {
    const ftyp = box('ftyp', new Uint8Array(24));
    const free1 = box('free', new Uint8Array(69));
    const moov = box('moov', new TextEncoder().encode('vide'));
    const free2 = box('free', new Uint8Array(56));
    const sidx = box('sidx', new Uint8Array(540));
    const moof = box('moof', new Uint8Array(580));
    const mdat = box('mdat', new Uint8Array(900));
    const all = [ftyp, free1, moov, free2, sidx, moof, mdat];
    const total = all.reduce((n, b) => n + b.length, 0);
    const data = new Uint8Array(total);
    let off = 0;
    for (const b of all) { data.set(b, off); off += b.length; }
    const r = splitFmp4Parts(data);
    const expectInit = ftyp.length + free1.length + moov.length + free2.length + sidx.length;
    expect(r.init.length).toBe(expectInit);
    expect(hasVideoTrak(r.init)).toBe(true); // moov 在 init 内
    expect(r.fragments.length).toBe(1);
    expect(r.fragments[0]!.length).toBe(moof.length + mdat.length);
  });

  it('无 moof 的轨道（只有 init + mdat）→ 媒体区整体作为片段', () => {
    const ftyp = box('ftyp', new Uint8Array(4));
    const moov = box('moov', new TextEncoder().encode('soun'));
    const mdat = box('mdat', new Uint8Array(32));
    const data = new Uint8Array(ftyp.length + moov.length + mdat.length);
    data.set(ftyp, 0);
    data.set(moov, ftyp.length);
    data.set(mdat, ftyp.length + moov.length);
    const r = splitFmp4Parts(data);
    expect(r.init.length).toBe(ftyp.length + moov.length);
    expect(r.fragments.length).toBe(1);
    expect(hasVideoTrak(r.init)).toBe(false);
  });
});
