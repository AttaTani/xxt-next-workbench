const taskManager = require('./taskManager');

async function runM2Test() {
    console.log('=== [切片 M2 单元与 API 状态测试开始] ===\n');

    // 1. 验证 getTasksState 包含多账户数据结构
    console.log('1. 验证调度器状态中包含多账户信息...');
    const state = taskManager.getTasksState();
    console.log(`- 账户列表总数: ${state.accounts.length}`);
    const defaultAcc = state.accounts.find(a => a.id === 'acc_default');
    if (!defaultAcc) throw new Error('未能从 state.accounts 找到 acc_default');
    console.log(`- 主账户信息: [${defaultAcc.name}] 状态: ${defaultAcc.status}`);

    // 2. 验证创建绑定特定账户的任务
    console.log('\n2. 验证创建任务并绑定到主账户 (acc_default)...');
    const task1 = await taskManager.createTask('https://mooc1-2.chaoxing.com/test1', '史记测试任务', 1.25, 'acc_default');
    console.log(`- 任务创建成功: id=${task1.id}, accountId=${task1.accountId}`);
    if (task1.accountId !== 'acc_default') throw new Error('任务 accountId 绑定不正确');

    // 3. 验证创建第二独立账户并绑定任务
    console.log('\n3. 创建第二账户并创建从属任务...');
    const acc2 = taskManager.accountManager.createAccount('李四 (代课)');
    console.log(`- 第二账户创建成功: id=${acc2.id}, name=${acc2.name}`);

    const task2 = await taskManager.createTask('https://mooc1-2.chaoxing.com/test2', '毛概测试任务', 1.0, acc2.id);
    console.log(`- 第二任务创建成功: id=${task2.id}, accountId=${task2.accountId}`);
    if (task2.accountId !== acc2.id) throw new Error('任务2 accountId 绑定不正确');

    // 4. 验证 getTasksState 聚合渲染
    console.log('\n4. 验证调度器多租户数据聚合...');
    const updatedState = taskManager.getTasksState();
    const foundT1 = updatedState.tasks.find(t => t.id === task1.id);
    const foundT2 = updatedState.tasks.find(t => t.id === task2.id);

    console.log(`- 任务1 聚合信息: 课程「${foundT1.name}」 -> 所属账号: 「${foundT1.accountName}」`);
    console.log(`- 任务2 聚合信息: 课程「${foundT2.name}」 -> 所属账号: 「${foundT2.accountName}」`);

    if (foundT1.accountName !== '默认主账号' || foundT2.accountName !== '李四 (代课)') {
        throw new Error('多租户任务聚合显示名称不匹配');
    }

    // 5. 验证未登录账户的任务启动保护机制
    console.log('\n5. 验证未登录账户任务启动时安全挂起拦截...');
    await taskManager.startTask(task2.id);
    const postStartState = taskManager.getTasksState();
    const postStartT2 = postStartState.tasks.find(t => t.id === task2.id);
    console.log(`- 未登录账号任务状态: ${postStartT2.status} (原因: ${postStartT2.errorMessage})`);
    if (postStartT2.status !== 'PAUSED') {
        throw new Error('未登录账户的任务未被正确拦截挂起');
    }
    console.log('✅【安全拦截验证通过】未登录账户任务被安全挂起，未发生异常崩溃或冒用会话！');

    // 6. 清理测试数据
    console.log('\n6. 清理测试任务与账户...');
    await taskManager.deleteTask(task1.id);
    await taskManager.deleteTask(task2.id);
    await taskManager.accountManager.deleteAccount(acc2.id);

    console.log('\n=== [切片 M2 单元与 API 状态测试全部通过！] ===');
    process.exit(0);
}

runM2Test().catch(err => {
    console.error('\n❌ 测试失败:', err.message);
    process.exit(1);
});
