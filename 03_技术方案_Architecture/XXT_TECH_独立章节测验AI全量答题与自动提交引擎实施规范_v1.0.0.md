# 超星整页独立章节测验与作业 AI 自动答题引擎：切片化工程实施规范 (E1-E3)

> **文档标识**：`XXT_TECH_独立章节测验AI全量答题与自动提交引擎实施规范_v1.0.0.md`  
> **文档版本**：v1.0.0 (High-Precision Full-Page Exam Auto-Solving Architecture)  
> **编制日期**：2026-10-14  
> **所属项目**：超星学习通全自动无人值守挂机系统 (`vps-service`)  
> **目标模块**：独立试卷/作业解析器与作答执行器 (`taskWorker.js` / `examSolver.js`)  
> **存储位置**：`c:\Users\Atta\Desktop\学习通\03_技术方案_Architecture\XXT_TECH_独立章节测验AI全量答题与自动提交引擎实施规范_v1.0.0.md`

---

## 1. 业务现状与需求背景 (Context & Problem Definition)

### 1.1 现状痛点
1. **GitHub 原版脚本缺陷**：原始油猴脚本仅能对视频任务点挂机，遇到纯题目的“章节测验 / 作业 / 试卷”任务点时，采取的是直接跳过策略（`_advanceChapterTest()` 点击下一步），导致超星大纲中的作业任务点始终保持**未完成（橙色状态）**，无法达到 $100\%$ 结课标准；
2. **随堂测验与整页测验的区别**：
   - **随堂测验（Video Quiz）**：视频中间浮现的单题弹窗模态框（`.ans-videoquiz`），我们已通过切片 T1-T3 实现了单题纯文本 CoT 高精度秒答；
   - **整页章节测验（Full-Page Chapter Exam）**：嵌套在超星多层 `iframe`（如 `#frame_content` $\to$ `.ans-cc` $\to$ `iframe[src*="work"]`）中的全量多题表单，包含单选、多选、判断等混合题型，带有独立的选项单选框/复选框、答案输入框以及底部的`【保存】`/`【提交】`按钮。

---

## 2. 系统核心指标与设计原则 (Goals & Guiding Principles)

| 指标维度 | 目标规格 | 设计说明 |
| :--- | :--- | :--- |
| **多题型支持度** | 单选题、判断题、多选题 100% 覆盖 | 支持按题型特征自动适配单选/多选勾选策略 |
| **批处理 Token 效率** | 单张试卷（5~10题）总耗时 $\le 2.5\text{s}$ | 摒弃逐题多次往返，整卷题目打包单次请求千问大模型 |
| **作答准确率** | $\ge 88\% \sim 95\%$ | 采用 `qwen-plus` 旗舰纯文本模型与审题思维链（CoT） |
| **提交风控与安全性** | 支持“自动提交”与“安全暂存”双模式 | 避免一次性误交低分试卷，提供防风控可控配置 |

---

## 3. 总体技术架构与数据流 (Architecture Flow)

```mermaid
flowchart TD
    Step1["任务点流转: 进入非视频任务点 (如章节测验)"] --> Step2["多层 iframe 穿透探测: 试卷容器判定 (.TiMu / .ans-cc / form#submitForm)"]
    Step2 --> Step3["试卷 DOM 结构化提取器 (extractFullExamContent)"]
    Step3 --> Step4["提取出整卷题目 JSON: 题号、题型、题干净文本、选项键值对"]
    
    Step4 --> Step5["试卷批量提示词构建器 (buildBatchExamPrompt)"]
    Step5 --> Step6["调用通义千问旗舰模型 (qwen-plus)<br/>单次批量输出答案映射字典"]
    
    Step6 --> Step7["结构化答案清洗与校验 (cleanBatchAnswers)"]
    Step7 --> Step8["DOM 模拟点击执行器 (applyExamAnswers)"]
    
    Step8 --> Step9{"配置项: examSubmitMode"}
    Step9 -- "SAVE_ONLY (暂存核验模式)" --> ActionSave["模拟点击【保存/暂存】按钮，保留答案"]
    Step9 -- "AUTO_SUBMIT (全自动代考模式)" --> ActionSubmit["模拟点击【提交】确认按钮，任务点变绿"]
    
    ActionSave --> Finish["平稳流转至下一小节任务点"]
    ActionSubmit --> Finish
```

---

## 4. 切片化实施计划 (Slice-Driven Roadmap)

为确保工程的高可用性、零回归及严密验证，将整套章节测验作答引擎拆分为 **E1、E2、E3 三个原子推进切片**：

