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
const editorHighlight     = $('editorHighlight');
const editorHighlightCode = $('editorHighlightCode');

/* ============================================================
   全局状态
   ============================================================ */
const DRAFT_KEY = 'mdide:draft';
const VIEW_KEY  = 'mdide:view';
const THEME_KEY = 'mdide:theme';
const HTML2PDF_CDN = 'vendor/html2pdf.bundle.min.js';

/* Pyodide（浏览器端 Python 运行时，首次运行代码时按需加载）。
   默认优先加载站点自带的本地 ./pyodide/ 目录（整站离线、零外部依赖，真站点最稳）；
   本地缺失时依次回退到多个公共 CDN 镜像，也可用 URL 参数 ?pyodide=地址/ 强制指定。
   注意：file:// 协议下浏览器会拦截对本地 .wasm 的 fetch()（同源 file 请求被 CORS 拦），
   故本地目录仅对 http(s) 生效；本地双击打开时自动回退 CDN。 */
const PYODIDE_VERSION = '0.26.4';
const _pyParam = (typeof URLSearchParams !== 'undefined')
  ? new URLSearchParams(location.search).get('pyodide') : null;
const _isFileProto = (typeof location !== 'undefined') && location.protocol === 'file:';
const PYODIDE_BASES = [
  _pyParam,
  _isFileProto ? null : './pyodide/',
  `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  `https://fastly.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  `https://gcore.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  `https://unpkg.com/pyodide@${PYODIDE_VERSION}/full/`,
].filter(Boolean);

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

/* 增量预览渲染：按“顶层块”缓存已解析 HTML，仅重新渲染发生变化的块 */
const previewBlockCache = new Map(); // 块文本 → 已完成 hljs 着色的 HTML
let previewHljsReady = false;        // 上次渲染时 hljs 是否就绪（变化时清空缓存）

/* Python 运行相关状态 */
let pyodideInstance = null;  // Pyodide 单例（类 Jupyter 内核，变量跨单元保留）
let pyodideLoading = null;   // 加载中的 Promise，避免重复加载
let pyBusy = false;          // 统一忙标志：任意 Python 执行进行中（防止 md/编辑器交叉启动）
let execCount = 0;           // 全局执行计数（类 In[n]）
let outputsDirty = false;    // 输出缓存是否有变化（用于草稿持久化）
const cellOutputs = new Map(); // 代码文本 → 输出记录
let pyExecQueue = Promise.resolve(); // Pyodide 执行串行队列（保证同一解释器不并发，避免状态错乱）

/* ============================================================
   通用小工具
   ============================================================ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* 安全的高亮封装：调用 hljs，失败回退为转义文本（不破坏编辑区逐字对齐） */
