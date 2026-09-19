// ============ 工具栏图标状态机（F-106，纯函数）============
import type { MediaItem, DownloadTask } from '../shared/types';

export interface IconStateInput {
  items: MediaItem[];
  tasks: Pick<DownloadTask, 'id' | 'stage'>[];
}

export interface IconState {
  icon: 'gray' | 'idle' | 'ring' | 'locked';
  badge: string | null; // 数字或 9+；解析中不计数
}

/** PRD F-106：无媒体灰 / 检测中彩无角标 / 已检测彩+数字 / 全部DRM锁 / 任务中叠加进度环 */
export function deriveIconState({ items, tasks }: IconStateInput): IconState {
  const activeTask = tasks.some((t) => ['downloading', 'decrypting', 'merging', 'transcoding', 'queued'].includes(t.stage));
  const downloadable = items.filter((i) => i.downloadable && i.status !== 'parsing' && i.status !== 'hint');
  const allProtected = items.length > 0 && items.every((i) => !i.downloadable);

  let icon: IconState['icon'] = 'gray';
  let badge: string | null = null;

  if (items.length === 0) {
    icon = activeTask ? 'ring' : 'gray';
  } else if (allProtected) {
    icon = 'locked';
  } else if (downloadable.length > 0) {
    icon = activeTask ? 'ring' : 'idle';
    badge = downloadable.length > 9 ? '9+' : String(downloadable.length);
  } else if (items.some((i) => i.status === 'parsing' || i.status === 'hint')) {
    icon = activeTask ? 'ring' : 'idle';
  }

  return { icon, badge };
}
