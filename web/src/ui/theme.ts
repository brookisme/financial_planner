/**
 * @fileoverview The Auto / Light / Dark appearance switch. Auto follows the system setting; a
 * choice is remembered in this browser (the page head applies it before drawing).
 *
 * License: BSD 3-Clause
 */

//
// CONSTANTS
//
const KEY = 'fp-theme';
type Theme = 'auto'|'light'|'dark';

//
// PUBLIC
//

/** Wires the appearance buttons in the header. */
export function buildTheme(): void {
  const group = document.getElementById('theme');
  if (!group) return;
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')];
  const mark = (t: Theme) => buttons.forEach((b) => b.setAttribute('aria-pressed',
      String(b.dataset.v === t)));
  mark(saved());
  buttons.forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.v as Theme;
    apply(t);
    try {
      if (t === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      // storage unavailable (private window): the choice lasts until reload
    }
    mark(t);
  }));
}

//
// INTERNAL
//

/** The stored choice, or auto. */
function saved(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

/** Sets or clears the page's theme override. */
function apply(t: Theme): void {
  const root = document.documentElement;
  if (t === 'auto') {
    delete root.dataset.theme;
    root.style.colorScheme = '';
  } else {
    root.dataset.theme = t;
    root.style.colorScheme = t;
  }
}
