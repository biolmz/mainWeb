/* ============================================================
   MD IDE · 在线 Markdown 编辑器 · 核心逻辑
   依赖（CDN，缺失时自动降级）：
     - marked        Markdown 解析
     - DOMPurify     HTML 消毒（防 XSS）
     - highlight.js  代码高亮
     - html2pdf.js   按需动态加载，仅导出 PDF 时使用
   ============================================================ */
'use strict';

/* ============================================================
   DOM 引用
   ============================================================ */
const $ = (id) => document.getElementById(id);

const editor        = $('editor');
const lineNumbers   = $('lineNumbers');
const preview       = $('preview');
const previewScroll = $('previewScroll');
const fileNameInput = $('fileName');
const dirtyDot      = $('dirtyDot');
const saveStatus    = $('saveStatus');
const statsEl       = $('stats');
const cursorPosEl   = $('cursorPos');
const readTimeEl    = $('readTime');
const engineStatus  = $('engineStatus');
const workspace     = $('workspace');
const splitter      = $('splitter');
const fileInput     = $('fileInput');
const pdfStage      = $('pdfStage');
const dropOverlay   = $('dropOverlay');
const toastEl       = $('toast');
const busyMask      = $('busyMask');
const busyText      = $('busyText');

/* ============================================================
   全局状态
   ============================================================ */
const DRAFT_KEY = 'mdide:draft';
const VIEW_KEY  = 'mdide:view';
const THEME_KEY = 'mdide:theme';
const HTML2PDF_CDN = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js';

