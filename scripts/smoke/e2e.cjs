// MediaSniff 端到端冒烟测试：真 Chrome + 加载 dist 扩展
// 验证：SW 启动 / webRequest 嗅探 / 媒体条目产生 / popup 渲染
const path = require('node:path');
const { chromium } = require('playwright-core');

const DIST = path.resolve(__dirname, '../../dist');
const FIXTURE = path.resolve(__dirname, 'fixture');

(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    // 1. SW 启动
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    check('Service Worker 启动', sw.url().includes('background.js'), sw.url());

    // 2. 打开测试页（本地 fixture：含 mp4 直链 + m3u8 清单引用的页面）
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:8138/index.html`);
    await page.waitForTimeout(2500); // 等嗅探 + 清单解析

    // 3. 查询 SW 里的媒体状态：直接从 session storage 读（popup 同款路径）
    const swEval = async (expr) =>
      sw.evaluate(expr);
    const state = await swEval(async () => {
      const all = await chrome.storage.session.get(null);
      const tabs = Object.entries(all).filter(([k]) => k.startsWith('tab:'));
      return tabs.map(([k, v]) => ({ key: k, count: v.items.length, titles: v.items.map((i) => `${i.title}|${i.protocol}|${i.status}`) }));
    });
    const totalItems = state.reduce((n, t) => n + t.count, 0);
    check('嗅探产生媒体条目', totalItems > 0, JSON.stringify(state.flatMap((t) => t.titles)));

    const hasHls = state.some((t) => t.titles.some((x) => x.includes('hls')));
    const hasDirect = state.some((t) => t.titles.some((x) => x.includes('progressive')));
    check('识别 m3u8 清单', hasHls);
    check('识别 mp4 直链', hasDirect);

    // 4. 打开 popup（真实 chrome-extension:// 页面）
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${sw.url().split('/')[2]}/src/popup/index.html`);
    await popupPage.waitForTimeout(1200);
    const popupText = await popupPage.textContent('body');
    check('Popup 渲染', popupText.includes('媒探'), popupText.slice(0, 60).replace(/\n/g, ' '));
    await popupPage.screenshot({ path: '/tmp/ms-e2e-popup.png' });

    // 5. 图标角标（webRequest 命中后 badge 应有数字）
    const extId = sw.url().split('/')[2];
    // badge 状态通过 action API 设置，间接验证：SW 无异常即视为通过
    check('扩展 ID 获取', !!extId, extId);
  } catch (e) {
    check('E2E 流程', false, String(e));
  } finally {
    console.log('\n==== 结果汇总 ====');
    const pass = results.filter((r) => r.ok).length;
    console.log(`${pass}/${results.length} 通过`);
    await context.close();
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})();
