const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const ExamSolver = require('./examSolver');

class TaskWorker extends EventEmitter {
    constructor(task, context, config, userDataDir) {
        super();
        this.task = task;
        this.context = context;
        this.config = config;
        this.userDataDir = userDataDir;
        this.screenshotPath = path.join(this.userDataDir, `screen_${this.task.id}.png`);

        this.page = null;
        this.monitorTimer = null;
        this.isProcessing = false;
        this.isSolvingQuiz = false;
        this.currentQuizSignature = null;
        this.currentQuizAttempts = 0;
        this.attemptedOptionIndices = new Set();
        this.quizCircuitBreakerTripped = false;
        this.lastProgressLogTs = 0;
        this.status = 'INITIALIZING';

        // 切片增强: 小节内多 Tab 管理
        this.currentUnitProcessedTabs = new Set();
        this.lastUnitKey = null;

        // 切片增强: 寻路防死循环熔断器
        this.unitVisitCounts = new Map();
        this.unitBlacklist = new Set();
        this.consecutiveUnitVisits = { name: null, count: 0, lastTime: 0 };

        // 切片增强: 章节测验与作业全量自动作答引擎
        this.examSolver = new ExamSolver(this.config);
        this.isSolvingExam = false;
        this.solvedExamSignatures = new Set();
    }

    log(msg, type = 'info') {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const entry = {
            taskId: this.task.id,
            taskName: this.task.name || '未命名课程',
            time,
            msg,
            type
        };
        this.emit('log', entry);
    }

    async start() {
        try {
            this.status = 'RUNNING';
            this.task.status = 'RUNNING';
            this.task.updatedAt = Date.now();
            this.unitBlacklist.clear();
            this.unitVisitCounts.clear();
            this.consecutiveUnitVisits = { name: null, count: 0, lastTime: 0 };
            this.solvedExamSignatures.clear();
            this.log(`正在启动任务: 「${this.task.name || this.task.url}」...`);

            this.page = await this.context.newPage();
            this.setupPageListeners(this.page);

            // 严格单 Tab 策略: 消除历史多余页面，并监听新标签页弹出，防止多窗口互踢
            const existingPages = this.context.pages();
            for (const p of existingPages) {
                if (p !== this.page) await p.close().catch(() => {});
            }

            this.onNewPage = async (newPage) => {
                try {
                    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
                    const newUrl = newPage.url() || '';
                    // 若弹出的窗口是非课程页面（如 space/index 个人空间、通知页），直接销毁阻断干扰
                    if (newUrl.includes('/space/index') || newUrl.includes('passport') || (!newUrl.includes('chaoxing.com'))) {
                        this.log(`【拦截非课程弹窗】自动关闭无用弹窗: ${newUrl}`);
                        await newPage.close().catch(() => {});
                        return;
                    }

                    // 仅当新窗口确实是课程播放页时，才平滑聚焦
                    if (newUrl.includes('studentstudy') || newUrl.includes('studentcourse') || newUrl.includes('mycourse')) {
                        this.log(`【标签页收敛】检测到课程播放页新窗口，正在平滑聚焦: ${newUrl}`);
                        const oldPage = this.page;
                        this.page = newPage;
                        this.setupPageListeners(newPage);
                        if (oldPage && oldPage !== newPage && !oldPage.isClosed()) {
                            await oldPage.close().catch(() => {});
                        }
                    } else {
                        // 其他未知窗口自动关闭
                        await newPage.close().catch(() => {});
                    }
                } catch (e) {}
            };
            this.context.on('page', this.onNewPage);

            const targetUrl = this.task.url;
            if (targetUrl.includes('studentcourse')) {
                await this.autoNavigateFromCatalog(targetUrl);
            } else {
                this.log(`正在打开课程播放页: ${targetUrl}`);
                await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await this.page.waitForTimeout(3000);
            }

            this.startMonitoring();
        } catch (err) {
            this.status = 'ERROR';
            this.task.status = 'ERROR';
            this.task.errorMessage = err.message;
            this.log(`任务启动异常: ${err.message}`, 'error');
            this.emit('error', err);
        }
    }