/* Pyodide（浏览器端 Python 运行时，首次运行代码时按需加载） */
const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_CDN   = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/pyodide.js`;
const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

/* 主题：跟随系统 / 白天 / 黑夜 / 高对比度 */
const THEMES = [
  { id: 'auto',     label: '跟随系统', icon: '◐' },
  { id: 'light',    label: '白天',     icon: '☀' },
  { id: 'dark',     label: '黑夜',     icon: '☾' },
  { id: 'contrast', label: '高对比度', icon: '◉' },
];

let engineReady = false;   // marked + DOMPurify 均可用
let dirty = false;         // 是否有未保存到本地的修改
let syncScroll = true;     // 编辑区 → 预览区 同步滚动
let viewMode = 'split';
let themeMode = 'auto';
let lastLineCount = -1;
let renderTimer = null;    // 渲染防抖
let autoSaveTimer = null;  // 草稿自动保存防抖
let toastTimer = null;

/* Python 运行相关状态 */
let pyodideInstance = null;  // Pyodide 单例（类 Jupyter 内核，变量跨单元保留）
let pyodideLoading = null;   // 加载中的 Promise，避免重复加载
let pyRunning = false;       // 串行执行锁
let execCount = 0;           // 全局执行计数（类 In[n]）
let outputsDirty = false;    // 输出缓存是否有变化（用于草稿持久化）
const cellOutputs = new Map(); // 代码文本 → 输出记录

/* ============================================================
   通用小工具
   ============================================================ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(msg, warn = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('warn', warn);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function showBusy(text) {
  busyText.textContent = text;
  busyMask.classList.add('show');
}

function hideBusy() {
  busyMask.classList.remove('show');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-loaded="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.loaded = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('网络脚本加载失败'));
    document.head.appendChild(s);
  });
}

/* 取不含扩展名的基础文件名 */
function getBaseName() {
  const name = fileNameInput.value.trim().replace(/[\\/:*?"<>|]/g, '_');
  return (name || 'untitled').replace(/\.(md|markdown|mdown|txt)$/i, '');
}

/* 触发浏览器下载 */
function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ============================================================
   主题系统：跟随系统 / 白天 / 黑夜 / 高对比度
   ============================================================ */
function resolveTheme(mode) {
  if (mode === 'auto') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return mode;
}

function applyTheme(mode, save = true) {
  themeMode = mode;
  document.documentElement.dataset.theme = resolveTheme(mode);
  const cfg = THEMES.find(t => t.id === mode) || THEMES[0];
  const btn = $('btnTheme');
  if (btn) {
    btn.textContent = cfg.icon + ' ' + cfg.label;
    btn.title = `当前主题：${cfg.label}（点击切换）`;
  }
  if (save) {
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* noop */ }
  }
}

function cycleTheme() {
  const idx = THEMES.findIndex(t => t.id === themeMode);
  const next = THEMES[(idx + 1) % THEMES.length].id;
  applyTheme(next);
  toast('主题：' + THEMES.find(t => t.id === next).label);
}

function initTheme() {
  let saved = 'auto';
  try { saved = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { /* noop */ }
  if (!THEMES.some(t => t.id === saved)) saved = 'auto';
  applyTheme(saved, false);
  /* 跟随系统模式下，系统外观变化时实时响应 */
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themeMode === 'auto') applyTheme('auto', false);
  });
}

/* ============================================================
   渲染引擎
   ============================================================ */
function initEngine() {
  if (window.marked && window.DOMPurify) {
    marked.use({ gfm: true, breaks: true });
    engineReady = true;
    engineStatus.classList.add('ok');
    engineStatus.textContent = window.hljs ? '引擎就绪 · 代码高亮' : '引擎就绪';
  } else {
    engineStatus.classList.add('fallback');
    engineStatus.textContent = '纯文本模式（CDN 加载失败）';
  }
}

/* Markdown → 消毒后的 HTML 字符串 */
function renderToHtml(md) {
  if (engineReady) {
    return DOMPurify.sanitize(marked.parse(md));
  }
  /* 降级：原文以纯文本呈现 */
  return '<pre style="white-space:pre-wrap;font-family:inherit;">' + escapeHtml(md) + '</pre>';
}

/* 对已生成的 DOM 做后处理：任务列表 / 外链 / 代码高亮 / Python 单元 */
function postProcess(container, opts = {}) {
  container.querySelectorAll('li > input[type="checkbox"]').forEach(cb => {
    const li = cb.parentElement;
    li.classList.add('task-list-item');
    if (li.parentElement) li.parentElement.classList.add('contains-task-list');
  });
  container.querySelectorAll('a[href]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  if (window.hljs) {
    try { window.hljs.configure({ ignoreUnescapedHTML: true }); } catch (e) { /* noop */ }
    container.querySelectorAll('pre code').forEach(block => {
      try { window.hljs.highlightElement(block); } catch (e) { /* 单块失败不影响整体 */ }
    });
  }
  /* ```python / ```py 代码块 → 可运行的类 Jupyter 单元（导出文档时为只读） */
  container.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    if (!code) return;
    if (!/language-(python|py)\b/.test(code.className)) return;
    buildPyCell(pre, code, opts.interactive !== false);
  });
}

/* 刷新预览 */
function refreshPreview() {
  preview.innerHTML = renderToHtml(editor.value);
  postProcess(preview, { interactive: true });
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(refreshPreview, 180);
}

/* ============================================================
   Python 运行（Pyodide · 类 Jupyter）
   ============================================================ */
function cellKey(code) {
  return String(code).replace(/\s+$/, '');
}

const MAX_CACHED_CELLS = 60;

function trimOutputs() {
  while (cellOutputs.size > MAX_CACHED_CELLS) {
    cellOutputs.delete(cellOutputs.keys().next().value);
  }
}

/* 把 pre 包裹成 py-cell：[执行计数] 标签 + 语言标记 + 运行按钮 + 输出区 */
function buildPyCell(pre, codeEl, interactive) {
  const codeText = codeEl.textContent;
  const cell = document.createElement('div');
  cell.className = 'py-cell';
  pre.parentNode.insertBefore(cell, pre);

  const bar = document.createElement('div');
  bar.className = 'py-cell-bar';

  const label = document.createElement('span');
  label.className = 'py-cell-label';
  label.textContent = '[ ]';
  bar.appendChild(label);

  const lang = document.createElement('span');
  lang.className = 'py-cell-lang';
  lang.textContent = 'python';
  bar.appendChild(lang);

  if (interactive) {
    const btn = document.createElement('button');
    btn.className = 'py-run-btn';
    btn.textContent = '▶ 运行';
    btn.title = '运行此 Python 代码块';
    btn.addEventListener('click', () => runPyCell(cell, codeText, label, btn));
    bar.appendChild(btn);
  }

  const out = document.createElement('div');
  out.className = 'py-output';

  cell.appendChild(bar);
  cell.appendChild(pre);
  cell.appendChild(out);

  /* 重渲染后恢复已有输出（代码未改动时） */
  const cached = cellOutputs.get(cellKey(codeText));
  if (cached) renderPyOutput(out, label, cached);
}

function renderPyOutput(out, labelEl, rec) {
  if (!out) return;
  if (labelEl) labelEl.textContent = rec && rec.count ? `[${rec.count}]` : '[ ]';
  out.innerHTML = '';
  if (!rec) { out.classList.remove('has-content'); return; }
  const hasContent = rec.stdout || rec.stderr || rec.error || rec.result;
  if (!hasContent) { out.classList.remove('has-content'); return; }
  out.classList.add('has-content');

  const append = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    out.appendChild(d);
  };
  if (rec.stdout) append('py-out-stdout', rec.stdout);
  if (rec.stderr) append('py-out-stderr', rec.stderr);
  if (rec.error) append('py-out-error', rec.error);
  if (rec.result) append('py-out-result', rec.result);
}

/* 惰性加载 Pyodide，全局单例复用（变量跨单元保留） */
async function getPyodide() {
  if (pyodideInstance) return pyodideInstance;
  if (pyodideLoading) return pyodideLoading;
  pyodideLoading = (async () => {
    showBusy('正在加载 Python 运行时（Pyodide）…首次运行需几秒');
    try {
      await loadScript(PYODIDE_CDN);
      if (!window.loadPyodide) throw new Error('pyodide.js 加载失败');
      const py = await window.loadPyodide({ indexURL: PYODIDE_INDEX });
      pyodideInstance = py;
      return py;
    } finally {
      hideBusy();
      pyodideLoading = null;
    }
  })();
  return pyodideLoading;
}

/* 执行单个单元：捕获 stdout / stderr / 表达式返回值 / 异常 */
async function runPyCell(cell, codeText, labelEl, btnEl) {
  if (pyRunning) {
    toast('已有单元正在运行，请稍候', true);
    return;
  }
  pyRunning = true;
  const out = cell.querySelector('.py-output');
  try {
    const py = await getPyodide();
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '… 运行中'; }
    if (labelEl) labelEl.textContent = '[*]';

    let stdoutBuf = '';
    let stderrBuf = '';
    py.setStdout({ batched: s => { stdoutBuf += s + '\n'; } });
    py.setStderr({ batched: s => { stderrBuf += s + '\n'; } });

    /* 按 import 自动加载包（如 numpy / pandas）；失败不阻断执行 */
    try { await py.loadPackagesFromImports(codeText); } catch (e) { /* noop */ }

    let resultText = null;
    let error = null;
    try {
      const result = await py.runPythonAsync(codeText);
      if (result !== undefined && result !== null) {
        try {
          resultText = String(result);
          if (typeof result.destroy === 'function') result.destroy();
        } catch (e) { resultText = '<object>'; }
      }
    } catch (err) {
      error = String(err && err.message ? err.message : err);
    }

    execCount++;
    const record = { stdout: stdoutBuf, stderr: stderrBuf, result: resultText, error, count: execCount };
    cellOutputs.set(cellKey(codeText), record);
    outputsDirty = true;
    trimOutputs();
    renderPyOutput(out, labelEl, record);
    if (!error) toast(`执行完成 [${execCount}]`);
  } catch (err) {
    renderPyOutput(out, labelEl, { error: '运行时错误：' + (err && err.message ? err.message : err), count: null });
    toast('Python 运行时加载失败', true);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '▶ 运行'; }
    pyRunning = false;
  }
}

/* 顺序运行预览区所有 Python 单元 */
async function runAllCells() {
  const cells = Array.from(preview.querySelectorAll('.py-cell'));
  if (!cells.length) {
    toast('当前文档没有 Python 代码块', true);
    return;
  }
  if (pyRunning) {
    toast('已有单元正在运行，请稍候', true);
    return;
  }
  toast(`顺序运行 ${cells.length} 个 Python 单元…`);
  for (const cell of cells) {
    const codeEl = cell.querySelector('pre code');
    if (!codeEl) continue;
    await runPyCell(
      cell,
      codeEl.textContent,
      cell.querySelector('.py-cell-label'),
      cell.querySelector('.py-run-btn')
    );
  }
}

/* ============================================================
   行号 / 统计 / 光标 / 状态
   ============================================================ */
function updateLineNumbers() {
  const count = editor.value.split('\n').length;
  if (count !== lastLineCount) {
    const parts = new Array(count);
    for (let i = 0; i < count; i++) parts[i] = i + 1;
    lineNumbers.textContent = parts.join('\n');
    lastLineCount = count;
  }
  lineNumbers.scrollTop = editor.scrollTop;
}

function updateStats() {
  const text = editor.value;
  const lines = text.split('\n').length;
  const chars = text.replace(/\s/g, '').length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  statsEl.textContent = `${chars} 字 · ${lines} 行`;

  let minutes = 0;
  if (text.trim()) minutes = Math.max(1, Math.round(cjk / 300 + words / 200));
  readTimeEl.textContent = `约 ${minutes} 分钟`;
}

function updateCursorPos() {
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos).split('\n');
  cursorPosEl.textContent = `行 ${before.length} · 列 ${before[before.length - 1].length + 1}`;
}

function setDirty(value) {
  dirty = value;
  dirtyDot.classList.toggle('show', dirty);
  if (dirty) {
    saveStatus.textContent = '未保存';
    saveStatus.className = 'st-item unsaved';
  }
}

function markSaved(label) {
  dirty = false;
  dirtyDot.classList.remove('show');
  saveStatus.textContent = label;
  saveStatus.className = 'st-item saved';
}

function refreshAll() {
  refreshPreview();
  updateLineNumbers();
  updateStats();
  updateCursorPos();
}

/* ============================================================
   编辑增强：Tab 缩进 / 列表自动续行
   ============================================================ */
function insertAtCursor(text, selectOffset = null) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(text, start, end, 'end');
  if (selectOffset !== null) {
    const anchor = start + selectOffset[0];
    const focus = start + selectOffset[1];
    editor.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus));
  }
  editor.focus();
  onInput();
}

function handleTab(e) {
  e.preventDefault();
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const sel = value.slice(start, end);
  const multiline = sel.includes('\n');

  if (!e.shiftKey && !multiline) {
    insertAtCursor('  ');
    return;
  }

  /* 多行（或 Shift+Tab）：按行增/减缩进 */
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIdx = value.indexOf('\n', end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const shifted = lines.map(l =>
    e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l
  ).join('\n');
  editor.setRangeText(shifted, lineStart, lineEnd, 'end');
  editor.setSelectionRange(lineStart, lineStart + shifted.length);
  onInput();
}

/* 回车时延续列表 / 引用前缀；空列表项回车退出列表 */
function handleEnter(e) {
  const start = editor.selectionStart;
  if (start !== editor.selectionEnd) return;
  const value = editor.value;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineText = value.slice(lineStart, start);

  /* 组：1=缩进 2=标记(- * + / n. / >) 3=空格 4=任务框整段 5=框内符号 6=内容 */
  const m = lineText.match(/^(\s*)(?:([-*+]|\d+\.|>)([ \t]+)(\[([ xX])\][ \t]+)?)?(.*)$/);
  if (!m || !m[2]) return; /* 无前缀 → 原生回车行为 */

  const [, indent, marker, , , taskBox, rest] = m;

  /* 列表项为空：回车清除前缀，退出列表 */
  if (!rest.trim()) {
    e.preventDefault();
    editor.setRangeText('', lineStart, start, 'end');
    onInput();
    return;
  }

  e.preventDefault();
  let prefix;
  if (taskBox !== undefined) {
    prefix = indent + '- [ ] ';
  } else if (/^\d+\.$/.test(marker)) {
    prefix = indent + (parseInt(marker, 10) + 1) + '. ';
  } else {
    prefix = indent + marker + ' ';
  }
  insertAtCursor('\n' + prefix);
}

/* ============================================================
   工具栏格式化动作
   ============================================================ */
function wrapSelection(before, after, placeholder) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const sel = value.slice(start, end);

  /* 光标外侧已是包裹符 → 取消包裹 */
  if (value.slice(start - before.length, start) === before &&
      value.slice(end, end + after.length) === after) {
    editor.setRangeText(sel, start - before.length, end + after.length, 'end');
  } else if (sel.startsWith(before) && sel.endsWith(after) && sel.length > before.length + after.length) {
    /* 选中文本自身已被包裹 → 去掉包裹符 */
    editor.setRangeText(sel.slice(before.length, sel.length - after.length), start, end, 'end');
  } else {
    const body = sel || placeholder;
    editor.setRangeText(before + body + after, start, end, 'end');
    editor.setSelectionRange(start + before.length, start + before.length + body.length);
  }
  editor.focus();
  onInput();
}

/* 行首前缀规则：add = 添加的前缀；strip = 识别/剥离已有前缀的正则 */
const PREFIX_RULES = {
  h1:    { add: '# ',     strip: /^#{1,6}[ \t]+/ },
  h2:    { add: '## ',    strip: /^#{1,6}[ \t]+/ },
  h3:    { add: '### ',   strip: /^#{1,6}[ \t]+/ },
  quote: { add: '> ',     strip: /^>[ \t]?/ },
  ul:    { add: '- ',     strip: /^(?:[-*+]|\d+\.)(?:[ \t]+\[[ xX]\][ \t]+|[ \t]+)/ },
  ol:    { add: '1. ',    strip: /^(?:[-*+]|\d+\.)(?:[ \t]+\[[ xX]\][ \t]+|[ \t]+)/ },
  task:  { add: '- [ ] ', strip: /^(?:[-*+][ \t]+)?\[[ xX]\][ \t]+/ }
};

function linePrefixAction(type) {
  const rule = PREFIX_RULES[type];
  if (!rule) return;

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIdx = value.indexOf('\n', end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const lines = value.slice(lineStart, lineEnd).split('\n');

  const nonEmpty = lines.filter(l => l.trim() !== '');
  const allPrefixed = nonEmpty.length > 0 && nonEmpty.every(l => rule.strip.test(l));

  const next = lines.map((l, i) => {
    if (l.trim() === '') return l;
    const stripped = l.replace(rule.strip, '');
    if (allPrefixed) return stripped;
    /* 有序列表按行重新编号，其余使用固定前缀 */
    return rule.add === '1. ' ? `${i + 1}. ${stripped}` : rule.add + stripped;
  }).join('\n');

  editor.setRangeText(next, lineStart, lineEnd, 'end');
  editor.setSelectionRange(lineStart, lineStart + next.length);
  editor.focus();
  onInput();
}

function applyAction(act) {
  switch (act) {
    case 'h1': case 'h2': case 'h3':
    case 'quote': case 'ul': case 'ol': case 'task':
      linePrefixAction(act);
      break;
    case 'bold': wrapSelection('**', '**', '粗体文本'); break;
    case 'italic': wrapSelection('*', '*', '斜体文本'); break;
    case 'strike': wrapSelection('~~', '~~', '删除文本'); break;
    case 'code': wrapSelection('`', '`', '代码'); break;
    case 'link':
      insertAtCursor('[](https://)', [1, 1]);
      break;
    case 'image':
      insertAtCursor('![](https://)', [2, 2]);
      break;
    case 'codeblock':
      insertAtCursor('\n```js\n' + (editor.value.slice(editor.selectionStart, editor.selectionEnd) || '// code') + '\n```\n');
      break;
    case 'table':
      insertAtCursor('\n| 表头 | 表头 | 表头 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n');
      break;
    case 'hr':
      insertAtCursor('\n---\n');
      break;
    case 'pyblock':
      insertAtCursor('\n```python\n# 在预览区点击 ▶ 运行 即可执行\nprint("Hello, MD IDE!")\n```\n');
      break;
  }
}

