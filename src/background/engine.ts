// ============ 双通道引擎检测与路由（F-401 / F-408）============
import type { EngineStatus, LocalEngineStatus } from '../shared/types';
import { LOCAL_ENGINE_VERSION } from '../shared/types';
import { STORAGE_KEYS } from '../shared/messages';
import { log } from './logger';

const ENGINE_NAME = 'com.mediasniff.engine';
let cached: EngineStatus = {
  browser: 'loading',
  local: 'not_installed',
  capabilities: defaultCaps(),
};

function defaultCaps() {
  return {
    remux: true,
    trackMerge: true,
    segmentMerge: true,
    aesDecrypt: true,
    transcode: false, // 需本地引擎
    localFileConvert: false, // 需本地引擎
  };
}

/** 浏览器内引擎就绪判定：mux.js 模块随包内置，模块加载成功即就绪（F-401 规则 3） */
export function markBrowserEngineReady(): void {
  cached.browser = 'ready';
  persist();
}

/** 本地引擎探测：native messaging ping（四态判定，F-401 规则 4） */
export async function probeLocalEngine(): Promise<LocalEngineStatus> {
  let status: LocalEngineStatus = 'not_installed';
  try {
    const resp = (await chrome.runtime.sendNativeMessage(ENGINE_NAME, { cmd: 'ping' })) as
      | { ok?: boolean; version?: string; error?: string }
      | undefined;
    if (resp?.ok && resp.version) {
      status = compareVersions(resp.version, LOCAL_ENGINE_VERSION) === 0 ? 'ready' : 'version_mismatch';
      cached.localVersion = resp.version;
    } else if (resp?.error === 'not_registered') {
      status = 'installed_unregistered';
    }
  } catch (e) {
    const msg = String(e);
    // 未安装：Native host 未找到；已安装未注册：访问被拒
    if (msg.includes('not found') || msg.includes('NotFound') || msg.includes('forbidden')) {
      status = 'not_installed';
    } else if (msg.includes('registry') || msg.includes('manifest')) {
      status = 'installed_unregistered';
    } else {
      status = 'not_installed';
    }
  }
  cached.local = status;
  cached.capabilities = { ...defaultCaps(), transcode: status === 'ready', localFileConvert: status === 'ready' };
  persist();
  log.info('engine', `本地引擎探测：${status}`, cached.localVersion ? `版本 ${cached.localVersion}` : undefined);
  return status;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function getEngineStatus(): EngineStatus {
  return cached;
}

/** 路由决策（F-401 规则 5）：仅需合并 → 浏览器内；转码/本地文件 → 本地引擎 */
export function routeEngine(needs: 'merge' | 'transcode' | 'localFile'): 'browser' | 'local' {
  if (needs === 'merge') return cached.browser === 'ready' ? 'browser' : 'local';
  return 'local'; // 调用方负责在 local 未就绪时按 E-014 引导
}

async function persist(): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.ENGINE]: cached });
  } catch { /* ignore */ }
}

export async function restoreEngineStatus(): Promise<void> {
  try {
    const o = await chrome.storage.session.get(STORAGE_KEYS.ENGINE);
    const saved = o[STORAGE_KEYS.ENGINE] as EngineStatus | undefined;
    if (saved) cached = { ...saved, capabilities: { ...defaultCaps(), ...saved.capabilities } };
  } catch { /* ignore */ }
}
