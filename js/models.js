import { state, els } from './state.js';
import { db } from './indexeddb-storage.js';
import { setState } from './store.js';
import { emit } from './event-bus.js';

/**
 * Populate a <select> with <option> entries for the given model list.
 * @param {HTMLSelectElement} selectEl
 * @param {Array<{id: string, name?: string}>} models
 */
export function populateSelectWithModels(selectEl, models) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        selectEl.appendChild(opt);
    });
}

// Model Management
export async function loadModels() {
    if(state.models.length > 0) return;
    
    // Try to load from cache in IndexedDB first
    const cachedModels = await db.settings.get('cached_models');
    if (cachedModels && Array.isArray(cachedModels.value) && cachedModels.value.length > 0) {
        setState({ models: cachedModels.value });
        populateModelSelect(cachedModels.value);
        // We still refresh in background if it's older than 1 hour, or just return for now
        // For simplicity, let's just return cached and allow manual refresh
        return;
    }

    try {
        const models = await fetchPuterModelsWithRetry();
        if (models && models.length > 0) {
            setState({ models });
            await db.settings.put({ key: 'cached_models', value: models });
            populateModelSelect(models);
        } else {
            const fallback = [
               { 
                   id: "openrouter:google/gemini-2.0-flash-lite-preview-02-05:free", 
                   name: "Gemini 2.0 Flash Lite (Free, Vision)", 
                   supportsVision: true,
                   costInfo: { isFree: true, inputCost: 0, outputCost: 0, currency: 'USD' }
               },
               { 
                   id: "openrouter:deepseek/deepseek-r1:free", 
                   name: "DeepSeek R1 (Free, Reasoning)", 
                   supportsVision: false,
                   costInfo: { isFree: true, inputCost: 0, outputCost: 0, currency: 'USD' }
               },
               { 
                   id: "openrouter:meta-llama/llama-3.3-70b-instruct:free", 
                   name: "Llama 3.3 70B (Free)", 
                   supportsVision: false,
                   costInfo: { isFree: true, inputCost: 0, outputCost: 0, currency: 'USD' }
               }
            ];
            // Ensure all fallback models have supportsVision property
            fallback.forEach(model => {
                if (model.supportsVision === undefined) {
                    model.supportsVision = model.name.toLowerCase().includes('gemini') || model.name.toLowerCase().includes('vision');
                }
            });
            setState({ models: fallback });
            populateModelSelect(fallback);
        }
    } catch (e) {
        console.error(e);
    }
}

export function populateModelSelect(models) {
    const currentModel = state.config.modelId;
    let found = false;
    models.forEach(m => {
        if (m.id === currentModel) found = true;
    });
    populateSelectWithModels(els.modelSelect, models);
    if(!found && currentModel) {
         const opt = document.createElement('option');
         opt.value = currentModel;
         opt.textContent = currentModel + " (Saved)";
         els.modelSelect.prepend(opt);
    }
    els.modelSelect.value = currentModel;
    
    // Update cost display when model selection changes
    updateCostDisplay();
}

export function filterModels() {
    const query = els.modelSearch.value.toLowerCase();
    const freeOnly = els.freeOnlyFilter.checked;
    
    const filtered = state.models.filter(m => {
        const matchesQuery = (m.name && m.name.toLowerCase().includes(query)) || 
                             m.id.toLowerCase().includes(query);
        
        if (!matchesQuery) return false;
        
        if (freeOnly) {
            const isFreeByName = m.name && m.name.toLowerCase().includes('free');
            const isFreeByCost = m.costInfo && m.costInfo.isFree;
            return isFreeByName || isFreeByCost;
        }
        
        return true;
    });
    
    populateModelSelect(filtered);
}

