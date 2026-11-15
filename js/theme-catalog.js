// Theme editor variable catalog.
//
// Every CSS custom property a theme can define is assigned to exactly one
// category (the editor renders one tab per category). `label` is shown next
// to the raw variable name; `hint` is optional extra guidance. Keep this in
// sync with js/store.js — tools/verify-theme-editor.js checks coverage.
export const THEME_VAR_CATEGORIES = [
    {
        id: 'surfaces',
        label: 'Surfaces',
        icon: 'layers',
        description: 'Backgrounds, hover states and message bubbles',
        vars: [
            { name: '--bg-primary', label: 'App background' },
            { name: '--bg-secondary', label: 'Secondary surface' },
            { name: '--bg-sidebar', label: 'Sidebar background' },
            { name: '--bg-tertiary', label: 'Tertiary surface' },
            { name: '--secondary-bg', label: 'Secondary background (alias)', hint: 'Kept for compatibility; usually same as --bg-secondary' },
            { name: '--input-bg', label: 'Input background' },
            { name: '--user-msg-bg', label: 'User message bubble' },
            { name: '--ai-msg-bg', label: 'Assistant message bubble' },
            { name: '--bg-hover', label: 'Hover background' },
            { name: '--hover-bg', label: 'Hover background (alias)' },
            { name: '--hover-overlay', label: 'Hover overlay (translucent)' },
            { name: '--hover-light', label: 'Hover light (translucent)' },
            { name: '--sidebar-hover', label: 'Sidebar item hover' },
            { name: '--btn-hover-bg', label: 'Button hover background' },
            { name: '--btn-hover-border', label: 'Button hover border' },
            { name: '--btn-primary-hover-bg', label: 'Primary button hover background' },
            { name: '--danger-hover', label: 'Danger button hover' },
            { name: '--danger-bg', label: 'Danger surface background' },
            { name: '--danger-border', label: 'Danger surface border' },
            { name: '--modal-overlay', label: 'Modal overlay backdrop' },
            { name: '--gradient-start', label: 'Welcome gradient start', hint: 'Usually a translucent stop for the welcome view gradient' },
            { name: '--chat-bg-pattern', label: 'Chat background pattern', hint: 'CSS image (e.g. url(...)) or none' },
            { name: '--user-avatar-bg', label: 'User avatar background' }
        ]
    },
    {
        id: 'text',
        label: 'Text',
        icon: 'format_size',
        description: 'Text colors, links and indicators',
        vars: [
            { name: '--text-primary', label: 'Primary text' },
            { name: '--text-secondary', label: 'Secondary text' },
            { name: '--text-caption', label: 'Caption / muted text' },
            { name: '--link-color', label: 'Link color' },
            { name: '--link-hover', label: 'Link hover' },
            { name: '--typing-indicator', label: 'Typing indicator dots' },
            { name: '--loading-spinner', label: 'Loading spinner' },
            { name: '--scrollbar-track', label: 'Scrollbar track' },
            { name: '--scrollbar-thumb', label: 'Scrollbar thumb' },
            { name: '--scrollbar-thumb-hover', label: 'Scrollbar thumb hover' }
        ]
    },
    {
        id: 'accent',
        label: 'Accent',
        icon: 'palette',
        description: 'Brand and accent colors (accent and primary are mirrors — set both)',
        vars: [
            { name: '--accent', label: 'Accent' },
            { name: '--accent-hover', label: 'Accent hover' },
            { name: '--accent-soft', label: 'Accent soft (translucent)' },
            { name: '--accent-bright', label: 'Accent bright' },
            { name: '--primary-color', label: 'Primary color', hint: 'Mirror of --accent' },
            { name: '--primary-hover', label: 'Primary hover', hint: 'Mirror of --accent-hover' },
            { name: '--primary-color-dark', label: 'Primary dark shade' },
            { name: '--primary-color-rgb', label: 'Primary color as RGB triplet', hint: 'Bare "r, g, b" — used inside rgba(), not a hex color' },
            { name: '--input-focus-border', label: 'Input focus border' },
            { name: '--focus-border', label: 'Focus border' }
        ]
    },
    {
        id: 'borders',
        label: 'Borders',
        icon: 'border_style',
        description: 'Border colors',
        vars: [
            { name: '--border-color', label: 'Border' },
            { name: '--border-strong', label: 'Border (strong)' },
            { name: '--table-border', label: 'Table border' },
            { name: '--code-border', label: 'Code block border' },
            { name: '--blockquote-border', label: 'Blockquote border' }
        ]
    },
    {
        id: 'status',
        label: 'Status',
        icon: 'info',
        description: 'Success / danger / warning colors',
        vars: [
            { name: '--success', label: 'Success' },
            { name: '--danger', label: 'Danger' },
            { name: '--danger-color', label: 'Danger (text/icon)', hint: 'Mirror of --danger' },
            { name: '--warning', label: 'Warning' }
        ]
    },
    {
        id: 'code',
        label: 'Code & Tables',
        icon: 'code',
        description: 'Code blocks, tables and blockquotes',
        vars: [
            { name: '--code-bg', label: 'Code background' },
            { name: '--pre-bg', label: 'Code block background' },
            { name: '--code-banner', label: 'Code banner' },
            { name: '--table-header-bg', label: 'Table header background' },
            { name: '--table-row-hover', label: 'Table row hover' },
            { name: '--blockquote-bg', label: 'Blockquote background' }
        ]
    },
    {
        id: 'toasts',
        label: 'Toasts',
        icon: 'notifications',
        description: 'Toast notification colors',
        vars: [
            { name: '--toast-info-bg', label: 'Info toast background' },
            { name: '--toast-info-border', label: 'Info toast border' },
            { name: '--toast-info-text', label: 'Info toast text' },
            { name: '--toast-warning-bg', label: 'Warning toast background' },
            { name: '--toast-warning-border', label: 'Warning toast border' },
            { name: '--toast-warning-text', label: 'Warning toast text' },
            { name: '--toast-error-bg', label: 'Error toast background' },
            { name: '--toast-error-border', label: 'Error toast border' },
            { name: '--toast-error-text', label: 'Error toast text' },
            { name: '--toast-success-bg', label: 'Success toast background' },
            { name: '--toast-success-border', label: 'Success toast border' },
            { name: '--toast-success-text', label: 'Success toast text' }
        ]
    },
    {
        id: 'effects',
        label: 'Effects',
        icon: 'auto_awesome',
        description: 'Selection, glow and shadows',
        vars: [
            { name: '--selection-bg', label: 'Text selection background' },
            { name: '--glow-effect', label: 'Glow effect' },
            { name: '--shadow-sm', label: 'Shadow (small)' },
            { name: '--shadow-md', label: 'Shadow (medium)' },
            { name: '--shadow-lg', label: 'Shadow (large)' },
            { name: '--shadow-input', label: 'Input shadow' },
            { name: '--shadow-pill', label: 'Pill shadow' }
        ]
    },
    {
        id: 'layout',
        label: 'Layout & Type',
        icon: 'straighten',
        description: 'Sizing, radii, motion and fonts',
        vars: [
            { name: '--sidebar-width', label: 'Sidebar width' },
            { name: '--avatar-size', label: 'Avatar size' },
            { name: '--content-max-width', label: 'Message column max width' },
            { name: '--content-padding-horizontal', label: 'Message column side padding' },
            { name: '--scrollbar-width', label: 'Scrollbar width' },
            { name: '--scrollbar-width-modal', label: 'Scrollbar width (modals)' },
            { name: '--radius-sm', label: 'Radius (small)' },
            { name: '--radius-md', label: 'Radius (medium)' },
            { name: '--radius-lg', label: 'Radius (large)' },
            { name: '--radius-xl', label: 'Radius (extra large)' },
            { name: '--radius-pill', label: 'Radius (pill)' },
            { name: '--input-border-radius', label: 'Composer border radius' },
            { name: '--message-border-radius', label: 'Message bubble radius' },
            { name: '--transition-speed', label: 'Transition speed' },
            { name: '--animation-easing', label: 'Animation easing' },
            { name: '--font-sans', label: 'UI font stack' },
            { name: '--font-mono', label: 'Monospace font stack' }
        ]
    },
    {
        id: 'runner',
        label: 'Code Runner',
        icon: 'play_circle',
        description: 'The sandboxed code-runner modal',
        vars: [
            { name: '--runner-iframe-bg', label: 'Runner iframe background' },
            { name: '--runner-btn-size', label: 'Run button size' },
            { name: '--runner-btn-color-idle', label: 'Run button icon (idle)' },
            { name: '--runner-btn-color-hover', label: 'Run button icon (hover)' },
            { name: '--runner-btn-bg-idle', label: 'Run button background (idle)' },
            { name: '--runner-btn-bg-hover', label: 'Run button background (hover)' },
            { name: '--runner-btn-border-hover', label: 'Run button border (hover)' },
            { name: '--runner-btn-opacity-idle', label: 'Run button opacity (idle)' },
            { name: '--runner-btn-opacity-hover', label: 'Run button opacity (hover)' },
            { name: '--runner-btn-icon-size', label: 'Run button icon size' },
            { name: '--runner-modal-width', label: 'Runner modal width' },
            { name: '--runner-modal-max-width', label: 'Runner modal max width' },
            { name: '--runner-modal-height', label: 'Runner modal height' },
            { name: '--runner-modal-max-height', label: 'Runner modal max height' },
            { name: '--runner-modal-header-pad', label: 'Runner header padding' },
            { name: '--runner-modal-title-size', label: 'Runner title font size' },
            { name: '--runner-modal-iframe-min', label: 'Runner iframe min height' }
        ]
    }
];

export const CATALOG_VAR_NAMES = new Set(
    THEME_VAR_CATEGORIES.flatMap(category => category.vars.map(v => v.name))
);
