/**
 * 📝 云端笔记系统 - 核心逻辑 v2.0
 * 腾讯云 COS 纯前端笔记应用
 *
 * 新增/优化：
 * - 多端同步（focus/visibility 检测 + 版本号冲突检测）
 * - 安全性增强（DOMPurify XSS防护 + 密钥遮蔽 + 子账号提示）
 * - 手动保存按钮 + 降低自动保存频率（8秒）
 * - 多文件格式支持（Markdown / TXT / HTML / JSON）
 * - 导入/导出功能
 * - 设备ID标识 + 冲突解决UI
 */

'use strict';

// ========== 全局状态 ==========
const state = {
    cos: null,
    config: null,
    notes: [],
    currentNote: null,
    autoSaveTimer: null,
    autoSaveDelay: 8000,    // 8秒防抖（降低频率）
    isPreview: false,
    isFullscreen: false,
    deviceId: '',
    lastSyncTime: 0,
    syncInterval: null,
    isOnline: navigator.onLine,
    currentFilter: 'all',
    conflictNote: null,      // 冲突时的云端版本
    noteCache: new Map(),    // 笔记内容缓存（避免重复下载）
};

// ========== 常量 ==========
const CONFIG_KEY = 'noteSys_v2_config';
const PWD_KEY = 'noteSys_v2_password';
const DEV_KEY = 'noteSys_v2_deviceId';
const CACHE_KEY = 'noteSys_v2_noteCache';
const NOTES_PREFIX = 'notes/';
const SUPPORTED_FORMATS = {
    markdown: { ext: '.md', mime: 'text/markdown', label: 'MD' },
    text: { ext: '.txt', mime: 'text/plain', label: 'TXT' },
    html: { ext: '.html', mime: 'text/html', label: 'HTML' },
    json: { ext: '.json', mime: 'application/json', label: 'JSON' },
};