async function fetchPuterModelsWithRetry() {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const resp = await fetch('https://api.puter.com/puterai/chat/models/details', {
                signal: AbortSignal.timeout(10000) // 10 second timeout
            });
            
            if (resp.ok) {
                const data = await resp.json();
                if (data.models) return parseModelData(data.models);
            } else {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            }
        } catch (error) {
            console.warn(`Model fetch attempt ${attempt + 1} failed:`, error);
            
            // Don't retry on client errors (4xx) or if this is the last attempt
            if (error.name === 'AbortError' || 
                (error.name === 'TypeError' && error.message.includes('Failed to fetch')) ||
                attempt === maxRetries - 1) {
                break;
            }
            
            // Exponential backoff with jitter
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    return null;
}

function extractCostInfo(model) {
    if (!model.costs) {
        return null;
    }

    const costs = model.costs;
    const currency = model.costs_currency || 'usd-cents';
    const isCents = currency === 'usd-cents';
    
    // Extract input cost
    let inputCost = null;
    const inputKey = model.input_cost_key || 'prompt_tokens';
    
    if (costs[inputKey] !== undefined) {
        inputCost = costs[inputKey];
    } else if (costs.prompt !== undefined) {
        inputCost = costs.prompt;
    } else if (costs.input !== undefined) {
        inputCost = costs.input;
    } else if (costs.input_tokens !== undefined) {
        inputCost = costs.input_tokens;
    }

    // Extract output cost
    let outputCost = null;
    const outputKey = model.output_cost_key || 'completion_tokens';
    
    if (costs[outputKey] !== undefined) {
        outputCost = costs[outputKey];
    } else if (costs.completion !== undefined) {
        outputCost = costs.completion;
    } else if (costs.output !== undefined) {
        outputCost = costs.output;
    } else if (costs.output_tokens !== undefined) {
        outputCost = costs.output_tokens;
    }

    // Convert to USD per million tokens
    const convertToUsdPerMillion = (cost) => {
        if (cost === null || cost === undefined) return null;
        
        // Convert from cents to dollars if needed
        const usdCost = isCents ? cost / 100 : cost;
        
        // Normalize to per million tokens
        const tokenBase = costs.tokens || 1000000;
        return (usdCost / tokenBase) * 1000000;
    };

    return {
        inputCost: convertToUsdPerMillion(inputCost),
        outputCost: convertToUsdPerMillion(outputCost),
        currency: 'USD',
        isFree: (inputCost === 0 || inputCost === null) && (outputCost === 0 || outputCost === null)
    };
}

function parseModelData(rawModels) {
    return rawModels.map(m => {
        let name = m.name || m.id.split('/').pop();
        if (m.costs && m.costs.input_tokens === 0 && m.costs.output_tokens === 0) name += " (Free)";
        if (m.description && m.description.toLowerCase().includes('reasoning')) name += " (Reasoning)";
        
        // Extract cost information
        const costInfo = extractCostInfo(m);
        
        // Check if model supports vision - use modalities field or fall back to name patterns
        let supportsVision = false;
        if (m.modalities && m.modalities.input && m.modalities.input.includes('image')) {
            supportsVision = true;
            name += " (Vision)";
        } else {
            // Fallback: check model name for vision indicators
            const modelId = m.id || '';
            const modelName = m.name || modelId.split('/').pop();
            if (modelName.toLowerCase().includes('gemini') || 
                modelName.toLowerCase().includes('vision') ||
                modelName.toLowerCase().includes('claude') ||
                modelId.toLowerCase().includes('gpt-4') ||
                modelName.toLowerCase().includes('gpt-4o') ||
                modelName.toLowerCase().includes('pixtral') ||
                modelName.toLowerCase().includes('llava')) {
                supportsVision = true;
                name += " (Vision)";
            }
        }
        
        // Check if model supports web search
        let supportsSearch = false;
        // Primary: check if costs.web_search is defined in API response
        if (m.costs && m.costs.web_search !== undefined) {
            supportsSearch = true;
            name += " (Web Search)";
        } else {
            // Fallback: check model name/ID for known search-capable patterns
            const modelId = m.id || '';
            const modelName = m.name || modelId.split('/').pop();
            const searchPatterns = [
                /grok/i,
                /gemini-2\.\d+-flash/i,
                /gemini-2\.5/i
            ];
            if (searchPatterns.some(pattern => pattern.test(modelId) || pattern.test(modelName))) {
                supportsSearch = true;
                name += " (Web Search)";
            }
        }
        
        return { 
            id: m.id, 
            name: name, 
            supportsVision: supportsVision,
            supportsSearch: supportsSearch,
            costInfo: costInfo
        };
    });
}

