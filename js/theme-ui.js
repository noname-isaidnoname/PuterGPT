// Theme dropdown UI — isolated from app.js to break the app.js hub cycle.
import { themeDefinitions } from './store.js';
import { els } from './state.js';

export function populateThemeDropdown() {
    if (!els.themeSelect) return;

    els.themeSelect.innerHTML = '';

    Object.entries(themeDefinitions).forEach(([key, theme]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = theme.name;
        els.themeSelect.appendChild(option);
    });

    const customOption = document.createElement('option');
    customOption.value = 'generate-custom';
    customOption.textContent = '🎨 Generate custom theme...';
    els.themeSelect.appendChild(customOption);
}
