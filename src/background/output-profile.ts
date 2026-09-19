// ============ 输出档案（策略模式）============
// 背景：此前扩展名/容器在任务创建处写死为视频语义——
//   `KNOWN_MEDIA_EXT` 只列视频扩展名、`outputContainer` 硬编码 'mp4'，
//   于是纯音频（如 QQ 音乐的 m4a）虽然嗅探显示为 M4A，落盘却变成 .mp4。
//
// 设计：把「输出档案 = 容器 + 扩展名 + MIME」的决策抽成策略，由工厂按媒体性质选择：
//   AudioOutputProfile（音频优先） / VideoOutputProfile（与既有视频行为逐字等价）
// 约束（用户要求）：**视频路径行为不得变化** —— VideoOutputProfile 就是原逻辑的搬运，
//   并由 output-profile.spec.ts 的回归用例锁死。

import type { MediaItem, Protocol } from '../shared/types';

export type OutputKind = 'audio' | 'video';

export interface OutputProfile {
  kind: OutputKind;
  /** 落盘容器（任务记录 / 后续转换路由使用） */
  container: string;
  /** 文件扩展名（不含点） */
  ext: string;
  /** 落盘 MIME（blob 通道下载时使用，避免被 Chrome 按 MIME 改名） */
  mime: string;
}

export interface ProfileContext {
  protocol: Protocol;
  masterUrl: string;
  /** 音频输出偏好：mp3 时统一转码输出 .mp3（规避 MP4 容器被 Chrome 误判改扩展名） */
  audioOutput?: 'original' | 'mp3';
  /** 从 URL 推断的原始扩展名（可能被站点伪装，如 .txt） */
  sourceExt: string;
  /** 嗅探到的 MIME（可能为空） */
  sourceMime?: string;
}

/** 视频容器白名单（与既有逻辑保持一致，勿随意增删） */
export const KNOWN_VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'flv', 'm4v', 'ts', 'm4s', 'avi'];
/** 音频容器白名单 */
export const KNOWN_AUDIO_EXT = ['m4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav'];

const AUDIO_MIME: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

interface OutputProfileStrategy {
  readonly kind: OutputKind;
  /** 该策略是否适用于此媒体 */
  supports(media: Pick<MediaItem, 'type'>, ctx: ProfileContext): boolean;
  resolve(ctx: ProfileContext): OutputProfile;
}

/** 音频策略：响应音频容器（m4a/mp3/aac/ogg/opus/flac/wav） */
class AudioOutputProfileStrategy implements OutputProfileStrategy {
  readonly kind: OutputKind = 'audio';

  supports(media: Pick<MediaItem, 'type'>, ctx: ProfileContext): boolean {
    if (media.type === 'audio') return true;
    if (ctx.sourceMime?.toLowerCase().startsWith('audio/')) return true;
    return KNOWN_AUDIO_EXT.includes(ctx.sourceExt);
  }

  resolve(ctx: ProfileContext): OutputProfile {
    // 用户选择「转为 MP3」：直接给出 mp3 档案（转码在离屏完成，此处只负责命名与 MIME）
    if (ctx.audioOutput === 'mp3') {
      return { kind: 'audio', container: 'mp3', ext: 'mp3', mime: 'audio/mpeg' };
    }
    const byExt = KNOWN_AUDIO_EXT.includes(ctx.sourceExt) ? ctx.sourceExt : null;
    const byMime = mimeToAudioExt(ctx.sourceMime);
    // 优先级：URL 扩展名 → MIME 推断 → 默认 m4a（MP4 家族音频最常见）
    const ext = byExt ?? byMime ?? 'm4a';
    return { kind: 'audio', container: ext, ext, mime: AUDIO_MIME[ext] ?? 'audio/mp4' };
  }
}

/** 视频策略：**与既有实现逐字等价**（含「伪装扩展名一律落 mp4」的历史修复） */
class VideoOutputProfileStrategy implements OutputProfileStrategy {
  readonly kind: OutputKind = 'video';

  supports(): boolean {
    return true; // 兜底策略
  }

  resolve(ctx: ProfileContext): OutputProfile {
    const rawExt = ctx.protocol === 'progressive' ? ctx.sourceExt : 'mp4';
    const ext = KNOWN_VIDEO_EXT.includes(rawExt) ? rawExt : 'mp4';
    return { kind: 'video', container: 'mp4', ext, mime: 'video/mp4' };
  }
}

function mimeToAudioExt(mime?: string): string | null {
  if (!mime) return null;
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m === 'audio/mp4' || m === 'audio/m4a' || m === 'audio/x-m4a') return 'm4a';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  if (m === 'audio/aac' || m === 'audio/x-aac') return 'aac';
  if (m === 'audio/ogg' || m === 'audio/opus') return 'ogg';
  if (m === 'audio/flac' || m === 'audio/x-flac') return 'flac';
  if (m === 'audio/wav' || m === 'audio/x-wav' || m === 'audio/wave') return 'wav';
  return null;
}

const STRATEGIES: OutputProfileStrategy[] = [new AudioOutputProfileStrategy(), new VideoOutputProfileStrategy()];

/** 工厂：按媒体性质选择输出档案策略（音频优先，视频兜底） */
export function resolveOutputProfile(media: Pick<MediaItem, 'type'>, ctx: ProfileContext): OutputProfile {
  const strategy = STRATEGIES.find((s) => s.supports(media, ctx)) ?? STRATEGIES[STRATEGIES.length - 1]!;
  return strategy.resolve(ctx);
}

/** 从 URL 推断原始扩展名（小写，不含 query） */
export function extFromUrl(url: string): string {
  try {
    return (new URL(url).pathname.split('.').pop() ?? '').toLowerCase();
  } catch {
    return (url.split('?')[0]!.split('.').pop() ?? '').toLowerCase();
  }
}
