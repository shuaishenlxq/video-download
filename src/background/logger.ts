// ============ 运行日志（F-508 + §7 脱敏硬约束）============
import type { LogEntry, LogLevel } from '../shared/types';
import { STORAGE_KEYS } from '../shared/messages';

const MAX_ENTRIES = 1000;

export class Logger {
  private buffer: LogEntry[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  log(level: LogLevel, module: LogEntry['module'], msg: string, detail?: string): void {
    this.buffer.push({ t: Date.now(), level, module, msg, detail });
    if (this.buffer.length > MAX_ENTRIES) this.buffer.splice(0, this.buffer.length - MAX_ENTRIES); // E-024 淘汰最旧
    this.schedulePersist();
  }
  error(m: LogEntry['module'], msg: string, detail?: string) { this.log('ERROR', m, msg, detail); }
  warn(m: LogEntry['module'], msg: string, detail?: string) { this.log('WARN', m, msg, detail); }
  info(m: LogEntry['module'], msg: string, detail?: string) { this.log('INFO', m, msg, detail); }
  debug(m: LogEntry['module'], msg: string, detail?: string) { this.log('DEBUG', m, msg, detail); }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      chrome.storage.session.set({ [STORAGE_KEYS.LOGS]: this.buffer }).catch(() => {});
    }, 500);
  }

  async load(): Promise<void> {
    try {
      const o = await chrome.storage.session.get(STORAGE_KEYS.LOGS);
      const saved = o[STORAGE_KEYS.LOGS] as LogEntry[] | undefined;
      if (saved?.length) this.buffer = saved;
    } catch { /* 会话日志丢失可接受 */ }
  }

  query(filter?: { level?: LogLevel; keyword?: string }): LogEntry[] {
    let out = this.buffer;
    if (filter?.level) {
      const rank: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
      const min = rank[filter.level];
      out = out.filter((l) => rank[l.level] >= min);
    }
    if (filter?.keyword) out = out.filter((l) => (l.msg + (l.detail ?? '')).includes(filter.keyword!));
    return out;
  }

  clear(): void {
    this.buffer = [];
    chrome.storage.session.remove(STORAGE_KEYS.LOGS).catch(() => {});
  }
}

/** 全局单例：后台各模块直接 import { log }（避免 index.ts 循环依赖） */
export const log = new Logger();

// ---------- 脱敏工具（§7.1 硬约束表）----------

/** 媒体地址脱敏：域名 + 路径前 3 段 + ***（禁止记录带签名参数的完整地址） */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).slice(0, 3).join('/');
    return `${u.hostname}/${segs}${segs ? '/' : ''}***`;
  } catch {
    return '(非法地址)';
  }
}

/** 本地路径脱敏：目录名 + /** */
export function sanitizePath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 1 ? `${parts[parts.length - 1]!}/**` : '/**';
}

/** 凭证类信息绝不落盘：只允许「已附凭证」表述 */
export function credentialsNote(has: boolean): string {
  return has ? '已附凭证' : '无凭证';
}
