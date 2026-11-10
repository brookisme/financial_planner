/**
 * @fileoverview Budgets: named snapshots of the Budgeting settings only (planned categories,
 * credit toggles, income, savings, annual expenses, emergency costs). Save / update / delete /
 * start over; picking a budget fills Planned / mo, and every budget can be the Compare column.
 * 529 and retirement settings are not part of a budget, but the same budget buttons sit at the
 * top of College 529s and Retirement (their contributions come from the budget); all of them
 * switch the one active budget.
 *
 * License: BSD 3-Clause
 */

import {get, send} from '../api';
import {$, $in, app, changed, onChange} from '../app';
import {esc} from '../format';
import {clone, diffBudget, rebaseBudget} from '../model';
import type {PlannerState, SavedBudget} from '../types';
import {fillPlanner, refreshCompare} from './planner';
import {refreshSpending} from './spending';
import {refreshStrip} from './strip';

//
// PUBLIC
//

/** Saved budgets (for the Compare column and the summary rows). */
export function savedBudgets(): SavedBudget[] {
  return state.list;
}

/** Id of the 12-month average, offered first wherever a budget is picked. */
export const AVG = '__avg';

/** Choices for a budget picker: the 12-month average, then every saved budget. */
export function budgetChoices(): Array<[string, string]> {
  return [[AVG, `${app.d.n}-mo avg`], ...state.list.map((b): [string, string] => [b.id, b.name])];
}

/** A budget's settings by id (AVG: the 12-month averages), or null if it no longer exists. */
export function budgetSt(id: string|null): PlannerState|null {
  if (id === AVG) return app.defs.st;
  const b = state.list.find((x) => x.id === id);
  return b ? stOf(b) : null;
}

/**
 * Picker choices saved with the budgets: the budget compared with the actual months (`cmp`),
 * the budgets shown as extra summary rows (`rows`) and the one attached to the Spending chart
 * (`attach`); `save` stores them.
 */
export function stripView(): View & {save: () => void} {
  state.view ??= {cmp: null, rows: [], attach: null};
  return Object.assign(state.view, {save: () => send('PUT', '/api/state/budgets',
      {...state, view: plainView()}).catch(() => {})});
}

/** Loads saved budgets and wires the bar. */
export async function buildBudgets(): Promise<void> {
  const saved = await get<{budgets?: typeof state}>('/api/state');
  state = {list: saved.budgets?.list ?? [], active: saved.budgets?.active ?? null,
    view: {cmp: null, rows: [], attach: null, ...saved.budgets?.view}};
  wireBar();
  onChange(touch);
  renderBar();
  refreshCompare();
  refreshSpending();
}

//
// INTERNAL
//
interface View {
  cmp: string|null;
  rows: string[];
  attach: string|null;
}

let state: {list: SavedBudget[]; active: string|null; view?: View} = {list: [], active: null};
let pendingSwitch: string|null = null;
let pendingDel = false;

/** A budget's settings on top of the current defaults. */
const stOf = (b: SavedBudget): PlannerState => rebaseBudget(app.defs.st, b.st, b.base);

/** The budget being shown, if any. */
const active = (): SavedBudget|null => state.list.find((b) => b.id === state.active) ?? null;

/** Random-enough id for budgets. */
const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Whether the page differs from a budget. */
function dirtyFrom(b: SavedBudget): boolean {
  return diffBudget(app.d, stOf(b), app.S.st).length > 0;
}

/** The picker choices without the save function. */
function plainView(): View|undefined {
  const v = state.view;
  return v && {cmp: v.cmp, rows: v.rows, attach: v.attach};
}

/** Saves the list to the plan folder and refreshes everything that offers budgets. */
function persist(): void {
  send('PUT', '/api/state/budgets', {...state, view: plainView()}).catch(() => {});
  refreshCompare();
  refreshStrip();
  refreshSpending();
}

/** Whether the page differs from the 12-month averages. */
function offAvg(): boolean {
  return diffBudget(app.d, app.defs.st, app.S.st).length > 0;
}

/** Loads budget settings onto the page. */
function apply(st: PlannerState): void {
  app.S.st = clone(st);
  fillPlanner();
  changed();
}

/** Refreshes the bar after any change and cancels pending confirmations. */
function touch(): void {
  pendingSwitch = null;
  pendingDel = false;
  renderBar();
}

/** Budget chips, state line and button labels. */
function renderBar(): void {
  const a = active();
  const dirty = a ? dirtyFrom(a) : null;
  const avgOn = !a && !offAvg();
  const chips = `<button type="button" class="chip" data-id="${AVG}" aria-pressed="${avgOn}">${
      app.d.n}-mo avg</button>` + state.list.map((b) => `<button type="button" class="chip"
      data-id="${esc(b.id)}" aria-pressed="${b.id === state.active}">${esc(b.name)}${
      b.id === state.active && dirty ? ' •' : ''}</button>`).join('');
  document.querySelectorAll<HTMLElement>('[data-bg-tabs]').forEach((el) => {
    el.innerHTML = chips;
  });
  const line = pendingSwitch ?
      'Unsaved changes will be lost. Click the budget again to switch.' :
      a && dirty ? `Unsaved changes to "${a.name}"` :
      !a && !avgOn ? 'Unsaved changes (not saved as a budget)' : '';
  document.querySelectorAll<HTMLElement>('[data-bg-state]').forEach((el) => {
    el.textContent = line;
  });
  const up = $('bg-update') as HTMLButtonElement;
  up.hidden = !a;
  up.textContent = a ? `Update "${a.name}"` : 'Update';
  up.disabled = !!a && !dirty;
  const del = $('bg-del');
  del.hidden = !a;
  del.textContent = pendingDel ? 'Click again to delete' : 'Delete';
  document.querySelectorAll<HTMLButtonElement>('[data-bg-tabs] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id!;
      if (btn.getAttribute('aria-pressed') === 'true') return;
      const cur = active();
      const dirtyNow = cur ? dirtyFrom(cur) : !state.list.some((b) => !dirtyFrom(b)) && offAvg();
      if (dirtyNow && pendingSwitch !== id) {
        pendingSwitch = id;
        renderBar();
        return;
      }
      pendingSwitch = null;
      state.active = id === AVG ? null : id;
      persist();
      apply(budgetSt(id)!);
    });
  });
}

/** Save / update / delete / start-over buttons. */
function wireBar(): void {
  const bar = $('budgets');
  // Typing a name must not count as a page edit (that would cancel confirmations).
  bar.addEventListener('input', (e) => e.stopPropagation());
  $('bg-save').addEventListener('click', () => {
    const inp = $in('bg-name');
    const name = inp.value.trim() || `Budget ${state.list.length + 1}`;
    const b: SavedBudget = {id: newId(), name, saved: new Date().toISOString(),
      st: clone(app.S.st), base: clone(app.defs.st)};
    state.list.push(b);
    state.active = b.id;
    inp.value = '';
    persist();
    renderBar();
  });
  $in('bg-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('bg-save').click();
  });
  $('bg-update').addEventListener('click', () => {
    const a = active();
    if (!a) return;
    Object.assign(a, {st: clone(app.S.st), base: clone(app.defs.st),
      saved: new Date().toISOString()});
    persist();
    renderBar();
  });
  $('bg-del').addEventListener('click', () => {
    if (!pendingDel) {
      pendingDel = true;
      renderBar();
      return;
    }
    pendingDel = false;
    state.list = state.list.filter((b) => b.id !== state.active);
    state.active = null;
    persist();
    renderBar();
  });
}
