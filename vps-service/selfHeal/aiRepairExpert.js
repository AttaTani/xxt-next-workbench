const Gatekeeper = require('./gatekeeper');
const RuleManager = require('./ruleManager');

/**
 * AiRepairExpert: AI 专家诊断与热补丁合成器 (Slice S1.3)
 * 当遇到未知 DOM 结构或选择器失效时，由大模型分析 DOM 差异合成补丁，并通过五道门禁热装载
 */
class AiRepairExpert {
    constructor(config, ruleManager, gatekeeper) {
        this.config = config || {};
        this.ruleManager = ruleManager || new RuleManager();
        this.gatekeeper = gatekeeper || new Gatekeeper();
    }

    /**
     * 构建诊断与热补丁生成提示词
     * @param {Object} incidentData 
     * @returns {string}
     */
    buildRepairPrompt(incidentData) {
        // 截取不超过 12,000 字符的 HTML 片段，保留核心结构
        let htmlSnippet = incidentData.htmlSnapshot || '';
        if (htmlSnippet.length > 12000) {
            // 优先截取包含 form / div 等核心容器区域
            const formIdx = htmlSnippet.indexOf('<form');
            if (formIdx !== -1) {
                htmlSnippet = htmlSnippet.substring(formIdx, formIdx + 12000);
            } else {
                htmlSnippet = htmlSnippet.substring(0, 12000);
            }
        }

        return (
            `你是一位资深前端逆向与 DOM 自动化专家。以下是超星平台页面提取失败的事故现场快照。\n` +
            `目前既有选择器无法提取到试卷题目：\n` +
            `【既有选择器配置】：\n${JSON.stringify(incidentData.currentSelectors, null, 2)}\n\n` +
            `【报错信息】：${incidentData.error}\n\n` +
            `【现场 HTML DOM 片段】：\n\`\`\`html\n${htmlSnippet}\n\`\`\`\n\n` +
            `【任务要求】：\n` +
            `1. 仔细分析 HTML 片段中题目、题型、题干、选项对应的实际标签与 class 类名。\n` +
            `2. 合成一组能够正确匹配该 HTML 结构的选择器，同时必须兼容原有类名（采用逗号分隔）。\n` +
            `3. 只能输出严格的 JSON 格式，严禁返回任何 Markdown 代码块外的修饰性文字！\n\n` +
            `【输出 JSON 契约规范】：\n` +
            `{\n` +
            `  "version": "1.0.1-patch-${Date.now()}",\n` +
            `  "target": "examSelectors",\n` +
            `  "patchType": "MERGE_SELECTORS",\n` +
            `  "selectors": {\n` +
            `    "container": ".TiMu, .Zy_TItle, #submitForm, [你推导的新容器选择器]",\n` +
            `    "questionNodes": ".TiMu, .singleQuesId, [你推导的新题目节点选择器]",\n` +
            `    "type": ".Zy_TItle_type, .type, em, [你推导的新题型选择器]",\n` +
            `    "stem": ".Zy_TItle_name, .fontx, h3, .stem, [你推导的新题干选择器]",\n` +
            `    "options": "li, .Zy_ulTop li, label, [你推导的新选项选择器]",\n` +
            `    "inputs": "input[type=\\"radio\\"], input[type=\\"checkbox\\"]"\n` +
            `  },\n` +
            `  "rationale": "简要说明类名变动原因"\n` +
            `}`
        );
    }

