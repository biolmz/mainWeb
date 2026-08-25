/**
 * 星光倒计时
 * 1. 从 countdowns.json 读取倒计时配置并自动渲染
 * 2. 通过网络授时接口校准时间（失败时降级为本地时间并定期重试）
 */

/* ---------------- 网络校时 ---------------- */

// 依次尝试的授时接口（均支持 CORS）
const TIME_APIS = [
  {
    url: "https://timeapi.io/api/time/current/zone?timeZone=Asia/Shanghai",
    parse: (data) => new Date(data.dateTime + "+08:00"),
  },
  {
    url: "https://worldtimeapi.org/api/timezone/Asia/Shanghai",
    parse: (data) => new Date(data.datetime),
  },
];

const SYNC_INTERVAL = 5 * 60 * 1000; // 每 5 分钟重新校时一次
let timeOffset = 0;      // 网络时间 - 本地时间（毫秒）
let synced = false;      // 是否已成功校时

/** 带超时的 fetch */
function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** 从授时服务获取时间偏移量 */
async function syncTime() {
  setSyncStatus("syncing");
  for (const api of TIME_APIS) {
    try {
      const t0 = Date.now();
      const res = await fetchWithTimeout(api.url);
      if (!res.ok) continue;
      const data = await res.json();
      const serverTime = api.parse(data);
      if (!serverTime || isNaN(serverTime.getTime())) continue;
      // 假设往返耗时对称，用中点时刻估算偏移
      const t1 = Date.now();
      timeOffset = serverTime.getTime() - (t0 + (t1 - t0) / 2);
      synced = true;
      setSyncStatus("ok");
      return;
    } catch (e) {
      // 尝试下一个接口
    }
  }
  // 全部失败：使用本地时间，稍后重试
  synced = false;
  setSyncStatus("local");
  setTimeout(syncTime, 30 * 1000);
}

function setSyncStatus(state) {
  const badge = document.getElementById("syncBadge");
  const text = document.getElementById("syncText");
  badge.classList.toggle("local", state === "local");
  text.textContent =
    state === "ok"     ? "已网络校时 · 北京时间" :
    state === "local"  ? "网络校时失败 · 使用本地时间" :
                         "正在网络校时…";
}

/** 当前校准后的时间 */
function now() {
  return new Date(Date.now() + timeOffset);
}

/* ---------------- 倒计时渲染 ---------------- */

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n) => String(n).padStart(2, "0");

const primarySlot = document.getElementById("primarySlot");
const grid = document.getElementById("grid");
let countdowns = []; // { cfg, target, els }

