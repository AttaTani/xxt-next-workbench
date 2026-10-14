---
name: fullcycle-dev-practice
description: 全流程高可用工程开发与交付治理规范（Full-Cycle Engineering Best Practices）。用于任何软件项目的全生命周期研发、文档规范、架构重构、自动化测试与构建发布。包含：(1) 六阶段顶级目录与语义化存储命名规范；(2) PRD/TECH/QA/Handbook 黄金四联文档书写标准；(3) 切片式开发（Slice-Driven）、根因剖析与零回归 Bug 修复闭环；(4) 前端设计、无头测试、Docx文档转换、移动端打包与 CI/CD 自动化 Skill 编排矩阵。在启动新项目、重构现有项目、撰写研发规格书、排查复杂缺陷或实施版本发布时务必使用此规范。
---

# 全流程高可用工程开发与交付治理实践规范 (Full-Cycle Dev Practice)

本 Skill 沉淀自高复杂度渐进式客户端应用（4400+ 行单文件工程、多主题/真机手势/双模交互）从 RFC 规划、切片研发、多维缺陷攻坚、文档全量闭环到 Android APK 云端自动构建打包的完整工程实战经验。

本规范的核心目标是：**将混乱的临时性改动转变为高确定性、可追溯、零暗账、零回归的专业级软件工程交付体系**。

---

## 核心工作流速查图 (Workflow Map)

```
[01. 需求与决策]         [02. 架构与切片设计]        [03. 切片实现与测试先行]
  PO 场景哲学              架构 RFC 规格书             Playwright 自动化断言
  商业价值与功能矩阵  ───>  技术选型与 DOM 拓扑  ───>   针对性外科手术式编码
  输出: PRD 文档          输出: TECH 方案            输出: 源码 + Test Suites
                                                          │
                                                          ▼
[06. 资产同步与归档]     [05. CI/CD 与打包交付]      [04. 质量审计与文档闭环]
  99_历史归档戳记          Capacitor 原生包装          QA 缺陷分析报告 (Root Cause)
  Git 语义化提交     <───  GitHub Actions 流水线  <───  更新 系统维护手册 (Handbook)
  全平台零回归交付         输出: Release APK / Web     全套黄金四联文档同步
```

---

## 阶段一：项目命名与六阶段存储目录规范

在任何项目启动或重构时，**必须第一时间确立统一顶级目录与命名标准**，坚决杜绝文件散落根目录的“扁平化污染”。

### 1.1 六阶段标准目录骨架

```
<Project-Root>/
├── 00_规范与指南_Standards/    # 项目工程级开发、设计与版本控制规范
├── 01_源码工程_Source/         # 核心产品源码（Web 单文件/模块化应用/Native 项目）
├── 02_产品需求_PRD/            # 业务规划、交互体验标准与功能规格说明书
├── 03_技术方案_Architecture/   # 技术重构方案、架构 RFC、系统设计与维护手册
├── 04_资产与数据_Assets/       # 预设数据包、配置资产、Prompt 指令与 Schema 契约
├── 05_测试与验收_QA/           # 自动化测试脚本、真机缺陷排查报告、回归用例表
└── 99_历史归档_Archive/        # 废弃文件、过渡副本归档库（带时间戳）
```

### 1.2 资产与文件命名公式
所有交付文档及核心数据必须严格采用统一前缀与语义版本公式：

$$\text{[项目标识]} \text{\_} \text{[文档类型]} \text{\_} \text{[模块描述]} \text{\_} \text{v[主].[次].[修订].[扩展名]}$$

- **项目标识 (Project Key)**：大驼峰或大写英文（如 `Aegis`、`Nexus`、`Aurora`）。
- **文档类型 (Doc Type)**：
  - `STD`：开发/团队规范 (Standards)
  - `PRD`：产品需求文档 (Product Requirements)
  - `TECH`：技术实现方案 / 架构 RFC (Technical Design)
  - `QA`：测试缺陷报告 / 验收单 (Quality Assurance)
  - `ASSET` / `DECK`：数据资产与卡包配置
  - `PROMPT`：AI 指令规范与结构化定义
