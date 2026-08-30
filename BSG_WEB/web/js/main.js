/* ============================================================
   麦糟奇旅 · 主脚本
   功能：导航高亮 / 移动端菜单 / 滚动浮现 / 数字滚动
         Canvas 图表（糖尿病趋势 / 营养成分 / 血糖曲线 / 权重环）
         机制选项卡 / BP 网络可视化 / 配方实验室 / 返回顶部
   ============================================================ */
(function () {
  'use strict';

  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ============ 工具 ============ */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* Canvas 高清适配：返回 {ctx, w, h}，w/h 为 CSS 像素 */
  function setupCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;
    /* 隐藏或未布局完成时 rect 可能为 0，回退到父容器/自身属性尺寸，避免除零与负值 */
    if (!w || w < 10) {
      w = Math.max((canvas.parentNode && canvas.parentNode.clientWidth) || 0, canvas.width || 0, 300) / (dpr > 2 ? dpr : 1);
      w = Math.max(w, 200);
    }
    if (!h || h < 10) {
      h = Math.max(parseFloat(canvas.getAttribute('height')) || 0, 180);
    }
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  var chartFonts = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif';
  var palette = ['#a4682a', '#e8b45a', '#7a9a4e', '#3e8f8a', '#c0605a', '#7a6ba8'];

  /* 带动画的图表绘制器：首次进入视口时以进度 t∈[0,1] 重绘。
     所有绘制调用都包 try/catch，单个图表异常不会中断其它功能 */
  function safeRender(canvas, drawFn, progress) {
    try {
      var s = setupCanvas(canvas);
      drawFn(s.ctx, s.w, s.h, progress);
    } catch (err) {
      if (window.console && console.warn) {
        console.warn('图表绘制异常（已隔离）：', err && err.message);
      }
    }
  }
  function animateChart(canvas, drawFn) {
    var started = false;
    function render(progress) { safeRender(canvas, drawFn, progress); }
    if (prefersReduced) { render(1); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !started) {
          started = true;
          io.disconnect();
          var t0 = performance.now(), dur = 1100;
          (function tick(now) {
            var t = clamp((now - t0) / dur, 0, 1);
            var ease = 1 - Math.pow(1 - t, 3);
            render(ease);
            if (t < 1) requestAnimationFrame(tick);
          })(t0);
        }
      });
    }, { threshold: 0.35 });
    io.observe(canvas);
    render(0);
  }

  /* 窗口尺寸变化 / 移动端旋转时重绘全部图表（防抖，兼容 orientationchange） */
  var redrawFns = [];
  var resizeTimer = null;
  function scheduleRedraw() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      redrawFns.forEach(function (fn) { fn(1); });
    }, 200);
  }
  window.addEventListener('resize', scheduleRedraw);
  window.addEventListener('orientationchange', function () {
    setTimeout(scheduleRedraw, 350);
  });
  /* 某些浏览器（如 iOS Safari 工具栏收起）只改变视口高度，用 ResizeObserver 兑底 */
  if (typeof ResizeObserver !== 'undefined') {
    var roDebounce = 0;
    var ro = new ResizeObserver(function () {
      clearTimeout(roDebounce);
      roDebounce = setTimeout(function () {
        redrawFns.forEach(function (fn) { fn(1); });
      }, 250);
    });
    ro.observe(document.documentElement);
  }

  /* ============ 导航 ============ */
  var navbar = $('#navbar');
  var navToggle = $('#navToggle');
  var navLinks = $('#navLinks');

  window.addEventListener('scroll', function () {
    navbar.classList.toggle('scrolled', window.scrollY > 10);
  }, { passive: true });

  navToggle.addEventListener('click', function () {
    var open = navLinks.classList.toggle('open');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $all('#navLinks a').forEach(function (a) {
    a.addEventListener('click', function () {
      navLinks.classList.remove('open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });

  /* 滚动定位高亮（scrollspy） */
  var sectionIds = ['background', 'nutrition', 'mechanism', 'journey', 'ai', 'product', 'faq'];
  var navMap = {};
  $all('.nav-links a[data-nav]').forEach(function (a) { navMap[a.getAttribute('data-nav')] = a; });

  var spyObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        $all('.nav-links a').forEach(function (a) { a.classList.remove('active'); });
        var link = navMap[entry.target.id];
        if (link) link.classList.add('active');
      }
    });
  }, { rootMargin: '-30% 0px -60% 0px' });
  sectionIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) spyObserver.observe(el);
  });

  /* ============ 返回顶部 ============ */
  var backTop = $('#backTop');
  window.addEventListener('scroll', function () {
    backTop.classList.toggle('show', window.scrollY > 600);
  }, { passive: true });
  backTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
  });

  /* ============ 滚动浮现 ============ */
  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry, i) {
      if (entry.isIntersecting) {
        var el = entry.target;
        var siblings = 0;
        setTimeout(function () { el.classList.add('revealed'); }, prefersReduced ? 0 : siblings * 60);
        revealObserver.unobserve(el);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  $all('[data-reveal]').forEach(function (el) { revealObserver.observe(el); });

  /* ============ 数字滚动 ============ */
  function animateCounter(el) {
    var target = parseFloat(el.getAttribute('data-count'));
    var decimals = parseInt(el.getAttribute('data-decimal') || '0', 10);
    var suffix = el.getAttribute('data-suffix') || '';
    if (prefersReduced) { el.textContent = target.toFixed(decimals) + suffix; return; }
    var t0 = performance.now(), dur = 1400;
    (function tick(now) {
      var t = clamp((now - t0) / dur, 0, 1);
      var ease = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * ease).toFixed(decimals) + suffix;
      if (t < 1) requestAnimationFrame(tick);
    })(t0);
  }
  var counterObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.6 });
  $all('[data-count]').forEach(function (el) { counterObserver.observe(el); });

  /* ============================================================
     图表一：全球糖尿病患者趋势（2021 vs 2045 预测）
     ============================================================ */
  (function diabetesChart() {
    var canvas = $('#diabetesChart');
    if (!canvas) return;

    function draw(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      var data = [
        { label: '2000 年', value: 1.51, note: '约 1.5 亿' },
        { label: '2021 年', value: 5.37, note: '5.37 亿 · 患病率 10.5%' },
        { label: '2045 年(预测)', value: 7.83, note: '7.83 亿 · 若不加干预' }
      ];
      var maxV = 8.5;
      var padL = 14, padB = 58, padT = 30;
      var cw = w - padL * 2;
      var plotH = h - padT - padB;
      var bw = Math.min(88, cw / 3 - 30);
      var gap = (cw - bw * 3) / 4;

      // 网格线
      ctx.strokeStyle = '#eee3cf';
      ctx.lineWidth = 1;
      for (var g = 0; g <= 4; g++) {
        var gy = padT + plotH * (g / 4);
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padL, gy); ctx.stroke();
      }

      data.forEach(function (d, i) {
        var bh = plotH * (d.value / maxV) * t;
        var x = padL + gap + i * (bw + gap);
        var y = padT + plotH - bh;
        var grad = ctx.createLinearGradient(0, y, 0, padT + plotH);
        if (i === 0) { grad.addColorStop(0, '#d9bc8a'); grad.addColorStop(1, '#efe2c8'); }
        else if (i === 1) { grad.addColorStop(0, '#c07f37'); grad.addColorStop(1, '#e8cf9f'); }
        else { grad.addColorStop(0, '#c0605a'); grad.addColorStop(1, '#eec3b8'); }
        roundRect(ctx, x, y, bw, bh, 10);
        ctx.fillStyle = grad; ctx.fill();

        ctx.fillStyle = '#3f2d20';
        ctx.font = '700 15px ' + chartFonts;
        ctx.textAlign = 'center';
        ctx.fillText((d.value * t).toFixed(2) + ' 亿', x + bw / 2, y - 8);

        ctx.fillStyle = '#7c5b3a';
        ctx.font = '12px ' + chartFonts;
        ctx.fillText(d.label, x + bw / 2, padT + plotH + 20);
        ctx.fillStyle = '#a08a6c';
        ctx.font = '11px ' + chartFonts;
        ctx.fillText(d.note, x + bw / 2, padT + plotH + 38);
      });

      // 趋势箭头
      ctx.strokeStyle = 'rgba(192, 96, 90, .55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(padL + gap + bw / 2, padT + plotH * (1 - 1.51 / maxV) - 4);
      ctx.lineTo(padL + gap * 3 + bw * 2.5, padT + plotH * (1 - 7.83 / maxV * t) - 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }
        canvas.height = 300;
    animateChart(canvas, draw);
    redrawFns.push(function (t) { safeRender(canvas, draw, t || 1); });
  })();

  /* ============================================================
     图表二：麦糟营养成分（区间条形图）
     ============================================================ */
  (function nutritionChart() {
    var canvas = $('#nutritionChart');
    if (!canvas) return;

    function draw(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      var data = [
        { name: '膳食纤维', min: 50, max: 70, color: '#7a9a4e' },
        { name: '蛋白质', min: 20, max: 30, color: '#a4682a' },
        { name: '阿拉伯木聚糖', min: 15, max: 25, color: '#e8b45a' },
        { name: '纤维素', min: 15, max: 25, color: '#d9a45b' },
        { name: '木质素', min: 12, max: 28, color: '#9a7b4f' }
      ];
      var maxV = 75;
      var padL = w < 400 ? 88 : 108;
      var padR = w < 400 ? 48 : 60;
      var labelFont = w < 400 ? 12 : 13;
      var rowH = 52, padT = 14;
      var plotW = w - padL - padR;

      // 刻度
      ctx.font = (w < 400 ? '9px ' : '10px ') + chartFonts;
      ctx.fillStyle = '#a08a6c';
      ctx.textAlign = 'center';
      for (var v = 0; v <= maxV; v += 15) {
        var gx = padL + plotW * (v / maxV);
        ctx.fillText(v + '%', gx, h - 4);
        ctx.strokeStyle = '#eee3cf';
        ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, padT + rowH * data.length); ctx.stroke();
      }

      data.forEach(function (d, i) {
        var cy = padT + i * rowH + rowH / 2;
        // 标签
        ctx.fillStyle = '#3f2d20';
        ctx.font = labelFont + 'px ' + chartFonts;
        ctx.textAlign = 'right';
        ctx.fillText(d.name, padL - 12, cy + 4);
        // 底轨
        roundRect(ctx, padL, cy - 11, plotW, 22, 11);
        ctx.fillStyle = '#f1e8d6'; ctx.fill();
        // 区间条
        var x1 = padL + plotW * (d.min / maxV);
        var x2 = padL + plotW * (d.max / maxV) * t;
        if (x2 > x1) {
          roundRect(ctx, x1, cy - 11, Math.max(x2 - x1, 22), 22, 11);
          var grad = ctx.createLinearGradient(x1, 0, x2, 0);
          grad.addColorStop(0, d.color);
          grad.addColorStop(1, shade(d.color, 26));
          ctx.fillStyle = grad; ctx.fill();
        }
        // 数值
        ctx.fillStyle = '#7c4a1e';
        ctx.font = '700 12px ' + chartFonts;
        ctx.textAlign = 'left';
        var maxLabel = (d.min + (d.max - d.min) * t);
        ctx.fillText(d.min + '–' + Math.round(maxLabel) + '%', Math.min(x2 + 8, w - 52), cy + 4);
      });
    }
    canvas.height = 300;
    animateChart(canvas, draw);
    redrawFns.push(function () {
      safeRender(canvas, draw, 1);
    });
  })();

  /* ============================================================
     图表三：餐后血糖曲线对比（机制一）
     ============================================================ */
  (function mechChart1() {
    var canvas = $('#mechChart1');
    if (!canvas) return;

    function draw(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      var padL = 40, padR = 14, padT = 18, padB = 40;
      var plotW = w - padL - padR, plotH = h - padT - padB;
      var maxG = 10, minutes = 180;

      // 坐标轴
      ctx.strokeStyle = '#d9c5a5';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
      ctx.stroke();

      // y 轴刻度
      ctx.font = '10px ' + chartFonts;
      ctx.fillStyle = '#a08a6c';
      ctx.textAlign = 'right';
      for (var g = 0; g <= maxG; g += 2.5) {
        var gy = padT + plotH * (1 - g / maxG);
        ctx.fillText(g.toFixed(1), padL - 6, gy + 3);
        ctx.strokeStyle = '#f0e7d4';
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + plotW, gy); ctx.stroke();
      }
      // x 轴刻度：窄屏拉大间隔避免文字重叠
      ctx.textAlign = 'center';
      var step = w < 340 ? 60 : 30;
      for (var m = 0; m <= minutes; m += step) {
        var mx = padL + plotW * (m / minutes);
        ctx.fillText(m + '分', mx, padT + plotH + 16);
      }
      ctx.fillText('餐后时间', padL + plotW / 2, padT + plotH + 32);

      function curve(x) { return padL + plotW * (x / minutes); }

      // 普通饼干曲线
      function normalG(x) {
        return 4.6 + 4.2 * Math.exp(-Math.pow((x - 42) / 26, 2)) + 1.4 * Math.exp(-Math.pow((x - 95) / 55, 2));
      }
      // 麦糟饼干曲线（峰值低、后移、平缓）
      function bsgG(x) {
        return 4.6 + 2.3 * Math.exp(-Math.pow((x - 62) / 34, 2)) + 0.9 * Math.exp(-Math.pow((x - 120) / 60, 2));
      }

      [
        { fn: normalG, color: '#c0605a', label: '普通饼干' },
        { fn: bsgG, color: '#7a9a4e', label: '麦糟饼干' }
      ].forEach(function (line) {
        ctx.beginPath();
        for (var x = 0; x <= minutes * t; x += 2) {
          var y = padT + plotH * (1 - line.fn(x) / maxG);
          if (x === 0) ctx.moveTo(curve(x), y); else ctx.lineTo(curve(x), y);
        }
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.stroke();
      });

      // 图例
      var lx = padL + 12, ly = padT + 10;
      [['#c0605a', '普通饼干'], ['#7a9a4e', '麦糟饼干']].forEach(function (lg, i) {
        ctx.fillStyle = lg[0];
        roundRect(ctx, lx, ly + i * 20, 14, 4, 2); ctx.fill();
        ctx.fillStyle = '#5d4a35';
        ctx.font = '12px ' + chartFonts;
        ctx.textAlign = 'left';
        ctx.fillText(lg[1], lx + 22, ly + i * 20 + 6);
      });
      // 血糖 mmol/L 标注
      ctx.fillStyle = '#a08a6c';
      ctx.font = '10px ' + chartFonts;
      ctx.textAlign = 'center';
      ctx.fillText('血糖 (mmol/L，示意)', padL / 2 + 6, padT + 2);
    }
    canvas.height = 260;
    animateChart(canvas, draw);
    redrawFns.push(function () {
      safeRender(canvas, draw, 1);
    });
  })();

  /* ============================================================
     图表四：六指标权重环形图
     ============================================================ */
  (function weightChart() {
    var canvas = $('#weightChart');
    if (!canvas) return;

    function draw(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      var data = [
        { name: '感官评分', v: 0.30, color: '#a4682a' },
        { name: 'eGI ↓', v: 0.20, color: '#c0605a' },
        { name: '膳食纤维', v: 0.15, color: '#7a9a4e' },
        { name: '总酚', v: 0.15, color: '#e8b45a' },
        { name: '硬度 ↓', v: 0.10, color: '#3e8f8a' },
        { name: '蛋白质', v: 0.10, color: '#7a6ba8' }
      ];
      var cx = w / 2, cy = h / 2 - 8;
      /* 半径下限保底：极窄视口下不再出现负半径 */
      var R = Math.max(14, Math.min(w, h) / 2 - 44);
      var r = Math.max(8, R * 0.62);
      var start = -Math.PI / 2;

      data.forEach(function (d, i) {
        var ang = d.v * Math.PI * 2 * t;
        ctx.beginPath();
        ctx.arc(cx, cy, R, start, start + ang);
        ctx.arc(cx, cy, r, start + ang, start, true);
        ctx.closePath();
        ctx.fillStyle = d.color;
        ctx.fill();
        ctx.strokeStyle = '#fffdf8';
        ctx.lineWidth = 2;
        ctx.stroke();
        start += ang;
      });
      // 中心文字
      ctx.fillStyle = '#3f2d20';
      ctx.font = '700 20px ' + chartFonts;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('综合', cx, cy - 10);
      ctx.fillText('评分', cx, cy + 12);
      ctx.textBaseline = 'alphabetic';

      // 图例：窄屏 2 列，宽屏 3 列，避免文字重叠
      var cols = w < 360 ? 2 : 3;
      var legFontSize = w < 300 ? 11 : 12;
      var lx = 12, ly = h - 6;
      ctx.font = legFontSize + 'px ' + chartFonts;
      ctx.textAlign = 'left';
      data.forEach(function (d, i) {
        var col = i % cols, row = Math.floor(i / cols);
        var x = lx + col * (w / cols);
        ctx.fillStyle = d.color;
        roundRect(ctx, x, ly - 30 + row * 18, 10, 10, 2); ctx.fill();
        ctx.fillStyle = '#5d4a35';
        ctx.fillText(d.name + ' ' + (d.v * 100 * t).toFixed(0) + '%', x + 15, ly - 21 + row * 18);
      });
    }
    canvas.height = 340;
    animateChart(canvas, draw);
    redrawFns.push(function () {
      safeRender(canvas, draw, 1);
    });
  })();

  /* ============ 圆角矩形与颜色工具 ============ */
  function roundRect(ctx, x, y, w, h, r) {
    if (h <= 0 || w <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function shade(hex, amt) {
    var num = parseInt(hex.slice(1), 16);
    var r = clamp((num >> 16) + amt, 0, 255);
    var g = clamp(((num >> 8) & 0xff) + amt, 0, 255);
    var b = clamp((num & 0xff) + amt, 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* ============ 机制选项卡 ============ */
  $all('.mech-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var key = tab.getAttribute('data-mech');
      $all('.mech-tab').forEach(function (t2) {
        var on = t2 === tab;
        t2.classList.toggle('is-active', on);
        t2.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $all('.mech-panel').forEach(function (p) {
        var on = p.getAttribute('data-mech-panel') === key;
        p.classList.toggle('is-active', on);
        if (on) { p.removeAttribute('hidden'); } else { p.setAttribute('hidden', ''); }
      });
    });
  });

  /* ============================================================
     BP 神经网络可视化（SVG 动态生成）
     ============================================================ */
  var bpOutputText = null;
  (function bpNet() {
    var svg = $('#bpNetSvg');
    if (!svg) return;
    var edgesG = $('#bpNetEdges'), nodesG = $('#bpNetNodes');
    var W = 640, H = 320;
    var layerX = [90, 320, 560];
    var inputLabels = ['麦糟 A', '油脂 B', '木糖醇 C'];

    var inputY = [90, 160, 230];
    var hiddenY = [];
    var nH = 12;
    for (var i = 0; i < nH; i++) hiddenY.push(38 + i * (244 / (nH - 1)));
    var outY = [160];

    var edgeEls = [];
    // 输入 → 隐层
    inputY.forEach(function (y1) {
      hiddenY.forEach(function (y2) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        el.setAttribute('x1', layerX[0]); el.setAttribute('y1', y1);
        el.setAttribute('x2', layerX[1]); el.setAttribute('y2', y2);
        el.setAttribute('class', 'bp-edge');
        edgesG.appendChild(el);
        edgeEls.push(el);
      });
    });
    // 隐层 → 输出
    hiddenY.forEach(function (y2) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      el.setAttribute('x1', layerX[1]); el.setAttribute('y1', y2);
      el.setAttribute('x2', layerX[2]); el.setAttribute('y2', outY[0]);
      el.setAttribute('class', 'bp-edge');
      edgesG.appendChild(el);
      edgeEls.push(el);
    });

    function node(x, y, label, val, cls) {
      var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 20);
      c.setAttribute('class', 'bp-node' + (cls ? ' ' + cls : ''));
      g.appendChild(c);
      if (label) {
        var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', x - 32); t.setAttribute('y', y + 4);
        t.setAttribute('text-anchor', 'end');
        t.setAttribute('class', 'bp-label');
        t.textContent = label;
        g.appendChild(t);
      }
      if (val !== undefined) {
        var v = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        v.setAttribute('x', x); v.setAttribute('y', y + 5);
        v.setAttribute('text-anchor', 'middle');
        v.setAttribute('class', 'bp-val');
        v.textContent = val;
        if (cls === 'bp-node-out') { v.id = 'bpOutVal'; bpOutputText = v; }
        g.appendChild(v);
      }
      nodesG.appendChild(g);
    }

    inputY.forEach(function (y, i) { node(layerX[0], y, inputLabels[i]); });
    hiddenY.forEach(function (y) { node(layerX[1], y); });
    node(layerX[2], outY[0], '预测评分', '—', 'bp-node-out');

    // 层标题
    [['输入层', layerX[0]], ['隐藏层 ×12', layerX[1]], ['输出层', layerX[2]]].forEach(function (lt) {
      var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', lt[1]); t.setAttribute('y', 305);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'bp-label');
      t.textContent = lt[0];
      nodesG.appendChild(t);
    });

    // 定期随机点亮部分连接，模拟信号流动
    if (!prefersReduced) {
      setInterval(function () {
        var pick = Math.floor(Math.random() * edgeEls.length);
        edgeEls.forEach(function (e) { e.classList.remove('pulse'); });
        for (var k = 0; k < 10; k++) {
          edgeEls[(pick + k * 7) % edgeEls.length].classList.add('pulse');
        }
      }, 1200);
    }
  })();

  function setBpOutput(score) {
    if (bpOutputText) bpOutputText.textContent = Math.round(score);
  }

  /* ============================================================
     配方实验室
     ============================================================ */
  (function lab() {
    var sliderA = $('#labA'), sliderB = $('#labB'), sliderC = $('#labC');
    if (!sliderA) return;
    var outA = $('#labAOut'), outB = $('#labBOut'), outC = $('#labCOut');
    var gaugeArc = $('#gaugeArc'), gaugeNum = $('#gaugeNum');
    var barFiber = $('#barFiber'), barProtein = $('#barProtein'), barEgi = $('#barEgi');
    var outFiber = $('#outFiber'), outProtein = $('#outProtein'), outEgi = $('#outEgi');
    var verdict = $('#labVerdict'), hint = $('#labHint');

    /* 简化的"机理模型"：基于课题先验规律（倒U型响应 + 线性效应） */
    function model(A, B, C) {
      // 感官评分：麦糟呈倒U（峰值约16%），油脂、木糖醇各呈宽倒U
      var sA = 0.74 + 0.28 * Math.exp(-Math.pow((A - 16) / 6.5, 2))
        - 0.38 * Math.pow(Math.max(0, (A - 22) / 8), 1.4);
      var sB = 0.80 + 0.20 * Math.exp(-Math.pow((B - 25) / 9, 2));
      var sC = 0.88 + 0.12 * Math.exp(-Math.pow((C - 12) / 3, 2));
      var sensory = clamp(100 * (0.52 * sA + 0.27 * sB + 0.21 * sC), 5, 99);
      // 膳食纤维 g/100g：随麦糟线性上升
      var fiber = 2.0 + A * 0.55;
      // 蛋白质 g/100g
      var protein = 6.5 + A * 0.22;
      // eGI：随麦糟下降，随糖醇略降
      var egi = clamp(73 - 0.9 * A - 0.06 * B - 0.35 * C, 40, 78);
      // 综合评分（课题权重：感官0.30 / eGI0.20 / 纤维0.15 / 总酚0.15 / 硬度0.10 / 蛋白0.10）
      var composite =
        0.30 * (sensory / 100) +
        0.20 * ((78 - egi) / 38) +
        0.15 * clamp(fiber / 19, 0, 1) +
        0.15 * clamp(A / 30, 0, 1) +      // 总酚近似随麦糟上升
        0.10 * clamp((sensory / 100), 0, 1) + // 硬度低≈感官好，简化
        0.10 * clamp(protein / 13.5, 0, 1);
      return {
        sensory: sensory, fiber: fiber, protein: protein,
        egi: egi, composite: composite * 100
      };
    }

    function verdictText(m, A) {
      if (A <= 4) return '👅 几乎没有麦糟：口感像普通饼干，但"健康属性"还没上线。';
      if (m.sensory < 60) return '😬 当前配方口感堪忧：纤维太多、油脂失衡，饼干可能又硬又糙。';
      if (m.sensory >= 60 && m.sensory < 78) return '🙂 中规中矩：能吃，但还没到让人回购的水平。';
      if (m.egi > 60) return '😋 口感在线，但控糖属性一般——试试再增加一些麦糟？';
      if (m.sensory >= 78 && m.egi <= 60) return '🏆 口感与控糖兼得！这已经是接近"甜点区"的优秀配方。';
      return '🤔 一个有意思的平衡点。';
    }

    function render(animGauge) {
      var A = parseFloat(sliderA.value);
      var B = parseFloat(sliderB.value);
      var C = parseFloat(sliderC.value);
      outA.textContent = A + '%';
      outB.textContent = B + '%';
      outC.textContent = (C % 1 === 0 ? C : C.toFixed(1)) + '%';

      var m = model(A, B, C);

      // 仪表盘
      var arcLen = 251; // 半圆弧长
      var frac = m.sensory / 100;
      if (prefersReduced || !animGauge) {
        gaugeArc.style.transition = 'none';
      } else {
        gaugeArc.style.transition = 'stroke-dashoffset .5s cubic-bezier(.22,.8,.35,1)';
      }
      gaugeArc.style.strokeDashoffset = String(arcLen * (1 - frac));
      animateNumber(gaugeNum, parseFloat(gaugeNum.textContent) || 0, m.sensory);
      setBpOutput(m.sensory);

      // 指标条
      barFiber.style.width = clamp(m.fiber / 19 * 100, 2, 100) + '%';
      barProtein.style.width = clamp(m.protein / 13.5 * 100, 2, 100) + '%';
      barEgi.style.width = clamp((m.egi - 38) / 42 * 100, 2, 100) + '%';
      outFiber.textContent = m.fiber.toFixed(1) + 'g';
      outProtein.textContent = m.protein.toFixed(1) + 'g';
      outEgi.textContent = m.egi.toFixed(0);

      verdict.textContent = verdictText(m, A);
    }

    function animateNumber(el, from, to) {
      if (prefersReduced) { el.textContent = Math.round(to); return; }
      var t0 = performance.now(), dur = 400;
      (function tick(now) {
        var t = clamp((now - t0) / dur, 0, 1);
        el.textContent = Math.round(lerp(from, to, t));
        if (t < 1) requestAnimationFrame(tick);
      })(t0);
    }

    [sliderA, sliderB, sliderC].forEach(function (s) {
      s.addEventListener('input', function () { render(true); });
    });

    /* 网格搜索寻优（模拟 GA/PSO 结果） */
    function optimize() {
      var best = null;
      for (var A = 0; A <= 30; A += 0.5) {
        for (var B = 15; B <= 35; B += 0.5) {
          for (var C = 8; C <= 16; C += 0.5) {
            var m = model(A, B, C);
            if (!best || m.composite > best.m.composite) {
              best = { A: A, B: B, C: C, m: m };
            }
          }
        }
      }
      return best;
    }

    $('#labOptimize').addEventListener('click', function () {
      var best = optimize();
      hint.textContent = '🤖 算法正在收敛…寻找"Pareto 前沿"上的精英配方…';
      if (prefersReduced) {
        sliderA.value = best.A; sliderB.value = best.B; sliderC.value = best.C;
        render(false);
        finishOptimize(best);
        return;
      }
      // 平滑滑动到最优解
      var startVals = {
        A: parseFloat(sliderA.value), B: parseFloat(sliderB.value), C: parseFloat(sliderC.value)
      };
      var t0 = performance.now(), dur = 1400;
      (function tween(now) {
        var t = clamp((now - t0) / dur, 0, 1);
        var ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        sliderA.value = lerp(startVals.A, best.A, ease);
        sliderB.value = lerp(startVals.B, best.B, ease);
        sliderC.value = lerp(startVals.C, best.C, ease);
        render(false);
        if (t < 1) {
          requestAnimationFrame(tween);
        } else {
          finishOptimize(best);
        }
      })(t0);
    });

    function finishOptimize(best) {
      hint.textContent = '✅ AI 推荐：麦糟 ' + fmt(best.A) + '% · 油脂 ' + fmt(best.B) +
        '% · 木糖醇 ' + fmt(best.C) + '%（综合评分 ' + best.m.composite.toFixed(1) +
        ' / 100）。注意"最优"不止一个——真实课题会给出整条 Pareto 前沿供选择。';
    }
    function fmt(v) { return (v % 1 === 0) ? v : v.toFixed(1); }

    $('#labReset').addEventListener('click', function () {
      sliderA.value = 15; sliderB.value = 25; sliderC.value = 12;
      render(true);
      hint.textContent = '提示：试试把麦糟加到 30%，看看口感评分会发生什么。';
    });

    render(false);
  })();

  /* ============ FAQ：同组只展开一个（可选的体验优化） ============ */
  $all('.faq-item').forEach(function (item) {
    item.addEventListener('toggle', function () {
      if (item.open) {
        $all('.faq-item').forEach(function (other) {
          if (other !== item) other.open = false;
        });
      }
    });
  });

})();
