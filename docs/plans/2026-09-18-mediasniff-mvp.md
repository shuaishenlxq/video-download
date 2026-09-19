# MediaSniff V1.0 功能实现计划（MVP 核心闭环 + 全量 P0/P1/P2）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按 `docs/PRD-MediaSniff-V1.0.md` 与 `design/MediaSniff-UI-Overview-v1.html` 实现 MediaSniff（媒探）Chrome MV3 扩展：三路嗅探 → 列表 → 下载（直下 / HLS / DASH / AES-128）→ 浏览器内合并落盘，UI 按原型 1:1 双主题。

**Architecture:** MV3 多入口 Vite 构建。后台 SW 负责嗅探/调度/下载（状态全部持久化，顶层注册监听）；主世界探针挂钩 fetch/XHR/MSE；Offscreen Document 负责重封装合并与 objectURL 落盘；分片二进制存 IndexedDB；popup React 单浮层三标签。处理引擎零 wasm：TS→MP4 用 mux.js，fMP4 双轨合并自研 box 级拼接器。

**Tech Stack:** Vite 6 + React 19 + TypeScript(strict) + vitest + mux.js + @types/chrome。UI 样式直接移植设计稿 CSS（CSS 变量双主题），不引入 Tailwind——设计稿 CSS 是已验证的完整设计系统，翻译成 Tailwind 是纯返工（KISS）。

**范围裁定（用户已确认"全部功能"）：**
- F-101~F-508 全做；F-309 直播录制 PRD 定义性排除（标记"本期不支持"，E-020）。
- 本地引擎本体是独立桌面程序（非本次交付），扩展侧做实：native messaging 探测四态 + 安装引导 + 版本比对 + 任务路由；无引擎时转码类动作按 E-014 给引导，不静默降级。
- WebM→MP4 跨容器重封装不做（VP8/9 需重编码，违反复封装定义）→ 直存 WebM + 兼容性提示（符合 F-402 规则 6）。

---

## 硬约束备忘（实现时随时对照）

| 约束 | 落实点 |
|------|--------|
| SW 休眠丢内存 | 所有监听 `src/background/index.ts` 顶层同步注册；状态写 storage（任务 local / 媒体 session） |
| SW 无 DOM/createObjectURL | 组装/落盘全部在 offscreen（reason `BLOBS`） |
| 禁远端代码 | 引擎资源全部随包（mux.js 打包），无任何 CDN 加载 |
| 下载接口不带自定义头 | fetch 通道 + DNR session rule 改写 Referer（`declarativeNetRequestWithHostAccess`） |
| 主世界注入 | manifest 静态声明仅隔离世界 bridge；探针用 `chrome.scripting.executeScript({world:'MAIN'})`（Chrome 95+，覆盖 109 基线） |
| 失败不丢成本 | 分片完成清单持久化；重试/暂停/重启续传同一逻辑；失败保留分片 |
| 不产出静默损坏 | 合并后校验容器头 + 时长偏差；失败不落盘 |
| 内存水位 | 峰值估算 = 体积 × 1.6（mux 双缓冲系数）；阈值 = deviceMemory×1024×25%；超限拒绝合并引导本地引擎 |
| 日志脱敏 | 只记「域名+路径前3段+***」；凭证/密钥/页面标题绝不落盘 |
| 进度节流 | 400ms 批量写 storage（IX-03） |

## 存储划分

| 数据 | 位置 | 生命周期 |
|------|------|---------|
| 媒体条目（按 tabId 分组）+ 过滤统计 | `storage.session` | 页面导航清空 |
| 下载任务 + 分片完成清单 | `storage.local` | 重启后置"已暂停"（E-013） |
| 分片二进制（Blob） | IndexedDB `ms-segments`（后台写入，offscreen 读取合并） | 任务结束/清理时删 |
| 设置 | `storage.local` `settings` | 持久 |
| 运行日志 ring(1000) + 脱敏 | `storage.session` `logs` | 会话 |
| 合规确认版本 | `storage.local` | 持久（LG-09） |

## 消息协议（popup ↔ background ↔ offscreen）

`{type, payload}`，全部常量收口 `src/shared/messages.ts`：
`sniff/queryState` `task/create` `task/command{pause|resume|cancel|retry|remove|saveVideoOnly|retryAudio}` `settings/get|set` `log/query|clear|export` `engine/probe` `popup/ready`
Offscreen：`merge/hls` `merge/dash` `save/blob`（结果经 storage 回传，不传 Blob）。

---

## Phase 0：工程骨架（Task 1-3）

