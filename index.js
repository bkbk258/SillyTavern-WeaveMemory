const MODULE_NAME = 'weaver-vec-memory';
const MEMORY_STORE_KEY = 'weaverVecMemory';
const DISPLAY_NAME = '织法·回响纺锤（v1.2.0）';

let extensionSettings = {};
let memoryState = null;
let isActive = false;
let initialized = false;
let memoryListVisible = false;
let recallPreviewVisible = false;
let calibrationPanelVisible = false;
let memorySearchTerm = '';

const defaultSettings = {
    archiveTriggerTurns: 5,
    decayRate: 0.02,
    maxRetrievedMemories: 4,
    recallPreset: 'standard',
    customRetrievedMemories: 4,
    importanceThreshold: 3,
    enabled: true,
    pauseNextRecall: false,
    calibrationResponseLength: 1200,
    searchMode: 'tfidf',
    apiUrl: 'https://api.siliconflow.cn/v1/embeddings',
    apiModel: 'BAAI/bge-m3',
    apiKey: ''
};

class LocalSearchEngine {
    constructor() {
        this.stopWords = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这']);
    }

    tokenize(text) {
        if (!text) return [];
        const words = [];
        let currentWord = '';

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (/[一-龥]/.test(char)) {
                words.push(char);
                if (currentWord.length > 0) words.push(currentWord + char);
                currentWord = char;
            } else if (/\w/.test(char)) {
                currentWord += char;
            } else {
                if (currentWord && !/[一-龥]/.test(currentWord)) words.push(currentWord.toLowerCase());
                currentWord = '';
            }
        }
        if (currentWord && !/[一-龥]/.test(currentWord)) words.push(currentWord.toLowerCase());

        return words.filter(w => w.trim().length > 0 && !this.stopWords.has(w));
    }

    calculateScore(queryText, memoryItem) {
        const queryTokens = new Set(this.tokenize(queryText));
        let score = 0;

        if (memoryItem.keywords?.length) {
            for (const kw of memoryItem.keywords) {
                if (queryText.includes(kw)) score += 3.0;
            }
        }

        const memoryTokens = this.tokenize(memoryItem.text);
        let overlapCount = 0;
        for (const token of memoryTokens) {
            if (queryTokens.has(token)) overlapCount++;
        }

        if (memoryTokens.length > 0) score += (overlapCount / memoryTokens.length) * 2.0;

        const weightMultiplier = memoryItem.weight || 1.0;
        const importanceBonus = (memoryItem.importance || 5) / 10.0;

        return score * weightMultiplier + importanceBonus;
    }
}

const localSearch = new LocalSearchEngine();

const MANUAL_MEMORY_TEMPLATES = {
    detail: {
        type: 'DETAIL',
        importance: 5,
        keywords: '可回调细节, 关键词',
        text: '一句话写清楚可在后文回调的小细节，例如：char把旧钥匙交给user，并约定危急时用它打开北侧暗门。'
    },
    relation: {
        type: 'RELATION',
        importance: 7,
        keywords: '关系变化, 信任, 关键词',
        text: '一句话写清楚关系从什么状态变成什么状态，例如：user在危机中选择信任char，两人关系从戒备转为初步同盟。'
    },
    item: {
        type: 'ITEM',
        importance: 6,
        keywords: '物品事件, 道具名, 关键词',
        text: '一句话写清楚物品归属、状态或用途，例如：银色怀表已由char交给user，表盖内刻着失踪者的名字。'
    },
    reveal: {
        type: 'HIDE_REVEALED',
        importance: 8,
        keywords: '伏笔揭露, 真相, 关键词',
        text: '一句话写清楚哪个伏笔被揭露、真相是什么，例如：此前反复出现的铃声实际来自封印装置启动前的预警。'
    }
};

const RECALL_PRESET_LIMITS = {
    light: 2,
    standard: 4,
    deep: 6
};

const CALIBRATION_TYPES = ['DETAIL', 'RELATION', 'ITEM', 'ROOT_CLOSED', 'HIDE_REVEALED', 'WORLD_RESOLVED'];

function doInit() {
    if (initialized) return;
    if (typeof window === 'undefined' || !window.SillyTavern) {
        console.error(`[${MODULE_NAME}] window.SillyTavern not found. Cannot initialize.`);
        return;
    }

    const context = window.SillyTavern.getContext();

    context.extensionSettings[MODULE_NAME] = {
        ...defaultSettings,
        ...(context.extensionSettings[MODULE_NAME] || {})
    };
    extensionSettings = context.extensionSettings[MODULE_NAME];

    loadMemoryState();
    buildSettingsUI();

    const eventSource = context.eventSource || window.eventSource;
    const eventTypes = context.eventTypes || window.event_types;

    if (eventSource && eventTypes) {
        eventSource.on(eventTypes.MESSAGE_RECEIVED, handleMessageReceived);
        eventSource.on(eventTypes.MESSAGE_SENT, applyDecay);
        eventSource.on(eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, injectContext);
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, () => {
                loadMemoryState();
                updateMemoryPanel();
            });
        }
        console.log(`[${MODULE_NAME}] Initialized and hooked events successfully`);
    } else {
        console.error(`[${MODULE_NAME}] Failed to hook events. EventSource or EventTypes missing.`);
    }

    isActive = extensionSettings.enabled !== false;
    initialized = true;
}

export async function init() {
    doInit();
}

if (typeof jQuery !== 'undefined') {
    jQuery(() => doInit());
} else if (typeof window !== 'undefined' && window.$) {
    window.$(() => doInit());
}

export function onEnable() {
    isActive = true;
}

export function onDisable() {
    isActive = false;
}

function getContext() {
    return window.SillyTavern.getContext();
}

function createEmptyMemoryState() {
    return {
        version: 2,
        memories: [],
        lastRecall: null,
        lastBackup: null,
        pendingCalibration: null,
        lastUpdated: Date.now()
    };
}

function getLegacyChatKey() {
    const context = getContext();
    if (context.chatId) return context.chatId;
    if (context.characters && context.characterId && context.characters[context.characterId]) {
        return context.characters[context.characterId].name;
    }
    return 'default';
}

function normalizeMemoryItem(item) {
    return {
        id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: String(item.type || 'DETAIL').trim(),
        importance: clampNumber(parseInt(item.importance, 10) || 5, 1, 10),
        keywords: Array.isArray(item.keywords) ? item.keywords.map(k => String(k).trim()).filter(Boolean) : [],
        text: String(item.text || '').trim(),
        sourceTurn: String(item.sourceTurn || '').trim(),
        sourceMessageIndex: Number.isFinite(Number(item.sourceMessageIndex)) ? Number(item.sourceMessageIndex) : null,
        sourceMessageHash: item.sourceMessageHash || '',
        sourceKind: item.sourceKind || 'auto',
        weight: clampNumber(Number(item.weight) || 1.0, 0.1, 1.5),
        timestamp: item.timestamp || Date.now(),
        updatedAt: item.updatedAt || item.timestamp || Date.now(),
        embedding: Array.isArray(item.embedding) ? item.embedding : null,
        embeddingModel: item.embeddingModel || '',
        embeddingUpdatedAt: item.embeddingUpdatedAt || 0
    };
}

