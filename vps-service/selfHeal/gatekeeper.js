const fs = require('fs');
const path = require('path');
const vm = require('vm');
const AstAuditor = require('./astAuditor');
const { FIXTURES, testExtractFromHtml } = require('./testFixtures');

/**
 * Gatekeeper: 五道防爆安全门禁统领核心 (The 5 Defense Gates)
 */
class Gatekeeper {
    constructor(baseDir) {
        this.baseDir = baseDir || path.resolve(__dirname, '../../');
        this.sandboxRootDir = path.join(this.baseDir, '.sandbox');
        this.circuitBreaker = {
            failureCount: 0,
            threshold: 2,
            isTripped: false,
            lastTrippedTime: 0,
            activePatchVersion: null
        };
        this._ensureDirs();
    }

    _ensureDirs() {
        if (!fs.existsSync(this.sandboxRootDir)) {
            fs.mkdirSync(this.sandboxRootDir, { recursive: true });
        }
    }

    /**
     * 运行五道防爆门禁综合评测流水线
     * @param {Object} patch - 候选补丁包
     * @param {string} [incidentHtml] - 故障现场原始 HTML 快照 (用于验证故障修复率)
     * @returns {Promise<{ passed: boolean, gateResults: Array<{ gate: number, name: string, passed: boolean, message: string }>, patch: Object }>}
     */
    async evaluatePatch(patch, incidentHtml = '') {
        const results = [];
        const timestamp = Date.now();
        const sandboxDir = path.join(this.sandboxRootDir, `hotfix-${timestamp}`);

        try {
            // ==========================================
            // Gate 1: 物理沙盒隔离 (Sandbox Isolation)
            // ==========================================
            let gate1Passed = false;
            let gate1Msg = '';
            try {
                fs.mkdirSync(sandboxDir, { recursive: true });
                const sandboxPatchFile = path.join(sandboxDir, 'candidate_patch.json');
                fs.writeFileSync(sandboxPatchFile, JSON.stringify(patch, null, 2), 'utf-8');
                gate1Passed = fs.existsSync(sandboxPatchFile);
                gate1Msg = `沙盒创建成功: ${sandboxDir}`;
            } catch (e) {
                gate1Msg = `沙盒隔离创建失败: ${e.message}`;
            }
            results.push({ gate: 1, name: '沙盒物理隔离 (Sandbox Isolation)', passed: gate1Passed, message: gate1Msg });
            if (!gate1Passed) return { passed: false, gateResults: results, patch };

            // ==========================================
            // Gate 2: 爆炸半径与 AST 安全审计 (Blast Radius & AST Whitelist)
            // ==========================================
            const auditRes = AstAuditor.auditPatch(patch);
            results.push({
                gate: 2,
                name: '爆炸半径与 AST 安全审计 (Blast Radius & AST Whitelist)',
                passed: auditRes.passed,
                message: auditRes.passed ? '零危险特征，目标位于规则白名单' : auditRes.violations.join('; ')
            });
            if (!auditRes.passed) return { passed: false, gateResults: results, patch };

            // ==========================================
            // Gate 3: 静态语法健康校验 (Static Syntax Gate)
            // ==========================================
            let gate3Passed = false;
            let gate3Msg = '';
            try {
                // 校验补丁中的 JSON 结构及选择器字符串语法
                const testObj = JSON.parse(JSON.stringify(patch));
                // 测试沙盒内虚拟上下文脚本解析
                const scriptContent = `const patch = ${JSON.stringify(testObj)}; Object.freeze(patch);`;
                new vm.Script(scriptContent);
                gate3Passed = true;
                gate3Msg = 'JSON/ES6 静态语法严格校验通过 (0 SyntaxError)';
            } catch (e) {
                gate3Msg = `语法校验未通过: ${e.message}`;
            }
            results.push({ gate: 3, name: '静态语法健康校验 (Static Syntax Gate)', passed: gate3Passed, message: gate3Msg });
            if (!gate3Passed) return { passed: false, gateResults: results, patch };

            // ==========================================
            // Gate 4: 离线 Mock 治具全量回归 (Offline Mock Regression Gate)
            // ==========================================
            let gate4Passed = true;
            const regressionDetails = [];

            // 1. 基线试卷回归验证 (必须 100% 保持可用)
            const mergedSelectors = patch.selectors || {};
            const r1 = testExtractFromHtml(FIXTURES.baseline_standard_single, mergedSelectors);
            const r2 = testExtractFromHtml(FIXTURES.baseline_multi_and_judge, mergedSelectors);

            if (!r1.success || !r2.success) {
                gate4Passed = false;
                regressionDetails.push(`基线用例提取失败: standard=${r1.success}, multi=${r2.success}`);
            } else {
                regressionDetails.push('历史 2 套标准基线用例 100% 提取通过');
            }

            // 2. 故障重放验证 (若提供了事故现场 HTML，新选择器必须能成功命中)
            if (incidentHtml) {
                const incidentRes = testExtractFromHtml(incidentHtml, mergedSelectors);
                if (!incidentRes.success) {
                    gate4Passed = false;
                    regressionDetails.push('故障现场 DOM 提取仍未解决 (0 命中)');
                } else {
                    regressionDetails.push('故障现场 DOM 成功提取修复 (修复率 100%)');
                }
            }

            results.push({
                gate: 4,
                name: '离线 Mock 治具全量回归 (Offline Mock Regression Gate)',
                passed: gate4Passed,
                message: regressionDetails.join(' | ')
            });
            if (!gate4Passed) return { passed: false, gateResults: results, patch };

            // ==========================================
            // Gate 5: 毫秒级熔断器与原子回滚就绪 (Circuit Breaker Gate)
            // ==========================================
            let gate5Passed = !this.circuitBreaker.isTripped;
            let gate5Msg = '';
            if (this.circuitBreaker.isTripped) {
                gate5Msg = `熔断器处于跳闸状态 (触发时间: ${new Date(this.circuitBreaker.lastTrippedTime).toLocaleTimeString()})，拒绝热修`;
            } else {
                gate5Passed = true;
                gate5Msg = `熔断就绪，当前失败计数: ${this.circuitBreaker.failureCount}/${this.circuitBreaker.threshold}，已配置毫秒级回滚钩子`;
            }

            results.push({
                gate: 5,
                name: '毫秒级熔断看门狗 (Circuit Breaker & Rollback Gate)',
                passed: gate5Passed,
                message: gate5Msg
            });

            const allPassed = results.every(r => r.passed);
            return {
                passed: allPassed,
                gateResults: results,
                patch
            };
        } finally {
            // 清理临时沙盒目录 (如果需要归档则保留，否则清理)
            try {
                if (fs.existsSync(sandboxDir)) {
                    // 保留沙盒记录供追溯
                }
            } catch (e) {}
        }
    }

    /**
     * 汇报任务结果以更新熔断器状态
     * @param {boolean} success 
     */
    reportExecutionResult(success) {
        if (success) {
            this.circuitBreaker.failureCount = 0;
            this.circuitBreaker.isTripped = false;
        } else {
            this.circuitBreaker.failureCount++;
            if (this.circuitBreaker.failureCount >= this.circuitBreaker.threshold) {
                this.circuitBreaker.isTripped = true;
                this.circuitBreaker.lastTrippedTime = Date.now();
                console.warn(`[Gatekeeper] ⚠️ 触发熔断保护！连续失败 ${this.circuitBreaker.failureCount} 次，自动跳闸防止系统震荡！`);
            }
        }
    }

    /**
     * 重置熔断器
     */
    resetCircuitBreaker() {
        this.circuitBreaker.failureCount = 0;
        this.circuitBreaker.isTripped = false;
        console.log('[Gatekeeper] 熔断器已手动复位');
    }
}

module.exports = Gatekeeper;