```mermaid
flowchart LR
    E1["【切片 E1】<br/>整卷试题 DOM 提取器<br/>与多层 iframe 穿透"] --> E2["【切片 E2】<br/>试卷批量打包 Prompt<br/>与 Qwen-Plus 批量推理"]
    E2 --> E3["【切片 E3】<br/>批量勾选、提交策略<br/>与全流程实机挂机验收"]
```

---

### 4.1 【切片 E1】：整卷试题 DOM 提取器与多层 iframe 穿透
- **核心目标**：从超星复杂的章节测验嵌套结构中，无损提取出整张试卷的所有题目元数据。
- **改动文件**：
  - 新建模块：[vps-service/examSolver.js](file:///c:/Users/Atta/Desktop/学习通/vps-service/examSolver.js)
  - 核心方法：`detectAndExtractExam(page)`
- **提取的数据结构规格**：
  ```json
  [
    {
      "id": "q_1",
      "index": 1,
      "type": "单选题", // 单选题 | 多选题 | 判断题
      "stem": "楚汉战争时期，刘邦率先攻入关中，采取了哪项政策安抚百姓？",
      "options": [
        { "letter": "A", "text": "废除秦法，约法三章", "elementSelector": "input[name='answer1'][value='A']" },
        { "letter": "B", "text": "严刑峻法，诛杀秦贵族", "elementSelector": "input[name='answer1'][value='B']" }
      ]
    }
  ]
  ```
- **自审验收标准**：
  - 单元测试覆盖真实超星试卷 HTML 样例（5道混合试题），能够 $100\%$ 精确识别题目类型、题干文本及对应的单选/多选框元素选择器。

---

### 4.2 【切片 E2】：试卷批量打包 Prompt 与千问旗舰模型推理对接
- **核心目标**：实现一次 API 往返即推导出整卷所有题目的最优答案，极速且节省 Token。
- **改动文件**：
  - [vps-service/examSolver.js](file:///c:/Users/Atta/Desktop/学习通/vps-service/examSolver.js)
  - [vps-service/config.json](file:///c:/Users/Atta/Desktop/学习通/vps-service/config.json)
- **Prompt 与响应规范**：
  ```text
  你是一位大学课程考试答题专家，请严格审查下列试卷并给出正确答案：
  第1题 (单选题)：楚汉战争时期，刘邦率先攻入关中...
  选项：A. 废除秦法，约法三章  B. 严刑峻法...
  第2题 (判断题)：刘邦比项羽整整大了一轮...
  
  【作答输出规范】：
  请严格输出 JSON 字典，如：{"1": "A", "2": "B", "3": "ACD"}
  ```
- **自审验收标准**：
  - 离线问答用例输入一张 5 题综合测验试卷，`qwen-plus` 在 2.5 秒内返回合法 JSON 答案字典，单选、多选、判断题解析格式合格率 $100\%$。

---

### 4.3 【切片 E3】：批量勾选执行、双模提交控制与实机挂机闭环
- **核心目标**：自动在页面上模拟用户物理点击完成勾选，并根据配置执行暂存或提交，与现有挂机流转衔接。
- **改动文件**：
  - [vps-service/taskWorker.js](file:///c:/Users/Atta/Desktop/学习通/vps-service/taskWorker.js)
  - [vps-service/config.json](file:///c:/Users/Atta/Desktop/学习通/vps-service/config.json)（新增 `enableChapterExamSolving: true`, `examSubmitMode: "SAVE_ONLY"`）
- **核心逻辑**：
  1. 在 `checkPlaybackStatus()` 中，当 `!foundVideo` 且检测到章节测验时，触发 `examSolver.solveExam()`；
  2. 模拟点击选完所有题目（每次点击加入 100~300ms 随机延迟，防止触发频率风控）；
  3. 若 `examSubmitMode === 'AUTO_SUBMIT'`：点击页面底部的“提交”并确认弹窗，测验任务点变绿；
  4. 若 `examSubmitMode === 'SAVE_ONLY'`：点击“暂存”或直接保留勾选，避免意外提交不及格；
  5. 答题完成后平稳流转至下一小节。
- **自审验收标准**：
  - 实盘挂机到带有“章节测验”的小节时，系统自动识别整页试卷、控制台输出各题推荐答案、页面自动完成勾选、完成暂存/提交并流畅切换下一节。

---

## 5. 配置参数定义规范 (`config.json`)

```json
{
  "enableChapterExamSolving": true,
  "examSubmitMode": "AUTO_SUBMIT", // 可选: "AUTO_SUBMIT" (全自动提交拿分) | "SAVE_ONLY" (仅填入答案并暂存)
  "examDelayBetweenClicksMs": 250,
  "examModel": "qwen-plus"
}
```

---

文档已编制完成并归档至规范目录。请确认是否立即开始按序推进 **【切片 E1：整卷试题 DOM 提取器与多层 iframe 穿透实现】**！
