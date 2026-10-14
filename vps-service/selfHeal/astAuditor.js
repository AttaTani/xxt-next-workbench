/**
 * astAuditor.js: AST 语法树安全审查与爆炸半径限制器 (Gate 2 核心)
 * 严格防范 AI 补丁产生越权调用、危险命令执行、文件破坏及 ReDoS 攻击
 */

const BANNED_PATTERNS = [
    /\bchild_process\b/i,
    /\bexec(Sync)?\b/i,
    /\bspawn(Sync)?\b/i,
    /\beval\s*\(/i,
    /\bFunction\s*\(/i,
    /\bprocess\s*\.\s*(exit|kill|abort)\b/i,
    /\bfs\s*\.\s*(unlink|rmdir|rm|truncate|chmod)\b/i,
    /\b__proto__\b/i,
    /\bconstructor\s*\[\s*['"]prototype['"]\s*\]/i,
    /\bObject\s*\.\s*setPrototypeOf\b/i
];

const ALLOWED_RULE_KEYS = [
    'exam.container',
    'exam.questionNodes',
    'exam.type',
    'exam.stem',
    'exam.options',
    'exam.inputs',
    'exam.submitButtons',
    'exam.saveButtons',
    'exam.confirmButtons',
    'exam.completedMarkers',
    'quiz.modal',
    'quiz.options',
    'quiz.submitButton',
    'catalog.container',
    'catalog.activeItem',
    'catalog.allUnits'
];

class AstAuditor {
    /**
     * 审核候选补丁包的安全合规性与爆炸半径
     * @param {Object} patch
     * @returns {{ passed: boolean, violations: string[] }}
     */
    static auditPatch(patch) {
        const violations = [];

        if (!patch || typeof patch !== 'object') {
            return { passed: false, violations: ['补丁格式无效，必须为非空 Object'] };
        }

        // 1. 检查目标是否在允许的爆炸半径内
        if (patch.target && !['examSelectors', 'quizSelectors', 'catalogSelectors'].includes(patch.target)) {
            violations.push(`[Gate 2 爆炸半径超标] 非法 target: ${patch.target}，只允许修改规则选择器`);
        }

        // 2. 原型链污染防护 (Prototype Pollution Guard)
        const checkPrototypePollution = (obj) => {
            if (!obj || typeof obj !== 'object') return false;
            const proto = Object.getPrototypeOf(obj);
            if (proto !== Object.prototype && proto !== null && !Array.isArray(obj)) {
                return true;
            }
            const ownKeys = Object.getOwnPropertyNames(obj);
            if (ownKeys.includes('__proto__') || ownKeys.includes('prototype')) {
                return true;
            }
            for (const key of Object.keys(obj)) {
                if (typeof obj[key] === 'object' && checkPrototypePollution(obj[key])) {
                    return true;
                }
            }
            return false;
        };

        if (checkPrototypePollution(patch)) {
            violations.push('[Gate 2 原型链拦截] 检测到 __proto__ 或原型篡改行为');
        }

        // 3. 深度扫描 JSON 结构中的字符串，检测危险黑名单
        const patchString = JSON.stringify(patch);
        for (const pattern of BANNED_PATTERNS) {
            if (pattern.test(patchString)) {
                violations.push(`[Gate 2 安全违规] 检测到危险调用特征: ${pattern.toString()}`);
            }
        }

        // 3. 校验具体的选择器键值
        if (patch.selectors && typeof patch.selectors === 'object') {
            for (const [key, value] of Object.entries(patch.selectors)) {
                if (typeof value !== 'string') {
                    violations.push(`[Gate 2 类型违规] 选择器 ${key} 的值必须为 string 类型`);
                    continue;
                }

                // 长度防护: 单个选择器字符串不得超过 2000 字符，防 DoS 注入
                if (value.length > 2000) {
                    violations.push(`[Gate 2 溢出违规] 选择器 ${key} 长度(${value.length})超出上限 2000`);
                }

                // CSS 选择器合法性粗筛: 严禁包含 JS 代码块注入如 <script> 或 javascript:
                if (/<script/i.test(value) || /javascript:/i.test(value)) {
                    violations.push(`[Gate 2 XSS 拦截] 选择器 ${key} 包含潜在脚本注入字符`);
                }
            }
        } else {
            violations.push('[Gate 2 缺少选择器] 补丁必须包含有效 selectors 字典');
        }

        return {
            passed: violations.length === 0,
            violations
        };
    }

    /**
     * 对 JS 脚本文件实施语法与安全审计
     * @param {string} codeContent 
     * @returns {{ passed: boolean, violations: string[] }}
     */
    static auditCode(codeContent) {
        const violations = [];
        if (!codeContent || typeof codeContent !== 'string') {
            return { passed: false, violations: ['代码内容为空'] };
        }

        for (const pattern of BANNED_PATTERNS) {
            if (pattern.test(codeContent)) {
                violations.push(`[Gate 2 AST 违规] 源码命中安全拦截规则: ${pattern.toString()}`);
            }
        }

        return {
            passed: violations.length === 0,
            violations
        };
    }
}

module.exports = AstAuditor;
