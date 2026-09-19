// ============ Service Worker 入口 ============
// 铁律（MV3）：所有事件监听必须在脚本顶层同步注册，休眠唤醒后才能重新生效。
import { registerNetworkSniffer, noteTabHost, clearNoListTab } from './sniffer';
import { installDownloadNamer } from './download-namer';
import { initDnrRules } from './dnr';
import { addHint, clearTab, updateItem, restore as restoreTabs, pageTitle } from './tab-store';
import { loadSettings, saveSettings, resetSettings, admitDomain, getSettings } from './settings';
import { enqueueParse, deriveTitle } from './analyzer';
import { restoreTasks, createTask, taskCommand, listTasks, applyFetchProgress } from './task-manager';
import { sanitizeUrl, log } from './logger';
import { restoreEngineStatus, probeLocalEngine, markBrowserEngineReady, getEngineStatus } from './engine';
import { MSG, STORAGE_KEYS } from '../shared/messages';
import type { Settings, MediaHint } from '../shared/types';

// ---------- 启动恢复（SW 冷启动）----------
void (async () => {
  await Promise.all([loadSettings(), restoreTabs(), restoreTasks(), restoreEngineStatus(), log.load()]);
  // 清理上次异常退出遗留的 DNR 规则（否则 id 冲突，见 dnr.ts 注释）
  await initDnrRules();
  // 点击工具栏图标 → 打开侧边栏（Chrome 114+；旧内核静默降级）
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch { /* 无该 API 的内核 */ }
  markBrowserEngineReady(); // mux.js 随包内置，模块加载成功即就绪
  await probeLocalEngine();
  log.info('engine', '后台服务已启动', `监听已注册（顶层同步）`);
})();

// ---------- 网络层嗅探（F-101，顶层注册）----------
registerNetworkSniffer();

// ---------- 下载落盘命名裁定（顶层注册：事件不可漏，否则 m4a 会被 MIME 规范化改回 mp4）----------
installDownloadNamer();

// ---------- 探针注入 + 导航清空（F-102 / F-106 规则 3）----------
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // 页面导航/刷新：清空该 tab 媒体集合（回到无媒体态）与无清单 DASH 聚合状态
    void clearTab(tabId);
    clearNoListTab(tabId);
  }
  // 记录页面所属域（无清单 DASH 条目的 siteDomain / Referer 依据）
  if (changeInfo.url) {
    try {
      noteTabHost(tabId, new URL(changeInfo.url).hostname);
    } catch { /* ignore */ }
  }
  // 注意：不再注入主世界探针（见 injectProbe 注释——B 站兼容事故）
  void tabId;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void (async () => {
    const [{ id }] = await Promise.all([chrome.tabs.get(tabId)]);
    void id;
    await updateBadgeForActiveTab();
  })();
});

/**
 * 【已停用】主世界探针注入。
 *
 * 停用原因（2026-09-18 真实事故，实测复现）：
 *   在主世界包装 fetch/XHR 后，B 站播放器检测 Function.prototype.toString 发现非原生实现，
 *   判定环境被篡改 → 拒绝启动播放（页面黑屏、readyState 恒为 0）。
 *   二分实验证据：仅去掉探针注入即恢复正常播放。
 *
 * 能力影响：无实质损失。页面发出的所有请求（含 fetch/XHR/m3u8 分片）在网络层
 *   chrome.webRequest 全部可见；MSE 的 blob 内存流本就无法下载（仅标记「内容流」）。
 *   blob: 地址由隔离世界 DOM 扫描（video/audio 的 src 属性）采集，零侵入。
 *
 * 如未来必须启用，前提是先解决 toString 可检测问题（Proxy 方案或对
 *   Function.prototype.toString 做全局伪装——后者侵入性更强，需重新评估风险）。
 */
void injectProbeLegacy;