function safeHighlight(code, lang) {
  try {
    return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch (e) {
    return escapeHtml(code);
  }
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
    const existing = document.querySelector(`script[data-loaded="${src}"]`);
    if (existing && existing.dataset.ok === '1') return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.loaded = src;
    s.onload = () => { s.dataset.ok = '1'; resolve(); };
    s.onerror = () => { s.remove(); reject(new Error('网络脚本加载失败：' + src)); };
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
    previewBlockCache.clear();   // 引擎就绪后以真正的渲染替换可能的降级缓存
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

/* 大文档增量渲染：把 Markdown 按“顶层块”切分（空白行分隔，且尊重围栏代码块），
   仅对发生变化的块重新解析，其余复用缓存，避免整篇重排。 */
function splitTopLevelBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let cur = [];
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(/^\s*(```|~~~)/);
    if (fm) {
      if (!inFence) { inFence = true; fenceMarker = fm[1]; }
      else if (line.trim().startsWith(fenceMarker)) { inFence = false; }
    }
    if (!inFence && line.trim() === '') {
      if (cur.length) { blocks.push(cur.join('\n')); cur = []; }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.length ? blocks : [''];
}

/* 提取全文的链接引用定义（如 [foo]: http://…），前置到每个块以保证跨块引用仍可解析 */
function extractRefDefs(md) {
  const defs = [];
  const re = /^\s*\[[^\]]+\]:\s+\S+/;
  const lines = md.split('\n');
  for (const line of lines) if (re.test(line)) defs.push(line);
  return defs.join('\n');
}

/* 渲染单个块：命中缓存直接返回；否则解析 → 在缓存阶段完成 hljs 着色（复用
   postProcess 的 hljs 会因 data-highlighted 跳过，避免每次按键重复着色）。 */
function renderBlockHtml(block, refDefs) {
  let h = previewBlockCache.get(block);
  if (h !== undefined) return h;
  const md = refDefs ? (refDefs + '\n\n' + block) : block;
  h = renderToHtml(md);
  const tmp = document.createElement('div');
  tmp.innerHTML = h;
  if (window.hljs) {
    try { window.hljs.configure({ ignoreUnescapedHTML: true }); } catch (e) { /* noop */ }
    tmp.querySelectorAll('pre code').forEach(b => {
      try { window.hljs.highlightElement(b); } catch (e) { /* 单块失败不影响整体 */ }
    });
  }
  h = tmp.innerHTML;
  previewBlockCache.set(block, h);
  return h;
}

/* 刷新预览（增量） */
function refreshPreview() {
  try {
    /* hljs 就绪状态变化时，已缓存（未着色）的块需要重新生成 */
    const hljsNow = !!window.hljs;
    if (hljsNow !== previewHljsReady) { previewBlockCache.clear(); previewHljsReady = hljsNow; }

    const full = editor.value;
    const refDefs = extractRefDefs(full);
    const blocks = splitTopLevelBlocks(full);
    const parts = blocks.map(b => renderBlockHtml(b, refDefs));
    preview.innerHTML = parts.join('\n\n');

    /* 仅保留当前文档用到的块缓存，防止无限增长 */
    const live = new Map();
    blocks.forEach(b => { const v = previewBlockCache.get(b); if (v !== undefined) live.set(b, v); });
    previewBlockCache.clear();
    live.forEach((v, k) => previewBlockCache.set(k, v));

    postProcess(preview, { interactive: true });
  } catch (e) {
    /* 渲染异常不应拖垮编辑器：保留上一次预览并提示 */
    console.error('预览渲染失败：', e);
    toast('预览渲染出错（内容已保留）', true);
  }
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(refreshPreview, 180);
}

/* ============================================================
   编辑区 Python 代码高亮（透明 textarea + 高亮垫层）
   只对 ```python / ```py 围栏块内代码做 hljs 着色，
   其余 Markdown 原文保持基础色；输出文本与源文逐字一致。
   ============================================================ */
let highlightTimer = null;

function buildEditorHighlightHtml(text) {
  const openRe  = /^```(?:python|py)\b.*$/gm;  /* 开始围栏 */
  const closeRe = /^```.*$/gm;                 /* 结束围栏（任意语言） */
  let html = '';
  let last = 0;
  let m;
  while ((m = openRe.exec(text)) !== null) {
    html += escapeHtml(text.slice(last, m.index));
    html += '<span class="md-fence">' + escapeHtml(m[0]) + '</span>';
    let pos = openRe.lastIndex;
    if (text[pos] === '\n') pos += 1;
    /* 查找结束围栏；未闭合时（正在输入）一直高亮到文末 */
    closeRe.lastIndex = pos;
    const cm = closeRe.exec(text);
    const codeEnd = cm ? cm.index : text.length;
    const code = text.slice(pos, codeEnd);
    /* 代码区域：hljs 真实着色，并包一层 .md-py 以在编辑区淡显代码块背景 */
    const codeHtml = (window.hljs && code)
      ? safeHighlight(code, 'python')
      : escapeHtml(code || '');
    html += '<span class="md-py">' + codeHtml + '</span>';
    if (cm) {
      html += '<span class="md-fence">' + escapeHtml(cm[0]) + '</span>';
      pos = closeRe.lastIndex;
    } else {
      pos = text.length;
    }
    last = pos;
    openRe.lastIndex = pos;
  }
  html += escapeHtml(text.slice(last));
  return html;
}

function highlightEditor() {
  editorHighlightCode.innerHTML = buildEditorHighlightHtml(editor.value);
  /* textarea 出现纵向滚动条时会占宽，垫层补偿同等宽度保证折行一致 */
  const sb = editor.offsetWidth - editor.clientWidth;
  editorHighlight.style.paddingRight = (18 + sb) + 'px';
  editorHighlight.scrollTop = editor.scrollTop;
}

function scheduleHighlight() {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(highlightEditor, 80);
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
    const spacer = document.createElement('span');
    spacer.className = 'py-cell-spacer';
    bar.appendChild(spacer);

    const btn = document.createElement('button');
    btn.className = 'py-run-btn';
    btn.textContent = '▶ 运行';
    btn.title = '运行此 Python 代码块';
    btn.addEventListener('click', () => runPyCell(cell, codeText, label, btn));
    bar.appendChild(btn);

    /* 在独立 Python 编辑器中打开此代码 */
    const editBtn = document.createElement('button');
    editBtn.className = 'py-cell-act';
    editBtn.textContent = '↗ 编辑器';
    editBtn.title = '在独立 Python 编辑器中打开此代码';
    editBtn.addEventListener('click', () => openPlayground(codeText));
    bar.appendChild(editBtn);

    /* 导出为 .py 文件（可交给本地 Python 编辑器运行） */
    const saveBtn = document.createElement('button');
    saveBtn.className = 'py-cell-act';
    saveBtn.textContent = '⤓ .py';
    saveBtn.title = '导出为 .py 文件（可用本地编辑器运行）';
    saveBtn.addEventListener('click', () => savePyFile(codeText, 'cell.py'));
    bar.appendChild(saveBtn);
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
  const hasContent = rec.stdout || rec.stderr || rec.error || rec.result ||
                     (rec.plots && rec.plots.length);
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
  /* matplotlib 出图：以内嵌 PNG 形式直接显示 */
  if (rec.plots && rec.plots.length) {
    const wrap = document.createElement('div');
    wrap.className = 'py-out-plots';
    rec.plots.forEach((src, i) => {
      const fig = document.createElement('div');
      fig.className = 'py-out-figure';
      const img = document.createElement('img');
      img.className = 'py-plot-img';
      img.src = src;
      img.alt = 'Python 绘图输出';
      fig.appendChild(img);
      fig.appendChild(makePlotDownloadBtn(src, i));
      wrap.appendChild(fig);
    });
    out.appendChild(wrap);
  }
}

/* 惰性加载 Pyodide，全局单例复用（变量跨单元保留） */
async function getPyodide() {
  if (pyodideInstance) return pyodideInstance;
  if (pyodideLoading) return pyodideLoading;
  pyodideLoading = (async () => {
    const tried = [];
    showBusy('正在加载 Python 运行时（Pyodide）…首次运行需几秒');
    try {
      for (const base of PYODIDE_BASES) {
        try {
          await loadScript(base + 'pyodide.js');
          if (!window.loadPyodide) throw new Error('pyodide.js 未导出 loadPyodide');
          const py = await window.loadPyodide({ indexURL: base });
          pyodideInstance = py;
          /* 在独立编辑器里标注已就绪 + 实际使用的源，便于排查 */
          const eng = $('pygEngine');
          if (eng) eng.textContent = '引擎：Pyodide · 已就绪（' + base.replace(/\/full\/$/, '').replace(/\/$/, '') + '）';
          return py;
        } catch (e) {
          tried.push(base);
          /* 清掉本源已注入的脚本，避免污染 window.loadPyodide 与下次重试 */
          const bad = document.querySelector(`script[src^="${base}"]`);
          if (bad) bad.remove();
          console.warn('Pyodide 源加载失败：', base, e);
        }
      }
      throw new Error('Python 运行时加载失败（已尝试 ' + tried.length + ' 个源）。若为本地部署，请确认站点目录下已包含 pyodide/ 文件夹；否则多为网络受限，可改用 ?pyodide=地址/ 指定可用源。');
    } finally {
      hideBusy();
    }
  })();
  /* 结束后清空在途标记，允许下次运行重新尝试所有源 */
  pyodideLoading.finally(() => { pyodideLoading = null; });
  return pyodideLoading;
}

/* 共享：在 Pyodide 中执行一段 Python，返回 { stdout, stderr, result, error }
   这是"真正的 Python"——Pyodide 即编译到 WebAssembly 的 CPython。
   支持 input()：通过浏览器 prompt 阻塞式读取一行（沙箱内无法直连本地解释器时的真实执行方案）。
   通过 pyExecQueue 串行化：同一 Pyodide 解释器不允许并发 runPythonAsync，否则全局状态会错乱。 */
async function executePythonCode(code, opts = {}) {
  const task = async () => {
  const py = await getPyodide();
  let stdoutBuf = '';
  let stderrBuf = '';
  py.setStdout({ batched: s => {
    stdoutBuf += s + '\n';
    if (opts.onStdout) opts.onStdout(s);
  } });
  py.setStderr({ batched: s => {
    stderrBuf += s + '\n';
    if (opts.onStderr) opts.onStderr(s);
  } });

  /* input() 支持：WASM 同步 stdin，用 prompt 阻塞读取 */
  if (typeof py.setStdin === 'function') {
    let queue = '';
    py.setStdin({
      stdin: () => {
        if (!queue) {
          const v = window.prompt(opts.inputPrompt || 'Python input()：', '');
          queue = (v === null ? '' : v) + '\n';
        }
        if (!queue.length) return null;
        const c = queue.charCodeAt(0);
        queue = queue.slice(1);
        return c;
      }
    });
  }

  /* 按 import 自动加载包（如 numpy / pandas / matplotlib）；失败不阻断执行 */
  try { await py.loadPackagesFromImports(code); } catch (e) { /* noop */ }

  let resultText = null;
  let error = null;
  let plots = [];
  try {
    const result = await py.runPythonAsync(code);
    if (result !== undefined && result !== null) {
      try {
        resultText = String(result);
        if (typeof result.destroy === 'function') result.destroy();
      } catch (e) { resultText = '<object>'; }
    }
    /* 捕获 matplotlib 已生成的图形（真实出图，非模拟） */
    plots = captureMatplotlibPlots(py);
  } catch (err) {
    error = String(err && err.message ? err.message : err);
    /* 即便执行异常，也尽量取回已生成的图形 */
    try { plots = plots.concat(captureMatplotlibPlots(py)); } catch (e) { /* noop */ }
  }
  return { stdout: stdoutBuf, stderr: stderrBuf, result: resultText, error, plots };
  };
  /* 串行排队：前一次未结束时，本次进入队列等待，互不影响全局状态 */
  const run = pyExecQueue.then(task, task);
  pyExecQueue = run.then(() => {}, () => {});
  return run;
}

/* 在 Pyodide 中捕获 matplotlib 已生成的图像，返回 data URL 数组。
   这是“真正画图”——后端是编译到 WASM 的真实 CPython + 真实 matplotlib。 */
function captureMatplotlibPlots(py) {
  try {
    /* 仅在 matplotlib 被 import 时才尝试捕获，避免无谓开销 */
    let imported = false;
    try { imported = py.globals.has('__mdide_mpl_loaded'); } catch (e) { imported = false; }
    if (!imported) {
      try { imported = py.runPython("'matplotlib' in __import__('sys').modules"); } catch (e) { imported = false; }
    }
    if (!imported) return [];
    /* 惰性注册捕获辅助函数（仅首次） */
    let defined = false;
    try { defined = py.globals.has('__mdide_capture_plots'); } catch (e) { defined = false; }
    if (!defined) {
      py.runPython(`
def __mdide_capture_plots():
    import io as _mdio, base64 as _mdb64, matplotlib.pyplot as _mdplt
    _out = []
    for _num in _mdplt.get_fignums():
        _fig = _mdplt.figure(_num)
        _buf = _mdio.BytesIO()
        _fig.savefig(_buf, format='png', bbox_inches='tight', dpi=110)
        _buf.seek(0)
        _out.append(_mdb64.b64encode(_buf.read()).decode('ascii'))
    _mdplt.close('all')
    return _out
`);
    }
    const fn = py.globals.get('__mdide_capture_plots');
    if (!fn) return [];
    const res = fn();
    const arr = (res && typeof res.toJs === 'function') ? res.toJs() : (res || []);
    if (res && typeof res.destroy === 'function') res.destroy();
    return Array.from(arr).map(b => 'data:image/png;base64,' + String(b));
  } catch (e) {
    return [];
  }
}

/* 执行单个单元：捕获 stdout / stderr / 表达式返回值 / 异常 */
async function runPyCell(cell, codeText, labelEl, btnEl, isBatch = false) {
  if (!isBatch && pyBusy) {
    toast('已有单元正在运行，请稍候', true);
    return;
  }
  if (!isBatch) pyBusy = true;
  const out = cell.querySelector('.py-output');
  try {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '… 运行中'; }
    if (labelEl) labelEl.textContent = '[*]';

    const rec = await executePythonCode(codeText, {});
    execCount++;
    rec.count = execCount;
    cellOutputs.set(cellKey(codeText), rec);
    outputsDirty = true;
    trimOutputs();
    renderPyOutput(out, labelEl, rec);
    if (!rec.error) toast(`执行完成 [${execCount}]`);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    renderPyOutput(out, labelEl, { error: '运行时错误：' + msg, count: null });
    toast('Python 运行时加载失败：' + msg, true);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '▶ 运行'; }
    if (!isBatch) pyBusy = false;
  }
}

/* 顺序运行预览区所有 Python 单元 */
async function runAllCells() {
  const cells = Array.from(preview.querySelectorAll('.py-cell'));
  if (!cells.length) {
    toast('当前文档没有 Python 代码块', true);
    return;
  }
  if (pyBusy) {
    toast('已有单元正在运行，请稍候', true);
    return;
  }
  pyBusy = true;
  toast(`顺序运行 ${cells.length} 个 Python 单元…`);
  try {
    for (const cell of cells) {
      const codeEl = cell.querySelector('pre code');
      if (!codeEl) continue;
      await runPyCell(
        cell,
        codeEl.textContent,
        cell.querySelector('.py-cell-label'),
        cell.querySelector('.py-run-btn'),
        true
      );
    }
  } finally {
    pyBusy = false;
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

let statsTimer = null;   // 统计信息防抖：避免大文档下每次按键都跑正则（流畅性）
function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(updateStats, 250);
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
  highlightEditor();
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
.py-out-plots { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 0 2px; }
.py-plot-img { max-width: 100%; border-radius: 6px; border: 1px solid #d8dee4; background: #fff; display: block; }
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
.pdf-page .py-out-plots { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 0 2px; }
.pdf-page .py-plot-img { max-width: 100%; border-radius: 6px; border: 1px solid #d8dee4; background: #fff; display: block; }
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
  let syncRaf = 0;
  let syncRatio = 0;
  editor.addEventListener('scroll', () => {
    /* 行号与高亮垫层需实时跟随，开销极小，直接更新 */
    lineNumbers.scrollTop = editor.scrollTop;
    editorHighlight.scrollTop = editor.scrollTop;
    if (!syncScroll || viewMode === 'edit') return;
    const denom = editor.scrollHeight - editor.clientHeight;
    syncRatio = denom > 0 ? editor.scrollTop / denom : 0;
    /* 预览同步用 rAF 合并，避免滚动事件中频繁触发布局（流畅性） */
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(() => {
      syncRaf = 0;
      const pDenom = previewScroll.scrollHeight - previewScroll.clientHeight;
      previewScroll.scrollTop = syncRatio * Math.max(0, pDenom);
    });
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
  scheduleHighlight();
  updateLineNumbers();
  scheduleStats();
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
  /* 中文输入法上屏后立即刷新高亮，避免候选期间滞后 */
  editor.addEventListener('compositionend', highlightEditor);
  /* 宽度变化（窗口缩放 / 视图切换 / 拖动分隔条）时重算折行宽度 */
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const sb = editor.offsetWidth - editor.clientWidth;
      editorHighlight.style.paddingRight = (18 + sb) + 'px';
    }).observe(editor);
  } else {
    window.addEventListener('resize', highlightEditor);
  }

  /* 视口缩小后，把已打开（且非全屏）的 Py 编辑器重新夹回可视区域并记录 */
  window.addEventListener('resize', () => {
    if (pyg.el && pyg.el.classList.contains('show') && !pyg.el.classList.contains('fullscreen')) {
      const r = pyg.el.getBoundingClientRect();
      const w = Math.max(480, Math.min(r.width, window.innerWidth));
      const h = Math.max(360, Math.min(r.height, window.innerHeight));
      const left = Math.max(0, Math.min(r.left, window.innerWidth - w));
      const top = Math.max(0, Math.min(r.top, window.innerHeight - h));
      pyg.el.style.width = w + 'px';
      pyg.el.style.height = h + 'px';
      pyg.el.style.left = left + 'px';
      pyg.el.style.top = top + 'px';
      savePygWin();
    }
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
    } else if (e.altKey && (e.key === 'y' || e.key === 'Y')) {
      /* Ctrl+Alt+Y：打开独立 Python 编辑器 */
      e.preventDefault();
      openPlayground();
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
- [x] **独立 Python 编辑器**：工具栏 🐍 编辑器（或 Ctrl+Alt+Y）打开，可运行 / 语法高亮 / 导出 .py 交给本地编辑器
- [x] **Python 画图**：\`matplotlib\` 出图直接显示在输出区（预览区与独立编辑器均支持，真实 CPython + 真实 matplotlib）
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

## Python 画图（matplotlib）

预览区与独立编辑器里的 Python 都是**真实 CPython（Pyodide）+ 真实 matplotlib**——点 ▶ 运行即可看到图：

\`\`\`python
import matplotlib.pyplot as plt

x = [1, 2, 3, 4, 5]
y = [2, 4, 1, 8, 5]
plt.figure(figsize=(6, 3))
plt.plot(x, y, marker='o', color='#2f81f7', label='示例数据')
plt.title('示例折线图')
plt.xlabel('x'); plt.ylabel('y')
plt.legend()
plt.show()
\`\`\`

---

### 提示

编辑完成后点击右上角 **保存 .md** 即可下载到本地；
也可以试试 **另存 HTML** 与 **导出 PDF**。
顶栏的 **◐ 主题** 按钮可循环切换主题，工具栏的 **▶ 运行全部** 可依次执行所有 Python 单元。
`;

/* ============================================================
   Python 编辑器（独立 Playground · 真实 CPython / Pyodide）
   ============================================================ */
const pyg = {
  el: $('pyPlayground'),
  header: $('pygHeader'),
  body: $('pygBody'),
  splitter: $('pygSplitter'),
  fullBtn: $('pygFull'),
  savePlotBtn: $('pygSavePlot'),
  editor: $('pygEditor'),
  highlight: $('pygHighlight'),
  highlightCode: $('pygHighlightCode'),
  lineNumbers: $('pygLineNumbers'),
  output: $('pygOutput'),
  runBtn: $('pygRun'),
  saveBtn: $('pygSave'),
  copyBtn: $('pygCopy'),
  clearBtn: $('pygClear'),
  closeBtn: $('pygClose'),
  openBtn: $('btnPyPlayground'),
};
let pygRunning = false;
let pygLineCount = -1;
let pygLastPlots = [];

function pygHighlightEditor() {
  const v = pyg.editor.value;
  pyg.highlightCode.innerHTML = (window.hljs && v) ? safeHighlight(v, 'python') : escapeHtml(v);
  const sb = pyg.editor.offsetWidth - pyg.editor.clientWidth;
  pyg.highlight.style.paddingRight = (18 + sb) + 'px';
  pyg.highlight.scrollTop = pyg.editor.scrollTop;
}

function pygUpdateLineNumbers() {
  const count = pyg.editor.value.split('\n').length;
  if (count !== pygLineCount) {
    const parts = new Array(count);
    for (let i = 0; i < count; i++) parts[i] = i + 1;
    pyg.lineNumbers.textContent = parts.join('\n');
    pygLineCount = count;
  }
  pyg.lineNumbers.scrollTop = pyg.editor.scrollTop;
}

function pygAppend(kind, text) {
  if (!text) return;
  const hint = pyg.output.querySelector('.pyg-empty-hint');
  if (hint) hint.remove();
  const d = document.createElement('div');
  d.className = 'pyg-line-' + kind;
  d.textContent = text;
  pyg.output.appendChild(d);
  pyg.output.scrollTop = pyg.output.scrollHeight;
}

/* 在独立编辑器输出区渲染 matplotlib 出图（内嵌 PNG），附导出按钮 */
function pygAppendPlot(src) {
  const hint = pyg.output.querySelector('.pyg-empty-hint');
  if (hint) hint.remove();
  const d = document.createElement('div');
  d.className = 'pyg-line-plot';
  const img = document.createElement('img');
  img.className = 'pyg-plot-img';
  img.src = src;
  img.alt = 'Python 绘图输出';
  d.appendChild(img);
  d.appendChild(makePlotDownloadBtn(src));
  pyg.output.appendChild(d);
  pyg.output.scrollTop = pyg.output.scrollHeight;
}

/* 生成“导出此图为 PNG”按钮（用于独立编辑器与 md 单元出图） */
function makePlotDownloadBtn(src, idx) {
  const dl = document.createElement('button');
  dl.className = 'py-plot-dl';
  dl.type = 'button';
  dl.title = '导出此图为 PNG';
  dl.textContent = '⤓ PNG';
  dl.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadDataUrlImage(src, 'mdide-plot-' + (idx != null ? (idx + 1) : Date.now()) + '.png');
  });
  return dl;
}

/* 触发浏览器下载一个 data URL 图像 */
function downloadDataUrlImage(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function pygClearOutput() {
  pyg.output.innerHTML = '<span class="pyg-empty-hint">运行结果将显示在此处…</span>';
}

async function pygRun() {
  if (pyBusy) { toast('已有单元正在运行，请稍候', true); return; }
  pyBusy = true;
  pygRunning = true;
  pyg.runBtn.disabled = true;
  pyg.runBtn.textContent = '… 运行中';
  pygClearOutput();
  try {
    const code = pyg.editor.value;
    if (!code.trim()) { pygAppend('stderr', '（空代码，未执行）'); return; }
    const rec = await executePythonCode(code, {
      onStdout: s => pygAppend('stdout', s),
      onStderr: s => pygAppend('stderr', s),
    });
    if (rec.plots && rec.plots.length) rec.plots.forEach(src => pygAppendPlot(src));
    pygLastPlots = rec.plots || [];
    if (rec.result) pygAppend('result', rec.result);
    if (rec.error) pygAppend('error', rec.error);
    if (!rec.stdout && !rec.stderr && !rec.result && !rec.error && !(rec.plots && rec.plots.length)) pygAppend('stdout', '（无输出）');
    if (!rec.error) toast('Python 执行完成');
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    pygAppend('error', '运行时加载失败：' + msg);
    toast('Python 运行时加载失败：' + msg, true);
  } finally {
    pyg.runBtn.disabled = false;
    pyg.runBtn.textContent = '▶ 运行';
    pygRunning = false;
    pyBusy = false;
  }
}

/* 打开独立 Python 编辑器；传入 seed 则载入该段代码 */
function openPlayground(seed) {
  if (typeof seed === 'string') {
    pyg.editor.value = seed;
    pygLineCount = -1;
  }
  /* 恢复上次保存的窗口位置/大小/全屏（首次则保持默认居中） */
  restorePygWin();
  pygLastPlots = [];
  pyg.el.classList.add('show');
  pyg.el.setAttribute('aria-hidden', 'false');
  pygHighlightEditor();
  pygUpdateLineNumbers();
  pyg.editor.focus();
}

function closePlayground() {
  pyg.el.classList.remove('show');
  pyg.el.setAttribute('aria-hidden', 'true');
}

/* 全屏 / 退出全屏：CSS 视口填充（覆盖其余界面） */
function togglePygFullscreen() {
  const fs = pyg.el.classList.toggle('fullscreen');
  if (pyg.fullBtn) pyg.fullBtn.textContent = fs ? '⤡ 退出' : '⤢ 全屏';
  if (fs) {
    /* 全屏时清掉拖拽/缩放留下的内联定位，交给 .fullscreen 规则接管 */
    pyg.el.style.transform = '';
    pyg.el.style.left = pyg.el.style.top = pyg.el.style.width = pyg.el.style.height = '';
  }
  pygHighlightEditor();
  savePygWin();
}

/* ============================================================
   Playground 窗口状态持久化（位置 / 大小 / 全屏 / 分隔条）
   存入 localStorage，下次打开自动恢复；隐私模式下静默降级。
   ============================================================ */
const PYG_WIN_KEY = 'mdide.pygwin.v1';

function savePygWin() {
  try {
    const isFs = pyg.el.classList.contains('fullscreen');
    const r = pyg.el.getBoundingClientRect();
    const data = {
      fullscreen: isFs,
      left: isFs ? null : Math.round(r.left),
      top: isFs ? null : Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      editorH: Math.round(pyg.editor.getBoundingClientRect().height),
    };
    localStorage.setItem(PYG_WIN_KEY, JSON.stringify(data));
  } catch (e) { /* 隐私模式 / 配额错误：忽略即可 */ }
}

function restorePygWin() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(PYG_WIN_KEY) || 'null'); } catch (e) { data = null; }
  /* 清除可能残留的定位/尺寸，从干净状态恢复 */
  pyg.el.classList.remove('fullscreen');
  pyg.el.style.transform = '';
  pyg.el.style.left = pyg.el.style.top = pyg.el.style.width = pyg.el.style.height = '';
  pyg.editor.style.flex = '';
  if (pyg.fullBtn) pyg.fullBtn.textContent = '⤢ 全屏';

  if (!data) return; /* 首次：保持默认居中 */

  if (data.fullscreen) {
    pyg.el.classList.add('fullscreen');
    if (pyg.fullBtn) pyg.fullBtn.textContent = '⤡ 退出';
    return;
  }
  const minW = 480, minH = 360;
  const w = Math.max(minW, Math.min(data.width || minW, window.innerWidth));
  const h = Math.max(minH, Math.min(data.height || minH, window.innerHeight));
  let left = (typeof data.left === 'number') ? data.left : (window.innerWidth - w) / 2;
  let top = (typeof data.top === 'number') ? data.top : (window.innerHeight - h) / 2;
  left = Math.max(0, Math.min(left, window.innerWidth - w));
  top = Math.max(0, Math.min(top, window.innerHeight - h));
  pyg.el.style.left = left + 'px';
  pyg.el.style.top = top + 'px';
  pyg.el.style.width = w + 'px';
  pyg.el.style.height = h + 'px';
  if (data.editorH && data.editorH > 80) pyg.editor.style.flex = '0 0 ' + data.editorH + 'px';
}

