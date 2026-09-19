// ============ 任务面板（F-208 / P-05）============
import { useState } from 'react';
import type { DownloadTask } from '../shared/types';
import { MSG, send } from '../shared/messages';
import { formatBytes, formatEta, formatSpeed } from '../shared/format';
import { PauseIcon, XIcon, CheckCircle, FolderIcon, AlertIcon, EngIcon } from './icons';
import { useToast } from './store';

export function TaskView({ tasks }: { tasks: DownloadTask[] }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [, showToast] = useToast();
  const cmd = async (taskId: string, c: string) => {
    await send(MSG.TASK_COMMAND, { taskId, cmd: c });
    showToast(c === 'cancel' ? '任务已取消' : '已执行');
  };

  const active = tasks.filter((t) => ['queued', 'downloading', 'decrypting', 'merging', 'transcoding'].includes(t.stage));
  const done = tasks.filter((t) => t.stage === 'done');
  const failed = tasks.filter((t) => t.stage === 'failed' || t.stage === 'paused');

  const stageLabel = (t: DownloadTask): { text: string; merge?: boolean } => {
    switch (t.stage) {
      case 'queued': return { text: '排队中' };
      case 'downloading': return { text: '下载中' };
      case 'decrypting': return { text: '解密中' };
      case 'merging': return { text: '合并中', merge: true };
      case 'transcoding': return { text: '转码中', merge: true };
      default: return { text: t.stage };
    }
  };

  const pct = (t: DownloadTask): number | null => {
    if (t.stage === 'merging' || t.stage === 'transcoding') return null; // IX-04 不确定态
    if (t.totalSegments > 0) return Math.min(100, (t.completedSegments / t.totalSegments) * 100);
    if (t.totalBytes && t.bytes > 0) return Math.min(100, (t.bytes / t.totalBytes) * 100);
    return t.stage === 'done' ? 100 : 0;
  };

  return (
    <div className="view">
      <div className="tstats">
        <div className="c">进行中 <b>{active.length}</b></div>
        <div className="c ok">已完成 <b>{done.length}</b></div>
        <div className="acts">
          <button className="ghost-btn" onClick={() => void Promise.all(active.map((t) => cmd(t.id, 'pause')))}>暂停全部</button>
          <button className="ghost-btn" onClick={() => void Promise.all(tasks.map((t) => cmd(t.id, 'remove')))}>清除记录</button>
        </div>
      </div>

      {active.length === 0 && done.length === 0 && failed.length === 0 && (
        <div className="empty">
          <h4>暂无下载任务</h4>
          <p>在「下载器」中选择媒体开始下载</p>
        </div>
      )}

      {/* 进行中 */}
      {active.map((t) => {
        const st = stageLabel(t);
        const p = pct(t);
        return (
          <div className="task" key={t.id}>
            <div className="t1">
              <span className="nm">{t.title}</span>
              <span className="dom">{t.siteDomain}</span>
            </div>
            {t.protocol === 'dash' && t.trackProgress ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {t.trackProgress.map((tp) => (
                  <div key={tp.trackId}>
                    <div className="pbar" style={{ height: 5 }}>
                      <div className="fill" style={{ width: `${tp.totalSegments ? (tp.completedSegments / tp.totalSegments) * 100 : 0}%`, opacity: tp.type === 'audio' ? 0.6 : 1 }} />
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                      {tp.type === 'video' ? '视频轨' : '音频轨'} {tp.completedSegments}/{tp.totalSegments}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pbar">
                <div className={`fill ${p == null ? 'indet' : ''}`} style={p != null ? { width: `${p}%` } : undefined} />
              </div>
            )}
            <div className="t2">
              <span className={`stage ${st.merge ? 'merge' : ''}`}>{st.text}</span>
              <span>
                {t.stage === 'merging' || t.stage === 'transcoding'
                  ? `分片 ${t.completedSegments}/${t.totalSegments} 已完成`
                  : [
                      t.totalBytes ? `${formatBytes(t.bytes)} / ${formatBytes(t.totalBytes)}` : formatBytes(t.bytes),
                      t.speedBps > 0 ? formatSpeed(t.speedBps) : null,
                      t.etaSec != null ? formatEta(t.etaSec) : null,
                    ].filter(Boolean).join(' · ')}
              </span>
              <span className="eng"><EngIcon />{t.engine === 'browser' ? '浏览器内处理' : '本地引擎处理'}</span>
              <span className="ctrl">
                <button className="icon-btn" onClick={() => void cmd(t.id, 'pause')} aria-label="暂停" style={{ opacity: st.merge ? 0.4 : 1 }}>
                  <PauseIcon />
                </button>
                <button className="icon-btn" onClick={() => void cmd(t.id, 'cancel')} aria-label="取消">
                  <XIcon />
                </button>
              </span>
            </div>
          </div>
        );
      })}

      {/* 已完成 */}
      {done.length > 0 && (
        <>
          <button className="tgroup" style={{ border: 'none', background: 'transparent', width: '100%' }} onClick={() => setCollapsed((c) => ({ ...c, done: !c.done }))}>
            <span className="chev">{collapsed.done ? '▸' : '▾'}</span>已完成 ({done.length})
          </button>
          {!collapsed.done && done.map((t) => (
            <div className="task done" key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="t1">
                <span className="okic"><CheckCircle /></span>
                <span className="nm">{t.title}</span>
                <span className="dom">{t.bytes ? formatBytes(t.bytes) : ''}</span>
                <span className="ctrl">
                  <button className="icon-btn" onClick={() => void cmd(t.id, 'openFolder')} title="打开文件夹"><FolderIcon /></button>
                  <button className="icon-btn" onClick={() => void cmd(t.id, 'remove')} aria-label="移除"><XIcon /></button>
                </span>
              </div>
              <div className="t2" style={{ color: 'var(--text-3)', fontSize: 11 }}>
                {t.engine === 'browser' ? '浏览器内处理' : '本地引擎处理'}
                {t.protocol === 'dash' ? ' · DASH 双轨' : ''}
                {t.outputFilename ? ` · ${t.outputFilename}` : ''}
              </div>
            </div>
          ))}
        </>
      )}

      {/* 已失败 / 已暂停 */}
      {failed.length > 0 && (
        <>
          <button className="tgroup" style={{ border: 'none', background: 'transparent', width: '100%', color: 'var(--danger)' }} onClick={() => setCollapsed((c) => ({ ...c, failed: !c.failed }))}>
            <span className="chev">{collapsed.failed ? '▸' : '▾'}</span>已失败 / 已暂停 ({failed.length})
          </button>
          {!collapsed.failed && failed.map((t) => (
            <div className="task fail" key={t.id}>
              <div className="t1"><span className="nm">{t.title}</span></div>
              <div className="reason">
                <AlertIcon />
                <span>
                  {t.stage === 'paused' ? '已暂停' : `失败：${t.errorMessage ?? '未知原因'}`}
                  {t.completedSegmentIndexes.length > 0 && (
                    <span className="keep"> · 已保留 {t.completedSegmentIndexes.length} 个分片，重试不从头开始</span>
                  )}
                </span>
              </div>
              {/* E-026 部分成功：两个出口 */}
              {t.partialSuccess && (
                <div className="factors">
                  <button className="btn" style={{ padding: '5px 14px', fontSize: 11.5 }} onClick={() => void cmd(t.id, 'saveVideoOnly')}>仅保存视频（无声音）</button>
                  <button className="btn line" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => void cmd(t.id, 'retryAudio')}>重试音频轨</button>
                </div>
              )}
              <div className="factors">
                {t.stage !== 'paused' || true ? (
                  <button className="btn" style={{ padding: '5px 14px', fontSize: 11.5 }} onClick={() => void cmd(t.id, 'retry')}>{t.stage === 'paused' ? '继续' : '重试'}</button>
                ) : null}
                {(t.errorCode === 'merge_validation' || t.errorCode === 'merge_failed') && (
                  <button className="btn line" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => void cmd(t.id, 'remerge')}>重新合并</button>
                )}
                <button className="btn line" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => void cmd(t.id, 'remove')}>移除</button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
