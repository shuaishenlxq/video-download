// ============ 「无清单 DASH」站点适配（B 站为代表）============
// 这类站点不用 .mpd 清单：playurl 接口返回各轨 baseUrl，播放器对**同一个 URL 反复发 Range 请求**
// 拼出完整轨道。网络层能看到这些请求，但无法读到 playurl 的 JSON（MV3 webRequest 不提供响应体）。
//
// 因此从 **URL 形态**反推轨道：
//   .../upgcxcode/99/91/137649199/137649199_da2-1-100022.m4s?sign...
//   └──── 目录 ────┘ └─ 视频 id ─┘ └ 基础名 ─┘ └codecId┘
// 命名规律：<base>-<序号>-<codecId>.m4s，同 base 的分片属于同一视频，codecId 区分轨/清晰度：
//   100xxx 区间 → 视频轨；30000+ 区间 → 音频轨（B 站约定：30216/30232/30280 为不同音质）
//
// 拿到轨道 URL 后可**全量 GET**（不带 Range）取得完整 fMP4（init + 媒体片段），
// 再拆成 init 与 fragments 交给现有 DASH 双轨合并管线（已实测可行）。

export interface NoListTrack {
  codecId: number;
  type: 'video' | 'audio';
  url: string;
}

export interface NoListItem {
  /** 聚合键：同站点同视频 */
  key: string;
  siteKey: string;
  groupId: string;
  video?: NoListTrack;
  audio?: NoListTrack;
}

const SEG_RE = /\/([^/]+)\/([^/]*?)-(\d+)-(\d+)\.(m4s|mp4|ts)(\?|$)/i;

/** 从分片 URL 解析出聚合信息；非「单文件轨道」形态返回 null */
export function parseNoListSegment(url: string): { key: string; siteKey: string; groupId: string; codecId: number; type: 'video' | 'audio' } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = SEG_RE.exec(u.pathname);
  if (!m) return null;
  const [, dirName, base, , codecRaw, ] = m;
  const codecId = Number(codecRaw);
  if (!Number.isFinite(codecId)) return null;
  // 目录 + 基础名 唯一标识一个视频（B 站：.../<avid>/<avid>_da2-1-<codec>.m4s）
  const groupId = `${dirName}/${base}`;
  return {
    key: `${u.hostname.replace(/^[^.]+\./, '')}|${groupId}|${codecId}`,
    siteKey: u.hostname,
    groupId,
    codecId,
    type: classifyTrack(codecId),
  };
}

/** codecId → 轨道类型（B 站约定；其它站点按数值区间近似） */
export function classifyTrack(codecId: number): 'video' | 'audio' {
  return codecId >= 30000 && codecId < 100000 ? 'audio' : 'video';
}

/**
 * 轨道聚合器：按 (tabId, groupId) 收集视频/音频轨，
 * 静默期（DEBOUNCE_MS）后回调产出可用条目。
 */
export const AGG_DEBOUNCE_MS = 1200;