/* Tab 缩进（4 空格），Shift+Tab 反缩进 */
function pygHandleTab(e) {
  const ed = pyg.editor;
  const start = ed.selectionStart;
  const end = ed.selectionEnd;
  const value = ed.value;
  if (!e.shiftKey && !value.slice(start, end).includes('\n')) {
    ed.setRangeText('    ', start, end, 'end');
    pygHighlightEditor();
    pygUpdateLineNumbers();
    return;
  }
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIdx = value.indexOf('\n', end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const block = value.slice(lineStart, lineEnd);
  const shifted = block.split('\n')
    .map(l => e.shiftKey ? l.replace(/^ {1,4}/, '') : '    ' + l)
    .join('\n');
  ed.setRangeText(shifted, lineStart, lineEnd, 'end');
  ed.setSelectionRange(lineStart, lineStart + shifted.length);
  pygHighlightEditor();
  pygUpdateLineNumbers();
}

/* 保存为 .py：优先用 File System Access API 直写本地磁盘，否则下载 */
function savePyFile(text, name) {
  if (window.showSaveFilePicker) {
    window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: 'Python 文件', accept: { 'text/x-python': ['.py'] } }]
    })
      .then(handle => handle.createWritable().then(w => w.write(text).then(() => w.close())))
      .then(() => toast('已保存为 ' + name))
      .catch(err => { if (!err || err.name !== 'AbortError') fallbackSave(text, name); });
  } else {
    fallbackSave(text, name);
  }
}

