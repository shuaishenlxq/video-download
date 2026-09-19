import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  // 构建时间注入：便于用户/排查时确认浏览器里实际加载的是哪一版
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    ),
  },
  plugins: [
    react(),
    {
      // 把静态 manifest 与 popup html 之外的公共资源搬到 dist 根
      closeBundle() {
        mkdirSync(r('dist'), { recursive: true });
        cpSync(r('src/manifest.json'), r('dist/manifest.json'));
      },
    },
  ],
  build: {
    outDir: r('dist'),
    emptyOutDir: true,
    target: 'chrome109',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: r('src/popup/index.html'),
        background: r('src/background/index.ts'),
        'content-bridge': r('src/content/bridge.ts'),
        offscreen: r('src/offscreen/offscreen.html'),
      },
      output: {
        entryFileNames: (chunk) => {
          const names: Record<string, string> = {
            background: 'background.js',
            'content-bridge': 'content-bridge.js',
          };
          return names[chunk.name ?? ''] ?? 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset) => (asset.names?.[0]?.endsWith('.css') ? 'assets/[name][extname]' : 'assets/[name][extname]'),
      },
    },
  },
});
