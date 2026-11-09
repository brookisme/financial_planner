/**
 * @fileoverview Budgets: named snapshots of the Budgeting settings only (planned categories,
 * credit toggles, income, savings, annual expenses, emergency costs). Save / update / delete /
 * start over; picking a budget fills Planned / mo, and every budget can be the Compare column.
 * 529 and retirement settings are not part of a budget.
 *
 * License: BSD 3-Clause
 */

import {get, send} from '../api';
import {$, $in, app, changed, onChange} from '../app';
import {esc} from '../format';
import {clone, diffBudget, rebaseBudget} from '../model';
import type {PlannerState, SavedBudget} from '../types';
import {fillPlanner, refreshCompare} from './planner';
import {refreshStrip} from './strip';

//
// PUBLIC
//

/** Saved budgets (for the Compare column and the summary rows). */
export function savedBudgets(): SavedBudget[] {
  return state.list;
}

/**
 * What the summary rows show: the budget compared with the actual months (`cmp`) and the
 * budgets shown as extra rows (`rows`); `save` stores it with the budgets.
 */
export function stripView(): {cmp: string|null; rows: string[]; save: () => void} {
  state.view ??= {cmp: null, rows: []};
  return Object.assign(state.view, {save: () => send('PUT', '/api/state/budgets',
      {...state, view: {cmp: state.view!.cmp, rows: state.view!.rows}}).catch(() => {})});
}

/** Loads saved budgets and wires the bar. */
export async function buildBudgets(): Promise<void> {
  const saved = await get<{budgets?: typeof state}>('/api/state');
  state = {list: saved.budgets?.list ?? [], active: saved.budgets?.active ?? null,
    view: saved.budgets?.view ?? {cmp: null, rows: []}};
  wireBar();
  onChange(touch);
  renderBar();
  refreshCompare();
}

//
// INTERNAL
//
let state: {list: SavedBudget[]; active: string|null;
            view?: {cmp: string|null; rows: string[]}} = {list: [], active: null};
let pendingSwitch: string|null = null;
let pendingDel = false;
let pendingReset = false;

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

/** Saves the list to the plan folder and refreshes the Compare choices. */
function persist(): void {
  send('PUT', '/api/state/budgets', {...state,
    view: state.view && {cmp: state.view.cmp, rows: state.view.rows}}).catch(() => {});
  refreshCompare();
  refreshStrip();
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
  pendingReset = false;
  renderBar();
}

/** Budget chips, state line and button labels. */
function renderBar(): void {
  const a = active();
  const dirty = a ? dirtyFrom(a) : null;
  const tabs = $('bg-tabs');
  tabs.innerHTML = state.list.length ? state.list.map((b) => `<button type="button" class="chip"
      data-id="${esc(b.id)}" aria-pressed="${b.id === state.active}">${esc(b.name)}${
      b.id === state.active && dirty ? ' •' : ''}</button>`).join('') :
      '<span class="small muted">No saved budgets yet. Name this one and save it.</span>';
  $('bg-state').textContent = pendingSwitch ?
      'Unsaved changes will be lost. Click the budget again to switch.' :
      a ? (dirty ? `Unsaved changes to "${a.name}"` : `Showing "${a.name}"`) :
      'Not saved as a budget yet';
  const up = $('bg-update') as HTMLButtonElement;
  up.hidden = !a;
  up.textContent = a ? `Update "${a.name}"` : 'Update';
  up.disabled = !!a && !dirty;
  const del = $('bg-del');
  del.hidden = !a;
  del.textContent = pendingDel ? 'Click again to delete' : 'Delete';
  $('bg-reset').textContent = pendingReset ? 'Click again to start over' : 'Start from averages';
  tabs.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id!;
      if (id === state.active) return;
      const cur = active();
      const dirtyNow = cur ? dirtyFrom(cur) : !state.list.some((b) => !dirtyFrom(b)) &&
          diffBudget(app.d, app.defs.st, app.S.st).length > 0;
      if (dirtyNow && pendingSwitch !== id) {
        pendingSwitch = id;
        renderBar();
        return;
      }
      pendingSwitch = null;
      state.active = id;
      persist();
      apply(stOf(state.list.find((b) => b.id === id)!));
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
  $('bg-reset').addEventListener('click', () => {
    if (!pendingReset) {
      pendingReset = true;
      renderBar();
      return;
    }
    pendingReset = false;
    state.active = null;
    persist();
    apply(app.defs.st);
  });
}