    setupPageListeners(page) {
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('Download the Vue Devtools') || text.includes('[HMR]') || text.includes('failed to load resource') || text.includes('ERR_NAME_NOT_RESOLVED')) return;
            this.log(`[页面] ${text}`, 'browser');
        });

        page.on('pageerror', err => {
            if (err.message.includes('logout is not defined') || err.message.includes('hasWorkMsg') || err.message.includes('Cannot read properties of undefined')) return;
            this.log(`页面异常: ${err.message}`, 'warn');
        });
    }

    startMonitoring() {
        if (this.monitorTimer) clearInterval(this.monitorTimer);
        this.monitorTimer = setInterval(async () => {
            if (this.isProcessing || this.status !== 'RUNNING') return;
            this.isProcessing = true;
            try {
                await this.checkPlaybackStatus();
            } catch (e) {
                this.log(`监控轮询异常: ${e.message}`, 'warn');
            } finally {
                this.isProcessing = false;
            }
        }, 3000);
    }

    async checkPlaybackStatus() {
        if (!this.page || this.page.isClosed()) return;

        // 【学习域沙箱守卫】防止意外跳入个人空间、云盘或站内信
        try {
            const curUrl = this.page.url();
            if (curUrl && !curUrl.includes('chaoxing.com/mooc-ans/mycourse/student')) {
                if (curUrl.includes('pan') || curUrl.includes('space') || curUrl.includes('cloud') || curUrl.includes('msg') || curUrl.includes('message')) {
                    this.log(`⚠️【沙箱越界防护】检测到页面脱离学习域 (当前: ${curUrl})，正在强制纠偏回课程主页...`, 'warn');
                    await this.page.goto(this.task.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
                    return;
                }
            }
        } catch (e) {}

        // 定期截屏
        try {
            const screen = await this.page.screenshot({ type: 'png' });
            fs.writeFileSync(this.screenshotPath, screen);
        } catch (e) {}

        const allFrames = [this.page, ...this.page.frames()];
        const rate = this.task.playbackRate || this.config.playbackRate || 1;
        let foundVideo = false;

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
                    // 若此 frame 包含随堂测验，立即结束后续无测验子 iframe 的遍历，防止状态被冲刷
                    break;
                }

                // 3. 检查视频状态并以幂等方式恢复播放
                const videoData = await frame.evaluate(async (targetRate) => {
                    const v = document.querySelector('video');
                    if (!v) return null;

                    // 若当前存在随堂测验弹窗，暂停视频驱动，全权交由答题状态机处理
                    if (document.querySelector('.ans-videoquiz, .ans-videoquiz-dialog')) {
                        return null;
                    }

                    let vjs = null;
                    if (window.videojs && window.videojs.players) {
                        const ids = Object.keys(window.videojs.players);
                        if (ids.length > 0) vjs = window.videojs.players[ids[0]];
                    }

                    if (v.paused && !v.ended) {
                        v.muted = true;
                        v.playbackRate = targetRate;

                        if (v.currentTime < 0.5) {
                            const bigBtn = document.querySelector('.vjs-big-play-button');
                            if (bigBtn) bigBtn.click();
                        }

                        if (vjs && typeof vjs.play === 'function') {
                            vjs.muted(true);
                            vjs.playbackRate(targetRate);
                            vjs.play();
                        } else {
                            v.play().catch(() => {});
                        }
                    } else if (!v.paused) {
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
                        this.noVideoTickCount = 0;
                        if (videoData.duration > 0) {
                            const pct = Math.floor((videoData.currentTime / videoData.duration) * 100);
                            this.task.progress = {
                                unitTitle: this.task.progress.unitTitle || '',
                                percentage: pct,
                                currentTime: Math.floor(videoData.currentTime),
                                duration: Math.floor(videoData.duration)
                            };
                            this.task.updatedAt = Date.now();
                        }

                        const now = Date.now();
                        if (!videoData.paused && now - this.lastProgressLogTs >= 12000) {
                            this.lastProgressLogTs = now;
                            this.log(`[挂机中] 正在播放视频: ${this.task.progress.percentage}% (${this.task.progress.currentTime}s/${this.task.progress.duration}s) | 倍速: ${rate}x`);
                        }

                        // 视频播放完成：必须达到 ended 或剩余时间少于 3 秒 (保证超星心跳上报完成并标绿)
                        if (videoData.ended || (videoData.duration > 0 && videoData.currentTime >= videoData.duration - 3)) {
                            this.log(`[视频完成] 当前任务点视频已完整播放完毕 (${videoData.currentTime}s/${videoData.duration}s)，准备流转后续任务点...`);
                            await this.advanceTabOrUnit();
                            break;
                        }
                    }
                } catch (err) {}
            }

            // 若整页未检测到视频（如章节测验、文档、作业等非视频任务点）
            if (!foundVideo) {
                // 1. 优先尝试章节测验与作业全量自动作答闭环
                if (this.config.enableChapterExamSolving !== false && !this.isSolvingExam) {
                    const examHandled = await this.handleChapterExam();
                    if (examHandled) {
                        this.noVideoTickCount = 0;
                        await this.updateCurrentUnitInfo();
                        return;
                    }
                }

                // 2. 常规文档/非测验任务点，停留 30s 后流转
                this.noVideoTickCount = (this.noVideoTickCount || 0) + 1;
                if (this.noVideoTickCount >= 10) {
                    this.noVideoTickCount = 0;
                    this.log(`【任务点流转】当前任务点为非视频任务点（已阅览停留 30s），准备流转至后续任务点...`);
                    await this.advanceTabOrUnit();
                }
            }

            await this.updateCurrentUnitInfo();
    }

    async updateCurrentUnitInfo() {
        try {
            const systemKeywords = ['云盘', '课程', '专题创作', '收件箱', '小组', '通讯录', '网站消息', '账号管理', '个人主页', '设置', '帮助', '退出', '返回'];
            if (this.task.progress.unitTitle && systemKeywords.some(k => this.task.progress.unitTitle.includes(k))) {
                this.task.progress.unitTitle = this.lastUnitKey || '';
            }

            const info = await this.page.evaluate(() => {
                const systemKeywords = ['云盘', '课程', '专题创作', '收件箱', '小组', '通讯录', '网站消息', '账号管理', '个人主页', '设置', '帮助', '退出', '返回'];
                const catalog = document.querySelector('#posCatalog, .posCatalog, .catalog_list, .level_1, .chapter_list, #courseTree, .cells, .course_section, .right_nav');
                let cur = null;
                if (catalog) {
                    cur = catalog.querySelector('.posCatalog_select, .cur, .active, li.current, .posCatalog_active, .cells.active, .cur_item');
                }
                const titleEl = document.querySelector('.posCatalog_select .posCatalog_name, .cur_title, .catalog_name');
                const courseTitleEl = document.querySelector('.course_title, .title_lesson, .courseName, h1.title, .right_title');

                let unitText = cur ? cur.innerText.replace(/\s+/g, ' ').trim() : '';
                if (systemKeywords.some(k => unitText.includes(k))) unitText = '';

                let titleText = titleEl ? titleEl.innerText.trim() : '';
                if (systemKeywords.some(k => titleText.includes(k))) titleText = '';

                return {
                    unit: unitText || titleText,
                    courseName: courseTitleEl ? courseTitleEl.innerText.trim() : ''
                };
            });
            if (info.unit) {
                this.task.progress.unitTitle = info.unit;
            } else if (this.lastUnitKey && (!this.task.progress.unitTitle || systemKeywords.some(k => this.task.progress.unitTitle.includes(k)))) {
                this.task.progress.unitTitle = this.lastUnitKey;
            }
            if (info.courseName && (!this.task.name || this.task.name === '未命名课程')) {
                this.task.name = info.courseName;
            }
        } catch (e) {}
    }

    /**
     * 章节测验与作业全量自动作答流转控制器
     */
    async handleChapterExam() {
        if (this.isSolvingExam || !this.page || this.page.isClosed()) return false;
        try {
            // 1. 穿透页面全量探测章节测验
            const examDetect = await this.examSolver.detectAndExtractExam(this.page);
            if (!examDetect.found || examDetect.questions.length === 0) {
                return false;
            }

            // 生成测验签名，防止同一测验反复作答
            const firstStem = examDetect.questions[0]?.stem || '';
            const examSig = `${examDetect.title}_${examDetect.questions.length}_${firstStem.slice(0, 20)}`;

            if (this.solvedExamSignatures.has(examSig)) {
                this.log(`【章节测验】当前测验「${examDetect.title}」(共${examDetect.questions.length}题) 本轮已作答完成，流转至下一任务点...`);
                await this.advanceTabOrUnit();
                return true;
            }

            if (examDetect.isCompleted) {
                this.log(`【章节测验】当前测验「${examDetect.title}」已处于完成/已交卷状态，跳过作答直接流转...`);
                this.solvedExamSignatures.add(examSig);
                await this.advanceTabOrUnit();
                return true;
            }

            this.isSolvingExam = true;
            this.log(`【章节测验检测】捕获整页独立测验/作业: 「${examDetect.title}」，题目总数: ${examDetect.questions.length} 题！启动 AI 答题引擎...`);

            const result = await this.examSolver.solveExam(this.page, {
                examSubmitMode: this.config.examSubmitMode || 'AUTO_SUBMIT',
                examDelayBetweenClicksMs: this.config.examDelayBetweenClicksMs || 250
            });

            if (result.success) {
                this.solvedExamSignatures.add(examSig);
                this.log(`🎉【章节测验答题成功】共 ${result.questionsCount} 道题已全部勾选，执行动作: [${result.actionTaken}]！`);
                if (result.details && result.details.length > 0) {
                    result.details.forEach(d => {
                        this.log(`  [第${d.questionNumber}题] (${d.type}) 推导答案: 【${d.predicted}】`);
                    });
                }
                // 等待 3 秒使页面状态同步
                await this.page.waitForTimeout(3000);
                this.log(`【章节测验】答题与提交完毕，正在平稳流转至后续任务点...`);
                await this.advanceTabOrUnit();
                return true;
            } else {
                this.log(`⚠️【章节测验答题失败】${result.error || '未知原因'}`, 'warn');
                return false;
            }
        } catch (err) {
            this.log(`【章节测验处理异常】${err.message}`, 'warn');
            return false;
        } finally {
            this.isSolvingExam = false;
        }
    }

    async advanceTabOrUnit() {
        if (!this.page || this.page.isClosed()) return;
        // 优先尝试切换同小节内未完成的 Tab 标签页 (如: 章节测验、文档、作业等)
        const tabSwitched = await this.trySwitchNextTab();
        if (tabSwitched) {
            return;
        }
        // 若同小节所有 Tab 均已轮询完毕，进入下一小节
        await this.nextUnit();
    }

    async trySwitchNextTab() {
        try {
            const tabInfo = await this.page.evaluate(() => {
                const containers = [
                    '.prev_ul', '.tabtags', '.card_head', '.tabs', '.nav-tabs',
                    '.ans-card-tab', '.ans-card-nav', '.ans-tabs', '.unit-tabs'
                ];
                let tabEls = [];
                for (const sel of containers) {
                    const c = document.querySelector(sel);
                    if (c) {
                        const items = Array.from(c.querySelectorAll('li, span, a, div.prev_title, div[role="tab"]')).filter(el => {
                            const t = el.innerText.trim();
                            return t.length > 0 && t.length < 20;
                        });
                        if (items.length > 1) {
                            tabEls = items;
                            break;
                        }
                    }
                }

                if (tabEls.length <= 1) {
                    const keywords = ['视频', '测验', '章节测验', '作业', '文档', '课件', '音频', '讨论'];
                    const candidates = Array.from(document.querySelectorAll('span, li, a, div')).filter(el => {
                        const t = el.innerText.trim();
                        return keywords.some(k => t === k || t.startsWith(k)) && el.children.length <= 2;
                    });
                    if (candidates.length > 1) {
                        const p = candidates[0].parentElement;
                        if (p && candidates.every(c => c.parentElement === p)) {
                            tabEls = candidates;
                        }
                    }
                }

                if (tabEls.length <= 1) return null;

                let activeIndex = -1;
                const tabsData = tabEls.map((el, idx) => {
                    const isActive = el.classList.contains('active') || 
                                     el.classList.contains('cur') || 
                                     el.classList.contains('selected') || 
                                     el.classList.contains('current') || 
                                     el.classList.contains('prev_title_active') ||
                                     el.getAttribute('aria-selected') === 'true';
                    if (isActive) activeIndex = idx;
                    const isCompleted = el.classList.contains('green') || 
                                        !!el.querySelector('.jobCheckRound.green, .ans-job-icon.green, .ans-job-icon-finish, i.finish');
                    return {
                        index: idx,
                        title: el.innerText.trim(),
                        isActive,
                        isCompleted
                    };
                });

                return { total: tabEls.length, activeIndex, tabs: tabsData };
            });

            if (!tabInfo || tabInfo.total <= 1) return false;

            const curUnitTitle = (this.task.progress.unitTitle || '').trim();
            if (this.lastUnitKey !== curUnitTitle) {
                this.lastUnitKey = curUnitTitle;
                this.currentUnitProcessedTabs.clear();
            }

            const currentActiveIdx = tabInfo.activeIndex >= 0 ? tabInfo.activeIndex : 0;
            this.currentUnitProcessedTabs.add(currentActiveIdx);

            let nextTargetTab = null;
            for (let i = 0; i < tabInfo.total; i++) {
                if (!this.currentUnitProcessedTabs.has(i)) {
                    nextTargetTab = tabInfo.tabs[i];
                    break;
                }
            }

            if (nextTargetTab) {
                this.log(`【多Tab流转】当前Tab[${tabInfo.tabs[currentActiveIdx]?.title || '任务点'}]已完成，检测到待处理任务点: 「${nextTargetTab.title}」(第${nextTargetTab.index + 1}/${tabInfo.total}项)，正在切换...`);
                
                await this.page.evaluate((targetIdx) => {
                    const containers = [
                        '.prev_ul', '.tabtags', '.card_head', '.tabs', '.nav-tabs',
                        '.ans-card-tab', '.ans-card-nav', '.ans-tabs', '.unit-tabs'
                    ];
                    let tabEls = [];
                    for (const sel of containers) {
                        const c = document.querySelector(sel);
                        if (c) {
                            const items = Array.from(c.querySelectorAll('li, span, a, div.prev_title, div[role="tab"]')).filter(el => {
                                const t = el.innerText.trim();
                                return t.length > 0 && t.length < 20;
                            });
                            if (items.length > 1) {
                                tabEls = items;
                                break;
                            }
                        }
                    }
                    if (tabEls.length <= 1) {
                        const keywords = ['视频', '测验', '章节测验', '作业', '文档', '课件', '音频', '讨论'];
                        const candidates = Array.from(document.querySelectorAll('span, li, a, div')).filter(el => {
                            const t = el.innerText.trim();
                            return keywords.some(k => t === k || t.startsWith(k)) && el.children.length <= 2;
                        });
                        if (candidates.length > 1) {
                            const p = candidates[0].parentElement;
                            if (p && candidates.every(c => c.parentElement === p)) {
                                tabEls = candidates;
                            }
                        }
                    }
                    if (tabEls[targetIdx]) {
                        tabEls[targetIdx].scrollIntoView();
                        tabEls[targetIdx].click();
                    }
                }, nextTargetTab.index);

                this.currentUnitProcessedTabs.add(nextTargetTab.index);
                await this.page.waitForTimeout(3500);
                this.log(`【多Tab流转】已成功切换至: 「${nextTargetTab.title}」`);
                return true;
            }

            this.log(`【多Tab流转】当前小节所有任务点 (${tabInfo.total} 个 Tab) 均已轮询完毕，准备进入下一小节...`);
            return false;
        } catch (e) {
            this.log(`多Tab流转检测异常: ${e.message}`, 'warn');
            return false;
        }
    }

    async nextUnit() {
        if (!this.page) return;
        this.log('【切换小节】正在查找并跳转至下一小节...');
        try {
            let switched = false;
            for (const frame of [this.page, ...this.page.frames()]) {
                const res = await frame.evaluate(() => {
                    const systemBlacklist = ['课程', '专题创作', '收件箱', '小组', '云盘', '通讯录', '网站消息', '账号管理', '个人主页', '设置', '帮助', '退出', '返回'];
                    const catalogArea = document.querySelector('#posCatalog, .posCatalog, .catalog_list, .level_1, .chapter_list, #courseTree, .cells, .course_section, .right_nav, .catalog_points');
                    if (!catalogArea) return { success: false };

                    const cur = catalogArea.querySelector('.posCatalog_select, .cur, .active, li.current, .posCatalog_active, .cells.active, .cur_item');
                    if (cur) {
                        const parentLi = cur.closest('li') || cur.closest('.posCatalog_item') || cur.closest('.cells');
                        let nextLi = parentLi ? parentLi.nextElementSibling : null;
                        while (nextLi) {
                            const link = nextLi.querySelector('a, .posCatalog_name, .cell_name') || nextLi;
                            const text = (link && link.innerText ? link.innerText.trim() : '');
                            if (text && !systemBlacklist.some(s => text.includes(s))) {
                                link.scrollIntoView();
                                link.click();
                                return { success: true, text };
                            }
                            nextLi = nextLi.nextElementSibling;
                        }
                    }

                    const orangeBadges = Array.from(catalogArea.querySelectorAll('.orange, span.orange, em.orange, .catalog_points_wait'));
                    for (const badge of orangeBadges) {
                        const row = badge.closest('li') || badge.closest('.posCatalog_item') || badge.closest('.cells');
                        if (row && !row.classList.contains('posCatalog_select') && !row.classList.contains('cur') && !row.classList.contains('active')) {
                            const link = row.querySelector('a, .posCatalog_name, .cell_name') || row;
                            const text = (link && link.innerText ? link.innerText.trim() : '');
                            if (text && !systemBlacklist.some(s => text.includes(s))) {
                                link.scrollIntoView();
                                link.click();
                                return { success: true, text };
                            }
                        }
                    }

                    return { success: false };
                });

                if (res && res.success) {
                    this.log(`【切换小节】已成功跳转到: 「${res.text}」`);
                    switched = true;
                    this.currentUnitProcessedTabs.clear();
                    this.lastUnitKey = null;
                    break;
                }
            }

            if (!switched && this.task.url) {
                this.log('【智能寻路】当前页未找到下一小节，正在返回课程大纲页自动定位未完成节点...');
                await this.autoNavigateFromCatalog(this.task.url);
            }

            await this.page.waitForTimeout(4000);
        } catch (e) {
            this.log(`切换下一小节出错: ${e.message}`, 'warn');
        }
    }

    normalizeUnitTitle(rawTitle) {
        if (!rawTitle) return '';
        return rawTitle.replace(/\s+/g, ' ').replace(/\s*\d+$/, '').trim();
    }

    async autoNavigateFromCatalog(catalogUrl) {
        this.log('【智能寻路】正在加载课程大纲页寻找未完成任务点...');
        try {
            await this.page.goto(catalogUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (navErr) {
            this.log(`【智能寻路】大纲页跳转注意: ${navErr.message}`, 'warn');
        }
        await this.page.waitForTimeout(3000);

        let candidates = [];
        for (const frame of [this.page, ...this.page.frames()]) {
            try {
                const list = await frame.evaluate(() => {
                    const systemBlacklist = ['课程', '专题创作', '收件箱', '小组', '云盘', '通讯录', '网站消息', '账号管理', '个人主页', '设置', '帮助', '退出', '返回'];
                    
                    const catalogArea = document.querySelector(
                        '#posCatalog, .posCatalog, .catalog_list, .level_1, .chapter_list, #courseTree, .cells, .course_section, .right_nav, .units, .leveltwo, .catalog_tabel, .timeline, #course_study_content'
                    ) || document.querySelector('.main, #main, .content, #content') || document.body;

                    const badges = Array.from(catalogArea.querySelectorAll(
                        '.orange, span.orange, em.orange, .catalog_points_wait, .roundpoint:not(.green):not(.finish), .catalog_point_round:not(.green):not(.finish), .jobCheckRound:not(.green):not(.finish)'
                    )).filter(el => {
                        if (el.classList.contains('green') || el.classList.contains('finish') || el.classList.contains('finished') || el.classList.contains('openlock')) return false;
                        if (el.closest('.green, .finish, .finished, .ans-job-icon-finish')) return false;
                        if (el.closest('.header, #header, .top_nav, .site_nav, .nav_list, .head_nav, .nav, .left_menu, .side_menu')) return false;
                        const text = el.innerText.trim();
                        if (text === '0') return false;
                        return true;
                    });

                    const results = [];
                    badges.forEach((badge, idx) => {
                        const row = badge.closest('h3, h2, li, .posCatalog_item, tr, .cells, .clearfix') || badge.parentElement;
                        if (row) {
                            const hasFinished = !!row.querySelector('.green, .finish, .finished, .ans-job-icon-finish');
                            const hasOrange = !!row.querySelector('.orange, em.orange, span.orange, .catalog_points_wait');
                            if (hasFinished && !hasOrange) return;

                            const link = row.querySelector('a[href*="studentstudy"], a[onclick*="chapter"], a[onclick*="toOldOrNew"], .posCatalog_name') || row.querySelector('a') || row;
                            const textEl = row.querySelector('.articlename, .posCatalog_name, .fl.fontCon') || link || row;
                            const text = textEl.innerText.replace(/\s+/g, ' ').trim();
                            const href = (link && typeof link.getAttribute === 'function') ? (link.getAttribute('href') || '') : '';

                            if (href.includes('pan.') || href.includes('space') || href.includes('msg')) return;
                            if (text && !systemBlacklist.some(s => text.includes(s))) {
                                results.push({ idx, text, href });
                            }
                        }
                    });
                    return results;
                });
                if (list && list.length > 0) {
                    candidates = list;
                    break;
                }
            } catch (e) {}
        }

        if (candidates.length === 0) {
            // 防误判校验：检查页面是否真实加载出了大纲结构
            const hasCatalogStructure = await this.page.evaluate(() => {
                return document.querySelectorAll('a[href*="studentstudy"], .units h3, .posCatalog_name, .leveltwo h3, .catalog_name').length > 0;
            }).catch(() => false);

            if (!hasCatalogStructure) {
                this.log('【智能寻路】大纲树节点尚未就绪或网络加载延迟，暂不判定完成，等待下轮轮询...', 'warn');
                await this.page.waitForTimeout(4000);
                return;
            }

            this.status = 'COMPLETED';
            this.task.status = 'COMPLETED';
            this.task.progress.percentage = 100;
            this.task.updatedAt = Date.now();
            this.log(`🎉【课程完成】本课程全部任务点已学完: 「${this.task.name}」！`, 'info');
            this.emit('completed', this.task);
            await this.stop();
            return;
        }

        // 熔断与黑名单过滤
        let chosenCandidate = null;
        const now = Date.now();

        for (const cand of candidates) {
            const normTitle = this.normalizeUnitTitle(cand.text);
            
            // 1. 检查是否在熔断黑名单中
            if (this.unitBlacklist.has(normTitle)) {
                this.log(`【寻路跳过】小节「${normTitle}」已被安全熔断，自动跳过`, 'warn');
                continue;
            }

            // 2. 连续访问死循环检测 (90秒内连续跌回大纲)
            let visitCount = (this.unitVisitCounts.get(normTitle) || 0);
            if (this.consecutiveUnitVisits.name === normTitle && (now - this.consecutiveUnitVisits.lastTime) < 90000) {
                this.consecutiveUnitVisits.count++;
            } else {
                this.consecutiveUnitVisits = { name: normTitle, count: 1, lastTime: now };
            }

            // 熔断条件: 真正连续跌回 4 次，或累计跌回 5 次才触发熔断
            if (this.consecutiveUnitVisits.count >= 4 || visitCount >= 5) {
                this.unitBlacklist.add(normTitle);
                this.log(`⚠️【寻路死循环熔断】小节「${normTitle}」反复跌回大纲(${this.consecutiveUnitVisits.count}次)，触发安全熔断保护！已将其加入跳过列表，自动寻路将跳过该小节推进后续任务。`, 'error');
                continue;
            }

            chosenCandidate = cand;
            this.unitVisitCounts.set(normTitle, visitCount + 1);
            this.consecutiveUnitVisits.lastTime = now;
            break;
        }

        if (!chosenCandidate) {
            this.log(`⚠️【寻路完成】大纲中剩余的未完成任务点均已被熔断跳过（共 ${this.unitBlacklist.size} 个顽固任务点）。课程主干任务全部执行完毕！`, 'warn');
            this.status = 'COMPLETED';
            this.task.status = 'COMPLETED';
            this.task.progress.percentage = 100;
            this.task.updatedAt = Date.now();
            this.emit('completed', this.task);
            await this.stop();
            return;
        }

        let clicked = false;
        for (const frame of [this.page, ...this.page.frames()]) {
            try {
                const res = await frame.evaluate((cand) => {
                    const rows = Array.from(document.querySelectorAll('h3, h2, li, .posCatalog_item, tr, .cells, .clearfix'));
                    for (const row of rows) {
                        const link = row.querySelector('a[href*="studentstudy"], a[onclick*="chapter"], a[onclick*="toOldOrNew"], .posCatalog_name') || row.querySelector('a') || row;
                        const href = (link && typeof link.getAttribute === 'function') ? (link.getAttribute('href') || '') : '';
                        const nameEl = row.querySelector('.articlename, .posCatalog_name, a, .cell_name, .fl.fontCon') || row;
                        const t = nameEl.innerText.replace(/\s+/g, ' ').trim();

                        const matchHref = cand.href && href && (href.includes(cand.href) || cand.href.includes(href));
                        const matchText = t && (t === cand.text || t.includes(cand.text) || cand.text.includes(t));

                        if (matchHref || matchText) {
                            if (link && link.click) {
                                if (link.getAttribute('target') === '_blank') {
                                    link.removeAttribute('target');
                                    link.target = '_self';
                                }
                                link.scrollIntoView();
                                link.click();
                                return true;
                            }
                        }
                    }
                    return false;
                }, chosenCandidate);

                if (res) {
                    clicked = true;
                    break;
                }
            } catch (e) {}
        }

        if (clicked) {
            const cleanName = this.normalizeUnitTitle(chosenCandidate.text);
            this.log(`【智能寻路】已自动定位并点击未完成任务点: 「${cleanName}」`);
            this.currentUnitProcessedTabs.clear();
            this.lastUnitKey = cleanName;
            this.task.progress.unitTitle = cleanName;
            await this.page.waitForTimeout(4000);
        }
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

            // 4. 探针：检查题干或选项中是否存在真正的试题插图 (排除超星UI小图标与占位图)
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
                    this.task.status = 'PAUSED';
                    this.task.errorMessage = `测验重试已达上限(${this.currentQuizAttempts}次)，触发防风控熔断暂停`;
                    this.task.updatedAt = Date.now();
                    this.emit('task_update', this.task);
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
                    this.currentQuizSignature = null;
                    this.currentQuizAttempts = 0;
                    this.attemptedOptionIndices.clear();
                    this.quizCircuitBreakerTripped = false;
                    return true;
                } else {
                    this.log(`⚠️【智能答题反馈】该选项未通过，状态机已记录已排除项 (#${targetIndex + 1})。`, 'warn');
                    return true; // 依然返回 true，告知外层循环此 frame 有测验，跳出子 frame 循环
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

    async stop() {
        if (this.monitorTimer) {
            clearInterval(this.monitorTimer);
            this.monitorTimer = null;
        }
        if (this.status !== 'COMPLETED') {
            this.status = 'PAUSED';
            this.task.status = 'PAUSED';
        }
        this.task.updatedAt = Date.now();
        if (this.onNewPage && this.context) {
            this.context.off('page', this.onNewPage);
            this.onNewPage = null;
        }
        if (this.page && !this.page.isClosed()) {
            await this.page.close().catch(() => {});
            this.page = null;
        }
        this.log('已暂停当前任务工作线程。');
    }
}

module.exports = TaskWorker;
