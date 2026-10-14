# 🚀 xxt-next-workbench (学习通 Next)

> **大模型驱动 · 自愈沙箱热修 · 多租户并发 · 全景 Web 学习托管工作台**  
> *An autonomous, self-healing headless learning engine powered by LLMs & Playwright.*

[![License: WTFPL](https://img.shields.io/badge/License-WTFPL-brightgreen.svg)](http://www.wtfpl.net/about/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-1.40%2B-red.svg)](https://playwright.dev/)
[![Status](https://img.shields.io/badge/Status-Production%20Ready-brightgreen.svg)](#)

`xxt-next-workbench` 是一套专为超星学习通打造的高可用、无头化（Headless）、多租户并发的自动化学习与任务托管平台。结合大语言模型智能答题、自愈沙箱热修补门禁与双轨运行架构，兼顾本地家庭宽带原生抗风控与云端 VPS 24/7 无人值守常驻能力。

---

## 🌟 核心架构与特性

### 1. 🛡️ 多账号并发与物理会话隔离 (Multi-Tenant Architecture)
- 基于 Playwright 独立 `launchPersistentContext` 机制，为每个账号分配独立的 `userDataDir` 数据目录与 Cookie/Storage。
- 账号物理级隔离，支持多用户任务并行调度、独立暂停/续跑，彻底杜绝多账号串号与状态污染问题。

### 2. ⚡ 双轨部署架构 (Dual-Track Engine)
- **本地家庭宽带直连轨**：开箱即用，通过原生宽带出口彻底免除超星“9010”等异地机房 IP 风控限制；提供桌面快捷方式一键静默启动。
- **云端 VPS 守护轨**：原生适配 Linux Systemd 守护单元，支持内存熔断保护（`MemoryMax=1.5G`）、崩溃毫秒级自愈与开机自启。

### 3. 🧠 大模型随堂测验 & 独立章节测验智能答题 (AI Exam Solver)
- 支持接入主流大模型（如 DashScope 通义千问、OpenAI 兼容接口、Anthropic 等）。
- 自动解析题目类型（单选、多选、判断题），语义推导最佳答案，支持自动回填与防中途退出护盾。

### 4. 🔬 自愈沙箱五道防爆门禁 (Autonomous Self-Heal Sandbox)
- 当学习通前端页面结构发生变更（播放器选择器失效、弹窗变动）时，触发自主诊断。
- 内置 **五道防爆门禁**：
  1. `SyntaxGate`：语法结构完整性校验
  2. `ASTAuditor`：静态语法树安全扫描，禁止越权操作
  3. `SandboxIsolation`：隔离环境防死循环保护
  4. `RuleVerification`：选择器字典合规审计
  5. `SafeRollback`：自动化安全备份与瞬时秒级回滚

### 5. 🖥️ 去模板化控制台 UI (Modern Web Console)
- 内置轻量现代化控制面板（端口 `3888`）：
  - 扫码登录：支持终端字符码与 Web 面板实时渲染超星登录二维码；
  - 任务监控：多账号实时进度展示、倍速动态切换（1.0x - 2.0x）、状态告警；
  - 安全鉴权：支持配置 `ADMIN_TOKEN` 访问口令，避免公网越权访问。

---

## 📂 项目工程规范与结构

本项目严格遵循标准化高可用工程生命周期规范进行目录分层：

```text
├── 00_规范与指南_Standards/         # 全生命周期工程规范与标准文档
├── 01_源码工程_Source/              # 生产环境核心工程源码
│   ├── accountManager.js          # 多租户账号生命周期与凭据持久化
│   ├── engine.js                  # Playwright 无头浏览器执行引擎
│   ├── examSolver.js              # 大模型智能答题与题目解析器
│   ├── taskManager.js             # 任务分发与优先级调度队列
│   ├── taskWorker.js              # 单课程工作单元守护进程
│   └── web.js                     # Express HTTP 服务与 WebSocket 控制台
├── 02_产品需求_PRD/                 # 需求规划书与阶段规格说明 (PRD)
├── 03_技术方案_Architecture/        # 核心技术架构、自愈沙箱与多租户设计文档
├── 04_视觉原型_Prototypes/          # 控制台 UI 原型与页面设计资产
├── 05_测试与验收_QA/                # 自动化测试用例、回归验证脚本与验收报告
├── 06_部署与运维_Ops/               # Windows 快捷脚本与 Linux Systemd 运维配置
├── 99_历史归档_Archive/             # 历史原型脚本与遗留系统归档
├── vps-service/                     # 云端/本地多端部署优化配置与自愈沙箱模块
├── .env.example                     # 环境变量模板
└── package.json                     # 项目配置与 NPM 脚本声明
```

---

## 🚀 快速上手

### 1. 环境准备
- **Node.js**：`>= 18.0.0`
- **npm**：`>= 9.0.0`
- **Playwright 浏览器核心**

```bash
# 克隆仓库
git clone https://github.com/AttaTani/xxt-next-workbench.git
cd xxt-next-workbench

# 安装项目依赖
npm install

# 安装 Playwright 所需的 Chromium 运行时
npx playwright install chromium
```

### 2. 配置环境变量
复制环境配置模板：
```bash
cp .env.example .env
```
根据实际需要编辑 `.env`：
```dotenv
# 大模型智能答题配置（若无需自动答题可留空）
DASHSCOPE_API_KEY=your_dashscope_api_key_here
OPENAI_BASE_URL=https://maas.qianwenaiapi.com/compatible-mode/v1

# 控制台管理口令（可选，配置后访问 Web 面板需口令认证）
ADMIN_TOKEN=your_custom_admin_token
```

### 3. 启动服务

#### 方式 A：本地终端前台运行
```bash
npm start
```
启动后终端将输出访问链接，浏览器打开 `http://127.0.0.1:3888` 即可进入工作台。

#### 方式 B：Windows 本地双轨桌面一键启停
如果你在 Windows 环境下使用，可执行一键创建桌面快捷方式：
```bash
npm run setup:shortcuts
```
执行后会在桌面生成 3 个快捷图标：
- `一键启动挂机`：后台静默启动服务并自动在默认浏览器打开控制台
- `一键停止挂机`：优雅停止所有运行中的 node 与浏览器进程
- `学习通控制面板`：快速调出工作台页面

#### 方式 C：Linux VPS Systemd 守护运行
参考 [`06_部署与运维_Ops/XXT_OPS_VPS服务部署与Systemd守护实践指南_v1.0.0.md`](06_部署与运维_Ops/XXT_OPS_VPS服务部署与Systemd守护实践指南_v1.0.0.md) 配置 systemd 服务单元。

---

## 🧪 测试与验收

工程配备完整的自愈沙箱与多账号隔离自动化测试套件：

```bash
# 运行全部自动化回归测试
npm test
```
测试覆盖率包含：
- `XXT_TEST_任务调度与未登录挂起测试`
- `XXT_TEST_多账户会话物理隔离测试`
- `XXT_TEST_切片S1_自愈沙箱五道门禁全量回归`

---

## 🔒 安全与隐私声明

- **凭证安全**：项目默认已严格在 `.gitignore` 中排除了所有用户的登录会话（`auth_*.json`）、本地浏览器缓存（`userData/`）、真实环境密钥（`.env`）以及运行日志文件。
- **免责声明**：本项目仅供计算机系统架构、无头自动化测试以及大模型工程落地等技术交流与学习研究之用。请严格遵守超星平台服务协议及相关法律法规，切勿用于商业用途或不正当牟利。使用者因违反相关规定所产生的一切法律后果由使用者本人自行承担。

---

## 📄 开源许可证

本项目基于 [WTFPL (Do What The Fuck You Want To Public License)](LICENSE) 开源发布。你想怎么干就怎么干，零限制、零拘束。
