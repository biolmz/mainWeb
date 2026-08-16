/* ============================================================
 *  📌 笔记数据文件 —— 独立维护，页面自动渲染
 *
 *  ⭐ 以后增加 / 修改 / 删除笔记，只需编辑本文件，保存后刷新页面即可，
 *     不需要改动 index.html。
 *
 *  字段说明：
 *    title    : 笔记标题（显示在页面上）
 *    url      : 笔记链接地址（暂未定可写 '#', 定好后再替换）
 *    tag      : 标签（用于搜索）
 *    category : 分类标识，必须与下方 categoryMeta 中的键一致
 *
 *  新增分类：
 *    1. 在 categoryMeta 中加一行（图标、显示名、描述）
 *    2. 在 categoryOrder 中加入该分类标识（决定卡片显示顺序）
 * ============================================================ */

// ----- 笔记数据（增删改都在这里操作）-----
const noteData = [

    // ---- 生物信息 (info) ----
    { title: 'git教程', url: 'https://bio2025.site/study/info/生信入门基础知识教程.html', tag: 'git教程', category: 'info' },
    { title: 'R_ggplot2教程', url: 'https://bio2025.site/study/info/ggplot2_tutorial', tag: 'ggplot2教程', category: 'info' },   // ← 示例占位，可删除
    { title: 'Biopython教程', url: 'https://bio2025.site/study/info/Biopython零基础实战教程.html', tag: 'Biopython零基础实战教程', category: 'info' },
    { title: '生信基础知识教程', url: 'https://bio2025.site/study/info/生信基础知识教程.html', tag: '配套biopython', category: 'info' },
    { title: '生信入门教程', url: 'https://bio2025.site/study/info/生信入门教程.html', tag: '生信基础', category: 'info' },


    // ---- 英语 (en) ----
    { title: '26.12四级作文预测范文', url: 'https://bio2025.site/study/en/26.12四级作文', tag: '四级作文', category: 'en' },
    { title: '四级作文', url: 'https://bio2025.site/study/en/cet4-1', tag: '四级作文', category: 'en' },

    // ---- 生物学 (bio) ----
    { title: 'example', url: '#', tag: 'example', category: 'bio' },    // ← 示例占位，可删除

    // ---- 数学 (math) ----
    { title: '8月数竞规划', url: 'https://bio2025.site/study/math/八月数竞', tag: '复习重点', category: 'math' },

];

// ----- 分类元数据（图标、显示名、描述）-----
const categoryMeta = {
    info: { icon: '🖥️', name: '生物信息', desc: '数据分析, R, Python' },
    en:   { icon: '🔤', name: '英语资料', desc: '四六级，考研英语' },
    bio:  { icon: '🌱', name: '生物学',   desc: '生物资料' },
    math: { icon: '📐', name: '数学',     desc: '数学资料' },
};

// ----- 分类显示顺序（越靠前越先显示）-----
const categoryOrder = ['info', 'en', 'bio', 'math'];
