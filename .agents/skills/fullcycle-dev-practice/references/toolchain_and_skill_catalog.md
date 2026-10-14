# 实战 Skill 矩阵与工具链编排指南 (Toolchain & Skill Catalog)

现代全流程软件工程绝非单打独斗，而是通过专门化的 **Agent Skills** 与现代工程工具链进行高度协同。本指南整理了在复杂客户端应用全生命周期研发中所编排的 Skill 矩阵与落地方案。

---

## 一、核心 Agent Skills 协同矩阵

| Skill 名称 | 职责定位 | 触发场景与实战运用 | 输出交付物 |
| :--- | :--- | :--- | :--- |
| **`doc-coauthoring`** | 需求与架构协同推演 | 需求发起、多方决策对齐、系统 RFC 制定。用于平衡产品体验愿景（PO）与技术实现可行性（架构师）。 | PRD 规格书、技术方案 RFC |
| **`frontend-design`** | 视觉系统与人机工效重塑 | UI 重构、主题切换、暗黑模式设计。坚决拒绝平庸模板，定制高质感颜色 Token、毛玻璃模糊层级与无障碍触控尺寸。 | CSS Design Tokens、轻量化 DOM 样式基线 |
| **`webapp-testing`** | 自动化无头回归测试 | 每个切片开发后、复杂缺陷修复后。利用 Playwright 启动真实无头浏览器，模拟触屏滑动手势、DOM 极限尺寸测试。 | 自动化测试脚本 (`test_*.js`)、全用例通过报告 |
| **`docx`** | 文档专业编译与导出 | 规范与技术方案跨部门交付。将 Markdown 原始文本渲染为带封面、多级大纲标题、样式美化表格与代码块的 `.docx` 文件。 | 高质量 Word 文档 (`*.docx`) |
| **`android-cli` / `Capacitor`** | 客户端原生包装与硬件赋能 | 纯 Web 应用打包为移动端 App。配置 Android 原生工程、注入触感微震动权限 (`VIBRATE`)、刘海屏与底栏安全区适配。 | `android/` 原生工程、离线本地资源 |

---

## 二、Web 单文件工程到 Android 原生 APK 打包实战指南

针对以纯离线、单文件 HTML/JS/CSS 为核心引擎的客户端应用，**Capacitor** 提供了现代、轻量且与 Web 标准 100% 契合的原生打包方案。

### 2.1 依赖安装与工程初始化
在项目根目录下，执行最小依赖安装：
```bash
# 1. 安装核心与 Android 驱动
npm install @capacitor/core @capacitor/android --save
npm install @capacitor/cli --save-dev

# 2. 初始化 Capacitor 配置（指向源码目录）
npx cap init "[应用名称]" "[包名，如 com.aegis.intimacy]" --web-dir "01_源码工程_Source"

# 3. 添加 Android 平台骨架
npx cap add android
```

### 2.2 关键硬件能力适配
在 `android/app/src/main/AndroidManifest.xml` 中配置硬件权限与配置变更防护：
```xml
<!-- 震动触感反馈权限 -->
<uses-permission android:name="android.permission.VIBRATE" />
<!-- 网络权限（若需要） -->
<uses-permission android:name="android.permission.INTERNET" />
```

在 `android/app/build.gradle` 中对齐版本与构建属性：
```groovy
defaultConfig {
    applicationId "com.aegis.intimacy"
    minSdkVersion 24       // Android 7.0+
    targetSdkVersion 36    // 遵循现代 Android SDK 标准
    versionCode 20900
    versionName "2.9.0"
}
```

每次更新 `01_源码工程_Source` 中的代码后，执行同步：
```bash
npx cap sync android
```

---

## 三、GitHub Actions 云端极速构建与免环境 CI/CD 实践

本地搭建 Android SDK、Gradle 与 Java 环境往往需要数个 GB 的存储空间和繁琐配置。**通过 GitHub Actions 云端流水线，可实现“推送到 GitHub 即自动构建 APK”的完全免本地环境体验**。

### 3.1 最佳实践工作流定义 (`.github/workflows/build-apk.yml`)
```yaml
name: Build Android APK

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    name: Build & Package APK
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Set up Node.js 22
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'

      - name: Set up JDK 21 (Capacitor 8 标准)
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      # 注：Ubuntu-latest 预装了 Android SDK，无需使用第三方 setup-android action

      - name: Install Node Dependencies
        run: npm install

      - name: Sync Capacitor Web Assets
        run: npx cap sync android

      - name: Build Android Debug APK
        run: |
          cd android
          chmod +x ./gradlew
          ./gradlew assembleDebug --no-daemon

      - name: Prepare APK Asset
        run: |
          cp android/app/build/outputs/apk/debug/app-debug.apk Aegis-Intimacy-v2.9.0.apk

      - name: Upload APK Artifact
        uses: actions/upload-artifact@v4
        with:
          name: Aegis-Intimacy-v2.9.0-APK
          path: Aegis-Intimacy-v2.9.0.apk
          retention-days: 30

      - name: Publish to GitHub Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          cat << 'EOF' > release_notes.md
          ### 发布构建产物 (Release APK)
          - 纯离线客户端渐进式交互引擎
          - 点击下方 Assets 中的 APK 即可直接下载并安装到安卓设备。
          EOF
          gh release create v2.9.0 Aegis-Intimacy-v2.9.0.apk \
            --title "Aegis Intimacy v2.9.0 APK" \
            --notes-file release_notes.md || true
```

### 3.2 常见坑位与避坑经验 (Lessons Learned)
1. **Node.js 版本约束**：Capacitor 8.x CLI 强制要求 `Node.js >= 22.0.0`，在 CI 中切勿使用 Node 18 或 20；
2. **JDK 版本对齐**：Capacitor 8 Android 原生模块编译采用 `source release: 21`，必须配置 `java-version: '21'`，配置 JDK 17 会触发 `invalid source release: 21` 错误；
3. **Android SDK 避免重复配置**：GitHub Actions 的 `ubuntu-latest` 机器已预装 Android SDK 且配置完备，调用 `android-actions/setup-android` 反而容易触发 license 重复校验崩溃；
4. **GitHub CLI 发布参数**：`gh release create` 不支持 `--clobber` 参数（`--clobber` 仅在 `gh release upload` 中支持），通过 `--notes-file` 传递换行 Release 备注更稳定。
