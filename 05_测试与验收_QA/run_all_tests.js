/**
 * 全流程自动化回归测试执行流水线 (QA Test Runner)
 * 依据《全流程高可用工程开发与交付治理规范》(fullcycle-dev-practice)
 */

const runM1 = require('./cases/XXT_TEST_多账户会话物理隔离测试_v1.0.0');
const runM2 = require('./cases/XXT_TEST_任务调度与未登录挂起测试_v1.0.0');

async function main() {
    console.log('===========================================================');
    console.log('🧪 [XXT-QA] 学习通自动化挂机系统 - 全量自动化测试流水线启动');
    console.log('===========================================================\n');

    const startTime = Date.now();
    const results = [];

    // Case 1: 会话物理隔离
    try {
        const t0 = Date.now();
        await runM1();
        results.push({ name: 'CASE 01: 多账户会话物理隔离与 Cookie 隔离池', pass: true, duration: Date.now() - t0 });
    } catch (err) {
        results.push({ name: 'CASE 01: 多账户会话物理隔离与 Cookie 隔离池', pass: false, error: err.message });
    }

    // Case 2: 任务调度与安全挂起
    try {
        const t0 = Date.now();
        await runM2();
        results.push({ name: 'CASE 02: 任务生命周期与未登录任务拦截挂起', pass: true, duration: Date.now() - t0 });
    } catch (err) {
        results.push({ name: 'CASE 02: 任务生命周期与未登录任务拦截挂起', pass: false, error: err.message });
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n===========================================================');
    console.log(`📊 [XXT-QA] 测试执行汇总报告 (总耗时: ${totalDuration}s)`);
    console.log('===========================================================');

    let allPass = true;
    results.forEach((r, idx) => {
        if (r.pass) {
            console.log(`  [PASS] #${idx + 1} ${r.name} (${r.duration}ms)`);
        } else {
            allPass = false;
            console.log(`  [FAIL] #${idx + 1} ${r.name} - 异常: ${r.error}`);
        }
    });

    console.log('===========================================================');
    if (allPass) {
        console.log('🎉 结论：全部自动化测试用例 100% 通过！质量门禁放行。');
        process.exit(0);
    } else {
        console.error('❌ 结论：存在失败用例，请参照 QA 报错进行排查。');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('测试流水线发生严重未知异常:', err);
    process.exit(1);
});
