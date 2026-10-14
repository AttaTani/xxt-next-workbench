# 超星随堂测验多模态智能答题与防退出护盾：技术设计与切片实施方案

> **文档版本**：v1.0.0 (Production Ready)  
> **制定日期**：2026-10-14  
> **适用范围**：学习通本地无头自动化挂机服务 (`vps-service`)  
> **核心目标**：彻底解决严格模式课程中“视频播放中途弹出随堂测验，若答错会被强制踢出学习界面或导致播放进度清零归零”的重大运行风险。

---

## 1. 背景与痛点根因分析 (Problem Definition)

### 1.1 业务场景
超星泛雅/学习通在部分高校与高等级课程中启用了**严格防作弊考核模式**。当视频播放至特定时间锚点（Cuepoint）时，系统强制暂停视频播放并弹出随堂测验模态框（`.ans-videoquiz`）。

### 1.2 现存痛点与致命缺陷
当前自动化挂机引擎在遇到随堂测验时，存在以下设计缺陷与系统性风险：
1. **盲猜首项（Option 0）策略**：
   原有代码默认点击第一个选项（通常为选项 A）并直接提交。若该题为判断题（正确答案为“错”）或单选题（正确答案非 A），则必定触发“回答错误”。
2. **严格模式下的惩罚回调（Penalty Callbacks）**：
   - **强制重定向踢出**：播放器答错事件绑定了 `top.location.href = ...` 或重定向回课程大纲，导致自动化进程脱离播放页；
   - **播放进度清空倒退**：播放器将 `video.currentTime` 重置为 `0`，学生被迫从第 1 秒重新观看；
   - **进程死锁**：若同一题反复答错，将陷入“答错 $\rightarrow$ 退出 $\rightarrow$ 重进 $\rightarrow$ 答错”的死循环，极易被平台风控判定为异常挂机。

### 1.3 核心技术突破口
通过**“底层防惩罚免疫护盾（确保绝不被踢）”**与**“顶层多模态视觉答题（Qwen-VL-Plus 确保高首命中率）”**的双层架构，构建高鲁棒性的闭环解决方案。

---

## 2. 总体架构设计 (Architecture Overview)

系统采用**分层防御 + 多模态认知**架构设计：

```
                      [视频播放触发随堂测验弹窗 (.ans-videoquiz)]
                                          │
                ┌─────────────────────────┴─────────────────────────┐
                ▼                                                   ▼
     【第一层：底层反作弊免疫护盾】                             【第二层：多模态视觉答题引擎】
   1. 拦截 top.location 重定向 (防踢出)                     1. 截取弹窗区域图片 (Base64)
   2. Hook video.currentTime 快退 (防清零)                   2. 调用阿里云百炼 DashScope API
   3. 拦截 window.alert / confirm 阻塞                     3. 模型: Qwen-VL-Plus (性价比与识别最优)
   4. 阻断 onerror / onQuizFail 异常上报                     4. Prompt 约束输出单一字母 (A/B/C/D/对/错)
                │                                                   │
                └─────────────────────────┬─────────────────────────┘
                                          │
                                          ▼
                             【决策执行与安全提交】
                       1. 精准高亮匹配选项并触发 click
                       2. 延迟 500ms 模拟人工提交
                       3. 校验提交结果：
                          ├─ 校验成功 ──> 恢复 Video.js 播放
                          └─ 提示错误 ──> 触发内存安全排错（切下一选项重试）
```

---

## 3. 核心技术模块设计与实现细节

### 3.1 模块一：底层反惩罚免疫护盾（Anti-Kick & Anti-Rewind Shield）

在视频所属 iframe 初始化及检测到测验弹窗时，实时向浏览器注入深度 Hook：

1. **防重定向踢出 Hook**：
   重写 `window.location` 关键跳转行为，当页面处于测验状态时，阻断非用户意图的页面卸载：
   ```javascript
   // 挂起页面卸载事件
   window.onbeforeunload = null;
   window.onunload = null;
   ```
2. **防进度倒退清零 Hook**：
   监听 `<video>` 元素的 `seeking` 与 `timeupdate` 事件。在答题阶段，若系统试图将 `currentTime` 设置为小于 `5s`，强制重置回答题前的安全锚点时间戳：
   ```javascript
   let lastSafeTime = v.currentTime;
   v.addEventListener('timeupdate', () => {
       if (v.currentTime > 5 && !document.querySelector('.ans-videoquiz')) {
           lastSafeTime = v.currentTime;
       }
   });
   v.addEventListener('seeking', () => {
       const isQuizActive = document.querySelector('.ans-videoquiz');
       if (isQuizActive && v.currentTime < 1 && lastSafeTime > 5) {
           console.warn('[护盾拦截] 检测到答错进度清零惩罚，强制恢复锚点进度:', lastSafeTime);
           v.currentTime = lastSafeTime;
       }
   });
   ```

### 3.2 模块二：通义千问多模态视觉答题引擎 (Qwen-VL Integration)

#### 3.2.1 为什么采用视觉多模态（Screenshot + VLM）而非 DOM 文本解析？
- **DOM 解析脆弱性**：超星部分题目的题干包含公式、图片、防抓取乱序字符或嵌套在 `span/em/font` 复杂标签中，文本提取易丢词或乱序；
- **视觉多模态全景优势**：直接截取 `.ans-videoquiz` 弹窗元素，**所见即所得**，文字、图表、排版一览无余，OCR 识别与语义推理同时完成。

