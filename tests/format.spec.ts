import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration, formatEta, formatSpeed, resolutionOf } from '../src/shared/format';

describe('formatBytes', () => {
  it('字节数转人类可读', () => {
    expect(formatBytes(428 * 1024 * 1024)).toBe('428 MB');
    expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB');
    expect(formatBytes(7.4 * 1024 * 1024)).toBe('7.4 MB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(null)).toBe('未知');
  });
});

describe('formatDuration', () => {
  it('秒转 hh:mm:ss', () => {
    expect(formatDuration(5025)).toBe('01:23:45');
    expect(formatDuration(192)).toBe('00:03:12');
    // PRD 6.3：时长为 0 或负数判为无效，按未知处理
    expect(formatDuration(0)).toBe('--:--');
    expect(formatDuration(null)).toBe('--:--');
    expect(formatDuration(-5)).toBe('--:--');
  });
});

describe('formatEta / formatSpeed', () => {
  it('剩余时间与速度', () => {
    expect(formatEta(43)).toBe('剩 43s');
    expect(formatEta(125)).toBe('剩 2m05s');
    expect(formatEta(null)).toBe('');
    expect(formatSpeed(4.2 * 1024 * 1024)).toBe('4.2 MB/s');
  });
});

describe('resolutionOf', () => {
  it('从 resolution 字符串取档位标签与像素数', () => {
    expect(resolutionOf('1920x1080').label).toBe('1080p');
    expect(resolutionOf('1280x720').pixels).toBe(1280 * 720);
    expect(resolutionOf(undefined).label).toBe('');
  });
});
