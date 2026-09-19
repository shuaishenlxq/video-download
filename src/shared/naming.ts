// ============ 命名模板引擎（F-307，纯函数）============
export const TEMPLATE_VARS = ['title', 'site', 'resolution', 'quality', 'bitrate', 'duration', 'date', 'time', 'index', 'ext'] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

export const DEFAULT_TEMPLATE = '{title}-{resolution}';
const MAX_LEN = 150;
const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f]/g;

export interface NameMeta {
  title?: string;
  site?: string;
  resolution?: string;
  quality?: string;
  bitrate?: number; // kbps
  durationSec?: number | null;
  date?: string;
  time?: string;
  index?: number;
  ext?: string;
}

/** 变量值渲染：缺失返回空串，duration 特殊格式，bitrate 带 kbps，index 补零两位起 */
function renderVar(name: string, meta: NameMeta): string {
  switch (name) {
    case 'title':
      return cleanTitle(meta.title);
    case 'site':
      return meta.site ?? '';
    case 'resolution':
      return meta.resolution ?? '';
    case 'quality':
      return meta.quality ?? '';
    case 'bitrate':
      return meta.bitrate ? `${Math.round(meta.bitrate)}kbps` : '';
    case 'duration': {
      const s = meta.durationSec;
      if (s == null || !Number.isFinite(s) || s <= 0) return '';
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.round(s % 60);
      return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
    }
    case 'date':
      return meta.date ?? '';
    case 'time':
      return meta.time ?? '';
    case 'index':
      return meta.index != null ? String(meta.index).padStart(2, '0') : '';
    case 'ext':
      return ''; // 扩展名由输出容器决定，模板中的 {ext} 恒为空（F-307 规则 2）
    default:
      return `{${name}}`; // 未知变量原文保留（PRD 6.3）
  }
}

function cleanTitle(raw?: string): string {
  if (!raw) return '';
  return raw.replace(ILLEGAL, '').replace(/\s+/g, ' ').trim();
}

/** 压缩多余分隔符（变量缺失后残留的 - _ . 空格 连缀） */
function collapseSeparators(name: string): string {
  return name
    .replace(/\s*[-_.]+\s*([-_.]+\s*)+/g, '-')
    .replace(/^[-_.\s]+|[-_.\s]+$/g, '')
    .trim();
}

export function buildFilename(template: string, meta: NameMeta): string {
  const ext = (meta.ext || 'mp4').replace(/^\.+/, '').replace(ILLEGAL, '');
  let body = template.replace(/\{(\w+)\}/g, (_, name: string) => renderVar(name, meta));
  // 模板里用户手写的扩展名一律剥掉（规则 2：扩展名不允许写在模板中）
  body = body.replace(/\.(mp4|webm|mkv|flv|ts|mp3|m4a|aac|mov)$/i, '');
  body = collapseSeparators(body).slice(0, MAX_LEN);
  if (!body) body = buildFilename(DEFAULT_TEMPLATE, { ...meta, resolution: undefined, quality: undefined }).replace(new RegExp(`\\.${ext}$`), '');
  return `${body}.${ext}`;
}

export function validateTemplate(tpl: string): { ok: boolean; reason?: string } {
  if (!tpl || !tpl.trim()) return { ok: false, reason: '模板不能为空' };
  if (tpl.length > 200) return { ok: false, reason: '模板长度不能超过 200' };
  const hasTitleOrIndex = /\{title\}/.test(tpl) || /\{index\}/.test(tpl);
  if (!hasTitleOrIndex) return { ok: false, reason: '模板必须包含 {title} 或 {index}，否则文件名会重复' };
  return { ok: true };
}

const PREVIEW_META: NameMeta = {
  title: '第一讲-环境搭建',
  site: 'example.com',
  resolution: '1920x1080',
  quality: '1080p',
  bitrate: 4500,
  durationSec: 5025,
  date: '20260918',
  time: '162330',
  ext: 'mp4',
};

export function previewFilename(tpl: string): string {
  return buildFilename(tpl, PREVIEW_META);
}
