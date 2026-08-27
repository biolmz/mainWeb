/* ============================================================
   PDF 工具箱 — PDF 处理封装（依赖 pdf.js / pdf-lib）
   ============================================================ */
"use strict";

const PdfUtils = (() => {
  /* ---------------- 初始化 pdf.js ---------------- */
  function initPdfJs() {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("pdf.js 库未加载，请检查 vendor 目录");
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    return pdfjsLib;
  }

  /* ---------------- 打开 PDF（file 对象 → pdf.js 文档） ---------------- */
  async function openPdf(file, extra = {}) {
    const lib = initPdfJs();
    const buf = await file.arrayBuffer();
    return lib.getDocument({ data: buf, ...extra }).promise;
  }

  /* ---------------- 读取 PDF 页数 ---------------- */
  async function getPageCount(file) {
    const doc = await openPdf(file);
    const n = doc.numPages;
    try { await doc.destroy(); } catch (_) { /* ignore */ }
    return n;
  }

  /* ---------------- 用 pdf-lib 加载 ---------------- */
  async function loadPdfLibFile(file) {
    if (typeof PDFLib === "undefined") {
      throw new Error("pdf-lib 库未加载，请检查 vendor 目录");
    }
    const bytes = await file.arrayBuffer();
    return PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  }

  /* ---------------- 渲染页面到 canvas ---------------- */
  async function renderPageToCanvas(pdf, pageNumber, scale = 1.0, target = null) {
    const page = await pdf.getPage(pageNumber);
    const vp = page.getViewport({ scale });
    const canvas = target || document.createElement("canvas");
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * ratio);
    canvas.height = Math.floor(vp.height * ratio);
    const ctx = canvas.getContext("2d");
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;
    return { canvas, viewport: vp };
  }

  /* ---------------- 提取页面文字（返回每页文本数组） ---------------- */
  async function extractTextByPage(pdf) {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      let prevY = null;
      for (const item of content.items) {
        if (item.str == null) continue;
        if (prevY !== null && Math.abs(item.transform[5] - prevY) > 2) text += "\n";
        text += item.str;
        prevY = item.transform[5];
      }
      pages.push(text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"));
    }
    return pages;
  }

  /* ---------------- 提取 PDF 内嵌图片 ----------------
     返回 [{ key, page, width, height, kind, img }]
     img 为 pdf.js 图像对象（含 data/width/height/kind）
  */
  async function extractImages(pdf, onPage) {
    const OPS = initPdfJs().OPS;
    const results = [];
    const seenKeys = new Set(); // 按图片资源名去重（同一对象被多页引用）

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const opList = await page.getOperatorList();
      const fnArr = opList.fnArray;
      const argsArr = opList.argsArray;

      for (let i = 0; i < fnArr.length; i++) {
        const fn = fnArr[i];
        let img = null;
        let key = null;

        if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject) {
          // 命名的 XObject 图片
          const name = argsArr[i][0];
          key = "x:" + name;
          if (seenKeys.has(key)) continue;
          const obj = page.objs.get(name);
          if (!obj || !obj.data || !obj.width) continue;
          img = obj;
          // 仅保留每种 key 的第一处，但要记录首次出现的页码
          img._firstPage = img._firstPage || p;
        } else if (fn === OPS.paintInlineImageXObject) {
          const raw = argsArr[i][0];
          if (!raw || !raw.data) continue;
          // inline 图片按内容简单去重（前 64 字节 + 尺寸）
          const head = Array.from(raw.data.slice(0, 64)).reduce(
            (acc, v) => (acc * 31 + v) % 2147483647, 0);
          key = "in:" + head + ":" + raw.width + "x" + raw.height;
          if (seenKeys.has(key)) continue;
          img = raw;
        } else {
          continue;
        }

        seenKeys.add(key);
        results.push({
          key,
          page: img._firstPage || p,
          width: img.width,
          height: img.height,
          kind: img.kind,
          img,
        });
      }
      if (onPage) onPage(p, pdf.numPages);
    }
    return results;
  }

  /* ---------------- 将 pdf.js 图像对象转为 canvas ---------------- */
  function imageToCanvas(img) {
    const { width, height, data } = img;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);
    const out = imageData.data;

    // pdf.js Kind 常量：1 = 1bpp 灰度(蒙版), 2 = RGB24, 3 = RGBA32, 4 = 灰度8
    const KIND = initPdfJs().ImageKind;

    if (img.kind === KIND.RGBA_32BPP) {
      out.set(data);
    } else if (img.kind === KIND.RGB_24BPP) {
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        out[j] = data[i];
        out[j + 1] = data[i + 1];
        out[j + 2] = data[i + 2];
        out[j + 3] = 255;
      }
    } else if (img.kind === KIND.GRAYSCALE_8BPP) {
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        out[j] = data[i];
        out[j + 1] = data[i];
        out[j + 2] = data[i];
        out[j + 3] = 255;
      }
    } else if (img.kind === KIND.GRAYSCALE_1BPP) {
      // 1bit 蒙版：按行解包为黑白
      const bytesPerRow = Math.ceil(width / 8);
      const bpp = img.bpc === 8 ? 8 : 1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let v;
          if (bpp === 1) {
            const byte = data[y * bytesPerRow + Math.floor(x / 8)];
            v = byte & (0x80 >> (x % 8)) ? 0 : 255;
          } else {
            v = data[y * bytesPerRow + x] ? 0 : 255;
          }
          const j = (y * width + x) * 4;
          out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
        }
      }
    } else {
      throw new Error("不支持的图像颜色模式 (kind=" + img.kind + ")");
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function canvasToBlob(canvas, mime = "image/png") {
    return new Promise((resolve) => canvas.toBlob(resolve, mime));
  }

  /* ---------------- 导出 ---------------- */
  return {
    initPdfJs,
    openPdf,
    getPageCount,
    loadPdfLibFile,
    renderPageToCanvas,
    extractTextByPage,
    extractImages,
    imageToCanvas,
    canvasToBlob,
  };
})();
