# MediaSniff 冒烟清单（人工验证指引）

## 安装

1. 打开 `chrome://extensions` → 右上角开启「开发者模式」
2. 方式 A：解压 `mediasniff-v1.0.0.zip` → 「加载已解压的扩展程序」选解压目录
3. 方式 B：直接「加载已解压的扩展程序」选仓库 `dist/` 目录

## 基础链路（已在 CI 化 E2E 中验证 ✅）

- [x] 扩展加载无报错（chrome://extensions 无错误按钮）
- [x] 打开含 mp4/音频/页面 JS 拉流的页面 → 工具栏图标变彩色 + 角标数字
- [x] 点击图标 → 首用合规门 → 勾选确认 → 媒体列表出现条目
- [x] 直下 mp4 → 任务面板「下载中」→「已完成」→ 文件在 ~/Downloads/MediaSniff/

## 真实站点回归（待人工执行）

| 场景 | 站点类型 | 验证点 |
|------|---------|--------|
| 渐进式直下 | 公开课/博客嵌视频 | 列表出现 → 下载 → 播放正常 |
| HLS 点播 | m3u8 测试源（如 test-streams.mux.dev） | 变体展开 → 选清晰度 → 下载 → 合并出 MP4 → 时长正确 |
| HLS AES-128 | 加密 m3u8 源 | 「AES-128」徽标 → 下载 → 解密合并成功 |
| DASH 双轨 | dash.js 参考源 | 「DASH 双轨」徽标 → 双进度条 → 合并有声音 |
| DRM 站点 | Widevine 平台 | 「受保护」徽标 + 下载禁用 + DRM 说明浮层 |
| 直播流 | news live | 「直播 · 本期不支持」标记 |
| 噪音过滤 | 广告多的站 | 加入黑名单 → 刷新后该域不再检测 |
| 断点续传 | 大文件 HLS | 中途暂停 → 继续（分片不重下）；失败 → 重试（跳过已完成） |
| 深色模式 | 系统深色 | 设置→外观→深色：暗底浅字可读 |

## 已知降级路径（出现时不是 bug）

- fake/异常分片 → mux.js 产出为空 → 自动降级为原始 TS 拼接保存（文件名 .ts）
- 合并校验失败 → 保留分片 + 「重新合并」按钮（任务面板失败组）
- 缺失分片 ≤2 → 继续合并并警告；>2 → 中止报告缺失数
- 「下载并转换」无本地引擎 → 引导浮层（仅合并无需安装）

## 开发命令

```bash
npm run build     # 类型检查 + 构建到 dist/
npm run test      # vitest 56 用例
npm run icons     # 重新生成工具栏图标
npm run zip       # 打包 dist → mediasniff-v1.0.0.zip
node scripts/smoke/e2e.cjs          # 嗅探链路 E2E（需先起 fixture：python3 -m http.server 8138 scripts/smoke/fixture）
node scripts/smoke/e2e-download.cjs # 下载链路 E2E
```

注意：E2E 需 playwright chromium（`npx playwright-core cli.js install chromium`）；品牌版 Chrome 136+ 已移除 `--load-extension`。
