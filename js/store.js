const createStoreImpl = (createState) => {
  let state;
  const listeners = new Set();
  const setState = (partial, replace) => {
    const nextState = typeof partial === "function" ? partial(state) : partial;
    if (!Object.is(nextState, state)) {
      const previousState = state;
      state = (replace != null ? replace : typeof nextState !== "object" || nextState === null) ? nextState : Object.assign({}, state, nextState);
      listeners.forEach((listener) => listener(state, previousState));
    }
  };
  const getState = () => state;
  const getInitialState = () => initialState;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const api = { setState, getState, getInitialState, subscribe };
  const initialState = state = createState(setState, getState, api);
  return api;
};
const createStore = ((createState) => createState ? createStoreImpl(createState) : createStoreImpl);
const applyMiddleware = (...middlewares) => (createState) => {
  const enhancedCreateState = middlewares.reduceRight((acc, middleware) => middleware(acc), createState);
  return createStoreImpl(enhancedCreateState);
};

// Theme definitions
export const themeDefinitions = {
  light: {
    name: '☀️ Light',
    cssVars: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f5f6f8',
      '--bg-sidebar': '#f9fafb',
      '--bg-tertiary': '#f5f6f8',
      '--secondary-bg': '#f5f6f8',
      '--text-primary': '#0f1115',
      '--text-secondary': '#61666b',
      '--text-caption': '#9ca3af',
      '--border-color': '#e3e6ea',
      '--border-strong': '#d2d6dc',
      '--input-bg': '#ffffff',
      '--user-msg-bg': '#e9f6ee',
      '--ai-msg-bg': 'transparent',
      '--accent': '#10a37f',
      '--accent-hover': '#0f8a6c',
      '--accent-soft': 'rgba(16, 163, 127, 0.10)',
      '--accent-bright': '#10a37f',
      '--primary-color': '#10a37f',
      '--primary-hover': '#0f8a6c',
      '--primary-color-dark': '#0c6e55',
      '--primary-color-rgb': '16, 163, 127',
      '--success': '#10b981',
      '--danger': '#dc2626',
      '--danger-color': '#dc2626',
      '--warning': '#d97706',
      '--btn-hover-bg': '#eff1f4',
      '--btn-hover-border': '#e3e6ea',
      '--btn-primary-hover-bg': '#0f8a6c',
      '--input-focus-border': '#10a37f',
      '--focus-border': '#10a37f',
      '--hover-overlay': 'rgba(15, 17, 21, 0.05)',
      '--hover-light': 'rgba(15, 17, 21, 0.06)',
      '--hover-bg': '#eff1f4',
      '--bg-hover': '#eff1f4',
      '--radius-sm': '6px',
      '--radius-md': '10px',
      '--radius-lg': '14px',
      '--radius-xl': '24px',
      '--radius-pill': '100px',
      '--font-sans': "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      '--shadow-sm': '0 1px 2px 0 rgba(15, 17, 21, 0.04)',
      '--shadow-md': '0 2px 4px rgba(15, 17, 21, 0.03), 0 8px 24px rgba(15, 17, 21, 0.06)',
      '--shadow-lg': '0 0 1px rgba(15, 17, 21, 0.15), 0 12px 32px rgba(15, 17, 21, 0.12)',
      '--shadow-input': '0 2px 2px rgba(15, 17, 21, 0.02), 0 6px 16px rgba(15, 17, 21, 0.05)',
      '--shadow-pill': '0 1px 1px rgba(16, 24, 32, 0.03), 0 2px 4px rgba(16, 24, 32, 0.05), 0 8px 20px rgba(16, 24, 32, 0.05)',
      '--user-avatar-bg': '#10a37f',
      '--gradient-start': 'rgba(255, 255, 255, 0)',
      '--input-border-radius': '26px',
      '--danger-hover': '#b91c1c',
      '--danger-bg': 'rgba(220, 38, 38, 0.08)',
      '--danger-border': 'rgba(220, 38, 38, 0.18)',
      '--modal-overlay': 'rgba(15, 17, 21, 0.45)',
      '--sidebar-width': '261px',
      '--avatar-size': '32px',
      '--content-max-width': '840px',
      '--content-padding-horizontal': '44px',
      '--font-mono': 'Menlo, Monaco, Consolas, "Cascadia Mono", "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
      '--scrollbar-width': '6px',
      '--scrollbar-width-modal': '8px',
      '--message-border-radius': '18px',
      '--code-bg': '#f6f7f9',
      '--code-border': '#e7e9ec',
      '--code-banner': '#eceef1',
      '--pre-bg': '#f6f7f9',
      '--blockquote-bg': 'rgba(15, 17, 21, 0.03)',
      '--blockquote-border': '#10a37f',
      '--link-color': '#0f8a6c',
      '--link-hover': '#0c6e55',
      '--table-border': '#e3e6ea',
      '--table-header-bg': '#f5f6f8',
      '--table-row-hover': 'rgba(0, 0, 0, 0.03)',
      '--scrollbar-track': 'transparent',
      '--scrollbar-thumb': '#d2d6dc',
      '--scrollbar-thumb-hover': '#b6bcc4',
      '--selection-bg': 'rgba(16, 163, 127, 0.22)',
      '--loading-spinner': '#10a37f',
      '--typing-indicator': '#9ca3af',
      '--sidebar-hover': 'rgba(15, 17, 21, 0.05)',
      '--chat-bg-pattern': 'none',
      '--glow-effect': 'rgba(16, 163, 127, 0.25)',
      '--transition-speed': '0.2s',
      '--animation-easing': 'ease-out',
      '--runner-iframe-bg': '#ffffff',

      '--toast-info-bg': '#21262c',
      '--toast-info-border': '#21262c',
      '--toast-info-text': '#eceff3',
      '--toast-warning-bg': '#3f2d0c',
      '--toast-warning-border': '#5a4517',
      '--toast-warning-text': '#f5c97b',
      '--toast-error-bg': '#3f1515',
      '--toast-error-border': '#5a1f1f',
      '--toast-error-text': '#ffb3b3',
      '--toast-success-bg': '#102e23',
      '--toast-success-border': '#1f4a38',
      '--toast-success-text': '#8affd1',

      '--runner-btn-size':           '28px',
      '--runner-btn-color-idle':     'var(--text-secondary)',
      '--runner-btn-bg-idle':        'transparent',
      '--runner-btn-color-hover':    'var(--text-primary)',
      '--runner-btn-bg-hover':       'var(--hover-light)',
      '--runner-btn-border-hover':   'transparent',
      '--runner-btn-opacity-idle':   '1',
      '--runner-btn-opacity-hover':  '1',
      '--runner-btn-icon-size':      '16px',

      '--runner-modal-width':        '90vw',
      '--runner-modal-max-width':    '90vw',
      '--runner-modal-height':       '85vh',
      '--runner-modal-max-height':   '85vh',
      '--runner-modal-header-pad':   '12px 16px',
      '--runner-modal-title-size':   '1rem',
      '--runner-modal-iframe-min':   '60vh'
    }
  },
  dark: {
    name: '🌙 Dark',
    cssVars: {
      '--bg-primary': '#151518',
      '--bg-secondary': '#232327',
      '--bg-sidebar': '#1b1b1e',
      '--bg-tertiary': '#232327',
      '--secondary-bg': '#232327',
      '--text-primary': '#f6f7f8',
      '--text-secondary': '#bfc3c7',
      '--text-caption': '#8b8f94',
      '--border-color': 'rgba(255, 255, 255, 0.09)',
      '--border-strong': 'rgba(255, 255, 255, 0.16)',
      '--input-bg': '#2c2c30',
      '--user-msg-bg': '#21302a',
      '--ai-msg-bg': 'transparent',
      '--accent': '#10a37f',
      '--accent-hover': '#13b57f',
      '--accent-soft': 'rgba(16, 163, 127, 0.18)',
      '--accent-bright': '#34d399',
      '--primary-color': '#10a37f',
      '--primary-hover': '#13b57f',
      '--primary-color-dark': '#0c6e55',
      '--primary-color-rgb': '16, 163, 127',
      '--success': '#10b981',
      '--danger': '#f26060',
      '--danger-color': '#f26060',
      '--warning': '#f5a623',
      '--btn-hover-bg': 'rgba(255, 255, 255, 0.07)',
      '--btn-hover-border': 'rgba(255, 255, 255, 0.12)',
      '--btn-primary-hover-bg': '#13b57f',
      '--input-focus-border': '#13b57f',
      '--focus-border': '#13b57f',
      '--hover-overlay': 'rgba(255, 255, 255, 0.08)',
      '--hover-light': 'rgba(255, 255, 255, 0.07)',
      '--hover-bg': 'rgba(255, 255, 255, 0.07)',
      '--bg-hover': 'rgba(255, 255, 255, 0.07)',
      '--radius-sm': '6px',
      '--radius-md': '10px',
      '--radius-lg': '14px',
      '--radius-xl': '24px',
      '--radius-pill': '100px',
      '--font-sans': "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.3)',
      '--shadow-md': '0 2px 4px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35)',
      '--shadow-lg': '0 0 1px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.45)',
      '--shadow-input': '0 2px 6px rgba(0, 0, 0, 0.25), 0 10px 28px rgba(0, 0, 0, 0.3)',
      '--shadow-pill': 'inset 0 1px 1px rgba(255, 255, 255, 0.09), 0 2px 6px rgba(0, 0, 0, 0.35)',
      '--user-avatar-bg': '#10a37f',
      '--gradient-start': 'rgba(21, 21, 24, 0)',
      '--input-border-radius': '26px',
      '--danger-hover': '#ef4444',
      '--danger-bg': 'rgba(242, 96, 96, 0.12)',
      '--danger-border': 'rgba(242, 96, 96, 0.25)',
      '--modal-overlay': 'rgba(0, 0, 0, 0.6)',
      '--sidebar-width': '261px',
      '--avatar-size': '32px',
      '--content-max-width': '840px',
      '--content-padding-horizontal': '44px',
      '--font-mono': 'Menlo, Monaco, Consolas, "Cascadia Mono", "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
      '--scrollbar-width': '6px',
      '--scrollbar-width-modal': '8px',
      '--message-border-radius': '18px',
      '--code-bg': '#1b1b1f',
      '--code-border': 'rgba(255, 255, 255, 0.07)',
      '--code-banner': '#202027',
      '--pre-bg': '#1b1b1f',
      '--blockquote-bg': 'rgba(255, 255, 255, 0.03)',
      '--blockquote-border': '#10a37f',
      '--link-color': '#34d399',
      '--link-hover': '#6ee7b7',
      '--table-border': 'rgba(255, 255, 255, 0.09)',
      '--table-header-bg': '#202027',
      '--table-row-hover': 'rgba(255, 255, 255, 0.04)',
      '--scrollbar-track': 'transparent',
      '--scrollbar-thumb': 'rgba(255, 255, 255, 0.14)',
      '--scrollbar-thumb-hover': 'rgba(255, 255, 255, 0.22)',
      '--selection-bg': 'rgba(16, 163, 127, 0.35)',
      '--loading-spinner': '#10a37f',
      '--typing-indicator': '#6f757c',
      '--sidebar-hover': 'rgba(255, 255, 255, 0.05)',
      '--chat-bg-pattern': 'none',
      '--glow-effect': 'rgba(16, 163, 127, 0.4)',
      '--transition-speed': '0.2s',
      '--animation-easing': 'ease-out',
      '--runner-iframe-bg': '#ffffff',

      '--toast-info-bg': '#2c2c30',
      '--toast-info-border': 'rgba(255, 255, 255, 0.12)',
      '--toast-info-text': '#eceff3',
      '--toast-warning-bg': '#3a2c0e',
      '--toast-warning-border': '#57441a',
      '--toast-warning-text': '#ffd08a',
      '--toast-error-bg': '#3a1518',
      '--toast-error-border': '#59232a',
      '--toast-error-text': '#ffb3b3',
      '--toast-success-bg': '#123122',
      '--toast-success-border': '#1d4a34',
      '--toast-success-text': '#8affd1',

      '--runner-btn-size':           '28px',
      '--runner-btn-color-idle':     'var(--text-secondary)',
      '--runner-btn-bg-idle':        'transparent',
      '--runner-btn-color-hover':    'var(--text-primary)',
      '--runner-btn-bg-hover':       'var(--hover-light)',
      '--runner-btn-border-hover':   'transparent',
      '--runner-btn-opacity-idle':   '1',
      '--runner-btn-opacity-hover':  '1',
      '--runner-btn-icon-size':      '16px',

      '--runner-modal-width':        '90vw',
      '--runner-modal-max-width':    '90vw',
      '--runner-modal-height':       '85vh',
      '--runner-modal-max-height':   '85vh',
      '--runner-modal-header-pad':   '12px 16px',
      '--runner-modal-title-size':   '1rem',
      '--runner-modal-iframe-min':   '60vh'
    }
  },
};