function injectProbeLegacy(tabId: number): Promise<void> {
  return (async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url?.startsWith('http')) return; // 浏览器内置页/商店页不注入（6.4）
      const s = getSettings();
      const host = new URL(tab.url).hostname;
      if (admitDomain(s, host) === 'deny') return; // 黑名单站点不注入探针（F-102 规则 7）
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        files: ['probe-main.js'],
      });
    } catch {
      // 受限页面（webstore/chrome://）注入失败属预期，静默
    }
  })();
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // offscreen 专属消息：offscreen.ts 自己处理
  if (msg?.target === 'offscreen') return false;

  (async () => {
    try {
      switch (msg?.type as string) {
        case 'hint': {
          // 内容桥投递的页面线索（F-102）
          const payload = (msg.payload ?? {}) as Partial<MediaHint>;
          if (!payload.url) return sendResponse({ ok: false, error: 'no_url' });
          const p = sender.tab;
          const hint: MediaHint = {
            ...payload,
            url: payload.url,
            tabId: p?.id ?? -1,
            frameId: sender.frameId ?? 0,
            source: 'page',
            isBlob: !!payload.isBlob,
            detectedAt: Date.now(),
          };
          if (hint.tabId < 0) return sendResponse({ ok: false });
          const title = await getTabTitle(hint.tabId);
          if (title) {
            hint.pageTitleSource = hint.pageTitleSource ?? title;
          }
          const r = await addHint(hint, title);
          const tabUrl = await getTabUrl(hint.tabId);
          // 页面层条目补充 pageUrl（直下 Referer 用）；清单线索立即进入解析（F-103）
          if (r?.item) {
            if (!r.item.pageUrl && tabUrl) await updateItem({ ...r.item, pageUrl: tabUrl });
            if (r.item.protocol === 'hls' || r.item.protocol === 'dash') {
              enqueueParse({ ...r.item, pageUrl: tabUrl }, tabUrl);
            }
          }
          await updateBadgeForActiveTab();
          return sendResponse({ ok: true, created: r?.created });
        }
        case 'rescanTab': {
          // 主动重扫：页面已播放/刷新扩展后，广播给内容脚本重新采集 DOM 媒体
          const overrideId = (msg.payload as { tabId?: number } | undefined)?.tabId;
          const t = overrideId != null ? await chrome.tabs.get(overrideId).catch(() => undefined) : await activeTab();
          if (t?.id) {
            await chrome.tabs.sendMessage(t.id, { type: 'mediasniff_rescan' }).catch(() => {});
          }
          return sendResponse({ ok: true });
        }
        case 'fetchProgress': {
          // offscreen 抓取通道进度（每 8MB 一次）
          const { taskId, bytes, total } = (msg.payload ?? {}) as { taskId?: string; bytes?: number; total?: number };
          if (taskId && typeof bytes === 'number') applyFetchProgress(taskId, bytes, total);
          return sendResponse({ ok: true });
        }
        case MSG.QUERY_TAB_STATE: {
          // 支持显式 tabId（调试/测试用），否则取当前激活标签页
          const overrideTabId = (msg.payload as { tabId?: number } | undefined)?.tabId;
          const tab = overrideTabId != null ? await chrome.tabs.get(overrideTabId).catch(() => undefined) : await activeTab();
          if (!tab?.id) return sendResponse({ items: [], filteredCount: 0, protectedCount: 0, parsingCount: 0, tabUrl: '' });
          const key = `${STORAGE_KEYS.TAB_STATE_PREFIX}${tab.id}`;
          const o = await chrome.storage.local.get(key);
          const state = o[key] ?? { items: [], filteredCount: 0, protectedCount: 0, parsingCount: 0 };
          return sendResponse({ ...state, tabUrl: tab.url ?? '', pageTitle: tab.title ?? '' });
        }
        case MSG.CREATE_TASK: {
          const { mediaId, tabId, variantId, audioTrackId, convert, presetId } = msg.payload ?? {};
          const key = `${STORAGE_KEYS.TAB_STATE_PREFIX}${tabId}`;
          const o = (await chrome.storage.local.get(key)) as Record<string, { items?: import('../shared/types').MediaItem[] }>;
          const items: Array<import('../shared/types').MediaItem> = o[key]?.items ?? [];
          const media = items.find((i) => i.id === mediaId);
          if (!media) return sendResponse({ ok: false, error: '媒体条目不存在' });
          const r = await createTask(media, { variantId, audioTrackId, convert, presetId });
          await updateBadgeForActiveTab();
          return sendResponse(r);
        }
        case MSG.TASK_COMMAND: {
          const { taskId, cmd } = msg.payload ?? {};
          return sendResponse(await taskCommand(taskId, cmd));
        }
        case 'listTasks':
          return sendResponse({ tasks: listTasks() });
        case MSG.GET_SETTINGS:
          return sendResponse({ settings: getSettings() });
        case MSG.SET_SETTINGS: {
          const s = await saveSettings(msg.payload as Partial<Settings>);
          log.info('ui', '设置已更新', Object.keys(msg.payload ?? {}).join(','));
          return sendResponse({ settings: s });
        }
        case MSG.RESET_SETTINGS: {
          const s = await resetSettings();
          return sendResponse({ settings: s });
        }
        case MSG.QUERY_LOGS: {
          const entries = log.query(msg.payload);
          return sendResponse({ entries });
        }
        case MSG.CLEAR_LOGS:
          log.clear();
          return sendResponse({ ok: true });
        case MSG.PROBE_ENGINE: {
          const local = await probeLocalEngine();
          return sendResponse({ engine: { ...getEngineStatus(), local } });
        }
        case MSG.CONFIRM_COMPLIANCE: {
          const s = await saveSettings({ complianceConfirmedVersion: '1.0' });
          log.info('ui', '合规声明已确认', '版本 1.0');
          return sendResponse({ settings: s });
        }
        case MSG.ADD_BLACKLIST: {
          const { domain } = msg.payload ?? {};
          const s = getSettings();
          const list = [...new Set([...s.blacklist, domain])];
          await saveSettings({ blacklist: list });
          return sendResponse({ ok: true, blacklist: list });
        }
        case MSG.EXPORT_SETTINGS:
          return sendResponse({ settings: getSettings() });
        case MSG.IMPORT_SETTINGS: {
          const incoming = msg.payload as Partial<Settings>;
          const s = await saveSettings(incoming);
          log.info('ui', '设置已导入');
          return sendResponse({ settings: s });
        }
        case MSG.PARSE_RETRY: {
          // 解析失败重试（媒体条目状态机：解析失败 → 解析中）
          const { mediaId, tabId } = msg.payload ?? {};
          const key = `${STORAGE_KEYS.TAB_STATE_PREFIX}${tabId}`;
          const o = (await chrome.storage.local.get(key)) as Record<string, { items?: import('../shared/types').MediaItem[] }>;
          const item = (o[key]?.items ?? []).find((i) => i.id === mediaId);
          if (item) enqueueParse({ ...item, pageUrl: await getTabUrl(tabId) }, await getTabUrl(tabId));
          return sendResponse({ ok: true });
        }
        default:
          return sendResponse({ ok: false, error: `unknown_message:${msg?.type}` });
      }
    } catch (e) {
      log.error('ui', `消息处理异常 ${msg?.type}`, String(e));
      return sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async
});

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getTabTitle(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.title ?? undefined;
  } catch {
    return undefined;
  }
}

async function getTabUrl(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ?? undefined;
  } catch {
    return undefined;
  }
}

// badge 更新（独立模块避免循环依赖）
import { updateBadgeForActiveTab } from './badge';

void deriveTitle;
void sanitizeUrl;
