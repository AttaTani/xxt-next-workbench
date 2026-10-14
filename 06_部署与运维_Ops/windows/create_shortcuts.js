const path = require('path');
const { execSync } = require('child_process');

const desktop = path.join(process.env.USERPROFILE, 'Desktop');
const scriptDir = path.resolve(__dirname);
const projectRoot = path.resolve(scriptDir, '..', '..');

function runPowerShell(psCommand) {
    const b64 = Buffer.from(psCommand, 'utf16le').toString('base64');
    execSync(`powershell.exe -NoProfile -EncodedCommand ${b64}`);
}

const targetSilent = path.join(scriptDir, 'start_silent.vbs');
const targetStop = path.join(scriptDir, 'stop_service.bat');
const targetDashboard = path.join(scriptDir, 'open_dashboard.bat');

const script = `
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")

$s1 = $ws.CreateShortcut("$desktop\\一键启动挂机.lnk")
$s1.TargetPath = "${targetSilent}"
$s1.WorkingDirectory = "${projectRoot}"
$s1.Description = "学习通后台静默挂机"
$s1.Save()

$s2 = $ws.CreateShortcut("$desktop\\一键停止挂机.lnk")
$s2.TargetPath = "${targetStop}"
$s2.WorkingDirectory = "${projectRoot}"
$s2.Description = "停止学习通挂机"
$s2.Save()

$s3 = $ws.CreateShortcut("$desktop\\学习通控制面板.lnk")
$s3.TargetPath = "${targetDashboard}"
$s3.WorkingDirectory = "${projectRoot}"
$s3.Description = "学习通控制面板"
$s3.Save()

Write-Output "OK"
`;

runPowerShell(script);
console.log('Shortcuts successfully created/updated on Desktop pointing to: ' + scriptDir);