### Task 1: 仓库初始化与脚手架
- `git init` + `.gitignore`（node_modules/dist/.DS_Store）
- `package.json`：react/react-dom/mux.js + devDeps(vite/@vitejs/plugin-react/typescript/@types/chrome/@types/react*/vitest)
- `tsconfig.json` strict、`vite.config.ts` 多入口（popup html、background、content-bridge、probe-main、offscreen html）、`vitest.config.ts`
- 验证：`npm run build` 产出 dist 可加载骨架（manifest v3 空壳）→ commit

### Task 2: manifest 与图标生成
- `scripts/gen-icons.mjs`：零依赖 PNG 编码器（zlib + IHDR/IDAT/IEND）+ 4× 超采样光栅化，产出 gray/idle/ring/locked 四态 × 16/32/48/128
- manifest：permissions(storage, downloads, offscreen, scripting, tabs, notifications, webRequest, declarativeNetRequestWithHostAccess, nativeMessaging)、host_permissions `["<all_urls>"]`、content_scripts(bridge, all_frames)、action、icons、web_accessible_resources（探针不需要——用 scripting API 注入）
- 验证：图标 PNG 用 `file` 命令校验尺寸；dist 加载 Chrome 无报错（用户侧人工验证留到最后）→ commit

### Task 3: shared 类型与工具
- `src/shared/types.ts`：MediaHint/MediaItem/Variant/Track/DownloadTask/Settings/LogEntry/EngineStatus 全量类型（对齐 PRD 字段表）
- `src/shared/messages.ts`、`src/shared/format.ts`（bytes/duration/time 格式化）、`src/shared/id.ts`（去重键哈希）
- TDD：format.spec（字节 428MB/1.2GB、时长 01:23:45/--:--）
- commit

## Phase 1：纯逻辑层（TDD，Task 4-8）

### Task 4: m3u8 解析器（F-103）
- `src/background/parser/m3u8.ts`：master（EXT-X-STREAM-INF: BANDWIDTH/RESOLUTION/CODECS/AUDIO → variants 排序分辨率降序、带宽兜底）；media（EXTINF 累加时长、EXT-X-KEY(METHOD/URI/IV)、EXT-X-MEDIA、EXT-X-ENDLIST→live、EXT-X-BYTERANGE、分片序号）
- 加密映射：NONE/AES-128/SAMPLE-AES（规则对齐 F-110）
- tests: master/media/加密/live/相对URL解析/缺RESOLUTION兜底 → commit

### Task 5: mpd 解析器（F-103）
- `src/background/parser/mpd.ts`：Period/AdaptationSet/Representation、mediaPresentationDuration、SegmentTemplate($Number$/$Time$/$RepresentationID$/$Bandwidth$/$Time$)、SegmentList、ContentProtection→drm、type=dynamic→live
- 变体展开成 segment URL 序列生成器（纯函数）
- tests: 模板展开/双轨识别/DRM/live → commit

### Task 6: 归并去重（F-104）
- `src/background/media-store.ts`（纯逻辑部分）：归一化（剥 `_t/_ts/token/expire`）、去重键（清单URL+时长 → URL+分辨率+体积）、分片并入清单、DASH 双轨归并、变体并入不换位
- tests: 分片不重条/变体归并/跨帧去重/不同媒体不误合并 → commit

### Task 7: 命名模板引擎（F-307）
- `src/shared/naming.ts`：10 个变量、非法字符过滤、变量缺失空串+分隔符压缩、150 长度截断、校验（必含 title/index）、实时预览
- tests: 全变量/缺失降级/非法字符/超长/校验失败 → commit

### Task 8: 队列调度器 + 内存水位 + 图标状态机（F-306/F-402/F-106）
- `src/background/tasks/queue.ts`：任务并发(默认2)、分片并发(默认4)、处理槽位=1、FIFO、自适应降速档位、重启恢复置暂停
- `src/background/memory.ts`：峰值估算与水位判定（纯函数，deviceMemory 注入）
- `src/background/icon-state.ts`：no_media/detecting/detected(n)/protected/running 五态推导（纯函数）
- tests: 排队顺序/处理槽位互斥/降速降档/水位拒绝/角标9+ → commit

## Phase 2：扩展骨架（Task 9-12）

### Task 9: 后台嗅探（F-101）
- `src/background/sniffer.ts`：webRequest onCompleted/onResponseStarted 观察型（顶层注册）；识别链 URL扩展名→MIME→Content-Range→特征库；60s 去重窗口；黑名单丢弃（F-109 判定）；tabId/frameId 归属
- `src/background/filters.ts`：类型/体积/扩展名过滤 + filteredCounts 统计（空态成因判定用）
- commit

