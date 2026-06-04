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
  dark: {
    name: '🌙 Dark',
    cssVars: {
      '--bg-primary': '#0d0d0d',
      '--bg-secondary': '#171717',
      '--bg-sidebar': '#000000',
      '--text-primary': '#f2f2f2',
      '--text-secondary': '#a6a6a6',
      '--border-color': '#2f2f2f',
      '--input-bg': '#1a1a1a',
      '--user-msg-bg': 'transparent',
      '--ai-msg-bg': '#171717',
      '--accent': '#10a37f',
      '--accent-hover': '#1a7f64',
      '--danger': '#ef4444',
      '--warning': '#f59e0b',
      '--btn-hover-bg': '#262626',
      '--btn-hover-border': '#404040',
      '--btn-primary-hover-bg': '#e5e5e5',
      '--input-focus-border': '#404040',
      '--hover-overlay': 'rgba(64, 64, 64, 0.1)',
      '--radius-sm': '4px',
      '--radius-md': '8px',
      '--radius-lg': '12px',
      '--radius-xl': '24px',
      '--font-sans': "'Inter', -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif",
      '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
      '--shadow-md': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      '--user-avatar-bg': '#5436da',
      '--gradient-start': 'rgba(13, 13, 13, 0)',
      '--input-border-radius': '26px',
      '--focus-border': '#404040',
      '--hover-light': 'rgba(255, 255, 255, 0.1)',
      '--danger-hover': '#dc2626',
      '--danger-bg': 'rgba(239, 68, 68, 0.1)',
      '--danger-border': 'rgba(239, 68, 68, 0.2)',
      '--modal-overlay': 'rgba(0, 0, 0, 0.7)',
      '--sidebar-width': '260px',
      '--avatar-size': '32px',
      '--font-mono': "'Fira Code', 'Consolas', 'Monaco', monospace",
      '--scrollbar-width': '6px',
      '--scrollbar-width-modal': '8px',
      // Enhanced creative variables
      '--message-border-radius': '18px',
      '--code-bg': '#1e1e1e',
      '--code-border': '#333333',
      '--pre-bg': '#1a1a1a',
      '--blockquote-bg': 'rgba(255, 255, 255, 0.05)',
      '--blockquote-border': '#444444',
      '--link-color': '#10a37f',
      '--link-hover': '#1a7f64',
      '--table-border': '#333333',
      '--table-header-bg': '#2a2a2a',
      '--table-row-hover': 'rgba(255, 255, 255, 0.05)',
      '--scrollbar-track': '#1a1a1a',
      '--scrollbar-thumb': '#404040',
      '--scrollbar-thumb-hover': '#555555',
      '--selection-bg': 'rgba(16, 163, 127, 0.3)',
      '--loading-spinner': '#10a37f',
      '--typing-indicator': '#666666',
      '--sidebar-hover': 'rgba(255, 255, 255, 0.05)',
      '--chat-bg-pattern': 'none',
      '--glow-effect': 'rgba(16, 163, 127, 0.5)',
      '--transition-speed': '0.2s',
      '--animation-easing': 'ease-out'
    }
  },
  light: {
    name: '☀️ Light',
    cssVars: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f8f9fa',
      '--bg-sidebar': '#f1f3f4',
      '--text-primary': '#1a1a1a',
      '--text-secondary': '#666666',
      '--border-color': '#e0e0e0',
      '--input-bg': '#ffffff',
      '--user-msg-bg': 'transparent',
      '--ai-msg-bg': '#f8f9fa',
      '--accent': '#10a37f',
      '--accent-hover': '#0d7f66',
      '--danger': '#dc3545',
      '--warning': '#fd7e14',
      '--btn-hover-bg': '#e9ecef',
      '--btn-hover-border': '#ced4da',
      '--btn-primary-hover-bg': '#404040',
      '--input-focus-border': '#10a37f',
      '--hover-overlay': 'rgba(0, 0, 0, 0.05)',
      '--radius-sm': '4px',
      '--radius-md': '8px',
      '--radius-lg': '12px',
      '--radius-xl': '24px',
      '--font-sans': "'Inter', -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif",
      '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
      '--shadow-md': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      '--user-avatar-bg': '#5436da',
      '--gradient-start': 'rgba(255, 255, 255, 0)',
      '--input-border-radius': '26px',
      '--focus-border': '#10a37f',
      '--hover-light': 'rgba(0, 0, 0, 0.05)',
      '--danger-hover': '#b91c1c',
      '--danger-bg': 'rgba(220, 53, 69, 0.1)',
      '--danger-border': 'rgba(220, 53, 69, 0.2)',
      '--modal-overlay': 'rgba(0, 0, 0, 0.5)',
      '--sidebar-width': '260px',
      '--avatar-size': '32px',
      '--font-mono': "'Fira Code', 'Consolas', 'Monaco', monospace",
      '--scrollbar-width': '6px',
      '--scrollbar-width-modal': '8px',
      // Enhanced creative variables
      '--message-border-radius': '18px',
      '--code-bg': '#f6f8fa',
      '--code-border': '#e1e4e8',
      '--pre-bg': '#f6f8fa',
      '--blockquote-bg': 'rgba(0, 0, 0, 0.03)',
      '--blockquote-border': '#d0d7de',
      '--link-color': '#0969da',
      '--link-hover': '#0550ae',
      '--table-border': '#d0d7de',
      '--table-header-bg': '#f6f8fa',
      '--table-row-hover': 'rgba(0, 0, 0, 0.03)',
      '--scrollbar-track': '#f1f3f4',
      '--scrollbar-thumb': '#c1c7cd',
      '--scrollbar-thumb-hover': '#9ca3af',
      '--selection-bg': 'rgba(16, 163, 127, 0.2)',
      '--loading-spinner': '#10a37f',
      '--typing-indicator': '#999999',
      '--sidebar-hover': 'rgba(0, 0, 0, 0.04)',
      '--chat-bg-pattern': 'none',
      '--glow-effect': 'rgba(16, 163, 127, 0.3)',
      '--transition-speed': '0.2s',
      '--animation-easing': 'ease-out'
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