export class NoListAggregator {
  private groups = new Map<string, NoListItem>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private onReady: (tabId: number, item: NoListItem) => void) {}

  /** 收一条分片 URL；返回是否发生了轨道更新 */
  add(tabId: number, url: string): boolean {
    const p = parseNoListSegment(url);
    if (!p) return false;
    const gk = `${tabId}|${p.groupId}`;
    let g = this.groups.get(gk);
    if (!g) {
      g = { key: gk, siteKey: p.siteKey, groupId: p.groupId };
      this.groups.set(gk, g);
    }
    const track: NoListTrack = { codecId: p.codecId, type: p.type, url };
    let changed = false;
    if (p.type === 'video') {
      // 同轨多清晰度：保留 codecId 最大者（B 站数值越大通常规格越高）
      if (!g.video || p.codecId > g.video.codecId) {
        g.video = track;
        changed = true;
      }
    } else if (!g.audio || p.codecId > g.audio.codecId) {
      g.audio = track;
      changed = true;
    }
    if (!changed) return false;

    // 静默期后产出（等两轨都出现，避免半成品进列表）
    const prev = this.timers.get(gk);
    if (prev) clearTimeout(prev);
    this.timers.set(
      gk,
      setTimeout(() => {
        this.timers.delete(gk);
        const cur = this.groups.get(gk);
        if (cur?.video) this.onReady(tabId, cur);
      }, AGG_DEBOUNCE_MS)
    );
    return true;
  }

  /** 页面导航时清理该 tab 的聚合状态 */
  clearTab(tabId: number): void {
    for (const [k, t] of this.timers) {
      if (k.startsWith(`${tabId}|`)) {
        clearTimeout(t);
        this.timers.delete(k);
      }
    }
    for (const k of [...this.groups.keys()]) {
      if (k.startsWith(`${tabId}|`)) this.groups.delete(k);
    }
  }

  snapshot(tabId: number): NoListItem[] {
    return [...this.groups.values()].filter((g) => g.key.startsWith(`${tabId}|`));
  }
}

/**
 * 拆分完整 fMP4 轨道文件（init + 媒体片段）。
 * B 站 m4s = ftyp + moov(init) + 连续 moof/mdat(媒体)。
 */
export function splitFmp4Parts(data: Uint8Array): { init: Uint8Array; fragments: Uint8Array[] } {
  const parts: { type: string; start: number; size: number }[] = [];
  let pos = 0;
  while (pos + 8 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + pos, 8);
    let size = view.getUint32(0);
    const type = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > data.length) break;
      const dv = new DataView(data.buffer, data.byteOffset + pos);
      size = Number(dv.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = data.length - pos;
    }
    if (size < headerSize || pos + size > data.length) break;
    parts.push({ type, start: pos, size });
    pos += size;
  }
  // init = 第一个 moof 之前的全部 box。
  // 真实形态（B 站实测）：ftyp → free → moov → free → sidx → moof/mdat…
  // 注意中间可能夹 free/sidx，不能"遇到非 ftyp/moov 就停"（否则 moov 会被漏掉）。
  const firstMoof = parts.find((p) => p.type === 'moof');
  const lastInit = parts.reduce((acc, p) => (p.type === 'ftyp' || p.type === 'moov' || p.type === 'sidx' || p.type === 'free' ? p : acc), parts[0]!);
  const initEnd = firstMoof ? firstMoof.start : lastInit.start + lastInit.size;
  const init = data.slice(0, initEnd);
  // fragments = 每个 moof 连同其后的 mdat（同属一个分片）
  const fragments: Uint8Array[] = [];
  let cur: number | null = null;
  for (const p of parts) {
    if (p.start < initEnd) continue;
    if (p.type === 'moof') {
      cur = p.start;
    } else if (p.type === 'mdat' && cur != null) {
      fragments.push(data.slice(cur, p.start + p.size));
      cur = null;
    }
  }
  // 兜底：没有 moof 的轨道（如音频轨只有 init+mdat）→ 整个媒体区作为一个片段
  if (!fragments.length && data.length > initEnd) fragments.push(data.slice(initEnd));
  return { init, fragments };
}

/** 字节序列查找（TypedArray.includes 只比较单个值，不能做子序列搜索） */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (!needle.length || needle.length > hay.length) return -1;
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** init 段里是否含视频轨（hdlr 的 'vide' 处理器类型） */
export function hasVideoTrak(init: Uint8Array): boolean {
  const VIDE = new Uint8Array([0x76, 0x69, 0x64, 0x65]); // 'vide'
  const SOUN = new Uint8Array([0x73, 0x6f, 0x75, 0x6e]); // 'soun'
  const v = indexOfBytes(init, VIDE);
  const a = indexOfBytes(init, SOUN);
  return v >= 0 && (a < 0 || v < a);
}