function fmtDateLine(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 主倒计时大卡片 */
function renderPrimary(cfg) {
  const target = new Date(cfg.date);
  const card = document.createElement("div");
  card.className = "primary-card glass";
  card.innerHTML = `
    <span class="primary-tag">重 点 目 标</span>
    <h1 class="primary-name">${cfg.emoji || "🎯"} ${escapeHtml(cfg.name)}</h1>
    <div class="primary-date">📅 ${fmtDateLine(target)} 周${WEEK[target.getDay()]} · ${pad(target.getHours())}:${pad(target.getMinutes())}</div>
    <div class="primary-days">
      <span class="num" data-role="days">--</span>
      <span class="unit">天</span>
    </div>
    <div class="primary-hms">
      <div class="hms-cell"><div class="v" data-role="h">--</div><div class="k">时</div></div>
      <div class="hms-cell"><div class="v" data-role="m">--</div><div class="k">分</div></div>
      <div class="hms-cell"><div class="v" data-role="s">--</div><div class="k">秒</div></div>
    </div>
    <div class="primary-finished" data-role="done" hidden>🎉 目标时刻已到！</div>
    <p class="primary-desc">${escapeHtml(cfg.description || "")}</p>
  `;
  primarySlot.appendChild(card);
  countdowns.push({
    cfg, target,
    els: {
      days: card.querySelector('[data-role="days"]'),
      h: card.querySelector('[data-role="h"]'),
      m: card.querySelector('[data-role="m"]'),
      s: card.querySelector('[data-role="s"]'),
      done: card.querySelector('[data-role="done"]'),
    },
    primary: true,
  });
}

/** 普通倒计时卡片 */
function renderCard(cfg, index) {
  const target = new Date(cfg.date);
  const card = document.createElement("div");
  card.className = "card glass";
  card.style.animationDelay = `${0.2 + index * 0.1}s`;
  card.innerHTML = `
    <div class="card-head">
      <div class="card-emoji">${cfg.emoji || "⏰"}</div>
      <div>
        <div class="card-title">${escapeHtml(cfg.name)}</div>
        <div class="card-date">${fmtDateLine(target)} 周${WEEK[target.getDay()]}</div>
      </div>
    </div>
    <div class="card-days">
      <span class="num" data-role="days">--</span>
      <span class="unit">天后</span>
    </div>
    <div class="card-hms" data-role="hms">--:--:--</div>
    ${cfg.description ? `<div class="card-desc">${escapeHtml(cfg.description)}</div>` : ""}
  `;
  if (cfg.color) card.style.setProperty("--card-accent", cfg.color);
  grid.appendChild(card);
  countdowns.push({
    cfg, target,
    els: {
      days: card.querySelector('[data-role="days"]'),
      hms: card.querySelector('[data-role="hms"]'),
      card,
    },
    primary: false,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** 加载 JSON 配置并渲染 */
async function loadCountdowns() {
  let config;
  try {
    const res = await fetch("countdowns.json?t=" + Date.now());
    config = await res.json();
  } catch (e) {
    primarySlot.innerHTML = `
      <div class="primary-card glass" style="text-align:center">
        <h1 class="primary-name">⚠️ 无法加载 countdowns.json</h1>
        <p class="primary-desc">请通过本地服务器访问本页面（直接双击打开的 file:// 协议下浏览器会拦截 fetch）。</p>
      </div>`;
    return;
  }

  if (config.title) document.title = config.title;

  const list = config.countdowns || [];
  const primary = list.find((c) => c.primary) || list[0];
  const others = list.filter((c) => c !== primary);

  if (primary) renderPrimary(primary);
  others.forEach(renderCard);
}

/* ---------------- 时钟与刷新 ---------------- */

const clockDate = document.getElementById("clockDate");
const clockTime = document.getElementById("clockTime");

function tick() {
  const t = now();

  // 顶部时钟：年月日 + 周几 + 时分秒
  clockDate.innerHTML =
    `${t.getFullYear()} 年 ${t.getMonth() + 1} 月 ${t.getDate()} 日 ` +
    `<span class="week">周${WEEK[t.getDay()]}</span>`;
  clockTime.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;

  // 各倒计时
  for (const item of countdowns) {
    let diff = item.target.getTime() - t.getTime();

    if (diff <= 0) {
      // 已结束 / 已开始
      if (item.primary) {
        item.els.days.parentElement.hidden = true;
        item.els.done.hidden = false;
        item.els.h.parentElement.hidden = true;
        item.els.m.parentElement.hidden = true;
        item.els.s.parentElement.hidden = true;
      } else {
        item.els.days.textContent = "0";
        item.els.hms.textContent = "已开始 🎉";
        item.els.card.classList.add("card-done");
      }
      continue;
    }

    const days = Math.floor(diff / 86400000);
    diff -= days * 86400000;
    const h = Math.floor(diff / 3600000);
    diff -= h * 3600000;
    const m = Math.floor(diff / 60000);
    diff -= m * 60000;
    const s = Math.floor(diff / 1000);

    if (item.primary) {
      item.els.days.textContent = days;
      item.els.h.textContent = pad(h);
      item.els.m.textContent = pad(m);
      item.els.s.textContent = pad(s);
    } else {
      item.els.days.textContent = days;
      item.els.hms.textContent = `${pad(h)} 时 ${pad(m)} 分 ${pad(s)} 秒`;
    }
  }
}

/* ---------------- 启动 ---------------- */

loadCountdowns();
syncTime();
setInterval(syncTime, SYNC_INTERVAL);
tick();
setInterval(tick, 250);
