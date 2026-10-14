const taskManager = require('./taskManager');
const assert = require('assert');

async function runM4E2ETest() {
    console.log('================================================================');
    console.log('🚀 [切片 M4] 多账户并发挂机端到端集成与物理隔离回归验收');
    console.log('================================================================\n');

    const accMgr = taskManager.accountManager;

    // -------------------------------------------------------------
    // 测试场景 1: 多账户档案与独立上下文实例化
    // -------------------------------------------------------------
    console.log('【测试用例 1】TC-M4-01: 多租户独立上下文实例与持久化');
    const acc1 = accMgr.getAccount('acc_default');
    assert(acc1, '主账户 acc_default 必须存在');
    console.log(`- 主账户档案: [${acc1.name}] (id: ${acc1.id}, 状态: ${acc1.status})`);

    const acc2 = accMgr.createAccount('E2E验收测试号_李四');
    console.log(`- 租户2档案创建: [${acc2.name}] (id: ${acc2.id}, 状态: ${acc2.status})`);
    assert(acc2.id && acc2.name === 'E2E验收测试号_李四', '租户2档案创建校验失败');

    const ctx1 = await accMgr.getOrCreateContext(acc1.id);
    const ctx2 = await accMgr.getOrCreateContext(acc2.id);
    assert(ctx1 !== ctx2, '两个账户必须拥有独立的 BrowserContext 实例！');
    console.log('✅【TC-M4-01 通过】成功为不同超星账户分配互相独立的 Playwright Context！\n');

    // -------------------------------------------------------------
    // 测试场景 2: 物理级 Cookie 绝对防串扰审计 (Canary Cookie Injection)
    // -------------------------------------------------------------
    console.log('【测试用例 2】TC-M4-02: 物理级 Cookie 绝对防串扰审计 (Canary 探针注入测试)');
    const cookies1Before = await ctx1.cookies();
    const cookies2Before = await ctx2.cookies();
    console.log(`- 初始状态: Context 1 拥有 ${cookies1Before.length} 个 Cookies, Context 2 拥有 ${cookies2Before.length} 个 Cookies`);

    // 向 Context 2 注入私有金丝雀 Cookie
    const canary2 = {
        name: 'USER2_EXCLUSIVE_TOKEN',
        value: 'SECRET_TENANT_2_XYZ',
        domain: '.chaoxing.com',
        path: '/'
    };
    await ctx2.addCookies([canary2]);

    // 向 Context 1 注入私有金丝雀 Cookie
    const canary1 = {
        name: 'USER1_EXCLUSIVE_TOKEN',
        value: 'SECRET_TENANT_1_ABC',
        domain: '.chaoxing.com',
        path: '/'
    };
    await ctx1.addCookies([canary1]);

    const cookies1After = await ctx1.cookies();
    const cookies2After = await ctx2.cookies();

    const c1HasCanary2 = cookies1After.some(c => c.name === 'USER2_EXCLUSIVE_TOKEN');
    const c2HasCanary1 = cookies2After.some(c => c.name === 'USER1_EXCLUSIVE_TOKEN');
    const c1HasCanary1 = cookies1After.some(c => c.name === 'USER1_EXCLUSIVE_TOKEN');
    const c2HasCanary2 = cookies2After.some(c => c.name === 'USER2_EXCLUSIVE_TOKEN');

    assert(c1HasCanary1 && c2HasCanary2, '各账户内部 Cookie 注入失败');
    assert(!c1HasCanary2, '重大安全漏洞: 账户2的 Cookie 泄露到了账户1的上下文中！');
    assert(!c2HasCanary1, '重大安全漏洞: 账户1的 Cookie 泄露到了账户2的上下文中！');

    console.log(`- 账户1 Cookies 验真: 仅包含 USER1 独占凭证 (未见 USER2 凭证)`);
    console.log(`- 账户2 Cookies 验真: 仅包含 USER2 独占凭证 (未见 USER1 凭证)`);
    console.log('✅【TC-M4-02 通过】零会话污染！跨租户 Cookie 具有 100% 物理隔离屏障！\n');

    // -------------------------------------------------------------
    // 测试场景 3: 任务-账户关联与多租户调度器聚合
    // -------------------------------------------------------------
    console.log('【测试用例 3】TC-M4-03: 任务-账户关联与多租户状态机聚合');
    const testTask1 = await taskManager.createTask('https://mooc1-2.chaoxing.com/course_user1', '史记·高祖本纪', 1.0, acc1.id);
    const testTask2 = await taskManager.createTask('https://mooc1-2.chaoxing.com/course_user2', '马克思主义政治经济学', 1.25, acc2.id);

    assert.strictEqual(testTask1.accountId, acc1.id, 'Task 1 accountId 绑定不正确');
    assert.strictEqual(testTask2.accountId, acc2.id, 'Task 2 accountId 绑定不正确');

    const state = taskManager.getTasksState();
    const enrolledT1 = state.tasks.find(t => t.id === testTask1.id);
    const enrolledT2 = state.tasks.find(t => t.id === testTask2.id);

    console.log(`- Task 1:「${enrolledT1.name}」-> 所属账户:「${enrolledT1.accountName}」(状态: ${enrolledT1.accountStatus})`);
    console.log(`- Task 2:「${enrolledT2.name}」-> 所属账户:「${enrolledT2.accountName}」(状态: ${enrolledT2.accountStatus})`);
    assert.strictEqual(enrolledT1.accountName, acc1.name);
    assert.strictEqual(enrolledT2.accountName, acc2.name);
    console.log('✅【TC-M4-03 通过】任务创建与多租户名称/状态绑定无缝正确！\n');

    // -------------------------------------------------------------
    // 测试场景 4: 故障域物理隔离 (Fault Domain Isolation)
    // -------------------------------------------------------------
    console.log('【测试用例 4】TC-M4-04: 故障域与未登录账号安全拦截测试');
    console.log('- 尝试触发未登录账户 (李四) 任务的调度启动...');
    const postStartT2 = await taskManager.startTask(testTask2.id);

    console.log(`- 拦截结果: 任务状态=${postStartT2.status}, 原因=${postStartT2.errorMessage}`);
    assert.strictEqual(postStartT2.status, 'PAUSED', '未登录账户任务必须被安全挂起！');
    assert(postStartT2.errorMessage.includes('未登录'), '未登录提示信息不明确');

    console.log('- 验证主账号 (默认主账号) 的任务启动是否被波及...');
    const postStartT1 = await taskManager.startTask(testTask1.id);
    console.log(`- 主账号任务状态: ${postStartT1.status}`);
    assert(postStartT1.status === 'QUEUED' || postStartT1.status === 'RUNNING', '主账号任务应正常进入调度！');
    console.log('✅【TC-M4-04 通过】单租户未登录/异常被严格局限在自身范围内，对其他租户零干扰！\n');

    // -------------------------------------------------------------
    // 测试场景 5: 多路并发槽位动态扩展测试
    // -------------------------------------------------------------
    console.log('【测试用例 5】TC-M4-05: 全局并发数动态调节与调度状态');
    await taskManager.setMaxConcurrent(2);
    console.log(`- 全局并发 Worker 数已扩展至: ${taskManager.maxConcurrent} 路`);
    assert.strictEqual(taskManager.maxConcurrent, 2, '并发数调整失败');

    await taskManager.setMaxConcurrent(1);
    console.log(`- 恢复默认安全并发数: ${taskManager.maxConcurrent} 路`);
    assert.strictEqual(taskManager.maxConcurrent, 1, '并发数恢复失败');
    console.log('✅【TC-M4-05 通过】多路并发配置动态生效，调度状态同步刷新！\n');

    // -------------------------------------------------------------
    // 清理测试临时数据
    // -------------------------------------------------------------
    console.log('【数据清理】正在清理回归测试临时任务与测试账户...');
    await taskManager.deleteTask(testTask1.id);
    await taskManager.deleteTask(testTask2.id);
    await accMgr.deleteAccount(acc2.id);
    console.log('- 测试任务与租户档案已清理');

    console.log('\n================================================================');
    console.log('🎉🎉🎉 [切片 M4] 端到端回归验收 5 项用例全部 100% 通过！');
    console.log('================================================================');
    process.exit(0);
}

runM4E2ETest().catch(err => {
    console.error('\n❌ [切片 M4 验收失败]:', err.message);
    console.error(err.stack);
    process.exit(1);
});
