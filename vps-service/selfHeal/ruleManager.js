const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/**
 * RuleManager: 动态规则热重载与版本版本管理器
 * 支持实时内存热替换选择器规则，支持零停机原子回滚
 */
class RuleManager extends EventEmitter {
    constructor(rulesPath) {
        super();
        this.rulesPath = rulesPath || path.resolve(__dirname, '../rules/selectors.json');
        this.currentVersion = '1.0.0';
        this.historySnapshots = [];
        this.activeRules = this._loadInitialRules();
    }

    _loadInitialRules() {
        try {
            if (fs.existsSync(this.rulesPath)) {
                const content = fs.readFileSync(this.rulesPath, 'utf-8');
                const parsed = JSON.parse(content);
                this.currentVersion = parsed.version || '1.0.0';
                console.log(`[RuleManager] 已装载基准规则库 v${this.currentVersion}`);
                return parsed;
            }
        } catch (e) {
            console.error(`[RuleManager] 装载基准规则库失败: ${e.message}`);
        }
        return {};
    }

    /**
     * 获取当前生效的选择器全集
     * @returns {Object}
     */
    getSelectors() {
        return this.activeRules;
    }

    /**
     * 获取指定模块的选择器
     * @param {'exam'|'quiz'|'catalog'} moduleKey 
     * @returns {Object}
     */
    getModuleSelectors(moduleKey) {
        return (this.activeRules && this.activeRules[moduleKey]) || {};
    }

    /**
     * 应用热修复补丁 (内存热重载 + 持久化写入 + 快照备份)
     * @param {Object} patch 
     * @returns {{ success: boolean, newVersion: string, previousVersion: string }}
     */
    applyPatch(patch) {
        const previousSnapshot = JSON.parse(JSON.stringify(this.activeRules));
        const previousVersion = this.currentVersion;

        // 保存历史版本用于原子回滚
        this.historySnapshots.push({
            version: previousVersion,
            timestamp: Date.now(),
            rules: previousSnapshot
        });
        if (this.historySnapshots.length > 10) this.historySnapshots.shift();

        const patchSelectors = patch.selectors || {};
        const newVersion = patch.version || `1.0.0-patch-${Date.now()}`;

        // 智能并集融合: 将新类名与既有选择器以逗号合并，去重
        if (!this.activeRules.exam) this.activeRules.exam = {};

        for (const [key, val] of Object.entries(patchSelectors)) {
            if (this.activeRules.exam[key]) {
                const existingParts = this.activeRules.exam[key].split(',').map(s => s.trim());
                const newParts = val.split(',').map(s => s.trim());
                const combined = Array.from(new Set([...existingParts, ...newParts])).join(', ');
                this.activeRules.exam[key] = combined;
            } else {
                this.activeRules.exam[key] = val;
            }
        }

        this.activeRules.version = newVersion;
        this.currentVersion = newVersion;

        // 异步持久化回写
        try {
            fs.writeFileSync(this.rulesPath, JSON.stringify(this.activeRules, null, 2), 'utf-8');
        } catch (e) {
            console.warn(`[RuleManager] 规则文件回写警告: ${e.message}`);
        }

        console.log(`[RuleManager] 🚀 热补丁注入成功！当前版本升级至: ${newVersion}`);
        this.emit('rulesUpdated', { version: newVersion, previousVersion, rules: this.activeRules });

        return {
            success: true,
            newVersion,
            previousVersion
        };
    }

    /**
     * 原子回滚至上一个稳定版本
     * @returns {{ success: boolean, restoredVersion: string }}
     */
    rollback() {
        if (this.historySnapshots.length === 0) {
            console.warn('[RuleManager] 无法回滚: 没有历史稳定版本快照');
            return { success: false, restoredVersion: this.currentVersion };
        }

        const lastSnapshot = this.historySnapshots.pop();
        this.activeRules = lastSnapshot.rules;
        this.currentVersion = lastSnapshot.version;

        try {
            fs.writeFileSync(this.rulesPath, JSON.stringify(this.activeRules, null, 2), 'utf-8');
        } catch (e) {}

        console.log(`[RuleManager] 🔄 已原子回滚至上一稳定版本: ${this.currentVersion}`);
        this.emit('rulesRollback', { version: this.currentVersion, rules: this.activeRules });

        return {
            success: true,
            restoredVersion: this.currentVersion
        };
    }
}

module.exports = RuleManager;
