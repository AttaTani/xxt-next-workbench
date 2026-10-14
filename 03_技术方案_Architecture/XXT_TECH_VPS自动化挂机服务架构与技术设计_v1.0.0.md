# 学习通 VPS 自动化后台挂机服务 —— 架构与技术设计文档

> **文档性质**：项目核心技术架构与 Agent 意图全景设计规范  
> **文档位置**：本地工程根目录 (`c:\Users\Atta\Desktop\学习通\`)  
> **保密与部署要求**：纯本地持久化归档，严禁同步/泄露至公网或未加密 VPS 环境。

---

## 1. 项目背景与 Agent 演进意图

### 1.1 业务背景
本项目最初源自基于油猴（Tampermonkey）的浏览器前端挂机脚本（`v3_optimized.js`），用于在 PC 浏览器端辅助完成超星/学习通网课的视频播放、任务点识别和章节跳转。然而，本地浏览器挂机存在以下严重限制：
1. **强依赖本地开机与前台窗口**：电脑关机或睡眠即中断，无法实现 24 小时无人值守。
2. **失焦与被动暂停拦截**：学习通页面监听窗口焦点与鼠标轨迹，后台最小化容易触发页面暂停。
3. **不可控的交互打断**：课程视频中途弹题、风控验证码（如【9010】操作异常）频发，导致本地挂机极易卡死。

### 1.2 上下文与 Agent 意图还原（任务崩溃前分析）
通过对挂掉的会话记录（Session `d26a6b5b` 及终端日志）深度回溯，还原出 Agent 的全部核心意图与演进链路：
1. **系统架构转型**：将原本依赖桌面浏览器的油猴脚本，彻底重构为**基于 Playwright Headless 的 Linux VPS 后台常驻服务**，并接入 `systemd` 守护进程。
2. **可视化控制台与人机协同**：构建轻量级 Express + Web 管理面板（端口 `3888`），提供二维码扫码登录、实时截屏推流、倍速调控与运行日志面板。
3. **复杂 DOM 与跨域 Iframe 穿透**：学习通播放器嵌套在深层 Iframe（如 `mooc1-2.chaoxing.com/ananas/modules/video/index.html`），Agent 意图设计全局遍历与针对性选择器穿透，实现对 `video` 标签与 `videojs` 播放器的直接控制。
4. **视频暂停根因阻断与主动驱动**：
   - 用户反馈 *“打开视频了，但是播放被暂停了”*。
   - Agent 分析发现视频暂停由两重因素导致：一是防作弊事件冒泡（`blur`/`visibilitychange`），二是**超星反爬图片验证码【9010 操作异常】拦截**。
5. **风控验证码闭环机制**：开发 `/api/captcha` 接口并在 Web 前端提供验证码浮层，使外部/人工能够对无头浏览器遭遇的验证码进行远程答码与恢复。
6. **任务终结原因**：Agent 在完成 9010 验证码提交、验证视频正常推进（`currentTime` 从 64s 推进到 71s）并准备输出总结时，本地代理网络通道（10809 端口）发生异常重置（`EOF`），导致会话意外终止。

---

## 2. 系统总体架构设计

系统由 **无头自动化核心引擎 (Engine)**、**Web 服务与 API 路由层 (Server)**、**轻量级监控运维前端 (Dashboard)**、以及 **Linux 系统级守护层 (Systemd)** 组成。

```mermaid
flowchart TD
    subgraph Client ["用户端 / 控制端"]
        Browser["本地浏览器 (Web 控制台)"]
        MobileApp["学习通手机 App (扫码端)"]
    end

    subgraph VPS ["东京 VPS 服务端 (tokyo:3888)"]
        subgraph WebLayer ["Web 通信层 (web.js)"]
            API_State["/api/state (状态轮询)"]
            API_QR["/api/login (二维码)"]
            API_Captcha["/api/captcha (验码提交)"]
            API_Screen["/api/screenshot (画面流)"]
            StaticUI["/public (HTML/CSS 控制台)"]
        end

        subgraph EngineLayer ["自动化引擎 (engine.js)"]
            PW_Context["Playwright Persistent Context"]
            SessionMgr["Cookie/Session 持久化管理器"]
            AntiCheat["防失焦/防暂停 Hook 注入器"]
            FrameTraverser["多层 Iframe 深度穿透器"]
            PlaybackDriver["Video.js 幂等播放驱动器"]
            CatalogRouter["课程大纲与小节智能路由"]
            CaptchaDetector["9010 风控验证码探测器"]
        end

        subgraph XuexitongCloud ["学习通官方云端"]
            Passport["统一认证中心 (passport2)"]
            CourseCatalog["课程大纲页 (studentcourse)"]
            StudyPage["播放学习页 (studentstudy)"]
            VideoFrame["Ananas 视频 Iframe (Frame 6)"]
        end
    end

    Browser -->|查看实时画面/日志/输验证码| WebLayer
    MobileApp -->|扫码授权| Passport
    WebLayer -->|RPC 控制/状态提取| EngineLayer
    PW_Context -->|持久化认证| Passport
    CatalogRouter -->|寻找未完成节点| CourseCatalog
    FrameTraverser -->|注入 Hook & 监控进度| VideoFrame
    PlaybackDriver -->|幂等 play() & 1.5x 倍速| VideoFrame
```

---

## 3. 核心功能模块设计

### 3.1 认证生命周期与持久化机制 (Session Persistence)
- **隔离式用户数据目录**：使用 Playwright 的 `launchPersistentContext(userDataDir, ...)`，保证 LocalStorage、IndexedDB 和缓存文件持久落盘。
- **Cookie 双重持久化**：
  - 定期或登录成功时提取 `context.cookies()`，以格式化 JSON 保存在 `userData/auth_state.json`。
  - 引擎每次重新初始化时，若文件存在则执行 `context.addCookies()`，避免每次重启都需要重新扫码。
- **登录状态探测状态机**：
  - 访问 `https://i.chaoxing.com/base`，若重定向至 `passport2.chaoxing.com/login` 则切入 `NEED_LOGIN` 状态。
  - 定位 `#quickCode` 元素截图生成 Base64 二维码并通过 Web 控制台下发。
  - 启动 180s 异步轮询监视器，监听 URL 跃迁，成功登录后进入 `LOGGED_IN` 并自动调起挂机任务。

### 3.2 课程入口智能识别与大纲路由 (Catalog Auto-Navigation)
为解决用户直接输入课程主页（而非具体小节播放页）的问题，设计大纲智能路由策略：
- **URL 模式识别**：匹配链接中包含 `studentcourse` 或非 `studentstudy` 的课程地址。
- **任务点扫描矩阵**：穿透主文档与所有嵌套子 Frame，检索未完成状态标记：
  - 标记选择器集合：`.orange`, `span.orange`, `em.orange`, `.roundpoint`, `.catalog_point_round`, `.jobCheckRound:not(.green)`。
  - 结构回溯：通过 `closest('li')` 或 `.posCatalog_item` 回溯包含小节名称的链接锚点。
- **自动触发跳转**：对首个未完成小节执行 `scrollIntoView()` 并触发点击，监听新页面/新标签页生成，平滑迁移主页面句柄。

### 3.3 深度嵌套 Iframe 穿透与视频播放驱动 (Playback Engine)
学习通的视频组件通常位于两到三层深度的 Iframe 内部（外层为 `iframe[name*="ans-cc"]`，内层为 `ananas/modules/video/index.html`）。

#### (1) 全局防作弊与防暂停 Hook
在循环监视器中，对所有激活的 Frame 注入防失焦代码：
```javascript
Object.defineProperty(document, 'hidden', { value: false, writable: false });
Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
const block = (e) => { e.stopImmediatePropagation(); };
window.addEventListener('blur', block, true);
window.addEventListener('mouseleave', block, true);
window.addEventListener('mouseout', block, true);
document.addEventListener('visibilitychange', block, true);
```

#### (2) 幂等播放驱动（杜绝 Toggle 陷阱）
传统自动化脚本常犯错误是盲目点击播放按钮（`click()`），但在视频已开始缓冲或播放时再次点击会导致**人为暂停**。本设计采用严格的幂等控制逻辑：
1. **探测原生 Video 元素**：检测 `document.querySelector('video')`。
2. **提取 Video.js 实例**：从 `window.videojs.players` 抓取活跃实例。
3. **状态判定与驱动**：
   - 仅当 `v.paused && !v.ended` 时，优先调用 `vjs.play()` 或原生 `v.play()`。
   - 强制设置静音（`v.muted = true`），防止被现代浏览器“未静音自动播放受限”策略拦截。
   - 仅在视频起始位置（`currentTime < 0.5`）才点击 `.vjs-big-play-button`。
   - 动态同步倍速设置（默认为 1.5 倍速）。

#### (3) 视频中途答题拦截自愈
定时扫描播放器内弹出的测验组件：
- 识别 `.ans-videoquiz-opt input` 及 `.ans-videoquiz label`，自动选择首选项。
- 触发提交按钮（`.ans-videoquiz-submit`），解冻视频播放挂起状态。

### 3.4 反爬机制与【9010】验证码闭环应对 (Anti-Spider Handler)
学习通服务器对异常频繁请求或云服务机房 IP（如机房 IDC 节点）会下发 `【9010】操作异常` 验证码页面。
- **拦截感知**：页面主体或子 Frame 渲染包含 `【9010】`、`请输入图片中的验证码` 的表单。
- **画面透传**：监视器每 3 秒刷新全屏截图并推送至前端控制台。
- **接口化提单**：`/api/captcha` 接收人工或后续 OCR 识别的 4 位验证码，自动定位 `input[type="text"]` 输入并点击提交。
- **状态恢复**：提单成功并等待页面重新加载后，自动化循环自动恢复视频播放监测。

### 3.5 章节完成度判定与平滑切节 (Sequential Progression)
- **完成阈值策略**：当 `currentTime / duration >= 0.96` 或触发 `ended` 事件时，视为当前任务点达标。
- **小节切换 Fallback 矩阵**：
  1. 优先点击当前选中项（`.posCatalog_select, .cur`）的下一个同级节点（`nextElementSibling`）。
  2. 其次全局搜索下一个带有 `.orange` 未完成标记的小节。
  3. 最后兜底触发界面上的“下一任务点”控件（`#prevNextFocusNext, .nextChapter`）。

---

## 4. 接口规范与数据模型 (API Specification)

服务默认监听 `0.0.0.0:3888`，所有通信采用 JSON 格式。

### 4.1 获取运行状态 (`GET /api/state`)
- **响应格式**：
```json
{
  "status": "RUNNING",
  "config": {
    "port": 3888,
    "playbackRate": 1.5,
    "courseUrl": "https://mooc1-2.chaoxing.com/...",
    "headless": true
  },
  "currentInfo": {
    "title": "项羽其人",
    "unit": "3.2 项羽其人",
    "progress": "7% (71s/918s)",
    "playing": true,
    "rate": 1.5,
    "url": "https://mooc1-2.chaoxing.com/..."
  },
  "qrBase64": null,
  "logs": [
    { "time": "16:34:32", "msg": "[挂机中] 正在播放视频: 7% (71s/918s)", "type": "info" }
  ],
  "hasScreenshot": true,
  "lastScreenshotTime": 1791909115000
}
```

### 4.2 提交验证码 (`POST /api/captcha`)
- **请求负载**：
```json
{
  "code": "KRSY"
}
```
- **业务逻辑**：查找 `#checkCode, input[placeholder*="验证码"]` 填入字符并触发提交，等待 3000ms 返回当前页面 URL。

### 4.3 任务控制接口
- `POST /api/start`：启动/恢复挂机，可传入 `{ courseUrl, playbackRate }`。
- `POST /api/stop`：暂停挂机定时器与播放驱动。
- `POST /api/next`：强制触发跳转下一小节。
- `POST /api/speed`：动态调整播放倍速 `{ rate: 1.5 }`。
- `POST /api/login`：请求刷新扫码二维码。
- `GET /api/screenshot`：输出最新页面 PNG 字节流（`Cache-Control: no-cache`）。

---

## 5. 关键痛点、防御策略与技术债务分析

| 痛点场景 | 表现特征 | 根因机理 | 应对策略 / 技术规范 |
| :--- | :--- | :--- | :--- |
| **字符乱码** | 终端出现 `?` 或乱码字符 | Windows GBK 控制台与 Linux UTF-8 交互编码不一致 | 代码与输出流全量统一为 UTF-8；文件写入强制显式指定 `'utf8'` |
| **播放假死** | 画面停滞在特定秒数 | 触发失焦检测，或误触发了双击暂停逻辑 | 注入全局 `Object.defineProperty` 冻结 `hidden`；调用幂等 `v.play()` 禁止点击画面 |
| **【9010】反爬** | 页面弹框阻塞视频播放 | 机房 IP 行为特征被超星 WAF 标记，下发图形验证码 | 建立实时截图面板 + `/api/captcha` 远程补录机制；预留自动化 OCR 接口切片 |
| **多 Frame 跨域** | 控制台抛出 Cross-Origin 异常 | 浏览器安全沙箱限制跨域 Frame 互访 | 严禁通过父窗口 `iframe.contentWindow.document` 穿透，改用 Playwright 原生 `page.frames()` 单独求值 |
| **会话意外中断** | 本地 Agent 报错 EOF 退出 | 本地网络连接或专线代理端口（10809）不稳定中断 | 架构解耦：所有挂机服务全部由 VPS 本地 systemd 守护，Agent 仅作为配置与审计客户端，Agent 挂掉不影响服务端持续运行 |
