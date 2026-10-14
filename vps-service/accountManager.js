const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const EventEmitter = require('events');

class AccountManager extends EventEmitter {
    constructor(userDataDir = null, browser = null) {
        super();
        this.userDataDir = userDataDir || path.join(__dirname, 'userData');
        this.accountsJsonPath = path.join(this.userDataDir, 'accounts.json');
        this.legacyAuthPath = path.join(this.userDataDir, 'auth_state.json');

        this.browser = browser;
        this.accounts = [];
        this.contexts = new Map(); // accountId -> BrowserContext
        this.activeLoginSessions = new Map(); // accountId -> { page, timer, timeoutAt }

        if (!fs.existsSync(this.userDataDir)) {
            fs.mkdirSync(this.userDataDir, { recursive: true });
        }

        this.loadAccounts();
    }

    log(msg, type = 'info', accountId = null) {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const prefix = accountId ? `[账户:${accountId}] ` : '';
        console.log(`[${time}] [${type.toUpperCase()}] ${prefix}${msg}`);
        this.emit('log', { time, type, msg, accountId });
    }

    // 1. 账户数据持久化与平滑迁移
    loadAccounts() {
        try {
            if (fs.existsSync(this.accountsJsonPath)) {
                this.accounts = JSON.parse(fs.readFileSync(this.accountsJsonPath, 'utf8'));
            } else {
                this.accounts = [];
                // 首次运行：自动迁移现有 auth_state.json 作为默认主账号
                this.migrateLegacyAccount();
            }
        } catch (e) {
            console.error('加载 accounts.json 异常:', e.message);
            this.accounts = [];
        }
    }

    migrateLegacyAccount() {
        const defaultId = 'acc_default';
        const defaultCookieFile = `auth_${defaultId}.json`;
        const targetCookiePath = path.join(this.userDataDir, defaultCookieFile);

        let hasCookies = false;
        if (fs.existsSync(this.legacyAuthPath)) {
            try {
                fs.copyFileSync(this.legacyAuthPath, targetCookiePath);
                hasCookies = true;
                this.log('已成功将现有全局登录凭证迁移至默认主账号 (acc_default)');
            } catch (err) {}
        }

        const defaultAccount = {
            id: defaultId,
            name: '默认主账号',
            status: hasCookies ? 'LOGGED_IN' : 'NEED_LOGIN',
            cookieFile: defaultCookieFile,
            userRealName: '',
            schoolName: '',
            lastLoginAt: hasCookies ? Date.now() : 0,
            createdAt: Date.now()
        };

        this.accounts.push(defaultAccount);
        this.saveAccounts();
    }

    saveAccounts() {
        try {
            fs.writeFileSync(this.accountsJsonPath, JSON.stringify(this.accounts, null, 2), 'utf8');
        } catch (e) {
            console.error('保存 accounts.json 失败:', e.message);
        }
    }

    listAccounts() {
        return this.accounts.map(acc => ({
            id: acc.id,
            name: acc.name,
            status: acc.status,
            userRealName: acc.userRealName || '',
            schoolName: acc.schoolName || '',
            lastLoginAt: acc.lastLoginAt || 0,
            createdAt: acc.createdAt || 0
        }));
    }

    getAccount(accountId) {
        return this.accounts.find(a => a.id === accountId) || null;
    }

    createAccount(name) {
        const id = 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const cookieFile = `auth_${id}.json`;
        const newAcc = {
            id,
            name: (name && name.trim()) ? name.trim() : `账号_${this.accounts.length + 1}`,
            status: 'NEED_LOGIN',
            cookieFile,
            userRealName: '',
            schoolName: '',
            lastLoginAt: 0,
            createdAt: Date.now()
        };
        this.accounts.push(newAcc);
        this.saveAccounts();
        this.log(`成功创建新账户档案: 「${newAcc.name}」 (${newAcc.id})`);
        return newAcc;
    }

    async deleteAccount(accountId) {
        const idx = this.accounts.findIndex(a => a.id === accountId);
        if (idx === -1) return false;

        const acc = this.accounts[idx];
        await this.closeContext(accountId);

        // 清理 Cookie 和二维码临时文件
        const cookiePath = path.join(this.userDataDir, acc.cookieFile);
        if (fs.existsSync(cookiePath)) {
            try { fs.unlinkSync(cookiePath); } catch (e) {}
        }
        const qrPath = path.join(this.userDataDir, `qr_${accountId}.png`);
        if (fs.existsSync(qrPath)) {
            try { fs.unlinkSync(qrPath); } catch (e) {}
        }

        this.accounts.splice(idx, 1);
        this.saveAccounts();
        this.log(`已成功删除账户: 「${acc.name}」 (${accountId})`);
        return true;
    }

