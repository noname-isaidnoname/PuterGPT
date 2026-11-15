import { streamPuterCompletion } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js';
import { state } from './state.js';
import { tokenManager } from './token-manager.js';
import { normalizeGenerationParams } from './generation-params.js';
import { createModal } from './modal-helper.js';
import { emit } from './event-bus.js';

let openComparison = null;

export function openModelComparison() {
    if (openComparison) return;
    const modal = createModal(`
        <div class="modal compare-modal" role="dialog" aria-modal="true" aria-labelledby="compare-title">
            <div class="compare-header">
                <h3 id="compare-title">Compare models</h3>
                <button class="settings-close compare-close" type="button" aria-label="Close comparison"><span class="material-icons-outlined">close</span></button>
            </div>
            <p class="compare-description">Both models receive this prompt and your current system prompt, without chat history or attachments. Each response is a separate request and may incur charges. Results are not saved to the chat.</p>
            <div class="select-group">
                <label for="compare-prompt">Prompt for both models</label>
                <textarea id="compare-prompt" rows="3" placeholder="Enter a prompt to compare"></textarea>
            </div>
            <div class="compare-columns">
                <section class="compare-column">
                    <label for="compare-model-a">Model A</label>
                    <select id="compare-model-a"></select>
                    <div class="compare-column-header"><span class="compare-status" aria-live="polite">Ready</span><button class="btn compare-stop" type="button" disabled>Stop A</button></div>
                    <div class="compare-output" aria-label="Model A response"></div>
                </section>
                <section class="compare-column">
                    <label for="compare-model-b">Model B</label>
                    <select id="compare-model-b"></select>
                    <div class="compare-column-header"><span class="compare-status" aria-live="polite">Ready</span><button class="btn compare-stop" type="button" disabled>Stop B</button></div>
                    <div class="compare-output" aria-label="Model B response"></div>
                </section>
            </div>
            <div class="compare-actions"><button class="btn primary compare-start" type="button">Compare</button></div>
        </div>`);
    openComparison = modal;
    const prompt = modal.querySelector('#compare-prompt');
    prompt.value = document.getElementById('user-input').value;
    const start = modal.querySelector('.compare-start');
    const columns = [...modal.querySelectorAll('.compare-column')].map(element => ({
        select: element.querySelector('select'),
        stop: element.querySelector('.compare-stop'),
        status: element.querySelector('.compare-status'),
        output: element.querySelector('.compare-output'),
        run: null
    }));
    const available = state.models.length ? state.models : [{ id: state.config.modelId, name: state.config.modelId }];
    for (const column of columns) {
        for (const model of available) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name || model.id;
            column.select.appendChild(option);
        }
        if (available.some(model => model.id === state.config.modelId)) column.select.value = state.config.modelId;
    }
    if (available.length > 1) columns[1].select.selectedIndex = columns[0].select.selectedIndex === 0 ? 1 : 0;

    let preparing = false;
    let closed = false;
    const refresh = () => {
        const busy = preparing || columns.some(column => column.run && !column.run.finished);
        start.disabled = busy;
        prompt.disabled = busy;
        columns.forEach(column => {
            column.select.disabled = busy;
            column.stop.disabled = !column.run || column.run.finished;
        });
    };
    const finish = (column, run, status) => {
        if (column.run !== run || run.finished) return;
        run.finished = true;
        column.status.textContent = status;
        refresh();
    };
    for (const column of columns) {
        column.stop.addEventListener('click', () => {
            const run = column.run;
            if (!run || run.finished) return;
            run.controller.abort();
            finish(column, run, 'Stopped');
        });
    }
    const remove = modal.remove.bind(modal);
    modal.remove = () => {
        closed = true;
        for (const column of columns) {
            if (column.run && !column.run.finished) {
                column.run.controller.abort();
                column.run.finished = true;
            }
        }
        openComparison = null;
        remove();
    };
    modal.querySelector('.compare-close').onclick = () => modal.remove();
    start.onclick = async () => {
        const text = prompt.value.trim();
        if (!text) {
            emit('toast:show', 'Enter a prompt to compare.', 'warning');
            prompt.focus();
            return;
        }
        preparing = true;
        refresh();
        let apiToken;
        try {
            apiToken = await tokenManager.getApiToken();
        } catch {
            apiToken = null;
        }
        if (closed) return;
        if (!apiToken) {
            preparing = false;
            refresh();
            emit('toast:show', 'Add an API token in Settings before comparing models.', 'error');
            return;
        }
        const systemPrompt = state.config.systemPrompt;
        const params = normalizeGenerationParams(state.generationParams);
        const modelIds = columns.map(column => column.select.value);
        const runs = columns.map(column => {
            const run = { controller: new AbortController(), finished: false };
            column.run = run;
            column.output.textContent = '';
            column.status.textContent = 'Generating…';
            return run;
        });
        preparing = false;
        refresh();
        columns.forEach((column, index) => {
            const run = runs[index];
            streamPuterCompletion({
                apiUrl: 'https://api.puter.com/drivers/call',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, Accept: '*/*' },
                signal: run.controller.signal,
                requestBody: {
                    interface: 'puter-chat-completion', driver: 'ai-chat', test_mode: true, method: 'complete',
                    args: {
                        model: modelIds[index], stream: true,
                        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
                        ...(params.temperature !== null && { temperature: params.temperature }),
                        ...(params.maxTokens !== null && { max_tokens: params.maxTokens })
                    }
                },
                onPartialUpdate: update => {
                    if (!run.finished && column.run === run && update.accumulatedContent !== undefined) {
                        column.output.textContent = update.accumulatedContent;
                    }
                },
                onComplete: final => {
                    if (run.finished || column.run !== run) return;
                    if (final.accumulatedContent !== undefined) column.output.textContent = final.accumulatedContent;
                    finish(column, run, 'Complete');
                },
                onError: error => finish(column, run, error?.name === 'AbortError' ? 'Stopped' : `Error: ${error?.message || 'Request failed'}`)
            }).then(() => finish(column, run, 'Complete'))
                .catch(error => finish(column, run, error?.name === 'AbortError' ? 'Stopped' : `Error: ${error?.message || 'Request failed'}`));
        });
    };
    setTimeout(() => prompt.focus(), 60);
}

document.getElementById('compare-btn').addEventListener('click', openModelComparison);
