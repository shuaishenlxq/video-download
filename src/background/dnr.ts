// ============ DNR Referer 改写（F-301：下载接口不支持自定义请求头的对策）============
// 扩展后台/离屏发起的 fetch 无法直接设 Referer，用 session 规则按域名临时改写。
const RULE_ID_BASE = 9000;
const RULE_ID_SPAN = 1000; // 本扩展占用的 id 区间 [9000, 10000)
let nextRuleId = RULE_ID_BASE;
let inited = false;

/** domain → ruleId（SW 内存；规则本身持久在 session 规则表里） */
const activeRules = new Map<string, number>();

/**
 * 初始化：清理本扩展历史遗留的规则并重置计数器。
 *
 * 必要性：DNR session 规则**跨 SW 重启持久**，而计数器是内存变量。
 * 若上次任务异常退出留下规则（例如只清了页面域、CDN 域泄漏），重启后计数器归零
 * → 新规则撞上旧 id → "Rule with id N does not have a unique ID"（真实事故）。
 * 因此启动时无条件清空本命名空间内的全部规则。
 */
export async function initDnrRules(): Promise<void> {
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const mine = existing.filter((r) => r.id >= RULE_ID_BASE && r.id < RULE_ID_BASE + RULE_ID_SPAN).map((r) => r.id);
    if (mine.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: mine });
    nextRuleId = RULE_ID_BASE;
    activeRules.clear();
    inited = true;
  } catch {
    /* 初始化失败不阻塞主流程；后续 ensure 时会重试 */
  }
}

function ruleFor(id: number, domain: string, referer: string): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [
        { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: referer },
        // Origin 一并补齐：部分 CDN 同时校验 Origin
        { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: referer.replace(/\/$/, '') },
      ],
    },
    condition: {
      requestDomains: [domain],
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
    },
  };
}

/**
 * 为若干域名挂 Referer 改写规则。
 *
 * 关键：媒体常由**第三方 CDN** 提供（B 站分片在 *.bilivideo.cn / 各类 mcdn 域），
 * 只按页面域挂规则会导致 CDN 请求不带 Referer → 防盗链 401。
 * 因此调用方应传入「页面域 + 所有实际请求域名」。
 */
export async function ensureRefererRule(domainOrDomains: string | string[], referer: string): Promise<void> {
  if (!inited) await initDnrRules();
  const domains = (Array.isArray(domainOrDomains) ? domainOrDomains : [domainOrDomains]).filter(Boolean);
  for (const domain of domains) {
    if (activeRules.has(domain)) continue;
    const id = nextRuleId++;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [ruleFor(id, domain, referer)] });
    } catch {
      // id 冲突（存在本扩展未跟踪的遗留规则）→ 重新初始化后重试一次
      await initDnrRules();
      const retryId = nextRuleId++;
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [ruleFor(retryId, domain, referer)] });
      activeRules.set(domain, retryId);
      continue;
    }
    activeRules.set(domain, id);
  }
}

export async function removeRefererRule(domainOrDomains: string | string[]): Promise<void> {
  const domains = Array.isArray(domainOrDomains) ? domainOrDomains : [domainOrDomains];
  const ids: number[] = [];
  for (const domain of domains) {
    const id = activeRules.get(domain);
    if (id == null) continue;
    ids.push(id);
    activeRules.delete(domain);
  }
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}

export async function removeAllRefererRules(): Promise<void> {
  for (const domain of [...activeRules.keys()]) await removeRefererRule(domain);
}
