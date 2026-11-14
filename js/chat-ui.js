import { state, els } from './state.js';
import { generateUniqueId, getMessageText } from './utils.js';
import { emit, on } from './event-bus.js';

// getMessageText is re-exported from utils for backward compatibility
export { getMessageText };

// Copy Button Logic
export function decorateCodeBlocks(root) {
    const preBlocks = root.querySelectorAll('pre');

    preBlocks.forEach(pre => {
        if (pre.parentElement.classList.contains('code-block-wrapper')) {
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';

        // Banner header: language label on the left, actions on the right
        const header = document.createElement('div');
        header.className = 'code-block-header';

        const codeForLang = pre.querySelector('code');
        const langClass = codeForLang ? Array.from(codeForLang.classList).find(c => c.startsWith('language-')) : null;
        const langLabel = document.createElement('span');
        langLabel.className = 'code-block-lang';
        langLabel.textContent = langClass ? langClass.replace('language-', '').toUpperCase() : 'CODE';
        header.appendChild(langLabel);

        const actions = document.createElement('div');
        actions.className = 'code-block-actions';
        header.appendChild(actions);

        wrapper.appendChild(header);

        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.title = 'Copy code';
        btn.innerHTML = '<span class="material-icons-outlined">content_copy</span>';

        btn.onclick = (e) => {
            e.stopPropagation();
            const codeBlock = pre.querySelector('code');
            const text = codeBlock ? codeBlock.innerText : pre.innerText;

            navigator.clipboard.writeText(text).then(() => {
                btn.innerHTML = '<span class="material-icons-outlined">check</span>';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = '<span class="material-icons-outlined">content_copy</span>';
                    btn.classList.remove('copied');
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy:', err);
            });
        };

        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.insertBefore(pre, null); // append pre directly after the header
        actions.appendChild(btn);

        // Add a "Run" button for HTML / JavaScript code blocks.
        // The function `isRunnableLanguage` and `openCodeRunner` are exposed on
        // `window` by `js/code-runner.js`, which is loaded as a side-effect from
        // `js/app.js`, so they are available here at runtime.
        const codeBlock = pre.querySelector('code');
        if (codeBlock && typeof window.isRunnableLanguage === 'function' && typeof window.openCodeRunner === 'function') {
            const langClass = Array.from(codeBlock.classList).find(c => c.startsWith('language-'));
            const lang = langClass ? langClass.replace('language-', '') : '';
            const runnable = window.isRunnableLanguage(lang);
            if (runnable) {
                const runBtn = document.createElement('button');
                runBtn.className = `run-btn run-btn-${runnable}`;
                runBtn.title = runnable === 'html' ? 'Preview HTML' : 'Run JavaScript';
                runBtn.innerHTML = '<span class="material-icons-outlined">play_arrow</span>';
                runBtn.onclick = (e) => {
                    e.stopPropagation();
                    const text = codeBlock.innerText;
                    window.openCodeRunner(text, runnable);
                };
                // Insert the run button just before the copy button so copy stays
                // rightmost and the run button sits to its left.
                actions.insertBefore(runBtn, btn);
            }
        }
    });
}

// Message Rendering
export function renderMessage(index, message, isTyping = false) {
    const id = 'msg-' + generateUniqueId();
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${message.role}`;
    msgDiv.id = id;
    msgDiv.dataset.index = index;

    let innerContent = '';
    if (isTyping) {
        innerContent = `<div class="typing-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    } else {
        // Handle images in content
        if (message.images && message.images.length > 0) {
            const imageHtml = message.images.map(imgUrl => 
                `<img src="${imgUrl}" style="max-width: 300px; max-height: 300px; border-radius: 8px; margin: 4px;" alt="Attached image">`
            ).join('');
            innerContent += imageHtml;
        }
        
        // Handle text content
        const textContent = getMessageText(message);
        if (textContent.trim()) {
            innerContent += marked.parse(textContent);
        }
    }

    let reasoningHTML = '';
    if (!isTyping && message.reasoning && message.reasoning.trim().length > 0) {
        reasoningHTML = `
            <div class="reasoning-block">
                <div class="reasoning-header">
                    <span>Thinking Process</span>
                    <span class="material-icons-outlined" style="font-size:16px">expand_more</span>
                </div>
                <div class="reasoning-content">${message.reasoning}</div>
            </div>
        `;
    }

    let costHTML = '';
    if (!isTyping && message.role === 'assistant' && message.cost && message.cost.formatted) {
        const costDetails = message.cost.formatted === 'Free' 
            ? 'Free' 
            : `${message.cost.inputTokens} input, ${message.cost.outputTokens} output tokens`;
            
        costHTML = `
            <div class="message-cost">
                <span>
                    ${costDetails}
                </span>
                <span style="font-weight: 600; color: var(--text-primary); margin-left: 6px;">~${message.cost.formatted}</span>
            </div>
        `;
    }

    const bodyHTML = (message.role === 'user')
        ? `<div class="user-bubble">${innerContent}</div>`
        : `${costHTML}${reasoningHTML}<div class="rendered-content">${innerContent}</div>`;

    msgDiv.innerHTML = `
        <div class="message-wrapper">
            <div class="message-content">
                ${bodyHTML}
            </div>
            <div class="msg-footer">
                ${!isTyping && ((getMessageText(message) && getMessageText(message).trim().length > 0) || (message.reasoning && message.reasoning.trim().length > 0)) ? `
                    <button class="action-btn edit" onclick="enterEditMode(${index})" title="Edit Message">
                        <span class="material-icons-outlined">edit</span>
                    </button>
                ` : ''}
            </div>
        </div>
    `;

    els.chatContainer.appendChild(msgDiv);
    emit('ui:scroll-bottom');
    
    if (!isTyping && message.reasoning) {
        const rHeader = msgDiv.querySelector('.reasoning-header');
        const rContent = msgDiv.querySelector('.reasoning-content');
        const rIcon = rHeader.querySelector('.material-icons-outlined');
        rHeader.onclick = () => {
            const isOpen = rContent.classList.toggle('open');
            rIcon.textContent = isOpen ? 'expand_less' : 'expand_more';
        };
    }
    
    if(!isTyping && message.content) {
        const renderedDiv = msgDiv.querySelector('.rendered-content');
        if (renderedDiv) {
            renderedDiv.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
            decorateCodeBlocks(renderedDiv);
        }
    }

    emit('ui:scroll-bottom');
    return id;
}

export function reRenderAllMessages() {
    els.chatContainer.innerHTML = '';
    state.messages.forEach((msg, index) => {
        if (msg.content === '' && msg.role === 'assistant') return;
        renderMessage(index, msg);
    });
    emit('ui:scroll-bottom');
}

// Listen for message-append events
on('message:append', (index, message, isTyping = false) => {
    renderMessage(index, message, isTyping);
});

// Listen for rerender requests
on('messages:rerender', () => {
    reRenderAllMessages();
});
