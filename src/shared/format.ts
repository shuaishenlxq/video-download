// ============ 格式化工具（纯函数）============
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatEta(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `剩 ${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `剩 ${m}m${String(s).padStart(2, '0')}s`;
}

export function formatSpeed(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return '';
  return `${formatBytes(bps)}/s`.replace(' ', ' ');
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

const QUALITY_HEIGHTS: Array<{ min: number; label: string }> = [
  { min: 4320, label: '4320p' },
  { min: 2160, label: '4K' },
  { min: 1440, label: '2K' },
  { min: 1080, label: '1080p' },
  { min: 720, label: '720p' },
  { min: 480, label: '480p' },
  { min: 360, label: '360p' },
  { min: 0, label: '低清' },
];

export function resolutionOf(res?: string): { pixels: number; height: number; label: string } {
  const m = res?.match(/^(\d+)[xX×](\d+)$/);
  if (!m) return { pixels: 0, height: 0, label: '' };
  const w = Number(m[1]);
  const h = Number(m[2]);
  const label = QUALITY_HEIGHTS.find((q) => h >= q.min)?.label ?? '';
  return { pixels: w * h, height: h, label };
}
