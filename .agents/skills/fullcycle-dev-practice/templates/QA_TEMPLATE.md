# [项目标识]_QA_[缺陷/模块描述]_v[版本号]

| 报告编号 | 发现环境 | 测试负责人 | 修复状态 | 日期 |
| :--- | :--- | :--- | :--- | :--- |
| QA-BUG-001 | 真实移动端 / Chrome Headless | [测试作者] | 待验证 / 修复中 / 已闭环 | YYYY-MM-DD |

---

## 一、缺陷背景与影响范围

- **复现设备/环境**：iOS 17 Safari / Android 14 Chrome / iPhone SE (375x667)
- **前置触发条件**：[例如：当卡片文字超过 3 行且处于特定抽屉展开状态时]
- **严重级别**：P0 (阻塞核心流程) / P1 (交互瑕疵) / P2 (轻微视觉缺陷)

---

## 二、缺陷现象 (Symptom)

> 描述用户可见的直观问题，附带错误日志或录屏截图说明：
> - 出现不该有的滚动条；
> - 按钮点击无响应；
> - 滑动手势被系统截断无法向上拖拽抽屉。

---

## 三、深层技术机理剖析 (Root Cause Analysis)

> **严禁仅陈述“加了样式就好了”，必须剖析机制原因**：
> 1. 原理解析：CSS / JS 运行时的本质冲突点；
> 2. 为什么在桌面端正常而在真机异常（如 touch 事件与 pointer 事件优先级、Retina 视网膜缩放影响）；
> 3. 是否存在时序竞态 (Race Condition) 或状态脱节。

---

## 四、针对性根治方案与代码对比

### 关键代码修复对比 (Diff)
```diff
- // 导致缺陷的原有代码
- height: 100%;
- overflow: scroll;
+ // 根治后的受控代码
+ flex: 1 1 0;
+ min-height: 0;
+ overflow-y: auto;
+ -webkit-overflow-scrolling: touch;
```

---

## 五、自动化测试套件与验收矩阵

### 5.1 自动化用例设计 (Playwright / Jest)
```javascript
test('验证极限小屏视口高度无弹性坍塌与截断', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  // 测量与断言逻辑
  const rect = await page.locator('.main-container').boundingBox();
  expect(rect.height).toBeLessThanOrEqual(667);
});
```

### 5.2 全量回归结果
- [x] 用例 1: 极限视口尺寸压测 (PASS)
- [x] 用例 2: 手势多段拖拽模拟 (PASS)
- [x] 用例 3: 状态变更与本地存储一致性 (PASS)
- [x] 用例 4: 极端脏数据容错降级 (PASS)

---

## 六、四重闭环同步状态
- [x] 源码已修复并合并；
- [x] PRD 需求体验边界已更新；
- [x] TECH 架构维护手册已回写；
- [x] 语义化 Commit 已提交至 Git。
