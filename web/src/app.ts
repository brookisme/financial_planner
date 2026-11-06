/**
 * @fileoverview Shared app context: the loaded data, the current settings, saving them to the
 * plan folder, and a simple change notification every section listens to.
 *
 * License: BSD 3-Clause
 */

import {get, send} from './api';
import {Data, defaults, rebase} from './model';
import type {Payload, Settings} from './types';

//
// CONSTANTS
//
const SAVE_DELAY_MS = 400;

//
// PUBLIC
//

/** The live app context. */
export const app = {
  d: null as unknown as Data,
  S: null as unknown as Settings,
  defs: null as unknown as Settings,
};

/** Element by id (throws if missing so mistakes surface early). */
export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/** Input element by id. */
export function $in(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

/** Registers a function to run after any settings change. */
export function onChange(fn: () => void): void {
  listeners.push(fn);
}

/** Saves the settings (debounced) and tells every section to update. */
export function changed(): void {
  scheduleSave();
  listeners.forEach((fn) => fn());
}

/** Number from an input ('' counts as 0). */
export function num(el: HTMLInputElement): number {
  const v = parseFloat(el.value);
  return isNaN(v) ? 0 : v;
}

/**
 * Loads the payload and saved UI state.
 * @returns The payload (check its error field).
 */
export async function load(): Promise<Payload> {
  const p = await get<Payload>('/api/payload');
  if (p.error) return p;
  app.d = new Data(p);
  app.defs = defaults(app.d);
  const state = await get<{ui?: {S?: Settings; base?: Settings}}>('/api/state');
  app.S = rebase(app.defs, state.ui?.S, state.ui?.base);
  return p;
}

/** Saves now (used before reloading the page after a settings change). */
export async function saveNow(): Promise<void> {
  if (timer) window.clearTimeout(timer);
  timer = 0;
  await send('PUT', '/api/state/ui', {S: app.S, base: app.defs});
}

/** Tooltip helpers shared by the charts. */
export function showTip(e: MouseEvent, html: string): void {
  const tip = $('tip');
  tip.innerHTML = html;
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 250)}px`;
  tip.style.top = `${e.clientY + 14}px`;
}

/** Hides the tooltip. */
export function hideTip(): void {
  $('tip').hidden = true;
}

/** Smooth scroll unless the user prefers reduced motion. */
export function scrollToEl(el: Element): void {
  el.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ?
      'auto' : 'smooth'});
}

//
// INTERNAL
//
const listeners: Array<() => void> = [];
let timer = 0;

/** Debounced save of the current settings. */
function scheduleSave(): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    send('PUT', '/api/state/ui', {S: app.S, base: app.defs}).catch(() => {});
  }, SAVE_DELAY_MS);
}
