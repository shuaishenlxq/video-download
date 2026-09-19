import { describe, it, expect } from 'vitest';
import { buildFilename, validateTemplate, TEMPLATE_VARS, previewFilename } from '../src/shared/naming';

const meta = {
  title: '第一讲-环境搭建',
  site: 'example.com',
  resolution: '1920x1080',
  quality: '1080p',
  bitrate: 4500,
  durationSec: 5025,
  date: '20260918',
  time: '162330',
  index: 3,
  ext: 'mp4',
};

describe('buildFilename（F-307）', () => {
  it('默认模板 {title}-{resolution}', () => {
    expect(buildFilename('{title}-{resolution}', meta)).toBe('第一讲-环境搭建-1920x1080.mp4');
  });
  it('扩展名自动追加，模板中写 .flv 也不会用错', () => {
    expect(buildFilename('{title}.flv', meta)).toBe('第一讲-环境搭建.mp4');
  });
  it('变量缺失时空串替代并压缩分隔符', () => {
    expect(buildFilename('{title}-{resolution}', { ...meta, resolution: undefined })).toBe('第一讲-环境搭建.mp4');
    expect(buildFilename('{index}-{title}', { ...meta, index: undefined })).toBe('第一讲-环境搭建.mp4');
  });
  it('批量序号补零两位起', () => {
    expect(buildFilename('{index}-{title}', meta)).toBe('03-第一讲-环境搭建.mp4');
  });
  it('时长格式 01h23m45s', () => {
    expect(buildFilename('{title}-{duration}', meta)).toBe('第一讲-环境搭建-01h23m45s.mp4');
  });
  it('非法文件名字符被过滤', () => {
    expect(buildFilename('{title}', { ...meta, title: 'a/b\\c:d*e?f"g<h>i|j' })).toBe('abcdefghij.mp4');
  });
  it('超长截断至 150 字符（含扩展名）', () => {
    const long = 'x'.repeat(200);
    const out = buildFilename('{title}', { ...meta, title: long });
    expect(out.length).toBeLessThanOrEqual(154); // 150 + .mp4
    expect(out.endsWith('.mp4')).toBe(true);
  });
  it('全部变量缺失回退默认模板', () => {
    expect(buildFilename('{quality}', { ...meta, quality: undefined })).toBe('第一讲-环境搭建.mp4');
  });
  it('未知变量原文保留（6.3：不静默丢弃）', () => {
    expect(buildFilename('{title}-{nope}', meta)).toBe('第一讲-环境搭建-{nope}.mp4');
  });
});

describe('validateTemplate（F-307 规则 3）', () => {
  it('必须含 {title} 或 {index}', () => {
    expect(validateTemplate('{title}-{resolution}').ok).toBe(true);
    expect(validateTemplate('{index}-{site}').ok).toBe(true);
    expect(validateTemplate('{site}-{date}').ok).toBe(false);
    expect(validateTemplate('').ok).toBe(false);
  });
  it('长度限制 200', () => {
    expect(validateTemplate(`{title}-${'a'.repeat(200)}`).ok).toBe(false);
  });
});

describe('TEMPLATE_VARS / previewFilename', () => {
  it('变量清单与 PRD 一致', () => {
    expect(TEMPLATE_VARS).toEqual(['title', 'site', 'resolution', 'quality', 'bitrate', 'duration', 'date', 'time', 'index', 'ext']);
  });
  it('实时预览', () => {
    expect(previewFilename('{title}-{resolution}')).toBe('第一讲-环境搭建-1920x1080.mp4');
  });
});