// More accurate token counting approximation
export function estimateTokens(text) {
    if (!text) return 0;
    
    // Improved token estimation based on common patterns
    // This is still an approximation but more accurate than simple character division
    let tokens = 0;
    
    // Split by whitespace and punctuation to get word-like units
    const words = text.split(/\s+|[.,;:!?'"(){}[\]<>\/\\]/);
    
    for (const word of words) {
        if (!word.trim()) continue; // Skip empty strings
        
        // Common patterns for token estimation:
        // - Short words (1-3 chars): usually 1 token
        // - Medium words (4-7 chars): usually 1-2 tokens  
        // - Long words (8+ chars): usually 2+ tokens
        // - Numbers and special patterns: vary
        
        if (/^\d+$/.test(word)) {
            // Pure numbers: typically 1-2 tokens
            tokens += Math.ceil(word.length / 3);
        } else if (/^[a-zA-Z]+$/.test(word)) {
            // Pure alphabetic words
            if (word.length <= 3) {
                tokens += 1;
            } else if (word.length <= 7) {
                tokens += Math.ceil(word.length / 4);
            } else {
                tokens += Math.ceil(word.length / 3.5);
            }
        } else {
            // Mixed content (numbers, letters, symbols)
            tokens += Math.ceil(word.length / 3);
        }
    }
    
    // Add tokens for whitespace and punctuation
    const whitespaceMatches = text.match(/\s+/g) || [];
    const punctuationMatches = text.match(/[.,;:!?'"(){}[\]<>\/\\]/g) || [];
    tokens += whitespaceMatches.length + punctuationMatches.length;
    
    return Math.max(tokens, Math.ceil(text.length / 6)); // Minimum fallback
}

export function calculateMessageCost(inputTokens, outputTokens, costInfo) {
    if (!costInfo || costInfo.isFree) {
        return { cost: 0, formatted: 'Free' };
    }
    
    const inputCost = (inputTokens / 1000000) * (costInfo.inputCost || 0);
    const outputCost = (outputTokens / 1000000) * (costInfo.outputCost || 0);
    const totalCost = inputCost + outputCost;
    
    return {
        cost: totalCost,
        formatted: `$${totalCost.toFixed(6)}`,
        inputCost: inputCost,
        outputCost: outputCost,
        inputTokens: inputTokens,
        outputTokens: outputTokens
    };
}

function formatCostDisplay(costInfo) {
    if (!costInfo) {
        return 'Cost information not available, Try refreshing models!';
    }
    
    if (costInfo.isFree) {
        return 'Free';
    }
    
    const formatCost = (cost) => {
        if (cost === null || cost === undefined) return 'N/A';
        return `$${cost.toFixed(4)}`;
    };
    
    const inputCost = formatCost(costInfo.inputCost);
    const outputCost = formatCost(costInfo.outputCost);
    
    return `${inputCost}/1M input, ${outputCost}/1M output`;
}

export function updateCostDisplay() {
    const currentModel = state.models.find(m => m.id === state.config.modelId);
    
    if (els.modelCostDisplay && currentModel) {
        els.modelCostDisplay.textContent = formatCostDisplay(currentModel.costInfo);
    }
}

window.refreshModels = async () => {
    setState({ models: [] });
    await db.settings.delete('cached_models');
    await loadModels();
    emit('toast:show', "Models refreshed");
};
