import { searchEngine, highlightText, formatDate, escapeHtml } from './search.js';
import { state, els } from './state.js';
import { emit } from './event-bus.js';

// Search UI Management
class SearchUI {
    constructor() {
        this.isSearchModalOpen = false;
        this.currentResults = [];
        this.currentQuery = '';
        this.currentFilters = {};
        this.expandedResults = new Set();
        this.currentChatSearchOpen = false;
        this.init();
    }

    init() {
        try {
            this.createSearchModal();
            this.setupEventListeners();
            this.setupKeyboardShortcuts();
            console.log('Search UI initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Search UI:', error);
        }
    }

    // Create search modal HTML
    createSearchModal() {
        console.log('Creating search modal...');
        try {
            const modalHTML = `
            <div class="modal-overlay" id="search-modal" style="display: none;">
                <div class="modal search-modal">
                    <h3>
                        <span class="material-icons-outlined">search</span>
                        Advanced Search
                        <span style="font-size: 0.7rem; background: var(--warning); color: white; padding: 2px 8px; border-radius: 12px; margin-left: 10px;">Experimental</span>
                    </h3>
                    
                    <div class="search-input-section">
                        <div class="search-input-wrapper">
                            <input type="text" id="search-input" class="search-input" placeholder="Search across all conversations..." autocomplete="off">
                            <button id="search-btn" class="search-btn">
                                <span class="material-icons-outlined">search</span>
                                Search
                            </button>
                        </div>
                        
                        <div id="search-history" class="search-history"></div>
                    </div>
                    
                    <div class="search-filters">
                        <div class="filter-group">
                            <label for="date-from-filter">From Date</label>
                            <input type="date" id="date-from-filter">
                        </div>
                        
                        <div class="filter-group">
                            <label for="date-to-filter">To Date</label>
                            <input type="date" id="date-to-filter">
                        </div>
                        
                        <div class="filter-group">
                            <label for="model-filter">Model</label>
                            <select id="model-filter">
                                <option value="all">All Models</option>
                            </select>
                        </div>
                        
                        <div class="filter-group">
                            <label for="content-type-filter">Content Type</label>
                            <select id="content-type-filter">
                                <option value="all">All Content</option>
                                <option value="text">Text Only</option>
                                <option value="images">With Images</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="search-results">
                        <div id="search-results-content">
                            <div class="no-results">
                                <span class="material-icons-outlined">search</span>
                                <h4>Start Searching</h4>
                                <p>Enter a search query to find conversations and messages.</p>
                            </div>
                        </div>
                    </div>
                    
                    <div class="search-shortcuts">
                        <strong>Shortcuts:</strong> 
                        <kbd>Ctrl+F</kbd> Search current chat • 
                        <kbd>Ctrl+Shift+F</kbd> Advanced search • 
                        <kbd>Esc</kbd> Close
                    </div>
                    
                    <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                        <button class="btn" onclick="searchUI.closeSearchModal()">Close</button>
                        <button class="btn primary" onclick="searchUI.rebuildIndex()">Rebuild Index</button>
                    </div>
                </div>
            </div>
            
            <div id="current-chat-search" class="current-chat-search" style="display: none;">
                <input type="text" id="current-chat-search-input" class="current-chat-search-input" placeholder="Search in current chat...">
                <div id="current-chat-search-results" class="current-chat-search-results"></div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        console.log('Search modal HTML added to body');
        
        // Verify the modal was added
        const modal = document.getElementById('search-modal');
        if (modal) {
            console.log('Search modal found in DOM');
        } else {
            console.error('Search modal not found after insertion');
        }
        } catch (error) {
            console.error('Error creating search modal:', error);
        }
    }

    // Setup event listeners
    setupEventListeners() {
        // Search modal events
        const searchInput = document.getElementById('search-input');
        const searchBtn = document.getElementById('search-btn');
        const modal = document.getElementById('search-modal');
        
        searchInput.addEventListener('input', (e) => {
            if (e.target.value.trim()) {
                this.performSearch(e.target.value);
            } else {
                this.clearResults();
            }
        });
        
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.performSearch(e.target.value);
            }
        });
        
        searchBtn.addEventListener('click', () => {
            this.performSearch(searchInput.value);
        });
        
        // Filter events
        ['date-from-filter', 'date-to-filter', 'model-filter', 'content-type-filter'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                if (this.currentQuery) {
                    this.performSearch(this.currentQuery);
                }
            });
        });
        
        // Modal close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeSearchModal();
            }
        });
        
        // Current chat search
        const currentChatSearchInput = document.getElementById('current-chat-search-input');
        currentChatSearchInput.addEventListener('input', (e) => {
            this.searchInCurrentChat(e.target.value);
        });
        
        currentChatSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeCurrentChatSearch();
            }
        });
    }

    // Setup keyboard shortcuts
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+Shift+F for advanced search
            if (e.ctrlKey && e.shiftKey && e.key === 'F') {
                e.preventDefault();
                this.openSearchModal();
            }
            
            // Ctrl+F for current chat search
            if (e.ctrlKey && e.key === 'F' && !e.shiftKey) {
                e.preventDefault();
                this.toggleCurrentChatSearch();
            }
            
            // Escape to close modals
            if (e.key === 'Escape') {
                if (this.isSearchModalOpen) {
                    this.closeSearchModal();
                } else if (this.currentChatSearchOpen) {
                    this.closeCurrentChatSearch();
                }
            }
        });
    }

    // Open search modal
    openSearchModal() {
        console.log('openSearchModal method called');
        try {
            const modal = document.getElementById('search-modal');
            if (!modal) {
                console.error('Search modal not found in DOM');
                return;
            }
            modal.style.display = 'flex';
            modal.classList.add('active'); // Add active class for visibility
            this.isSearchModalOpen = true;
            
            // Focus search input
            setTimeout(() => {
                const searchInput = document.getElementById('search-input');
                if (searchInput) {
                    searchInput.focus();
                } else {
                    console.error('Search input not found');
                }
            }, 100);
            
            // Load search history
            this.loadSearchHistory();
            
            // Populate model filter
            this.populateModelFilter();
            
            console.log('Search modal opened successfully');
        } catch (error) {
            console.error('Error in openSearchModal:', error);
        }
    }

    // Close search modal
    closeSearchModal() {
        const modal = document.getElementById('search-modal');
        modal.classList.remove('active'); // Remove active class
        modal.style.display = 'none';
        this.isSearchModalOpen = false;
        this.currentResults = [];
        this.currentQuery = '';
        this.expandedResults.clear();
    }

    // Toggle current chat search
    toggleCurrentChatSearch() {
        if (this.currentChatSearchOpen) {
            this.closeCurrentChatSearch();
        } else {
            this.openCurrentChatSearch();
        }
    }

    // Open current chat search
    openCurrentChatSearch() {
        if (!state.currentChatId || state.messages.length === 0) {
            emit('toast:show', 'No active conversation to search');
            return;
        }
        
        const searchDiv = document.getElementById('current-chat-search');
        searchDiv.style.display = 'block';
        this.currentChatSearchOpen = true;
        
        setTimeout(() => {
            document.getElementById('current-chat-search-input').focus();
        }, 100);
    }

    // Close current chat search
    closeCurrentChatSearch() {
        const searchDiv = document.getElementById('current-chat-search');
        searchDiv.style.display = 'none';
        this.currentChatSearchOpen = false;
        
        // Clear search
        document.getElementById('current-chat-search-input').value = '';
        document.getElementById('current-chat-search-results').innerHTML = '';
    }

    // Perform search
    async performSearch(query) {
        if (!query.trim()) {
            this.clearResults();
            return;
        }
        
        this.currentQuery = query;
        this.currentFilters = this.getCurrentFilters();
        
        // Show loading
        this.showLoading();
        
        // Add to search history
        searchEngine.addToHistory(query);
        this.loadSearchHistory();
        
        // Perform search with slight delay for better UX
        setTimeout(async () => {
            try {
                const results = searchEngine.search(query, this.currentFilters);
                this.displayResults(results);
            } catch (error) {
                console.error('Search error:', error);
                this.showError('An error occurred during search');
            }
        }, 100);
    }

    // Search in current chat
    searchInCurrentChat(query) {
        if (!query.trim()) {
            document.getElementById('current-chat-search-results').innerHTML = '';
            return;
        }
        
        try {
            const results = searchEngine.searchInCurrentChat(query);
            this.displayCurrentChatResults(results);
        } catch (error) {
            console.error('Current chat search error:', error);
        }
    }

    // Display current chat search results
    displayCurrentChatResults(results) {
        const resultsContainer = document.getElementById('current-chat-search-results');
        
        if (results.length === 0) {
            resultsContainer.innerHTML = '<div style="padding: 10px; color: var(--text-secondary); font-size: 0.8rem;">No matches found</div>';
            return;
        }
        
        resultsContainer.innerHTML = results.map(result => `
            <div class="current-chat-search-result" onclick="searchUI.jumpToMessage(${result.messageId})">
                <div style="font-weight: 600; margin-bottom: 4px; font-size: 0.7rem; text-transform: uppercase;">
                    ${escapeHtml(result.role)}
                </div>
                <div>${highlightText(result.content.substring(0, 100) + (result.content.length > 100 ? '...' : ''), result.matches)}</div>
            </div>
        `).join('');
    }

    // Jump to specific message
    jumpToMessage(messageId) {
        // Scroll to message
        const messages = document.querySelectorAll('.message');
        if (messages[messageId]) {
            messages[messageId].scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Highlight temporarily
            messages[messageId].style.backgroundColor = 'var(--primary-color)';
            setTimeout(() => {
                messages[messageId].style.backgroundColor = '';
            }, 2000);
        }
        
        // Close current chat search
        this.closeCurrentChatSearch();
    }

    // Get current filters
    getCurrentFilters() {
        return {
            dateFrom: document.getElementById('date-from-filter').value ? 
                     new Date(document.getElementById('date-from-filter').value).getTime() : null,
            dateTo: document.getElementById('date-to-filter').value ? 
                   new Date(document.getElementById('date-to-filter').value).getTime() + 86400000 : null,
            model: document.getElementById('model-filter').value,
            contentType: document.getElementById('content-type-filter').value
        };
    }

    // Display search results
    displayResults(results) {
        const resultsContainer = document.getElementById('search-results-content');
        
        if (results.length === 0) {
            resultsContainer.innerHTML = `
                <div class="no-results">
                    <span class="material-icons-outlined">search_off</span>
                    <h4>No Results Found</h4>
                    <p>Try adjusting your search terms or filters.</p>
                </div>
            `;
            return;
        }
        
        this.currentResults = results;
        
        resultsContainer.innerHTML = `
            <div class="search-results-header">
                <div class="search-results-count">
                    Found ${results.length} conversation${results.length !== 1 ? 's' : ''} with matches
                </div>
                <div class="search-results-actions">
                    <button class="clear-results-btn" onclick="searchUI.clearResults()">Clear</button>
                </div>
            </div>
            ${results.map((result, index) => this.createResultHTML(result, index)).join('')}
        `;
    }

    // Create result HTML
    createResultHTML(result, index) {
        const isExpanded = this.expandedResults.has(result.chatId);
        const totalMatches = result.matches.reduce((sum, match) => sum + match.matches.length, 0);
        
        return `
            <div class="search-result-item ${isExpanded ? 'expanded' : ''}" data-chat-id="${result.chatId}">
                <div class="search-result-header" onclick="searchUI.toggleResultExpansion('${result.chatId}')">
                    <div>
                        <div class="search-result-title">${escapeHtml(result.chatTitle)}</div>
                        <div class="search-result-meta">
                            <div class="search-result-meta-item">
                                <span class="material-icons-outlined">schedule</span>
                                ${formatDate(result.lastModified)}
                            </div>
                            <div class="search-result-meta-item">
                                <span class="material-icons-outlined">smart_toy</span>
                                ${escapeHtml(result.model.split(':')[1] || result.model)}
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div class="search-match-count">${totalMatches} match${totalMatches !== 1 ? 'es' : ''}</div>
                        <button class="btn" style="padding: 4px 8px; font-size: 0.8rem;" onclick="event.stopPropagation(); searchUI.loadChatResult('${result.chatId}')">
                            Open
                        </button>
                    </div>
                </div>
                <div class="search-result-matches">
                    ${result.matches.map(match => this.createMatchHTML(match)).join('')}
                </div>
            </div>
        `;
    }

    // Create match HTML
    createMatchHTML(match) {
        return `
            <div class="search-match">
                <div class="search-match-header">
                    <div class="search-match-role">${match.role}</div>
                    <div class="search-match-time">${formatDate(match.timestamp)}</div>
                </div>
                <div class="search-match-content">
                    ${highlightText(match.content, match.matches)}
                    ${match.hasImages ? '<div style="margin-top: 5px; font-size: 0.8rem; color: var(--text-secondary);"><span class="material-icons-outlined" style="font-size: 14px; vertical-align: middle;">image</span> Contains images</div>' : ''}
                </div>
            </div>
        `;
    }

    // Toggle result expansion
    toggleResultExpansion(chatId) {
        if (this.expandedResults.has(chatId)) {
            this.expandedResults.delete(chatId);
        } else {
            this.expandedResults.add(chatId);
        }
        
        const resultItem = document.querySelector(`[data-chat-id="${chatId}"]`);
        resultItem.classList.toggle('expanded');
    }

    // Load chat from search result
    loadChatResult(chatId) {
        this.closeSearchModal();
        window.loadChat(chatId);
    }

    // Show loading state
    showLoading() {
        const resultsContainer = document.getElementById('search-results-content');
        resultsContainer.innerHTML = `
            <div class="search-loading">
                <span class="material-icons-outlined">search</span>
                Searching...
            </div>
        `;
    }

    // Show error state
    showError(message) {
        const resultsContainer = document.getElementById('search-results-content');
        resultsContainer.innerHTML = `
            <div class="no-results">
                <span class="material-icons-outlined">error</span>
                <h4>Search Error</h4>
                <p>${message}</p>
            </div>
        `;
    }

    // Clear results
    clearResults() {
        const resultsContainer = document.getElementById('search-results-content');
        resultsContainer.innerHTML = `
            <div class="no-results">
                <span class="material-icons-outlined">search</span>
                <h4>Start Searching</h4>
                <p>Enter a search query to find conversations and messages.</p>
            </div>
        `;
        this.currentResults = [];
        this.currentQuery = '';
        this.expandedResults.clear();
    }

    // Load search history
    loadSearchHistory() {
        const historyContainer = document.getElementById('search-history');
        const history = searchEngine.getHistory();
        
        if (history.length === 0) {
            historyContainer.innerHTML = '';
            return;
        }
        
        historyContainer.innerHTML = history.map(query => {
            const escapedQuery = escapeHtml(query);
            const jsEscapedQuery = escapedQuery.replace(/'/g, "\\'");
            return `<div class="search-history-item" onclick="searchUI.searchFromHistory('${jsEscapedQuery}')">${escapedQuery}</div>`;
        }).join('');
    }

    // Search from history
    searchFromHistory(query) {
        document.getElementById('search-input').value = query;
        this.performSearch(query);
    }

    // Populate model filter
    async populateModelFilter() {
        const modelSelect = document.getElementById('model-filter');
        const models = await searchEngine.getAvailableModels();
        
        // Clear existing options except "All Models"
        modelSelect.innerHTML = '<option value="all">All Models</option>';
        
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model.split(':')[1] || model;
            modelSelect.appendChild(option);
        });
    }

    // Rebuild search index
    async rebuildIndex() {
        try {
            await searchEngine.rebuildIndex();
            emit('toast:show', 'Search index rebuilt successfully', 'success');
            await this.populateModelFilter();
        } catch (error) {
            console.error('Index rebuild error:', error);
            emit('toast:show', 'Failed to rebuild search index', 'error');
        }
    }
}

// Create global search UI instance
const searchUI = new SearchUI();

// Make searchUI globally available for onclick handlers
window.searchUI = searchUI;

// Make functions globally available
window.openSearchModal = function() {
    console.log('openSearchModal called');
    try {
        searchUI.openSearchModal();
    } catch (error) {
        console.error('Error opening search modal:', error);
    }
};
window.closeSearchModal = function() {
    console.log('closeSearchModal called');
    try {
        searchUI.closeSearchModal();
    } catch (error) {
        console.error('Error closing search modal:', error);
    }
};
