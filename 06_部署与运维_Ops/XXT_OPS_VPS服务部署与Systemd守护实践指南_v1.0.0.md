# XXT - VPS 服务部署与 Systemd 守护实践指南 (OPS-001)

> **文档标识**：`XXT_OPS_VPS服务部署与Systemd守护实践指南_v1.0.0.md`  
> **版本**：v1.0.0  
> **适用环境**：Ubuntu 20.04/22.04 LTS / Debian 11/12 Linux VPS  
> **状态**：Active (生产运维基准)  

---

## 1. 环境准备与前置依赖

### 1.1 Node.js 与 Chromium 运行库
在目标 VPS 上执行环境初始化：

```bash
# 1. 更新软件包索引
sudo apt-get update && sudo apt-get install -y curl git ufw

# 2. 安装 Node.js 18 LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. 安装 Playwright 底层依赖及中文字体库（防止无头渲染中文字体乱码）
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libasound2 libpangocairo-1.0-0 fonts-wqy-zenhei fonts-wqy-microhei
```

---

## 2. 工程部署结构

VPS 宿主机推荐部署路径：`/opt/xxt-vps` 或 `~/xxt-vps`。

```bash
# 部署源码至宿主机
mkdir -p /opt/xxt-vps
cd /opt/xxt-vps
# 同步 01_源码工程_Source 内的代码文件
npm install express playwright qrcode-terminal
```

---

## 3. Systemd 守护进程单元配置

通过 `systemd` 将自动化服务注册为系统级后台守护进程，支持开机自启、崩溃瞬时自愈重启。

创建服务单元文件 `/etc/systemd/system/xxt-service.service`：

```ini
[Unit]
Description=XueXiTong Headless Automation Service (XXT)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/xxt-vps
ExecStart=/usr/bin/node /opt/xxt-vps/web.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3888

# 资源与内存保护（防止浏览器长时间运行内存泄漏引发 OOM）
MemoryMax=1.5G
MemoryHigh=1.2G

[Install]
WantedBy=multi-user.target
```

### 3.1 守护进程运维常用命令
```bash
# 重载系统单元配置
sudo systemctl daemon-reload

# 启动服务并设置开机自启
sudo systemctl start xxt-service
sudo systemctl enable xxt-service

# 查看服务状态
sudo systemctl status xxt-service

# 实时查看输出日志
sudo journalctl -u xxt-service -f -n 100

# 重启或停止服务
sudo systemctl restart xxt-service
sudo systemctl stop xxt-service
```

---

## 4. 网络安全与端口安全防护

1. **禁止明文公网暴露**：
   建议通过 SSH 端口隧道将远端 3888 映射至本地：
   ```bash
   # 在本地电脑终端运行端口转发
   ssh -L 3888:127.0.0.1:3888 user@vps-ip
   ```
   然后本地浏览器直接访问 `http://127.0.0.1:3888` 即可安全管理，无需对外开放公网端口。
2. **UFW 防火墙配置**（如确需外网访问，请加设安全组白名单）：
   ```bash
   sudo ufw allow 22/tcp
   sudo ufw allow from <YOUR_HOME_IP> to any port 3888 proto tcp
   sudo ufw enable
   ```
