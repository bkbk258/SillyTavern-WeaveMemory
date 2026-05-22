// 动态获取 ST 上下文，不使用静态 import 避免路径报错
const MODULE_NAME = 'weaver-vec-memory';
let extensionSettings = {};
let isActive = false;

// Default settings
const defaultSettings = {
    archiveTriggerTurns: 5,
    decayRate: 0.02, // 2% per turn
    maxRetrievedMemories: 5,
    importanceThreshold: 3,
    searchMode: 'tfidf', // 'tfidf' or 'api'
    apiUrl: 'https://api.siliconflow.cn/v1/embeddings',
    apiModel: 'BAAI/bge-m3',
    apiKey: ''
};

// Memory storage structure
// { [characterId_chatId]: [ { id, text, keywords, importance, weight, type, sourceTurn, timestamp } ] }
let memoryDB = {};

// TF-IDF implementation for local matching
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
                words.push(char); // Single char
                if (currentWord.length > 0) {
                    words.push(currentWord + char); // Bi-gram
                }
                currentWord = char;
            } else if (/\w/.test(char)) {
                currentWord += char;
            } else {
                if (currentWord && !/[一-龥]/.test(currentWord)) {
                    words.push(currentWord.toLowerCase());
                }
                currentWord = '';
            }
        }
        if (currentWord && !/[一-龥]/.test(currentWord)) {
            words.push(currentWord.toLowerCase());
        }
        
        return words.filter(w => w.trim().length > 0 && !this.stopWords.has(w));
    }

    calculateScore(queryText, memoryItem) {
        const queryTokens = new Set(this.tokenize(queryText));
        let score = 0;
        
        if (memoryItem.keywords && memoryItem.keywords.length > 0) {
            for (const kw of memoryItem.keywords) {
                if (queryText.includes(kw)) score += 3.0;
            }
        }
        
        const memoryTokens = this.tokenize(memoryItem.text);
        let overlapCount = 0;
        for (const token of memoryTokens) {
            if (queryTokens.has(token)) overlapCount++;
        }
        
        if (memoryTokens.length > 0) {
            score += (overlapCount / memoryTokens.length) * 2.0;
        }
        
        const weightMultiplier = memoryItem.weight || 1.0;
        const importanceBonus = (memoryItem.importance || 5) / 10.0;
        
        return score * weightMultiplier + importanceBonus;
    }
}

const localSearch = new LocalSearchEngine();

// ==========================================
// Extension API Hooks
// ==========================================

export async function init() {
    // 动态获取 SillyTavern 全局变量，避免 import 报错
    if (typeof window === 'undefined' || !window.SillyTavern) {
        console.error(`[${MODULE_NAME}] window.SillyTavern not found. Cannot initialize.`);
        return;
    }

    const context = window.SillyTavern.getContext();

    // Load settings
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = { ...defaultSettings };
    }
    extensionSettings = context.extensionSettings[MODULE_NAME];

    // Load DB
    if (!context.extensionSettings[`${MODULE_NAME}_db`]) {
        context.extensionSettings[`${MODULE_NAME}_db`] = {};
    }
    memoryDB = context.extensionSettings[`${MODULE_NAME}_db`];

    // Build Settings UI
    buildSettingsUI();

    // Hook events
    const eventSource = context.eventSource || window.eventSource;
    const eventTypes = context.eventTypes || window.event_types;
    
    if (eventSource && eventTypes) {
        eventSource.on(eventTypes.MESSAGE_RECEIVED, handleMessageReceived);
        eventSource.on(eventTypes.MESSAGE_SENT, applyDecay);
        eventSource.on(eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, injectContext);
        console.log(`[${MODULE_NAME}] Initialized and hooked events successfully`);
    } else {
        console.error(`[${MODULE_NAME}] Failed to hook events. EventSource or EventTypes missing.`);
    }

    isActive = true;
}

export function onEnable() {
    isActive = true;
}

export function onDisable() {
    isActive = false;
}

// ==========================================
// Core Logic
// ==========================================

function getChatId() {
    const context = window.SillyTavern.getContext();
    if (context.chatId) return context.chatId; 
    if (context.characters && context.characterId && context.characters[context.characterId]) {
        return context.characters[context.characterId].name; 
    }
    return 'default';
}

function getMemoryArray() {
    const chatId = getChatId();
    if (!memoryDB[chatId]) {
        memoryDB[chatId] = [];
    }
    return memoryDB[chatId];
}

function saveDB() {
    const context = window.SillyTavern.getContext();
    context.extensionSettings[`${MODULE_NAME}_db`] = memoryDB;
    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();
    }
}

