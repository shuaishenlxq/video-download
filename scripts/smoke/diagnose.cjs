// 诊断：扩展是否加载成功 + chrome://extensions 错误读取
const path = require('node:path');
const { chromium } = require('playwright-core');

const DIST = path.resolve(__dirname, '../../dist');

(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
  try {
    await context.waitForEvent('serviceworker', { timeout: 8000 }).then(
      (sw) => console.log('SW:', sw.url()),
      () => console.log('SW: 未启动（15s 内无事件）')
    );
    const page = await context.newPage();
    await page.goto(`chrome://extensions`);
    await page.waitForTimeout(1500);
    // 打开开发者模式才能看到错误（默认可能已开）
    const info = await page.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const items = mgr?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item');
      const out = [];
      items?.forEach((it) => {
        const sr = it.shadowRoot;
        out.push({
          name: sr?.querySelector('#name')?.textContent?.trim(),
          id: it.id,
          errorsBtn: !!sr?.querySelector('#errors-button'),
        });
      });
      return out;
    });
    console.log('扩展列表:', JSON.stringify(info, null, 2));
    // 点击错误按钮读取错误
    for (const ext of info) {
      if (ext.errorsBtn) {
        await page.evaluate((id) => {
          const mgr = document.querySelector('extensions-manager');
          const item = mgr.shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelector(`#${id}`);
          item.shadowRoot.querySelector('#errors-button').click();
        }, ext.id);
        await page.waitForTimeout(800);
        const errs = await page.evaluate(() => {
          const dlg = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-error-page');
          if (!dlg) return null;
          return dlg.shadowRoot ? dlg.shadowRoot.textContent : dlg.textContent;
        });
        console.log(`扩展 ${ext.name} 错误:`, errs?.slice(0, 500));
      }
    }
  } finally {
    await context.close();
  }
})();
