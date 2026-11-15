import { emit } from './event-bus.js';
import { subscribe } from './store.js';

export function initializeVoiceInput() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const button = document.getElementById('voice-btn');
    const input = document.getElementById('user-input');
    if (!Recognition) return;

    let recognition = null;
    let prefix = '';
    let suffix = '';
    let rendered = '';
    let stopping = false;
    const stop = () => {
        if (recognition && !stopping) {
            stopping = true;
            try { recognition.stop(); } catch { stopping = false; }
        }
    };
    const setListening = listening => {
        button.classList.toggle('selected', listening);
        button.setAttribute('aria-pressed', String(listening));
        button.title = listening ? 'Stop voice input' : 'Start voice input';
        button.setAttribute('aria-label', button.title);
    };

    button.hidden = false;
    button.addEventListener('click', () => {
        if (recognition) {
            stop();
            return;
        }
        prefix = input.value.slice(0, input.selectionStart);
        suffix = input.value.slice(input.selectionEnd);
        rendered = input.value;
        const session = new Recognition();
        recognition = session;
        stopping = false;
        session.interimResults = true;
        session.continuous = true;
        session.onresult = event => {
            // Do not overwrite text typed manually while recognition was active.
            if (input.value !== rendered) {
                stop();
                return;
            }
            let spoken = '';
            for (let i = 0; i < event.results.length; i++) spoken += event.results[i][0].transcript;
            rendered = prefix + spoken + suffix;
            input.value = rendered;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        session.onerror = event => {
            if (event.error !== 'aborted') emit('toast:show', `Voice input failed: ${event.error || 'unknown error'}`, 'error');
        };
        session.onend = () => {
            if (recognition === session) recognition = null;
            stopping = false;
            setListening(false);
        };
        try {
            session.start();
            setListening(true);
        } catch (error) {
            recognition = null;
            setListening(false);
            emit('toast:show', `Voice input failed: ${error.message}`, 'error');
        }
    });
    subscribe((next, previous) => {
        if (next.currentChatId !== previous.currentChatId || (next.isGenerating && !previous.isGenerating)) stop();
    });
}