// ========== 工具函数 ==========
function log(level, ...args) {
    const styles = {
        info: 'color:#3B82F6;font-weight:bold',
        ok: 'color:#10B981;font-weight:bold',
        warn: 'color:#F59E0B;font-weight:bold',
        err: 'color:#EF4444;font-weight:bold',
    };
    console.log(`%c[Notes ${level}]`, styles[level] || '', ...args);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    if (isToday) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (isYesterday) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function formatTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function getDeviceId() {
    let id = localStorage.getItem(DEV_KEY);
    if (!id) {
        id = 'dev_' + generateId();
        localStorage.setItem(DEV_KEY, id);
    }
    return id;
}

function getNoteKey(note) {
    const id = typeof note === 'string' ? note : note.id;
    return NOTES_PREFIX + id;
}

function detectFormat(content, fallbackTitle = '') {
    if (typeof content !== 'string') return 'text';
    const trimmed = content.trim();
    if (!trimmed) return 'text';
    // JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { JSON.parse(trimmed); return 'json'; } catch(e) {}
    }
    // HTML
    if (/<(html|body|div|p|h[1-6]|span|table|ul|ol)\b/i.test(trimmed) ||
        (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<?xml'))) {
        return 'html';
    }
    // Markdown
    if (/^#{1,6}\s|^[-*+]\s|^>\s|^```|\*\*.*\*\*|\[.*\]\(.*\)/m.test(trimmed)) {
        return 'markdown';
    }
    return 'text';
}

function extractTitle(content, format, fallback = '无标题') {
    if (!content) return fallback;
    const lines = content.split('\n');

    if (format === 'markdown') {
        for (const line of lines) {
            const m = line.match(/^#{1,3}\s+(.+)$/);
            if (m) return m[1].trim().substring(0, 50);
        }
    }
    if (format === 'html') {
        const m = content.match(/<title>(.+?)<\/title>/i);
        if (m) return m[1].trim().substring(0, 50);
        const h = content.match(/<h[1-3][^>]*>(.+?)<\/h[1-3]>/i);
        if (h) return h[1].replace(/<[^>]+>/g, '').trim().substring(0, 50);
    }
    if (format === 'json') {
        try {
            const obj = JSON.parse(content);
            if (obj.title) return String(obj.title).substring(0, 50);
        } catch(e) {}
    }
    // 取第一行非空
    for (const line of lines) {
        const t = line.trim();
        if (t) return t.substring(0, 50);
    }
    return fallback;
}

// ========== COS 封装 ==========
function cosGet(key) {
    return new Promise((resolve, reject) => {
        if (!state.cos || !state.config) {
            reject(new Error('COS 未初始化，请先配置'));
            return;
        }
        state.cos.getObject({
            Bucket: state.config.bucket,
            Region: state.config.region,
            Key: key,
        }, (err, data) => {
            if (err) { reject(err); return; }
            try {
                let content;
                if (typeof data.Body === 'string') {
                    content = data.Body;
                } else if (data.Body instanceof ArrayBuffer) {
                    content = new TextDecoder('utf-8').decode(data.Body);
                } else if (data.Body instanceof Blob) {
                    // 异步但 we're in promise
                    data.Body.text().then(t => resolve(t)).catch(reject);
                    return;
                } else {
                    content = String(data.Body);
                }
                resolve(content);
            } catch(e) {
                reject(e);
            }
        });
    });
}

function cosPut(key, body, contentType) {
    return new Promise((resolve, reject) => {
        if (!state.cos || !state.config) {
            reject(new Error('COS 未初始化，请先配置'));
            return;
        }
        const blob = new Blob([body], { type: (contentType || 'application/octet-stream') + '; charset=utf-8' });
        state.cos.putObject({
            Bucket: state.config.bucket,
            Region: state.config.region,
            Key: key,
            Body: blob,
            ContentType: (contentType || 'application/octet-stream') + '; charset=utf-8',
        }, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
}

function cosDelete(key) {
    return new Promise((resolve, reject) => {
        if (!state.cos || !state.config) {
            reject(new Error('COS 未初始化'));
            return;
        }
        state.cos.deleteObject({
            Bucket: state.config.bucket,
            Region: state.config.region,
            Key: key,
        }, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
}

function cosList(prefix) {
    return new Promise((resolve, reject) => {
        if (!state.cos || !state.config) {
            reject(new Error('COS 未初始化'));
            return;
        }
        const allItems = [];
        const listNext = (marker) => {
            state.cos.getBucket({
                Bucket: state.config.bucket,
                Region: state.config.region,
                Prefix: prefix || '',
                Marker: marker || '',
                MaxKeys: 1000,
            }, (err, data) => {
                if (err) { reject(err); return; }
                if (data.Contents) allItems.push(...data.Contents);
                if (data.IsTruncated === 'true' || data.IsTruncated === true) {
                    listNext(data.NextMarker || (data.Contents && data.Contents[data.Contents.length-1].Key));
                } else {
                    resolve(allItems);
                }
            });
        };
        listNext();
    });
}

// ========== 配置管理 ==========
function loadConfig() {
    try {
        const saved = localStorage.getItem(CONFIG_KEY);
        if (saved) {
            state.config = JSON.parse(saved);
            initCOS();
            return true;
        }
    } catch (e) {
        log('err', '加载配置失败:', e);
    }
    return false;
}

function saveConfigToStorage(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    state.config = config;
    initCOS();
}

function initCOS() {
    if (!state.config) return;
    try {
        state.cos = new COS({
            SecretId: state.config.secretId,
            SecretKey: state.config.secretKey,
        });
        log('ok', 'COS 初始化成功');
    } catch(e) {
        log('err', 'COS 初始化失败:', e);
        state.cos = null;
    }
}

// ========== 认证 ==========
function checkPassword() {
    const pwdInput = document.getElementById('passwordInput');
    const pwd = pwdInput.value.trim();

    if (!pwd) { showError('请输入密码'); return; }

    const savedPwd = localStorage.getItem(PWD_KEY);

    // 首次设置
    if (!savedPwd) {
        if (pwd.length < 4) { showError('密码至少4位'); return; }
        localStorage.setItem(PWD_KEY, pwd);
        loginSuccess();
        return;
    }

    // 验证
    if (pwd === savedPwd) {
        loginSuccess();
    } else {
        showError('密码错误');
        pwdInput.value = '';
        pwdInput.focus();
    }
}

function loginSuccess() {
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');

    if (state.config) {
        document.getElementById('userBucket').textContent = state.config.bucket;
        document.getElementById('loginBucketInfo').textContent = '📦 ' + state.config.bucket;
        document.getElementById('loginBucketInfo').classList.remove('hidden');
        loadNotesList();
        startSyncMonitor();
    } else {
        document.getElementById('userBucket').textContent = '未配置';
        showSettings();
    }
}

function logout() {
    if (state.currentNote && state.currentNote.unsaved) {
        showConfirm('退出确认', '当前有未保存的更改，确定要退出吗？', () => {
            doLogout();
        });
        return;
    }
    doLogout();
}

function doLogout() {
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
    document.getElementById('passwordInput').value = '';
    document.getElementById('passwordInput').focus();
    stopSyncMonitor();
}

// ========== 设置管理 ==========
function showSettings() {
    if (state.config) {
        document.getElementById('configSecretId').value = state.config.secretId || '';
        document.getElementById('configSecretKey').value = state.config.secretKey || '';
        document.getElementById('configBucket').value = state.config.bucket || '';
        document.getElementById('configRegion').value = state.config.region || 'ap-guangzhou';
    }
    const pwd = localStorage.getItem(PWD_KEY);
    if (pwd) document.getElementById('configPassword').value = pwd;

    document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settingsModal').classList.add('hidden');
}

function togglePasswordField(id, btn) {
    const input = document.getElementById(id);
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
    } else {
        input.type = 'password';
        btn.textContent = '👁️';
    }
}

function saveSettings() {
    const secretId = document.getElementById('configSecretId').value.trim();
    const secretKey = document.getElementById('configSecretKey').value.trim();
    const bucket = document.getElementById('configBucket').value.trim();
    const region = document.getElementById('configRegion').value;
    const password = document.getElementById('configPassword').value.trim();

    if (!secretId || !secretKey || !bucket) {
        showToast('请填写完整的 COS 配置信息', 'error');
        return;
    }
    if (!password || password.length < 4) {
        showToast('请设置至少4位访问密码', 'error');
        return;
    }
    // 校验 bucket 格式
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(bucket.split('-').slice(0,-1).join('-')) && !bucket.includes('-')) {
        // 宽松校验，主要提醒
    }
    if (!bucket.includes('-')) {
        showToast('⚠️ Bucket 名称通常包含 APPID 后缀（如 my-bucket-1250000000）', 'warning');
    }

    const config = { secretId, secretKey, bucket, region };
    saveConfigToStorage(config);
    localStorage.setItem(PWD_KEY, password);

    document.getElementById('userBucket').textContent = bucket;
    closeSettings();
    showToast('✅ 配置已保存', 'success');

    loadNotesList();
    startSyncMonitor();
}

async function testConnection() {
    const secretId = document.getElementById('configSecretId').value.trim();
    const secretKey = document.getElementById('configSecretKey').value.trim();
    const bucket = document.getElementById('configBucket').value.trim();
    const region = document.getElementById('configRegion').value;

    if (!secretId || !secretKey || !bucket) {
        showToast('请先填写完整的 COS 配置', 'error');
        return;
    }

    showToast('🔍 正在测试连接...', 'info');
    setSyncStatus('syncing', '测试中...');

    try {
        const testCos = new COS({ SecretId: secretId, SecretKey: secretKey });
        const testKey = NOTES_PREFIX + '__connection_test__.json';
        const testBody = JSON.stringify({ test: true, ts: Date.now() });

        // PUT
        await new Promise((resolve, reject) => {
            testCos.putObject({
                Bucket: bucket, Region: region, Key: testKey,
                Body: new Blob([testBody], { type: 'application/json' }),
                ContentType: 'application/json',
            }, (err, data) => { if (err) reject(err); else resolve(data); });
        });

        // GET
        await new Promise((resolve, reject) => {
            testCos.getObject({
                Bucket: bucket, Region: region, Key: testKey,
            }, (err, data) => { if (err) reject(err); else resolve(data); });
        });

        // DELETE
        await new Promise((resolve, reject) => {
            testCos.deleteObject({
                Bucket: bucket, Region: region, Key: testKey,
            }, (err, data) => { if (err) reject(err); else resolve(data); });
        });

        showToast('✅ 连接成功！COS 配置正确', 'success');
        setSyncStatus('synced', '已连接');
    } catch (err) {
        log('err', '连接测试失败:', err);
        let msg = err.message || '未知错误';
        if (err.statusCode === 403) msg = '403 禁止访问 - 检查密钥权限';
        else if (err.statusCode === 404) msg = '404 存储桶不存在 - 检查 Bucket/Region';
        else if (err.statusCode === 400) msg = '400 请求错误 - 检查参数格式';
        showToast(`❌ 连接失败: ${msg}`, 'error');
        setSyncStatus('error', '连接失败');
    }
}

function clearAllData() {
    showConfirm('清除所有本地数据', '确定要清除本地所有配置和缓存吗？\n\n⚠️ 这不会删除云端的笔记文件。', () => {
        localStorage.removeItem(CONFIG_KEY);
        localStorage.removeItem(PWD_KEY);
        localStorage.removeItem(DEV_KEY);
        localStorage.removeItem(CACHE_KEY);
        state.config = null;
        state.cos = null;
        state.notes = [];
        state.noteCache.clear();
        showToast('🗑️ 本地数据已清除，1秒后刷新...', 'warning');
        setTimeout(() => location.reload(), 1000);
    });
}

// ========== 笔记列表 ==========
async function loadNotesList(force = false) {
    if (!state.cos || !state.config) return;

    setSyncStatus('syncing', '同步中...');

    try {
        const items = await cosList(NOTES_PREFIX);
        const notes = [];

        // 并行获取笔记内容（限制并发）
        const concurrency = 4;
        let idx = 0;
        async function next() {
            while (idx < items.length) {
                const item = items[idx++];
                // 跳过非笔记文件
                if (!item.Key.endsWith('.json') && !item.Key.endsWith('.md') &&
                    !item.Key.endsWith('.txt') && !item.Key.endsWith('.html')) continue;

                try {
                    const content = await cosGet(item.Key);
                    let note;

                    if (item.Key.endsWith('.json')) {
                        try {
                            note = JSON.parse(content);
                        } catch(e) {
                            // JSON 解析失败，当纯文本
                            note = {
                                id: item.Key.replace(NOTES_PREFIX, '').replace('.json', ''),
                                title: '损坏的笔记',
                                content: content,
                                format: 'text',
                                createdAt: Date.parse(item.LastModified) || Date.now(),
                                updatedAt: Date.parse(item.LastModified) || Date.now(),
                            };
                        }
                    } else {
                        const ext = item.Key.split('.').pop();
                        const fmt = ext === 'md' ? 'markdown' : (ext === 'html' ? 'html' : 'text');
                        note = {
                            id: item.Key.replace(NOTES_PREFIX, ''),
                            title: extractTitle(content, fmt),
                            content: content,
                            format: fmt,
                            createdAt: Date.parse(item.LastModified) || Date.now(),
                            updatedAt: Date.parse(item.LastModified) || Date.now(),
                        };
                    }

                    // 确保必要字段
                    if (!note.id) note.id = generateId();
                    if (!note.format) note.format = detectFormat(note.content);
                    if (!note.title) note.title = extractTitle(note.content, note.format);
                    if (!note.createdAt) note.createdAt = Date.now();
                    if (!note.updatedAt) note.updatedAt = Date.now();

                    note.size = item.Size || (note.content ? new Blob([note.content]).size : 0);
                    note.cosKey = item.Key;
                    note.lastModified = item.LastModified;

                    notes.push(note);
                    // 更新缓存
                    state.noteCache.set(note.id, { content: note.content, updatedAt: note.updatedAt });
                } catch(e) {
                    log('warn', '解析笔记失败:', item.Key, e);
                }
            }
        }

        const workers = [];
        for (let i = 0; i < concurrency; i++) workers.push(next());
        await Promise.all(workers);

        // 排序
        notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        state.notes = notes;

        // 持久化缓存
        persistCache();

        renderNotesList();
        updateStorageInfo();
        setSyncStatus('synced', `已同步 ${notes.length} 篇`);
        state.lastSyncTime = Date.now();

    } catch (err) {
        log('err', '加载笔记列表失败:', err);
        if (err.statusCode === 403) {
            showToast('❌ 无权限访问存储桶，请检查密钥', 'error');
        } else if (err.statusCode === 404) {
            showToast('❌ 存储桶不存在，请检查配置', 'error');
        } else {
            showToast(`❌ 同步失败: ${err.message || '网络错误'}`, 'error');
        }
        setSyncStatus('error', '同步失败');
    }
}

function renderNotesList() {
    const container = document.getElementById('notesList');
    const query = (document.getElementById('searchInput').value || '').toLowerCase().trim();

    let notes = state.notes;

    // 筛选格式
    if (state.currentFilter !== 'all') {
        notes = notes.filter(n => n.format === state.currentFilter);
    }

    // 搜索
    if (query) {
        notes = notes.filter(n =>
            (n.title || '').toLowerCase().includes(query) ||
            (n.content || '').toLowerCase().includes(query)
        );
    }

    if (notes.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${query ? '🔍' : '📭'}</div>
                <p>${query ? '无匹配结果' : '暂无笔记'}</p>
                <small>${query ? '试试其他关键词' : '点击上方按钮创建'}</small>
            </div>`;
        return;
    }

    container.innerHTML = notes.map(note => {
        const isActive = state.currentNote && state.currentNote.id === note.id;
        const preview = (note.content || '').replace(/[#*`>\[\]\-_=]/g, '').substring(0, 60);
        const date = formatDate(note.updatedAt || note.createdAt);
        const size = formatSize(note.size || 0);
        const fmt = note.format || 'text';
        const fmtInfo = SUPPORTED_FORMATS[fmt] || SUPPORTED_FORMATS.text;
        const unsavedMark = (state.currentNote && state.currentNote.id === note.id && state.currentNote.unsaved) ?
            '<span class="note-item-unsaved-dot" title="未保存"></span>' : '';

        return `
            <div class="note-item ${isActive ? 'active' : ''}" onclick="openNote('${note.id}')" data-id="${note.id}">
                <div class="note-item-title">
                    ${unsavedMark}
                    <span class="note-item-format ${fmt}">${fmtInfo.label}</span>
                    <span class="note-title-text">${escapeHtml(note.title || '无标题')}</span>
                </div>
                <div class="note-item-preview">${escapeHtml(preview)}</div>
                <div class="note-item-meta">
                    <span class="note-item-date">${date}</span>
                    <span class="note-item-size">${size}</span>
                </div>
            </div>
        `;
    }).join('');
}

function filterNotes() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClear');
    if (input.value) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
    renderNotesList();
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchClear').classList.add('hidden');
    renderNotesList();
}

function setFilter(type, btn) {
    state.currentFilter = type;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else {
        const tab = document.querySelector(`.filter-tab[data-type="${type}"]`);
        if (tab) tab.classList.add('active');
    }
    renderNotesList();
}

// ========== 笔记 CRUD ==========
function createNewNote() {
    // 保存当前
    if (state.currentNote && state.currentNote.unsaved) {
        saveCurrentNote(false);
    }

    const fmt = document.getElementById('noteFormat')?.value || 'markdown';
    const now = Date.now();
    const note = {
        id: generateId(),
        title: '新建笔记',
        content: fmt === 'markdown' ? '# 新建笔记\n\n开始写作...' : '',
        format: fmt,
        createdAt: now,
        updatedAt: now,
        unsaved: true,
        isNew: true,
    };

    state.currentNote = note;
    state.notes.unshift(note);
    renderNotesList();
    showEditor(note);
    showToast('📝 已创建新笔记', 'success');
}

async function openNote(noteId) {
    // 保存当前未保存的
    if (state.currentNote && state.currentNote.unsaved && !state.currentNote.isNew) {
        saveCurrentNote(false);
    }

    const cached = state.notes.find(n => n.id === noteId);
    if (!cached) return;

    // 先显示缓存内容
    state.currentNote = {
        ...cached,
        unsaved: false,
    };
    renderNotesList();
    showEditor(state.currentNote);

    // 后台从云端拉取最新版本
    try {
        const cloudContent = await cosGet(cached.cosKey || getNoteKey(noteId));
        let cloudNote;

        if (cached.cosKey && cached.cosKey.endsWith('.json')) {
            cloudNote = JSON.parse(cloudContent);
        } else {
            const fmt = detectFormat(cloudContent);
            cloudNote = {
                id: noteId,
                title: extractTitle(cloudContent, fmt),
                content: cloudContent,
                format: fmt,
                updatedAt: Date.now(),
            };
        }

        // 比较版本
        const localContent = state.currentNote.content;
        const cloudUpdated = cloudNote.updatedAt || 0;
        const localUpdated = state.currentNote.updatedAt || 0;

        if (cloudUpdated > localUpdated && cloudContent !== localContent) {
            // 云端更新 → 提示冲突
            showConflictDialog(state.currentNote, cloudNote);
        } else if (cloudContent !== localContent) {
            // 本地更新 → 使用本地
            state.currentNote.content = localContent;
        }
    } catch(e) {
        log('warn', '拉取云端版本失败，使用缓存:', e);
    }
}

function showEditor(note) {
    document.getElementById('emptyEditor').classList.add('hidden');
    document.getElementById('editorContainer').classList.remove('hidden');

    document.getElementById('noteTitle').value = note.title || '';
    document.getElementById('noteContent').value = note.content || '';

    const fmtSelect = document.getElementById('noteFormat');
    if (fmtSelect) fmtSelect.value = note.format || 'markdown';

    updateWordCount();
    updateSaveStatus('unsaved', '未保存');
    renderPreview();

    // 移动端自动关闭侧边栏
    if (window.innerWidth <= 768) {
        closeSidebar();
    }

    // 更新移动端标题
    document.getElementById('mobileTitle').textContent = note.title || '无标题';
}

function closeEditor() {
    if (state.currentNote && state.currentNote.unsaved) {
        saveCurrentNote(false);
    }
    state.currentNote = null;
    document.getElementById('emptyEditor').classList.remove('hidden');
    document.getElementById('editorContainer').classList.add('hidden');
    document.getElementById('mobileTitle').textContent = '📝 云端笔记';
    renderNotesList();
}

function deleteCurrentNote() {
    if (!state.currentNote) return;

    const note = state.currentNote;
    const title = note.title || '无标题';

    showConfirm('删除笔记', `确定要删除「${title}」吗？\n\n此操作不可恢复。`, async () => {
        try {
            const key = note.cosKey || getNoteKey(note.id);
            await cosDelete(key);

            state.notes = state.notes.filter(n => n.id !== note.id);
            state.noteCache.delete(note.id);
            persistCache();

            state.currentNote = null;
            document.getElementById('emptyEditor').classList.remove('hidden');
            document.getElementById('editorContainer').classList.add('hidden');

            renderNotesList();
            updateStorageInfo();
            showToast('🗑️ 笔记已删除', 'success');
        } catch (err) {
            log('err', '删除失败:', err);
            showToast(`❌ 删除失败: ${err.message}`, 'error');
        }
    });
}

function duplicateCurrentNote() {
    if (!state.currentNote) return;
    const src = state.currentNote;
    const now = Date.now();
    const dup = {
        id: generateId(),
        title: (src.title || '无标题') + ' (副本)',
        content: src.content || '',
        format: src.format || 'markdown',
        createdAt: now,
        updatedAt: now,
        unsaved: true,
        isNew: true,
    };
    state.currentNote = dup;
    state.notes.unshift(dup);
    renderNotesList();
    showEditor(dup);
    closeNoteMenu();
    showToast('📄 已复制笔记', 'success');
}

function renameCurrentNote() {
    if (!state.currentNote) return;
    const newTitle = prompt('重命名笔记', state.currentNote.title || '');
    if (newTitle !== null && newTitle.trim()) {
        state.currentNote.title = newTitle.trim();
        state.currentNote.unsaved = true;
        document.getElementById('noteTitle').value = newTitle.trim();
        renderNotesList();
        updateSaveStatus('unsaved', '未保存');
    }
    closeNoteMenu();
}

// ========== 自动保存（降低频率） ==========
function onTitleChange() {
    if (!state.currentNote) return;
    state.currentNote.title = document.getElementById('noteTitle').value || '无标题';
    state.currentNote.unsaved = true;
    updateSaveStatus('unsaved', '待保存...');
    scheduleAutoSave();
}

function onContentChange() {
    if (!state.currentNote) return;
    state.currentNote.content = document.getElementById('noteContent').value;
    state.currentNote.format = detectFormat(state.currentNote.content) || state.currentNote.format || 'text';
    state.currentNote.unsaved = true;
    updateWordCount();
    updateSaveStatus('unsaved', '待保存...');
    renderPreview();
    scheduleAutoSave();
}

function scheduleAutoSave() {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(() => {
        saveCurrentNote(false);
    }, state.autoSaveDelay); // 8秒
}

async function manualSave() {
    if (!state.currentNote) {
        showToast('没有正在编辑的笔记', 'warning');
        return;
    }
    if (!state.cos || !state.config) {
        showToast('⚙️ 请先配置 COS 存储', 'warning');
        showSettings();
        return;
    }

    clearTimeout(state.autoSaveTimer);
    await saveCurrentNote(true);
}

async function saveCurrentNote(showToastMsg) {
    if (!state.currentNote) return;
    if (!state.cos || !state.config) return;
    if (!state.currentNote.unsaved && !state.currentNote.isNew) return;

    const note = state.currentNote;
    note.updatedAt = Date.now();
    note.title = document.getElementById('noteTitle').value || note.title || '无标题';

    // 检测格式
    const fmt = detectFormat(note.content) || note.format || 'markdown';
    note.format = fmt;

    updateSaveStatus('saving', '⏳ 保存中...');
    setSaveBtnState('saving', '保存中');

    try {
        let key, body, contentType;

        if (fmt === 'json') {
            // 尝试解析为 JSON，保存原始结构
            try {
                const parsed = JSON.parse(note.content);
                if (!parsed.title && note.title) parsed.title = note.title;
                if (!parsed.updatedAt) parsed.updatedAt = note.updatedAt;
                body = JSON.stringify(parsed, null, 2);
            } catch(e) {
                body = note.content;
            }
            key = NOTES_PREFIX + note.id + '.json';
            contentType = 'application/json';
        } else if (fmt === 'html') {
            body = note.content;
            key = NOTES_PREFIX + note.id + '.html';
            contentType = 'text/html';
        } else if (fmt === 'markdown') {
            // 包装为 JSON 保留元数据
            const payload = {
                id: note.id,
                title: note.title,
                content: note.content,
                format: 'markdown',
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
                deviceId: state.deviceId,
            };
            body = JSON.stringify(payload, null, 2);
            key = NOTES_PREFIX + note.id + '.json';
            contentType = 'application/json';
        } else {
            // text
            body = note.content;
            key = NOTES_PREFIX + note.id + '.txt';
            contentType = 'text/plain';
        }

        await cosPut(key, body, contentType);

        // 更新状态
        note.unsaved = false;
        note.isNew = false;
        note.cosKey = key;
        note.size = new Blob([body]).size;

        // 更新缓存
        state.noteCache.set(note.id, { content: note.content, updatedAt: note.updatedAt });
        persistCache();

        // 更新列表
        const idx = state.notes.findIndex(n => n.id === note.id);
        if (idx >= 0) state.notes[idx] = { ...note };
        state.notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

        updateSaveStatus('saved', '✅ 已保存');
        setSaveBtnState('saved', '已保存');
        document.getElementById('lastSaved').textContent = `最后保存: ${formatTime(Date.now())}`;
        document.getElementById('mobileTitle').textContent = note.title || '无标题';

        renderNotesList();
        updateStorageInfo();

        if (showToastMsg) showToast('💾 已保存到云端', 'success');

        // 3秒后恢复默认按钮状态
        setTimeout(() => {
            if (state.currentNote && !state.currentNote.unsaved) {
                setSaveBtnState('idle', '保存');
            }
        }, 3000);

    } catch (err) {
        log('err', '保存失败:', err);
        let msg = err.message || '未知错误';
        if (err.statusCode === 403) msg = '无权限（检查密钥）';
        else if (err.statusCode === 400) msg = '请求格式错误';
        else if (!state.isOnline) msg = '当前离线，无法保存';

        updateSaveStatus('error', '❌ 保存失败');
        setSaveBtnState('error', '失败');
        if (showToastMsg) showToast(`❌ 保存失败: ${msg}`, 'error');
    }
}

function changeNoteFormat() {
    if (!state.currentNote) return;
    const newFmt = document.getElementById('noteFormat').value;
    state.currentNote.format = newFmt;
    state.currentNote.unsaved = true;
    updateSaveStatus('unsaved', '格式已更改，待保存');
    renderPreview();
}

// ========== 冲突解决 ==========
function showConflictDialog(localNote, cloudNote) {
    const choice = confirm(
        `⚠️ 检测到云端有更新的版本！\n\n` +
        `本地修改时间: ${formatTime(localNote.updatedAt)}\n` +
        `云端修改时间: ${formatTime(cloudNote.updatedAt)}\n\n` +
        `点击「确定」→ 加载云端版本\n` +
        `点击「取消」→ 保留本地版本（保存时会覆盖云端）`
    );

    if (choice) {
        // 使用云端版本
        state.currentNote.content = cloudNote.content || cloudNote.body || '';
        state.currentNote.title = cloudNote.title || extractTitle(state.currentNote.content, cloudNote.format || 'text');
        state.currentNote.format = cloudNote.format || detectFormat(state.currentNote.content);
        state.currentNote.updatedAt = cloudNote.updatedAt || Date.now();
        state.currentNote.unsaved = false;

        document.getElementById('noteContent').value = state.currentNote.content;
        document.getElementById('noteTitle').value = state.currentNote.title;
        const fmtSelect = document.getElementById('noteFormat');
        if (fmtSelect) fmtSelect.value = state.currentNote.format;

        updateWordCount();
        updateSaveStatus('saved', '已加载云端版本');
        renderPreview();
        showToast('📥 已加载云端版本', 'info');
    } else {
        state.currentNote.unsaved = true;
        updateSaveStatus('unsaved', '本地版本（将覆盖云端）');
        showToast('📝 保留本地版本，保存时将覆盖云端', 'warning');
    }
}

// ========== 预览 ==========
function togglePreview() {
    state.isPreview = !state.isPreview;
    const previewPane = document.getElementById('previewPane');
    const btn = document.getElementById('previewBtn');
    const mobileBtn = document.getElementById('mobilePreviewBtn');

    if (state.isPreview) {
        previewPane.classList.remove('hidden');
        if (window.innerWidth <= 768) {
            document.getElementById('editorPane').classList.add('hidden');
        }
        renderPreview();
        if (btn) { btn.textContent = '✏️'; btn.classList.add('active'); btn.title = '返回编辑'; }
        if (mobileBtn) mobileBtn.textContent = '✏️';
    } else {
        previewPane.classList.add('hidden');
        document.getElementById('editorPane').classList.remove('hidden');
        if (btn) { btn.textContent = '👁️'; btn.classList.remove('active'); btn.title = '预览'; }
        if (mobileBtn) mobileBtn.textContent = '👁️';
    }
}

function renderPreview() {
    const content = document.getElementById('noteContent').value;
    const previewPane = document.getElementById('previewPane');
    if (!previewPane || previewPane.classList.contains('hidden')) return;

    const fmt = state.currentNote?.format || 'markdown';

    try {
        let html = '';
        if (fmt === 'markdown') {
            html = marked.parse(content || '*开始写作...*');
        } else if (fmt === 'html') {
            html = content;
        } else if (fmt === 'json') {
            try {
                const obj = JSON.parse(content);
                html = '<pre><code>' + escapeHtml(JSON.stringify(obj, null, 2)) + '</code></pre>';
            } catch(e) {
                html = '<pre><code>' + escapeHtml(content) + '</code></pre>';
            }
        } else {
            // text
            html = '<pre style="white-space:pre-wrap;font-family:inherit">' + escapeHtml(content) + '</pre>';
        }

        // XSS 防护
        if (window.DOMPurify) {
            html = DOMPurify.sanitize(html, {
                ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','del','ul','ol','li','blockquote','pre','code','a','img','table','thead','tbody','tr','th','td','hr','input','span','div'],
                ALLOWED_ATTR: ['href','src','alt','title','type','checked','disabled','class'],
            });
        }

        previewPane.innerHTML = html;

        // 代码高亮
        previewPane.querySelectorAll('pre code').forEach(block => {
            if (window.hljs) hljs.highlightElement(block);
        });
    } catch (e) {
        previewPane.innerHTML = '<p style="color:var(--danger)">渲染错误: ' + escapeHtml(e.message) + '</p>';
    }
}

// ========== 全屏 ==========
function toggleFullscreen() {
    state.isFullscreen = !state.isFullscreen;
    const editorArea = document.getElementById('editorArea');
    const btn = document.getElementById('fullscreenBtn');

    if (state.isFullscreen) {
        editorArea.classList.add('fullscreen');
        if (btn) btn.textContent = '🔲';
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    } else {
        editorArea.classList.remove('fullscreen');
        if (btn) btn.textContent = '⛶';
        if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        }
    }
}

// ========== 同步监控 ==========
function startSyncMonitor() {
    stopSyncMonitor();
    // 每 30 秒检查一次
    state.syncInterval = setInterval(() => {
        if (document.hidden) return; // 页面不可见时不检查
        if (!state.isOnline) {
            setSyncStatus('offline', '离线');
            return;
        }
        // 距离上次同步超过 30 秒，静默刷新
        if (Date.now() - state.lastSyncTime > 30000) {
            silentRefresh();
        }
    }, 10000);

    // 网络状态监听
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
}

function stopSyncMonitor() {
    if (state.syncInterval) {
        clearInterval(state.syncInterval);
        state.syncInterval = null;
    }
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
}

function handleOnline() {
    state.isOnline = true;
    showToast('🌐 网络已恢复', 'success');
    setSyncStatus('syncing', '重新同步...');
    silentRefresh();
}

function handleOffline() {
    state.isOnline = false;
    showToast('📴 当前离线，更改将在恢复后同步', 'warning');
    setSyncStatus('offline', '离线');
}

async function silentRefresh() {
    if (!state.cos || !state.config) return;
    try {
        const items = await cosList(NOTES_PREFIX);
        // 检查是否有新笔记或更新
        let hasChanges = false;
        for (const item of items) {
            const id = item.Key.replace(NOTES_PREFIX, '');
            const cached = state.noteCache.get(id);
            const modTime = Date.parse(item.LastModified);

            if (!cached || cached.updatedAt < modTime) {
                hasChanges = true;
                break;
            }
        }

        if (hasChanges) {
            await loadNotesList(true);
        } else {
            state.lastSyncTime = Date.now();
            setSyncStatus('synced', `已同步 ${state.notes.length} 篇`);
        }
    } catch(e) {
        log('warn', '后台同步失败:', e);
    }
}

function forceSync() {
    if (!state.isOnline) {
        showToast('📴 当前离线，无法同步', 'warning');
        return;
    }
    showToast('🔄 正在同步...', 'info');
    setSyncStatus('syncing', '同步中...');
    loadNotesList(true);
}

function setSyncStatus(type, text) {
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncText');
    const btn = document.getElementById('syncBtn');
    if (dot) {
        dot.className = 'sync-dot ' + (type === 'synced' ? 'synced' :
                                        type === 'syncing' ? 'syncing' :
                                        type === 'error' ? 'error' : 'offline');
    }
    if (txt) txt.textContent = text;
    if (btn) {
        if (type === 'syncing') btn.classList.add('spinning');
        else btn.classList.remove('spinning');
    }
}

// ========== UI 状态 ==========
function setSaveBtnState(state_, text) {
    const btn = document.getElementById('saveBtn');
    if (!btn) return;
    btn.className = 'btn-save' + (state_ !== 'idle' ? ' ' + state_ : '');
    const textSpan = btn.querySelector('.save-text');
    const iconSpan = btn.querySelector('.save-icon');
    if (textSpan) textSpan.textContent = text;
    if (iconSpan) {
        if (state_ === 'saving') iconSpan.textContent = '⏳';
        else if (state_ === 'saved') iconSpan.textContent = '✅';
        else if (state_ === 'error') iconSpan.textContent = '❌';
        else iconSpan.textContent = '💾';
    }
}

function updateSaveStatus(cls, text) {
    const el = document.getElementById('saveStatus');
    if (el) { el.className = 'status-item ' + cls; el.textContent = text; }
}

function updateWordCount() {
    const content = document.getElementById('noteContent').value;
    const count = content.length;
    const el = document.getElementById('wordCount');
    if (el) el.textContent = `${count} 字`;
}

function updateStorageInfo() {
    if (!state.notes.length) {
        const el = document.getElementById('storageInfo');
        if (el) el.textContent = '';
        return;
    }
    const total = state.notes.reduce((sum, n) => sum + (n.size || 0), 0);
    const el = document.getElementById('storageInfo');
    if (el) el.textContent = `${state.notes.length} 篇 · ${formatSize(total)}`;
}

// ========== 同步滚动 ==========
function syncScroll(source, targetId) {
    const target = document.getElementById(targetId);
    if (!target || target.classList.contains('hidden')) return;
    const srcScrollRatio = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
    target.scrollTop = srcScrollRatio * Math.max(1, target.scrollHeight - target.clientHeight);
}

// ========== 导入/导出 ==========
function showImportDialog() {
    document.getElementById('importModal').classList.remove('hidden');
    document.getElementById('importList').classList.add('hidden');
    document.getElementById('importArea').classList.remove('hidden');
}

function closeImportDialog() {
    document.getElementById('importModal').classList.add('hidden');
}

async function handleFileImport(event) {
    const files = event.target.files;
    if (!files || !files.length) return;

    const list = document.getElementById('importList');
    list.classList.remove('hidden');
    document.getElementById('importArea').classList.add('hidden');

    list.innerHTML = '<p style="padding:10px;color:var(--text-muted)">正在导入...</p>';

    const imported = [];
    for (const file of files) {
        try {
            const text = await file.text();
            const ext = file.name.split('.').pop().toLowerCase();
            let fmt = 'text';
            if (['md', 'markdown'].includes(ext)) fmt = 'markdown';
            else if (ext === 'html' || ext === 'htm') fmt = 'html';
            else if (ext === 'json') fmt = 'json';
            else fmt = detectFormat(text);

            const now = Date.now();
            const note = {
                id: generateId(),
                title: file.name.replace(/\.[^.]+$/, '').substring(0, 50),
                content: text,
                format: fmt,
                createdAt: now,
                updatedAt: now,
                unsaved: true,
                isNew: true,
            };

            state.notes.unshift(note);
            imported.push(note);
        } catch(e) {
            log('err', '导入失败:', file.name, e);
        }
    }

    renderNotesList();
    updateStorageInfo();

    list.innerHTML = imported.map(n => `
        <div class="import-item">
            <span class="import-item-icon">${n.format === 'markdown' ? '📄' : n.format === 'html' ? '🌐' : n.format === 'json' ? '📊' : '📃'}</span>
            <span class="import-item-name">${escapeHtml(n.title)}</span>
            <span class="import-item-size">${formatSize(n.content.length)}</span>
        </div>
    `).join('');

    showToast(`📥 已导入 ${imported.length} 个文件，记得保存`, 'success');

    // 3秒后关闭弹窗
    setTimeout(() => {
        closeImportDialog();
        // 自动打开第一个
        if (imported.length > 0) {
            state.currentNote = imported[0];
            showEditor(imported[0]);
            saveCurrentNote(false);
        }
    }, 2000);
}

function exportCurrentNote() {
    if (!state.currentNote) return;
    const note = state.currentNote;
    const fmt = note.format || 'markdown';
    const fmtInfo = SUPPORTED_FORMATS[fmt] || SUPPORTED_FORMATS.text;
    let content = note.content;
    let filename = (note.title || 'note').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    let mime = fmtInfo.mime;

    if (fmt === 'json') {
        try {
            const obj = JSON.parse(content);
            content = JSON.stringify(obj, null, 2);
        } catch(e) {}
    }

    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + fmtInfo.ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`📤 已导出: ${filename}${fmtInfo.ext}`, 'success');
    closeNoteMenu();
}

