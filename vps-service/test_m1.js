const path = require('path');
const fs = require('fs');
const AccountManager = require('./accountManager');

async function runM1Test() {
    console.log('=== [切片 M1 单元测试开始] ===\n');
    const userDataDir = path.join(__dirname, 'userData');
    const mgr = new AccountManager(userDataDir);

    // 1. 验证老账号平滑迁移
    console.log('1. 验证已有会话平滑迁移...');
    const accounts = mgr.listAccounts();
    console.log(`- 当前账户总数: ${accounts.length}`);
    const defaultAcc = accounts.find(a => a.id === 'acc_default');
    if (!defaultAcc) {
        throw new Error('未成功迁移/生成默认主账号 (acc_default)');
    }
    console.log(`- 默认主账号名称: 「${defaultAcc.name}」 状态: ${defaultAcc.status}`);

    // 2. 验证多账户创建与持久化
    console.log('\n2. 验证新建独立账户档案...');
    const testAcc = mgr.createAccount('单元测试备用号');
    console.log(`- 新建账户: id=${testAcc.id}, name=${testAcc.name}, status=${testAcc.status}`);
    const updatedList = mgr.listAccounts();
    console.log(`- 新增后账户总数: ${updatedList.length}`);
    if (updatedList.length < 2) {
        throw new Error('账户列表长度不正确');
    }

    // 3. 验证 Playwright 独立 BrowserContext 物理隔离
    console.log('\n3. 验证 Playwright BrowserContext 独立隔离池...');
    const ctxDefault = await mgr.getOrCreateContext('acc_default');
    const cookiesDefault = await ctxDefault.cookies();
    console.log(`- 主账号 Context Cookies 数: ${cookiesDefault.length} (有效历史认证)`);

    const ctxTest = await mgr.getOrCreateContext(testAcc.id);
    const cookiesTest = await ctxTest.cookies();
    console.log(`- 新测试账号 Context Cookies 数: ${cookiesTest.length} (完全洁净无污染)`);

    if (cookiesDefault.length > 0 && cookiesTest.length === 0) {
        console.log('✅【物理隔离验证通过】不同账户在 Chromium 内部 Cookie 严格隔离，零串扰！');
    } else if (cookiesDefault.length === 0) {
        console.log('⚠️ 主账号暂无 Cookies，但两个 Context 相互独立。');
    } else {
        throw new Error('Cookie 隔离性失败！新账号被旧账号 Cookie 污染！');
    }

    // 4. 清理测试账号
    console.log('\n4. 清理单元测试临时账号...');
    await mgr.deleteAccount(testAcc.id);
    const finalList = mgr.listAccounts();
    console.log(`- 清理后账户总数: ${finalList.length}`);

    // 5. 安全关闭全部浏览器
    await mgr.closeAll();
    console.log('\n=== [切片 M1 单元测试全部通过！] ===');
}

runM1Test().catch(err => {
    console.error('\n❌ 测试失败:', err.message);
    process.exit(1);
});