function loadMemoryState() {
    const context = getContext();
    context.chatMetadata = context.chatMetadata || {};

    if (!context.chatMetadata[MEMORY_STORE_KEY]) {
        context.chatMetadata[MEMORY_STORE_KEY] = createEmptyMemoryState();
        migrateLegacyMemories(context.chatMetadata[MEMORY_STORE_KEY]);
    }

    memoryState = context.chatMetadata[MEMORY_STORE_KEY];
    memoryState.version = 2;
    memoryState.memories = (memoryState.memories || []).map(normalizeMemoryItem).filter(mem => mem.text);
    memoryState.lastRecall = memoryState.lastRecall || null;
    memoryState.lastBackup = memoryState.lastBackup || null;
    memoryState.pendingCalibration = memoryState.pendingCalibration || null;
    memoryState.lastUpdated = memoryState.lastUpdated || Date.now();
}

function migrateLegacyMemories(targetState) {
    const context = getContext();
    const legacyDB = context.extensionSettings[`${MODULE_NAME}_db`];
    if (!legacyDB || typeof legacyDB !== 'object') return;

    const legacyKeys = [getLegacyChatKey()];
    if (context.characters && context.characterId && context.characters[context.characterId]) {
        legacyKeys.push(context.characters[context.characterId].name);
    }

    for (const key of [...new Set(legacyKeys)]) {
        const legacyMemories = legacyDB[key];
        if (Array.isArray(legacyMemories) && legacyMemories.length > 0) {
            targetState.memories = legacyMemories.map(normalizeMemoryItem).filter(mem => mem.text);
            targetState.lastUpdated = Date.now();
            console.log(`[${MODULE_NAME}] Migrated ${targetState.memories.length} legacy memories from ${key}`);
            break;
        }
    }
}

function getMemoryArray() {
    if (!memoryState) loadMemoryState();
    return memoryState.memories;
}

function saveDB() {
    const context = getContext();
    context.chatMetadata = context.chatMetadata || {};
    memoryState.lastUpdated = Date.now();
    context.chatMetadata[MEMORY_STORE_KEY] = memoryState;

    if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    } else if (typeof context.saveChat === 'function') {
        context.saveChat();
    } else if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
}

function handleMessageReceived(messageId) {
    if (!isActive) return;

    const context = getContext();
    const chat = context.chat || [];

    let msg = null;
    if (typeof messageId === 'number' || typeof messageId === 'string') {
        msg = chat.find(m => m.mes === messageId || m._mesId === messageId);
    }
    if (!msg) msg = chat[chat.length - 1];

    if (msg && !msg.is_user && msg.mes) extractAndStoreMemories(msg.mes, msg);
}

function extractAndStoreMemories(text, message = null, options = {}) {
    if (!text) return 0;

    const sourceMeta = getMessageSourceMeta(message, text);
    if (options.replace !== false) removeMemoriesFromMessage(sourceMeta);

    const archiveRegex = /<VEC_ARCHIVE>([\s\S]*?)<\/VEC_ARCHIVE>/g;
    let match;
    let newMemoriesCount = 0;

    while ((match = archiveRegex.exec(text)) !== null) {
        const blockContent = match[1];
        const lineRegex = /\[VEC\]\s*(.*?)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*)/g;
        let lineMatch;

        while ((lineMatch = lineRegex.exec(blockContent)) !== null) {
            const [, type, importanceStr, keywordsStr, summary, source] = lineMatch;
            const memoryItem = buildMemoryItem(type, importanceStr, keywordsStr, summary, source, sourceMeta, 'auto');
            if (!memoryItem) continue;
            if (isDuplicateMemory(memoryItem)) continue;

            getMemoryArray().push(memoryItem);
            newMemoriesCount++;
        }
    }

    if (newMemoriesCount > 0 || sourceMeta.removedCount > 0) {
        console.log(`[${MODULE_NAME}] Archived ${newMemoriesCount} new memories, removed ${sourceMeta.removedCount} stale memories`);
        saveDB();
        updateMemoryPanel();
    }
    return newMemoriesCount;
}

function getMessageSourceMeta(message, text) {
    const context = getContext();
    const chat = context.chat || [];
    const index = message ? chat.indexOf(message) : chat.length - 1;
    return {
        index: index >= 0 ? index : null,
        hash: simpleHash(text || message?.mes || ''),
        removedCount: 0
    };
}

function removeMemoriesFromMessage(sourceMeta) {
    if (sourceMeta.index === null) return;
    const before = getMemoryArray().length;
    memoryState.memories = getMemoryArray().filter(mem => {
        if (mem.sourceKind === 'manual') return true;
        return mem.sourceMessageIndex !== sourceMeta.index;
    });
    sourceMeta.removedCount = before - memoryState.memories.length;
}

function buildMemoryItem(type, importanceStr, keywordsStr, summary, source, sourceMeta = {}, sourceKind = 'auto') {
    const importance = parseInt(importanceStr, 10);
    const text = String(summary || '').trim();
    const keywords = String(keywordsStr || '').split(',').map(k => k.trim()).filter(Boolean);

    if (!Number.isFinite(importance) || importance < 1 || importance > 10) return null;
    if (importance < extensionSettings.importanceThreshold) return null;
    if (text.length < 6) return null;
    if (keywords.length < 1) return null;
    if (/\[.*?\]|\.\.\.|待补充|示例|内容摘要/.test(text)) return null;

    return normalizeMemoryItem({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        importance,
        keywords,
        text,
        sourceTurn: source,
        sourceMessageIndex: sourceMeta.index,
        sourceMessageHash: sourceMeta.hash,
        sourceKind,
        weight: 1.0,
        timestamp: Date.now(),
        updatedAt: Date.now()
    });
}

function isDuplicateMemory(memoryItem) {
    return getMemoryArray().some(mem => {
        if (mem.sourceTurn && memoryItem.sourceTurn && mem.sourceTurn === memoryItem.sourceTurn && mem.text === memoryItem.text) return true;
        return textSimilarity(mem.text, memoryItem.text) > 0.88;
    });
}

function textSimilarity(a, b) {
    const aTokens = new Set(localSearch.tokenize(a));
    const bTokens = new Set(localSearch.tokenize(b));
    if (!aTokens.size || !bTokens.size) return 0;
    let overlap = 0;
    for (const token of aTokens) if (bTokens.has(token)) overlap++;
    return overlap / Math.max(aTokens.size, bTokens.size);
}

function applyDecay() {
    if (!isActive) return;

    const memories = getMemoryArray();
    const decayFactor = 1.0 - (extensionSettings.decayRate || 0.02);
    let changed = false;

    for (const mem of memories) {
        if (mem.weight > 0.1) {
            mem.weight = Math.max(0.1, mem.weight * decayFactor);
            changed = true;
        }
    }

    if (changed) saveDB();
    updateMemoryPanel();
}

