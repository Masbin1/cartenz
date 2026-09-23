/**
 * The pieces of the theme choice the server-rendered layout needs. Kept apart
 * from lib/theme.ts, which holds a React hook and so is client-only.
 */
export const THEME_STORAGE_KEY = 'cartenz.theme';

/**
 * Runs in <head> before the page paints, so a saved Dark choice never flashes
 * light on load. Kept tiny and dependency-free; it mirrors readPreference and
 * applyPreference in lib/theme.ts.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
