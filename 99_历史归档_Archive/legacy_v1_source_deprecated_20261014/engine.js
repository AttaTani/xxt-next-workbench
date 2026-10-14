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

    async askQwenVL(base64Image) {
        const apiKey = this.config.qwenApiKey || process.env.DASHSCOPE_API_KEY;
        const baseUrl = this.config.qwenBaseUrl || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
        const model = this.config.aiModel || 'qwen3-vl-plus';
        if (!apiKey) return null;

        const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
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
                            text: '这是一道中国大学在线课程视频中的随堂测验题。请仔细识别图片中的题目内容和所有选项（单选、多选或判断题），直接给出正确答案的选项字母或对错（例如 A、B、C 或 D，判断题请给 A 或 B 或 对、错）。请务必只输出选项字母或判断结果，不要输出任何解释、分析过程或多余文字符号。'
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
        const content = data.choices?.[0]?.message?.content?.trim() || '';
        const match = content.match(/([A-D]|对|错|正确|错误)/i);
        return match ? match[0].toUpperCase() : content;
    }

    async handleQuizWithAI(frame) {
        if (this.isSolvingQuiz) return false;
        try {
            const isQuizVisible = await frame.evaluate(() => {
                const q = document.querySelector('.ans-videoquiz, .ans-videoquiz-dialog, [id*="videoquiz"]');
                if (!q) return false;
                const rect = q.getBoundingClientRect();
                return rect.width > 20 && rect.height > 20 && window.getComputedStyle(q).display !== 'none';
            }).catch(() => false);

            if (!isQuizVisible) return false;

            this.isSolvingQuiz = true;
            this.log('【智能答题】检测到随堂测验弹窗，正在截取试题并调用多模态模型...');

            const quizEl = await frame.$('.ans-videoquiz, .ans-videoquiz-dialog');
            if (!quizEl) return false;

            const imgBuf = await quizEl.screenshot();
            const base64 = imgBuf.toString('base64');
            const aiAnswer = await this.askQwenVL(base64);

            if (!aiAnswer) {
                this.log('【智能答题】未获取到模型答案，降级至本地安全排错试错', 'warn');
                return false;
            }

            this.log(`【智能答题】千问多模态模型 (${this.config.aiModel || 'qwen3-vl-plus'}) 识别推荐答案: 「${aiAnswer}」`);

            const clickedText = await frame.evaluate((ans) => {
                const labels = Array.from(document.querySelectorAll('.ans-videoquiz-opt, .ans-videoquiz label, .ans-videoquiz li, .ans-videoquiz p'));
                for (const l of labels) {
                    const text = (l.innerText || '').trim();
                    if (text.startsWith(ans) || text.includes(ans)) {
                        const inp = l.querySelector('input') || l;
                        inp.click();
                        return text;
                    }
                }
                const code = ans.charCodeAt(0);
                if (code >= 65 && code <= 68) {
                    const idx = code - 65;
                    if (labels[idx]) {
                        const inp = labels[idx].querySelector('input') || labels[idx];
                        inp.click();
                        return (labels[idx].innerText || '').trim();
                    }
                }
                if (ans.includes('对') || ans.includes('正确')) {
                    const l = labels.find(el => (el.innerText || '').includes('对') || (el.innerText || '').includes('正确'));
                    if (l) { (l.querySelector('input') || l).click(); return l.innerText.trim(); }
                }
                if (ans.includes('错') || ans.includes('错误')) {
                    const l = labels.find(el => (el.innerText || '').includes('错') || (el.innerText || '').includes('错误'));
                    if (l) { (l.querySelector('input') || l).click(); return l.innerText.trim(); }
                }
                return null;
            }, aiAnswer);

            if (clickedText) {
                this.log(`【智能答题】已成功命中选项: 「${clickedText}」，准备原子提交...`);
                await frame.waitForTimeout(500);
                await frame.evaluate(() => {
                    const submitBtn = document.querySelector('.ans-videoquiz-submit, #ext-gen1046, .btn-ok, .ans-btn')
                        || Array.from(document.querySelectorAll('button, div, span, a')).find(el => el.innerText && el.innerText.trim() === '提交');
                    if (submitBtn) submitBtn.click();
                });
                this.log(`【智能答题】已成功提交测验！`);
                this.sendNotification('随堂测验已通过', `千问多模态已自动完成答题提交: ${clickedText}`);
                await frame.waitForTimeout(1500);
                return true;
            }
        } catch (err) {
            this.log(`【智能答题】处理测验异常: ${err.message}，降级至本地排错模式`, 'warn');
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

                // 2. 检查视频状态并以幂等方式恢复播放 (禁止使用可能导致暂停的 toggle 按钮点击)
                const videoData = await frame.evaluate(async (targetRate) => {
                    const v = document.querySelector('video');
                    if (!v) return null;

                    // 检查答题弹窗 (切片Q2: 智能排错状态机与防踢兜底)
                    try {
                        const quizDialog = document.querySelector('.ans-videoquiz');
                        if (quizDialog) {
                            const wrongTip = document.querySelector('.ans-videoquiz-wrong, [class*="wrong"]')
                                || (document.body.innerText && document.body.innerText.includes('回答错误'));
                            const quizOptions = Array.from(document.querySelectorAll('.ans-videoquiz-opt input, .ans-videoquiz label, [name="ans-videoquiz-opt"]'));
                            
                            if (quizOptions.length > 0) {
                                // 若已提示答错且有多选项，自动切到后续未选项进行排除试错
                                let targetOpt = quizOptions[0];
                                if (wrongTip && quizOptions.length > 1) {
                                    targetOpt = quizOptions[1];
                                }
                                targetOpt.click();

                                const submitBtn = document.querySelector('.ans-videoquiz-submit, #ext-gen1046, .btn-ok, .ans-btn')
                                    || Array.from(document.querySelectorAll('button, div, span, a')).find(el => el.innerText && el.innerText.trim() === '提交');
                                if (submitBtn) {
                                    submitBtn.click();
                                }
                            }
                        }
                    } catch (quizErr) {}

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

                    const nextBtn = document.querySelector('#prevNextFocusNext, .nextChapter, #right1');
                    if (nextBtn) {
                        nextBtn.click();
                        return { success: true, text: '下一任务点' };
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
