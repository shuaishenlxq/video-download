// 诊断：m3u8 条目为何停留在 parsing —— 读运行日志 + 轮询状态
const path = require('node:path');
const { chromium } = require('playwright-core');

const DIST = path.resolve(__dirname, '../../dist');

(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:8138/index.html`);
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1500);
      const logs = await sw.evaluate(async () => {
        const o = await chrome.storage.session.get('logs');
        return (o.logs ?? []).slice(-8).map((l) => `${l.level} ${l.module}: ${l.msg}${l.detail ? ' | ' + l.detail : ''}`);
      });
      const state = await sw.evaluate(async () => {
        const all = await chrome.storage.session.get(null);
        return Object.entries(all).filter(([k]) => k.startsWith('tab:')).flatMap(([, v]) => v.items.map((i) => `${i.title} [${i.protocol}/${i.status}] enc=${i.encryption}`));
      });
      console.log(`--- t+${(i + 1) * 1.5}s ---`);
      console.log('条目:', state);
      console.log('日志:', logs);
      if (state.some((s) => s.includes('hls/ready') || s.includes('hls/parse_failed'))) break;
    }
  } finally {
    await context.close();
  }
})();
