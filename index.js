const MODULE_NAME = 'weaver-vec-memory';
const MEMORY_STORE_KEY = 'weaverVecMemory';
const DISPLAY_NAME = '织法·回响纺锤（v1.1.1）';

let extensionSettings = {};
let memoryState = null;
let isActive = false;
let initialized = false;
let memoryListVisible = false;
let memorySearchTerm = '';

const defaultSettings = {
    archiveTriggerTurns: 5,
    decayRate: 0.02,
    maxRetrievedMemories: 5,
    importanceThreshold: 3,
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

    isActive = true;
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
        version: 1,
        memories: [],
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
    memoryState.version = 1;
    memoryState.memories = (memoryState.memories || []).map(normalizeMemoryItem).filter(mem => mem.text);
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

function extractAndStoreMemories(text, message = null) {
    if (!text) return;

    const sourceMeta = getMessageSourceMeta(message, text);
    removeMemoriesFromMessage(sourceMeta);

    const archiveRegex = /<VEC_ARCHIVE>([\s\S]*?)<\/VEC_ARCHIVE>/g;
    let match;
    let newMemoriesCount = 0;

    while ((match = archiveRegex.exec(text)) !== null) {
        const blockContent = match[1];
        const lineRegex = /\[VEC\]\s*(.*?)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*)/g;
        let lineMatch;

        while ((lineMatch = lineRegex.exec(blockContent)) !== null) {
            const [, type, importanceStr, keywordsStr, summary, source] = lineMatch;
            const memoryItem = buildMemoryItem(type, importanceStr, keywordsStr, summary, source, sourceMeta);
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
    memoryState.memories = getMemoryArray().filter(mem => mem.sourceMessageIndex !== sourceMeta.index);
    sourceMeta.removedCount = before - memoryState.memories.length;
}

function buildMemoryItem(type, importanceStr, keywordsStr, summary, source, sourceMeta = {}) {
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

    const recentMessages = chat.slice(-3).map(m => m.mes).join('\n');
    const memories = getMemoryArray();
    if (memories.length === 0) return;

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

        if (context.setExtensionPrompt) context.setExtensionPrompt(MODULE_NAME, injectionText, 0, 4);
    }
}

function localSearchRetriever(queryText, memories) {
    return memories
        .map(mem => ({ memory: mem, score: localSearch.calculateScore(queryText, mem) }))
        .filter(item => item.score > 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, extensionSettings.maxRetrievedMemories || 5)
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
            .slice(0, extensionSettings.maxRetrievedMemories || 5)
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
                    <div class="memory-status-card">
                        <div id="weaver-memory-count">当前记忆库：<span>0</span> 条记录</div>
                        <div class="weaver-status-buttons">
                            <button id="weaver-memory-toggle" class="menu_button">查看记忆明细</button>
                            <button id="weaver-memory-export" class="menu_button">导出 JSON</button>
                            <button id="weaver-memory-import" class="menu_button">导入 JSON</button>
                            <button id="weaver-memory-clear" class="menu_button">清空本对话记忆</button>
                        </div>
                    </div>

                    <input type="file" id="weaver-memory-import-file" accept="application/json,.json" style="display: none;">
                    <div id="weaver-memory-import-status"></div>

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
                    <div class="set-block flex-container">
                        <label>单轮最大检索量 <span id="weaver-max-val">5</span>条</label>
                        <input type="range" id="weaver-max-mem" min="1" max="10" value="5">
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
    window.$('#weaver-search-mode').val(extensionSettings.searchMode || 'tfidf');
    window.$('#weaver-api-url').val(extensionSettings.apiUrl || defaultSettings.apiUrl);
    window.$('#weaver-api-model').val(extensionSettings.apiModel || defaultSettings.apiModel);
    window.$('#weaver-api-key').val(extensionSettings.apiKey || '');
    window.$('#weaver-max-mem').val(extensionSettings.maxRetrievedMemories || 5);
    window.$('#weaver-max-val').text(extensionSettings.maxRetrievedMemories || 5);
    window.$('#weaver-decay').val((extensionSettings.decayRate || 0.02) * 100);
    window.$('#weaver-decay-val').text((extensionSettings.decayRate || 0.02) * 100);
    window.$('#weaver-thresh').val(extensionSettings.importanceThreshold || 3);
    window.$('#weaver-thresh-val').text(extensionSettings.importanceThreshold || 3);
}

function bindSettingsEvents() {
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

    window.$('#weaver-max-mem').on('input', function() {
        const val = parseInt(window.$(this).val(), 10);
        window.$('#weaver-max-val').text(val);
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

    window.$('#weaver-memory-search').on('input', function() {
        memorySearchTerm = window.$(this).val().trim().toLowerCase();
        renderMemoryList();
    });

    window.$('#weaver-memory-export').on('click', exportMemories);
    window.$('#weaver-memory-import').on('click', () => window.$('#weaver-memory-import-file').val('').trigger('click'));
    window.$('#weaver-memory-import-file').on('change', importMemoriesFromFile);

    window.$('#weaver-memory-clear').on('click', function() {
        if (confirm('确定要清空当前对话的所有回响记忆吗？')) {
            memoryState.memories = [];
            saveDB();
            updateMemoryPanel();
        }
    });
}

function updateMemoryPanel() {
    if (!window.$) return;
    const count = getMemoryArray().length;
    window.$('#weaver-memory-count span').text(count);
    renderMemoryList();
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