function exportAllNotes() {
    if (!state.notes.length) {
        showToast('没有可导出的笔记', 'warning');
        return;
    }

    showToast(`📤 正在导出 ${state.notes.length} 篇笔记...`, 'info');

    state.notes.forEach((note, i) => {
        setTimeout(() => {
            const fmt = note.format || 'text';
            const fmtInfo = SUPPORTED_FORMATS[fmt] || SUPPORTED_FORMATS.text;
            let content = note.content || '';
            if (fmt === 'json') {
                try { content = JSON.stringify(JSON.parse(content), null, 2); } catch(e) {}
            }
            const blob = new Blob([content], { type: fmtInfo.mime + ';charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (note.title || 'note').replace(/[^\w\u4e00-\u9fa5-]/g, '_') + fmtInfo.ext;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, i * 300); // 间隔避免浏览器拦截
    });
}

// ========== 笔记操作菜单 ==========
function showNoteMenu() {
    document.getElementById('noteMenuModal').classList.remove('hidden');
}

function closeNoteMenu() {
    document.getElementById('noteMenuModal').classList.add('hidden');
}

// ========== 侧边栏（移动端） ==========
function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('show');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('show');
}

// ========== Toast ==========
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => { toast.remove(); }, 300);
    }, duration);
}

function showError(msg) {
    const el = document.getElementById('loginError');
    if (el) {
        el.textContent = msg;
        setTimeout(() => { el.textContent = ''; }, 3000);
    }
}

