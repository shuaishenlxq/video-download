// 输出档案策略测试（纯音频被存成 mp4 的修复）
// 关键约束：**视频路径行为必须与既有逻辑逐字等价**（回归用例锁死）
import { describe, it, expect } from 'vitest';
import { resolveOutputProfile, extFromUrl, KNOWN_VIDEO_EXT } from '../src/background/output-profile';
import type { Protocol } from '../src/shared/types';

const ctxOf = (url: string, protocol: Protocol = 'progressive', mime?: string) => ({
  protocol,
  masterUrl: url,
  sourceExt: protocol === 'progressive' ? extFromUrl(url) : 'mp4',
  sourceMime: mime,
});

const audio = { type: 'audio' as const };
const video = { type: 'video' as const };

describe('音频输出档案（QQ 音乐等纯音频站）', () => {
  it('m4a 直链 → 落盘 .m4a / 容器 m4a / MIME audio/mp4', () => {
    const p = resolveOutputProfile(audio, ctxOf('https://isure6.stream.qqmusic.qq.com/C400003uIqJ04h0QOcI.m4a?guid=123&vkey=abc'));
    expect(p).toMatchObject({ kind: 'audio', container: 'm4a', ext: 'm4a', mime: 'audio/mp4' });
  });

  it('mp3 直链 → 落盘 .mp3', () => {
    const p = resolveOutputProfile(audio, ctxOf('https://cdn.example.com/song.mp3?token=x'));
    expect(p).toMatchObject({ ext: 'mp3', container: 'mp3', mime: 'audio/mpeg' });
  });

  it('URL 无扩展名时按 MIME 推断（audio/mpeg → mp3）', () => {
    const p = resolveOutputProfile(audio, ctxOf('https://cdn.example.com/stream?id=9', 'progressive', 'audio/mpeg'));
    expect(p.ext).toBe('mp3');
  });

  it('URL 扩展名被伪装（.txt）但类型是音频 → 仍按音频落盘', () => {
    const p = resolveOutputProfile(audio, ctxOf('https://cdn.example.com/song.txt', 'progressive', 'audio/mp4'));
    expect(p.ext).toBe('m4a');
  });

  it('仅凭 URL 扩展名也能识别为音频（媒体类型未标注时）', () => {
    const p = resolveOutputProfile(video, ctxOf('https://cdn.example.com/track.flac'));
    expect(p).toMatchObject({ kind: 'audio', ext: 'flac', mime: 'audio/flac' });
  });
});

describe('音频输出偏好：转为 MP3', () => {
  it('audioOutput=mp3 → 容器/扩展名 mp3、MIME audio/mpeg', () => {
    const p = resolveOutputProfile(audio, { ...ctxOf('https://cdn.example.com/song.m4a'), audioOutput: 'mp3' });
    expect(p).toMatchObject({ kind: 'audio', container: 'mp3', ext: 'mp3', mime: 'audio/mpeg' });
  });

  it('视频条目不受 audioOutput 影响（仍是 mp4）', () => {
    const p = resolveOutputProfile(video, { ...ctxOf('https://h/index.m3u8', 'hls'), audioOutput: 'mp3' });
    expect(p).toMatchObject({ kind: 'video', ext: 'mp4', mime: 'video/mp4' });
  });
});

describe('视频输出档案（回归：必须与既有逻辑等价）', () => {
  it('HLS/DASH 恒为 mp4', () => {
    expect(resolveOutputProfile(video, ctxOf('https://h/index.m3u8', 'hls')).ext).toBe('mp4');
    expect(resolveOutputProfile(video, ctxOf('https://h/manifest.mpd', 'dash')).ext).toBe('mp4');
  });

  it('progressive 且扩展名在视频白名单内 → 沿用该扩展名', () => {
    for (const ext of ['mp4', 'webm', 'mkv', 'flv', 'm4v', 'mov']) {
      const p = resolveOutputProfile(video, ctxOf(`https://h/a.${ext}`));
      expect(p.ext).toBe(ext);
      expect(p.container).toBe('mp4');
      expect(p.mime).toBe('video/mp4');
    }
  });

  it('伪装扩展名（.txt/.jpg）→ 一律落 mp4（历史修复回归）', () => {
    expect(resolveOutputProfile(video, ctxOf('https://h/video.txt')).ext).toBe('mp4');
    expect(resolveOutputProfile(video, ctxOf('https://h/video.jpg')).ext).toBe('mp4');
  });

  it('分片扩展名 ts/m4s 保持原样', () => {
    expect(resolveOutputProfile(video, ctxOf('https://h/seg.ts')).ext).toBe('ts');
    expect(resolveOutputProfile(video, ctxOf('https://h/seg.m4s')).ext).toBe('m4s');
  });

  it('视频白名单不含音频扩展名（防止音频被当视频处理）', () => {
    for (const a of ['m4a', 'mp3', 'aac', 'flac']) expect(KNOWN_VIDEO_EXT.includes(a)).toBe(false);
  });
});

describe('extFromUrl', () => {
  it('剥离 query 并转小写', () => {
    expect(extFromUrl('https://a/b/C400.m4a?vkey=ABC&u=1')).toBe('m4a');
    expect(extFromUrl('https://a/b/MOV.MP4')).toBe('mp4');
  });
});
