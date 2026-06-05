import { state, els } from './state.js';
import { getMessageText } from './utils.js';
import { getSavedChats } from './storage.js';
import { on } from './event-bus.js';

// Search Engine Core
class SearchEngine {
    constructor() {
        this.searchIndex = null;
        this.lastIndexUpdate = 0;
        this.searchHistory = [];
    }

    // Build search index from all saved chats
    async buildIndex() {
        try {
            const chats = await getSavedChats();
            const index = {};
            
            chats.forEach(chat => {
                const chatIndex = {
                    id: chat.id,
                    title: chat.title,
                    lastModified: chat.lastModified,
                    model: this.extractModelFromChat(chat),
                    messageIndex: []
                };

                chat.messages.forEach((message, messageIndex) => {
                    const content = getMessageText(message);
                    if (content.trim()) {
                        chatIndex.messageIndex.push({
                            messageId: messageIndex,
                            role: message.role,
                            content: content.toLowerCase(),
                            originalContent: content,
                            timestamp: message.timestamp || chat.lastModified,
                            hasImages: Array.isArray(message.content) && 
                                      message.content.some(item => item.type === 'image_url')
                        });
                    }
                });

                index[chat.id] = chatIndex;
            });

            this.searchIndex = index;
            this.lastIndexUpdate = Date.now();
            console.log(`Search index built with ${Object.keys(index).length} chats`);
            return index;
        } catch (error) {
            console.error('Failed to build search index:', error);
            this.searchIndex = {};
            return {};
        }
    }

    // Extract model used in chat (simplified - could be enhanced)
    extractModelFromChat(chat) {
        // Try to find model from first message or use default
        if (chat.messages && chat.messages.length > 0) {
            const firstMessage = chat.messages[0];
            if (firstMessage.model) return firstMessage.model;
        }
        return state.config.modelId || 'unknown';
    }

    // Perform search with filters
    async search(query, filters = {}) {
        if (!this.searchIndex) {
            await this.buildIndex();
        }

        if (!query.trim()) return [];

        const normalizedQuery = query.toLowerCase().trim();
        const results = [];
        const queryTerms = normalizedQuery.split(/\s+/).filter(term => term.length > 0);

        Object.values(this.searchIndex).forEach(chatIndex => {
            // Apply filters first
            if (!this.passesFilters(chatIndex, filters)) return;

            const matches = [];
            let totalScore = 0;

            chatIndex.messageIndex.forEach((message, idx) => {
                const matchData = this.searchInMessage(message, queryTerms);
                if (matchData.matches.length > 0) {
                    matches.push({
                        messageId: message.messageId,
                        role: message.role,
                        content: message.originalContent,
                        timestamp: message.timestamp,
                        matches: matchData.matches,
                        score: matchData.score,
                        hasImages: message.hasImages
                    });
                    totalScore += matchData.score;
                }
            });

            if (matches.length > 0) {
                results.push({
                    chatId: chatIndex.id,
                    chatTitle: chatIndex.title,
                    lastModified: chatIndex.lastModified,
                    model: chatIndex.model,
                    matches: matches,
                    totalScore: totalScore,
                    matchCount: matches.length
                });
            }
        });

        // Sort by relevance (score, recency, match count)
        results.sort((a, b) => {
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
            if (b.lastModified !== a.lastModified) return b.lastModified - a.lastModified;
            return b.matchCount - a.matchCount;
        });

        return results;
    }

    // Search within a single message
    searchInMessage(message, queryTerms) {
        const matches = [];
        let score = 0;

        queryTerms.forEach(term => {
            const regex = new RegExp(this.escapeRegex(term), 'gi');
            let match;
            while ((match = regex.exec(message.content)) !== null) {
                matches.push({
                    term: term,
                    start: match.index,
                    end: match.index + term.length,
                    context: this.getContext(message.content, match.index, term.length)
                });
                score += 1; // Base score for match
                
                // Bonus for exact word matches
                if (this.isWordBoundary(message.content, match.index, term.length)) {
                    score += 2;
                }
            }
        });

        return { matches, score };
    }

    // Get context around a match
    getContext(content, matchStart, matchLength, contextLength = 100) {
        const start = Math.max(0, matchStart - contextLength);
        const end = Math.min(content.length, matchStart + matchLength + contextLength);
        return content.substring(start, end);
    }

    // Check if character is word boundary
    isWordBoundary(content, start, length) {
        const before = start === 0 || /\W/.test(content[start - 1]);
        const after = start + length >= content.length || /\W/.test(content[start + length]);
        return before && after;
    }

    // Escape regex special characters
    escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Check if chat passes filters
    passesFilters(chatIndex, filters) {
        // Date range filter
        if (filters.dateFrom && chatIndex.lastModified < filters.dateFrom) return false;
        if (filters.dateTo && chatIndex.lastModified > filters.dateTo) return false;

        // Model filter
        if (filters.model && filters.model !== 'all' && chatIndex.model !== filters.model) return false;

        // Content type filter
        if (filters.contentType === 'text' && chatIndex.messageIndex.some(msg => msg.hasImages)) return false;
        if (filters.contentType === 'images' && !chatIndex.messageIndex.some(msg => msg.hasImages)) return false;

        return true;
    }

