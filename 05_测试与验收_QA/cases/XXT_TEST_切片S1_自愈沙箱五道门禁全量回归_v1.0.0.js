/**
 * XXT_TEST_切片S1_自愈沙箱五道门禁全量回归_v1.0.0.js
 * 
 * 全面断言切片 S1:
 * 1. 事故现场快照无损捕获 (IncidentDumper)
 * 2. 爆炸半径限制与 AST 语法安全白名单 (AstAuditor / Gate 2)
 * 3. 静态语法健康校验 (Gate 3)
 * 4. 离线 Mock 治具全量回归 (Gate 4)
 * 5. 毫秒级熔断看门狗与原子回滚 (Gate 5)
 * 6. 内存规则动态热重载与全链路自进化闭环 (RuleManager + AiRepairExpert)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
    IncidentDumper,
    FIXTURES,
    testExtractFromHtml,
    AstAuditor,
    Gatekeeper,
    RuleManager,
    AiRepairExpert
} = require('../../vps-service/selfHeal');

async function runS1TestSuite() {
    console.log('================================================================');
    console.log('🧪 开始运行 【切片 S1：代码级自主沙箱热修复与五道防爆门禁】 自动化回归测试');
    console.log('================================================================\n');

    let passedTests = 0;
    let totalTests = 6;

    // -------------------------------------------------------------
    // Test 1: 事故现场快照无损捕获与结构校验 (S1.1)
    // -------------------------------------------------------------
    try {
        console.log('▶️ [Test 1/6] 验证 IncidentDumper 现场快照序列化与落盘...');
        const dumper = new IncidentDumper();
        const fakeFrame = {
            url: () => 'https://mooc1-2.chaoxing.com/work/doHomeWorkNew?courseId=999',
            content: async () => '<html><body><div class="test-exam-container">Mock Exam HTML</div></body></html>'
        };

        const dumpResult = await dumper.dumpIncident({
            frame: fakeFrame,
            taskId: 'test_task_s1',
            taskName: '测试课程',
            scene: 'CHAPTER_EXAM',
            error: 'TestExtractionFailed: 0 questions matched',
            currentSelectors: { container: '.TiMu' }
        });

        assert.ok(dumpResult.incidentId.startsWith('INC_'), 'incidentId 必须以 INC_ 开头');
        assert.ok(fs.existsSync(dumpResult.snapshotPath), '快照 JSON 必须成功写入磁盘');
        const writtenJson = JSON.parse(fs.readFileSync(dumpResult.snapshotPath, 'utf-8'));
        assert.strictEqual(writtenJson.scene, 'CHAPTER_EXAM');
        assert.strictEqual(writtenJson.taskId, 'test_task_s1');
        assert.ok(writtenJson.htmlSnapshot.includes('Mock Exam HTML'));

        // 清理临时测试快照
        try { fs.unlinkSync(dumpResult.snapshotPath); } catch (e) {}

        console.log('  ✅ Test 1 通过: 现场 DOM 与事故包序列化结构符合契约\n');
        passedTests++;
    } catch (e) {
        console.error(`  ❌ Test 1 失败: ${e.message}\n`);
    }

    // -------------------------------------------------------------
    // Test 2: Gate 2 爆炸半径与 AST 语法树安全审查 (S1.2)
    // -------------------------------------------------------------
    try {
        console.log('▶️ [Test 2/6] 验证 Gate 2 爆炸半径限制与恶意注入拦截 (AstAuditor)...');
        
        // 恶意注入样本 1: 尝试执行系统命令
        const evilPatch1 = {
            target: 'examSelectors',
            selectors: {
                container: '.TiMu; require("child_process").execSync("calc.exe");'
            }
        };
        const res1 = AstAuditor.auditPatch(evilPatch1);
        assert.strictEqual(res1.passed, false, '必须拦截包含 child_process 的补丁');

        // 恶意注入样本 2: 尝试越权修改非规则核心目标
        const evilPatch2 = {
            target: 'systemCore',
            selectors: {
                container: '.TiMu'
            }
        };
        const res2 = AstAuditor.auditPatch(evilPatch2);
        assert.strictEqual(res2.passed, false, '必须拦截非法 target');

        // 恶意注入样本 3: 尝试原型链污染
        const evilPatch3 = {
            target: 'examSelectors',
            selectors: JSON.parse('{"container": ".TiMu", "__proto__": {"admin": true}}')
        };
        const res3 = AstAuditor.auditPatch(evilPatch3);
        assert.strictEqual(res3.passed, false, '必须拦截 __proto__ 污染特征');

        // 合法补丁样本
        const validPatch = {
            version: '1.0.1-patch-test',
            target: 'examSelectors',
            selectors: {
                container: '.TiMu, .new_TiMu',
                questionNodes: '.TiMu, .singleQuesId, .new_card',
                stem: '.Zy_TItle, .new_stem',
                options: 'li, .answerBg, .new_option'
            }
        };
        const resValid = AstAuditor.auditPatch(validPatch);
        assert.strictEqual(resValid.passed, true, '合规规则补丁必须放行');

        console.log('  ✅ Test 2 通过: 成功拦截 child_process / 越权 target / 原型链污染等所有高危输入\n');
        passedTests++;
    } catch (e) {
        console.error(`  ❌ Test 2 失败: ${e.message}\n`);
    }

    // -------------------------------------------------------------
    // Test 3: Gate 4 离线 Mock 治具基线与变异回归 (S1.2)
    // -------------------------------------------------------------
    try {
        console.log('▶️ [Test 3/6] 验证 Gate 4 离线历史基准与变异样本提取测试...');

        const baselineSelectors = {
            container: '.TiMu, #submitForm',
            questionNodes: '.TiMu, .singleQuesId',
            options: 'li, .answerBg'
        };

        // 验证标准基线通过
        const r1 = testExtractFromHtml(FIXTURES.baseline_standard_single, baselineSelectors);
        assert.strictEqual(r1.success, true, '治具 1 (标准单选) 必须提取成功');

        const r2 = testExtractFromHtml(FIXTURES.baseline_multi_and_judge, baselineSelectors);
        assert.strictEqual(r2.success, true, '治具 2 (多选与判断) 必须提取成功');

        // 验证变异样本在旧选择器下失效
        const r3Old = testExtractFromHtml(FIXTURES.variant_hybrid_class, baselineSelectors);
        assert.strictEqual(r3Old.success, false, '变异场景在旧规则下必须返回 false');

        // 增强补丁在变异样本下成功提取
        const enhancedSelectors = {
            container: '.TiMu, #submitForm, .xxt-exam-sheet',
            questionNodes: '.TiMu, .singleQuesId, .xxt-question-card',
            options: 'li, .xxt-opt-item'
        };
        const r3New = testExtractFromHtml(FIXTURES.variant_hybrid_class, enhancedSelectors);
        assert.strictEqual(r3New.success, true, '变异场景在增强规则下必须提取成功');

        console.log('  ✅ Test 3 通过: 离线 Mock 治具库可精确度量提取成功率与修复率\n');
        passedTests++;
    } catch (e) {
        console.error(`  ❌ Test 3 失败: ${e.message}\n`);
    }

    // -------------------------------------------------------------
    // Test 4: Gate 5 熔断看门狗状态转移与跳闸测试 (S1.2)
    // -------------------------------------------------------------
    try {
        console.log('▶️ [Test 4/6] 验证 Gate 5 毫秒级熔断器计数、跳闸与人工复位...');
        const gatekeeper = new Gatekeeper();
        assert.strictEqual(gatekeeper.circuitBreaker.isTripped, false);

        // 连续报告 2 次失败
        gatekeeper.reportExecutionResult(false);
        assert.strictEqual(gatekeeper.circuitBreaker.failureCount, 1);
        assert.strictEqual(gatekeeper.circuitBreaker.isTripped, false);

        gatekeeper.reportExecutionResult(false);
        assert.strictEqual(gatekeeper.circuitBreaker.failureCount, 2);
        assert.strictEqual(gatekeeper.circuitBreaker.isTripped, true, '达到阈值后熔断器必须跳闸');

        // 跳闸状态下 Gate 5 必须拒绝新补丁
        const dummyPatch = {
            target: 'examSelectors',
            selectors: {
                container: '.TiMu',
                questionNodes: '.TiMu'
            }
        };
        const evalRes = await gatekeeper.evaluatePatch(dummyPatch);
        assert.strictEqual(evalRes.passed, false, '跳闸状态下严禁通过');
        const gate5Result = evalRes.gateResults.find(g => g.gate === 5);
        assert.ok(gate5Result.message.includes('跳闸状态'));

        // 手动复位
        gatekeeper.resetCircuitBreaker();
        assert.strictEqual(gatekeeper.circuitBreaker.isTripped, false, '复位后恢复就绪状态');

        console.log('  ✅ Test 4 通过: 熔断器能够精准识别级联异常并自锁保护\n');
        passedTests++;
    } catch (e) {
        console.error(`  ❌ Test 4 失败: ${e.message}\n`);
    }

    // -------------------------------------------------------------
    // Test 5: RuleManager 动态热重载与原子回滚 (S1.3)
    // -------------------------------------------------------------
    try {
        console.log('▶️ [Test 5/6] 验证 RuleManager 内存热替换与原子版本回滚...');
        const tempRulesPath = path.join(__dirname, 'temp_test_rules.json');
        fs.writeFileSync(tempRulesPath, JSON.stringify({
            version: '1.0.0',
            exam: {
                container: '.TiMu',
                questionNodes: '.TiMu'
            }
        }), 'utf-8');

        const ruleMgr = new RuleManager(tempRulesPath);
        assert.strictEqual(ruleMgr.currentVersion, '1.0.0');

        // 应用补丁
        const patchResult = ruleMgr.applyPatch({
            version: '1.0.1-patch-test',
            target: 'examSelectors',
            selectors: {
                container: '.new_exam_box',
                questionNodes: '.new_card'
            }
        });

        assert.strictEqual(patchResult.success, true);
        assert.strictEqual(ruleMgr.currentVersion, '1.0.1-patch-test');
        // 验证并集融合
        assert.ok(ruleMgr.getModuleSelectors('exam').container.includes('.TiMu'));
        assert.ok(ruleMgr.getModuleSelectors('exam').container.includes('.new_exam_box'));

        // 执行原子回滚
        const rollbackRes = ruleMgr.rollback();
        assert.strictEqual(rollbackRes.success, true);
        assert.strictEqual(rollbackRes.restoredVersion, '1.0.0');
        assert.strictEqual(ruleMgr.currentVersion, '1.0.0');

        // 清理临时文件
        try { fs.unlinkSync(tempRulesPath); } catch (e) {}

        console.log('  ✅ Test 5 通过: 内存热替换与历史版本原子回滚验证无误\n');
        passedTests++;
    } catch (e) {
        console.error(`  ❌ Test 5 失败: ${e.message}\n`);
    }

    // -------------------------------------------------------------
    // Test 6: 端到端全链路自愈闭环演练 (S1.4)
    // -------------------------------------------------------------
    try {
        console.log('▶️ [Test 6/6] 验证全链路自进化闭环 (事故触发 -> AI合成 -> 五关门禁 -> 热装载)...');

        const tempRulesPath2 = path.join(__dirname, 'temp_test_rules2.json');
        fs.writeFileSync(tempRulesPath2, JSON.stringify({
            version: '1.0.0',
            exam: {
                container: '.TiMu, #submitForm',
                questionNodes: '.TiMu, .singleQuesId',
                stem: '.Zy_TItle_name',
                options: 'li, .Zy_ulTop li'
            }
        }), 'utf-8');

        const ruleMgr2 = new RuleManager(tempRulesPath2);
        const gatekeeper2 = new Gatekeeper();
        const expert = new AiRepairExpert({}, ruleMgr2, gatekeeper2);

        // 模拟超星突发变异场景 (变异治具 4)
        const incidentData = {
            incidentId: 'INC_TEST_MUTATION_001',
            timestamp: Date.now(),
            taskId: 'task_live_mock',
            taskName: '前端逆向测试',
            scene: 'CHAPTER_EXAM',
            error: 'ZeroQuestionsExtracted: class mutation detected',
            currentSelectors: ruleMgr2.getModuleSelectors('exam'),
            htmlSnapshot: FIXTURES.variant_hybrid_class
        };

        const healReport = await expert.diagnoseAndRepair(incidentData);
        assert.strictEqual(healReport.success, true, '自愈闭环必须成功');
        assert.ok(healReport.gateReport.passed, '五道门禁必须全绿');
        assert.ok(healReport.version.startsWith('1.0.1-patch'), '版本号必须成功递增');

        // 验证热修后的规则能否成功提取原变异治具
        const postRules = ruleMgr2.getModuleSelectors('exam');
        const reExtract = testExtractFromHtml(FIXTURES.variant_hybrid_class, postRules);
        assert.strictEqual(reExtract.success, true, '自愈后再次提取必须为 true');

        // 清理临时文件
        try { fs.unlinkSync(tempRulesPath2); } catch (e) {}

        console.log('  ✅ Test 6 通过: 事故触发后自动完成诊断、过五关门禁并达成 100% 修复率\n');
        passedTests++;
    } catch (e) {
        console.error(`  ❌ Test 6 失败: ${e.message}\n`);
    }

    console.log('================================================================');
    console.log(`🏁 切片 S1 回归测试完成: ${passedTests}/${totalTests} 通过 (通过率: ${Math.round(passedTests / totalTests * 100)}%)`);
    console.log('================================================================\n');

    if (passedTests !== totalTests) {
        process.exit(1);
    }
}

module.exports = runS1TestSuite;

if (require.main === module) {
    runS1TestSuite().catch(err => {
        console.error('测试运行异常:', err);
        process.exit(1);
    });
}
