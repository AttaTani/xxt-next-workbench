const express = require('express');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT_EXCEPTION]', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED_REJECTION]', reason);
});

const taskManager = require('./taskManager');

const app = express();
app.use(express.json());

// 1. 安全防护响应头 (防止 MIME 类型嗅探与点击劫持)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// 2. 管理口令鉴权中间件 (支持在 config.json 或环境变量中配置 ADMIN_TOKEN 防公网越权)
const getAdminToken = () => process.env.ADMIN_TOKEN || taskManager.config.adminToken;
app.use('/api', (req, res, next) => {
    const requiredToken = getAdminToken();
    if (requiredToken) {
        const authHeader = req.headers['authorization'];
        const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const clientToken = req.headers['x-admin-token'] || bearerToken || req.query.token;
        if (!clientToken || clientToken !== requiredToken) {
            return res.status(401).json({ success: false, error: '未授权：访问口令无效或缺失 (Invalid or Missing Admin Token)' });
        }
    }
    next();
});

// 3. 严格校验 URL 路由参数 :id，防御路径穿越 (Path Traversal)
app.param('id', (req, res, next, id) => {
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ success: false, error: '非法参数格式 (Invalid ID format)' });
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ================= 多账户管理 API (切片 M2) =================

// 1. 获取所有超星账户档案列表
app.get('/api/accounts', (req, res) => {
    res.json({
        success: true,
        accounts: taskManager.accountManager.listAccounts()
    });
});

