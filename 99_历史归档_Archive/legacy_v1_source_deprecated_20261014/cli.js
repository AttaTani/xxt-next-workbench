const engine = require('./engine');
const qrcodeTerminal = require('qrcode-terminal');

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
    switch (command) {
        case 'login':
            console.log('正在请求学习通二维码登录...');
            engine.on('qr', (base64) => {
                console.log('\n[提示] 二维码图片已保存至: vps-service/userData/qrcode.png');
                console.log('您也可以在手机浏览器打开: http://66.42.43.239:3888 进行扫码！\n');
            });
            engine.on('login_success', () => {
                console.log('\n✅ 登录成功！认证信息已持久化。');
                process.exit(0);
            });
            await engine.requestQrLogin();
            break;

        case 'start':
            const url = args[1];
            if (!url && !engine.config.courseUrl) {
                console.error('请提供课程 URL，例如: node cli.js start "https://mooc1.chaoxing.com/mycourse/..."');
                process.exit(1);
            }
            await engine.start(url);
            console.log('挂机服务已启动，按 Ctrl+C 退出控制台（后台仍可在 Web 面板查看）。');
            break;

        case 'status':
            await engine.checkLogin();
            console.log('当前状态:', engine.getState());
            process.exit(0);
            break;

        case 'web':
        case 'server':
            require('./web');
            break;

        default:
            console.log(`
学习通 VPS 挂机服务命令行工具使用方法:
  node vps-service/cli.js web             # 启动 Web 控制面板与挂机服务 (端口 3888)
  node vps-service/cli.js login           # 扫码登录并保存凭据
  node vps-service/cli.js start <URL>     # 直接从命令行启动指定课程挂机
  node vps-service/cli.js status          # 检查当前登录与运行状态
`);
            process.exit(0);
    }
}

main().catch(err => {
    console.error('执行出错:', err);
    process.exit(1);
});
