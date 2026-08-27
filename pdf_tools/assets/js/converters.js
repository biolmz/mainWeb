/* ============================================================
   PDF 工具箱 — docx / xlsx 转换器
   手写 Office Open XML 最小结构（依赖 JSZip 打包）
   ============================================================ */
"use strict";

const Converters = (() => {
  function xmlEscape(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    }[c]));
  }

  function jsonToXml(json) {
    return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n" + json;
  }

  /* ================= docx 生成 ================= */
  function buildDocxDocumentXml(pagesText) {
    const body = pagesText
      .map((text, i) => {
        const head = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第 ${i + 1} 页</w:t></w:r></w:p>`;
        const lines = String(text || "（本页无文本）")
          .split("\n")
          .map(
            (line) =>
              `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`
          )
          .join("");
        return head + lines;
      })
      .join("");

    return jsonToXml(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`
    );
  }

  function buildDocxZip(pagesText) {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      jsonToXml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
      )
    );
    zip.file(
      "_rels/.rels",
      jsonToXml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
      )
    );
    zip.file("word/document.xml", buildDocxDocumentXml(pagesText));
    return zip;
  }

  /* ================= xlsx 生成 ================= */
  function colName(n) {
    // 1 -> A, 27 -> AA
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function buildSheetXml(table) {
    const rows = table
      .map((row, ri) => {
        const cells = row
          .map((val, ci) => {
            const v = String(val == null ? "" : val);
            if (!v) return `<c r="${colName(ci + 1)}${ri + 1}"/>`;
            return `<c r="${colName(ci + 1)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    return jsonToXml(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
    );
  }

  function buildXlsxZip(sheets) {
    // sheets: [{ name, table: string[][] }]
    const zip = new JSZip();

    const sheetOverrides = sheets
      .map((_, i) => {
        const f = "sheet" + (i + 1);
        return `<Override PartName="/xl/worksheets/${f}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
      })
      .join("");

    zip.file(
      "[Content_Types].xml",
      jsonToXml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}</Types>`
      )
    );
    zip.file(
      "_rels/.rels",
      jsonToXml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
      )
    );

    const sheetEntries = sheets
      .map((s, i) => {
        const f = "sheet" + (i + 1);
        return `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
      })
      .join("");
    zip.file(
      "xl/workbook.xml",
      jsonToXml(
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`
      )
    );

    const relEntries = sheets
      .map((_, i) => {
        const f = "sheet" + (i + 1);
        return `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${f}.xml"/>`;
      })
      .join("");
    zip.file(
      "xl/_rels/workbook.xml.rels",
      jsonToXml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries}</Relationships>`
      )
    );

    sheets.forEach((s, i) => {
      zip.file("xl/worksheets/sheet" + (i + 1) + ".xml", buildSheetXml(s.table));
    });

    return zip;
  }

  /* ================= PDF 文本项 → 表格聚类 =================
     items: [{ str, x, y }]，y 为 pdf.js 坐标（自底部向上）
     返回二维数组
  */
  function clusterToTable(items, opts = {}) {
    const Y_TOL = opts.yTol || 6;
    const X_TOL = opts.xTol || 8;

    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of sorted) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(it.y - last.y) <= Y_TOL) {
        last.items.push(it);
      } else {
        rows.push({ y: it.y, items: [it] });
      }
    }

    const xs = [];
    for (const r of rows) for (const it of r.items) xs.push(it.x);
    xs.sort((a, b) => a - b);
    const cols = [];
    for (const x of xs) {
      const last = cols[cols.length - 1];
      if (last != null && x - last <= X_TOL) continue;
      cols.push(x);
    }

    const table = rows.map((r) => {
      const rowArr = new Array(cols.length).fill("");
      for (const it of r.items) {
        let ci = 0;
        for (let i = 0; i < cols.length; i++) {
          if (Math.abs(it.x - cols[i]) <= X_TOL) { ci = i; break; }
          if (it.x > cols[i]) ci = i;
        }
        rowArr[ci] = (rowArr[ci] ? rowArr[ci] + " " : "") + it.str;
      }
      return rowArr;
    });

    // 去掉完全空白的行
    return table.filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  return { buildDocxZip, buildXlsxZip, clusterToTable, xmlEscape };
})();