async function injectContext() {
    if (!isActive) return;

    const context = getContext();
    const chat = context.chat || [];
    if (chat.length === 0) return;

    if (extensionSettings.pauseNextRecall) {
        extensionSettings.pauseNextRecall = false;
        saveSettings();
        updatePauseButton();
        clearRecallPrompt(context);
        saveLastRecall({
            status: 'skipped',
            timestamp: Date.now(),
            queryPreview: '',
            memories: [],
            injectionText: '',
            message: '已按用户设置跳过本轮回响，下轮自动恢复。'
        });
        setImportStatus('已跳过本轮回响，下轮自动恢复。', 'info');
        return;
    }

    const recentMessages = chat.slice(-3).map(m => m.mes).join('\n');
    const memories = getMemoryArray();
    if (memories.length === 0) {
        clearRecallPrompt(context);
        saveLastRecall({
            status: 'empty',
            timestamp: Date.now(),
            queryPreview: recentMessages.slice(-240),
            memories: [],
            injectionText: '',
            message: '当前记忆库为空，本轮没有召回。'
        });
        return;
    }

    let retrieved = [];
    if (extensionSettings.searchMode === 'api' && extensionSettings.apiKey) {
        retrieved = await hybridSearchRetriever(recentMessages, memories);
    } else {
        retrieved = localSearchRetriever(recentMessages, memories);
    }

    if (retrieved.length > 0) {
        retrieved.forEach(mem => {
            mem.weight = Math.min(1.0, (mem.weight || 1.0) + 0.2);
            mem.updatedAt = Date.now();
        });
        saveDB();
        updateMemoryPanel();

        let injectionText = `\n<RECALLED_MEMORY>\n`;
        injectionText += `[SYSTEM NOTE: 以下为“织法·回响纺锤”按当前语境召回的历史细节，只作为事实参考。若与当前正文、大总结或角色卡冲突，以当前上下文和大总结为准。]\n`;
        retrieved.forEach(mem => {
            injectionText += `- [${mem.type}｜重要度${mem.importance}｜出处${mem.sourceTurn || '未标注'}] ${mem.text}\n`;
        });
        injectionText += `</RECALLED_MEMORY>\n`;

        saveLastRecall({
            status: 'injected',
            timestamp: Date.now(),
            queryPreview: recentMessages.slice(-240),
            memories: retrieved.map(toRecallSnapshot),
            injectionText
        });

        if (context.setExtensionPrompt) context.setExtensionPrompt(MODULE_NAME, injectionText, 0, 4);
    } else {
        clearRecallPrompt(context);
        saveLastRecall({
            status: 'none',
            timestamp: Date.now(),
            queryPreview: recentMessages.slice(-240),
            memories: [],
            injectionText: '',
            message: '上一轮没有匹配到可召回记忆。'
        });
    }
}

function localSearchRetriever(queryText, memories) {
    return memories
        .map(mem => ({ memory: mem, score: localSearch.calculateScore(queryText, mem) }))
        .filter(item => item.score > 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, getRecallLimit())
        .map(item => item.memory);
}