function fallbackSave(text, name) {
  downloadFile(text, name, 'text/x-python;charset=utf-8');
  toast('已下载 ' + name + '（可双击用本地 Python 编辑器打开运行）');
}

/* 编辑器 / 控制台 高度分隔条（上下拖拽调整） */
function initPygSplitter() {
  if (!pyg.splitter) return;
  pyg.splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const body = pyg.body;
    const onMove = (ev) => {
      const rect = body.getBoundingClientRect();
      const min = 80, max = rect.height - 80 - 6;
      let h = Math.max(min, Math.min(max, ev.clientY - rect.top));
      pyg.editor.style.flex = '0 0 ' + h + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      pygHighlightEditor();
      savePygWin();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
  });
}

/* 窗口拖动（标题栏）/ 缩放（八向手柄） */
function initPygResizeMove() {
  const el = pyg.el;
  if (!el) return;
  let mode = null, dir = '';
  let startX = 0, startY = 0, startRect = null;

  const onMove = (e) => {
    if (!mode) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const r = startRect;
    let left = r.left, top = r.top, w = r.width, h = r.height;
    if (dir.includes('e')) w = r.width + dx;
    if (dir.includes('s')) h = r.height + dy;
    if (dir.includes('w')) w = r.width - dx;
    if (dir.includes('n')) h = r.height - dy;
    if (mode === 'move') { left = r.left + dx; top = r.top + dy; }
    else { if (dir.includes('w')) left = r.left + dx; if (dir.includes('n')) top = r.top + dy; }
    const minW = 480, minH = 360;
    if (w < minW) { if (mode === 'resize' && dir.includes('w')) left = r.left + (r.width - minW); w = minW; }
    if (h < minH) { if (mode === 'resize' && dir.includes('n')) top = r.top + (r.height - minH); h = minH; }
    left = Math.max(0, Math.min(left, window.innerWidth - w));
    top = Math.max(0, Math.min(top, window.innerHeight - h));
    el.style.transform = 'none';
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  };
  const onUp = () => {
    mode = null; dir = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    savePygWin();
  };

  pyg.header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.pyg-btn')) return;
    if (e.button !== 0) return;
    mode = 'move'; dir = '';
    startX = e.clientX; startY = e.clientY;
    startRect = el.getBoundingClientRect();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  el.querySelectorAll('.pyg-rsz').forEach(h => {
    h.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      mode = 'resize'; dir = h.dataset.dir;
      startX = e.clientX; startY = e.clientY;
      startRect = el.getBoundingClientRect();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });
  });
}

