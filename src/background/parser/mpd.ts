// ============ DASH mpd 解析器（F-103）============
export interface MpdRepresentation {
  id: string;
  type: 'video' | 'audio';
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
  lang?: string;
  // SegmentTemplate / SegmentList 原始信息
  initTemplate?: string; // $RepresentationID$ 形式
  mediaTemplate?: string; // $RepresentationID$/seg-$Number$.m4s
  initUrl?: string; // SegmentList 显式
  explicitSegmentUrls?: string[]; // SegmentList 显式
  timescale?: number;
  segmentDuration?: number; // 在 timescale 下的分片时长
  startNumber?: number;
  // SegmentTimeline ($Time$)
  timelineEntries?: { t: number; d: number }[];
  /** MPD 总时长（秒），用于 $Number$ 模式推分片数 */
  durationFromMpd?: number;
}

export interface MpdDocument {
  live: boolean;
  durationSec: number | null;
  encryption: 'none' | 'drm';
  representations: MpdRepresentation[];
}

export type ParseMpdResult = { ok: true; doc: MpdDocument } | { ok: false; reason: string };

function parseDuration(iso: string): number | null {
  // PT1H2M3S / PT30S / P0DT0H30M10.5S
  const m = iso?.match(/^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0);
}

const DRM_SYSTEM_IDS = [
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // widevine
  '9a04f079-9840-4286-ab92-e65be0885f95', // playready
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2', // fairplay
];

function hasDrm(adaptationSet: Element, rep: Element): boolean {
  const cps = [
    ...Array.from(adaptationSet.getElementsByTagNameNS('*', 'ContentProtection')),
    ...Array.from(rep.getElementsByTagNameNS('*', 'ContentProtection')),
  ];
  if (!cps.length) return false;
  // 仅有 mp4protection（cenc 声明）而无具体 DRM 系统时，视为 cenc 加密：无密钥获取通道，按 DRM 处理（红线：不绕过）
  return true;
}

export function parseMpd(text: string, baseUrl: string): ParseMpdResult {
  let dom: Document;
  try {
    dom = new DOMParser().parseFromString(text, 'text/xml');
  } catch {
    return { ok: false, reason: 'xml parse failed' };
  }
  if (dom.getElementsByTagName('parsererror').length) return { ok: false, reason: 'xml parse error' };
  const mpd = dom.getElementsByTagNameNS('*', 'MPD')[0];
  if (!mpd) return { ok: false, reason: 'no MPD element' };

  const live = (mpd.getAttribute('type') ?? 'static') === 'dynamic';
  const durationSec = parseDuration(mpd.getAttribute('mediaPresentationDuration') ?? '');

  const representations: MpdRepresentation[] = [];
  let drm = false;
  const periods = Array.from(mpd.getElementsByTagNameNS('*', 'Period'));
  for (const period of periods) {
    const periodBase = resolveAttr(period, 'xml:base') ?? undefined;
    const sets = Array.from(period.getElementsByTagNameNS('*', 'AdaptationSet'));
    for (const set of sets) {
      const setBase = resolveAttr(set, 'xml:base') ?? undefined;
      const contentType =
        set.getAttribute('contentType') ?? (set.getAttribute('mimeType') ?? '').split('/')[0] ?? '';
      const setLang = set.getAttribute('lang') ?? undefined;
      // AdaptationSet 级 SegmentTemplate
      const setTpl = directChild(set, 'SegmentTemplate');
      const reps = Array.from(set.getElementsByTagNameNS('*', 'Representation')).filter((e) => e.parentElement === set || e.parentElement?.localName === 'AdaptationSet');
      for (const rep of reps) {
        const mime = rep.getAttribute('mimeType') ?? set.getAttribute('mimeType') ?? '';
        const type: 'video' | 'audio' =
          contentType === 'audio' || mime.startsWith('audio/') || rep.getElementsByTagNameNS('*', 'AudioChannelConfiguration').length > 0
            ? 'audio'
            : 'video';
        if (hasDrm(set, rep)) drm = true;

        const node: MpdRepresentation = {
          id: rep.getAttribute('id') ?? `rep-${representations.length}`,
          type,
          bandwidth: rep.getAttribute('bandwidth') ? Number(rep.getAttribute('bandwidth')) : undefined,
          resolution:
            rep.getAttribute('width') && rep.getAttribute('height')
              ? `${rep.getAttribute('width')}x${rep.getAttribute('height')}`
              : undefined,
          codecs: rep.getAttribute('codecs') ?? undefined,
          lang: setLang ?? rep.getAttribute('lang') ?? undefined,
        };

        const tpl = directChild(rep, 'SegmentTemplate') ?? setTpl;
        if (tpl) {
          node.timescale = Number(tpl.getAttribute('timescale') ?? '1') || 1;
          node.segmentDuration = tpl.getAttribute('duration') ? Number(tpl.getAttribute('duration')) : undefined;
          node.startNumber = tpl.getAttribute('startNumber') ? Number(tpl.getAttribute('startNumber')) : undefined;
          node.initTemplate = tpl.getAttribute('initialization') ?? undefined;
          node.mediaTemplate = tpl.getAttribute('media') ?? undefined;
          const timeline = directChild(tpl, 'SegmentTimeline');
          if (timeline) {
            node.timelineEntries = Array.from(timeline.getElementsByTagNameNS('*', 'S')).map((s) => ({
              t: Number(s.getAttribute('t') ?? '0'),
              d: Number(s.getAttribute('d') ?? '0'),
            }));
          }
        } else {
          const list = directChild(rep, 'SegmentList') ?? directChild(set, 'SegmentList');
          if (list) {
            node.timescale = Number(list.getAttribute('timescale') ?? '1') || 1;
            node.segmentDuration = list.getAttribute('duration') ? Number(list.getAttribute('duration')) : undefined;
            const init = directChild(list, 'Initialization');
            node.initUrl = init?.getAttribute('sourceURL') ?? undefined;
            node.explicitSegmentUrls = Array.from(list.getElementsByTagNameNS('*', 'SegmentURL'))
              .map((s) => s.getAttribute('media') ?? undefined)
              .filter((u): u is string => !!u);
          }
        }
        // xml:base 链
        void periodBase;
        void setBase;
        node.durationFromMpd = durationSec ?? undefined;
        representations.push(node);
      }
    }
  }

  if (!representations.length) return { ok: false, reason: 'no representations' };
  void baseUrl;
  return {
    ok: true,
    doc: { live, durationSec: durationSec ?? null, encryption: drm ? 'drm' : 'none', representations },
  };
}