    // 2. Playwright 独立 BrowserContext 池化管理
    async initBrowser(headless = true) {
        if (!this.browser) {
            this.log('正在启动多租户全局浏览器主进程 (Playwright Chromium)...');
            this.browser = await chromium.launch({
                headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--autoplay-policy=no-user-gesture-required',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
        }
        return this.browser;
    }

    async getOrCreateContext(accountId) {
        const acc = this.getAccount(accountId);
        if (!acc) throw new Error(`账户不存在: ${accountId}`);

        if (this.contexts.has(accountId)) {
            return this.contexts.get(accountId);
        }

        await this.initBrowser();

        this.log(`正在为账户 [${acc.name}] 实例化专属隔离 BrowserContext...`, 'info', accountId);
        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 },
            ignoreHTTPSErrors: true
        });

        // 挂载该账户私有 Cookie
        const cookiePath = path.join(this.userDataDir, acc.cookieFile);
        if (fs.existsSync(cookiePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
                if (data.cookies && data.cookies.length > 0) {
                    await context.addCookies(data.cookies);
                    this.log(`已为账户 [${acc.name}] 载入历史登录 Cookies (${data.cookies.length} 项)`, 'info', accountId);
                }
            } catch (err) {
                this.log(`载入账户 Cookies 失败: ${err.message}`, 'warn', accountId);
            }
        }