function handleMessageReceived(messageId) {
    if (!isActive) return;
    
    const context = window.SillyTavern.getContext();
    const chat = context.chat || [];
    
    // Find message by ID or take the last one
    let msg = null;
    if (typeof messageId === 'number' || typeof messageId === 'string') {
        msg = chat.find(m => m.mes === messageId || m._mesId === messageId);
    }
    if (!msg) {
        msg = chat[chat.length - 1];
    }
    
    // Process only if it's an AI message
    if (msg && !msg.is_user && msg.mes) {
        extractAndStoreMemories(msg.mes);
    }
}

function extractAndStoreMemories(text) {
    if (!text) return;

    // Look for <VEC_ARCHIVE> block
    const archiveRegex = /<VEC_ARCHIVE>([\s\S]*?)<\/VEC_ARCHIVE>/g;
    let match;
    let newMemoriesCount = 0;
    
    while ((match = archiveRegex.exec(text)) !== null) {
        const blockContent = match[1];
        
        // Parse individual [VEC] lines
        // Format: [VEC] 类型标签 | 重要性(1-10) | 关键词(逗号分隔) | 内容摘要 | 源楼层
        const lineRegex = /\[VEC\]\s*(.*?)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*)/g;
        let lineMatch;
        
        while ((lineMatch = lineRegex.exec(blockContent)) !== null) {
            const [, type, importanceStr, keywordsStr, summary, source] = lineMatch;
            const importance = parseInt(importanceStr, 10);
            
            if (importance < extensionSettings.importanceThreshold) continue;
            
            const keywords = keywordsStr.split(',').map(k => k.trim()).filter(k => k);
            
            const memoryItem = {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                type: type.trim(),
                importance: importance,
                keywords: keywords,
                text: summary.trim(),
                sourceTurn: source.trim(),
                weight: 1.0, 
                timestamp: Date.now()
            };
            
            getMemoryArray().push(memoryItem);
            newMemoriesCount++;
        }
    }
    
    if (newMemoriesCount > 0) {
        console.log(`[${MODULE_NAME}] Archived ${newMemoriesCount} new memories`);
        saveDB();
        if (typeof updateMemoryCount === 'function') updateMemoryCount();
    }
}

function applyDecay() {
    if (!isActive) return;
    
    const memories = getMemoryArray();
    const decayFactor = 1.0 - (extensionSettings.decayRate || 0.02);
    let changed = false;
    
    for (const mem of memories) {
        if (mem.weight > 0.1) { 
            mem.weight = mem.weight * decayFactor;
            changed = true;
        }
    }
    
    if (changed) saveDB();
}

async function injectContext(eventData) {
    if (!isActive) return;
    
    const context = window.SillyTavern.getContext();
    const chat = context.chat || [];
    if (chat.length === 0) return;
    
    const recentMessages = chat.slice(-3).map(m => m.mes).join('\n');
    const memories = getMemoryArray();
    if (memories.length === 0) return;
    
    let retrieved = [];
    
    if (extensionSettings.searchMode === 'api' && extensionSettings.apiKey) {
        // Fallback to local for now until API is implemented
        console.log(`[${MODULE_NAME}] API search requested but using local fallback`);
        retrieved = localSearchRetriever(recentMessages, memories);
    } else {
        retrieved = localSearchRetriever(recentMessages, memories);
    }
    
    if (retrieved.length > 0) {
        retrieved.forEach(mem => {
            mem.weight = Math.min(1.0, mem.weight + 0.2); 
        });
        saveDB();
        
        let injectionText = `\n<RECALLED_MEMORY>\n`;
        injectionText += `[SYSTEM NOTE: 以下是基于当前语境自动检索的历史记忆。请在后续的 <thinking> 步骤一中参考这些事实。]\n`;
        
        retrieved.forEach((mem) => {
            injectionText += `- [${mem.type}] (重要度:${mem.importance}) ${mem.text} (出处:${mem.sourceTurn})\n`;
        });
        injectionText += `</RECALLED_MEMORY>\n`;
        
        // Depth 3-4 is usually right before system prompt
        if (context.setExtensionPrompt) {
            context.setExtensionPrompt(MODULE_NAME, injectionText, 0, 4);
        }
    }
}

function localSearchRetriever(queryText, memories) {
    const scoredMemories = memories.map(mem => {
        return {
            memory: mem,
            score: localSearch.calculateScore(queryText, mem)
        };
    });
    
    return scoredMemories
        .filter(item => item.score > 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, extensionSettings.maxRetrievedMemories || 5)
        .map(item => item.memory);
}

