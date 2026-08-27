# 📄 PDF 工具箱

> 纯前端 · 本地处理 · 无需注册 · 文件绝不上传

一个开箱即用的 PDF 处理网站：**合并、拆分、提取页面、提取文字、提取图片、OCR 扫描件识别、PDF 压缩、转 Word / Excel**，全部在浏览器本地完成。支持 **暗色主题**，可一键打包为 **Docker 镜像** 或 **Electron 桌面应用**。

---

## ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 🔗 **PDF 合并** | 多文件按顺序合并，拖拽排序，自动显示每文件页数 |
| ✂️ **PDF 拆分** | 按「每 N 页一份」或「自定义范围」（如 `1-3,5,7-9`），结果可打包 ZIP |
| 📑 **提取页面** | 按范围输入，或可视化缩略图勾选页面组成新文件 |
| 📝 **提取文字** | 逐页提取文本，预览 / 复制 / 导出 TXT（UTF-8 BOM） |
| 🔍 **OCR 扫描件识别** | 识别扫描版 / 图片型 PDF 文字，支持简体中文与英文，SIMD 加速 |
| 🖼️ **提取图片** | 解析 PDF 内嵌图片，去重后预览、逐个下载或打包 ZIP |
| 🗜️ **PDF 压缩** | 重新编码页面为 JPEG，显著减小扫描件体积，压缩率实时展示 |
| 🔄 **转 Word / Excel** | PDF 文本转 .docx；按坐标聚类成表格转 .xlsx（每页一个工作表） |
| 🌙 **暗色主题** | 一键切换，记忆偏好并自动跟随系统主题 |

## 📁 目录结构

```
├── index.html              首页（功能入口 + 使用说明）
├── merge.html              PDF 合并
├── split.html              PDF 拆分
├── extract-pages.html      提取页面
├── extract-text.html       提取文字
├── ocr.html                OCR 扫描件识别
├── extract-images.html     提取图片
├── compress.html           PDF 压缩
├── convert.html            转 Word / Excel
├── about.html              关于
├── assets/
│   ├── css/style.css       全局样式（含暗色主题）
│   └── js/
│       ├── common.js       公共工具（范围解析 / 下载 / ZIP / 进度 / 主题）
│       ├── pdf-utils.js    PDF 处理封装（pdf.js / pdf-lib）
│       └── converters.js   docx / xlsx 生成器
├── vendor/                 前端库（已本地化，离线可用）
│   ├── pdf-lib.min.js      PDF 创建 / 拷贝 / 保存
│   ├── pdf.min.js          PDF 解析与渲染（Mozilla pdf.js）
│   ├── tesseract.min.js    OCR 引擎（Tesseract.js）
│   ├── tesseract-core-*.wasm.js
│   ├── jszip.min.js        ZIP / Office 文档打包
│   └── tessdata/           chi_sim / eng 语言包
├── Dockerfile              构建 nginx 镜像
├── nginx.conf              nginx 站点配置
├── main.js                 Electron 主进程
└── package.json            Electron 依赖与打包配置
```

## 🚀 快速开始

### 方式一：直接打开（最简单）

用 Chrome / Edge / Firefox 直接双击打开 `index.html` 即可使用。

> 提示：`file://` 协议下部分浏览器会限制 Web Worker，OCR 功能建议使用方式二。

### 方式二：本地静态服务器（推荐，功能完整）

需要 Python 或任意静态服务器：

```bash
# Python
cd 项目目录
python -m http.server 8080

# 或 Node
npx serve .
```

访问 `http://localhost:8080`。

### 方式三：Docker 部署

```bash
# 构建镜像
docker build -t pdf-tools .

# 运行
docker run -d -p 8080:80 --name pdf-tools pdf-tools
```

访问 `http://localhost:8080`。镜像基于 `nginx:alpine`，已启用 gzip 与静态资源缓存。

### 方式四：Electron 桌面应用

```bash
# 安装依赖（首次较慢，需下载 Electron）
npm install

# 开发运行
npm start

# 打包安装包（产物在 release/ 目录）
npm run dist:win      # Windows（NSIS + 便携版）
npm run dist:mac      # macOS（DMG）
npm run dist:linux    # Linux（AppImage + deb）
```

## 🛠️ 技术栈

| 库 | 用途 |
|---|---|
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 合并、拆分、提取页面、压缩重建 |
| [pdf.js](https://mozilla.github.io/pdf.js/)（Mozilla） | PDF 解析、页面渲染、文本 / 图片 / 坐标提取 |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | OCR 文字识别（chi_sim / eng） |
| [JSZip](https://stuk.github.io/jszip/) | ZIP 打包、docx / xlsx 生成 |
| 原生 HTML / CSS / JavaScript | 零构建、零后端依赖 |

所有第三方库均下载至 `vendor/` 目录本地引用，**不依赖任何 CDN，可完全离线运行**。

## 🔒 隐私与安全

- 所有操作均在浏览器本地执行，文件**不会上传**到任何服务器
- 关闭页面后文件数据即从内存释放，适合处理合同、证件等敏感材料
- Docker 版本仅提供静态文件服务，不含任何数据上报逻辑

## ⚠️ 使用限制

- 受密码保护（加密）的 PDF 无法处理，请先解除密码
- 扫描版 PDF 无文字层，「提取文字」结果为空属正常，请使用「OCR 识别」
- OCR 首次使用需加载语言包（约 2-5 MB），识别耗时随页数 / 精度增加
- PDF 压缩会将页面栅格化为图片，文字型 PDF 压缩后不可复制、不可搜索
- 转 Word / Excel 为文本提取式转换，不含原排版样式；Excel 表格为坐标近似识别
- 提取图片仅针对内嵌图像对象，背景图与矢量图形不会被提取
- 建议使用最新版 Chrome / Edge / Firefox 处理超大文件

## 📄 许可证

MIT License