async function hybridSearchRetriever(queryText, memories) {
    try {
        const localRanked = memories
            .map(mem => ({ memory: mem, score: localSearch.calculateScore(queryText, mem) }))
            .sort((a, b) => b.score - a.score);

        const queryEmbedding = await createEmbedding(queryText);
        await ensureMemoryEmbeddings(memories);

        const vectorRanked = memories
            .filter(mem => Array.isArray(mem.embedding))
            .map(mem => ({ memory: mem, score: cosineSimilarity(queryEmbedding, mem.embedding) }))
            .sort((a, b) => b.score - a.score);

        return fuseRankings(localRanked, vectorRanked)
            .slice(0, getRecallLimit())
            .map(item => item.memory);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Hybrid search failed, falling back to local search:`, error);
        setApiStatus(`向量检索失败，已自动退回本地检索：${getErrorMessage(error)}`, 'error');
        return localSearchRetriever(queryText, memories);
    }
}

function fuseRankings(localRanked, vectorRanked) {
    const scores = new Map();
    const k = 60;

    localRanked.forEach((item, index) => {
        const bonus = item.memory.importance / 10 + (item.memory.weight || 1) * 0.3;
        scores.set(item.memory.id, {
            memory: item.memory,
            score: (1 / (k + index + 1)) + bonus + Math.max(0, item.score) * 0.15
        });
    });

    vectorRanked.forEach((item, index) => {
        const existing = scores.get(item.memory.id);
        const vectorScore = (1 / (k + index + 1)) + Math.max(0, item.score) * 0.8;
        if (existing) {
            existing.score += vectorScore + 0.08;
        } else {
            scores.set(item.memory.id, { memory: item.memory, score: vectorScore });
        }
    });

    return [...scores.values()].sort((a, b) => b.score - a.score);
}

async function ensureMemoryEmbeddings(memories) {
    const missing = memories.filter(mem => !Array.isArray(mem.embedding) || mem.embeddingModel !== extensionSettings.apiModel);
    if (missing.length === 0) return;

    for (const mem of missing) {
        mem.embedding = await createEmbedding(`${mem.type}\n${mem.keywords.join('，')}\n${mem.text}`);
        mem.embeddingModel = extensionSettings.apiModel;
        mem.embeddingUpdatedAt = Date.now();
    }
    saveDB();
}

async function createEmbedding(input) {
    if (!extensionSettings.apiKey) throw new Error('API Key 为空');
    const response = await fetch(extensionSettings.apiUrl || defaultSettings.apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${extensionSettings.apiKey}`
        },
        body: JSON.stringify({
            model: extensionSettings.apiModel || defaultSettings.apiModel,
            input
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`服务商返回 ${response.status}: ${text.slice(0, 160)}`);
    }

    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error('返回结果里没有可用向量');
    return embedding;
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        aNorm += a[i] * a[i];
        bNorm += b[i] * b[i];
    }
    if (!aNorm || !bNorm) return 0;
    return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function buildSettingsUI() {
    const html = `
        <div id="weaver-vec-settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <div>
                        <b>${DISPLAY_NAME}</b>
                        <small class="weaver-author">作者：bk的殿下</small>
                    </div>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="weaver-enable-card">
                        <label class="weaver-enable-label">
                            <input type="checkbox" id="weaver-enabled-toggle">
                            <span><b>启用回响纺锤</b></span>
                        </label>
                        <small>关闭后不会自动收录或注入记忆，也不会执行记忆衰减；已有记忆仍可查看、编辑、导入导出。</small>
                    </div>

                    <div class="memory-status-card">
                        <div id="weaver-memory-count">当前记忆库：<span>0</span> 条记录</div>
                        <div class="weaver-status-buttons">
                            <button id="weaver-memory-toggle" class="menu_button">查看记忆明细</button>
                            <button id="weaver-recall-preview-toggle" class="menu_button">最近召回预览</button>
                            <button id="weaver-pause-next" class="menu_button">暂停下一轮回响</button>
                            <button id="weaver-sync-latest" class="menu_button">同步最新楼层</button>
                            <button id="weaver-rebuild-chat" class="menu_button">重建当前聊天记忆</button>
                            <button id="weaver-calibration-toggle" class="menu_button">大总结校准记忆</button>
                            <button id="weaver-restore-backup" class="menu_button">恢复上一次备份</button>
                            <button id="weaver-manual-add" class="menu_button">手动添加记忆</button>
                            <button id="weaver-memory-export" class="menu_button">导出 JSON</button>
                            <button id="weaver-memory-import" class="menu_button">导入 JSON</button>
                            <button id="weaver-memory-clear" class="menu_button">清空本对话记忆</button>
                        </div>
                    </div>

                    <input type="file" id="weaver-memory-import-file" accept="application/json,.json" style="display: none;">
                    <div id="weaver-backup-info" class="weaver-backup-info"></div>
                    <div id="weaver-memory-import-status"></div>

                    <div id="weaver-recall-preview-panel" style="display: none;">
                        <h4>最近一次召回预览</h4>
                        <div id="weaver-recall-preview-content"></div>
                    </div>

                    <div id="weaver-calibration-panel" style="display: none;">
                        <h4>大总结校准记忆</h4>
                        <small>适合在你手动修正大总结、准备隐藏前文继续聊时使用。大总结会被视为最高事实源；大总结楼层可以是 AI 楼、用户楼或系统式总结楼，只要该楼文本是你确认后的事实基准即可。</small>
                        <div class="weaver-calibration-grid">
                            <label>大总结所在楼层<input id="weaver-calibration-summary-floor" type="number" min="1" class="text_pole" placeholder="例如 100"></label>
                            <label>分段起始楼层<input id="weaver-calibration-start-floor" type="number" min="1" class="text_pole" placeholder="分段时填写"></label>
                            <label>分段结束楼层<input id="weaver-calibration-end-floor" type="number" min="1" class="text_pole" placeholder="分段时填写"></label>
                        </div>
                        <div class="weaver-radio-block">
                            <b>校准范围</b>
                            <label><input type="radio" name="weaver-calibration-range" value="before" checked> 全文校准：处理大总结之前所有旧自动记忆</label>
                            <label><input type="radio" name="weaver-calibration-range" value="range"> 分段校准：只处理上面填写的楼层范围</label>
                        </div>
                        <div class="weaver-radio-block">
                            <b>校准方式</b>
                            <label><input type="radio" name="weaver-calibration-action" value="generate" checked> 用大总结生成新的校准记忆</label>
                            <label><input type="radio" name="weaver-calibration-action" value="clear"> 仅清理旧自动记忆，不新增</label>
                        </div>
                        <div class="weaver-warning">默认保留手动添加记忆；确认写入或清理前会自动备份。</div>
                        <div class="weaver-status-buttons">
                            <button id="weaver-calibration-start" class="menu_button">生成校准预览</button>
                            <button id="weaver-calibration-cancel" class="menu_button">取消</button>
                        </div>
                        <div id="weaver-calibration-preview-panel" style="display: none;">
                            <h4>校准预览</h4>
                            <div id="weaver-calibration-preview-content"></div>
                            <div class="weaver-status-buttons">
                                <button id="weaver-calibration-apply" class="menu_button">确认写入校准记忆</button>
                                <button id="weaver-calibration-discard" class="menu_button">取消预览</button>
                            </div>
                        </div>
                    </div>

                    <div id="weaver-manual-panel" style="display: none;">
                        <h4>手动添加记忆</h4>
                        <select id="weaver-manual-template" class="text_pole">
                            <option value="">选择记忆模板（可选）</option>
                            <option value="relation">关系变化模板</option>
                            <option value="item">物品事件模板</option>
                            <option value="reveal">伏笔揭露模板</option>
                            <option value="detail">可回调细节模板</option>
                        </select>
                        <div class="weaver-manual-grid">
                            <select id="weaver-manual-type" class="text_pole">
                                <option value="DETAIL">DETAIL（可回调细节）</option>
                                <option value="RELATION">RELATION（关系变更）</option>
                                <option value="ITEM">ITEM（物品事件）</option>
                                <option value="ROOT_CLOSED">ROOT_CLOSED（根脉闭环）</option>
                                <option value="HIDE_REVEALED">HIDE_REVEALED（伏笔揭露）</option>
                                <option value="WORLD_RESOLVED">WORLD_RESOLVED（世界线收束）</option>
                            </select>
                            <input id="weaver-manual-importance" type="number" min="1" max="10" value="5" class="text_pole" placeholder="重要度 1-10">
                        </div>
                        <input id="weaver-manual-keywords" class="text_pole" placeholder="关键词，用逗号分隔，例如：信任, 玉佩, 约定">
                        <textarea id="weaver-manual-text" class="text_pole" placeholder="一句话写清楚这个事实，例如：user在危机中选择信任char，两人关系从戒备转为初步信任。"></textarea>
                        <div class="weaver-status-buttons">
                            <button id="weaver-manual-save" class="menu_button">保存手动记忆</button>
                            <button id="weaver-manual-cancel" class="menu_button">取消</button>
                        </div>
                    </div>

                    <div id="weaver-memory-panel" style="display: none;">
                        <input type="text" id="weaver-memory-search" class="text_pole" placeholder="搜索摘要、关键词、类型或出处...">
                        <div id="weaver-memory-list"></div>
                    </div>

                    <div class="set-block">
                        <label><b>检索模式选择</b></label>
                        <select id="weaver-search-mode" class="text_pole">
                            <option value="tfidf">关键词匹配（零配置 / 本地执行）</option>
                            <option value="api">混合检索（关键词 + 语义向量）</option>
                        </select>
                        <small>推荐先用关键词匹配。混合检索需要配置 Embedding API，会自动把关键词和语义结果合并排序。</small>
                    </div>

                    <hr>

                    <div id="weaver-api-settings" style="display: none;">
                        <h4>API 配置（混合检索）</h4>
                        <div class="set-block">
                            <label>API 地址</label>
                            <input type="text" id="weaver-api-url" class="text_pole" placeholder="https://api.siliconflow.cn/v1/embeddings">
                        </div>
                        <div class="set-block">
                            <label>模型名称</label>
                            <input type="text" id="weaver-api-model" class="text_pole" placeholder="BAAI/bge-m3">
                        </div>
                        <div class="set-block">
                            <label>API Key</label>
                            <input type="password" id="weaver-api-key" class="text_pole" placeholder="sk-...">
                        </div>
                        <div class="set-block weaver-api-actions">
                            <button id="weaver-api-test" class="menu_button">测试连接</button>
                            <button id="weaver-regenerate-embeddings" class="menu_button">重新生成缺失向量</button>
                        </div>
                        <div id="weaver-api-status"></div>
                        <hr>
                    </div>

                    <h4>核心参数调节</h4>
                    <div class="set-block">
                        <label><b>召回数量档位</b></label>
                        <select id="weaver-recall-preset" class="text_pole">
                            <option value="light">轻量：2 条</option>
                            <option value="standard">标准：4 条</option>
                            <option value="deep">深度：6 条</option>
                            <option value="custom">自定义</option>
                        </select>
                        <input id="weaver-custom-recall" type="number" min="1" max="10" class="text_pole" style="display:none; margin-top:8px;" placeholder="自定义召回条数">
                        <small>控制每轮最多注入几条回响记忆。条数越多，越容易召回细节，也越容易占用上下文。</small>
                    </div>
                    <div class="set-block flex-container">
                        <label>记忆衰减率 <span id="weaver-decay-val">2</span>%</label>
                        <input type="range" id="weaver-decay" min="0" max="10" value="2">
                        <small>每轮对话后记忆权重的下降比例。被检索命中时权重会恢复。</small>
                    </div>
                    <div class="set-block flex-container">
                        <label>归档重要度阈值 <span id="weaver-thresh-val">3</span></label>
                        <input type="range" id="weaver-thresh" min="1" max="10" value="3">
                        <small>低于此分数的临时细节将被忽略归档。</small>
                    </div>
                </div>
            </div>
        </div>
    `;

    if (window.$) {
        window.$('#extensions_settings').append(html);
        hydrateSettingsUI();
        bindSettingsEvents();
        updateMemoryPanel();
        toggleApiSettings();
    } else {
        console.error(`[${MODULE_NAME}] jQuery ($) not found!`);
    }
}

function hydrateSettingsUI() {
    window.$('#weaver-enabled-toggle').prop('checked', extensionSettings.enabled !== false);
    window.$('#weaver-search-mode').val(extensionSettings.searchMode || 'tfidf');
    window.$('#weaver-api-url').val(extensionSettings.apiUrl || defaultSettings.apiUrl);
    window.$('#weaver-api-model').val(extensionSettings.apiModel || defaultSettings.apiModel);
    window.$('#weaver-api-key').val(extensionSettings.apiKey || '');
    window.$('#weaver-recall-preset').val(extensionSettings.recallPreset || 'standard');
    window.$('#weaver-custom-recall').val(extensionSettings.customRetrievedMemories || extensionSettings.maxRetrievedMemories || 4);
    toggleCustomRecallInput();
    updatePauseButton();
    window.$('#weaver-decay').val((extensionSettings.decayRate || 0.02) * 100);
    window.$('#weaver-decay-val').text((extensionSettings.decayRate || 0.02) * 100);
    window.$('#weaver-thresh').val(extensionSettings.importanceThreshold || 3);
    window.$('#weaver-thresh-val').text(extensionSettings.importanceThreshold || 3);
}

