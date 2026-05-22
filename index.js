import { eventSource, event_types } from '../../../../../../public/scripts/extensions.js';

// The actual imports will be provided by SillyTavern at runtime
// We'll use getContext() to access ST internals safely across versions

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
        // Simple tokenization for Chinese (character based with basic grouping)
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
        // Base score on keyword matching
        const queryTokens = new Set(this.tokenize(queryText));
        let score = 0;
        
        // 1. Exact keyword match (highest weight)
        if (memoryItem.keywords && memoryItem.keywords.length > 0) {
            for (const kw of memoryItem.keywords) {
                if (queryText.includes(kw)) score += 3.0;
            }
        }
        
        // 2. Token overlap score
        const memoryTokens = this.tokenize(memoryItem.text);
        let overlapCount = 0;
        for (const token of memoryTokens) {
            if (queryTokens.has(token)) overlapCount++;
        }
        
        if (memoryTokens.length > 0) {
            score += (overlapCount / memoryTokens.length) * 2.0;
        }
        
        // 3. Add memory's own weight and importance
        const weightMultiplier = memoryItem.weight || 1.0;
        const importanceBonus = (memoryItem.importance || 5) / 10.0;
        
        return score * weightMultiplier + importanceBonus;
    }
}

const localSearch = new LocalSearchEngine();

// Setup UI and load settings
export async function init() {
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (!context) {
        console.error(`[${MODULE_NAME}] Failed to get SillyTavern context`);
        return;
    }

    // Load settings
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = { ...defaultSettings };
    }
    extensionSettings = context.extensionSettings[MODULE_NAME];

    // Load DB from local storage (we use ST's extension settings for now to keep it portable)
    if (!context.extensionSettings[`${MODULE_NAME}_db`]) {
        context.extensionSettings[`${MODULE_NAME}_db`] = {};
    }
    memoryDB = context.extensionSettings[`${MODULE_NAME}_db`];

    // Build Settings UI dynamically instead of loading external HTML
    buildSettingsUI();

    // Hook into message events
    const eventTypes = context.eventTypes || event_types;
    if (context.eventSource && eventTypes) {
        context.eventSource.on(eventTypes.MESSAGE_RECEIVED, handleMessageReceived);
        context.eventSource.on(eventTypes.MESSAGE_SENT, applyDecay);
        context.eventSource.on(eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, injectContext);
        console.log(`[${MODULE_NAME}] Hooked into SillyTavern events successfully`);
    } else {
        console.error(`[${MODULE_NAME}] Failed to hook events. EventSource: ${!!context.eventSource}, EventTypes: ${!!eventTypes}`);
    }

    isActive = true;
}

export function onEnable() {
    isActive = true;
}

export function onDisable() {
    isActive = false;
}

// Generate an ID for the current chat context
function getChatId() {
    const context = SillyTavern.getContext();
    if (context.chatId) return context.chatId; // 1.13+ has chatId
    if (context.characters && context.characters[context.characterId]) {
        return context.characters[context.characterId].name; // fallback
    }
    return 'default';
}

// Ensure the memory array exists for current chat
function getMemoryArray() {
    const chatId = getChatId();
    if (!memoryDB[chatId]) {
        memoryDB[chatId] = [];
    }
    return memoryDB[chatId];
}

function saveDB() {
    const context = SillyTavern.getContext();
    context.extensionSettings[`${MODULE_NAME}_db`] = memoryDB;
    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();
    }
}

// Extract VEC_ARCHIVE blocks from AI responses
function handleMessageReceived(messageId) {
    if (!isActive) return;
    
    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    
    // Find the message
    const msg = chat.find(m => m.mes === messageId || m._mesId === messageId) || chat[chat.length - 1];
    if (!msg || !msg.is_user) {
        // It's an AI message
        const content = msg ? msg.mes : '';
        extractAndStoreMemories(content);
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
            
            // Skip low importance if configured
            if (importance < extensionSettings.importanceThreshold) continue;
            
            const keywords = keywordsStr.split(',').map(k => k.trim()).filter(k => k);
            
            const memoryItem = {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                type: type.trim(),
                importance: importance,
                keywords: keywords,
                text: summary.trim(),
                sourceTurn: source.trim(),
                weight: 1.0, // Initial weight is 100%
                timestamp: Date.now()
            };
            
            getMemoryArray().push(memoryItem);
            newMemoriesCount++;
        }
    }
    
    if (newMemoriesCount > 0) {
        console.log(`[${MODULE_NAME}] Archived ${newMemoriesCount} new memories`);
        saveDB();
    }
}

// Decay memory weights when user sends a message
function applyDecay() {
    if (!isActive) return;
    
    const memories = getMemoryArray();
    const decayFactor = 1.0 - (extensionSettings.decayRate || 0.02);
    let changed = false;
    
    for (const mem of memories) {
        if (mem.weight > 0.1) { // Floor it at 0.1
            mem.weight = mem.weight * decayFactor;
            changed = true;
        }
    }
    
    if (changed) saveDB();
}