function bindPyPlayground() {
  if (!pyg.el) return;
  pyg.openBtn.addEventListener('click', () => openPlayground());
  pyg.closeBtn.addEventListener('click', closePlayground);
  pyg.runBtn.addEventListener('click', pygRun);
  pyg.saveBtn.addEventListener('click', () => savePyFile(pyg.editor.value, 'playground.py'));
  pyg.copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(pyg.editor.value)
      .then(() => toast('代码已复制到剪贴板'))
      .catch(() => toast('复制失败', true));
  });
  pyg.clearBtn.addEventListener('click', () => {
    pyg.editor.value = '';
    pygClearOutput();
    pygHighlightEditor();
    pygUpdateLineNumbers();
    pyg.editor.focus();
  });
  /* 全屏 / 退出全屏（CSS 视口填充，叠加原生 Fullscreen API） */
  pyg.fullBtn.addEventListener('click', togglePygFullscreen);
  /* 导出当前输出区中的所有图形为 PNG */
  pyg.savePlotBtn.addEventListener('click', () => {
    if (!pygLastPlots.length) { toast('当前没有可导出的图形', true); return; }
    pygLastPlots.forEach((src, i) => downloadDataUrlImage(src, 'mdide-plot-' + (i + 1) + '.png'));
    toast('已导出 ' + pygLastPlots.length + ' 张图形');
  });

  initPygSplitter();
  initPygResizeMove();

  let pygHlTimer = null;
  pyg.editor.addEventListener('input', () => {
    /* 行号即时更新（开销极小），高亮延后防抖，避免每次按键都跑 hljs（流畅性） */
    pygUpdateLineNumbers();
    clearTimeout(pygHlTimer);
    pygHlTimer = setTimeout(pygHighlightEditor, 70);
  });
  pyg.editor.addEventListener('scroll', () => {
    pyg.lineNumbers.scrollTop = pyg.editor.scrollTop;
    pyg.highlight.scrollTop = pyg.editor.scrollTop;
  });
  pyg.editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); pygHandleTab(e); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); pygRun(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pyg.el.classList.contains('show')) {
      if (pyg.el.classList.contains('fullscreen')) togglePygFullscreen();
      else closePlayground();
    }
  });
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const sb = pyg.editor.offsetWidth - pyg.editor.clientWidth;
      pyg.highlight.style.paddingRight = (18 + sb) + 'px';
    }).observe(pyg.editor);
  }
}

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
  bindPyPlayground();

  refreshAll();
})();
