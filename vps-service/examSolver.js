const EventEmitter = require('events');
const { RuleManager, IncidentDumper, AiRepairExpert, Gatekeeper } = require('./selfHeal');

/**
 * ExamSolver: 超星整页独立章节测验与作业提取及作答引擎
 */
class ExamSolver extends EventEmitter {
    constructor(config) {
        super();
        this.config = config || {};
        this.ruleManager = new RuleManager();
        this.gatekeeper = new Gatekeeper();
        this.incidentDumper = new IncidentDumper();
        this.aiRepairExpert = new AiRepairExpert(this.config, this.ruleManager, this.gatekeeper);
    }

    /**
     * 穿透页面所有主/子 iframe，探测并提取全量试卷信息
     * @param {import('playwright').Page} page 
     * @returns {Promise<{ found: boolean, frame: any, questions: Array, submitBtnSelector: string, saveBtnSelector: string }>}
     */
    async detectAndExtractExam(page) {
        if (!page || page.isClosed()) return { found: false, questions: [] };

        const allFrames = [page, ...page.frames()];
        const selectors = this.ruleManager.getModuleSelectors('exam') || {};

        for (const frame of allFrames) {
            try {
                let examData = await this._evaluateFrameExam(frame, selectors);

                // 自进化热修复 Hook: 若当前 frame 明确属于作业/测验页面但未能提取到试题
                const frameUrl = frame.url ? frame.url() : '';
                const isExamFrameLikely = /work|homework|exam|doHomeWork|studentstudy/i.test(frameUrl);

                if ((!examData || examData.questionCount === 0) && isExamFrameLikely) {
                    if (this.config.enableSelfHealing !== false) {
                        console.log(`[ExamSolver] ⚠️ 测验 iframe (${frameUrl}) 提取题目为 0，触发现场快照与自进化诊断...`);
                        const dump = await this.incidentDumper.dumpIncident({
                            page,
                            frame,
                            taskId: 'live_exam',
                            taskName: '独立章节测验',
                            scene: 'CHAPTER_EXAM',
                            error: 'ZeroQuestionsExtracted: Likely DOM selector mutation.',
                            currentSelectors: selectors
                        });

                        const healRes = await this.aiRepairExpert.diagnoseAndRepair(dump.incidentData);
                        if (healRes.success) {
                            console.log(`[ExamSolver] 🚀 自愈规则热重载完成 (v${healRes.version})，立即重试提取...`);
                            const updatedSelectors = this.ruleManager.getModuleSelectors('exam');
                            examData = await this._evaluateFrameExam(frame, updatedSelectors);
                        }
                    }
                }

                if (examData && examData.questionCount > 0) {
                    return {
                        found: true,
                        frame,
                        ...examData
                    };
                }
            } catch (err) {}
        }

        return { found: false, questions: [] };
    }

