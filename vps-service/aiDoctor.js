const EventEmitter = require('events');

class AiDoctor extends EventEmitter {
    constructor(taskManager) {
        super();
        this.taskManager = taskManager;
        this.timer = null;
        this.isChecking = false;
        this.lastActionTimestamp = 0;
        this.lastDiagnosis = null;
        this.historySnapshots = []; // 保存最近几次任务进度快照，用于对比是否卡滞
    }

    start() {
        if (this.timer) clearInterval(this.timer);
        const intervalMs = (this.taskManager.config.aiDoctorIntervalMinutes || 2) * 60 * 1000;
        this.log(`AI 运维医生 (AI-Doctor) 已启动！巡检周期: ${Math.round(intervalMs / 1000 / 60)} 分钟，诊断模型: ${this.taskManager.config.aiDoctorModel || 'qwen-plus'}`);

        // 启动后 30 秒进行首次快速体检，随后按间隔周期巡检
        setTimeout(() => this.diagnoseAndHeal(), 30000);
        this.timer = setInterval(() => this.diagnoseAndHeal(), intervalMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.log('AI 运维医生已暂停巡检。');
    }

    log(msg, type = 'info') {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const entry = {
            taskId: null,
            taskName: '🤖 AI-Doctor',
            time,
            msg,
            type
        };
        this.taskManager.logs.push(entry);
        if (this.taskManager.logs.length > this.taskManager.maxLogs) this.taskManager.logs.shift();
        console.log(`[${time}] [AI-DOCTOR] ${msg}`);
        this.taskManager.emit('log', entry);
    }

    async diagnoseAndHeal() {
        if (this.isChecking) return;
        if (this.taskManager.config.enableAiDoctor === false) return;

        this.isChecking = true;
        try {
            const activeTasks = this.taskManager.tasks.filter(t => t.status === 'RUNNING');
            if (activeTasks.length === 0) {
                // 没有运行中的任务，无需频繁调用大模型消耗 Token
                return;
            }

            // 【关键保护拦截】若有任何任务正在答题或正在解决章节测验，绝对不打扰
            const hasActiveQuiz = activeTasks.some(t => {
                const worker = this.taskManager.workers.get(t.id);
                return worker && (worker.isSolvingQuiz || worker.isSolvingExam);
            });
            if (hasActiveQuiz) {
                this.log('当前任务正在进行随堂测验/章节作业智能答题，AI 运维医生保持静默观察...');
                return;
            }

            // 1. 采集当前系统切片快照
            const recentLogs = this.taskManager.logs.slice(-25).map(l => `[${l.time}] [${l.type}] ${l.taskName ? `(${l.taskName}) ` : ''}${l.msg}`);
            const taskSnapshots = activeTasks.map(t => ({
                id: t.id,
                name: t.name,
                status: t.status,
                progress: t.progress,
                updatedAt: new Date(t.updatedAt).toLocaleTimeString()
            }));

            // 记录历史快照用于卡滞判定
            this.historySnapshots.push({
                time: Date.now(),
                tasks: JSON.parse(JSON.stringify(taskSnapshots))
            });
            if (this.historySnapshots.length > 5) this.historySnapshots.shift();

            // 2. 构造诊断提示词
            const prompt = 
                `你是一位超星学习通全自动挂机系统的首席 AIOps 智能运维医生。\n` +
                `请分析下列系统的最新运行状态和日志切片，判定系统健康度，并给出自愈动作指导。\n\n` +
                `【当前活跃任务列表】：\n${JSON.stringify(taskSnapshots, null, 2)}\n\n` +
                `【最近 25 条实时系统日志】：\n${recentLogs.join('\n')}\n\n` +
                `【已知隐蔽异常模式与处置准则】：\n` +
                `1. 正常运行 (HEALTHY)：视频时间正常累加，无死循环，或者正在稳步播放、或正在进行测验答题。推荐动作: NO_OP。\n` +
                `2. 假死/卡滞 (STUCK)：视频进度停滞超过 5 分钟没有任何递增，且完全没有答题日志。推荐动作: RESTART_TASK。\n` +
                `3. 寻路死循环 (NAV_LOOP)：日志中反复打印同一小节的“智能寻路定位点击”超过 3 次，未能进入视频播放。推荐动作: FORCE_NEXT。\n` +
                `4. 风控异常 (RISK_SUSPEND)：出现 9010、antispider、Verify 等风控拦截特征。推荐动作: SAFE_PAUSE。\n\n` +
                `【核心防误判规则（必读）】：\n` +
                `* 随堂测验/章节作业时，视频会暂停等待答题，这是 100% 正常现象，绝非假死！推荐动作必须是 NO_OP！\n` +
                `* 超星前端日志如 'XTemplate Error'、'JQMIGRATE'、'Deprecated as of 10.6.0' 属于网页自带无害提示，绝对不是脚本异常，严禁因这些日志判定为 STUCK！\n\n` +
                `【严格输出 JSON 规范】：\n` +
                `必须输出且只能输出一个合法 JSON 对象（严禁包含任何前缀、解释、markdown 标记）：\n` +
                `{\n` +
                `  "health_score": 95,\n` +
                `  "system_state": "HEALTHY",\n` +
                `  "summary": "简明诊断结论（30字以内）",\n` +
                `  "anomaly_detected": null,\n` +
                `  "recommended_action": "NO_OP",\n` +
                `  "target_task_id": "${activeTasks[0]?.id || ''}"\n` +
                `}\n` +
                `可选 recommended_action 取值: "NO_OP" | "RESTART_TASK" | "FORCE_NEXT" | "SAFE_PAUSE"`;

            const apiKey = this.taskManager.config.qwenApiKey || process.env.DASHSCOPE_API_KEY;
            const baseUrl = this.taskManager.config.qwenBaseUrl || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
            const model = this.taskManager.config.aiDoctorModel || 'qwen-plus';

            if (!apiKey) {
                this.log('未配置 Qwen API Key，AI 运维巡检跳过。', 'warn');
                return;
            }

            const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1
                })
            });

            if (!res.ok) {
                throw new Error(`AI API HTTP ${res.status}`);
            }

            const data = await res.json();
            const rawContent = data.choices?.[0]?.message?.content?.trim() || '{}';
            
            // 提取纯 JSON 内容
            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('未解析到合法诊断 JSON');
            }

            const diagnosis = JSON.parse(jsonMatch[0]);
            this.lastDiagnosis = diagnosis;

            // 3. 根据健康诊断结果执行自愈动作
            if (diagnosis.system_state === 'HEALTHY' || diagnosis.recommended_action === 'NO_OP') {
                this.log(`巡检体检合格 [健康度: ${diagnosis.health_score}/100]: 「${diagnosis.summary}」`);
            } else {
                this.log(`⚠️ 巡检发现异常 [${diagnosis.system_state} | 评分: ${diagnosis.health_score}]: 「${diagnosis.summary}」`, 'warn');
                await this.executeSelfHealing(diagnosis);
            }

        } catch (err) {
            this.log(`AI 运维医生诊断巡检出现偶发异常: ${err.message}`, 'warn');
        } finally {
            this.isChecking = false;
        }
    }

    async executeSelfHealing(diagnosis) {
        const now = Date.now();
        // 防震荡限频保护：3 分钟内最多执行一次自愈动作
        if (now - this.lastActionTimestamp < 180000) {
            this.log(`【自愈限频阻断】距离上次自愈动作不足 3 分钟，暂不重复触发以防系统震荡。`, 'warn');
            return;
        }

        const taskId = diagnosis.target_task_id;
        const action = diagnosis.recommended_action;
        this.log(`🚨【AI-Doctor 触发自主自愈】动作: [${action}]，目标任务: [${taskId}]，原因: ${diagnosis.summary}`, 'error');

        try {
            switch (action) {
                case 'RESTART_TASK': {
                    const worker = this.taskManager.workers.get(taskId);
                    if (worker && (worker.isSolvingQuiz || worker.isSolvingExam)) {
                        this.log(`【自愈保护拦截】任务 ${taskId} 正在执行答题推理或提交，取消重启以防破坏答题。`, 'warn');
                        return;
                    }

                    // 门禁 1: 严格对比历史快照，检查视频时间是否真的静止
                    if (this.historySnapshots.length >= 2) {
                        const oldest = this.historySnapshots[0]?.tasks?.find(t => t.id === taskId);
                        const newest = this.historySnapshots[this.historySnapshots.length - 1]?.tasks?.find(t => t.id === taskId);
                        if (oldest && newest && oldest.progress && newest.progress) {
                            const oldCur = oldest.progress.currentTime || 0;
                            const newCur = newest.progress.currentTime || 0;
                            // 若进度有推进，绝对健康
                            if (newCur > oldCur) {
                                this.log(`【自愈保护拦截】任务 ${taskId} 进度仍在推进 (${oldCur}s -> ${newCur}s)，判定健康，驳回杀进程请求。`, 'info');
                                return;
                            }
                        }
                    }

                    // 门禁 2: 检查最近活跃时间，5 分钟内有正常更新绝不杀进程
                    const targetTask = this.taskManager.tasks.find(t => t.id === taskId);
                    if (targetTask && (now - targetTask.updatedAt < 300000)) {
                        this.log(`【自愈保护拦截】任务 ${taskId} 在 5 分钟内有正常更新 (${Math.round((now - targetTask.updatedAt)/1000)}秒前)，驳回杀进程请求。`, 'info');
                        return;
                    }

                    this.lastActionTimestamp = now;
                    this.log(`【自愈执行】经严密多维数据比对确认真正假死，正在平稳重启: ${taskId}...`);
                    await this.taskManager.pauseTask(taskId);
                    await new Promise(r => setTimeout(r, 4000));
                    await this.taskManager.startTask(taskId);
                    this.log(`【自愈执行完成】任务 ${taskId} 已完成重启并重新调度！`);
                    break;
                }
                case 'FORCE_NEXT': {
                    this.lastActionTimestamp = now;
                    this.log(`【自愈执行】正在为任务 ${taskId} 强制跳过当前故障小节...`);
                    const worker = this.taskManager.workers.get(taskId);
                    if (worker) {
                        await worker.nextUnit();
                    }
                    this.log(`【自愈执行完成】已向任务发出强制跳小节指令！`);
                    break;
                }
                case 'SAFE_PAUSE': {
                    this.lastActionTimestamp = now;
                    this.log(`【安全挂起】疑似风控阻击，主动暂停任务以防风控惩罚: ${taskId}...`);
                    await this.taskManager.pauseTask(taskId);
                    this.log(`【安全挂起完成】任务已进入主动安全保护态，避免被系统封号。`);
                    break;
                }
                default:
                    this.log(`未识别的自愈动作: ${action}，已记录忽略。`, 'warn');
            }
        } catch (e) {
            this.log(`执行自愈动作出错: ${e.message}`, 'error');
        }
    }
}

module.exports = AiDoctor;