- **范例**：
  - `Aegis_PRD_前端轻量化与视觉系统重塑_v1.0.md`
  - `Aegis_TECH_系统设计与迭代维护手册_v2.9.0.md`
  - `Aegis_QA_移动端真机触屏滑动失效缺陷分析报告_v1.0.0.md`

### 1.3 废弃归档铁律（无损追溯）
- **严禁原地 Hard Delete（硬删除）** 具有历史上下文的技术文档或历史阶段源码；
- 废弃文件一律移入 `99_历史归档_Archive/`；
- 文件名强制追加 `_deprecated_YYYYMMDD` 后缀（如 `index_v2.4.0_deprecated_20261003.html`）。

> 详细目录规范及分支治理请查阅：[naming_and_storage_standards.md](file:///c:/Users/Atta/Desktop/Aegis%E7%A7%81%E5%AF%86%E5%8D%A1%E7%89%8C%E4%BA%92%E5%8A%A8App/.agents/skills/fullcycle-dev-practice/references/naming_and_storage_standards.md)。

---

## 阶段二：黄金四联文档体系 (Golden Quad-Doc Suite)

任何中大型功能演进或重构，必须通过“文档四联体”保障从需求提出到代码落地的认知对齐。

| 文档类型 | 核心受众 | 解决的核心问题 | 触发与交付时机 |
| :--- | :--- | :--- | :--- |
| **02 PRD** | PO / 产品经理 / 业务方 | “为什么做？做什么？体验与交互验收指标是什么？” | 迭代启动前，定义功能矩阵与体验边界 |
| **03 TECH** | 架构师 / 研发工程师 | “底层如何实现？数据流拓扑？状态机如何转迁？降级策略？” | 编码实施前，将 PRD 拆解为可落地的切片技术设计 |
| **05 QA** | 测试 / 质量负责人 / 研发 | “遇到了什么 Bug？根因原理是什么？如何用脚本自动化复现？” | 开发中或提测后，记录缺陷排查与自动化验证用例 |
| **03 Manual** | 长期维护者 / 二次开发者 | “当前系统全局架构长什么样？各模块 API 与状态如何维护？” | 切片全部完成上线时更新，作为系统的**单一可信源** |

### 文档格式双轨输出
- **Markdown (`.md`)**：存放在工程目录中，作为代码同源的纯文本可追溯源文件；
- **Office Word (`.docx`)**：利用 `docx` 工具链自动编译生成，供业务端汇报、移动端离线阅读及跨团队审批。

> 详细各文档模板与结构标准请查阅：[documentation_standards.md](file:///c:/Users/Atta/Desktop/Aegis%E7%A7%81%E5%AF%86%E5%8D%A1%E7%89%8C%E4%BA%92%E5%8A%A8App/.agents/skills/fullcycle-dev-practice/references/documentation_standards.md)。

---

## 阶段三：切片迭代与零回归 Bug 修复规范 (Slicing & QA Loop)

严禁在未划分切片、没有回归测试的情况下进行“大一统式代码重写”。必须遵循以下五步闭环：

### 3.1 切片式开发（Slice-Driven Iteration）
当面临复杂重构或多模块修改时，强制遵循**纵向切片隔离原则**：
1. **切片 1（骨架与布局基座）**：例如 DOM 结构减负、视口与 Flex 高度坍塌治理；
2. **切片 2（核心交互逻辑）**：例如抽屉滑动、手势判定、模态框响应式挂载；
3. **切片 3（视觉与主题体系）**：例如 CSS 变量 Token 分层、动效平滑度优化；
4. **切片 4（安全性与边界加固）**：例如数据导入白名单、本地防卡死降级、无痕保护。

### 3.2 Bug 修复四步闭环标准（S-R-A-S 流程）

```
[1. Symptom 现象定位] ──> [2. Root Cause 根因剖析] ──> [3. Automation 自动化断言] ──> [4. Sync 四重文档闭环]
   截取报错/实机录屏          排查机制级机理(非表面打补丁)   编写 Playwright 逆向断言       源码修复 + QA报告 + PRD同步
```

1. **Symptom（现象锁定）**：明确复现路径（真机机型、视口尺寸、触发顺序）；
2. **Root Cause（根因剖析）**：挖掘核心技术原理（如 CSS `height: 100%` 在父级无显式高度时坍塌、移动端未声明 `touch-action: pan-y` 导致系统手势截胡、Android 平台 AAR 依赖最低 SDK 约束）；
3. **Automation（测试先行）**：在修复源码前，编写或补充针对该缺陷的自动化测试断言；修复后执行全量测试套件，验证 100% PASS；
4. **Sync（文档同频）**：修复完成后，同步沉淀《缺陷分析报告》，并回写更新维护手册中的设计章节。

> 完整实机排查与回归指南请查阅：[bug_fixing_and_iteration_sop.md](file:///c:/Users/Atta/Desktop/Aegis%E7%A7%81%E5%AF%86%E5%8D%A1%E7%89%8C%E4%BA%92%E5%8A%A8App/.agents/skills/fullcycle-dev-practice/references/bug_fixing_and_iteration_sop.md)。

---

## 阶段四：实战 Skill 协同编排矩阵 (Toolchain & Skill Catalog)

在全流程开发中，善用专门化的 Agent Skills 进行多维度能力互补，能够数十倍提升交付质量与速度：

```
                    ┌─────────────────────────┐
                    │      doc-coauthoring    │ (需求与架构推演对齐)
                    └────────────┬────────────┘
                                 ▼
┌─────────────────────────┐              ┌─────────────────────────┐
│     frontend-design     │              │          docx           │
│ (高级视觉设计与动效排版) │              │ (规范转 Word 报告交付)   │
└────────────┬────────────┘              └────────────┬────────────┘
             │                                        │
             ▼                                        ▼
┌─────────────────────────┐              ┌─────────────────────────┐
│     webapp-testing      │ ───────────> │  android-cli / Actions  │
│ (Playwright 无头真机断言)│              │ (Capacitor 原生打包与CI) │
└─────────────────────────┘              └─────────────────────────┘
```

1. **`doc-coauthoring`**：用于 PRD 与技术 RFC 的多角色推演（PO 视角、架构师视角、实现工程师视角）；
2. **`frontend-design`**：重塑 UI 时摆脱平庸的框架默认样式，建立精美、自洽且克制的视觉语言（颜色 Token、微质感、弹性工效）；
3. **`webapp-testing`**：使用 Playwright 模拟用户交互、触控划屏、抽屉拖拽与视口断言，筑牢坚不可摧的质量底线；
4. **`docx`**：将工程生成的纯文本 Markdown 文档，高质量渲染为包含专业标题、表格、高亮呼应块的 Word 文档；
5. **`android-cli` / Capacitor / GitHub Actions**：实现从纯客户端 Web 代码到独立运行移动端 Android APK 的全自动化编译与持续集成。

> 各 Skill 详细协同参数与配置指南请查阅：[toolchain_and_skill_catalog.md](file:///c:/Users/Atta/Desktop/Aegis%E7%A7%81%E5%AF%86%E5%8D%A1%E7%89%8C%E4%BA%92%E5%8A%A8App/.agents/skills/fullcycle-dev-practice/references/toolchain_and_skill_catalog.md)。

---

## 快速复用检查清单 (Checklist)

当将此 Skill 复制至新项目时，按以下核对表执行初始化：

- [ ] 根目录已建立 `00` ~ `05` 及 `99` 标准六阶段目录结构；
- [ ] `.gitignore` 已配置，排除 `node_modules/`、`scratch/`、临时日志与原生构建缓存，并规范保留 `package-lock.json`；
- [ ] 文档命名严格符合 `[项目标识]_[文档类型]_[功能模块]_[版本号].[ext]`；
- [ ] 每次重大迭代均输出完整的 PRD、TECH、QA 缺陷报告与 Manual 维护手册；
- [ ] 关键业务路径具备无头自动化测试用例，重构后保持 100% 通过；
- [ ] 移动端或跨平台构建接入 GitHub Actions，实现云端推送自动打包发布。