function directChild(el: Element, localName: string): Element | null {
  for (const c of Array.from(el.children)) if (c.localName === localName) return c;
  return null;
}

function resolveAttr(el: Element, name: string): string | null {
  let cur: Element | null = el;
  while (cur) {
    const v = cur.getAttribute(name);
    if (v) return v;
    cur = cur.parentElement;
  }
  return null;
}

// ---------- Segment URL 展开 ----------
export interface ExpandedSegments {
  initUrl?: string;
  segmentUrls: string[];
  avgSegmentDur?: number; // 秒
  totalDurationSec?: number;
}

function substitute(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth)(%0\d+d)?\$/g, (_, name: string, pad?: string) => {
    const v = vars[name];
    if (v == null) return '';
    if (pad) {
      const num = Number(v);
      const digits = Number(pad.match(/%0(\d+)d/)?.[1] ?? '1');
      return String(num).padStart(digits, '0');
    }
    return String(v);
  });
}

export function expandSegments(rep: MpdRepresentation, manifestUrl: string): ExpandedSegments {
  const base = manifestUrl.includes('/') ? manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1) : '';
  const abs = (u: string) => {
    try {
      return new URL(u, manifestUrl).href;
    } catch {
      return base + u;
    }
  };
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth ?? 0 };

  const initUrl = rep.initTemplate ? abs(substitute(rep.initTemplate, vars)) : rep.initUrl ? abs(rep.initUrl) : undefined;

  if (rep.explicitSegmentUrls) {
    return { initUrl, segmentUrls: rep.explicitSegmentUrls.map(abs) };
  }
  if (!rep.mediaTemplate) return { initUrl, segmentUrls: [] };

  const urls: string[] = [];
  if (rep.timelineEntries?.length) {
    // $Time$ 模式：按 timeline 生成
    let t = rep.timelineEntries[0]!.t;
    let n = rep.startNumber ?? 1;
    for (const e of rep.timelineEntries) {
      for (let x = 0; x < Math.max(1, Math.round(e.d / (rep.segmentDuration ?? (e.d || 1)))); x++) {
        urls.push(abs(substitute(rep.mediaTemplate, { ...vars, Number: n, Time: t })));
        t += e.d;
        n++;
      }
    }
  } else {
    // $Number$ 模式：按总时长推分片数
    const timescale = rep.timescale ?? 1;
    const segDur = rep.segmentDuration ?? 0;
    const total = rep.durationFromMpd ?? 0;
    const count = segDur ? Math.ceil((total * timescale) / segDur) : 0;
    for (let n = rep.startNumber ?? 1; n < (rep.startNumber ?? 1) + count; n++) {
      urls.push(abs(substitute(rep.mediaTemplate, { ...vars, Number: n })));
    }
    return { initUrl, segmentUrls: urls, avgSegmentDur: segDur / timescale, totalDurationSec: total };
  }
  return { initUrl, segmentUrls: urls };
}
