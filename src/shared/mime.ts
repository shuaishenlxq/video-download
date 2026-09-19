// ============ 输出 MIME 映射（纯函数）============
// 事故背景：offscreen 落盘的 Blob 若不指定 type，Chrome 判定为 text/plain，
// 会把文件名扩展名强制改成 .txt（覆盖 downloads API 的 filename 参数）。
export function mimeForFilename(filename: string): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    ts: 'video/mp2t',
    m4s: 'video/iso.segment',
    flv: 'video/x-flv',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
  };
  return map[ext] ?? 'video/mp4';
}