        this.contexts.set(accountId, context);
        return context;
    }

    async closeContext(accountId) {
        if (this.contexts.has(accountId)) {
            try {
                const ctx = this.contexts.get(accountId);
                await ctx.close().catch(() => {});
            } catch (e) {}
            this.contexts.delete(accountId);
        }
        if (this.activeLoginSessions.has(accountId)) {
            const sess = this.activeLoginSessions.get(accountId);
            if (sess.timer) clearInterval(sess.timer);
            if (sess.page && !sess.page.isClosed()) {
                await sess.page.close().catch(() => {});
            }
            this.activeLoginSessions.delete(accountId);
        }
    }

    async saveAccountCookies(accountId) {
        const acc = this.getAccount(accountId);
        if (!acc || !this.contexts.has(accountId)) return;

        try {
            const context = this.contexts.get(accountId);
            const cookies = await context.cookies();
            if (cookies && cookies.length > 0) {
                const cookiePath = path.join(this.userDataDir, acc.cookieFile);
                fs.writeFileSync(cookiePath, JSON.stringify({ cookies }, null, 2), 'utf8');
                this.log(`账户 [${acc.name}] 认证 Cookies 已持久化 (${cookies.length} 项)`, 'info', accountId);
            }
        } catch (e) {
            this.log(`持久化 Cookies 异常: ${e.message}`, 'warn', accountId);
        }
    }

    // 3. 账户状态主动探测
    async checkAccountLoginStatus(accountId) {
        const acc = this.getAccount(accountId);
        if (!acc) return false;

        try {
            const context = await this.getOrCreateContext(accountId);
            const page = await context.newPage();
            try {
                await page.goto('https://i.chaoxing.com/base', { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.waitForTimeout(2000);
                const currentUrl = page.url();

                if (currentUrl.includes('passport2.chaoxing.com/login')) {
                    acc.status = 'NEED_LOGIN';
                    this.saveAccounts();
                    return false;
                }

                // 尝试抓取学生姓名与学校信息
                const studentInfo = await page.evaluate(() => {
                    const nameEl = document.querySelector('.user-name, #show_name, .message_name, .user_name, .name');
                    const schoolEl = document.querySelector('.school-name, .dept, .unit, .school');
                    return {
                        name: nameEl ? nameEl.innerText.trim() : '',
                        school: schoolEl ? schoolEl.innerText.trim() : ''
                    };
                }).catch(() => ({ name: '', school: '' }));

                if (studentInfo.name) acc.userRealName = studentInfo.name;
                if (studentInfo.school) acc.schoolName = studentInfo.school;

                acc.status = 'LOGGED_IN';
                acc.lastLoginAt = Date.now();
                this.saveAccounts();
                await this.saveAccountCookies(accountId);
                this.log(`账户 [${acc.name}] 登录有效！${acc.userRealName ? `(学生: ${acc.userRealName})` : ''}`, 'info', accountId);
                return true;
            } finally {
                await page.close().catch(() => {});
            }
        } catch (e) {
            this.log(`检查账户登录态失败: ${e.message}`, 'warn', accountId);
            return false;
        }
    }

    // 4. 独立扫码认证流程
    async requestQrLogin(accountId) {
        const acc = this.getAccount(accountId);
        if (!acc) throw new Error(`未找到账户: ${accountId}`);

        // 若已有进行中的扫码会话，先关闭
        if (this.activeLoginSessions.has(accountId)) {
            const old = this.activeLoginSessions.get(accountId);
            if (old.timer) clearInterval(old.timer);
            if (old.page && !old.page.isClosed()) await old.page.close().catch(() => {});
            this.activeLoginSessions.delete(accountId);
        }

        const context = await this.getOrCreateContext(accountId);
        const page = await context.newPage();

        this.log(`正在为账户 [${acc.name}] 请求超星登录二维码...`, 'info', accountId);
        try {
            await page.goto('https://passport2.chaoxing.com/login?refer=https%3A%2F%2Fi.chaoxing.com%2Fbase', {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            const qrSelector = '#quickCode';
            await page.waitForSelector(qrSelector, { timeout: 15000 });
            await page.waitForTimeout(1000);

            const qrEl = await page.$(qrSelector);
            if (!qrEl) throw new Error('未能在页面中找到二维码元素 #quickCode');

            const qrBuffer = await qrEl.screenshot();
            const qrPath = path.join(this.userDataDir, `qr_${accountId}.png`);
            fs.writeFileSync(qrPath, qrBuffer);

            const qrBase64 = `data:image/png;base64,${qrBuffer.toString('base64')}`;
            acc.status = 'LOGGING_IN';
            this.saveAccounts();

            this.log(`账户 [${acc.name}] 二维码已刷新，等待客户端扫码认证...`, 'info', accountId);

            // 启动异步长轮询监听扫码结果
            this.waitForLoginSuccess(accountId, page);
            return qrBase64;
        } catch (e) {
            await page.close().catch(() => {});
            this.log(`获取二维码失败: ${e.message}`, 'error', accountId);
            throw e;
        }
    }

    waitForLoginSuccess(accountId, page) {
        const acc = this.getAccount(accountId);
        const startTime = Date.now();
        const timeoutMs = 180000; // 3分钟超时

        const timer = setInterval(async () => {
            try {
                if (Date.now() - startTime > timeoutMs) {
                    clearInterval(timer);
                    this.activeLoginSessions.delete(accountId);
                    if (!page.isClosed()) await page.close().catch(() => {});
                    if (acc && acc.status === 'LOGGING_IN') {
                        acc.status = 'NEED_LOGIN';
                        this.saveAccounts();
                    }
                    this.log(`账户 [${acc?.name || accountId}] 扫码等待超时。`, 'warn', accountId);
                    return;
                }

                if (page.isClosed()) {
                    clearInterval(timer);
                    this.activeLoginSessions.delete(accountId);
                    return;
                }

                const url = page.url();
                if (!url.includes('passport2.chaoxing.com/login')) {
                    clearInterval(timer);
                    this.activeLoginSessions.delete(accountId);

                    await page.waitForTimeout(2000);
                    // 尝试抓取真实姓名与学校
                    const info = await page.evaluate(() => {
                        const nameEl = document.querySelector('.user-name, #show_name, .message_name, .user_name, .name');
                        const schoolEl = document.querySelector('.school-name, .dept, .unit, .school');
                        return {
                            name: nameEl ? nameEl.innerText.trim() : '',
                            school: schoolEl ? schoolEl.innerText.trim() : ''
                        };
                    }).catch(() => ({ name: '', school: '' }));

                    if (acc) {
                        acc.status = 'LOGGED_IN';
                        acc.lastLoginAt = Date.now();
                        if (info.name) acc.userRealName = info.name;
                        if (info.school) acc.schoolName = info.school;
                        this.saveAccounts();
                    }

                    await this.saveAccountCookies(accountId);
                    await page.close().catch(() => {});

                    this.log(`🎉 恭喜！账户 [${acc?.name || accountId}] 扫码登录成功！${acc?.userRealName ? `(学生: ${acc.userRealName})` : ''}`, 'info', accountId);
                    this.emit('account_login_success', acc);
                }
            } catch (err) {}
        }, 2000);

        this.activeLoginSessions.set(accountId, { page, timer, timeoutAt: startTime + timeoutMs });
    }

    async closeAll() {
        for (const [id, session] of this.activeLoginSessions) {
            if (session.timer) clearInterval(session.timer);
            if (session.page && !session.page.isClosed()) await session.page.close().catch(() => {});
        }
        this.activeLoginSessions.clear();

        for (const [id, context] of this.contexts) {
            await context.close().catch(() => {});
        }
        this.contexts.clear();

        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
        }
    }
}

module.exports = AccountManager;