// ========== 确认弹窗 ==========
let confirmCallback = null;

function showConfirm(title, message, callback) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmModal').classList.remove('hidden');
    confirmCallback = callback;
}

function closeConfirm() {
    document.getElementById('confirmModal').classList.add('hidden');
    confirmCallback = null;
}

function executeConfirm() {
    if (confirmCallback) confirmCallback();
    closeConfirm();
}

// ========== 缓存持久化 ==========
function persistCache() {
    try {
        const obj = {};
        for (const [k, v] of state.noteCache) obj[k] = v;
        localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch(e) {
        // localStorage 可能满了，忽略
    }
}

function loadCache() {
    try {
        const saved = localStorage.getItem(CACHE_KEY);
        if (saved) {
            const obj = JSON.parse(saved);
            for (const [k, v] of Object.entries(obj)) {
                state.noteCache.set(k, v);
            }
        }
    } catch(e) {}
}

// ========== 键盘快捷键 ==========
document.addEventListener('keydown', (e) => {
    // 如果焦点在输入框/密码框，不拦截 Enter
    const tag = (e.target.tagName || '').toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

    // Ctrl/Cmd + S → 保存
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        manualSave();
        return;
    }

    // Ctrl/Cmd + N → 新建
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        createNewNote();
        return;
    }

    // Ctrl/Cmd + P → 预览
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        togglePreview();
        return;
    }

    // Esc → 关闭弹窗 / 退出全屏
    if (e.key === 'Escape') {
        closeSettings();
        closeConfirm();
        closeNoteMenu();
        closeImportDialog();
        if (state.isFullscreen) toggleFullscreen();
        if (window.innerWidth <= 768) closeSidebar();
    }

    // Ctrl/Cmd + F → 聚焦搜索
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('searchInput')?.focus();
    }

    // Ctrl/Cmd + E → 导出当前
    if ((e.ctrlKey || e.metaKey) && e.key === 'e' && !isInput) {
        e.preventDefault();
        exportCurrentNote();
    }
});

