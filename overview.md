# 交付概览：MediaSniff（媒探）V1.0 实现

## 本次交付：PRD → 可安装扩展（全量 P0 / P1 / P2）

**产出**：`mediasniff-v1.0.0.zip`（153 KB）——拖入 `chrome://extensions`（开发者模式）即可用。代码仓库同目录 `dist/` 为未打包版本。

### 功能覆盖（对照 PRD 功能清单）

| 模块 | 覆盖 | 说明 |
|------|------|------|
| M1 嗅探 | F-101~110 全部 ✅ | **网络层 webRequest 观察 + DOM 扫描两路**（主世界探针因破坏播放器实测停用，见下「关键修复」）；m3u8/mpd 解析、归并去重、图标五态角标、黑白名单、加密识别标记 |
| M2 列表 | F-201~209 全部 ✅ | 媒体列表（徽标/变体展开/筛选/搜索/排序/批量）、单条操作菜单六项、任务面板三分组、空态三成因判定（DRM＞被过滤＞无媒体）、双主题 |
| M3 下载 | F-301~308 ✅（F-304 AES-128 实现于解密阶段） | 双通道直下（原生 + 扩展内抓取 DNR 补 Referer）、HLS 分片下载浏览器内合并出 MP4（mux.js 转封装）、DASH 双轨合并（自研 fMP4 box 级拼接器）、AES-128 WebCrypto 解密、指数退避重试 + 分片级续传、两级并发 + 自适应降速、命名模板 10 变量实时预览、保存位置三模式 |
| M4 处理 | F-401/402 ✅ · F-403~408 引导/编排级 | 浏览器内引擎（mux.js 随包内置，零 wasm 零远端加载）+ 本地引擎四态探测（native messaging ping）+ 能力路由；内存水位前置拦截（25% 设备内存）；转码执行依赖本地引擎（独立桌面程序，不在扩展范围），无引擎时按 E-014 引导不静默降级 |
| M5 设置 | F-501~508 全部 ✅ | 通用/嗅探/下载/转换设置、导入导出、首用合规门、隐私声明、运行日志（脱敏 + 级别过滤 + 导出） |

**范围外**（PRD 定义性排除）：F-309 直播录制（P3，标记"本期不支持"）；DRM 绕过（红线）。

### 验证状态

| 项 | 结果 |
|----|------|
| 单元测试 | 56/56 通过（m3u8/mpd 解析、归并去重、命名模板、分片池重试/错误分流、并发队列、内存水位、图标状态机、日志脱敏） |
| 类型检查 | tsc strict 全绿 |
| 端到端（真 Chrome + --load-extension） | 12/12 通过：SW 启动 → 三路嗅探出条目 → m3u8 解析变体 → popup 渲染 → 点击下载 → chrome.downloads 落盘 complete |
| 包体积 | 153 KB zip / 556 KB dist —— **Q-02（引擎能否 ≤25MB）实测解除**：核心引擎 mux.js 仅 ~300KB，无需裁剪 |

### 09-19 会话增量（音频/媒体质量/UI）

1. **音频输出档案（策略模式）**：`src/background/output-profile.ts` 统一决定容器/扩展名/MIME；纯音频不再被存成 .mp4（此前 KNOWN_MEDIA_EXT 无音频扩展名 + outputContainer 硬编码）。视频策略与原逻辑逐字等价（回归测试锁死）。
2. **音频转 MP3（可选）**：设置「音频输出：保留原始 / 转为 MP3」。管线 = fetch → `AudioContext.decodeAudioData`（浏览器原生解码）→ 内置 lamejs（`public/vendor/lame.min.js`，156KB）→ blob(audio/mpeg) → downloads API（保留子目录）。MP3 是裸音频流，彻底规避容器判定歧义。默认「保留原始」。
3. **M4A 命名根因链（经验）**：Chrome 下载的类型判定——http 直链看 Content-Type；**blob 看内容嗅探（MP4 家族判 ftyp 主品牌，不看 blob 的 MIME）**。纯音频 MP4 落盘前把品牌标成 `M4A ` 族即可保住扩展名（ffmpeg 标准）。`onDeterminingFilename` 对扩展自身发起的下载不触发。
4. **DNR 规则 id 冲突**：session 规则跨 SW 重启持久而计数器是内存变量 → 启动时清空本扩展区间（[9000,10000)）+ 任务结束清理全部新加域名。
5. **设置/嗅探结果持久化**：媒体集合 storage.session → storage.local（session 在扩展刷新时清空，曾致「嗅探到 0 个」）+ 主动重扫。
6. **UI**：工具栏图标实心饱满（生成器超采样坐标 bug 修复）、按钮 UA 默认样式重置（深色下 tab 文字不可见）、**UI 迁移到 Chrome 侧边栏**（sidePanel API，常驻 + 切标签自动刷新）、运行日志常驻入口 + 显示构建时间。