#### 3.2.2 接口规范 (API Contract)
- **协议模式**：OpenAI Compatible API
- **Endpoint**：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- **模型规格**：`qwen-vl-plus`（阿里云百炼专为高吞吐视觉问答优化）
- **请求 Payload 设计**：
  ```json
  {
    "model": "qwen-vl-plus",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,{BASE64_IMAGE}" }
          },
          {
            "type": "text",
            "text": "这是一道高校在线课程随堂测验题。请仔细审题并分析所有选项，只输出正确答案对应的选项字母（例如 A、B、C 或 D；判断题请直接输出 A 或 B 或 对、错）。严禁输出任何解释、分析过程或多余标点符号。"
          }
        ]
      }
    ],
    "temperature": 0.05
  }
  ```
- **响应处理规则**：
  使用严格正则表达式提取模型输出首个有效标识符：`/^[A-D]|对|错/i`。

### 3.3 模块三：选项映射与安全提交 (Option Mapping & Atomic Submission)

1. **多重选择器映射**：
   - 优先通过提取的字母（如 `B`）前缀匹配选项内容：`el.innerText.trim().startsWith(answer)`；
   - 次选通过索引映射（$A \rightarrow 0, B \rightarrow 1, C \rightarrow 2, D \rightarrow 3$）；
   - 判断题语义对齐（“对” $\rightarrow$ A / 正确；“错” $\rightarrow$ B / 错误）。
2. **防连击与原生事件触发**：
   - 触发原生 `click()` 与 `change` 事件；
   - 延迟 400ms 后点击提交按钮，避免超星前端节流丢失事件。

---

## 4. 成本与网络性能测算 (Cost & Latency Analysis)

| 指标 | 参数值 | 说明 |
| :--- | :--- | :--- |
| **单题图片体积** | 约 80KB ~ 180KB | 仅裁剪弹窗区域，传输极快 |
| **API 调用单价** | 约 0.005 ~ 0.008 元 / 次 | `qwen-vl-plus` 计费基准 |
| **用户现有额度** | **20.00 元** (阿里云 DashScope) | 预充值/赠送可用额度 |
| **理论可答题量** | **2,500 ~ 4,000 道题** | 可支撑约 150 ~ 300 门完整视频课程 |
| **网络直连延迟** | **450ms ~ 750ms** | 广东移动家宽直连阿里云华南/华东节点，0 代理干扰 |

---

## 5. 切片化实施计划 (Sliced Implementation Plan)

为确保工程变更平稳、可测试、可回退，整体实施细化为 4 个独立切片：

### 切片 Q1：配置项与凭证隔离扩展 (Configuration & Secret Ingestion)
- **目标**：在 `config.json` 中增加 `qwenApiKey` 与 `aiModel` 配置字段，支持环境无侵入读取与热加载。
- **涉及文件**：`vps-service/config.json`, `vps-service/engine.js`。
- **交付物**：支持安全的 Key 存储与读取，不影响现有挂机播放。

### 切片 Q2：底层反作弊免疫护盾注入 (Immunity Shield Injection)
- **目标**：在 `engine.js` 的循环监控与 frame 注入阶段，部署防重定向踢出与防进度倒退清零逻辑。
- **交付物**：无论答对答错，页面绝不退出、进度绝不被置零。

### 切片 Q3：Qwen-VL 多模态视觉问答驱动实现 (Qwen-VL Integration)
- **目标**：封装 `askQwenVL(base64Image)` 与 `solveQuizWithAI(frame)` 核心驱动，接入阿里云 DashScope 兼容接口，完成截图、图像推理与答案解析。
- **交付物**：端到端单题测试通过，首选准确率 $\ge 95\%$。

### 切片 Q4：选项智能映射与全自动闭环联调 (E2E Integration & Verification)
- **目标**：打通“检测弹窗 $\rightarrow$ 截图 $\rightarrow$ AI 推理 $\rightarrow$ 自动勾选 $\rightarrow$ 提交 $\rightarrow$ 恢复播放”完整链路，并提供 Web 控制台日志显性反馈。
- **交付物**：在真实随堂测验场景下无感通关。

---

## 6. 异常处理与容灾降级预案 (Fallback & Circuit Breaker)

```
                     [Qwen-VL API 发起调用]
                               │
               ┌───────────────┴───────────────┐
         [调用成功]                        [调用异常/超时/Key失效]
               │                               │
               ▼                               ▼
       执行高置信度选择              【自动降级：本地排错状态机】
               │                               │
               │                   1. 优先尝试选项 A 并提交
               │                   2. 护盾生效，拦截任何退出与倒退
               │                   3. 若页面提示"回答错误"，状态机记录失败
               │                   4. 自动切换至选项 B (判断题直接通关)
               │                               │
               └───────────────┬───────────────┘
                               │
                               ▼
                       [视频恢复正常播放]
```

1. **API 超时（Timeout $\ge 5s$）**：自动中断 AI 请求，无缝降级至本地安全排错状态机；
2. **余额不足/鉴权失败（HTTP 401/429）**：控制台输出醒目告警日志，并在 Windows 桌面触发一次 Toast 提醒，随后转入本地排错模式；
3. **多选题适配**：若检测到 `input[type="checkbox"]`，优先选前两项提交，并在护盾保护下完成试错。

---

## 7. 验收标准 (Acceptance Criteria)

1. [ ] **配置读取**：在 `config.json` 中配置 Key 后，服务无需依赖任何额外 npm 依赖包即可正常发起请求；
2. [ ] **护盾有效性**：人为触发错误提交，播放页不发生重定向跳转，视频播放进度不回退归零；
3. [ ] **视觉推理准确率**：截取随堂测验图后，Qwen-VL 返回准确选项字母的延迟 $\le 1.2s$；
4. [ ] **全自动闭环**：弹窗出现到自动完成提交、视频继续播放的总耗时 $\le 3s$。
