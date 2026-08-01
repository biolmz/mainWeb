/**
 * 📝 云端笔记系统 - 核心逻辑
 * 基于腾讯云 COS 的纯前端笔记应用
 */

// ========== 全局状态 ==========
const state = {
    cos: null,            // COS 实例
    config: null,         // COS 配置
    notes: [],            // 笔记列表
    currentNote: null,    // 当前编辑的笔记
    autoSaveTimer: null,  // 自动保存定时器
    isPreview: false,     // 是否预览模式
    isFullscreen: false,  // 是否全屏
    saveQueue: [],        // 保存队列
    isSaving: false,      // 是否正在保存
};

// ========== 配置管理 ==========
const CONFIG_KEY = 'noteSystem_config';
const PASSWORD_KEY = 'noteSystem_password';

function loadConfig() {
    try {
        const saved = localStorage.getItem(CONFIG_KEY);
        if (saved) {
            state.config = JSON.parse(saved);
            initCOS();
            return true;
        }
    } catch (e) {
        console.error('加载配置失败:', e);
    }
    return false;
}

function saveConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    state.config = config;
    initCOS();
}

function initCOS() {
    if (!state.config) return;

    // 使用永久密钥初始化（纯前端方案）
    // ⚠️ 生产环境建议使用临时密钥（STS）
    state.cos = new COS({
        SecretId: state.config.secretId,
        SecretKey: state.config.secretKey,
    });

    showToast('☁️ COS 已连接', 'success');
}

// ========== 认证 ==========
function checkPassword() {
    const pwd = document.getElementById('passwordInput').value.trim();
    const savedPwd = localStorage.getItem(PASSWORD_KEY);

    if (!pwd) {
        showError('请输入密码');
        return;
    }

    // 首次设置密码
    if (!savedPwd) {
        if (pwd.length < 4) {
            showError('密码至少4位');
            return;
        }
        localStorage.setItem(PASSWORD_KEY, pwd);
        loginSuccess();
        return;
    }

    // 验证密码
    if (pwd === savedPwd) {
        loginSuccess();
    } else {
        showError('密码错误');
    }
}

function loginSuccess() {
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');

    // 显示存储桶信息
    if (state.config) {
        document.getElementById('userBucket').textContent = `📦 ${state.config.bucket}`;
        // 加载笔记列表
        loadNotesList();
    } else {
        document.getElementById('userBucket').textContent = '⚙️ 未配置';
        showSettings();
    }
}

function logout() {
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
    document.getElementById('passwordInput').value = '';
    document.getElementById('passwordInput').focus();
}

// ========== 设置管理 ==========
function showSettings() {
    // 填充现有配置
    if (state.config) {
        document.getElementById('configSecretId').value = state.config.secretId || '';
        document.getElementById('configSecretKey').value = state.config.secretKey || '';
        document.getElementById('configBucket').value = state.config.bucket || '';
        document.getElementById('configRegion').value = state.config.region || 'ap-guangzhou';
    }
    const pwd = localStorage.getItem(PASSWORD_KEY);
    if (pwd) {
        document.getElementById('configPassword').value = pwd;
    }

    document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settingsModal').classList.add('hidden');
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

    const config = { secretId, secretKey, bucket, region };
    saveConfig(config);
    localStorage.setItem(PASSWORD_KEY, password);

    document.getElementById('userBucket').textContent = `📦 ${bucket}`;
    closeSettings();
    showToast('✅ 配置已保存', 'success');

    // 重新加载笔记列表
    loadNotesList();
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

    try {
        const testCos = new COS({ SecretId: secretId, SecretKey: secretKey });
        await new Promise((resolve, reject) => {
            testCos.getBucket({
                Bucket: bucket,
                Region: region,
                MaxKeys: 1,
            }, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });
        showToast('✅ 连接成功！COS 配置正确', 'success');
    } catch (err) {
        console.error('连接测试失败:', err);
        showToast(`❌ 连接失败: ${err.message || '未知错误'}`, 'error');
    }
}

function clearAllData() {
    showConfirm('清除所有数据', '确定要清除本地所有配置和缓存吗？这不会删除云端的笔记文件。', () => {
        localStorage.removeItem(CONFIG_KEY);
        localStorage.removeItem(PASSWORD_KEY);
        state.config = null;
        state.cos = null;
        state.notes = [];
        state.currentNote = null;
        showToast('🗑️ 本地数据已清除', 'success');
        setTimeout(() => location.reload(), 1000);
    });
}

// ========== 笔记 CRUD ==========
const NOTES_PREFIX = 'notes/';

function getNoteKey(noteId) {
    return NOTES_PREFIX + noteId + '.json';
}

function generateNoteId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
}