    // Search within current conversation only
    searchInCurrentChat(query) {
        if (!state.currentChatId || !state.messages.length) return [];

        const queryTerms = query.toLowerCase().trim().split(/\s+/).filter(term => term.length > 0);
        const results = [];

        state.messages.forEach((message, idx) => {
            const content = getMessageText(message).toLowerCase();
            const matchData = this.searchInMessage({
                content: content,
                originalContent: getMessageText(message),
                messageId: idx,
                role: message.role,
                timestamp: message.timestamp || Date.now(),
                hasImages: Array.isArray(message.content) && 
                          message.content.some(item => item.type === 'image_url')
            }, queryTerms);

            if (matchData.matches.length > 0) {
                results.push({
                    messageId: idx,
                    role: message.role,
                    content: getMessageText(message),
                    timestamp: message.timestamp || Date.now(),
                    matches: matchData.matches,
                    score: matchData.score
                });
            }
        });

        return results.sort((a, b) => b.score - a.score);
    }

    // Search across all chats
    search(query, filters = {}) {
        if (!this.searchIndex) {
            throw new Error('Search index not built. Please rebuild the search index first.');
        }

        const queryTerms = query.toLowerCase().trim().split(/\s+/).filter(term => term.length > 0);
        if (queryTerms.length === 0) return [];

        const results = [];

        for (const [chatId, chatIndex] of Object.entries(this.searchIndex)) {
            // Apply filters
            if (!this.passesFilters(chatIndex, filters)) continue;

            const chatResults = {
                chatId: chatId,
                chatTitle: chatIndex.title,
                lastModified: chatIndex.lastModified,
                model: chatIndex.model,
                matches: []
            };

            // Search through each message in the chat
            chatIndex.messageIndex.forEach(message => {
                const matchData = this.searchInMessage(message, queryTerms);
                if (matchData.matches.length > 0) {
                    chatResults.matches.push({
                        role: message.role,
                        content: message.originalContent,
                        matches: matchData.matches,
                        timestamp: message.timestamp,
                        hasImages: message.hasImages
                    });
                }
            });

            // Only include chats that have matches
            if (chatResults.matches.length > 0) {
                results.push(chatResults);
            }
        }

        return results;
    }

    // Get unique models from all chats
    async getAvailableModels() {
        if (!this.searchIndex) await this.buildIndex();
        
        const models = new Set();
        Object.values(this.searchIndex).forEach(chatIndex => {
            if (chatIndex.model) models.add(chatIndex.model);
        });
        return Array.from(models);
    }

    // Add search to history
    addToHistory(query) {
        if (!query.trim()) return;
        
        // Remove if already exists
        this.searchHistory = this.searchHistory.filter(item => item !== query);
        
        // Add to beginning
        this.searchHistory.unshift(query);
        
        // Keep only last 10 searches
        this.searchHistory = this.searchHistory.slice(0, 10);
    }

    // Get search history
    getHistory() {
        return this.searchHistory;
    }

    // Clear search history
    clearHistory() {
        this.searchHistory = [];
    }

    // Force index rebuild
    async rebuildIndex() {
        return await this.buildIndex();
    }
}

// Create global search instance
export const searchEngine = new SearchEngine();

// Listen for rebuild requests
on('search:rebuild', () => {
    searchEngine.rebuildIndex().catch(err =>
        console.warn('Failed to rebuild search index:', err)
    );
});

// Utility functions
export function escapeHtml(text) {
    const tempDiv = document.createElement('div');
    tempDiv.textContent = text;
    const escapedHtml = tempDiv.innerHTML;
    tempDiv.remove();
    return escapedHtml;
}

export function highlightText(text, matches) {
    if (!matches || matches.length === 0) return escapeHtml(text);

    // First escape the text to prevent HTML injection
    let highlightedText = escapeHtml(text);
    const offsets = [];

    // Calculate all highlight ranges
    matches.forEach(match => {
        offsets.push({
            start: match.start,
            end: match.end,
            term: match.term
        });
    });

    // Sort by start position
    offsets.sort((a, b) => a.start - b.start);

    // Apply highlights from end to start to avoid position shifts
    offsets.reverse().forEach(offset => {
        const before = highlightedText.substring(0, offset.start);
        const match = highlightedText.substring(offset.start, offset.end);
        const after = highlightedText.substring(offset.end);
        highlightedText = before + `<mark class="search-highlight">${match}</mark>` + after;
    });

    return highlightedText;
}

export function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
}

// Export search functions for global access
window.searchInCurrentChat = (query) => searchEngine.searchInCurrentChat(query);
window.getSearchHistory = () => searchEngine.getHistory();
