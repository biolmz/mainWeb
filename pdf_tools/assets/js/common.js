/* ============================================================
   PDF 工具箱 — 公共工具函数（无依赖）
   ============================================================ */
"use strict";

const PDFTools = (() => {
  /* ---------------- 导航高亮 ---------------- */
  function initNav(activePage) {
    document.querySelectorAll(".nav-links a[data-page]").forEach((a) => {
      if (a.dataset.page === activePage) a.classList.add("active");
    });
  }

  /* ---------------- 主题（暗色/亮色） ---------------- */
  function initTheme() {
    const KEY = "pdf-tools-theme";
    const root = document.documentElement;

    function apply(theme) {
      root.dataset.theme = theme;
      localStorage.setItem(KEY, theme);
      const btn = document.querySelector(".theme-btn");
      if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
    }

    let theme = localStorage.getItem(KEY);
    if (theme !== "light" && theme !== "dark") {
      theme =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    }
    root.dataset.theme = theme;

    const nav = document.querySelector(".nav-links");
    if (nav && !nav.querySelector(".theme-btn")) {
      const btn = document.createElement("button");
      btn.className = "theme-btn";
      btn.type = "button";
      btn.title = "切换亮色 / 暗色主题";
      btn.textContent = theme === "dark" ? "☀️" : "🌙";
      btn.addEventListener("click", () => {
        apply(root.dataset.theme === "dark" ? "light" : "dark");
      });
      nav.appendChild(btn);
    }
  }

  /* ---------------- 文件大小格式化 ---------------- */
  function formatBytes(bytes, digits = 1) {
    if (bytes === 0) return "0 B";
    if (bytes == null || isNaN(bytes)) return "-";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : digits) + " " + sizes[i];
  }

  /* ---------------- 时间格式化 ---------------- */
  function pad(n) { return String(n).padStart(2, "0"); }

  function timestamp(prefix = "") {
    const d = new Date();
    return (
      prefix +
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "_" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  /* ---------------- 范围解析 ----------------
     支持 "1-3,5,7-9" / "2,4,6" / "1-10"
     返回有序的 [start, end] 数组（页码从 1 开始）
  */
  function parseRanges(input, totalPages) {
    const parts = String(input || "")
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;

    const ranges = [];
    const seen = new Set();

    for (const part of parts) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10);
        let b = parseInt(m[2], 10);
        if (a > b) [a, b] = [b, a];
        if (a < 1 || b > totalPages) throw new Error(`页码范围 ${part} 超出范围（1-${totalPages}）`);
        ranges.push([a, b]);
        for (let i = a; i <= b; i++) seen.add(i);
      } else if (/^\d+$/.test(part)) {
        const p = parseInt(part, 10);
        if (p < 1 || p > totalPages) throw new Error(`页码 ${p} 超出范围（1-${totalPages}）`);
        ranges.push([p, p]);
        seen.add(p);
      } else {
        throw new Error(`无法识别的范围："${part}"（示例：1-3,5,7-9）`);
      }
    }

    // 合并相邻/重叠区间
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of ranges) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1) {
        last[1] = Math.max(last[1], e);
      } else {
        merged.push([s, e]);
      }
    }
    return merged;
  }

  /* ---------------- 从 ranges 生成页码数组（1 基） ---------------- */
  function rangesToPages(ranges) {
    const pages = [];
    for (const [s, e] of ranges) for (let i = s; i <= e; i++) pages.push(i);
    return pages;
  }

  /* ---------------- 触发浏览器下载 ---------------- */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 400);
  }

  /* ---------------- zip 打包下载 ---------------- */
  async function zipDownload(files, zipName) {
    if (typeof JSZip === "undefined") {
      throw new Error("JSZip 库未加载");
    }
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.blob);
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    downloadBlob(blob, zipName);
  }

  /* ---------------- 安全文件名 ---------------- */
  function safeName(name) {
    return String(name || "file")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_");
  }

  /* ---------------- Toast 提示 ---------------- */
  function toast(message, type = "info", duration = 3200) {
    let wrap = document.querySelector(".toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 350);
    }, duration);
  }

  /* ---------------- 进度条 ---------------- */
  function showProgress(container, text) {
    const wrap = document.createElement("div");
    wrap.className = "progress-wrap";
    wrap.innerHTML =
      '<div class="progress-bar"><div class="fill"></div></div>' +
      '<div class="progress-text"></div>';
    container.appendChild(wrap);
    const fill = wrap.querySelector(".fill");
    const txt = wrap.querySelector(".progress-text");
    const api = {
      set(p, label) {
        fill.style.width = Math.min(100, Math.max(0, p)) + "%";
        if (label != null) txt.textContent = label;
      },
      done(label) {
        fill.style.width = "100%";
        txt.textContent = label || "完成";
        setTimeout(() => wrap.remove(), 1400);
      },
      fail(label) {
        txt.textContent = label || "处理失败";
        setTimeout(() => wrap.remove(), 3000);
      },
    };
    if (text) txt.textContent = text;
    return api;
  }

  /* ---------------- 拖拽上传区 ---------------- */
  /* 返回一个函数：绑定到一个 <input type="file">，dropzone 为可拖拽区域元素 */
  function setupDropzone(dropzone, input, onChange) {
    if (!dropzone || !input) return;
    const handleFiles = (files) => {
      const list = Array.from(files || input.files || []);
      if (onChange) onChange(list);
      else {
        const dt = new DataTransfer();
        list.forEach((f) => dt.items.add(f));
        input.files = dt.files;
      }
    };
    dropzone.addEventListener("click", () => input.click());
    input.addEventListener("change", () => handleFiles(input.files));
    ["dragenter", "dragover"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      })
    );
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) {
        // 将拖入的文件写入 input 以便读取
        const dt = new DataTransfer();
        for (const f of e.dataTransfer.files) dt.items.add(f);
        input.files = dt.files;
        handleFiles(dt.files);
      }
    });
  }

  /* ---------------- 校验 PDF ---------------- */
  function isPdf(file) {
    return !!(
      file &&
      (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
    );
  }

  /* ---------------- 导出 ---------------- */
  return {
    initNav,
    initTheme,
    formatBytes,
    timestamp,
    parseRanges,
    rangesToPages,
    downloadBlob,
    zipDownload,
    safeName,
    toast,
    showProgress,
    setupDropzone,
    isPdf,
  };
})();

/* 页面加载时自动初始化主题（脚本均在 body 底部，DOM 已就绪） */
PDFTools.initTheme();
