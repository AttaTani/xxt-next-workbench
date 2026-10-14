// 针对国内环境：清除系统级代理环境变量，确保超星流量强制直连国内原生宽带
if (!process.env.USE_PROXY) {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const EventEmitter = require('events');

class XuexitongEngine extends EventEmitter {
    constructor() {
        super();
        this.rootDir = path.resolve(__dirname, '..');
        this.userDataDir = path.join(__dirname, 'userData');
        this.authJsonPath = path.join(this.userDataDir, 'auth_state.json');
        this.configPath = path.join(__dirname, 'config.json');
        this.scriptPath = path.join(this.rootDir, 'v3_optimized.js');
        this.screenshotPath = path.join(this.userDataDir, 'screen.png');
        this.qrPath = path.join(this.userDataDir, 'qrcode.png');

        this.loadConfig();

        this.context = null;
        this.page = null;
        this.status = 'IDLE'; // IDLE, NEED_LOGIN, LOGGED_IN, RUNNING, STOPPED, ERROR
        this.qrBase64 = null;
        this.logs = [];
        this.maxLogs = 300;
        this.currentInfo = {
            title: '',
            unit: '',
            progress: '',
            playing: false,
            rate: this.config.playbackRate || 1.5,
            url: ''
        };
        this.monitorTimer = null;
        this.isProcessing = false;
        this.lastProgressLogTs = 0;
        this.isSolvingQuiz = false;
        this.currentQuizSignature = null;
        this.currentQuizAttempts = 0;
        this.attemptedOptionIndices = new Set();
        this.quizCircuitBreakerTripped = false;
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } else {
                this.config = {
                    port: 3888,
                    playbackRate: 1.5,
                    autoAdvanceNoVideo: false,
                    courseUrl: '',
                    headless: true
                };
            }
        } catch (e) {
            this.config = { port: 3888, playbackRate: 1.5, autoAdvanceNoVideo: false, courseUrl: '', headless: true };
        }
    }

    saveConfig(updates = {}) {
        this.config = { ...this.config, ...updates };
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    }

    log(msg, type = 'info') {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const entry = { time, msg, type };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
        this.emit('log', entry);
    }

    sendNotification(title, message) {
        if (process.platform !== 'win32') return;
        try {
            let psScript = path.join(__dirname, 'utils', 'notify.ps1');
            if (!fs.existsSync(psScript)) {
                psScript = path.join(__dirname, 'notify.ps1');
            }
            if (!fs.existsSync(psScript)) return;
            const ps = spawn('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-File', psScript,
                '-Title', String(title),
                '-Message', String(message)
            ], { detached: true, stdio: 'ignore', windowsHide: true });
            ps.unref();
        } catch (e) {}
    }

    cleanAndParseAnswer(rawContent) {
        if (!rawContent || typeof rawContent !== 'string') return null;
        let text = rawContent.trim();

        // 1. 优先匹配结构化答案标记，如【答案：A】、答案: B、选择: C、选项：D
        const tagMatch = text.match(/(?:【)?(?:答案|选择|正确答案|参考答案|我选择|选项)[:：\s]*([A-D])(?:】)?/i);
        if (tagMatch) {
            return tagMatch[1].toUpperCase();
        }

        // 2. 匹配末尾单独成行或带有对/错结论的行 (CoT 推理后在末行总结答案)
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            const endMatch = line.match(/(?:^|[^a-zA-Z])([A-D])(?:[\.、\s]*$)/i);
            if (endMatch) {
                return endMatch[1].toUpperCase();
            }
            if (/^(对|正确|√|T|true)/i.test(line)) return 'A';
            if (/^(错|错误|×|F|false)/i.test(line)) return 'B';
        }

        // 3. 过滤题型描述噪音词汇
        text = text.replace(/^(题型|题目类型|题目)?[:：\s]*(单选|多选|判断|填空)题?[:：\s]*/gi, '');
        text = text.replace(/(单选|多选|判断|填空)题/gi, '');
        text = text.replace(/^(答案|正确答案|参考答案|我选择|应该是|选项)[:：\s]*/gi, '');
        text = text.trim();

        // 4. 提取单字符字母 A-D
        const letterMatch = text.match(/([A-D])/i);
        if (letterMatch) {
            return letterMatch[1].toUpperCase();
        }

        // 5. 对/错 语义转译兜底 (A=对, B=错)
        if (/^(对|正确|√|T|true)/i.test(text)) return 'A';
        if (/^(错|错误|×|F|false)/i.test(text)) return 'B';

        // 6. 若仍无法判定，绝不返回脏文本，返回 null 触发排除法
        return null;
    }

    async askQwenText(quizInfo) {
        const apiKey = this.config.qwenApiKey || process.env.DASHSCOPE_API_KEY;
        const baseUrl = this.config.qwenBaseUrl || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
        const model = this.config.textContentModel || 'qwen-plus';
        if (!apiKey) return null;

        const optionsText = quizInfo.options.map(o => `${o.letter}. ${o.content || o.rawText}`).join('\n');
        
        const userPrompt = 
            `你是一位大学在线课程随堂测验答题专家。请以极度严谨的态度审查下列测验题：\n\n` +
            `【题型】：${quizInfo.qType}\n` +
            `【题目】：${quizInfo.stem}\n` +
            `【选项】：\n${optionsText}\n\n` +
            `【作答规范与要求】：\n` +
            `1. 严禁盲目肯定！仔细核对题干中的时间、年龄、数值、因果关系及否定词（如“不属于”、“错误的是”），若有任何微小错误即为假命题；\n` +
            `2. 若为判断题：A 代表对/正确，B 代表错/错误；\n` +
            `3. 请先输出极其简短的核心审题依据（不超过30字）；\n` +
            `4. 在最后单独起一行，以严格格式输出最终选定的大写字母，如【答案：A】。`;

        const payload = {
            model,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.1
        };

        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Text API HTTP ${res.status}: ${err}`);
        }

        const data = await res.json();
        const rawContent = data.choices?.[0]?.message?.content?.trim() || '';
        const parsed = this.cleanAndParseAnswer(rawContent);
        return {
            letter: parsed,
            reasoning: rawContent.split('\n')[0] || rawContent
        };
    }

    async askQwenVL(base64Image) {
        const apiKey = this.config.qwenApiKey || process.env.DASHSCOPE_API_KEY;
        const baseUrl = this.config.qwenBaseUrl || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
        const model = this.config.visionContentModel || this.config.aiModel || 'qwen3-vl-plus';
        if (!apiKey) return null;

        const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const promptText = 
            '这是一道中国大学在线课程视频中的随堂测验试题。\n' +
            '【严格输出规范】：\n' +
            '1. 你的任务是识别正确答案，请务必直接输出唯一的大写选项字母（如 A、B、C 或 D）。\n' +
            '2. 若为判断题，且选项为“对/错”或“正确/错误”，请严格根据选项映射输出对应字母：A 代表对/正确，B 代表错/错误。\n' +
            '3. 绝对禁止输出“单选题”、“判断题”、“多选题”、“答案是”、“正确答案”等任何题型描述或多余汉字！\n' +
            '4. 绝对禁止包含任何分析推理过程，违者将被判定为格式错误。\n' +
            '你只需输出且只能输出一个大写字母：';

        const payload = {
            model,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/png;base64,${base64Image}` }
                        },
                        {
                            type: 'text',
                            text: promptText
                        }
                    ]
                }
            ],
            temperature: 0.05
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`API HTTP ${res.status}: ${err}`);
        }

        const data = await res.json();
        const rawContent = data.choices?.[0]?.message?.content?.trim() || '';
        return this.cleanAndParseAnswer(rawContent);
    }

    async extractQuizContent(frame) {
        return await frame.evaluate(() => {
            const q = document.querySelector('.ans-videoquiz, .ans-videoquiz-dialog, [id*="videoquiz"]');
            if (!q) return null;
            const rect = q.getBoundingClientRect();
            if (rect.width <= 20 || rect.height <= 20 || window.getComputedStyle(q).display === 'none') return null;

            // 1. 提取题型 (单选题 / 多选题 / 判断题)
            let qType = '单选题';
            const typeEl = q.querySelector('.ans-videoquiz-type, .type, em');
            if (typeEl) {
                const tText = (typeEl.innerText || '').trim();
                if (tText.includes('判断')) qType = '判断题';
                else if (tText.includes('多选')) qType = '多选题';
            } else if ((q.innerText || '').includes('判断题')) {
                qType = '判断题';
            }

            // 2. 提取题目正文 (过滤掉题型标签噪音)
            const stemEl = q.querySelector('.ans-videoquiz-title, h3, .title, .ans-videoquiz-stem') || q;
            let stem = (stemEl.innerText || '').replace(/\[(单选题|多选题|判断题)\]/g, '').trim();

            // 3. 提取所有可用选项 (去重并解析 A/B/C/D 标号与文本)
            let optEls = Array.from(q.querySelectorAll('.ans-videoquiz-opt'));
            if (optEls.length === 0) {
                optEls = Array.from(q.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
                    .map(i => i.closest('li') || i.closest('label') || i.parentElement);
            }
            if (optEls.length === 0) {
                optEls = Array.from(q.querySelectorAll('label'));
            }
            if (optEls.length === 0) {
                optEls = Array.from(q.querySelectorAll('li'));
            }
            optEls = Array.from(new Set(optEls.filter(Boolean)));

            const options = optEls.map((el, idx) => {
                const raw = (el.innerText || '').trim();
                return {
                    index: idx,
                    rawText: raw,
                    letter: String.fromCharCode(65 + idx),
                    content: raw.replace(/^[A-D][\.\、\:\s]+/i, '').trim(),
                    text: raw
                };
            });

            // 4. 探针：检查题干或选项中是否存在真正的试题插图
            const contentImgs = Array.from(q.querySelectorAll('img')).filter(img => {
                const src = (img.src || '').toLowerCase();
                const isUi = src.includes('icon') || src.includes('btn') || src.includes('loading') || src.includes('logo');
                return !isUi && (img.clientWidth > 30 || img.naturalWidth > 30);
            });

            const hasWrongTip = !!q.querySelector('.ans-videoquiz-wrong, [class*="wrong"]') 
                || ((q.innerText || '').includes('回答错误') || (q.innerText || '').includes('答案错误'));

            return {
                qType,
                stem,
                options,
                optionCount: options.length,
                hasContentImage: contentImgs.length > 0,
                hasWrongTip,
                signature: (stem || '').replace(/\s+/g, '').slice(0, 60) || 'unknown_quiz'
            };
        }).catch(() => null);
    }

    async handleQuizWithAI(frame) {
        if (this.isSolvingQuiz) return false;
        try {
            // 1. 【切片T1】调用 DOM 高保真提取器获取试题与探针数据
            const quizInfo = await this.extractQuizContent(frame);

            if (!quizInfo || quizInfo.optionCount === 0) {
                return false;
            }

            // 检查是否是新的测验题
            if (this.currentQuizSignature !== quizInfo.signature) {
                this.currentQuizSignature = quizInfo.signature;
                this.currentQuizAttempts = 0;
                this.attemptedOptionIndices.clear();
                this.quizCircuitBreakerTripped = false;
                this.log(`【智能答题】捕获随堂测验，指纹: [${quizInfo.signature.slice(0, 24)}...]，候选选项数: ${quizInfo.optionCount}`);
            }

            // 熔断保护检查 (ACT-4: 最多尝试 min(3, optionCount) 次)
            const maxAllowedAttempts = Math.min(3, quizInfo.optionCount);
            if (this.currentQuizAttempts >= maxAllowedAttempts || this.attemptedOptionIndices.size >= quizInfo.optionCount) {
                if (!this.quizCircuitBreakerTripped) {
                    this.quizCircuitBreakerTripped = true;
                    this.log(`⚠️【答题安全熔断触发】已连续尝试 ${this.currentQuizAttempts} 次均未通过，为防封号已主动暂停挂机！请手动答题后恢复。`, 'error');
                    this.sendNotification('随堂测验答题熔断', `连续答题${this.currentQuizAttempts}次失败，已主动暂停挂机以防风控`);
                    await this.stop();
                }
                return false;
            }

            this.isSolvingQuiz = true;

            // 2. 【切片T3】双模智能路由与 CoT 推理决策
            let targetIndex = -1;
            let targetMethod = '';

            let aiLetter = null;
            let aiReasoning = '';

            // 仅在首次尝试且有未试过选项时调用大模型
            if (this.attemptedOptionIndices.size === 0) {
                const enableHybrid = this.config.enableHybridRouting !== false;

                // 若题干/选项含有效插图且允许双模降级，走视觉模型分支
                if (enableHybrid && quizInfo.hasContentImage) {
                    this.log('【智能答题】检测到试题包含插图/图表，启动多模态视觉模型 (qwen3-vl-plus)...');
                    const quizEl = await frame.$('.ans-videoquiz, .ans-videoquiz-dialog');
                    if (quizEl) {
                        const imgBuf = await quizEl.screenshot();
                        const base64 = imgBuf.toString('base64');
                        aiLetter = await this.askQwenVL(base64);
                    }
                } else {
                    // 常规纯文本题目（98%+），直连纯文本旗舰大模型并获取思维链理由
                    const modelName = this.config.textContentModel || 'qwen-plus';
                    this.log(`【智能答题】启用纯文本旗舰模型 [${modelName}] 进行深度审题推理...`);
                    const result = await this.askQwenText(quizInfo);
                    if (result) {
                        aiLetter = result.letter;
                        aiReasoning = result.reasoning;
                    }
                }
            }

            if (aiLetter) {
                if (aiReasoning) {
                    this.log(`【大模型审题理由】「${aiReasoning}」`);
                }
                this.log(`【智能答题】大模型推荐答案: 「${aiLetter}」`);
                const code = aiLetter.charCodeAt(0);
                if (code >= 65 && code <= 68) {
                    const mappedIdx = code - 65;
                    if (mappedIdx < quizInfo.optionCount && !this.attemptedOptionIndices.has(mappedIdx)) {
                        targetIndex = mappedIdx;
                        targetMethod = `大模型推理(${aiLetter})`;
                    }
                }
                if (targetIndex === -1) {
                    for (let i = 0; i < quizInfo.options.length; i++) {
                        const optText = quizInfo.options[i].rawText || quizInfo.options[i].text;
                        if (optText.startsWith(aiLetter) && !this.attemptedOptionIndices.has(i)) {
                            targetIndex = i;
                            targetMethod = `文本标签匹配(${aiLetter})`;
                            break;
                        }
                    }
                }
            }

            // 排除法状态机：若 AI 答案已试过或无效，选择下一个未尝试选项
            if (targetIndex === -1) {
                for (let i = 0; i < quizInfo.optionCount; i++) {
                    if (!this.attemptedOptionIndices.has(i)) {
                        targetIndex = i;
                        targetMethod = `排除法试错(#${i + 1})`;
                        break;
                    }
                }
            }

            if (targetIndex === -1) {
                this.log('【智能答题】所有可用选项均已尝试，无法继续。', 'warn');
                return false;
            }

            // 3. 记录尝试并点击提交
            this.attemptedOptionIndices.add(targetIndex);
            this.currentQuizAttempts++;

            const targetOptText = quizInfo.options[targetIndex]?.text || `选项${targetIndex + 1}`;
            this.log(`【智能答题】正在提交第 ${this.currentQuizAttempts}/${maxAllowedAttempts} 次尝试 [${targetMethod}]: ${targetOptText}`);

            const clicked = await frame.evaluate((idx) => {
                const q = document.querySelector('.ans-videoquiz, .ans-videoquiz-dialog, [id*="videoquiz"]');
                if (!q) return false;
                let optEls = Array.from(q.querySelectorAll('.ans-videoquiz-opt'));
                if (optEls.length === 0) {
                    optEls = Array.from(q.querySelectorAll('input[type="radio"], input[type="checkbox"]')).map(i => i.closest('li') || i.closest('label') || i.parentElement);
                }
                if (optEls.length === 0) {
                    optEls = Array.from(q.querySelectorAll('label'));
                }
                if (optEls.length === 0) {
                    optEls = Array.from(q.querySelectorAll('li'));
                }
                optEls = Array.from(new Set(optEls.filter(Boolean)));

                const target = optEls[idx];
                if (target) {
                    const inp = target.querySelector('input') || target;
                    inp.click();
                    return true;
                }
                return false;
            }, targetIndex);

            if (clicked) {
                await frame.waitForTimeout(600);
                await frame.evaluate(() => {
                    const submitBtn = document.querySelector('.ans-videoquiz-submit, #ext-gen1046, .btn-ok, .ans-btn')
                        || Array.from(document.querySelectorAll('button, div, span, a')).find(el => el.innerText && el.innerText.trim() === '提交');
                    if (submitBtn) submitBtn.click();
                });

                this.log(`【智能答题】提交指令已发出，正在校验结果...`);
                await frame.waitForTimeout(2000);

                // 4. 提交后检验：弹窗是否已关闭
                const stillOpen = await frame.evaluate(() => {
                    const q = document.querySelector('.ans-videoquiz, .ans-videoquiz-dialog, [id*="videoquiz"]');
                    if (!q) return false;
                    const rect = q.getBoundingClientRect();
                    return rect.width > 20 && rect.height > 20 && window.getComputedStyle(q).display !== 'none';
                }).catch(() => false);

                if (!stillOpen) {
                    this.log(`🎉【智能答题成功】测验已顺利通过，弹窗消除！`);
                    this.sendNotification('随堂测验已通过', `随堂测验已自动解决: ${targetOptText}`);
                    this.currentQuizSignature = null;
                    this.currentQuizAttempts = 0;
                    this.attemptedOptionIndices.clear();
                    this.quizCircuitBreakerTripped = false;
                    return true;
                } else {
                    this.log(`⚠️【智能答题反馈】该选项未通过，状态机已记录已排除项 (#${targetIndex + 1})。`, 'warn');
                    return true;
                }
            }
            return true;
        } catch (err) {
            this.log(`【智能答题】执行异常: ${err.message}`, 'warn');
        } finally {
            this.isSolvingQuiz = false;
        }
        return false;
    }

    setupPageListeners(page) {
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('Download the Vue Devtools') || text.includes('[HMR]') || text.includes('failed to load resource') || text.includes('ERR_NAME_NOT_RESOLVED')) return;
            this.log(`[页面] ${text}`, 'browser');
        });

        page.on('pageerror', err => {
            if (err.message.includes('logout is not defined') || err.message.includes('hasWorkMsg') || err.message.includes('Cannot read properties of undefined')) return;
            this.log(`页面脚本错误: ${err.message}`, 'warn');
        });
    }

    async saveSessionCookies() {
        if (!this.context) return;
        try {
            const cookies = await this.context.cookies();
            if (cookies && cookies.length > 0) {
                fs.writeFileSync(this.authJsonPath, JSON.stringify({ cookies }, null, 2), 'utf8');
            }
        } catch (e) {}
    }

    async restoreSessionCookies() {
        if (!this.context || !fs.existsSync(this.authJsonPath)) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.authJsonPath, 'utf8'));
            if (data.cookies && data.cookies.length > 0) {
                await this.context.addCookies(data.cookies);
                this.log(`已成功恢复历史登录凭证 (${data.cookies.length} 个 Cookies)`);
            }
        } catch (e) {}
    }

    async initBrowser() {
        if (this.context) return;
        this.log('正在初始化无头浏览器环境 (Playwright Chromium)...');
        if (!fs.existsSync(this.userDataDir)) {
            fs.mkdirSync(this.userDataDir, { recursive: true });
        }

        this.context = await chromium.launchPersistentContext(this.userDataDir, {
            headless: this.config.headless !== false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-blink-features=AutomationControlled'
            ],
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });

        await this.restoreSessionCookies();

        this.context.on('page', async (newPage) => {
            this.log(`检测到新标签页打开: ${newPage.url()}`);
            this.page = newPage;
            this.setupPageListeners(newPage);
        });

        const pages = this.context.pages();
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
        this.setupPageListeners(this.page);
    }

    async checkLogin() {
        await this.initBrowser();
        this.log('检查当前登录状态...');
        try {
            await this.page.goto('https://i.chaoxing.com/base', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            const url = this.page.url();
            if (url.includes('passport2.chaoxing.com/login') || url.includes('/login')) {
                this.status = 'NEED_LOGIN';
                this.log('尚未登录，请在 Web 面板扫码登录。', 'warn');
                this.requestQrLogin().catch(() => {});
                return false;
            } else {
                this.status = 'LOGGED_IN';
                await this.saveSessionCookies();
                this.log('检测到已有效登录！');
                return true;
            }
        } catch (e) {
            this.log(`检查登录失败: ${e.message}`, 'error');
            return false;
        }
    }

    async requestQrLogin() {
        await this.initBrowser();
        this.status = 'NEED_LOGIN';
        this.log('正在获取学习通登录二维码...');
        try {
            await this.page.goto('https://passport2.chaoxing.com/login?refer=https%3A%2F%2Fi.chaoxing.com%2Fbase', { waitUntil: 'networkidle', timeout: 30000 });
            const qrSelector = '#quickCode';
            await this.page.waitForSelector(qrSelector, { timeout: 15000 });
            await this.page.waitForTimeout(1000);

            const qrEl = await this.page.$(qrSelector);
            if (qrEl) {
                const qrBuffer = await qrEl.screenshot();
                fs.writeFileSync(this.qrPath, qrBuffer);
                this.qrBase64 = `data:image/png;base64,${qrBuffer.toString('base64')}`;
                this.log('二维码已刷新，请在 Web 面板用学习通 App 扫码登录！');
                this.emit('qr', this.qrBase64);
            }

            this.waitForLoginSuccess();
            return this.qrBase64;
        } catch (e) {
            this.status = 'ERROR';
            this.log(`获取二维码失败: ${e.message}`, 'error');
            throw e;
        }
    }

    async waitForLoginSuccess() {
        const startTime = Date.now();
        const timeout = 180000;
        const check = async () => {
            if (this.status !== 'NEED_LOGIN') return;
            if (Date.now() - startTime > timeout) {
                this.log('扫码登录等待超时，请点击刷新二维码。', 'warn');
                this.status = 'IDLE';
                return;
            }
            try {
                const url = this.page.url();
                if (!url.includes('passport2.chaoxing.com/login')) {
                    this.status = 'LOGGED_IN';
                    this.qrBase64 = null;
                    await this.saveSessionCookies();
                    this.log('恭喜！扫码登录成功！认证信息已永久持久化。');
                    this.emit('login_success');
                    if (this.config.courseUrl) {
                        this.start(this.config.courseUrl);
                    }
                    return;
                }
            } catch (err) {}
            setTimeout(check, 2000);
        };
        setTimeout(check, 2000);
    }

    async autoNavigateFromCatalog(catalogUrl) {
        this.log('【智能识别】检测到当前为课程大纲页 (studentcourse)，正在自动寻找未完成任务点...');
        await this.page.goto(catalogUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await this.page.waitForTimeout(3000);

        const searchTargets = [this.page, ...this.page.frames()];
        let clickResult = null;

        for (const frame of searchTargets) {
            try {
                const result = await frame.evaluate(() => {
                    const badges = Array.from(document.querySelectorAll('.orange, span.orange, em.orange, .roundpoint, .catalog_point_round, .point_status, i.roundpoint, .jobCheckRound:not(.green)'));
                    for (const badge of badges) {
                        const row = badge.closest('li') || badge.closest('.posCatalog_item') || badge.closest('tr') || badge.closest('.clearfix') || badge.parentElement;
                        if (row) {
                            const link = row.querySelector('a') || row.querySelector('.posCatalog_name') || row;
                            if (link) {
                                link.scrollIntoView();
                                const text = (row.querySelector('.posCatalog_name') || link).innerText.trim();
                                link.click();
                                return { success: true, text: text || '未完成小节' };
                            }
                        }
                    }

                    const links = Array.from(document.querySelectorAll('a[href*="studentstudy"], a[onclick*="toOldOrNew"], a[onclick*="chapter"], .posCatalog_name'));
                    for (const link of links) {
                        if (link.offsetParent !== null) {
                            link.scrollIntoView();
                            const text = link.innerText.trim();
                            link.click();
                            return { success: true, text: text || '首个章节' };
                        }
                    }

                    return { success: false };
                });

                if (result && result.success) {
                    clickResult = result;
                    break;
                }
            } catch (err) {}
        }

        if (clickResult && clickResult.success) {
            this.log(`【智能识别】已成功定位并点击: 「${clickResult.text}」，正在进入播放页...`);
            await this.page.waitForTimeout(5000);

            const allPages = this.context.pages();
            if (allPages.length > 1) {
                this.page = allPages[allPages.length - 1];
                this.setupPageListeners(this.page);
            }
            return true;
        }
        return false;
    }

    async start(targetCourseUrl) {
        if (targetCourseUrl) {
            this.saveConfig({ courseUrl: targetCourseUrl });
        }
        const courseUrl = targetCourseUrl || this.config.courseUrl;
        if (!courseUrl) {
            this.log('未配置课程 URL，请先设置需要学习的课程地址！', 'warn');
            return false;
        }

        const isLogged = await this.checkLogin();
        if (!isLogged) {
            return false;
        }

        this.status = 'RUNNING';
        this.log(`正在进入课程: ${courseUrl}`);
        try {
            if (courseUrl.includes('studentcourse') || (!courseUrl.includes('studentstudy') && courseUrl.includes('chaoxing.com'))) {
                await this.autoNavigateFromCatalog(courseUrl);
            } else {
                await this.page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await this.page.waitForTimeout(3000);
            }

            await this.saveSessionCookies();
            this.startMonitor();
            return true;
        } catch (e) {
            this.status = 'ERROR';
            this.log(`进入课程页面失败: ${e.message}`, 'error');
            return false;
        }
    }

    startMonitor() {
        if (this.monitorTimer) clearInterval(this.monitorTimer);
        this.monitorTimer = setInterval(async () => {
            if (this.status !== 'RUNNING' || !this.page) return;
            try {
                await this.page.screenshot({ path: this.screenshotPath });
                await this.driveVideoPlayback();
                await this.updateCurrentUnitInfo();
            } catch (err) {}
        }, 3000);
    }

    async driveVideoPlayback() {
        const rate = this.config.playbackRate || 1.5;
        let foundVideo = false;

        // 0. 优先检测是否被超星 9010 反爬拦截并执行安全熔断
        const allFrames = this.page.frames();
        const captchaFrame = allFrames.find(f => f.url().includes('antispider') || f.url().includes('Verify.ac'));
        if (captchaFrame) {
            this.currentInfo.playing = false;
            this.status = 'RISK_SUSPEND';
            await this.stop();
            this.log('【风控熔断触发】检测到超星【9010】操作异常验证码，已主动停止挂机轮询，阻断风控升级惩罚！', 'error');
            return;
        }

        for (const frame of allFrames) {
            try {
                // 1. 全局防暂停/防失焦 hook 注入 + 切片Q2: 防退出/防倒退底层免疫护盾
                await frame.evaluate(() => {
                    try {
                        if (!window.__antiPauseBound) {
                            window.__antiPauseBound = true;
                            Object.defineProperty(document, 'hidden', { value: false, writable: false });
                            Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
                            const block = (e) => { e.stopImmediatePropagation(); };
                            window.addEventListener('blur', block, true);
                            window.addEventListener('mouseleave', block, true);
                            window.addEventListener('mouseout', block, true);
                            document.addEventListener('visibilitychange', block, true);

                            // 【切片Q2护盾】屏蔽阻塞弹窗与异常页面卸载
                            window.alert = function() { return true; };
                            window.confirm = function() { return true; };
                            window.onbeforeunload = null;
                        }

                        // 【切片Q2护盾】防止答错导致播放进度倒退清零
                        const v = document.querySelector('video');
                        if (v && !v.__shieldBound) {
                            v.__shieldBound = true;
                            v.__safeTime = v.currentTime || 0;
                            v.addEventListener('timeupdate', () => {
                                const hasQuiz = !!document.querySelector('.ans-videoquiz');
                                if (!hasQuiz && v.currentTime > 5) {
                                    v.__safeTime = v.currentTime;
                                }
                            });
                            v.addEventListener('seeking', () => {
                                const hasQuiz = !!document.querySelector('.ans-videoquiz');
                                if (hasQuiz && v.currentTime < 1 && v.__safeTime > 5) {
                                    console.warn('[免疫护盾] 拦截随堂测验答错倒退归零惩罚，恢复安全锚点:', v.__safeTime);
                                    v.currentTime = v.__safeTime;
                                }
                            });
                        }
                    } catch (e) {}
                });

                // 2. 【切片Q3 & Q4】尝试通过千问多模态模型视觉答题
                const quizHandled = await this.handleQuizWithAI(frame);
                if (quizHandled) {
                    break;
                }

                // 3. 检查视频状态并以幂等方式恢复播放 (禁止使用可能导致暂停的 toggle 按钮点击)
                const videoData = await frame.evaluate(async (targetRate) => {
                    const v = document.querySelector('video');
                    if (!v) return null;

                    // 若当前存在随堂测验弹窗，暂停视频驱动，全权交由答题状态机处理
                    if (document.querySelector('.ans-videoquiz, .ans-videoquiz-dialog')) {
                        return null;
                    }

                    // 获取 videojs 实例
                    let vjs = null;
                    if (window.videojs && window.videojs.players) {
                        const ids = Object.keys(window.videojs.players);
                        if (ids.length > 0) vjs = window.videojs.players[ids[0]];
                    }

                    // 如果暂停中且未结束：调用原生幂等 play()
                    if (v.paused && !v.ended) {
                        v.muted = true;
                        v.playbackRate = targetRate;

                        // 若处于视频开头 0 秒，才点击初始大播放按钮
                        if (v.currentTime < 0.5) {
                            const bigBtn = document.querySelector('.vjs-big-play-button');
                            if (bigBtn) bigBtn.click();
                        }

                        // 优先通过 Video.js 恢复
                        if (vjs && typeof vjs.play === 'function') {
                            vjs.muted(true);
                            vjs.playbackRate(targetRate);
                            vjs.play();
                        } else {
                            v.play().catch(() => {});
                        }
                    } else if (!v.paused) {
                        // 确保倍速生效
                        if (v.playbackRate !== targetRate) {
                            v.playbackRate = targetRate;
                            if (vjs) vjs.playbackRate(targetRate);
                        }
                    }

                    return {
                        paused: v.paused,
                        currentTime: Number(v.currentTime || 0),
                        duration: Number(v.duration || 0),
                        ended: v.ended,
                        playbackRate: v.playbackRate
                    };
                }, rate);

                if (videoData) {
                    foundVideo = true;
                    this.currentInfo.playing = !videoData.paused && !videoData.ended;

                    if (videoData.duration > 0) {
                        const pct = Math.floor((videoData.currentTime / videoData.duration) * 100);
                        this.currentInfo.progress = `${pct}% (${Math.floor(videoData.currentTime)}s/${Math.floor(videoData.duration)}s)`;
                    }

                    // 定期日志输出
                    const now = Date.now();
                    if (!videoData.paused && now - this.lastProgressLogTs >= 12000) {
                        this.lastProgressLogTs = now;
                        this.log(`[挂机中] 正在播放视频: ${this.currentInfo.progress} | 倍速: ${rate}x`);
                    }

                    // 检查是否播放完毕 (达到 96% 即判定完成并切节)
                    if (videoData.ended || (videoData.duration > 0 && videoData.currentTime >= videoData.duration * 0.96)) {
                        this.log(`[视频完成] 当前视频已完成 96%+，准备自动切换下一小节...`);
                        this.sendNotification('学习通挂机提醒', `当前视频已播放达 96%+，准备进入下一小节`);
                        await this.nextUnit();
                        break;
                    }
                }
            } catch (err) {}
        }

        if (!foundVideo) {
            this.currentInfo.playing = false;
        }
    }

    async updateCurrentUnitInfo() {
        try {
            const info = await this.page.evaluate(() => {
                const cur = document.querySelector('.posCatalog_select, .cur, .active, li.current, .posCatalog_active');
                const titleEl = document.querySelector('h1, h2, .cur_title, .catalog_name');
                return {
                    unit: cur ? cur.innerText.replace(/\s+/g, ' ').trim() : '',
                    title: titleEl ? titleEl.innerText.trim() : '',
                    url: window.location.href
                };
            });
            this.currentInfo.unit = info.unit || this.currentInfo.unit;
            this.currentInfo.title = info.title || this.currentInfo.title;
            this.currentInfo.url = info.url || this.page.url();
        } catch (e) {}
    }

    async stop() {
        if (this.monitorTimer) {
            clearInterval(this.monitorTimer);
            this.monitorTimer = null;
        }
        this.status = 'STOPPED';
        this.currentInfo.playing = false;
        this.log('已暂停挂机服务。');
    }

    async nextUnit() {
        if (!this.page) return;
        this.log('【切换小节】正在查找并跳转至下一小节...');
        try {
            let switched = false;
            for (const frame of [this.page, ...this.page.frames()]) {
                const res = await frame.evaluate(() => {
                    const cur = document.querySelector('.posCatalog_select, .cur, .active, li.current, .posCatalog_active');
                    if (cur) {
                        const parentLi = cur.closest('li') || cur.closest('.posCatalog_item');
                        let nextLi = parentLi ? parentLi.nextElementSibling : null;
                        while (nextLi) {
                            const link = nextLi.querySelector('a, .posCatalog_name') || nextLi;
                            if (link) {
                                link.scrollIntoView();
                                link.click();
                                return { success: true, text: link.innerText.trim() };
                            }
                            nextLi = nextLi.nextElementSibling;
                        }
                    }

                    const orangeBadges = Array.from(document.querySelectorAll('.orange, span.orange, em.orange, .roundpoint, .catalog_point_round'));
                    for (const badge of orangeBadges) {
                        const row = badge.closest('li') || badge.closest('.posCatalog_item');
                        if (row && !row.classList.contains('posCatalog_select') && !row.classList.contains('cur')) {
                            const link = row.querySelector('a, .posCatalog_name') || row;
                            if (link) {
                                link.scrollIntoView();
                                link.click();
                                return { success: true, text: link.innerText.trim() };
                            }
                        }
                    }

                    return { success: false };
                });

                if (res && res.success) {
                    this.log(`【切换小节】已成功跳转到: 「${res.text}」`);
                    this.sendNotification('学习通自动跳转', `已成功进入新任务点: 「${res.text}」`);
                    switched = true;
                    break;
                }
            }

            if (!switched && this.config.courseUrl) {
                this.log('【智能寻路】当前页未找到下一小节，正在返回课程大纲页自动定位未完成节点...');
                await this.autoNavigateFromCatalog(this.config.courseUrl);
            }

            await this.page.waitForTimeout(4000);
        } catch (e) {
            this.log(`切换下一小节出错: ${e.message}`, 'warn');
        }
    }

    async setPlaybackRate(rate) {
        this.saveConfig({ playbackRate: rate });
        this.currentInfo.rate = rate;
        this.log(`播放倍速已设置为: ${rate}x`);
    }

    getState() {
        const safeConfig = { ...this.config };
        if (safeConfig.qwenApiKey) {
            safeConfig.qwenApiKey = safeConfig.qwenApiKey.slice(0, 6) + '******' + safeConfig.qwenApiKey.slice(-4);
        }
        return {
            status: this.status,
            config: safeConfig,
            currentInfo: this.currentInfo,
            qrBase64: this.qrBase64,
            logs: this.logs.slice(-50),
            hasScreenshot: fs.existsSync(this.screenshotPath),
            lastScreenshotTime: fs.existsSync(this.screenshotPath) ? fs.statSync(this.screenshotPath).mtimeMs : 0
        };
    }
}

module.exports = new XuexitongEngine();
