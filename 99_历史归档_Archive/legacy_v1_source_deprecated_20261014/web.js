const express = require('express');
const path = require('path');
const fs = require('fs');
const engine = require('./engine');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
    res.json(engine.getState());
});

app.get('/api/debug_eval', async (req, res) => {
    try {
        const page = engine.page;
        for (const f of page.frames()) {
            if (f.url().includes('modules/video')) {
                const info = await f.evaluate(async () => {
                    const v = document.querySelector('video');
                    let playErr = null;
                    let vjsKeys = [];
                    if (window.videojs) {
                        vjsKeys = Object.keys(window.videojs.players || {});
                    }
                    try {
                        v.muted = true;
                        const p = v.play();
                        if (p && p.catch) {
                            await p;
                        }
                    } catch (e) {
                        playErr = e.name + ': ' + e.message;
                    }
                    return {
                        url: location.href,
                        hasVideo: !!v,
                        paused: v ? v.paused : null,
                        currentTime: v ? v.currentTime : null,
                        duration: v ? v.duration : null,
                        playErr,
                        vjsKeys,
                        windowPlayer: !!window.player
                    };
                });
                return res.json({ frameUrl: f.url(), info });
            }
        }
        res.json({ error: 'Video frame not found' });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/api/debug', async (req, res) => {
    try {
        const page = engine.page;
        if (!page) return res.json({ error: 'No page' });
        const frames = page.frames();
        const frameInfo = [];
        for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            let data = null;
            try {
                data = await f.evaluate(() => {
                    const v = document.querySelector('video');
                    const playElements = Array.from(document.querySelectorAll('.vjs-big-play-button, .playBtn, button, div')).filter(el => {
                        const cl = el.className || '';
                        return typeof cl === 'string' && (cl.includes('vjs-big-play-button') || cl.includes('playBtn') || cl.includes('ans-attach-ct'));
                    }).map(el => ({ tag: el.tagName, class: el.className }));
                    return {
                        hasVideo: !!v,
                        videoInfo: v ? { src: v.src, paused: v.paused, current: v.currentTime, duration: v.duration } : null,
                        playElements: playElements.slice(0, 5),
                        bodyTextSnippet: (document.body ? document.body.innerText : '').slice(0, 100)
                    };
                });
            } catch (err) {
                data = { error: err.message };
            }
            frameInfo.push({ index: i, url: f.url(), name: f.name(), data });
        }
        res.json({ pageUrl: page.url(), frameCount: frames.length, frameInfo });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.all('/api/captcha', async (req, res) => {
    const code = (req.body && req.body.code) || req.query.code;
    if (!code) {
        return res.status(400).json({ success: false, error: '缺少验证码参数 code' });
    }
    try {
        const page = engine.page;
        const frames = page ? page.frames() : [];
        const targets = [
            ...frames.filter(f => f.url().includes('antispider') || f.url().includes('Verify')),
            page,
            ...frames
        ];

        let submitted = false;
        let submitUrl = '';

        for (const target of targets) {
            if (!target) continue;
            try {
                const inputs = await target.$$('input[placeholder*="验证码"], #code, #checkCode, .input-code, input[type="text"]');
                for (const input of inputs) {
                    if (await input.isVisible().catch(() => false)) {
                        await input.fill(code);
                        const submitBtn = await target.$('button, input[type="submit"], .btn, input[value="提交"], #submitBtn');
                        if (submitBtn) {
                            await submitBtn.click();
                            submitted = true;
                            submitUrl = target.url();
                            break;
                        }
                    }
                }
                if (submitted) break;
            } catch (err) {}
        }

        if (submitted) {
            await page.waitForTimeout(3000);
            engine.log(`已成功在 [${submitUrl}] 提交验证码: ${code}`);
            res.json({ success: true, submittedIn: submitUrl, pageUrl: page.url() });
        } else {
            res.json({ success: false, error: '在主页面及所有嵌套 Frame 中均未找到可见的验证码输入框' });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/screenshot', (req, res) => {
    const screenshotPath = engine.screenshotPath;
    if (fs.existsSync(screenshotPath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(screenshotPath);
    } else {
        res.status(404).send('No screenshot yet');
    }
});

app.post('/api/start', async (req, res) => {
    const { courseUrl, playbackRate } = req.body;
    if (playbackRate) {
        await engine.setPlaybackRate(playbackRate);
    }
    const success = await engine.start(courseUrl);
    res.json({ success, state: engine.getState() });
});

app.post('/api/stop', async (req, res) => {
    await engine.stop();
    res.json({ success: true, state: engine.getState() });
});

app.post('/api/next', async (req, res) => {
    await engine.nextUnit();
    res.json({ success: true });
});

app.post('/api/speed', async (req, res) => {
    const { rate } = req.body;
    if (rate) await engine.setPlaybackRate(rate);
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    try {
        const qr = await engine.requestQrLogin();
        res.json({ success: true, qr });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

const PORT = engine.config.port || 3888;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 学习通 本地智能挂机控制台已在后台启动！`);
    console.log(`🌐 本地访问地址: http://127.0.0.1:${PORT}`);
    console.log(`=======================================================`);
});

(async () => {
    try {
        const isLogged = await engine.checkLogin();
        if (isLogged && engine.config.courseUrl) {
            console.log(`检测到已存课程，正在自动恢复挂机任务: ${engine.config.courseUrl}`);
            await engine.start();
        }
    } catch (e) {
        console.error('初始化异常:', e.message);
    }
})();