### Task 10: 内容探针（F-102）
- `src/content/probe-main.ts`：主世界挂钩 fetch/XHR(open+send)/URL.createObjectURL/MSE(addSourceBuffer+appendBuffer)/HTMLMediaElement.src setter；完全静默透传（保留原返回值/异常/this）；postMessage 单向投递 `{__mediasniff__: hint}`
- `src/content/bridge.ts`：隔离世界接收 window message → runtime.send；DOM 扫描 video/audio/source（src/currentSrc/poster）+ MutationObserver 增量；iframe all_frames
- 后台 `injector.ts`：tabs.onUpdated 顶层监听，`chrome.scripting.executeScript` MAIN 注入探针（命中黑名单不注入）；导航清 tab 媒体集合
- commit

### Task 11: 清单解析编排 + 元数据（F-103/F-105）
- `src/background/analyzer.ts`：线索→清单抓取（fetch credentials:include + DNR Referer）→ m3u8/mpd 解析 → 变体/轨道/加密/直播标注；解析失败降级"仅记录地址"（E-001/002）
- `src/background/metadata.ts`：标题来源优先级链（页面标题→元素title→文件名→站点+时间）、时长/体积兜底、非法字符过滤
- commit

### Task 12: offscreen 管家 + 分片存储 + 日志系统
- `src/background/offscreen-manager.ts`：hasDocument/setup（reason BLOBS）
- `src/background/tasks/segments.ts`：IDB 封装（put/get/delete/clear/list/孤儿清理），分片名补零对齐
- `src/background/logger.ts`：ring 1000、级别过滤、脱敏（§7.1 硬约束表）、任务生命周期日志挂 task 记录
- tests: logger 脱敏单测 → commit

## Phase 3：下载引擎（Task 13-16）

### Task 13: 直下通道（F-301）
- `src/background/tasks/direct-task.ts`：通道选择（无需自定义头→chrome.downloads；需要→fetch 内存转存 offscreen 落盘）；>200MB 内存通道提示；Range 续传；速度/进度节流上报；同名冲突策略（F-308 rename/overwrite(确认)/skip）
- commit

### Task 14: HLS 管线（F-302/F-304/F-305）
- `src/background/tasks/hls-task.ts`：三阶段状态机（下载→解密→合并）；分片并发调度（复用 queue.ts 的 SegmentPool）；指数退避 500ms×2^n 上限 8s、最大 3 次；错误分流（超时/429降并发/401不重试/404缺失≤2继续）；AES-128：密钥抓取（IV 缺省用 Media Sequence 16 字节大端）、WebCrypto AES-CBC 逐片解密
- 合并经 offscreen：`merge/hls` → mux.js Transmuxer 流式推入 → 输出 Blob → IDB 暂存 → 校验（ftyp/tfdt 时长偏差）→ objectURL + chrome.downloads → 清理
- 校验失败：保留分片 + "重新合并"入口（E-009）
- commit

### Task 15: DASH 双轨管线（F-303）
- `src/background/tasks/dash-task.ts`：视频/音频两子任务并行、总进度按字节加权；音轨选择（语言→最高码率）；音频轨失败→"部分成功"+两出口（E-026）；时长差>1s 裁短 + >10% 告警
- `src/offscreen/mp4merge.ts`：自研 fMP4 双轨合并——box 解析（moov/mvhd/trak/trex/mfhd/tfhd/tfdt/trun）→ 新 moov 合并双 trak（音轨 track_ID 重编号）→ 视频片段流 + 音频片段流顺序拼接（mfhd sequence 全局重写），不重编码
- 合并校验失败 → 降级分轨导出 + 显式告知（规则 7）
- tests: mp4merge box 重编号（合成 fixture）→ commit

### Task 16: 引擎检测与路由（F-401/F-408）
- `src/background/engine.ts`：浏览器内引擎 ready（mux.js 模块加载成功即就绪）；本地引擎 `sendNativeMessage('com.mediasniff.engine', {cmd:'ping'})` → 四态（ready/installed_unregistered/not_installed/version_mismatch，version 比对）
- 路由表：仅合并→browser；转码/本地文件→local（无引擎→E-014 引导，不静默降级）；超水位→降级链（规则 5）
- `下载并转换` 编排（F-403）：合并完成→转码子任务（依赖本地引擎）；转换规则匹配（F-406：扩展名/域名）
- commit

## Phase 4：Popup UI（Task 17-22，按设计稿 1:1）