// 2. 创建新超星账户档案
app.post('/api/accounts', (req, res) => {
    try {
        const { name } = req.body;
        const account = taskManager.accountManager.createAccount(name);
        res.json({
            success: true,
            account,
            accounts: taskManager.accountManager.listAccounts()
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 3. 请求指定账户专属扫码登录二维码
app.post('/api/accounts/:id/qr-login', async (req, res) => {
    try {
        const qrBase64 = await taskManager.accountManager.requestQrLogin(req.params.id);
        res.json({ success: true, qrBase64 });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 4. 查询指定账户当前登录态与学生信息
app.get('/api/accounts/:id/status', async (req, res) => {
    try {
        const acc = taskManager.accountManager.getAccount(req.params.id);
        if (!acc) return res.status(404).json({ success: false, error: '未找到该账户' });
        res.json({ success: true, account: acc });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 5. 删除指定账户档案与会话
app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const success = await taskManager.accountManager.deleteAccount(req.params.id);
        res.json({
            success,
            accounts: taskManager.accountManager.listAccounts(),
            state: taskManager.getTasksState()
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// ================= 并发任务管理 API (升级支持绑定账户) =================

// 6. 获取全量任务列表与并发调度器状态 (含账户信息)
app.get('/api/tasks', (req, res) => {
    res.json(taskManager.getTasksState());
});

// 7. 新建单个课程挂机任务 (可指定 accountId)
app.post('/api/tasks', async (req, res) => {
    try {
        const { url, name, playbackRate, accountId } = req.body;
        const task = await taskManager.createTask(url, name, playbackRate, accountId);
        res.json({ success: true, task, state: taskManager.getTasksState() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 8. 批量创建课程挂机任务 (文本粘贴多行链接，可指定 accountId)
app.post('/api/tasks/batch', async (req, res) => {
    try {
        const { urls, playbackRate, accountId } = req.body;
        const tasks = await taskManager.createBatchTasks(urls, playbackRate, accountId);
        res.json({ success: true, count: tasks.length, tasks, state: taskManager.getTasksState() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 9. 启动/恢复指定任务
app.post('/api/tasks/:id/start', async (req, res) => {
    try {
        const task = await taskManager.startTask(req.params.id);
        res.json({ success: true, task, state: taskManager.getTasksState() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 10. 暂停指定任务
app.post('/api/tasks/:id/pause', async (req, res) => {
    try {
        const task = await taskManager.pauseTask(req.params.id);
        res.json({ success: true, task, state: taskManager.getTasksState() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 11. 删除指定任务
app.delete('/api/tasks/:id', async (req, res) => {
    try {
        await taskManager.deleteTask(req.params.id);
        res.json({ success: true, state: taskManager.getTasksState() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 12. 调整任务队列优先级
app.post('/api/tasks/:id/priority', async (req, res) => {
    try {
        const { action } = req.body;
        const tasks = await taskManager.setTaskPriority(req.params.id, action);
        res.json({ success: true, tasks, state: taskManager.getTasksState() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 13. 调整全局最大并发 Worker 数 (1 ~ 4)
app.post('/api/settings/concurrency', async (req, res) => {
    try {
        const { maxConcurrent } = req.body;
        const val = await taskManager.setMaxConcurrent(maxConcurrent);
        res.json({ success: true, maxConcurrent: val, state: taskManager.getTasksState() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 14. 一键启动全部任务
app.post('/api/tasks/start-all', async (req, res) => {
    await taskManager.startAll();
    res.json({ success: true, state: taskManager.getTasksState() });
});

// 15. 一键暂停全部任务
app.post('/api/tasks/stop-all', async (req, res) => {
    await taskManager.stopAll();
    res.json({ success: true, state: taskManager.getTasksState() });
});

// 16. 获取指定任务专属实时截图
app.get('/api/tasks/:id/screenshot', (req, res) => {
    const taskScreen = path.join(taskManager.userDataDir, `screen_${req.params.id}.png`);
    if (fs.existsSync(taskScreen)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Type', 'image/png');
        return res.sendFile(taskScreen);
    }
    const globalScreen = path.join(taskManager.userDataDir, 'screen.png');
    if (fs.existsSync(globalScreen)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Type', 'image/png');
        return res.sendFile(globalScreen);
    }
    res.status(404).send('暂无该任务截图');
});

// ================= 向后兼容与全局状态 API (Legacy Compatibility) =================

app.get('/api/state', (req, res) => {
    const tasksState = taskManager.getTasksState();
    const activeWorkers = Array.from(taskManager.workers.values()).filter(w => w.status === 'RUNNING');
    const primaryWorker = activeWorkers[0];
    const primaryTask = primaryWorker ? primaryWorker.task : (tasksState.tasks.find(t => t.status === 'RUNNING') || tasksState.tasks[0]);

    // 脱敏配置对象，屏蔽敏感 API Key 与 Token
    const safeConfig = { ...taskManager.config };
    if (safeConfig.qwenApiKey) {
        safeConfig.qwenApiKey = safeConfig.qwenApiKey.slice(0, 6) + '******' + safeConfig.qwenApiKey.slice(-4);
    }
    delete safeConfig.adminToken;

    const legacy = {
        status: tasksState.status,
        config: safeConfig,
        accounts: tasksState.accounts,
        currentInfo: {
            title: primaryTask ? primaryTask.name : '',
            unit: primaryTask ? (primaryTask.progress.unitTitle || '') : '',
            progress: primaryTask ? `${primaryTask.progress.percentage}% (${primaryTask.progress.currentTime}s/${primaryTask.progress.duration}s)` : '',
            playing: !!primaryWorker && primaryWorker.status === 'RUNNING',
            rate: primaryTask ? primaryTask.playbackRate : 1,
            url: primaryTask ? primaryTask.url : ''
        },
        qrBase64: taskManager.qrBase64,
        logs: tasksState.logs,
        tasksState,
        hasScreenshot: fs.existsSync(path.join(taskManager.userDataDir, 'screen.png')) || (primaryTask && fs.existsSync(path.join(taskManager.userDataDir, `screen_${primaryTask.id}.png`)))
    };
    res.json(legacy);
});

app.get('/api/screen.png', (req, res) => {
    const activeWorkers = Array.from(taskManager.workers.values()).filter(w => w.status === 'RUNNING');
    if (activeWorkers.length > 0) {
        const worker = activeWorkers[0];
        if (fs.existsSync(worker.screenshotPath)) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Content-Type', 'image/png');
            return res.sendFile(worker.screenshotPath);
        }
    }
    const globalScreen = path.join(taskManager.userDataDir, 'screen.png');
    if (fs.existsSync(globalScreen)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Type', 'image/png');
        return res.sendFile(globalScreen);
    }
    res.status(404).send('No screenshot yet');
});

app.get('/api/qrcode.png', (req, res) => {
    const qrPath = path.join(taskManager.userDataDir, 'qrcode.png');
    if (fs.existsSync(qrPath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(qrPath);
    } else {
        res.status(404).send('No QR code yet');
    }
});

// ================= AI 运维医生 API (切片 D1) =================

// 1. 获取最近一次体检报告与状态
app.get('/api/doctor/status', (req, res) => {
    res.json({
        success: true,
        enabled: taskManager.config.enableAiDoctor !== false,
        intervalMinutes: taskManager.config.aiDoctorIntervalMinutes || 2,
        model: taskManager.config.aiDoctorModel || 'qwen-plus',
        lastDiagnosis: taskManager.aiDoctor?.lastDiagnosis || null,
        lastActionTimestamp: taskManager.aiDoctor?.lastActionTimestamp || 0
    });
});

let lastManualDiagnoseTs = 0;
// 2. 手动立即触发一次 AI 全量健康体检 (带 30s 冷却限频防 DoS 与资费耗尽)
app.post('/api/doctor/diagnose', async (req, res) => {
    try {
        const now = Date.now();
        if (now - lastManualDiagnoseTs < 30000) {
            const waitSec = Math.ceil((30000 - (now - lastManualDiagnoseTs)) / 1000);
            return res.status(429).json({ success: false, error: `调用过于频繁，请等待 ${waitSec} 秒冷却后再试` });
        }
        if (!taskManager.aiDoctor) {
            return res.status(400).json({ success: false, error: 'AI Doctor 模块未初始化' });
        }
        lastManualDiagnoseTs = now;
        await taskManager.aiDoctor.diagnoseAndHeal();
        res.json({
            success: true,
            diagnosis: taskManager.aiDoctor.lastDiagnosis
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/start', async (req, res) => {
    const { courseUrl, playbackRate, accountId } = req.body;
    if (courseUrl) {
        const task = await taskManager.createTask(courseUrl, '', playbackRate || 1, accountId);
        res.json({ success: true, task, state: taskManager.getTasksState() });
    } else {
        await taskManager.startAll();
        res.json({ success: true, state: taskManager.getTasksState() });
    }
});

app.post('/api/stop', async (req, res) => {
    await taskManager.stopAll();
    res.json({ success: true, state: taskManager.getTasksState() });
});

app.post('/api/next', async (req, res) => {
    const activeWorkers = Array.from(taskManager.workers.values()).filter(w => w.status === 'RUNNING');
    if (activeWorkers.length > 0) {
        await activeWorkers[0].nextUnit();
    }
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    try {
        const qr = await taskManager.requestQrLogin();
        res.json({ success: true, qr });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 启动监听端口
const PORT = taskManager.config.port || 3888;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 学习通 多租户智能并发挂机服务已启动！`);
    console.log(`🌐 本地管理控制台: http://127.0.0.1:${PORT}`);
    console.log(`⚡ 最大并发 Worker 数: ${taskManager.maxConcurrent}`);
    console.log(`👤 已装载超星账户数: ${taskManager.accountManager.listAccounts().length}`);
    console.log(`=======================================================`);
});

// 自动唤醒持久化就绪队列
(async () => {
    try {
        const isLogged = await taskManager.checkLogin();
        if (isLogged) {
            console.log('检测到默认账号登录有效，正在自动激活任务池并发调度...');
            await taskManager.schedule();
        }
    } catch (e) {
        console.error('初始化异常:', e.message);
    }
})();