    /**
     * 在指定 frame 内部执行基于动态选择器的题目 DOM 提取
     * @private
     */
    async _evaluateFrameExam(frame, selectors) {
        return await frame.evaluate((sel) => {
            const containerSel = sel.container || '.TiMu, .Zy_TItle, #submitForm, .questionList, .singleQuesId, .Cy_TItle, .marBom60, .Zy_ulTop';
            const qNodeSel = sel.questionNodes || '.TiMu, .singleQuesId, .marBom60, [id^="question_"], .question_item, .stem_holder, .Zy_TItle';
            const typeSel = sel.type || '.Zy_TItle_type, .type, .TiMu_type, em';
            const stemSel = sel.stem || '.Zy_TItle_name, .Zy_TItle, .fontx, h3, .stem';
            const optSel = sel.options || 'li, .Zy_ulTop li, .answerBg, label, .ans-options-list li';

            // 超星章节测验与作业核心容器探测
            const examContainer = document.querySelector(containerSel);
            if (!examContainer) return null;

            // 提取所有独立整题容器 (过滤父子嵌套)
            let questionNodes = Array.from(document.querySelectorAll(qNodeSel));
            questionNodes = questionNodes.filter(node => !questionNodes.some(other => other !== node && other.contains(node)));
            if (questionNodes.length === 0) return null;

            const parsedQuestions = [];

            questionNodes.forEach((qNode, idx) => {
                // 1. 题型判断
                let qType = '单选题';
                const typeEl = qNode.querySelector(typeSel);
                const rawType = (typeEl ? typeEl.innerText : qNode.innerText) || '';
                if (rawType.includes('多选')) qType = '多选题';
                else if (rawType.includes('判断')) qType = '判断题';
                else if (rawType.includes('填空')) qType = '填空题';

                // 2. 题干文本提取与清洗
                const stemEl = qNode.querySelector(stemSel) || qNode;
                let stem = (stemEl.innerText || '').trim();
                // 过滤题干开头的题号与题型标签如: 1. 【单选题】
                stem = stem.replace(/^\d+[\.、\s]*/, '')
                           .replace(/^【(单选题|多选题|判断题|填空题)】/, '')
                           .replace(/\([^\)]*分\)/g, '')
                           .trim();

                // 3. 选项列表与选择器定位
                const options = [];
                const optElements = Array.from(qNode.querySelectorAll(optSel));

                optElements.forEach((optEl, optIdx) => {
                    const optText = (optEl.innerText || '').trim();
                    if (!optText) return;

                    // 提取选项字母 A, B, C, D
                    const letterMatch = optText.match(/^([A-Z])[\.、\:\s]/i);
                    const letter = letterMatch ? letterMatch[1].toUpperCase() : String.fromCharCode(65 + optIdx);
                    const cleanContent = optText.replace(/^[A-Z][\.、\:\s]+/i, '').trim();

                    // 关联的 input radio/checkbox 或可点击容器
                    const inputEl = optEl.querySelector('input[type="radio"], input[type="checkbox"]');
                    const inputId = inputEl ? inputEl.id : '';
                    const inputName = inputEl ? inputEl.name : '';
                    const inputValue = inputEl ? inputEl.value : '';

                    options.push({
                        letter,
                        rawText: optText,
                        content: cleanContent,
                        inputId,
                        inputName,
                        inputValue,
                        optionIndex: optIdx
                    });
                });

                // 仅收录含有有效题干和选项的选择/判断题
                if (stem && options.length > 0) {
                    parsedQuestions.push({
                        questionIndex: idx,
                        id: `ques_${idx + 1}`,
                        type: qType,
                        stem,
                        options
                    });
                }
            });

            if (parsedQuestions.length === 0) return null;

            // 检查页面底部提交与保存按钮
            const hasSubmitBtn = !!document.querySelector('.Btn_blue_1, a[onclick*="btnBlueSubmit"], .btnSubmit, #btnSubmit, a.btn-ok, a[onclick*="formSubmit"], input[type="submit"], .submitBtn, a.btn_ok, #formSubmit, [onclick*="submit" i], .workBtnIndex');
            const hasSaveBtn = !!document.querySelector('.btnGray_1, a[onclick*="noSubmit"], .btnSave, #btnSave, a.btn-save, a[onclick*="saveForm"], [onclick*="save" i]');
            const bodyText = document.body ? document.body.innerText : '';
            const isCompleted = (!hasSubmitBtn && !hasSaveBtn) && 
                (bodyText.includes('已完成') || bodyText.includes('已提交') || bodyText.includes('已批阅') || bodyText.includes('您的得分') || bodyText.includes('成绩'));

            return {
                title: (document.title || '章节测验').trim(),
                questionCount: parsedQuestions.length,
                questions: parsedQuestions,
                hasSubmitBtn,
                hasSaveBtn,
                isCompleted
            };
        }, selectors);
    }

    /**
     * 构造整卷题目的批量提问 Prompt
     * @param {Array} questions 
     * @returns {string}
     */
    buildBatchExamPrompt(questions) {
        let prompt = 
            `你是一位国家级高等教育课程考试各学科答题权威专家。\n` +
            `请仔细阅读并严格审查下列整页大学课程测验试卷题目，针对每一道题目推导并给出最优标准答案。\n\n` +
            `【试卷题目列表】：\n`;

        questions.forEach((q, idx) => {
            const qNum = idx + 1;
            prompt += `第${qNum}题 (${q.type})：${q.stem}\n`;
            prompt += `选项：\n`;
            (q.options || []).forEach(opt => {
                prompt += `  ${opt.letter}. ${opt.content || opt.rawText}\n`;
            });
            prompt += `\n`;
        });

        prompt += 
            `【答题与输出规范】：\n` +
            `1. 必须且只能输出严格的合法 JSON 字典，严禁包含任何前缀、解释、思考过程或多余的 Markdown 标记。\n` +
            `2. JSON 键为题号字符串（如 "1", "2", "3"），值为该题对应的选项大写字母。\n` +
            `3. 单选题或判断题：只能是单个选项字母，如 "A" 或 "B"。\n` +
            `4. 多选题：将所有正确选项的大写字母连续组合输出，无逗号和空格，如 "ABC"、"ACD"。\n` +
            `5. 判断题特别注意：若选项 A 为“对/正确”，B 为“错/错误”，请根据陈述的正误直接给出 A 或 B。\n` +
            `6. 示例格式：\n` +
            `{"1": "A", "2": "B", "3": "ACD"}\n`;

        return prompt;
    }

    /**
     * 解析并校验模型返回的答案 JSON
     * @param {string} rawContent 
     * @param {Array} questions 
     * @returns {{ valid: boolean, answers: Object, details: Array }}
     */
    cleanAndValidateAnswers(rawContent, questions) {
        let parsedJson = null;

        try {
            // 提取外层 {...}
            const match = (rawContent || '').match(/\{[\s\S]*\}/);
            if (match) {
                parsedJson = JSON.parse(match[0]);
            }
        } catch (e) {
            console.error('[ExamSolver] JSON.parse 失败，尝试正则提取:', e.message);
        }

        // 若直接 JSON.parse 失败，做正则降级提取: "1": "A" 或 1: "A"
        if (!parsedJson) {
            parsedJson = {};
            const regex = /(?:["']?(\d+)["']?\s*:\s*["']?([A-Za-z]+)["']?)/g;
            let m;
            while ((m = regex.exec(rawContent)) !== null) {
                parsedJson[m[1]] = m[2].toUpperCase();
            }
        }

        const answers = {};
        const details = [];

        questions.forEach((q, idx) => {
            const qNum = String(idx + 1);
            // 候选 key: "1", 1, q.id, `ques_${qNum}`
            let rawAns = parsedJson[qNum] || parsedJson[idx + 1] || parsedJson[q.id] || parsedJson[`ques_${qNum}`] || '';
            
            // 格式清洗：只保留大写英文字母
            let cleanAns = String(rawAns).replace(/[^A-Za-z]/g, '').toUpperCase();

            // 获取该题支持的所有有效选项字母集合
            const availableLetters = (q.options || []).map(opt => opt.letter.toUpperCase());

            // 过滤不在选项范围内的非法字母
            cleanAns = cleanAns.split('').filter(char => availableLetters.includes(char)).join('');

            // 如果答案仍为空，安全回退到该题第一个选项
            if (!cleanAns && availableLetters.length > 0) {
                cleanAns = availableLetters[0];
            }

            answers[qNum] = cleanAns;
            details.push({
                questionNumber: qNum,
                type: q.type,
                stem: q.stem.substring(0, 30) + (q.stem.length > 30 ? '...' : ''),
                predicted: cleanAns,
                availableOptions: availableLetters
            });
        });

        const validCount = Object.keys(answers).length;
        return {
            valid: validCount === questions.length,
            answers,
            details
        };
    }

    /**
     * 调用千问大模型进行批量试卷秒级推理
     * @param {Array} questions 
     * @returns {Promise<{ success: boolean, answers: Object, durationMs: number, details: Array, rawContent: string, model: string, error?: string }>}
     */
    async askQwenBatchExam(questions) {
        const startTime = Date.now();
        if (!questions || questions.length === 0) {
            return { success: false, answers: {}, durationMs: 0, error: '试卷题目列表为空' };
        }

        const apiKey = this.config.qwenApiKey || process.env.DASHSCOPE_API_KEY;
        const baseUrl = this.config.qwenBaseUrl || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
        const model = this.config.examModel || this.config.textContentModel || 'qwen-plus';

        if (!apiKey) {
            return { success: false, answers: {}, durationMs: 0, error: '未配置 Qwen API Key' };
        }

        const prompt = this.buildBatchExamPrompt(questions);

        try {
            const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: '你是一位顶尖的高校课程试题解答专家，输出必须是合法纯 JSON 格式。' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.05
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`API HTTP ${res.status}: ${errText}`);
            }

            const data = await res.json();
            const durationMs = Date.now() - startTime;
            const rawContent = data.choices?.[0]?.message?.content?.trim() || '';

            const { valid, answers, details } = this.cleanAndValidateAnswers(rawContent, questions);

            return {
                success: valid,
                answers,
                durationMs,
                details,
                rawContent,
                model
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            return {
                success: false,
                answers: {},
                durationMs,
                error: error.message
            };
        }
    }

    /**
     * 模拟用户在试卷中批量勾选各题目标准答案
     * @param {any} frame Playwright Frame 或 Page
     * @param {Array} questions 提取出的题目列表
     * @param {Object} answers 大模型推导出的答案字典 {"1": "A", "2": "ABC"}
     * @param {number} delayMs 勾选间隔延迟(ms)
     * @returns {Promise<{ clickedCount: number, details: Array }>}
     */
    async fillAnswers(frame, questions, answers, delayMs = 250) {
        if (!frame || !questions || !answers) return { clickedCount: 0, details: [] };

        const clickDetails = [];
        let totalClicked = 0;

        for (let idx = 0; idx < questions.length; idx++) {
            const q = questions[idx];
            const qNum = String(idx + 1);
            const targetAns = answers[qNum] || '';
            if (!targetAns) continue;

            const targetLetters = targetAns.split(''); // 如 ['A'] 或 ['A', 'C', 'D']

            for (const letter of targetLetters) {
                const targetOpt = (q.options || []).find(o => o.letter === letter);
                try {
                    const clickResult = await frame.evaluate(({ qIdx, targetLetter, optData }) => {
                        // 策略 1: 若选项有已知的唯一 inputId，直接精准点击
                        if (optData && optData.inputId) {
                            const inp = document.getElementById(optData.inputId);
                            if (inp) {
                                if (!inp.checked) {
                                    inp.click();
                                    return { success: true, method: 'direct_id_click', optLetter: targetLetter };
                                }
                                return { success: true, method: 'already_checked', optLetter: targetLetter };
                            }
                        }

                        // 策略 2: 若有 inputName
                        if (optData && optData.inputName) {
                            let inp = null;
                            if (optData.inputValue) {
                                inp = document.querySelector(`input[name="${optData.inputName}"][value="${optData.inputValue}"]`);
                            }
                            if (!inp && typeof optData.optionIndex === 'number') {
                                const matchedInputs = Array.from(document.querySelectorAll(`input[name="${optData.inputName}"]`));
                                if (matchedInputs[optData.optionIndex]) inp = matchedInputs[optData.optionIndex];
                            }
                            if (inp) {
                                if (!inp.checked) {
                                    inp.click();
                                    return { success: true, method: 'name_index_click', optLetter: targetLetter };
                                }
                                return { success: true, method: 'already_checked', optLetter: targetLetter };
                            }
                        }

                        // 策略 3: 定位题目容器 (严格过滤父子嵌套，保证与提取时序号严格对应)
                        let questionNodes = Array.from(document.querySelectorAll('.TiMu, .singleQuesId, .marBom60'));
                        if (questionNodes.length === 0) {
                            questionNodes = Array.from(document.querySelectorAll('[id^="question_"], .question_item, .stem_holder'));
                        }
                        if (questionNodes.length === 0) {
                            questionNodes = Array.from(document.querySelectorAll('.Zy_TItle'));
                        }
                        questionNodes = questionNodes.filter(node => !questionNodes.some(other => other !== node && other.contains(node)));

                        const qNode = questionNodes[qIdx];
                        if (!qNode) return { success: false, reason: 'QUESTION_NODE_NOT_FOUND' };

                        // 遍历选项节点
                        const optElements = Array.from(qNode.querySelectorAll('li, .Zy_ulTop li, .answerBg, label, .ans-options-list li'));
                        for (let optIdx = 0; optIdx < optElements.length; optIdx++) {
                            const optEl = optElements[optIdx];
                            const optText = (optEl.innerText || '').trim();
                            const letterMatch = optText.match(/^([A-Z])[\.、\:\s]/i);
                            const optLetter = letterMatch ? letterMatch[1].toUpperCase() : String.fromCharCode(65 + optIdx);

                            if (optLetter === targetLetter) {
                                const inputEl = optEl.querySelector('input[type="radio"], input[type="checkbox"]');
                                if (inputEl) {
                                    if (!inputEl.checked) {
                                        inputEl.click();
                                        return { success: true, method: 'container_input_click', optLetter };
                                    } else {
                                        return { success: true, method: 'already_checked', optLetter };
                                    }
                                }
                                optEl.click();
                                return { success: true, method: 'element_click', optLetter };
                            }
                        }

                        // 策略 4: 题目容器内通过 input 位置或值降级匹配 (支持 true/false 与 A/B)
                        const inputs = Array.from(qNode.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
                        for (let optIdx = 0; optIdx < inputs.length; optIdx++) {
                            const inp = inputs[optIdx];
                            const val = (inp.value || '').toUpperCase();
                            const derivedLetter = String.fromCharCode(65 + optIdx);
                            const isMatch = val === targetLetter || derivedLetter === targetLetter ||
                                (targetLetter === 'A' && (val === 'TRUE' || val === '1')) ||
                                (targetLetter === 'B' && (val === 'FALSE' || val === '0'));
                            if (isMatch) {
                                if (!inp.checked) {
                                    inp.click();
                                    return { success: true, method: 'fallback_input_click', optLetter: targetLetter };
                                }
                                return { success: true, method: 'already_checked', optLetter: targetLetter };
                            }
                        }

                        return { success: false, reason: 'OPTION_NOT_FOUND', targetLetter };
                    }, { qIdx: idx, targetLetter: letter, optData: targetOpt });

                    if (clickResult && clickResult.success) {
                        totalClicked++;
                        clickDetails.push({ qNum, letter, result: clickResult.method });
                    }

                    // 防风控微随机延迟
                    const jitter = Math.floor(Math.random() * 80) - 40;
                    const sleepTime = Math.max(100, delayMs + jitter);
                    await new Promise(r => setTimeout(r, sleepTime));
                } catch (err) {
                    console.error(`[ExamSolver] 点击第 ${qNum} 题选项 ${letter} 出错:`, err.message);
                }
            }
        }

        return { clickedCount: totalClicked, details: clickDetails };
    }

    /**
     * 提交试卷或保存答题结果
     * @param {any} frame 
     * @param {string} mode "AUTO_SUBMIT" | "SAVE_ONLY"
     * @returns {Promise<{ success: boolean, actionTaken: string }>}
     */
    async submitOrSave(frame, mode = 'AUTO_SUBMIT') {
        if (!frame) return { success: false, actionTaken: 'NO_FRAME' };

        try {
            const result = await frame.evaluate(async (submitMode) => {
                // 劫持弹窗以防阻塞
                window.confirm = () => true;
                window.alert = () => true;

                if (submitMode === 'AUTO_SUBMIT') {
                    // 查找提交按钮 (包含常规测验与超星新版作业)
                    const submitSelectors = [
                        '.Btn_blue_1', 'a[onclick*="btnBlueSubmit"]',
                        '.btnSubmit', '#btnSubmit', 'a.btn-ok', 'a[onclick*="formSubmit"]',
                        'input[type="submit"]', '.submitBtn', 'a.btn_ok', '#formSubmit',
                        'a[onclick*="btnSubmit"]', 'a[onclick*="submit" i]', '.Zy_btn_ok', '.btn_ok', '.workBtnIndex'
                    ];

                    let submitBtn = null;
                    for (const sel of submitSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.offsetParent !== null) {
                            submitBtn = el;
                            break;
                        }
                    }

                    if (!submitBtn) {
                        // 文本匹配提交按钮
                        const allBtns = Array.from(document.querySelectorAll('button, a, input[type="button"], span.btn, div.btn'));
                        submitBtn = allBtns.find(b => {
                            const t = (b.innerText || b.value || '').trim();
                            return t === '提交' || t === '交卷' || t === '提交作业' || t === '提交测验';
                        });
                    }

                    if (submitBtn) {
                        submitBtn.scrollIntoView();
                        submitBtn.click();

                        // 延时处理可能出现的超星确认弹窗
                        setTimeout(() => {
                            const popoverConfirmBtns = Array.from(document.querySelectorAll('.bluebtn, a[onclick*="submitCheckTimes"], .popover .btn-ok, .ans-dialog .btn-ok, .layui-layer-btn0, a.ok, a.confirm, .pop-btn-ok'));
                            popoverConfirmBtns.forEach(b => {
                                const t = (b.innerText || '').trim();
                                if (t === '确定' || t === '提交' || t === '是') b.click();
                            });
                        }, 500);

                        return { success: true, action: 'SUBMITTED' };
                    }

                    return { success: false, action: 'SUBMIT_BTN_NOT_FOUND' };
                } else {
                    // SAVE_ONLY 暂存模式
                    const saveSelectors = [
                        '.btnGray_1', 'a[onclick*="noSubmit"]',
                        '.btnSave', '#btnSave', 'a.btn-save', 'a[onclick*="saveForm"]',
                        '.saveBtn', 'a.btn_save', 'a[onclick*="save" i]', '#save'
                    ];
                    let saveBtn = null;
                    for (const sel of saveSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.offsetParent !== null) {
                            saveBtn = el;
                            break;
                        }
                    }

                    if (!saveBtn) {
                        const allBtns = Array.from(document.querySelectorAll('button, a, input[type="button"], span.btn'));
                        saveBtn = allBtns.find(b => {
                            const t = (b.innerText || b.value || '').trim();
                            return t === '暂存' || t === '保存' || t === '保存未提交';
                        });
                    }

                    if (saveBtn) {
                        saveBtn.scrollIntoView();
                        saveBtn.click();
                        return { success: true, action: 'SAVED' };
                    }

                    return { success: true, action: 'ANSWERS_FILLED_NO_SAVE_BTN' };
                }
            }, mode);

            // 在主页面也做一次确认弹窗探测点击
            await new Promise(r => setTimeout(r, 1000));
            try {
                if (frame.page) {
                    await frame.page().evaluate(() => {
                        window.confirm = () => true;
                        window.alert = () => true;
                        const modalOk = document.querySelector('.popover .btn-ok, .ans-dialog .btn-ok, .layui-layer-btn0, a.ok, a.confirm, .bluebtn, .pop-btn-ok');
                        if (modalOk) modalOk.click();
                    });
                }
            } catch (e) {}

            return result;
        } catch (err) {
            return { success: false, actionTaken: 'ERROR', error: err.message };
        }
    }

    /**
     * 高级调度入口：自动识别、推导答案、批量勾选并提交章节测验
     * @param {import('playwright').Page} page 
     * @param {Object} options 覆盖配置 (examSubmitMode, examDelayBetweenClicksMs, etc.)
     * @returns {Promise<{ handled: boolean, success: boolean, alreadyDone?: boolean, questionsCount?: number, answers?: Object, details?: Array, actionTaken?: string, error?: string }>}
     */
    async solveExam(page, options = {}) {
        if (!page || page.isClosed()) {
            return { handled: false, success: false, reason: 'PAGE_CLOSED' };
        }

        const mode = options.examSubmitMode || this.config.examSubmitMode || 'AUTO_SUBMIT';
        const delayMs = options.examDelayBetweenClicksMs || this.config.examDelayBetweenClicksMs || 250;

        // 1. 穿透探测
        const examInfo = await this.detectAndExtractExam(page);
        if (!examInfo.found || examInfo.questions.length === 0) {
            return { handled: false, success: false, reason: 'NO_EXAM_FOUND' };
        }

        const { frame, questions, title, isCompleted } = examInfo;
        if (isCompleted) {
            return {
                handled: true,
                success: true,
                alreadyDone: true,
                title,
                message: '当前章节测验已经完成/提交，无需重复作答'
            };
        }

        // 2. 调用千问大模型进行整卷秒级推理
        const aiResult = await this.askQwenBatchExam(questions);
        if (!aiResult.success) {
            return {
                handled: true,
                success: false,
                questionsCount: questions.length,
                error: `大模型测验批量推理失败: ${aiResult.error}`
            };
        }

        // 3. 模拟物理点击批量勾选试题
        const fillResult = await this.fillAnswers(frame, questions, aiResult.answers, delayMs);

        // 4. 执行提交或保存策略
        const submitResult = await this.submitOrSave(frame, mode);

        return {
            handled: true,
            success: true,
            questionsCount: questions.length,
            title,
            answers: aiResult.answers,
            details: aiResult.details,
            fillResult,
            submitResult,
            actionTaken: submitResult?.action || mode
        };
    }
}

module.exports = ExamSolver;

