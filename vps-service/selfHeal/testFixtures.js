/**
 * testFixtures.js: 超星自动化测试与基准治具库 (Offline Mock Regression Harness)
 * 提供 5 套真实/变异的典型题型 HTML 治具，用于 Gate 4 离线全量回归测试
 */

const FIXTURES = {
    // 治具 1: 标准超星单选题结构
    baseline_standard_single: `
<!DOCTYPE html>
<html>
<head><title>课后作业</title></head>
<body>
    <div id="submitForm">
        <div class="TiMu singleQuesId" id="question_101">
            <div class="Zy_TItle clearfix">
                <i class="fl">1</i>
                <div class="Zy_TItle_name">【单选题】《史记》的作者是谁？ (5分)</div>
            </div>
            <ul class="Zy_ulTop">
                <li class="answerBg">
                    <label><input type="radio" name="answer_101" id="ans_101_A" value="A"> A. 司马迁</label>
                </li>
                <li class="answerBg">
                    <label><input type="radio" name="answer_101" id="ans_101_B" value="B"> B. 班固</label>
                </li>
                <li class="answerBg">
                    <label><input type="radio" name="answer_101" id="ans_101_C" value="C"> C. 司马光</label>
                </li>
                <li class="answerBg">
                    <label><input type="radio" name="answer_101" id="ans_101_D" value="D"> D. 刘向</label>
                </li>
            </ul>
        </div>
        <div class="marBom60">
            <a href="javascript:void(0);" class="Btn_blue_1 workBtnIndex" onclick="btnBlueSubmit();">提交</a>
            <a href="javascript:void(0);" class="btnGray_1 workBtnIndex" onclick="noSubmit();">保存</a>
        </div>
    </div>
</body>
</html>
`,

    // 治具 2: 多选题与判断题复合结构
    baseline_multi_and_judge: `
<!DOCTYPE html>
<html>
<body>
    <form id="submitForm">
        <div class="TiMu singleQuesId" id="q_1">
            <div class="Zy_TItle_type">【多选题】</div>
            <div class="Zy_TItle_name">下列属于我国古代四大名著的有：</div>
            <ul class="Zy_ulTop">
                <li><label><input type="checkbox" name="ans_1" value="A"> A. 《红楼梦》</label></li>
                <li><label><input type="checkbox" name="ans_1" value="B"> B. 《西游记》</label></li>
                <li><label><input type="checkbox" name="ans_1" value="C"> C. 《水浒传》</label></li>
                <li><label><input type="checkbox" name="ans_1" value="D"> D. 《聊斋志异》</label></li>
            </ul>
        </div>
        <div class="TiMu singleQuesId" id="q_2">
            <div class="Zy_TItle_type">【判断题】</div>
            <div class="Zy_TItle_name">西汉王朝建立于公元前202年。</div>
            <ul class="Zy_ulTop">
                <li><label><input type="radio" name="ans_2" value="true"> 正确</label></li>
                <li><label><input type="radio" name="ans_2" value="false"> 错误</label></li>
            </ul>
        </div>
    </form>
</body>
</html>
`,

    // 治具 3: 随堂视频弹窗阻断测验
    baseline_video_quiz: `
<!DOCTYPE html>
<html>
<body>
    <div class="ans-videoquiz ans-dialog">
        <div class="ans-videoquiz-title">【随堂单选】秦始皇统一六国的时间是哪一年？</div>
        <div class="ans-videoquiz-opt">
            <label><input type="radio" name="ans_vq" value="A"> A. 公元前221年</label>
        </div>
        <div class="ans-videoquiz-opt">
            <label><input type="radio" name="ans_vq" value="B"> B. 公元前206年</label>
        </div>
        <div class="ans-videoquiz-submit" id="ext-gen1045">
            <button class="ans-videoquiz-submit-btn">提交并继续</button>
        </div>
    </div>
</body>
</html>
`,

    // 治具 4: 变异场景 A - 类名变更为 2026 新版混合容器 (混淆或新命名前缀)
    variant_hybrid_class: `
<!DOCTYPE html>
<html>
<body>
    <div class="xxt-exam-sheet">
        <div class="xxt-question-card" data-qid="901">
            <span class="xxt-tag-type">单选题</span>
            <h3 class="xxt-stem-title">计算机硬件系统的核心部件是什么？</h3>
            <div class="xxt-options-list">
                <div class="xxt-opt-item"><input type="radio" name="q901" value="A"> A. 中央处理器 (CPU)</div>
                <div class="xxt-opt-item"><input type="radio" name="q901" value="B"> B. 内存</div>
                <div class="xxt-opt-item"><input type="radio" name="q901" value="C"> C. 硬盘</div>
            </div>
        </div>
    </div>
</body>
</html>
`,

    // 治具 5: 变异场景 B - 跨层级嵌套与无序号选项
    variant_deep_nested: `
<!DOCTYPE html>
<html>
<body>
    <section class="homework-container">
        <article class="homework-question" id="ques_501">
            <div class="stem-box">
                <em class="type-badge">[判断题]</em>
                <div class="stem-text">二分查找算法的时间复杂度是 O(log n)。</div>
            </div>
            <div class="options-wrapper">
                <div class="choice-row"><input type="radio" name="opt_501" value="true"> 正确</div>
                <div class="choice-row"><input type="radio" name="opt_501" value="false"> 错误</div>
            </div>
        </article>
    </section>
</body>
</html>
`
};

/**
 * 通用提取校验器: 在纯文本/DOM 规则下测试给定 selectors 是否能有效从 HTML 提取题目
 * @param {string} html 
 * @param {Object} selectors 
 * @returns {{ success: boolean, count: number, questions: Array }}
 */
function testExtractFromHtml(html, selectors) {
    if (!html || !selectors) return { success: false, count: 0, questions: [] };

    // 匹配容器和题目节点
    // 支持按逗号分隔的选择器逐一扫描
    const containerClasses = (selectors.container || '').split(',').map(s => s.trim().replace(/^[\.#]/, ''));
    const qNodeClasses = (selectors.questionNodes || selectors.questionNode || '').split(',').map(s => s.trim().replace(/^[\.#]/, ''));

    // 检查 HTML 中是否包含任一容器标记
    const hasContainer = containerClasses.some(cls => cls && html.includes(cls));
    const matchedQNodes = qNodeClasses.filter(cls => cls && html.includes(cls));

    // 粗粒度正则提取验证题目与选项存在性
    const radioCheckboxMatches = html.match(/<input[^>]+type=["'](radio|checkbox)["'][^>]*>/gi) || [];
    const stemMatches = html.match(/(【(单选|多选|判断|填空)题?】|class=["'][^"']*(title|name|stem)[^"']*["'])/gi) || [];

    const extractedCount = matchedQNodes.length > 0 && radioCheckboxMatches.length > 0 ? 1 : 0;
    const isSuccess = hasContainer && extractedCount > 0;

    return {
        success: isSuccess,
        hasContainer,
        matchedQNodes,
        inputCount: radioCheckboxMatches.length,
        stemSignCount: stemMatches.length
    };
}

module.exports = {
    FIXTURES,
    testExtractFromHtml
};
