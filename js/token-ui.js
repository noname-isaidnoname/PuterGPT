// Token UI Orchestrator - re-exports & global bindings
import {
    renderTokenList,
    addToken,
    deleteToken,
    setActiveToken,
    editTokenName,
    toggleTokenDisabled
} from './token-ui-list.js';

import {
    toggleTokenRotation,
    initializeTokenManagement
} from './token-ui-rotation.js';

import {
    showTokenGuide,
    importTokens,
    exportTokens
} from './token-ui-modals.js';

import { quickRegisterToken } from './token-ui-quick.js';

export { initializeTokenManagement };

// Attach to window for HTML inline onclick handlers
window.addToken = addToken;
window.deleteToken = deleteToken;
window.setActiveToken = setActiveToken;
window.editTokenName = editTokenName;
window.toggleTokenDisabled = toggleTokenDisabled;
window.toggleTokenRotation = toggleTokenRotation;
window.showTokenGuide = showTokenGuide;
window.importTokens = importTokens;
window.exportTokens = exportTokens;
window.quickRegisterToken = quickRegisterToken;