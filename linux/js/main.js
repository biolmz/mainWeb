/* Linux in Browser - 核心逻辑: v86 + xterm.js 双模式 */
"use strict";

const CONFIG = {
  tinycore: {
    title: "TinyCore Linux · gcc 工具链",
    memory_size: 768 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    wasm_path: "vendor/v86.wasm",
    bios: { url: "vendor/seabios.bin" },
    vga_bios: { url: "vendor/vgabios.bin" },
    bzimage: { url: "images/tinycore/vmlinuz" },
    initrd: { url: "images/tinycore/core-gcc.gz" },
    cmdline: "console=ttyS0,38400 tsc=reliable mitigations=off random.trust_cpu=on",
    filesystem: null
  },
  "9p": {
    title: "9P 文件系统实验 · virtio-9p 挂载宿主目录",
    memory_size: 768 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    wasm_path: "vendor/v86.wasm",
    bios: { url: "vendor/seabios.bin" },
    vga_bios: { url: "vendor/vgabios.bin" },
    bzimage: { url: "images/9p/vmlinuz-9p" },
    initrd: { url: "images/9p/core9p.gz" },
    cmdline: "console=ttyS0,38400 tsc=reliable mitigations=off random.trust_cpu=on",
    filesystem: {
      baseurl: "images/9p/base/",
      basefs: "images/9p/fs.json"
    }
  }
};

let emulator = null;
let term = null;
let fitAddon = null;
let currentMode = "tinycore";
let serialBuffer = "";      // 内核日志缓冲
let bootLog = "";           // 完整启动日志
let bootMsgShown = true;
let ready = false;

const $ = (id) => document.getElementById(id);

/* ---------------- xterm ---------------- */
function initTerminal() {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
    theme: {
      background: "#0b0e14",
      foreground: "#d4e0f0",
      cursor: "#60a5fa",
      selectionBackground: "rgba(96,165,250,.3)"
    },
    scrollback: 5000,
    convertEol: false
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($("terminal"));
  fitAddon.fit();
  term.write("\x1b[2J\x1b[H");
  term.write("\x1b[1;33m[Linux in Browser]\x1b[0m 正在初始化模拟器...\r\n");
  term.onData((data) => {
    if (emulator) emulator.serial0_send(data);
  });
  window.addEventListener("resize", () => { if (fitAddon) fitAddon.fit(); });
}

/* ---------------- 状态与进度 ---------------- */
function setStatus(text, cls) {
  const el = $("vm-status");
  el.textContent = text;
  el.className = "status-badge" + (cls ? " " + cls : "");
}
function showBootMsg(show) {
  $("boot-msg").classList.toggle("hidden", !show);
  bootMsgShown = show;
}
function setProgress(cur, total, label) {
  const pct = total > 0 ? Math.min(100, Math.round(cur / total * 100)) : 0;
  $("progress-bar").style.width = pct + "%";
  const mb = (v) => (v / 1048576).toFixed(1);
  $("progress-text").textContent = label + " " + mb(cur) + " MB / " + mb(total) + " MB (" + pct + "%)";
}

/* ---------------- v86 ---------------- */
function createV86(mode) {
  const cfg = JSON.parse(JSON.stringify(CONFIG[mode]));
  cfg.autostart = true;
  cfg.disable_keyboard = true;
  cfg.screen_container = null; // 仅用串口终端
  emulator = new V86(cfg);

  emulator.add_listener("emulator-ready", () => {
    setStatus("已就绪", "running");
    term.write("\x1b[32m[ok]\x1b[0m 模拟器就绪，内核启动中...\r\n");
  });
  emulator.add_listener("cpu-init-error", (e) => {
    setStatus("CPU 初始化错误", "error");
    term.write("\x1b[31m[err]\x1b[0m " + e + "\r\n");
  });
  emulator.add_listener("download-progress", (info) => {
    const file = info && info.file_name ? info.file_name : "";
    const cur = info ? info.loaded : 0;
    const total = info ? info.total : 0;
    setProgress(cur, total, "下载 " + String(file).split("/").pop());
  });
  emulator.add_listener("serial0-output-byte", (byte) => {
    if (byte === 0) return;
    const ch = String.fromCharCode(byte);
    serialBuffer += ch;
    if (serialBuffer.length > 200000) serialBuffer = serialBuffer.slice(-200000);
    term.write(ch);
  });
}

function stopV86() {
  if (emulator) {
    try { emulator.destroy(); } catch (e) {}
    emulator = null;
  }
}