function bindSettingsEvents() {
    window.$('#weaver-enabled-toggle').on('change', function() {
        extensionSettings.enabled = window.$(this).is(':checked');
        isActive = extensionSettings.enabled;
        saveSettings();
        setImportStatus(isActive ? '回响纺锤已启用：会自动收录并注入记忆。' : '回响纺锤已关闭：不会自动收录或注入记忆。', 'info');
    });

    window.$('#weaver-search-mode').on('change', function() {
        extensionSettings.searchMode = window.$(this).val();
        saveSettings();
        toggleApiSettings();
    });

    window.$('#weaver-api-url').on('input', function() { extensionSettings.apiUrl = window.$(this).val(); saveSettings(); });
    window.$('#weaver-api-model').on('input', function() { extensionSettings.apiModel = window.$(this).val(); saveSettings(); });
    window.$('#weaver-api-key').on('input', function() { extensionSettings.apiKey = window.$(this).val(); saveSettings(); });

    window.$('#weaver-api-test').on('click', testApiConnection);
    window.$('#weaver-regenerate-embeddings').on('click', regenerateMissingEmbeddings);

    window.$('#weaver-recall-preset').on('change', function() {
        extensionSettings.recallPreset = window.$(this).val();
        extensionSettings.maxRetrievedMemories = getRecallLimit();
        saveSettings();
        toggleCustomRecallInput();
    });

    window.$('#weaver-custom-recall').on('input', function() {
        const val = clampNumber(parseInt(window.$(this).val(), 10) || 4, 1, 10);
        extensionSettings.customRetrievedMemories = val;
        extensionSettings.maxRetrievedMemories = val;
        saveSettings();
    });

    window.$('#weaver-decay').on('input', function() {
        const val = parseInt(window.$(this).val(), 10);
        window.$('#weaver-decay-val').text(val);
        extensionSettings.decayRate = val / 100.0;
        saveSettings();
    });

    window.$('#weaver-thresh').on('input', function() {
        const val = parseInt(window.$(this).val(), 10);
        window.$('#weaver-thresh-val').text(val);
        extensionSettings.importanceThreshold = val;
        saveSettings();
    });

    window.$('#weaver-memory-toggle').on('click', function() {
        memoryListVisible = !memoryListVisible;
        window.$('#weaver-memory-panel').toggle(memoryListVisible);
        window.$(this).text(memoryListVisible ? '收起记忆明细' : '查看记忆明细');
        renderMemoryList();
    });

    window.$('#weaver-recall-preview-toggle').on('click', function() {
        recallPreviewVisible = !recallPreviewVisible;
        window.$('#weaver-recall-preview-panel').toggle(recallPreviewVisible);
        window.$(this).text(recallPreviewVisible ? '收起召回预览' : '最近召回预览');
        renderRecallPreview();
    });

    window.$('#weaver-pause-next').on('click', function() {
        extensionSettings.pauseNextRecall = !extensionSettings.pauseNextRecall;
        saveSettings();
        updatePauseButton();
        setImportStatus(extensionSettings.pauseNextRecall ? '已设置：下一轮回响会暂停，之后自动恢复。' : '已取消暂停：下一轮会正常注入回响。', 'info');
    });

    window.$('#weaver-calibration-toggle').on('click', function() {
        calibrationPanelVisible = !calibrationPanelVisible;
        window.$('#weaver-calibration-panel').toggle(calibrationPanelVisible);
        window.$(this).text(calibrationPanelVisible ? '收起大总结校准' : '大总结校准记忆');
        renderCalibrationPreview();
    });

    window.$('#weaver-memory-search').on('input', function() {
        memorySearchTerm = window.$(this).val().trim().toLowerCase();
        renderMemoryList();
    });

    window.$('#weaver-memory-export').on('click', exportMemories);
    window.$('#weaver-memory-import').on('click', () => window.$('#weaver-memory-import-file').val('').trigger('click'));
    window.$('#weaver-memory-import-file').on('change', importMemoriesFromFile);
    window.$('#weaver-sync-latest').on('click', syncLatestAssistantMessage);
    window.$('#weaver-rebuild-chat').on('click', rebuildCurrentChatMemories);
    window.$('#weaver-restore-backup').on('click', restoreLastBackup);
    window.$('#weaver-manual-add').on('click', () => window.$('#weaver-manual-panel').slideToggle());
    window.$('#weaver-manual-cancel').on('click', () => window.$('#weaver-manual-panel').slideUp());
    window.$('#weaver-manual-save').on('click', addManualMemory);
    window.$('#weaver-manual-template').on('change', applyManualTemplate);
    window.$('#weaver-calibration-start').on('click', startCalibration);
    window.$('#weaver-calibration-cancel').on('click', () => window.$('#weaver-calibration-panel').slideUp());
    window.$('#weaver-calibration-apply').on('click', confirmCalibrationApply);
    window.$('#weaver-calibration-discard').on('click', cancelCalibrationPreview);

    window.$('#weaver-memory-clear').on('click', function() {
        if (confirm('确定要清空当前对话的所有回响记忆吗？')) {
            createMemoryBackup('清空本对话记忆');
            memoryState.memories = [];
            saveDB();
            updateMemoryPanel();
            renderBackupInfo();
        }
    });
}

function updateMemoryPanel() {
    if (!window.$) return;
    const count = getMemoryArray().length;
    window.$('#weaver-memory-count span').text(count);
    renderBackupInfo();
    renderMemoryList();
    renderRecallPreview();
}

window.updateMemoryCount = updateMemoryPanel;

function renderMemoryList() {
    if (!window.$ || !memoryListVisible) return;

    const memories = getFilteredMemories();
    const list = window.$('#weaver-memory-list');
    list.empty();

    if (memories.length === 0) {
        list.append('<div class="weaver-empty">当前没有匹配的记忆。</div>');
        return;
    }

    memories.forEach(mem => {
        const card = window.$(`
            <div class="weaver-memory-card" data-id="${escapeHtml(mem.id)}">
                <div class="weaver-memory-head">
                    <span class="weaver-memory-type">${escapeHtml(mem.type)}</span>
                    <span>重要度 ${mem.importance}</span>
                    <span>权重 ${Number(mem.weight || 1).toFixed(2)}</span>
                    <span>${getSourceKindLabel(mem.sourceKind)}</span>
                    <span>${mem.embedding ? '已有向量' : '未生成向量'}</span>
                </div>
                <textarea class="weaver-memory-text text_pole">${escapeHtml(mem.text)}</textarea>
                <input class="weaver-memory-keywords text_pole" value="${escapeHtml(mem.keywords.join(', '))}" placeholder="关键词，用逗号分隔">
                <div class="weaver-memory-foot">
                    <span>来源消息：${formatMessageIndex(mem.sourceMessageIndex)}</span>
                    <span>出处：${escapeHtml(mem.sourceTurn || '未标注')}</span>
                    <span>${formatTime(mem.timestamp)}</span>
                    <input class="weaver-memory-importance" type="number" min="1" max="10" value="${mem.importance}">
                    <button class="menu_button weaver-memory-save">保存</button>
                    <button class="menu_button weaver-memory-delete">删除</button>
                </div>
            </div>
        `);

        card.find('.weaver-memory-save').on('click', () => saveMemoryCard(mem.id, card));
        card.find('.weaver-memory-delete').on('click', () => deleteMemory(mem.id));
        list.append(card);
    });
}