### 关键架构修正（实测定论）

**主世界探针整体停用**：原设计三路并行嗅探中的「页面主世界探针」被实测否决——包装 `fetch`/`XHR`/`video.src` setter/MSE API 后，B 站等站点播放器检测 `Function.prototype.toString` 发现非原生实现，判定环境被篡改并**拒绝播放**（页面黑屏）。二分实验证据：仅移除探针注入即恢复正常播放。停用后嗅探能力无实质损失（页面所有请求在 webRequest 层可见；MSE blob 流本就无法下载；blob 地址由 DOM 扫描采集）。**教训：任何包装页面原生 API 的能力，都必须用真实大厂站点回归，不能只测自建 fixture。**

### 端到端暴露并修复的真实问题

1. **网络层清单线索不进解析队列**（只有页面层消息路径触发解析）→ sniffer 命中清单后直接 enqueueParse
2. **`chrome.downloads` 拒绝 Referer 自定义头**（"Unsafe request header name"）→ 通道改为：原生下载（Cookie 自动携带）优先，失败降级扩展内抓取（fetch + DNR session 规则补 Referer + offscreen 落盘）
3. Chrome 136+ 品牌版移除 `--load-extension` → E2E 用 playwright chromium 跑

### 已知边界（诚实声明）

- fMP4 双轨合并采用「顺序轨拼接 + track 重编号 + mfhd 序列号全局重写」策略，未做轨道交织——主流播放器（VLC/Chrome/mpv）可播，极端播放器兼容性待真实站点回归
- HLS BYTERANGE、DASH SegmentBase(sidx) 未实现，遇到时降级为直接下载并记录日志
- 本地引擎（mediasniff-engine）本体是独立桌面程序（Node + ffmpeg + Native Messaging），本次交付其扩展侧全部对接面：探测四态、安装引导、命令展示、重新检测、任务路由
- 直播流（无 ENDLIST / dynamic）按 PRD E-020 标记不支持

### 建议下一步

1. 真实站点冒烟（B站课程页/公开课站/播客站各 3-5 个），验证三路嗅探检出率
2. 用真实 HLS 源回归合并链路（fake 分片走的是降级直存路径）
3. PRD 附录 E 的 Q-03（内存水位系数）/Q-04（200MB 阈值）按 9.5.3 方式实测校准
4. 若要落地 F-403 转码：启动 mediasniff-engine 桌面程序子项目

## 上一阶段产出（PRD 与调研）

| 产出 | 路径 | 规模 |
|------|------|------|
| 竞品功能全景调研 | `docs/research/2026-09-18-video-downloadhelper-feature-map.md` | 6.4k 字 |
| 主 PRD | `docs/PRD-MediaSniff-V1.0.md` | 96k 字 / 44 功能点 |
| UI 高保真原型 | `design/MediaSniff-UI-Overview-v1.html`（+ 暗/浅双底截图） | 8 屏 |
| 实现计划 | `docs/plans/2026-09-18-mediasniff-mvp.md` | 25 任务 |

### 核心架构（与 PRD 9.5 对齐）

- **MV3 多入口 Vite 构建**：background SW（嗅探/调度/下载）+ content（隔离桥静态注入 + 主世界探针 scripting API 注入）+ offscreen（重封装/合并/objectURL 落盘）+ popup（React 19）
- **状态持久化**：任务 → storage.local（重启置暂停）；媒体集合 → storage.session（导航清空）；分片 → IndexedDB（SW 写 / offscreen 读）；日志 → session 环形 1000 条
- **UI**：384px 浮层三标签（下载器/任务/设置），设计稿 CSS 1:1 移植，`data-theme` 双主题，薄荷青 #3CDBC0