function startVM(mode) {
  stopV86();
  currentMode = mode;
  serialBuffer = "";
  term.reset();
  $("term-title").textContent = CONFIG[mode].title + " (serial console → xterm.js)";
  $("p9panel").style.display = mode === "9p" ? "" : "none";
  setStatus("加载镜像中…", "");
  showBootMsg(true);
  setProgress(0, 1, "准备中");
  // 让 UI 先刷新
  setTimeout(() => {
    createV86(mode);
    // 预置提示
    term.write("\r\n\x1b[1;36m>>> 正在启动 TinyCore Linux (WASM x86 模拟) ...\x1b[0m\r\n");
    term.write(">>> 启动完成后会自动登录 root，即可使用 gcc / make / vi\r\n\r\n");
    setStatus("启动中…", "");
  }, 50);
}

/* ---------------- 发送命令 ---------------- */
function sendStr(s) {
  if (emulator) emulator.serial0_send(s);
}
function typeCmd(cmd) {
  // 模拟输入命令 + 回车
  sendStr(cmd + "\n");
  return cmd;
}

/* ---------------- 示例实验 ---------------- */
function renderLabs() {
  const box = $("lab-buttons");
  box.innerHTML = "";
  LABS.forEach((lab) => {
    const b = document.createElement("button");
    b.className = "lab-item";
    const name = document.createElement("div");
    name.className = "lab-name";
    name.textContent = "▸ " + lab.name;
    const desc = document.createElement("div");
    desc.className = "lab-desc";
    desc.textContent = lab.desc;
    b.appendChild(name);
    b.appendChild(desc);
    b.onclick = () => runLab(lab);
    box.appendChild(b);
  });
}

function runLab(lab) {
  if (!emulator || !ready) {
    term.write("\x1b[31m系统尚未就绪，请等待启动完成。\x1b[0m\r\n");
    return;
  }
  if (lab.extra) {
    typeCmd(lab.extra);
    return;
  }
  // 1. 写入源码
  sendStr("mkdir -p /opt/labs && cat > /opt/labs/" + lab.file + " <<'TCEOF'\n" + lab.code + "\nTCEOF\n");
  // 2. 编译 + 运行
  setTimeout(() => {
    typeCmd("cd /opt/labs && gcc -O2 -Wall " + lab.file + " -o " + lab.file.replace(/\.c$/, "") + (lab.file === "threads.c" ? " -lpthread" : "") + " && ./" + lab.file.replace(/\.c$/, ""));
  }, 400);
}

/* ---------------- 模式切换 ---------------- */
function switchMode(mode) {
  if (mode === currentMode && emulator) { term.write("\r\n[已在此模式]\r\n"); return; }
  $("btn-tinycore").classList.toggle("active", mode === "tinycore");
  $("btn-9p").classList.toggle("active", mode === "9p");
  startVM(mode);
}

/* ---------------- 就绪检测 ---------------- */
function detectReady() {
  // 检测 shell 提示符出现 (root@box 或 "# ")
  const m = serialBuffer.match(/(root@[^:]+:[^#]*# |tc@[^:]+:[^$]*\$ )$/);
  if (m && !ready) {
    ready = true;
    showBootMsg(false);
    setStatus("运行中", "running");
    term.write("\r\n\x1b[1;32m=== 系统就绪！可用 gcc / g++ / make 编译 C 程序 ===\x1b[0m\r\n");
    term.write("试试右侧的【操作系统实验】按钮，或输入: cd /root/labs && ls\r\n\r\n");
  }
}

setInterval(detectReady, 800);

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $("btn-tinycore").onclick = () => switchMode("tinycore");
  $("btn-9p").onclick = () => switchMode("9p");
  $("btn-start").onclick = () => startVM(currentMode);
  $("btn-clear").onclick = () => term.reset();
  $("btn-reboot").onclick = () => {
    if (emulator && ready) { ready = false; typeCmd("reboot -f"); }
    else startVM(currentMode);
  };
  $("btn-save-log").onclick = () => {
    const blob = new Blob([serialBuffer], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "boot-log-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("btn-dmesg").onclick = () => { if (ready) typeCmd("dmesg | tail -20"); };
  $("btn-9p-mount").onclick = () => {
    if (!ready) { term.write("\x1b[31m系统未就绪\x1b[0m\r\n"); return; }
    // 已挂载则跳过挂载, 直接列出; 避免重复挂载报错
    typeCmd("grep -q ' /mnt/9p ' /proc/mounts || mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p; echo '--- /mnt/9p ---'; ls -la /mnt/9p");
  };
  $("btn-9p-ls").onclick = () => { if (ready) typeCmd("ls -la /mnt/9p 2>/dev/null || echo '未挂载, 先点 mount'"); };
}

/* ---------------- 启动 ---------------- */
window.addEventListener("DOMContentLoaded", () => {
  initTerminal();
  renderLabs();
  bindEvents();
  startVM("tinycore");
});