async function loadNotesList() {
    if (!state.cos || !state.config) return;

    try {
        const data = await new Promise((resolve, reject) => {
            state.cos.getBucket({
                Bucket: state.config.bucket,
                Region: state.config.region,
                Prefix: NOTES_PREFIX,
            }, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });

        const notes = [];
        if (data.Contents) {
            for (const item of data.Contents) {
                try {
                    const noteData = await new Promise((resolve, reject) => {
                        state.cos.getObject({
                            Bucket: state.config.bucket,
                            Region: state.config.region,
                            Key: item.Key,
                        }, (err, data) => {
                            if (err) reject(err);
                            else resolve(data);
                        });
                    });

                    // COS SDK 返回的 Body 可能是 ArrayBuffer 或 Blob
                    let content;
                    if (typeof noteData.Body === 'string') {
                        content = noteData.Body;
                    } else if (noteData.Body instanceof ArrayBuffer) {
                        content = new TextDecoder('utf-8').decode(noteData.Body);
                    } else if (noteData.Body instanceof Blob) {
                        content = await noteData.Body.text();
                    } else {
                        content = String(noteData.Body);
                    }
                    const note = JSON.parse(content);
                    note.size = item.Size;
                    note.cosKey = item.Key;
                    notes.push(note);
                } catch (e) {
                    console.warn('解析笔记失败:', item.Key, e);
                }
            }
        }

        // 按更新时间排序
        notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        state.notes = notes;
        renderNotesList();

        // 更新存储信息
        updateStorageInfo();

    } catch (err) {
        console.error('加载笔记列表失败:', err);
        showToast(`❌ 加载失败: ${err.message}`, 'error');
    }
}

function renderNotesList(filter = '') {
    const container = document.getElementById('notesList');
    const query = filter.toLowerCase().trim();

    let notes = state.notes;
    if (query) {
        notes = notes.filter(n =>
            (n.title || '').toLowerCase().includes(query) ||
            (n.content || '').toLowerCase().includes(query)
        );
    }

    if (notes.length === 0) {
        container.innerHTML = `<div class="empty-state">${query ? '🔍 无匹配结果' : '暂无笔记，点击上方按钮创建'}</div>`;
        return;
    }

    container.innerHTML = notes.map(note => {
        const isActive = state.currentNote && state.currentNote.id === note.id;
        const preview = (note.content || '').replace(/[#*`>\[\]\-]/g, '').substring(0, 60);
        const date = formatDate(note.updatedAt || note.createdAt);
        const size = formatSize(note.size || 0);
        const unsavedMark = (state.currentNote && state.currentNote.id === note.id && state.currentNote.unsaved) ? '<span class="note-item-unsaved"></span>' : '';

        return `
            <div class="note-item ${isActive ? 'active' : ''}" onclick="openNote('${note.id}')">
                <div class="note-item-title">${unsavedMark}${escapeHtml(note.title || '无标题')}</div>
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
    const query = document.getElementById('searchInput').value;
    renderNotesList(query);
}

function createNewNote() {
    // 如果有未保存的当前笔记，先保存
    if (state.currentNote && state.currentNote.unsaved) {
        saveCurrentNote();
    }

    const note = {
        id: generateNoteId(),
        title: '新建笔记',
        content: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        unsaved: true,
    };

    state.currentNote = note;
    state.notes.unshift(note);
    renderNotesList(document.getElementById('searchInput').value);
    showEditor(note);
    showToast('📝 已创建新笔记', 'success');
}

function openNote(noteId) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;

    // 保存当前笔记
    if (state.currentNote && state.currentNote.unsaved) {
        saveCurrentNote();
    }

    state.currentNote = { ...note };
    renderNotesList(document.getElementById('searchInput').value);
    showEditor(state.currentNote);
}

function showEditor(note) {
    document.getElementById('emptyEditor').classList.add('hidden');
    document.getElementById('editorContainer').classList.remove('hidden');

    document.getElementById('noteTitle').value = note.title || '';
    document.getElementById('noteContent').value = note.content || '';

    updateWordCount();
    updateSaveStatus('unsaved', '未保存');
    renderPreview();
}

function deleteCurrentNote() {
    if (!state.currentNote) return;

    const noteId = state.currentNote.id;
    const noteTitle = state.currentNote.title || '无标题';

    showConfirm('删除笔记', `确定要删除「${noteTitle}」吗？此操作不可恢复。`, async () => {
        try {
            const key = getNoteKey(noteId);
            await new Promise((resolve, reject) => {
                state.cos.deleteObject({
                    Bucket: state.config.bucket,
                    Region: state.config.region,
                    Key: key,
                }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            // 从本地移除
            state.notes = state.notes.filter(n => n.id !== noteId);
            state.currentNote = null;

            // 重置编辑器
            document.getElementById('emptyEditor').classList.remove('hidden');
            document.getElementById('editorContainer').classList.add('hidden');
            document.getElementById('noteTitle').value = '';
            document.getElementById('noteContent').value = '';

            renderNotesList(document.getElementById('searchInput').value);
            updateStorageInfo();
            showToast('🗑️ 笔记已删除', 'success');

        } catch (err) {
            console.error('删除失败:', err);
            showToast(`❌ 删除失败: ${err.message}`, 'error');
        }
    });
}

// ========== 自动保存 ==========
function autoSave() {
    if (!state.currentNote) return;

    // 更新当前笔记数据
    state.currentNote.title = document.getElementById('noteTitle').value || '无标题';
    state.currentNote.content = document.getElementById('noteContent').value;
    state.currentNote.updatedAt = Date.now();
    state.currentNote.unsaved = true;

    updateWordCount();
    updateSaveStatus('unsaved', '待保存...');

    // 实时预览
    renderPreview();

    // 防抖保存（3秒后自动保存）
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(() => {
        saveCurrentNote();
    }, 3000);
}

async function saveCurrentNote() {
    if (!state.currentNote || !state.cos || !state.config) return;
    if (!state.currentNote.unsaved) return;

    const note = state.currentNote;
    note.updatedAt = Date.now();

    try {
        updateSaveStatus('saving', '⏳ 保存中...');

        const key = getNoteKey(note.id);
        const jsonStr = JSON.stringify({
            id: note.id,
            title: note.title,
            content: note.content,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
        });

        // 使用 Blob 确保 UTF-8 编码正确（支持中文）
        const body = new Blob([jsonStr], { type: 'application/json; charset=utf-8' });

        await new Promise((resolve, reject) => {
            state.cos.putObject({
                Bucket: state.config.bucket,
                Region: state.config.region,
                Key: key,
                Body: body,
                ContentType: 'application/json; charset=utf-8',
            }, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });

        // 更新本地状态
        note.unsaved = false;
        const index = state.notes.findIndex(n => n.id === note.id);
        if (index >= 0) {
            state.notes[index] = { ...note };
        } else {
            state.notes.unshift({ ...note });
        }

        // 重新排序
        state.notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

        updateSaveStatus('saved', '✅ 已保存');
        document.getElementById('lastSaved').textContent = `最后保存: ${formatTime(Date.now())}`;

        // 更新列表
        renderNotesList(document.getElementById('searchInput').value);
        updateStorageInfo();

    } catch (err) {
        console.error('保存失败:', err);
        updateSaveStatus('error', '❌ 保存失败');
        showToast(`❌ 保存失败: ${err.message}`, 'error');
    }
}

function updateSaveStatus(cls, text) {
    const el = document.getElementById('saveStatus');
    el.className = cls;
    el.textContent = text;
}

function updateWordCount() {
    const content = document.getElementById('noteContent').value;
    const count = content.length;
    document.getElementById('wordCount').textContent = `${count} 字`;
}

// ========== 预览功能 ==========
function togglePreview() {
    state.isPreview = !state.isPreview;
    const previewPane = document.getElementById('previewPane');
    const btn = document.getElementById('previewBtn');

    if (state.isPreview) {
        previewPane.classList.remove('hidden');
        renderPreview();
        btn.textContent = '✏️ 编辑';
        btn.classList.add('active');
    } else {
        previewPane.classList.add('hidden');
        btn.textContent = '👁️ 预览';
        btn.classList.remove('active');
    }
}

function renderPreview() {
    const content = document.getElementById('noteContent').value;
    const previewPane = document.getElementById('previewPane');
    if (!previewPane || previewPane.classList.contains('hidden')) return;

    try {
        let html = marked.parse(content || '*开始写作...*');
        // 代码高亮
        previewPane.innerHTML = html;
        previewPane.querySelectorAll('pre code').forEach(block => {
            hljs.highlightElement(block);
        });
    } catch (e) {
        previewPane.innerHTML = '<p style="color:red">预览渲染错误</p>';
    }
}

// ========== 全屏功能 ==========
function toggleFullscreen() {
    state.isFullscreen = !state.isFullscreen;
    const editorArea = document.querySelector('.editor-area');
    const btn = document.getElementById('fullscreenBtn');

    if (state.isFullscreen) {
        editorArea.classList.add('fullscreen');
        btn.textContent = '🔲 退出全屏';
    } else {
        editorArea.classList.remove('fullscreen');
        btn.textContent = '⛶ 全屏';
    }
}

// ========== 同步滚动 ==========
function syncScroll(source, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const percentage = source.scrollTop / (source.scrollHeight - source.clientHeight);
    target.scrollTop = percentage * (target.scrollHeight - target.clientHeight);
}

// ========== 存储信息 ==========
function updateStorageInfo() {
    if (!state.notes.length) {
        document.getElementById('storageInfo').textContent = '';
        return;
    }

    const totalSize = state.notes.reduce((sum, n) => sum + (n.size || 0), 0);
    document.getElementById('storageInfo').textContent = `${state.notes.length} 篇 · ${formatSize(totalSize)}`;
}

// ========== 刷新 ==========
function refreshNotesList() {
    showToast('🔄 正在刷新...', 'info');
    loadNotesList();
}

// ========== 工具函数 ==========
function formatDate(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    if (isToday) return `今天 ${formatTime(timestamp)}`;
    if (isYesterday) return `昨天 ${formatTime(timestamp)}`;

    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatTime(timestamp) {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== Toast 通知 ==========
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toast.classList.remove('hidden');

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => {
            toast.classList.add('hidden');
            toast.style.animation = '';
        }, 300);
    }, 3000);
}

function showError(msg) {
    document.getElementById('loginError').textContent = msg;
    setTimeout(() => {
        document.getElementById('loginError').textContent = '';
    }, 3000);
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

// ========== 键盘快捷键 ==========
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S 手动保存
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (state.currentNote) {
            state.currentNote.unsaved = true;
            saveCurrentNote();
            showToast('💾 已手动保存', 'success');
        }
    }

    // Ctrl/Cmd + N 新建笔记
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        createNewNote();
    }

    // Ctrl/Cmd + P 预览
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        togglePreview();
    }

    // Esc 关闭弹窗
    if (e.key === 'Escape') {
        closeSettings();
        closeConfirm();
        if (state.isFullscreen) toggleFullscreen();
    }
});

// ========== 页面离开前保存 ==========
window.addEventListener('beforeunload', (e) => {
    if (state.currentNote && state.currentNote.unsaved) {
        e.preventDefault();
        e.returnValue = '有未保存的更改，确定要离开吗？';
        // 尝试同步保存
        saveCurrentNote();
    }
});

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
    // 加载配置
    const hasConfig = loadConfig();

    // 检查是否已设置密码
    const savedPwd = localStorage.getItem(PASSWORD_KEY);
    if (!savedPwd) {
        // 首次使用，显示设置
        document.getElementById('loginOverlay').classList.remove('hidden');
        // 不自动弹出设置，等用户设置密码后
    }

    // 回车登录
    document.getElementById('passwordInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') checkPassword();
    });

    // 配置项回车保存
    const configInputs = ['configSecretId', 'configSecretKey', 'configBucket', 'configPassword'];
    configInputs.forEach(id => {
        document.getElementById(id).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveSettings();
        });
    });

    console.log('%c📝 云端笔记系统已就绪', 'color: #4F46E5; font-size: 16px; font-weight: bold;');
    console.log('%c💡 快捷键: Ctrl+S 保存 | Ctrl+N 新建 | Ctrl+P 预览', 'color: #64748B;');
});
