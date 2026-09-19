// ============ App 根组件：主题 + 合规门 + 三标签导航 ============
import { useEffect, useState } from 'react';
import type { Settings } from '../shared/types';
import { MSG, send } from '../shared/messages';
import { useTabState, useTasks, useSettings } from './store';
import { Logo, CloseIcon, LogIcon } from './icons';
import { MediaListView } from './MediaListView';
import { TaskView } from './TaskView';
import { SettingsView } from './SettingsView';
import { LogView, ComplianceView } from './InfoViews';

type Tab = 'list' | 'tasks' | 'settings';
type Overlay = null | 'log' | 'about' | 'engine';

export function App() {
  const [tab, setTab] = useState<Tab>('list');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settings, update] = useSettings();
  const tabState = useTabState();
  const tasks = useTasks();
  const [anchor, setAnchor] = useState<string | null>(null);

  // 主题（F-501：跟随系统/浅/深）
  useEffect(() => {
    const apply = () => {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = settings.theme === 'system' ? (prefersDark ? 'dark' : 'light') : settings.theme;
      document.documentElement.setAttribute('data-theme', theme);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  const openSettingsAt = (a?: string) => {
    setAnchor(a ?? null);
    setOverlay(null);
    setTab('settings');
  };

  const activeCount = tasks.filter((t) => ['queued', 'downloading', 'decrypting', 'merging', 'transcoding'].includes(t.stage)).length;

  // 首次使用合规门（F-506）
  if (!settings.complianceConfirmedVersion) {
    return (
      <div className="popup">
        <TopBar tasks={0} />
        <ComplianceView confirmed={false} mode="gate" onConfirm={() => void send(MSG.CONFIRM_COMPLIANCE).then(() => update({ complianceConfirmedVersion: '1.0' } as Partial<Settings>))} />
      </div>
    );
  }

  return (
    <div className="popup">
      <TopBar tasks={activeCount} onOpenTasks={() => setTab('tasks')} onOpenLog={() => { setTab('tasks'); setOverlay('log'); }} />
      <div className="tabs">
        <button className={`tab ${tab === 'list' && !overlay ? 'active' : ''}`} onClick={() => { setTab('list'); setOverlay(null); }}>下载器</button>
        <button className={`tab ${tab === 'tasks' && !overlay ? 'active' : ''}`} onClick={() => { setTab('tasks'); setOverlay(null); }}>
          任务{activeCount > 0 && <span className="n">{activeCount}</span>}
        </button>
        <button className={`tab ${tab === 'settings' && !overlay ? 'active' : ''}`} onClick={() => { setTab('settings'); setOverlay(null); }}>设置</button>
      </div>

      {overlay === 'log' ? (
        <LogView onBack={() => setOverlay(null)} />
      ) : overlay === 'about' ? (
        <ComplianceView confirmed mode="about" onConfirm={() => undefined} />
      ) : overlay === 'engine' ? (
        <ComplianceView confirmed mode="about" onConfirm={() => undefined} />
      ) : tab === 'list' ? (
        <MediaListView
          state={tabState}
          tasks={tasks}
          settings={settings}
          onOpenSettings={openSettingsAt}
          onOpenLog={() => setOverlay('log')}
        />
      ) : tab === 'tasks' ? (
        <TaskView tasks={tasks} />
      ) : (
        <SettingsView
          settings={settings}
          update={update}
          anchor={anchor}
          onOpenLog={() => setOverlay('log')}
          onOpenAbout={() => setOverlay('about')}
          onOpenEngine={() => setOverlay('engine')}
        />
      )}
    </div>
  );
}

function TopBar({ tasks, onOpenTasks, onOpenLog }: { tasks: number; onOpenTasks?: () => void; onOpenLog?: () => void }) {
  return (
    <div className="topbar">
      <Logo />
      <div className="brand">媒探<span>MediaSniff</span></div>
      <div className="spacer" />
      {tasks > 0 && (
        <div className="task-pill" onClick={onOpenTasks}>任务 <b>{tasks}</b></div>
      )}
      {onOpenLog && (
        <button className="icon-btn" onClick={onOpenLog} aria-label="运行日志" title="运行日志">
          <LogIcon />
        </button>
      )}
      <button className="icon-btn" onClick={() => window.close()} aria-label="关闭">
        <CloseIcon />
      </button>
    </div>
  );
}