// Create the main application store
const useAppStore = createStore((set, get) => ({
  // Chat state
  messages: [],
  currentChatId: null,
  attachedImages: [], // Array of { file, dataUrl, name } objects
  
  // Models state
  models: [],
  
  // Configuration state
  config: {
    systemPrompt: 'You are a helpful assistant.', // Default fallback
    modelId: 'openrouter:stepfun/step-3.5-flash:free', // Default fallback
    autoScroll: true, // Default fallback
    tokenRotation: false, // Default fallback
    enableWebSearch: false, // Default fallback
    theme: 'dark' // Default fallback
  },
  
  // Track original settings for comparison
  originalSettings: {
    systemPrompt: 'You are a helpful assistant.',
    modelId: 'openrouter:stepfun/step-3.5-flash:free',
    autoScroll: true,
    tokenRotation: false,
    enableWebSearch: false,
    theme: 'dark'
  },
  
  // Operation tracking
  lastOperationId: null,
  abortController: null,
  // Single source of truth for "an AI response is being generated" —
  // drives the send/stop button and blocks concurrent requests.
  isGenerating: false,
  
  // Actions for updating state
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ 
    messages: [...state.messages, message] 
  })),
  
  setCurrentChatId: (currentChatId) => set({ currentChatId }),
  
  setAttachedImages: (attachedImages) => set({ attachedImages }),
  addAttachedImage: (image) => set((state) => ({ 
    attachedImages: [...state.attachedImages, image] 
  })),
  clearAttachedImages: () => set({ attachedImages: [] }),
  
  setModels: (models) => set({ models }),
  
  updateConfig: (configUpdates) => set((state) => ({ 
    config: { ...state.config, ...configUpdates } 
  })),
  
  updateOriginalSettings: (settings) => set({ originalSettings: settings }),
  
  // Reset chat state for new chat
  newChat: () => set({ 
    currentChatId: null, 
    messages: [], 
    attachedImages: [] 
  }),
  
  // Load chat data
  loadChat: (chatData) => set({
    currentChatId: chatData.id,
    messages: chatData.messages,
    attachedImages: []
  })
}));

// Export store instance for direct access
const appStore = useAppStore;

// Export convenience functions
export const getState = () => appStore.getState();
export const setState = (updates) => appStore.setState(updates);
export const subscribe = (listener) => appStore.subscribe(listener);