// ========== 页面生命周期 ==========
window.addEventListener('beforeunload', (e) => {
    if (state.currentNote && state.currentNote.unsaved) {
        // 尝试同步保存
        saveCurrentNote(false);
        e.preventDefault();
        e.returnValue = '有未保存的更改，确定要离开吗？';
    }
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.isOnline) {
        // 页面重新可见，检查更新
        if (Date.now() - state.lastSyncTime > 15000) {
            forceSync();
        }
    }
});

window.addEventListener('focus', () => {
    if (state.isOnline && Date.now() - state.lastSyncTime > 15000) {
        forceSync();
    }
});

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
    // 设备ID
    state.deviceId = getDeviceId();
    log('info', '设备ID:', state.deviceId);

    // 加载缓存
    loadCache();

    // 加载配置
    loadConfig();

    // 检查密码
    const savedPwd = localStorage.getItem(PWD_KEY);
    if (!savedPwd) {
        document.getElementById('loginOverlay').classList.remove('hidden');
    }

    // 回车登录
    document.getElementById('passwordInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') checkPassword();
    });

    // 配置项回车保存
    ['configSecretId', 'configSecretKey', 'configBucket', 'configPassword'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveSettings();
        });
    });

    // 移动端菜单按钮
    document.getElementById('menuBtn')?.addEventListener('click', openSidebar);
    document.getElementById('sidebarOverlay')?.addEventListener('click', closeSidebar);
    document.getElementById('toolbarBack')?.addEventListener('click', closeEditor);
    document.getElementById('mobilePreviewBtn')?.addEventListener('click', togglePreview);
    document.getElementById('mobileSaveBtn')?.addEventListener('click', manualSave);

    // 初始化网络状态
    state.isOnline = navigator.onLine;
    if (!state.isOnline) setSyncStatus('offline', '离线');

    // 配置 marked
    if (window.marked) {
        marked.setOptions({
            breaks: true,
            gfm: true,
            highlight: function(code, lang) {
                if (window.hljs && lang && hljs.getLanguage(lang)) {
                    try { return hljs.highlight(code, { language: lang }).value; }
                    catch(e) {}
                }
                return code;
            }
        });
    }

    log('ok', '📝 云端笔记系统 v2.0 已就绪');
    console.log('%c快捷键: Ctrl+S 保存 | Ctrl+N 新建 | Ctrl+P 预览 | Ctrl+F 搜索 | Ctrl+E 导出', 'color:#64748B');
});
