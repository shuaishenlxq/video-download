import { describe, it, expect } from 'vitest';
import { parseM3u8 } from '../src/background/parser/m3u8';

const BASE = 'https://cdn.example.com/vod/';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p/index.m3u8`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
seg-0.ts
#EXTINF:9.009,
seg-1.ts
#EXTINF:8.0,
seg-2.ts
#EXT-X-ENDLIST`;

const MEDIA_AES = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-KEY:METHOD=AES-128,URI="https://key.example.com/key?id=1",IV=0x9c7db8778570d05c3177c349fd9236aa
#EXTINF:10.0,
seg-100.ts
#EXTINF:10.0,
seg-101.ts
#EXT-X-ENDLIST`;

describe('parseM3u8：主清单（F-103 规则 1/4）', () => {
  const r = parseM3u8(MASTER, BASE);
  it('识别为 master 并解析变体', () => {
    expect(r.type).toBe('master');
    if (r.type !== 'master') return;
    expect(r.variants).toHaveLength(3);
    expect(r.variants[0]!.resolution).toBe('1920x1080');
    expect(r.variants[2]!.resolution).toBe('854x480');
  });
  it('分辨率降序排序（缺失时带宽兜底）', () => {
    if (r.type !== 'master') return;
    expect(r.variants.map((v) => v.bandwidth)).toEqual([4500000, 2500000, 1000000]);
  });
  it('相对 URL 基于清单地址解析', () => {
    if (r.type !== 'master') return;
    expect(r.variants[2]!.playlistUrl).toBe('https://cdn.example.com/vod/480p/index.m3u8');
  });
  it('quality 标签', () => {
    if (r.type !== 'master') return;
    expect(r.variants[0]!.qualityLabel).toBe('1080p');
    expect(r.variants[2]!.qualityLabel).toBe('480p');
  });
});

describe('parseM3u8：媒体清单', () => {
  it('分片列表 + 时长累加 + 直播判定', () => {
    const r = parseM3u8(MEDIA, BASE);
    expect(r.type).toBe('media');
    if (r.type !== 'media') return;
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]).toMatchObject({ url: 'https://cdn.example.com/vod/seg-0.ts', index: 0 });
    expect(r.durationSec).toBeCloseTo(26.018, 2);
    expect(r.live).toBe(false);
    expect(r.encryption.method).toBe('none');
    expect(r.mediaSequence).toBe(0);
  });
  it('AES-128 加密识别（F-110）', () => {
    const r = parseM3u8(MEDIA_AES, BASE);
    if (r.type !== 'media') throw new Error('expect media');
    expect(r.encryption).toEqual({
      method: 'aes128',
      keyUrl: 'https://key.example.com/key?id=1',
      ivHex: '9c7db8778570d05c3177c349fd9236aa',
    });
    expect(r.mediaSequence).toBe(100);
  });
  it('SAMPLE-AES 标记为不支持（F-110）', () => {
    const t = MEDIA_AES.replace('AES-128', 'SAMPLE-AES');
    const r = parseM3u8(t, BASE);
    if (r.type !== 'media') throw new Error('expect media');
    expect(r.encryption.method).toBe('sampleaes');
  });
  it('无 ENDLIST 判定为直播（F-103 规则 3）', () => {
    const r = parseM3u8(MEDIA.replace('#EXT-X-ENDLIST', ''), BASE);
    if (r.type !== 'media') throw new Error('expect media');
    expect(r.live).toBe(true);
  });
  it('BYTERANGE 解析', () => {
    const t = `#EXTM3U\n#EXTINF:10.0,\n#EXT-X-BYTERANGE:75232@0\nvideo.mp4\n#EXT-X-ENDLIST`;
    const r = parseM3u8(t, BASE);
    if (r.type !== 'media') throw new Error('expect media');
    expect(r.segments[0]!.byterange).toEqual({ length: 75232, offset: 0 });
  });
  it('格式非法返回 error（E-002 降级）', () => {
    expect(parseM3u8('hello world', BASE).type).toBe('error');
    expect(parseM3u8('', BASE).type).toBe('error');
  });
});