### Task 17: 设计系统与外壳
- `src/popup/styles/tokens.css` + `components.css`（从设计稿 CSS 移植，`data-theme` 双主题，384px）
- `Theme.tsx`（跟随系统/浅/深 + storage 持久化）、TopBar（logo/任务 pill/关闭）、Tabs、Toast(2s/4s)、Confirm（五处二次确认）
- commit

### Task 18: 下载器视图（F-201~209）
- MediaList：条目（缩略图/时长角标/标题/mono 规格/徽标 res·dash·enc·drm·err）、kebab 菜单、变体展开（radio/推荐标）、骨架加载态
- 筛选 seg（全部/视频/音频）+ 搜索（标题/时长/体积）+ 排序 + 批量选择条（全选/已选/批量下载）
- 空态三成因判定（DRM＞被过滤＞无媒体）+ 骨架条目；DRM 说明浮层（P-02 文案）；引擎引导浮层
- 操作菜单：下载/快速下载/下载并转换(需引擎置灰+引导)/复制地址/新标签页预览/加入黑名单（E-021 重复下载聚焦既有任务）
- commit

### Task 19: 任务面板（F-208）
- 统计行（进行中/已完成/暂停全部/清除记录）；任务行（名称/域名/进度条/阶段标签 下载中·解密中·合并中(indet)/速度剩余/引擎标注/暂停取消）
- 分组：进行中/已完成(打开文件夹)/已失败(原因+已保留分片+重试/查看日志/移除)；DASH 双轨子进度；部分成功两出口
- commit

### Task 20: 设置页（F-501~505/507）
- 合规卡（已确认态）；嗅探设置（类型/体积范围/扩展名 chips/域名过滤三模式+增删+导入导出+刷新提示 note）
- 下载设置（并发×分片+峰值提示/命名模板+变量 chips+实时预览+校验/保存位置三模式+子目录+冲突策略/快速下载确认开关/完成通知）
- 转换设置（预设列表 CRUD/参数微调/规则——标注需本地引擎）；通用（语言/主题）；隐私说明（F-507）
- 底栏：运行日志/关于与合规/恢复默认（二次确认）
- commit

### Task 21: 日志视图 + 合规首用 + 引导页
- P-07 日志：级别 seg/搜索/清空/导出；P-06 首用合规（勾选→确认）；引擎状态卡（四态+cmdline+重新检测）；本地引擎安装指引二级视图（下载安装包开新标签）
- commit

### Task 22: 图标状态接线（F-106）
- `src/background/icon-state.ts` 应用到 chrome.action（setIcon 四态文件 + setBadgeText 数字 9+/lock + 颜色）；tabs.onActivated/onUpdated 重算；后台标签页不动效
- commit

## Phase 5：集成交付（Task 23-25）

### Task 23: 全量 build + 测试绿 + 手工冒烟清单
- `npm run test` 全绿、`npm run build` 零错误；dist 打 zip（用户可拖入 chrome://extensions 加载）
- 冒烟清单文档（测试站点建议、验证路径）
### Task 24: overview.md 更新 + 记忆沉淀
### Task 25: present_files 交付（zip + 冒烟清单 + 计划文档）

---

## 关键算法备忘

**AES-128 IV 缺省**：`Media Sequence Number` 转 16 字节大端。
**退避**：`delay = min(500 * 2^retry, 8000)`；429/503 时 `delay = 8000` 且 `segmentConcurrency--`（下限 1），连续 20 次成功后 `+1` 恢复。
**分片进度分母校准**：实测累计字节 / 已完成片数 × 总片数，与预估偏差 >30% 时重置分母并记日志（6.3）。
**fMP4 双轨合并**：新 moov = 视频 trak + 音轨 trak（track_ID=2），mvex 追加音轨 trex；mdat 数据流 = 视频 init 后接全部视频 moof+mdat，再音频 init 后全部音频 moof+mdat；每个 moof 的 mfhd.sequence_number 重写为全局递增；音轨 traf 的 tfhd.track_ID 重写为 2。校验：双 sidx 非必需，用 moof 数与 tfdt 时间轴抽样校验。
**TS→MP4（mux.js）**：`new muxjs.Transmuxer()` 逐片 push，'data' 事件收 initSegment+segments，最终拼合；首片解析失败→"格式不支持"降级（F-402 规则 4）。
**复合 Blob 合并**：`new Blob(idbBlobs)` 浏览器磁盘背板，不全量进内存——这满足"流式分块"水位约束；水位估算仍做前置拦截（双保险）。