function getFilteredMemories() {
    const memories = [...getMemoryArray()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (!memorySearchTerm) return memories;

    return memories.filter(mem => {
        const haystack = [mem.type, mem.text, mem.sourceTurn, ...(mem.keywords || [])].join(' ').toLowerCase();
        return haystack.includes(memorySearchTerm);
    });
}

function saveMemoryCard(id, card) {
    const mem = getMemoryArray().find(item => item.id === id);
    if (!mem) return;

    mem.text = card.find('.weaver-memory-text').val().trim();
    mem.keywords = card.find('.weaver-memory-keywords').val().split(',').map(k => k.trim()).filter(Boolean);
    mem.importance = clampNumber(parseInt(card.find('.weaver-memory-importance').val(), 10) || mem.importance, 1, 10);
    mem.updatedAt = Date.now();
    mem.embedding = null;
    mem.embeddingModel = '';
    mem.embeddingUpdatedAt = 0;
    saveDB();
    updateMemoryPanel();
}

function deleteMemory(id) {
    memoryState.memories = getMemoryArray().filter(mem => mem.id !== id);
    saveDB();
    updateMemoryPanel();
}

function getRecallLimit() {
    const preset = extensionSettings.recallPreset || 'standard';
    if (preset === 'custom') {
        return clampNumber(parseInt(extensionSettings.customRetrievedMemories, 10) || parseInt(extensionSettings.maxRetrievedMemories, 10) || 4, 1, 10);
    }
    return RECALL_PRESET_LIMITS[preset] || 4;
}

function toRecallSnapshot(mem) {
    return {
        id: mem.id,
        type: mem.type,
        importance: mem.importance,
        sourceTurn: mem.sourceTurn,
        sourceKind: mem.sourceKind,
        text: mem.text,
        keywords: Array.isArray(mem.keywords) ? [...mem.keywords] : []
    };
}

function saveLastRecall(recall) {
    memoryState.lastRecall = recall;
    saveDB();
    renderRecallPreview();
}

function clearRecallPrompt(context = getContext()) {
    if (context.setExtensionPrompt) context.setExtensionPrompt(MODULE_NAME, '', 0, 4);
}

function renderRecallPreview() {
    if (!window.$ || !recallPreviewVisible) return;
    const container = window.$('#weaver-recall-preview-content');
    container.empty();
    const recall = memoryState?.lastRecall;
    if (!recall) {
        container.append('<div class="weaver-empty">还没有召回记录。</div>');
        return;
    }

    const statusText = recall.message || (recall.status === 'injected' ? `上次实际注入 ${recall.memories?.length || 0} 条记忆。` : '上一轮没有召回。');
    container.append(`<div class="weaver-backup-info">${escapeHtml(statusText)}${recall.timestamp ? `｜${escapeHtml(formatTime(recall.timestamp))}` : ''}</div>`);

    if (recall.injectionText) {
        container.append(`<textarea class="text_pole weaver-recall-text" readonly>${escapeHtml(recall.injectionText)}</textarea>`);
    }

    const memories = recall.memories || [];
    if (memories.length === 0) return;
    memories.forEach(mem => {
        container.append(`
            <div class="weaver-memory-card">
                <div class="weaver-memory-head">
                    <span class="weaver-memory-type">${escapeHtml(mem.type)}</span>
                    <span>重要度 ${escapeHtml(mem.importance)}</span>
                    <span>${escapeHtml(getSourceKindLabel(mem.sourceKind))}</span>
                    <span>${escapeHtml(mem.sourceTurn || '未标注')}</span>
                </div>
                <div>${escapeHtml(mem.text)}</div>
                <small>关键词：${escapeHtml((mem.keywords || []).join(', ') || '无')}</small>
            </div>
        `);
    });
}

function createMemoryBackup(reason) {
    memoryState.lastBackup = {
        reason,
        timestamp: Date.now(),
        count: getMemoryArray().length,
        memories: JSON.parse(JSON.stringify(getMemoryArray()))
    };
}

function restoreLastBackup() {
    const backup = memoryState?.lastBackup;
    if (!backup || !Array.isArray(backup.memories)) {
        setImportStatus('恢复失败：当前没有可恢复的备份。', 'error');
        return;
    }
    if (!confirm(`确定要恢复上一次备份吗？
备份原因：${backup.reason || '未标注'}
备份条数：${backup.count || backup.memories.length}`)) return;
    memoryState.memories = backup.memories.map(normalizeMemoryItem).filter(mem => mem.text);
    saveDB();
    updateMemoryPanel();
    setImportStatus('已恢复上一次备份。', 'success');
}

function renderBackupInfo() {
    if (!window.$) return;
    const backup = memoryState?.lastBackup;
    if (!backup) {
        window.$('#weaver-backup-info').text('');
        return;
    }
    window.$('#weaver-backup-info').text(`最近备份：${backup.reason || '未标注'}｜${formatTime(backup.timestamp)}｜${backup.count || backup.memories?.length || 0} 条`);
}

function applyManualTemplate() {
    const key = window.$('#weaver-manual-template').val();
    const tpl = MANUAL_MEMORY_TEMPLATES[key];
    if (!tpl) return;
    window.$('#weaver-manual-type').val(tpl.type);
    window.$('#weaver-manual-importance').val(tpl.importance);
    window.$('#weaver-manual-keywords').attr('placeholder', tpl.keywords);
    window.$('#weaver-manual-text').attr('placeholder', tpl.text);
    if (!window.$('#weaver-manual-text').val().trim()) window.$('#weaver-manual-text').val('');
}

function getChatMessageByDisplayFloor(floor) {
    const displayFloor = parseInt(floor, 10);
    const chat = getContext().chat || [];
    if (!Number.isFinite(displayFloor) || displayFloor < 1 || displayFloor > chat.length) {
        throw new Error(`楼层 ${floor || ''} 不存在。当前聊天共有 ${chat.length} 楼。`);
    }
    const index = displayFloor - 1;
    const message = chat[index];
    if (!message || !message.mes) throw new Error(`第 ${displayFloor} 楼没有可用文本。`);
    return { message, index, displayFloor };
}

function getCalibrationRange(summaryFloor, mode, startFloor, endFloor) {
    const chatLength = (getContext().chat || []).length;
    const summaryIndex = summaryFloor - 1;
    let startIndex = 0;
    let endIndex = summaryIndex - 1;

    if (mode === 'range') {
        const start = parseInt(startFloor, 10);
        const end = parseInt(endFloor, 10);
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('分段校准需要填写起始楼层和结束楼层。');
        if (start < 1 || end < 1 || start > chatLength || end > chatLength) throw new Error(`分段范围超出当前聊天楼层。当前共有 ${chatLength} 楼。`);
        if (start > end) throw new Error('分段起始楼层不能大于结束楼层。');
        startIndex = start - 1;
        endIndex = end - 1;
    }

    if (endIndex < startIndex) throw new Error('当前范围内没有可处理的旧楼层。');
    return { startIndex, endIndex, startFloor: startIndex + 1, endFloor: endIndex + 1 };
}

function countAutoMemoriesInRange(startIndex, endIndex) {
    return getMemoryArray().filter(mem => mem.sourceKind !== 'manual' && Number.isFinite(Number(mem.sourceMessageIndex)) && mem.sourceMessageIndex >= startIndex && mem.sourceMessageIndex <= endIndex).length;
}

function removeAutoMemoriesInRange(startIndex, endIndex) {
    const before = getMemoryArray().length;
    memoryState.memories = getMemoryArray().filter(mem => {
        if (mem.sourceKind === 'manual') return true;
        const index = Number(mem.sourceMessageIndex);
        if (!Number.isFinite(index)) return true;
        return index < startIndex || index > endIndex;
    });
    return before - memoryState.memories.length;
}

function buildCalibrationSystemPrompt() {
    return `你是“织法·回响纺锤”的记忆整理器。请只根据用户提供的【已手动修正的大总结】生成长期记忆条目。

规则：
1. 大总结是最高事实源，不要补充大总结没有明确提到的事实。
2. 不要保留含糊、过时、可能与大总结冲突的信息。
3. 每条记忆必须是一个清晰事实，适合后续剧情召回。
4. 优先提取关系变化、物品事件、伏笔揭露、可回调细节、根脉闭环、世界线收束。
5. type 只能使用：${CALIBRATION_TYPES.join(', ')}。
6. importance 必须是 1-10 的整数。
7. keywords 必须是字符串数组，至少 1 个。
8. 只输出 JSON 数组，不要解释，不要 Markdown。`;
}

async function startCalibration() {
    try {
        const summaryFloor = parseInt(window.$('#weaver-calibration-summary-floor').val(), 10);
        const { message, index, displayFloor } = getChatMessageByDisplayFloor(summaryFloor);
        const rangeMode = window.$('input[name="weaver-calibration-range"]:checked').val();
        const action = window.$('input[name="weaver-calibration-action"]:checked').val();
        const range = getCalibrationRange(displayFloor, rangeMode, window.$('#weaver-calibration-start-floor').val(), window.$('#weaver-calibration-end-floor').val());
        const removeCount = countAutoMemoriesInRange(range.startIndex, range.endIndex);
        const context = getContext();
        const plan = {
            chatId: context.chatId || '',
            summaryFloor: displayFloor,
            summaryIndex: index,
            summaryHash: simpleHash(message.mes),
            range,
            action,
            removeCount,
            createdAt: Date.now()
        };

        if (action === 'clear') {
            memoryState.pendingCalibration = { plan, items: [], rawText: '' };
            saveDB();
            renderCalibrationPreview();
            setImportStatus('仅清理模式预览已生成，请确认后执行。', 'info');
            return;
        }

        setImportStatus('正在调用当前 SillyTavern 模型生成校准记忆...', 'info');
        const items = await generateCalibrationMemories(message, displayFloor, index);
        if (items.length === 0) throw new Error('模型没有返回可用的校准记忆。');
        memoryState.pendingCalibration = { plan, items, rawText: '' };
        saveDB();
        renderCalibrationPreview();
        setImportStatus(`校准预览已生成：将清理 ${removeCount} 条旧自动记忆，准备新增 ${items.length} 条校准记忆。`, 'success');
    } catch (error) {
        setImportStatus(`校准失败：${getErrorMessage(error)}`, 'error');
    }
}

async function generateCalibrationMemories(summaryMessage, summaryFloor, summaryIndex) {
    const context = getContext();
    const systemPrompt = buildCalibrationSystemPrompt();
    const prompt = `【已手动修正的大总结｜第${summaryFloor}楼】
${summaryMessage.mes}

请根据这份大总结生成 8-30 条“回响纺锤”长期记忆。`;
    const responseLength = clampNumber(parseInt(extensionSettings.calibrationResponseLength, 10) || 1200, 300, 4000);
    let raw = '';

    if (typeof context.generateRaw === 'function') {
        raw = await context.generateRaw({
            prompt,
            systemPrompt,
            responseLength
        });
    } else if (typeof context.generateQuietPrompt === 'function') {
        raw = await context.generateQuietPrompt(`${systemPrompt}\n\n${prompt}`);
    } else {
        throw new Error('当前 SillyTavern 没有提供后台生成或静默生成接口，无法自动生成校准记忆。你可以使用“仅清理旧自动记忆”模式。');
    }

    return parseCalibrationMemories(raw, {
        index: summaryIndex,
        hash: simpleHash(summaryMessage.mes),
        sourceTurn: `大总结校准｜第${summaryFloor}楼`
    });
}

function parseCalibrationMemories(rawText, sourceMeta) {
    const raw = String(rawText || '').trim();
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('模型返回内容里没有 JSON 数组。');
    let parsed;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (error) {
        throw new Error(`JSON 解析失败：${getErrorMessage(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error('校准结果不是数组。');

    const items = [];
    for (const item of parsed) {
        const type = CALIBRATION_TYPES.includes(String(item.type || '').trim()) ? String(item.type).trim() : 'DETAIL';
        const keywords = Array.isArray(item.keywords) ? item.keywords.join(',') : String(item.keywords || '');
        const memoryItem = buildMemoryItem(type, item.importance, keywords, item.text, sourceMeta.sourceTurn, sourceMeta, 'calibration');
        if (!memoryItem) continue;
        if (items.some(existing => textSimilarity(existing.text, memoryItem.text) > 0.88)) continue;
        items.push(memoryItem);
    }
    return items;
}

function renderCalibrationPreview() {
    if (!window.$) return;
    const preview = memoryState?.pendingCalibration;
    const panel = window.$('#weaver-calibration-preview-panel');
    const content = window.$('#weaver-calibration-preview-content');
    if (!preview) {
        panel.hide();
        content.empty();
        return;
    }
    panel.show();
    content.empty();
    const plan = preview.plan;
    content.append(`<div class="weaver-warning">将处理第 ${plan.range.startFloor} - ${plan.range.endFloor} 楼；预计清理 ${plan.removeCount} 条旧自动记忆；新增 ${preview.items.length} 条校准记忆。</div>`);
    if (preview.items.length === 0) {
        content.append('<div class="weaver-empty">仅清理模式：不会新增校准记忆。</div>');
        return;
    }
    preview.items.forEach(mem => {
        content.append(`
            <div class="weaver-calibration-card">
                <div class="weaver-memory-head">
                    <span class="weaver-memory-type">${escapeHtml(mem.type)}</span>
                    <span>重要度 ${escapeHtml(mem.importance)}</span>
                    <span>${escapeHtml(mem.sourceTurn)}</span>
                </div>
                <div>${escapeHtml(mem.text)}</div>
                <small>关键词：${escapeHtml((mem.keywords || []).join(', '))}</small>
            </div>
        `);
    });
}

function confirmCalibrationApply() {
    try {
        const pending = memoryState?.pendingCalibration;
        if (!pending) throw new Error('没有待写入的校准预览。');
        const context = getContext();
        if ((pending.plan.chatId || '') !== (context.chatId || '')) throw new Error('当前聊天已切换，已取消写入。');
        const currentSummary = context.chat?.[pending.plan.summaryIndex];
        if (!currentSummary || simpleHash(currentSummary.mes) !== pending.plan.summaryHash) throw new Error('大总结楼层内容已变化，请重新生成预览。');

        createMemoryBackup('大总结校准记忆');
        const removed = removeAutoMemoriesInRange(pending.plan.range.startIndex, pending.plan.range.endIndex);
        let added = 0;
        for (const item of pending.items.map(normalizeMemoryItem).filter(mem => mem.text)) {
            if (isDuplicateMemory(item)) continue;
            memoryState.memories.push(item);
            added++;
        }
        memoryState.pendingCalibration = null;
        saveDB();
        updateMemoryPanel();
        renderCalibrationPreview();
        setImportStatus(`大总结校准完成：清理 ${removed} 条旧自动记忆，新增 ${added} 条校准记忆。`, 'success');
    } catch (error) {
        setImportStatus(`写入失败：${getErrorMessage(error)}`, 'error');
    }
}

function cancelCalibrationPreview() {
    memoryState.pendingCalibration = null;
    saveDB();
    renderCalibrationPreview();
    setImportStatus('已取消校准预览，记忆库未改变。', 'info');
}

function getSourceKindLabel(sourceKind) {
    if (sourceKind === 'manual') return '手动添加';
    if (sourceKind === 'calibration') return '大总结校准';
    return '自动归档';
}

function getLatestAssistantMessage() {
    const chat = getContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user && chat[i].mes) return chat[i];
    }
    return null;
}

function syncLatestAssistantMessage() {
    const message = getLatestAssistantMessage();
    if (!message) {
        setImportStatus('同步失败：当前聊天里没有找到 char 楼层。', 'error');
        return;
    }

    const sourceMeta = getMessageSourceMeta(message, message.mes);
    const before = getMemoryArray().filter(mem => mem.sourceMessageIndex === sourceMeta.index).length;
    const count = extractAndStoreMemories(message.mes, message);
    setImportStatus(`最新楼层同步完成：清理 ${before} 条旧记忆，新增 ${count} 条；若该楼层没有 VEC_ARCHIVE，则只清理不新增。`, 'success');
}

function rebuildCurrentChatMemories() {
    if (!confirm('确定要按当前聊天内容重建自动记忆吗？这会清理现有自动归档/校准记忆，再从当前聊天里的 VEC_ARCHIVE 重新读取；手动添加记忆会保留。')) return;

    const chat = getContext().chat || [];
    createMemoryBackup('重建当前聊天自动记忆');
    memoryState.memories = getMemoryArray().filter(mem => mem.sourceKind === 'manual');
    let total = 0;
    chat.forEach(message => {
        if (message && !message.is_user && message.mes) {
            total += extractAndStoreMemories(message.mes, message, { replace: false });
        }
    });
    saveDB();
    updateMemoryPanel();
    setImportStatus(`当前聊天自动记忆已重建：保留手动记忆，共读取 ${total} 条自动记忆。`, 'success');
}

function addManualMemory() {
    const latestMessage = getLatestAssistantMessage();
    const sourceMeta = latestMessage ? getMessageSourceMeta(latestMessage, latestMessage.mes) : { index: null, hash: '', removedCount: 0 };
    const type = window.$('#weaver-manual-type').val();
    const importance = window.$('#weaver-manual-importance').val();
    const keywords = window.$('#weaver-manual-keywords').val();
    const text = window.$('#weaver-manual-text').val();
    const sourceTurn = sourceMeta.index === null ? '手动添加' : `第${sourceMeta.index + 1}楼`;
    const memoryItem = buildMemoryItem(type, importance, keywords, text, sourceTurn, sourceMeta, 'manual');

    if (!memoryItem) {
        setImportStatus('手动添加失败：请填写摘要、至少一个关键词，并确认重要度是 1-10。', 'error');
        return;
    }
    if (isDuplicateMemory(memoryItem)) {
        setImportStatus('手动添加失败：已有高度相似的记忆。', 'error');
        return;
    }

    getMemoryArray().push(memoryItem);
    saveDB();
    updateMemoryPanel();
    window.$('#weaver-manual-text').val('');
    window.$('#weaver-manual-keywords').val('');
    window.$('#weaver-manual-panel').slideUp();
    setImportStatus('手动记忆已添加。', 'success');
}

function exportMemories() {
    const data = JSON.stringify(memoryState, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weaver-echo-memory-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importMemoriesFromFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const imported = JSON.parse(reader.result);
            const importedMemories = extractImportedMemories(imported);
            if (importedMemories.length === 0) {
                setImportStatus('导入失败：JSON 里没有找到可用记忆。', 'error');
                return;
            }

            const mode = confirm('选择“确定”=覆盖当前记忆库；选择“取消”=追加导入并跳过重复项。') ? 'replace' : 'append';
            if (mode === 'replace') {
                createMemoryBackup('覆盖导入记忆');
                memoryState.memories = importedMemories.map(normalizeMemoryItem).filter(mem => mem.text);
            } else {
                let added = 0;
                for (const item of importedMemories.map(normalizeMemoryItem).filter(mem => mem.text)) {
                    if (isDuplicateMemory(item)) continue;
                    memoryState.memories.push(item);
                    added++;
                }
                setImportStatus(`追加导入完成：新增 ${added} 条，重复内容已跳过。`, 'success');
            }

            saveDB();
            updateMemoryPanel();
            if (mode === 'replace') setImportStatus(`覆盖导入完成：当前共有 ${memoryState.memories.length} 条记忆。`, 'success');
        } catch (error) {
            setImportStatus(`导入失败：${getErrorMessage(error)}`, 'error');
        }
    };
    reader.readAsText(file);
}

function extractImportedMemories(imported) {
    if (Array.isArray(imported)) return imported;
    if (Array.isArray(imported?.memories)) return imported.memories;
    if (Array.isArray(imported?.weaverVecMemory?.memories)) return imported.weaverVecMemory.memories;
    return [];
}

async function testApiConnection() {
    setApiStatus('正在测试连接...', 'info');
    try {
        const embedding = await createEmbedding('织法回响测试');
        setApiStatus(`连接成功，已返回 ${embedding.length} 维向量。`, 'success');
    } catch (error) {
        setApiStatus(`连接失败：${getErrorMessage(error)}`, 'error');
    }
}

async function regenerateMissingEmbeddings() {
    setApiStatus('正在生成缺失向量...', 'info');
    try {
        await ensureMemoryEmbeddings(getMemoryArray());
        updateMemoryPanel();
        setApiStatus('缺失向量已生成完成。', 'success');
    } catch (error) {
        setApiStatus(`生成失败：${getErrorMessage(error)}`, 'error');
    }
}

function toggleCustomRecallInput() {
    if (!window.$) return;
    const isCustom = window.$('#weaver-recall-preset').val() === 'custom';
    window.$('#weaver-custom-recall').toggle(isCustom);
}

function updatePauseButton() {
    if (!window.$) return;
    const paused = extensionSettings.pauseNextRecall === true;
    window.$('#weaver-pause-next')
        .toggleClass('weaver-pause-active', paused)
        .text(paused ? '取消暂停下一轮' : '暂停下一轮回响');
}

function toggleApiSettings() {
    if (!window.$) return;
    if (window.$('#weaver-search-mode').val() === 'api') {
        window.$('#weaver-api-settings').slideDown();
    } else {
        window.$('#weaver-api-settings').slideUp();
    }
}

function setApiStatus(message, type) {
    if (!window.$) return;
    window.$('#weaver-api-status')
        .removeClass('success error info')
        .addClass(type || 'info')
        .text(message || '');
}

function setImportStatus(message, type) {
    if (!window.$) return;
    window.$('#weaver-memory-import-status')
        .removeClass('success error info')
        .addClass(type || 'info')
        .text(message || '');
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[MODULE_NAME] = extensionSettings;
    if (context.saveSettingsDebounced) context.saveSettingsDebounced();
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getErrorMessage(error) {
    return error?.message || String(error || '未知错误');
}

function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString();
}

function formatMessageIndex(index) {
    return Number.isFinite(Number(index)) ? `第 ${Number(index) + 1} 楼` : '未标注';
}

function simpleHash(text) {
    let hash = 0;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) - hash) + source.charCodeAt(i);
        hash |= 0;
    }
    return `${source.length}-${Math.abs(hash)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
