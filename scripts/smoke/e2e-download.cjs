// 端到端：真实下载（直下通道）——popup 点击下载 → 任务完成
const path = require('node:path');
const { chromium } = require('playwright-core');

const DIST = path.resolve(__dirname, '../../dist');

async function getTabId(sw, urlPart) {
  return sw.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => t.url?.includes(part));
    return hit?.id ?? null;
  }, urlPart);
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  };
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:8138/index.html`);
    await page.waitForTimeout(2000);
    const targetTabId = await getTabId(sw, '127.0.0.1:8138');
    check('找到测试页 tabId', targetTabId != null, String(targetTabId));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/index.html?tabId=${targetTabId}`);
    await popup.waitForTimeout(800);

    // 过合规门（勾选框文本在 aria-label）
    await popup.click('button[aria-label="我已阅读并理解上述内容"]');
    await popup.click('button:has-text("确认并继续")');
    await popup.waitForTimeout(500);

    // 找 sample.mp4 条目的 kebab 菜单
    const item = popup.locator('.mitem', { hasText: 'sample' }).first();
    check('找到 sample.mp4 条目', await item.count() > 0);
    await item.locator('.kebab').click();
    await popup.waitForTimeout(300);
    // 点「下载」（菜单里第一个非 off 的下载项）
    await popup.locator('.menu .mi', { hasText: '下载' }).first().click();
    check('点击下载', true);

    // 切到任务 tab 等完成
    await popup.locator('.tab', { hasText: '任务' }).click();
    let done = false;
    for (let i = 0; i < 10; i++) {
      await popup.waitForTimeout(1000);
      const t1 = await popup.locator('.task.done', { hasText: 'sample' }).count();
      if (t1 > 0) {
        done = true;
        break;
      }
    }
    check('直下任务完成', done);
    await popup.screenshot({ path: '/tmp/ms-e2e-task.png' });

    // 验证文件真的落盘（SW 上下文中 filename 会被 Chrome 脱敏为 UUID，以 state 为准）
    const dl = await sw.evaluate(async () => {
      const list = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
      return list.map((d) => ({ state: d.state, bytes: d.bytesReceived, mime: d.mime }));
    });
    console.log('downloads:', JSON.stringify(dl));
    check('文件落盘 downloads API', dl.some((d) => d.state === 'complete' && d.bytes > 0), JSON.stringify(dl[0]));
  } catch (e) {
    check('E2E 流程', false, String(e).slice(0, 300));
  } finally {
    await context.close();
    process.exit(failures ? 1 : 0);
  }
})();