// ==========================================
// UI Logic
// ==========================================

function buildSettingsUI() {
    const html = `
        <div class="weaver-vec-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>织法·向量记忆 (Weaver Memory)</b>
                    <div class="inline-drawer-icon fa-solid fa-brain down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    
                    <div class="memory-status-card">
                        <div id="weaver-memory-count">当前记忆库：<span>0</span> 条记录</div>
                        <button id="weaver-memory-clear" class="menu_button">清空本角色记忆</button>
                    </div>

                    <div class="set-block">
                        <label><b>检索模式选择</b></label>
                        <select id="weaver-search-mode" class="text_pole">
                            <option value="tfidf">关键词匹配 (零配置/本地执行)</option>
                            <option value="api">向量语义检索 (需配置API)</option>
                        </select>
                        <small>推荐大多数用户使用关键词匹配，即装即用。高级用户可使用硅基流动等兼容OpenAI的API实现语义检索。</small>
                    </div>

                    <hr>

                    <div id="weaver-api-settings" style="display: none;">
                        <h4>API 配置 (向量语义检索)</h4>
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

    // Make sure we use global jQuery to append to ST UI
    if (window.$) {
        window.$('#extensions_settings').append(html);

        // Initial value setup
        window.$('#weaver-search-mode').val(extensionSettings.searchMode || 'tfidf');
        window.$('#weaver-api-url').val(extensionSettings.apiUrl || 'https://api.siliconflow.cn/v1/embeddings');
        window.$('#weaver-api-model').val(extensionSettings.apiModel || 'BAAI/bge-m3');
        window.$('#weaver-api-key').val(extensionSettings.apiKey || '');
        window.$('#weaver-max-mem').val(extensionSettings.maxRetrievedMemories || 5);
        window.$('#weaver-max-val').text(extensionSettings.maxRetrievedMemories || 5);
        window.$('#weaver-decay').val((extensionSettings.decayRate || 0.02) * 100);
        window.$('#weaver-decay-val').text((extensionSettings.decayRate || 0.02) * 100);
        window.$('#weaver-thresh').val(extensionSettings.importanceThreshold || 3);
        window.$('#weaver-thresh-val').text(extensionSettings.importanceThreshold || 3);
        
        updateMemoryCount();
        toggleApiSettings();

        // Event listeners
        window.$('#weaver-search-mode').on('change', function() {
            extensionSettings.searchMode = window.$(this).val();
            saveSettings();
            toggleApiSettings();
        });

        window.$('#weaver-api-url').on('input', function() { extensionSettings.apiUrl = window.$(this).val(); saveSettings(); });
        window.$('#weaver-api-model').on('input', function() { extensionSettings.apiModel = window.$(this).val(); saveSettings(); });
        window.$('#weaver-api-key').on('input', function() { extensionSettings.apiKey = window.$(this).val(); saveSettings(); });

        window.$('#weaver-max-mem').on('input', function() { 
            const val = parseInt(window.$(this).val());
            window.$('#weaver-max-val').text(val);
            extensionSettings.maxRetrievedMemories = val; 
            saveSettings(); 
        });

        window.$('#weaver-decay').on('input', function() { 
            const val = parseInt(window.$(this).val());
            window.$('#weaver-decay-val').text(val);
            extensionSettings.decayRate = val / 100.0; 
            saveSettings(); 
        });

        window.$('#weaver-thresh').on('input', function() { 
            const val = parseInt(window.$(this).val());
            window.$('#weaver-thresh-val').text(val);
            extensionSettings.importanceThreshold = val; 
            saveSettings(); 
        });

        window.$('#weaver-memory-clear').on('click', function() {
            const chatId = getChatId();
            if (confirm(`确定要清空当前记录的所有向量记忆吗？`)) {
                memoryDB[chatId] = [];
                saveDB();
                updateMemoryCount();
            }
        });

        window.$('.inline-drawer-toggle').on('click', function() {
            window.$(this).next('.inline-drawer-content').slideToggle();
            window.$(this).find('.inline-drawer-icon').toggleClass('down up');
            updateMemoryCount();
        });
    } else {
        console.error(`[${MODULE_NAME}] jQuery ($) not found!`);
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

// Make it global so other functions can call it
window.updateMemoryCount = function() {
    if (!window.$) return;
    const count = getMemoryArray().length;
    window.$('#weaver-memory-count span').text(count);
};

function saveSettings() {
    const context = window.SillyTavern.getContext();
    context.extensionSettings[MODULE_NAME] = extensionSettings;
    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();
    }
}