    /**
     * 启发式 DOM 分析器 (在离线或 LLM 无可用 Key 时的确定性后备机制)
     * @param {Object} incidentData 
     * @returns {Object}
     */
    heuristicSynthesizePatch(incidentData) {
        const html = incidentData.htmlSnapshot || '';
        const currentSelectors = incidentData.currentSelectors || {};

        // 正则提取所有 class 属性并提取高频命中的候选类
        const classMatches = html.match(/class=["']([^"']+)["']/g) || [];
        const detectedClasses = new Set();

        classMatches.forEach(m => {
            const raw = m.replace(/class=["']|["']/g, '');
            raw.split(/\s+/).forEach(cls => {
                if (cls && cls.length > 2) detectedClasses.add(cls);
            });
        });

        // 针对题型、容器、选项进行语义评分
        const candidateContainers = [];
        const candidateQuestions = [];
        const candidateStems = [];
        const candidateOptions = [];

        detectedClasses.forEach(cls => {
            const lower = cls.toLowerCase();
            if (lower.includes('exam') || lower.includes('sheet') || lower.includes('homework') || lower.includes('form')) {
                candidateContainers.push('.' + cls);
            }
            if (lower.includes('question') || lower.includes('timu') || lower.includes('ques') || lower.includes('card')) {
                candidateQuestions.push('.' + cls);
            }
            if (lower.includes('stem') || lower.includes('title') || lower.includes('name')) {
                candidateStems.push('.' + cls);
            }
            if (lower.includes('opt') || lower.includes('choice') || lower.includes('item') || lower.includes('answer')) {
                candidateOptions.push('.' + cls);
            }
        });

        // 合并既有规则生成候选补丁
        const merge = (existing, candidates) => {
            const list = (existing || '').split(',').map(s => s.trim()).filter(Boolean);
            candidates.forEach(c => { if (!list.includes(c)) list.push(c); });
            return list.join(', ');
        };

        return {
            version: `1.0.1-patch-${Date.now()}`,
            target: 'examSelectors',
            patchType: 'MERGE_SELECTORS',
            selectors: {
                container: merge(currentSelectors.container, candidateContainers),
                questionNodes: merge(currentSelectors.questionNodes, candidateQuestions),
                stem: merge(currentSelectors.stem, candidateStems),
                options: merge(currentSelectors.options, candidateOptions),
                inputs: currentSelectors.inputs || 'input[type="radio"], input[type="checkbox"]'
            },
            rationale: '基于启发式 DOM 拓扑类名逆向分析生成的自适应扩展补丁'
        };
    }

    /**
     * 触发诊断、补丁合成、过五关门禁与热装载自进化闭环
     * @param {Object} incidentData 
     * @returns {Promise<{ success: boolean, patch: Object, gateReport: Object, version?: string, error?: string }>}
     */
    async diagnoseAndRepair(incidentData) {
        console.log(`[AiRepairExpert] 🩺 启动代码级自进化沙箱修复... 事故ID: ${incidentData.incidentId}`);

        let candidatePatch = null;
        const apiKey = this.config.qwenApiKey || process.env.DASHSCOPE_API_KEY;
        const baseUrl = this.config.qwenBaseUrl || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
        const model = this.config.examModel || 'qwen-plus';

        // 1. 尝试调用大模型生成高级推导补丁
        if (apiKey) {
            try {
                const prompt = this.buildRepairPrompt(incidentData);
                console.log(`[AiRepairExpert] 正在调用 ${model} 专家模型进行 DOM 拓扑逆向推导...`);

                const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model,
                        temperature: 0.1,
                        messages: [
                            { role: 'system', content: '你是一位顶尖的前端逆向与自动化架构师，只输出符合 Schema 规范的纯 JSON。' },
                            { role: 'user', content: prompt }
                        ]
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    let raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
                    if (raw) {
                        raw = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
                        candidatePatch = JSON.parse(raw);
                        console.log(`[AiRepairExpert] 大模型已产出结构化候选补丁: ${candidatePatch.version}`);
                    }
                }
            } catch (e) {
                console.warn(`[AiRepairExpert] 大模型推导异常 (${e.message})，启用启发式后备引擎`);
            }
        }

        // 2. 若大模型离线或解析失败，使用确定性启发式分析器保底
        if (!candidatePatch) {
            console.log('[AiRepairExpert] 启动启发式 DOM 分析生成保底补丁...');
            candidatePatch = this.heuristicSynthesizePatch(incidentData);
        }

        // 3. 将候选补丁提交至【五道防爆安全门禁】
        console.log('[AiRepairExpert] 🛡️ 正在将候选补丁提交至五道防爆安全门禁 (Gate 1 ~ Gate 5)...');
        const gateReport = await this.gatekeeper.evaluatePatch(candidatePatch, incidentData.htmlSnapshot);

        console.log('[AiRepairExpert] 门禁审核结果:\n' + gateReport.gateResults.map(r => `  Gate ${r.gate} [${r.passed ? 'PASS' : 'FAIL'}]: ${r.name} -> ${r.message}`).join('\n'));

        if (!gateReport.passed) {
            console.error('[AiRepairExpert] ❌ 补丁未通过防爆安全门禁，已阻断热替换，确保生产系统零被污染！');
            this.gatekeeper.reportExecutionResult(false);
            return {
                success: false,
                patch: candidatePatch,
                gateReport,
                error: '未通过防爆门禁审核'
            };
        }

        // 4. 五关全过 -> 内存动态热重载 (无需重启服务)
        const applyRes = this.ruleManager.applyPatch(candidatePatch);
        this.gatekeeper.reportExecutionResult(true);

        console.log(`[AiRepairExpert] 🎉 自进化热修复完成！规则库已原子热重载至 v${applyRes.newVersion}`);

        return {
            success: true,
            patch: candidatePatch,
            gateReport,
            version: applyRes.newVersion,
            rationale: candidatePatch.rationale
        };
    }
}

module.exports = AiRepairExpert;
