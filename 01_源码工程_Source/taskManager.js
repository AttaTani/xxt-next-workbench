const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const TaskWorker = require('./taskWorker');
const AccountManager = require('./accountManager');
const AiDoctor = require('./aiDoctor');

class TaskManager extends EventEmitter {
    constructor() {
        super();
        this.rootDir = path.resolve(__dirname, '..');
        this.userDataDir = process.env.USER_DATA_DIR || (fs.existsSync(path.join(__dirname, 'userData')) ? path.join(__dirname, 'userData') : (fs.existsSync(path.join(this.rootDir, 'vps-service', 'userData')) ? path.join(this.rootDir, 'vps-service', 'userData') : path.join(__dirname, 'userData')));
        this.tasksJsonPath = path.join(this.userDataDir, 'tasks.json');
        this.configPath = fs.existsSync(path.join(__dirname, 'config.json')) ? path.join(__dirname, 'config.json') : (fs.existsSync(path.join(this.rootDir, 'vps-service', 'config.json')) ? path.join(this.rootDir, 'vps-service', 'config.json') : path.join(__dirname, 'config.json'));

        this.loadConfig();

        // 实例化多租户会话与上下文管理器
        this.accountManager = new AccountManager(this.userDataDir);
        this.status = 'IDLE'; // IDLE, NEED_LOGIN, LOGGED_IN, RUNNING, STOPPED, ERROR
        this.logs = [];
        this.maxLogs = 500;

        this.maxConcurrent = this.config.maxConcurrent || 1;
        this.tasks = [];
        this.workers = new Map(); // taskId -> TaskWorker

        this.loadTasks();

        // 实例化并启动 AI 运维巡检哨兵 (切片 D1)
        this.aiDoctor = new AiDoctor(this);
        if (this.config.enableAiDoctor !== false) {
            this.aiDoctor.start();
        }

        // 监听来自 AccountManager 的生命周期事件
        this.accountManager.on('log', (entry) => {
            this.logs.push(entry);
            if (this.logs.length > this.maxLogs) this.logs.shift();
            this.emit('log', entry);
        });

        this.accountManager.on('account_login_success', (acc) => {
            this.log(`账户「${acc.name}」扫码登录成功，尝试唤醒排队任务...`, 'info', null, acc.name);
            this.schedule();
        });
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } else {
                this.config = {
                    port: 3888,
                    playbackRate: 1,
                    maxConcurrent: 1,
                    autoAdvanceNoVideo: false,
                    courseUrl: '',
                    headless: true
                };
            }
        } catch (e) {
            this.config = { port: 3888, playbackRate: 1, maxConcurrent: 1, headless: true };
        }
    }

    saveConfig(updates = {}) {
        this.config = { ...this.config, ...updates };
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    }

    loadTasks() {
        try {
            if (fs.existsSync(this.tasksJsonPath)) {
                this.tasks = JSON.parse(fs.readFileSync(this.tasksJsonPath, 'utf8'));
                for (const t of this.tasks) {
                    if (!t.accountId) t.accountId = 'acc_default';
                    if (t.status === 'RUNNING') {
                        t.status = 'QUEUED';
                    }
                }
            } else {
                this.tasks = [];
                if (this.config.courseUrl) {
                    this.tasks.push({
                        id: 'task_1',
                        accountId: 'acc_default',
                        name: '默认首选课程',
                        url: this.config.courseUrl,
                        status: 'QUEUED',
                        playbackRate: this.config.playbackRate || 1,
                        progress: {
                            unitTitle: '',
                            percentage: 0,
                            currentTime: 0,
                            duration: 0
                        },
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                    this.saveTasks();
                }
            }
        } catch (e) {
            this.tasks = [];
        }
    }

    saveTasks() {
        try {
            if (!fs.existsSync(this.userDataDir)) {
                fs.mkdirSync(this.userDataDir, { recursive: true });
            }
            fs.writeFileSync(this.tasksJsonPath, JSON.stringify(this.tasks, null, 2), 'utf8');
        } catch (e) {
            console.error('保存 tasks.json 失败:', e.message);
        }
    }

    log(msg, type = 'info', taskId = null, taskName = null) {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const entry = {
            taskId,
            taskName,
            time,
            msg,
            type
        };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        const prefix = taskName ? `[${taskName}] ` : '';
        console.log(`[${time}] [${type.toUpperCase()}] ${prefix}${msg}`);
        this.emit('log', entry);
    }

    async initBrowser() {
        return await this.accountManager.initBrowser(this.config.headless !== false);
    }

    async checkLogin() {
        this.log('检查默认主账号登录状态...');
        const isLogged = await this.accountManager.checkAccountLoginStatus('acc_default');
        this.status = isLogged ? 'LOGGED_IN' : 'NEED_LOGIN';
        return isLogged;
    }

    async requestQrLogin(accountId = 'acc_default') {
        return await this.accountManager.requestQrLogin(accountId);
    }

    // ================= 核心多租户并发调度器 (Multi-Tenant Concurrency Scheduler) =================

    async schedule() {
        // 统计当前处于运行中的工作线程
        const activeWorkers = Array.from(this.workers.values()).filter(w => w.status === 'RUNNING');
        const runningCount = activeWorkers.length;

        // 若活跃线程已达上限，暂不唤醒新任务
        if (runningCount >= this.maxConcurrent) {
            return;
        }

        const availableSlots = this.maxConcurrent - runningCount;
        const queuedTasks = this.tasks.filter(t => t.status === 'QUEUED');

        for (let i = 0; i < Math.min(availableSlots, queuedTasks.length); i++) {
            const task = queuedTasks[i];
            await this.spawnWorker(task);
        }

        this.status = Array.from(this.workers.values()).some(w => w.status === 'RUNNING') ? 'RUNNING' : 'IDLE';
    }

    async spawnWorker(task) {
        if (this.workers.has(task.id)) {
            const existing = this.workers.get(task.id);
            if (existing.status === 'RUNNING') return;
            await existing.stop();
            this.workers.delete(task.id);
        }

        const accountId = task.accountId || 'acc_default';
        const account = this.accountManager.getAccount(accountId);
        if (!account) {
            this.log(`【启动异常】未找到任务绑定的账户: ${accountId}`, 'error', task.id);
            task.status = 'ERROR';
            task.errorMessage = `绑定账户不存在: ${accountId}`;
            this.saveTasks();
            return;
        }

        if (account.status !== 'LOGGED_IN') {
            this.log(`【启动挂起】账户「${account.name}」未登录，请在面板扫码认证后再启动。`, 'warn', task.id);
            task.status = 'PAUSED';
            task.errorMessage = `账户「${account.name}」尚未登录，请先扫码认证`;
            this.saveTasks();
            return;
        }

        this.log(`正在分配并发槽位启动任务: 「${task.name || task.id}」 (绑定账户: ${account.name})`, 'info', task.id, task.name);

        // 获取该账户专属的独立隔离 BrowserContext
        const context = await this.accountManager.getOrCreateContext(accountId);
        const worker = new TaskWorker(task, context, this.config, this.userDataDir);

        worker.on('log', (entry) => {
            this.logs.push(entry);
            if (this.logs.length > this.maxLogs) this.logs.shift();
            console.log(`[${entry.time}] [${entry.type.toUpperCase()}] [${task.name || task.id}] ${entry.msg}`);
            this.emit('log', entry);
        });

        worker.on('completed', async (completedTask) => {
            this.log(`🎉 任务已完成全部学习: 「${completedTask.name}」`, 'info', completedTask.id, completedTask.name);
            this.saveTasks();
            this.workers.delete(completedTask.id);
            setTimeout(() => this.schedule(), 2000);
        });

        worker.on('error', (err) => {
            this.saveTasks();
            this.workers.delete(task.id);
            setTimeout(() => this.schedule(), 2000);
        });

        this.workers.set(task.id, worker);
        await worker.start();
        this.saveTasks();
    }

    // ================= 任务生命周期管理 =================

    validateCourseUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') {
            throw new Error('课程 URL 不能为空');
        }
        const trimmed = rawUrl.trim();
        let parsed;
        try {
            parsed = new URL(trimmed);
        } catch (e) {
            throw new Error('无效的 URL 格式，请输入合法的 HTTP/HTTPS 链接');
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('仅允许 HTTP 或 HTTPS 协议');
        }

        const host = parsed.hostname.toLowerCase();

        // 防御 SSRF：严禁访问回环地址、局域网私有网段与云元数据地址
        const forbiddenPatterns = [
            'localhost', '127.0.0.1', '::1', '0.0.0.0',
            '169.254.', '10.', '192.168.'
        ];
        if (forbiddenPatterns.some(p => host === p || host.startsWith(p)) ||
            (host.startsWith('172.') && /^172\.(1[6-9]|2\d|3[01])\./.test(host))) {
            throw new Error('安全拦截：禁止访问内网、本地回环或元数据地址');
        }

        // 允许超星学习通全系域名及高校超星定制平台域名
        const allowedDomains = ['chaoxing.com', 'xuexitong.com', 'edu.cn'];
        const isAllowed = allowedDomains.some(d => host === d || host.endsWith('.' + d));
        if (!isAllowed) {
            throw new Error(`安全拦截：非受信任域名 [${host}]，仅支持超星平台 (*.chaoxing.com / *.xuexitong.com / *.edu.cn) 课程链接`);
        }

        return trimmed;
    }

    async createTask(url, name = '', playbackRate = 1, accountId = 'acc_default') {
        const validUrl = this.validateCourseUrl(url);
        const id = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const validAccountId = (accountId && this.accountManager.getAccount(accountId))
            ? accountId
            : (this.accountManager.listAccounts()[0]?.id || 'acc_default');

        const newTask = {
            id,
            accountId: validAccountId,
            name: name || '待识别课程',
            url: validUrl,
            status: 'QUEUED',
            playbackRate: Number(playbackRate) || this.config.playbackRate || 1,
            progress: {
                unitTitle: '',
                percentage: 0,
                currentTime: 0,
                duration: 0
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.tasks.push(newTask);
        this.saveTasks();
        this.log(`成功创建新任务: ${id} (归属账户: ${validAccountId})`, 'info', id);
        this.schedule();
        return newTask;
    }

    async createBatchTasks(urls, playbackRate = 1, accountId = 'acc_default') {
        if (!Array.isArray(urls)) throw new Error('urls 必须为数组');
        const created = [];
        for (const u of urls) {
            const raw = (u || '').trim();
            if (raw) {
                try {
                    const validUrl = this.validateCourseUrl(raw);
                    const t = await this.createTask(validUrl, '', playbackRate, accountId);
                    created.push(t);
                } catch (err) {
                    this.log(`跳过不合规链接: ${raw} (${err.message})`, 'warn');
                }
            }
        }
        return created;
    }

    async startTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('未找到该任务');

        const accountId = task.accountId || 'acc_default';
        const account = this.accountManager.getAccount(accountId);
        if (account && account.status !== 'LOGGED_IN') {
            task.status = 'PAUSED';
            task.errorMessage = `账户「${account.name}」未登录，请先扫码认证`;
            task.updatedAt = Date.now();
            this.saveTasks();
            this.log(`【启动挂起】账户「${account.name}」未登录，请先在面板扫码。`, 'warn', task.id);
            return task;
        }

        task.status = 'QUEUED';
        task.errorMessage = null;
        task.updatedAt = Date.now();
        this.saveTasks();
        this.log(`任务已加入就绪队列: 「${task.name}」`, 'info', task.id);
        await this.schedule();
        return task;
    }

    async pauseTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('未找到该任务');
        if (this.workers.has(taskId)) {
            const worker = this.workers.get(taskId);
            await worker.stop();
            this.workers.delete(taskId);
        }
        task.status = 'PAUSED';
        task.updatedAt = Date.now();
        this.saveTasks();
        this.log(`任务已暂停: 「${task.name}」`, 'info', task.id);
        this.schedule();
        return task;
    }

    async deleteTask(taskId) {
        if (!taskId || typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
            throw new Error('无效的 taskId');
        }
        await this.pauseTask(taskId).catch(() => {});
        this.tasks = this.tasks.filter(t => t.id !== taskId);
        const screenPath = path.join(this.userDataDir, `screen_${taskId}.png`);
        if (fs.existsSync(screenPath)) {
            try { fs.unlinkSync(screenPath); } catch (e) {}
        }
        this.saveTasks();
        this.log(`任务已删除: ${taskId}`);
        this.schedule();
        return { success: true };
    }

    async setTaskPriority(taskId, action) {
        const idx = this.tasks.findIndex(t => t.id === taskId);
        if (idx === -1) throw new Error('未找到该任务');
        const [target] = this.tasks.splice(idx, 1);
        if (action === 'top') {
            this.tasks.unshift(target);
        } else if (action === 'up' && idx > 0) {
            this.tasks.splice(idx - 1, 0, target);
        } else if (action === 'down' && idx < this.tasks.length) {
            this.tasks.splice(idx + 1, 0, target);
        } else {
            this.tasks.push(target);
        }
        this.saveTasks();
        return this.tasks;
    }

    async setMaxConcurrent(num) {
        const val = Math.max(1, Math.min(4, Number(num) || 1));
        this.maxConcurrent = val;
        this.saveConfig({ maxConcurrent: val });
        this.log(`全局最大并发数已调整为: ${val} 路`);
        await this.schedule();
        return this.maxConcurrent;
    }

    async stopAll() {
        for (const [id, worker] of this.workers.entries()) {
            await worker.stop().catch(() => {});
        }
        this.workers.clear();
        for (const t of this.tasks) {
            if (t.status === 'RUNNING' || t.status === 'QUEUED') {
                t.status = 'PAUSED';
            }
        }
        this.saveTasks();
        this.status = 'STOPPED';
        this.log('已暂停所有挂机任务。');
    }

    async startAll() {
        for (const t of this.tasks) {
            if (t.status !== 'COMPLETED') {
                t.status = 'QUEUED';
            }
        }
        this.saveTasks();
        this.log('已启动全部任务调度！');
        await this.schedule();
    }

    getTasksState() {
        const accounts = this.accountManager.listAccounts();
        const enrichedTasks = this.tasks.map(t => {
            const acc = accounts.find(a => a.id === t.accountId);
            return {
                ...t,
                accountName: acc ? acc.name : '默认主账号',
                accountStatus: acc ? acc.status : 'NEED_LOGIN',
                userRealName: acc ? acc.userRealName : ''
            };
        });
        return {
            status: this.status,
            maxConcurrent: this.maxConcurrent,
            runningCount: Array.from(this.workers.values()).filter(w => w.status === 'RUNNING').length,
            accounts,
            tasks: enrichedTasks,
            logs: this.logs.slice(-60)
        };
    }
}

module.exports = new TaskManager();
