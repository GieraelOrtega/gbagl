(function initializeTheme() {
  const THEME_KEY = 'gbagl-theme';
  const MOTION_KEY = 'gbagl-reduce-motion';
  const THEMES = new Set(['system', 'light', 'dark']);
  const root = document.documentElement;

  function storedValue(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function themePreference() {
    const stored = storedValue(THEME_KEY, 'system');
    return THEMES.has(stored) ? stored : 'system';
  }

  function resolvedTheme(preference) {
    if (preference !== 'system') return preference;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(preference = themePreference()) {
    root.dataset.theme = resolvedTheme(preference);
    root.dataset.themePreference = preference;
  }

  function applyMotion(reduced = storedValue(MOTION_KEY, 'false') === 'true') {
    root.toggleAttribute('data-reduce-motion', reduced);
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  applyTheme();
  applyMotion();

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (themePreference() === 'system') applyTheme('system');
  });

  document.addEventListener('DOMContentLoaded', () => {
    const themeSelect = document.querySelector('[data-theme-select]');
    const motionToggle = document.querySelector('[data-reduce-motion]');
    const status = document.querySelector('[data-appearance-status]');
    if (themeSelect) {
      themeSelect.value = themePreference();
      themeSelect.addEventListener('change', () => {
        const preference = THEMES.has(themeSelect.value) ? themeSelect.value : 'system';
        const saved = save(THEME_KEY, preference);
        applyTheme(preference);
        if (status) status.textContent = saved
          ? 'Appearance saved on this device.'
          : 'This browser could not save the appearance setting.';
      });
    }
    if (motionToggle) {
      motionToggle.checked = root.hasAttribute('data-reduce-motion');
      motionToggle.addEventListener('change', () => {
        const saved = save(MOTION_KEY, String(motionToggle.checked));
        applyMotion(motionToggle.checked);
        if (status) status.textContent = saved
          ? 'Appearance saved on this device.'
          : 'This browser could not save the appearance setting.';
      });
    }
  });
}());
