const fs = require('fs');
const path = require('path');

/**
 * IncidentDumper: 故障现场无损快照捕获器
 * 当作业、测验或播放器提取出现空结果或异常时，自动捕获现场 DOM、报错栈与屏幕快照
 */
class IncidentDumper {
    constructor(baseDir) {
        this.baseDir = baseDir || path.resolve(__dirname, '../../');
        this.snapshotsDir = path.join(this.baseDir, '05_测试与验收_QA', 'snapshots', 'incidents');
        this.screenshotsDir = path.join(this.baseDir, '05_测试与验收_QA', 'screenshots');
        this._ensureDirs();
    }

    _ensureDirs() {
        if (!fs.existsSync(this.snapshotsDir)) {
            fs.mkdirSync(this.snapshotsDir, { recursive: true });
        }
        if (!fs.existsSync(this.screenshotsDir)) {
            fs.mkdirSync(this.screenshotsDir, { recursive: true });
        }
    }

    /**
     * 捕获故障现场快照
     * @param {Object} params
     * @param {import('playwright').Page} params.page
     * @param {import('playwright').Frame} [params.frame]
     * @param {string} params.taskId
     * @param {string} params.taskName
     * @param {string} params.scene - 'CHAPTER_EXAM' | 'IN_VIDEO_QUIZ' | 'CATALOG_ROUTING'
     * @param {string|Error} params.error
     * @param {Object} [params.currentSelectors]
     * @returns {Promise<{ incidentId: string, snapshotPath: string, screenshotPath: string }>}
     */
    async dumpIncident({ page, frame, taskId, taskName, scene, error, currentSelectors }) {
        const timestamp = Date.now();
        const dateStr = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
        const incidentId = `INC_${dateStr}_${taskId || 'unknown'}`;

        let htmlSnapshot = '';
        let frameUrl = '';

        try {
            const targetFrame = frame || page;
            if (targetFrame && typeof targetFrame.content === 'function') {
                htmlSnapshot = await targetFrame.content();
                frameUrl = targetFrame.url ? targetFrame.url() : '';
            } else if (targetFrame && typeof targetFrame.evaluate === 'function') {
                htmlSnapshot = await targetFrame.evaluate(() => document.documentElement.outerHTML);
                frameUrl = await targetFrame.evaluate(() => window.location.href);
            }
        } catch (e) {
            htmlSnapshot = `<!-- Failed to extract HTML: ${e.message} -->`;
        }

        // 截取当前屏幕快照
        const screenshotFileName = `${incidentId}.png`;
        const screenshotPath = path.join(this.screenshotsDir, screenshotFileName);
        try {
            if (page && typeof page.screenshot === 'function' && !page.isClosed()) {
                await page.screenshot({ path: screenshotPath, fullPage: false });
            }
        } catch (e) {
            console.warn(`[IncidentDumper] 截屏保存失败: ${e.message}`);
        }

        const incidentData = {
            incidentId,
            timestamp,
            isoTime: new Date(timestamp).toISOString(),
            taskId,
            taskName,
            scene,
            error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error),
            frameUrl,
            currentSelectors: currentSelectors || {},
            screenshot: screenshotFileName,
            htmlLength: htmlSnapshot.length,
            htmlSnapshot
        };

        const snapshotFileName = `${incidentId}.json`;
        const snapshotPath = path.join(this.snapshotsDir, snapshotFileName);
        fs.writeFileSync(snapshotPath, JSON.stringify(incidentData, null, 2), 'utf-8');

        console.log(`[IncidentDumper] ⚠️ 故障现场快照已保存: ${snapshotPath}`);
        return {
            incidentId,
            snapshotPath,
            screenshotPath,
            incidentData
        };
    }
}

module.exports = IncidentDumper;
