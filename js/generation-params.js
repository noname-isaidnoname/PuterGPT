import { getState, setState, subscribe } from './store.js';
import { emit } from './event-bus.js';

// Null means "let the model decide", preserving existing behavior for old chats.
export function normalizeGenerationParams(value) {
    const temperature = value?.temperature;
    const maxTokens = value?.maxTokens;
    return {
        temperature: typeof temperature === 'number' && Number.isFinite(temperature)
            && temperature >= 0 && temperature <= 2 ? temperature : null,
        maxTokens: Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 32768 ? maxTokens : null
    };
}

export function initializeGenerationParams() {
    const temperature = document.getElementById('chat-temperature');
    const maxTokens = document.getElementById('chat-max-tokens');
    const reset = document.getElementById('reset-generation-params');
    const sync = state => {
        const params = normalizeGenerationParams(state.generationParams);
        temperature.value = params.temperature ?? '';
        maxTokens.value = params.maxTokens ?? '';
        temperature.disabled = maxTokens.disabled = reset.disabled = state.isGenerating;
    };
    const save = () => {
        if (!temperature.validity.valid || !maxTokens.validity.valid) {
            emit('toast:show', 'Enter a temperature from 0 to 2 and a whole token limit from 1 to 32768.', 'error');
            sync(getState());
            return;
        }
        setState({ generationParams: normalizeGenerationParams({
            temperature: temperature.value === '' ? null : Number(temperature.value),
            maxTokens: maxTokens.value === '' ? null : Number(maxTokens.value)
        }) });
        emit('chat:save');
    };
    temperature.addEventListener('change', save);
    maxTokens.addEventListener('change', save);
    reset.addEventListener('click', () => {
        setState({ generationParams: normalizeGenerationParams(null) });
        emit('chat:save');
    });
    subscribe((next, previous) => {
        if (next.generationParams !== previous.generationParams || next.isGenerating !== previous.isGenerating) sync(next);
    });
    sync(getState());
}
