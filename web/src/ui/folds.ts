/**
 * @fileoverview Collapsible side cards, shared by Budgeting and Retirement.
 *
 * License: BSD 3-Clause
 */

import {esc} from '../format';

//
// PUBLIC
//

/**
 * Makes every card in a side column collapsible to its title line (so a change in a lower card is
 * visible without scrolling), with a button that folds or opens them all. Folded cards are
 * remembered in this browser.
 * @param side The column holding the cards (.panel elements with an h3).
 * @param allBtn The "Collapse Settings" / "Expand Settings" button.
 * @param key localStorage key for the folded card titles.
 */
export function buildFolds(side: HTMLElement, allBtn: HTMLElement, key: string): void {
  const panels = [...side.querySelectorAll<HTMLElement>('.panel')];
  let folded = new Set<string>();
  try {
    folded = new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    // storage unavailable: start with everything open
  }
  const keyOf = (el: HTMLElement) => el.querySelector('h3')?.textContent?.trim() ?? '';
  const store = () => {
    try {
      localStorage.setItem(key, JSON.stringify([...folded]));
    } catch {
      // not remembered, which is fine
    }
  };
  const set = (el: HTMLElement, on: boolean) => {
    el.classList.toggle('folded', on);
    const b = el.querySelector<HTMLButtonElement>(':scope > .fold')!;
    b.setAttribute('aria-expanded', String(!on));
    b.textContent = on ? '▸' : '▾';
    if (on) folded.add(keyOf(el));
    else folded.delete(keyOf(el));
  };
  const markAll = () => {
    allBtn.textContent = panels.every((p) => p.classList.contains('folded')) ? 'Expand Settings' :
        'Collapse Settings';
  };
  panels.forEach((el) => {
    el.classList.add('foldable');
    el.insertAdjacentHTML('afterbegin', `<button class="fold" type="button" aria-expanded="true"
      aria-label="Show or hide ${esc(keyOf(el))}">▾</button>`);
    set(el, folded.has(keyOf(el)));
    el.querySelector(':scope > .fold')!.addEventListener('click', () => {
      set(el, !el.classList.contains('folded'));
      store();
      markAll();
    });
  });
  allBtn.addEventListener('click', () => {
    const fold = allBtn.textContent === 'Collapse Settings';
    panels.forEach((el) => set(el, fold));
    store();
    markAll();
  });
  markAll();
}
