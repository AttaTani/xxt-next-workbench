# 项目命名与存储治理规范 (Naming & Storage Standards)

清晰、规范的目录架构与文件命名体系是降低团队认知负荷、防止资产散落和杜绝版本覆盖事故的生命线。

---

## 一、六阶段标准目录划分

项目根目录下必须设立严格的六阶段顶级目录，严禁在根目录下随意抛掷零散文档或临时脚本：

| 目录编号与名称 | 中文定义 | 目录职责与准入规则 |
| :--- | :--- | :--- |
| **`00_规范与指南_Standards/`** | 顶层规范 | 存放项目工程规范、编码标准、命名规范、UI 设计法则等指导性制度。 |
| **`01_源码工程_Source/`** | 核心工程 | 存放最终运行的源代码（如 Web 单文件/前端项目/Android 原生工程/后端服务）。 |
| **`02_产品需求_PRD/`** | 需求规格 | 存放所有产品层面的业务需求、用户体验指标、版本迭代规划文档。 |
| **`03_技术方案_Architecture/`** | 架构设计 | 存放系统重构方案、架构 RFC、模块技术设计及系统维护总手册。 |
| **`04_资产与数据_Assets/`** | 业务资产 | 存放业务预设数据包、配置文件、AI 生成 Prompt 指令及 JSON Schema 定义。 |
| **`05_测试与验收_QA/`** | 质量保证 | 存放自动化测试脚本、缺陷根因分析报告、测试验收表及兼容性测试结果。 |
| **`99_历史归档_Archive/`** | 历史归档 | 存放被新版本替代的废弃代码、历史草稿、过期文档等，保留完整审计痕迹。 |

---

## 二、文件命名公式与语义化版本

### 2.1 资产命名统一公式

$$\text{[项目标识]} \text{\_} \text{[文档/资产类型]} \text{\_} \text{[业务/模块描述]} \text{\_} \text{v[主].[次].[修订].[扩展名]}$$

- **项目标识 (Project Prefix)**：全项目统一（如 `Aegis`、`Nexus`、`Hyperion`）；
- **类型标识 (Type Tag)**：
  - `STD`：标准规范 (Standards)
  - `PRD`：产品需求 (Product Requirements Document)
  - `TECH`：技术实现方案 / 架构 (Technical Design / Architecture)
  - `QA`：质量与缺陷报告 (Quality Assurance)
  - `DECK` / `ASSET`：数据卡包 / 资源包 (Asset Bundle)
  - `PROMPT`：Prompt 指令集与 Schema (Prompt Guidelines)
- **描述字段**：简明清晰的中文或英文连字符（如 `前端轻量化与视觉系统重塑`、`暗室法则-感官剥夺与支配`）；
- **版本号**：遵循严格的语义化版本规范。

### 2.2 语义化版本规则 (SemVer 2.0)

采用 `v[MAJOR].[MINOR].[PATCH]` 格式：
- **MAJOR (主版本号)**：发生重大架构变动、重写核心机制或发生破坏性变更（Breaking Change）时递增；
- **MINOR (次版本号)**：完成重大功能模块扩展、切片重构落地或发布新特性时递增（如 v2.8.0 -> v2.9.0）；
- **PATCH (修订版本号)**：针对缺陷修复、细节微调、样式对齐或性能小修时递增（如 v2.9.0 -> v2.9.1）。

---

## 三、历史版本无损归档机制 (Archiving SOP)

在工程迭代过程中，**严禁原地硬删除 (Hard Delete)** 具有历史参考价值的文件。

1. **废弃判定**：当一个技术方案手册、PRD 或代码基准被全新版本完全替代时，触发归档。
2. **转移归档**：将原文件从对应目录剪切移入 `99_历史归档_Archive/`。
3. **添加时间戳后缀**：在原文件名后缀前增加 `_deprecated_YYYYMMDD`。
   - 示例：`Aegis_TECH_系统设计与迭代维护手册_v2.8.0.md.docx` 
     $\rightarrow$ `99_历史归档_Archive/Aegis_TECH_系统设计与迭代维护手册_v2.8.0_deprecated_20261003.md.docx`
4. **追溯收益**：任何时候若发现新版本缺失历史设计的边缘逻辑，可随时在 `99` 归档区检索对比。

---

## 四、版本控制与跨平台编码规范

### 4.1 Git 忽略文件 (.gitignore) 基线
必须建立防护完善的 `.gitignore`，防止脏文件入库：
```gitignore
# 依赖包与缓存
node_modules/
.gradle/
build/
*.log

# 临时与草稿脚本
scratch/
*.tmp

# 系统与 IDE 元数据
.DS_Store
Thumbs.db
.idea/
.vscode/

# 原生打包产物 (由 CI 统一构建与发布)
*.apk
android/app/build/
android/.gradle/
```

### 4.2 跨平台中文路径配置 (Windows / Linux)
对于包含中文字符的项目目录，必须配置 Git 支持原生 UTF-8 路径输出，避免文件名被转码为乱码八进制：
```bash
git config core.quotepath false
```

### 4.3 语义化 Git 提交信息规范 (Conventional Commits)
采用清晰的类型前缀：
- `feat`: 新增特性或切片功能落地（如 `feat(ui): lightweight drawer refactor v2.9.0`）
- `fix`: 修复系统或样式缺陷（如 `fix(touch): resolve mobile touch action collision`）
- `refactor`: 代码重构（不增减功能的逻辑优化）
- `docs`: 文档、规范、手册的新增与同步
- `test`: 自动化测试用例新增或调整
- `chore`: 构建配置、依赖包更新或 CI/CD 流程调整