// Hook into prompt generation
async function injectContext(eventData) {
    if (!isActive) return;
    
    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    if (chat.length === 0) return;
    
    // Get last few messages as query context
    const recentMessages = chat.slice(-3).map(m => m.mes).join('\n');
    
    const memories = getMemoryArray();
    if (memories.length === 0) return;
    
    let retrieved = [];
    
    if (extensionSettings.searchMode === 'api' && extensionSettings.apiKey) {
        // TODO: Implement actual API vector search later
        // For now fallback to local
        console.log(`[${MODULE_NAME}] API search not fully implemented yet, falling back to local`);
        retrieved = localSearchRetriever(recentMessages, memories);
    } else {
        retrieved = localSearchRetriever(recentMessages, memories);
    }
    
    if (retrieved.length > 0) {
        // Boost weights of retrieved memories (Reinforcement)
        retrieved.forEach(mem => {
            mem.weight = Math.min(1.0, mem.weight + 0.2); 
        });
        saveDB();
        
        // Format the injection block
        let injectionText = `\n<RECALLED_MEMORY>\n`;
        injectionText += `[SYSTEM NOTE: 以下是基于当前语境自动检索的历史记忆。请在后续的 <thinking> 步骤一中参考这些事实。]\n`;
        
        retrieved.forEach((mem, index) => {
            injectionText += `- [${mem.type}] (重要度:${mem.importance}) ${mem.text} (出处:${mem.sourceTurn})\n`;
        });
        injectionText += `</RECALLED_MEMORY>\n`;
        
        // Use ST's extension prompt injection API
        if (context.setExtensionPrompt) {
            // Position 0 = Before system prompt, 1 = After system prompt, 2 = Before scenario, etc.
            // Depth affects how far back in the chat history it appears
            context.setExtensionPrompt(MODULE_NAME, injectionText, 0, 4);
            console.log(`[${MODULE_NAME}] Injected ${retrieved.length} memories into prompt`);
        }
    }
}

function localSearchRetriever(queryText, memories) {
    // Calculate scores
    const scoredMemories = memories.map(mem => {
        return {
            memory: mem,
            score: localSearch.calculateScore(queryText, mem)
        };
    });
    
    // Sort and filter
    return scoredMemories
        .filter(item => item.score > 0.5) // Minimum score threshold
        .sort((a, b) => b.score - a.score)
        .slice(0, extensionSettings.maxRetrievedMemories || 5)
        .map(item => item.memory);
}

// ---------------- UI Building ----------------

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
                        <button id="weaver-memory-clear" class="menu_button">清除当前角色记忆</button>
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

    // Append to ST's extension settings container
    $('#extensions_settings').append(html);

    // Initial value setup
    $('#weaver-search-mode').val(extensionSettings.searchMode || 'tfidf');
    $('#weaver-api-url').val(extensionSettings.apiUrl || 'https://api.siliconflow.cn/v1/embeddings');
    $('#weaver-api-model').val(extensionSettings.apiModel || 'BAAI/bge-m3');
    $('#weaver-api-key').val(extensionSettings.apiKey || '');
    $('#weaver-max-mem').val(extensionSettings.maxRetrievedMemories || 5);
    $('#weaver-max-val').text(extensionSettings.maxRetrievedMemories || 5);
    $('#weaver-decay').val((extensionSettings.decayRate || 0.02) * 100);
    $('#weaver-decay-val').text((extensionSettings.decayRate || 0.02) * 100);
    $('#weaver-thresh').val(extensionSettings.importanceThreshold || 3);
    $('#weaver-thresh-val').text(extensionSettings.importanceThreshold || 3);
    
    updateMemoryCount();
    toggleApiSettings();

    // Event listeners
    $('#weaver-search-mode').on('change', function() {
        extensionSettings.searchMode = $(this).val();
        saveSettings();
        toggleApiSettings();
    });

    $('#weaver-api-url').on('input', function() { extensionSettings.apiUrl = $(this).val(); saveSettings(); });
    $('#weaver-api-model').on('input', function() { extensionSettings.apiModel = $(this).val(); saveSettings(); });
    $('#weaver-api-key').on('input', function() { extensionSettings.apiKey = $(this).val(); saveSettings(); });

    $('#weaver-max-mem').on('input', function() { 
        const val = parseInt($(this).val());
        $('#weaver-max-val').text(val);
        extensionSettings.maxRetrievedMemories = val; 
        saveSettings(); 
    });

    $('#weaver-decay').on('input', function() { 
        const val = parseInt($(this).val());
        $('#weaver-decay-val').text(val);
        extensionSettings.decayRate = val / 100.0; 
        saveSettings(); 
    });

    $('#weaver-thresh').on('input', function() { 
        const val = parseInt($(this).val());
        $('#weaver-thresh-val').text(val);
        extensionSettings.importanceThreshold = val; 
        saveSettings(); 
    });

    $('#weaver-memory-clear').on('click', function() {
        const chatId = getChatId();
        if (confirm(`确定要清空当前聊天 (${chatId}) 的所有向量记忆吗？`)) {
            memoryDB[chatId] = [];
            saveDB();
            updateMemoryCount();
        }
    });

    // Update count periodically when drawer is open
    $('.inline-drawer-toggle').on('click', function() {
        $(this).next('.inline-drawer-content').slideToggle();
        $(this).find('.inline-drawer-icon').toggleClass('down up');
        updateMemoryCount();
    });
}

function toggleApiSettings() {
    if ($('#weaver-search-mode').val() === 'api') {
        $('#weaver-api-settings').slideDown();
    } else {
        $('#weaver-api-settings').slideUp();
    }
}

function updateMemoryCount() {
    const count = getMemoryArray().length;
    $('#weaver-memory-count span').text(count);
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.extensionSettings[MODULE_NAME] = extensionSettings;
    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();
    }
}