/* ============================================================
   文件操作
   ============================================================ */
function newDocument() {
  if (dirty && !confirm('当前文档尚未保存到本地，确定新建并丢弃修改吗？')) return;
  editor.value = '';
  fileNameInput.value = 'untitled.md';
  cellOutputs.clear();
  outputsDirty = false;
  execCount = 0;
  lastLineCount = -1;
  markSaved('就绪');
  refreshAll();
  toast('已新建文档');
  editor.focus();
}

function openLocalFile() {
  fileInput.click();
}

function openFile(file) {
  if (!file) return;
  if (!/\.(md|markdown|mdown|txt)$/i.test(file.name)) {
    toast('仅支持 .md / .markdown / .txt 文件', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    editor.value = String(reader.result);
    fileNameInput.value = file.name;
    cellOutputs.clear();
    outputsDirty = false;
    execCount = 0;
    lastLineCount = -1;
    markSaved('已打开 ' + file.name);
    refreshAll();
    previewScroll.scrollTop = 0;
    editor.scrollTop = 0;
    toast('已打开：' + file.name);
  };
  reader.onerror = () => toast('文件读取失败', true);
  reader.readAsText(file, 'utf-8');
}

function saveMarkdown() {
  let name = fileNameInput.value.trim().replace(/[\\/:*?"<>|]/g, '_') || 'untitled.md';
  if (!/\.(md|markdown|mdown|txt)$/i.test(name)) name += '.md';
  fileNameInput.value = name;
  downloadFile(editor.value, name, 'text/markdown;charset=utf-8');
  markSaved('已保存到本地 · ' + name);
  toast('已保存：' + name);
}

/* ---------------- 导出文档共用浅色主题 ---------------- */
const LIGHT_DOC_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f0f2f5;
  color: #1f2328;
  font-family: 'Space Grotesk', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Serif SC', sans-serif;
  line-height: 1.75;
  font-size: 16px;
}
.doc {
  max-width: 830px;
  margin: 0 auto;
  padding: 56px 56px 72px;
  background: #ffffff;
  min-height: 100vh;
}
.doc-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  padding-bottom: 14px;
  margin-bottom: 34px;
  border-bottom: 2px solid #1f2328;
}
.doc-title {
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.doc-meta { font-size: 0.75rem; color: #8b949e; font-family: monospace; white-space: nowrap; }
h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.7em 0 0.7em; font-weight: 600; }
h1 { font-size: 1.9em; padding-bottom: 0.3em; border-bottom: 1px solid #d8dee4; }
h2 { font-size: 1.45em; padding-bottom: 0.25em; border-bottom: 1px solid #eaeef2; }
h3 { font-size: 1.22em; }
h4 { font-size: 1.05em; }
p { margin: 0.85em 0; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
strong { font-weight: 600; }
ul, ol { padding-left: 1.7em; margin: 0.85em 0; }
li { margin: 0.3em 0; }
ul.contains-task-list { list-style: none; padding-left: 0.3em; }
li.task-list-item { list-style: none; }
li.task-list-item input { margin-right: 0.5em; }
blockquote {
  margin: 1.1em 0;
  padding: 0.4em 1.2em;
  border-left: 4px solid #d0d7de;
  color: #57606a;
  background: #f6f8fa;
  border-radius: 0 4px 4px 0;
}
code {
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 0.87em;
  background: rgba(175, 184, 193, 0.2);
  border-radius: 4px;
  padding: 0.15em 0.4em;
}
pre {
  margin: 1.1em 0;
  padding: 14px 18px;
  background: #f6f8fa;
  border: 1px solid #d8dee4;
  border-radius: 8px;
  overflow-x: auto;
  line-height: 1.6;
}
pre code { background: none; padding: 0; font-size: 0.85em; }
table { width: 100%; border-collapse: collapse; margin: 1.3em 0; font-size: 0.92em; }
th, td { border: 1px solid #d8dee4; padding: 8px 13px; }
th { background: #f6f8fa; text-align: left; }
tr:nth-child(even) td { background: #fbfcfd; }
img { max-width: 100%; border-radius: 6px; }
hr { border: none; height: 1px; background: #d8dee4; margin: 2.2em 0; }
.doc-footer {
  margin-top: 56px;
  padding-top: 14px;
  border-top: 1px dashed #d8dee4;
  font-size: 0.72rem;
  color: #8b949e;
  text-align: center;
  font-family: monospace;
}
/* highlight.js · github light */
.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-literal { color: #cf222e; }
.hljs-type, .hljs-title.class_ { color: #953800; }
.hljs-string, .hljs-regexp, .hljs-addition { color: #0a3069; }
.hljs-number, .hljs-symbol, .hljs-variable, .hljs-template-variable { color: #0550ae; }
.hljs-comment, .hljs-quote, .hljs-deletion { color: #6e7781; font-style: italic; }
.hljs-title.function_ { color: #8250df; }
.hljs-attr, .hljs-attribute, .hljs-selector-attr { color: #0550ae; }
.hljs-meta, .hljs-doctag { color: #953800; }
.hljs-section, .hljs-name { color: #116329; }

/* Python 单元（导出版为只读：隐藏运行按钮，无输出时隐藏输出区） */
.py-cell { margin: 1.3em 0; border: 1px solid #d8dee4; border-radius: 8px; background: #ffffff; overflow: hidden; }
.py-cell-bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; background: #f6f8fa; border-bottom: 1px solid #eaeef2; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 0.72rem; color: #57606a; }
.py-cell-label { color: #0969da; }
.py-cell pre { margin: 0; border: none; border-radius: 0; }
.py-output { padding: 8px 14px; border-top: 1px dashed #d8dee4; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 0.8rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.py-output:empty { display: none; }
.py-out-stderr, .py-out-error { color: #cf222e; }
.py-out-result { color: #0969da; }
.py-out-result::before { content: 'Out: '; opacity: .65; }
.py-run-btn { display: none; }
@media print {
  body { background: #fff; }
  .doc { padding: 0; max-width: none; }
  .doc-header, .doc-footer { display: none; }
  pre, blockquote, table { break-inside: avoid; }
}
`;

/* PDF 导出专用样式：与 LIGHT_DOC_CSS 同源，但全部 scope 到 .pdf-page 容器，
   避免注入页面时污染编辑器自身的全局样式 */
const PDF_DOC_CSS = `
.pdf-stage { background: #ffffff; }
.pdf-page {
  width: 730px;
  background: #ffffff;
  color: #1f2328;
  font-family: 'Space Grotesk', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Serif SC', sans-serif;
  line-height: 1.75;
  font-size: 16px;
}
.pdf-page * { box-sizing: border-box; }
.pdf-page .doc { padding: 44px 50px; }
.pdf-page .doc-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  padding-bottom: 14px;
  margin-bottom: 34px;
  border-bottom: 2px solid #1f2328;
}
.pdf-page .doc-title { font-size: 1.15rem; font-weight: 600; }
.pdf-page .doc-meta { font-size: 0.75rem; color: #8b949e; font-family: monospace; white-space: nowrap; }
.pdf-page h1, .pdf-page h2, .pdf-page h3,
.pdf-page h4, .pdf-page h5, .pdf-page h6 { line-height: 1.35; margin: 1.7em 0 0.7em; font-weight: 600; }
.pdf-page h1 { font-size: 1.9em; padding-bottom: 0.3em; border-bottom: 1px solid #d8dee4; }
.pdf-page h2 { font-size: 1.45em; padding-bottom: 0.25em; border-bottom: 1px solid #eaeef2; }
.pdf-page h3 { font-size: 1.22em; }
.pdf-page h4 { font-size: 1.05em; }
.pdf-page p { margin: 0.85em 0; }
.pdf-page a { color: #0969da; text-decoration: none; }
.pdf-page strong { font-weight: 600; }
.pdf-page ul, .pdf-page ol { padding-left: 1.7em; margin: 0.85em 0; }
.pdf-page li { margin: 0.3em 0; }
.pdf-page ul.contains-task-list { list-style: none; padding-left: 0.3em; }
.pdf-page li.task-list-item { list-style: none; }
.pdf-page li.task-list-item input { margin-right: 0.5em; }
.pdf-page blockquote {
  margin: 1.1em 0;
  padding: 0.4em 1.2em;
  border-left: 4px solid #d0d7de;
  color: #57606a;
  background: #f6f8fa;
  border-radius: 0 4px 4px 0;
}
.pdf-page code {
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 0.87em;
  background: rgba(175, 184, 193, 0.2);
  border-radius: 4px;
  padding: 0.15em 0.4em;
}
.pdf-page pre {
  margin: 1.1em 0;
  padding: 14px 18px;
  background: #f6f8fa;
  border: 1px solid #d8dee4;
  border-radius: 8px;
  overflow-x: auto;
  line-height: 1.6;
}
.pdf-page pre code { background: none; padding: 0; font-size: 0.85em; }
.pdf-page table { width: 100%; border-collapse: collapse; margin: 1.3em 0; font-size: 0.92em; }
.pdf-page th, .pdf-page td { border: 1px solid #d8dee4; padding: 8px 13px; }
.pdf-page th { background: #f6f8fa; text-align: left; }
.pdf-page tr:nth-child(even) td { background: #fbfcfd; }
.pdf-page img { max-width: 100%; border-radius: 6px; }
.pdf-page hr { border: none; height: 1px; background: #d8dee4; margin: 2.2em 0; }
.pdf-page .doc-footer {
  margin-top: 56px;
  padding-top: 14px;
  border-top: 1px dashed #d8dee4;
  font-size: 0.72rem;
  color: #8b949e;
  text-align: center;
  font-family: monospace;
}
.pdf-page .hljs-keyword, .pdf-page .hljs-selector-tag, .pdf-page .hljs-built_in, .pdf-page .hljs-literal { color: #cf222e; }
.pdf-page .hljs-type, .pdf-page .hljs-title.class_ { color: #953800; }
.pdf-page .hljs-string, .pdf-page .hljs-regexp, .pdf-page .hljs-addition { color: #0a3069; }
.pdf-page .hljs-number, .pdf-page .hljs-symbol, .pdf-page .hljs-variable, .pdf-page .hljs-template-variable { color: #0550ae; }
.pdf-page .hljs-comment, .pdf-page .hljs-quote, .pdf-page .hljs-deletion { color: #6e7781; font-style: italic; }
.pdf-page .hljs-title.function_ { color: #8250df; }
.pdf-page .hljs-attr, .pdf-page .hljs-attribute, .pdf-page .hljs-selector-attr { color: #0550ae; }
.pdf-page .hljs-meta, .pdf-page .hljs-doctag { color: #953800; }
.pdf-page .hljs-section, .pdf-page .hljs-name { color: #116329; }

/* Python 单元（只读版：无按钮、无输出时隐藏）——全部规则带 .pdf-page 前缀，不污染页面 */
.pdf-page .py-cell { margin: 1.3em 0; border: 1px solid #d8dee4; border-radius: 8px; background: #ffffff; overflow: hidden; }
.pdf-page .py-cell-bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; background: #f6f8fa; border-bottom: 1px solid #eaeef2; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 0.72rem; color: #57606a; }
.pdf-page .py-cell-label { color: #0969da; }
.pdf-page .py-cell pre { margin: 0; border: none; border-radius: 0; }
.pdf-page .py-output { padding: 8px 14px; border-top: 1px dashed #d8dee4; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 0.8rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.pdf-page .py-output:empty { display: none; }
.pdf-page .py-out-stderr, .pdf-page .py-out-error { color: #cf222e; }
.pdf-page .py-out-result { color: #0969da; }
.pdf-page .py-out-result::before { content: 'Out: '; opacity: .65; }
.pdf-page .py-run-btn { display: none; }
`;

/* 生成导出用的浅色文档 DOM（含内联样式） */
function buildLightDoc() {
  const wrap = document.createElement('div');
  wrap.className = 'doc';

  const base = getBaseName();
  const tmp = document.createElement('div');
  tmp.innerHTML = renderToHtml(editor.value);
  postProcess(tmp, { interactive: false });
  const h1 = tmp.querySelector('h1');
  const title = (h1 && h1.textContent.trim()) || base;

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const header = document.createElement('header');
  header.className = 'doc-header';
  header.innerHTML = `<span class="doc-title">${escapeHtml(title)}</span><span class="doc-meta">${escapeHtml(stamp)}</span>`;

  const footer = document.createElement('footer');
  footer.className = 'doc-footer';
  footer.textContent = '— 由 MD IDE 导出 —';

  wrap.appendChild(header);
  while (tmp.firstChild) wrap.appendChild(tmp.firstChild);
  wrap.appendChild(footer);
  return { wrap, title };
}

function saveAsHtml() {
  const { wrap, title } = buildLightDoc();
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="MD IDE">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400&family=Noto+Serif+SC:wght@400;600&display=swap" rel="stylesheet">
<style>${LIGHT_DOC_CSS}</style>
</head>
<body>
${wrap.innerHTML}
</body>
</html>`;
  const name = getBaseName() + '.html';
  downloadFile(html, name, 'text/html;charset=utf-8');
  markSaved('已另存为 HTML');
  toast('已导出：' + name);
}

async function saveAsPdf() {
  if (!editor.value.trim()) {
    toast('文档为空，无需导出', true);
    return;
  }
  showBusy('正在生成 PDF…');
  try {
    await loadScript(HTML2PDF_CDN);
    if (!window.html2pdf) throw new Error('html2pdf 加载失败');

    pdfStage.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = PDF_DOC_CSS;
    const scoped = document.createElement('div');
    scoped.className = 'pdf-page';
    const { wrap } = buildLightDoc();
    scoped.appendChild(wrap);
    pdfStage.appendChild(style);
    pdfStage.appendChild(scoped);

    /* 留出时间渲染字体与图片 */
    await new Promise(r => setTimeout(r, 150));

    await window.html2pdf().set({
      margin: [12, 12, 16, 12],
      filename: getBaseName() + '.pdf',
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    }).from(scoped).save();

    markSaved('已导出 PDF');
    toast('PDF 已导出');
  } catch (err) {
    toast('PDF 导出失败：' + (err && err.message ? err.message : '未知错误'), true);
  } finally {
    hideBusy();
    pdfStage.innerHTML = '';
  }
}

/* ============================================================
   草稿自动保存（localStorage）
   ============================================================ */
function autoSaveDraft() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      const payload = {
        name: fileNameInput.value,
        content: editor.value,
        time: Date.now()
      };
      /* Python 单元输出随草稿持久化（较大时跳过，避免占满存储） */
      if (outputsDirty) {
        try {
          const json = JSON.stringify(Object.fromEntries(cellOutputs));
          if (json.length < 400000) payload.outputs = json;
        } catch (e) { /* 含无法序列化内容时跳过 */ }
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
      outputsDirty = false;
      const t = new Date();
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      if (dirty) {
        saveStatus.textContent = `草稿已自动保存 ${hh}:${mm}`;
        saveStatus.className = 'st-item unsaved';
      }
    } catch (e) { /* 存储空间不足等，静默处理 */ }
  }, 800);
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const draft = JSON.parse(raw);
    if (typeof draft.content !== 'string') return false;
    editor.value = draft.content;
    if (draft.name) fileNameInput.value = draft.name;
    /* 恢复 Python 单元输出缓存 */
    if (draft.outputs) {
      try {
        const entries = Object.entries(JSON.parse(draft.outputs));
        entries.forEach(([k, v]) => cellOutputs.set(k, v));
        if (entries.length) execCount = Math.max(...entries.map(([, v]) => (v && v.count) || 0));
      } catch (e) { /* 缓存解析失败不影响内容恢复 */ }
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* ============================================================
   视图切换 / 分栏拖拽 / 同步滚动
   ============================================================ */
function setView(mode) {
  viewMode = mode;
  workspace.className = 'workspace view-' + mode;
  document.querySelectorAll('#viewSwitch button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  try { localStorage.setItem(VIEW_KEY, mode); } catch (e) { /* noop */ }
}

function initSplitter() {
  let dragging = false;
  const isMobile = () => window.matchMedia('(max-width: 720px)').matches;

  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = isMobile() ? 'row-resize' : 'col-resize';
  });

  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = workspace.getBoundingClientRect();
    let ratio = isMobile()
      ? (e.clientY - rect.top) / rect.height
      : (e.clientX - rect.left) / rect.width;
    ratio = Math.min(0.85, Math.max(0.15, ratio));
    workspace.style.setProperty('--editor-width', (ratio * 100).toFixed(2) + '%');
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };
  splitter.addEventListener('pointerup', stop);
  splitter.addEventListener('pointercancel', stop);
}

function initScrollSync() {
  editor.addEventListener('scroll', () => {
    lineNumbers.scrollTop = editor.scrollTop;
    if (!syncScroll || viewMode === 'edit') return;
    const denom = editor.scrollHeight - editor.clientHeight;
    const ratio = denom > 0 ? editor.scrollTop / denom : 0;
    const pDenom = previewScroll.scrollHeight - previewScroll.clientHeight;
    previewScroll.scrollTop = ratio * Math.max(0, pDenom);
  });
}

/* ============================================================
   拖拽文件打开
   ============================================================ */
function initDragDrop() {
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    dropOverlay.classList.add('show');
  });

  window.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  });

  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.remove('show');
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('show');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) openFile(file);
  });
}

/* ============================================================
   事件绑定
   ============================================================ */
function onInput() {
  scheduleRender();
  updateLineNumbers();
  updateStats();
  setDirty(true);
  autoSaveDraft();
}

function bindEvents() {
  /* 编辑器 */
  editor.addEventListener('input', onInput);
  editor.addEventListener('click', updateCursorPos);
  editor.addEventListener('keyup', updateCursorPos);
  editor.addEventListener('select', updateCursorPos);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') return handleTab(e);
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) return handleEnter(e);
  });

  /* 文件名变化 → 视为修改 */
  fileNameInput.addEventListener('input', () => setDirty(true));

  /* 顶栏操作 */
  $('btnNew').addEventListener('click', newDocument);
  $('btnOpen').addEventListener('click', openLocalFile);
  $('btnSaveMd').addEventListener('click', saveMarkdown);
  $('btnSaveHtml').addEventListener('click', saveAsHtml);
  $('btnSavePdf').addEventListener('click', saveAsPdf);
  $('btnTheme').addEventListener('click', cycleTheme);
  $('btnRunAll').addEventListener('click', runAllCells);

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
    fileInput.value = '';
  });

  /* 视图切换 */
  document.querySelectorAll('#viewSwitch button').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  /* 工具栏 */
  document.querySelectorAll('#toolbar button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'sync-scroll') return;
      applyAction(btn.dataset.act);
    });
  });

  $('btnSyncScroll').addEventListener('click', function () {
    syncScroll = !syncScroll;
    this.classList.toggle('active', syncScroll);
    toast(syncScroll ? '同步滚动：开' : '同步滚动：关');
  });

  /* 全局快捷键 */
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    if (e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      saveAsPdf();
    } else if (e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveAsHtml();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      saveMarkdown();
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      openLocalFile();
    } else if (e.altKey && (e.key === '1' || e.key === '2' || e.key === '3')) {
      /* 注意：Ctrl+数字是浏览器保留键（切换标签页），故叠加 Alt */
      e.preventDefault();
      setView(e.key === '1' ? 'edit' : e.key === '2' ? 'split' : 'preview');
    } else if (e.key === 'Enter') {
      /* Ctrl/Cmd + Enter：运行全部 Python 单元 */
      e.preventDefault();
      runAllCells();
    } else if (document.activeElement === editor) {
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); applyAction('bold'); }
      else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); applyAction('italic'); }
      else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); applyAction('link'); }
    }
  });

  /* 离开页面前提醒 */
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ============================================================
   初始示例文档（首次访问时展示）
   ============================================================ */
const WELCOME_DOC = `# 欢迎使用 MD IDE ✨

一个纯浏览器端的 **Markdown 编辑器**：所有处理均在本地完成，内容不会上传到任何服务器。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| \`Ctrl + S\` | 保存为 .md 到本地 |
| \`Ctrl + Shift + S\` | 另存为 HTML |
| \`Ctrl + Alt + P\` | 导出 PDF |
| \`Ctrl + O\` | 打开本地文件 |
| \`Ctrl + Alt + 1 / 2 / 3\` | 切换 编辑 / 分栏 / 预览 |
| \`Ctrl + Enter\` | 运行全部 Python 单元 |
| \`Ctrl + B / I / K\` | 粗体 / 斜体 / 链接 |
| \`Tab / Shift + Tab\` | 缩进 / 反缩进 |

## 你能做什么

- [x] 实时分栏预览，支持 GFM 表格、任务列表、删除线
- [x] **Python 代码运行**：预览中 \`\`\`python 代码块可点击 ▶ 运行（Pyodide，变量跨单元保留）
- [x] 四种主题：跟随系统 / 白天 / 黑夜 / 高对比度
- [x] 一键保存 \`.md\`、另存独立 \`.html\`、导出 \`.pdf\`
- [x] 拖拽 \`.md\` 文件到窗口直接打开
- [x] 草稿自动保存，刷新页面不丢失
- [ ] 开始写下你的第一行文字

> 代码高亮也没有问题——下面的 Python 块是 **可运行的**，点击块右上角 **▶ 运行**（首次会加载运行时，需几秒）：

\`\`\`python
def hello_markdown():
    """在序列与代码之间探寻真理"""
    print("Hello, MD IDE!")

hello_markdown()
\`\`\`

---

### 提示

编辑完成后点击右上角 **保存 .md** 即可下载到本地；
也可以试试 **另存 HTML** 与 **导出 PDF**。
顶栏的 **◐ 主题** 按钮可循环切换主题，工具栏的 **▶ 运行全部** 可依次执行所有 Python 单元。
`;

/* ============================================================
   启动
   ============================================================ */
(function init() {
  initEngine();
  initTheme();

  const restored = restoreDraft();
  if (!restored) {
    editor.value = WELCOME_DOC;
    saveStatus.textContent = '就绪';
    saveStatus.className = 'st-item';
  } else {
    markSaved('已恢复上次草稿');
  }

  let savedView = 'split';
  try { savedView = localStorage.getItem(VIEW_KEY) || 'split'; } catch (e) { /* noop */ }
  setView(['edit', 'split', 'preview'].includes(savedView) ? savedView : 'split');

  bindEvents();
  initScrollSync();
  initSplitter();
  initDragDrop();

  refreshAll();
})();
