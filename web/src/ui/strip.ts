/**
 * @fileoverview The summary rows at the top. The first row is always the last 12 months as they
 * actually were (category averages, credits and annual costs from the data); on its right, pick a
 * saved budget to see how far over or under it those months were. More rows can show any saved
 * budget (or the current, unsaved edits in Budgeting) as a plan, each with the same over / under
 * comparison against the actual months.
 *
 * License: BSD 3-Clause
 */

import {$, app, onChange} from '../app';
import {esc, fmt} from '../format';
import {type Budget, budget} from '../model';
import type {PlannerState} from '../types';
import {AVG, budgetChoices, budgetSt, savedBudgets, stripView} from './budgets';

//
// PUBLIC
//

/** Builds the rows and keeps them up to date. */
export function buildStrip(): void {
  const host = $('strips');
  host.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    const view = stripView();
    if (el.dataset.cmp !== undefined) view.cmp = el.value || null;
    if (el.dataset.add !== undefined && el.value) view.rows.push(el.value);
    view.save();
    refreshStrip();
  });
  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-rm]') as HTMLElement|null;
    if (!b) return;
    const view = stripView();
    view.rows.splice(+b.dataset.rm!, 1);
    view.save();
    refreshStrip();
  });
  onChange(refreshStrip);
  refreshStrip();
}

/** Redraws the rows (after edits, or when budgets are saved or deleted). */
export function refreshStrip(): void {
  const d = app.d;
  const list = savedBudgets();
  const choices = budgetChoices();
  const view = stripView();
  view.rows = view.rows.filter((id) => id === CURRENT || budgetSt(id));
  if (view.cmp && !budgetSt(view.cmp)) view.cmp = null;
  const actual = budget(d, app.defs.st);
  const planOf = (id: string): [string, PlannerState] => {
    if (id === CURRENT) return ['Current edits in Budgeting', app.S.st];
    if (id === AVG) return [`${d.n}-month average`, app.defs.st];
    return [`Budget “${list.find((x) => x.id === id)!.name}”`, budgetSt(id)!];
  };
  const cmpSel = `<label class="eyebrow" for="strip-cmp">Compare with</label><select
    id="strip-cmp" class="cmp-sel" data-cmp><option value="">Choose a budget</option>${
    choices.map(([v, n]) => `<option value="${esc(v)}"${v === view.cmp ? ' selected' : ''}>${
      esc(n)}</option>`).join('')}</select>`;
  let h = `<div class="strip-head"><span class="eyebrow">Last ${d.n} months · actual</span><span
    class="small muted">from your transactions</span></div>` +
      row(actual, 'actual', view.cmp ? vsTile(actual, planOf(view.cmp)[1], cmpSel) :
          `<div class="vs">${cmpSel}<span class="small muted">to see if you were over or under
            it</span></div>`);
  view.rows.forEach((id, i) => {
    const [name, st] = planOf(id);
    const b = budget(d, st);
    h += `<div class="strip-head plan"><span class="eyebrow">${esc(name)} · planned</span><button
      class="btn sm" type="button" data-rm="${i}" aria-label="Hide ${esc(name)}">×</button></div>` +
        row(b, 'plan', vsTile(actual, st, '', true));
  });
  const options = [...(view.rows.includes(CURRENT) ? [] : [[CURRENT, 'Current edits']]),
    ...choices.filter(([v]) => !view.rows.includes(v))];
  if (options.length) {
    h += `<div class="strip-add"><select class="cmp-sel" data-add aria-label="Show a budget"><option
      value="">+ Show a budget</option>${options.map(([v, n]) => `<option value="${esc(v)}">${
      esc(n)}</option>`).join('')}</select></div>`;
  }
  $('strips').innerHTML = h;
}

//
// INTERNAL
//
const CURRENT = '__current';

/** Spending the over / under comparison uses: spending plus annual expenses. */
function outgo(b: Budget): number {
  return b.spend + b.annual;
}

/** One row of tiles, with an optional comparison tile on the right. */
function row(b: Budget, cls: string, extra: string): string {
  const d = app.d;
  const parts = [];
  if (d.children.length) parts.push('529s');
  d.p.savings.forEach((s) => parts.push(s.name));
  if (b.investing) parts.push('investing');
  const tile = (label: string, v: string, note: string, more = '') => `<div${more}><span
    class="eyebrow">${label}</span><span class="v">${v}</span><span class="small muted">${note}</span></div>`;
  return `<div class="strip ${cls}${extra ? ' with-vs' : ''}">` +
      tile('Take-home income', fmt(b.income),
           `${esc(d.partners.map((x) => x.name).join(' + ') || 'Household')}, net`) +
      tile('Spending', fmt(b.spend), b.credits ? 'after credits' : 'regular categories') +
      tile('Savings', fmt(b.savings + b.investing), esc(parts.join(' + ') || 'none set')) +
      tile('Annual expenses', fmt(b.annual), `${fmt(b.annual * 12)}/yr`) +
      tile('Left over each month', `<span class="${b.left < 0 ? 'neg' : 'pos'}">${fmt(b.left)}</span>`,
           `${b.left < 0 ? 'short ' : ''}${fmt(Math.abs(b.left) * 12)} over a year`, ' class="result"') +
      extra + '</div>';
}

/** The over / under tile: the actual months' spending against a plan. */
function vsTile(actual: Budget, st: PlannerState, head: string, plan = false): string {
  const p = outgo(budget(app.d, st));
  const diff = outgo(actual) - p;
  const pct = p ? Math.round(Math.abs(diff) / p * 100) : 0;
  const same = Math.abs(diff) < 0.5;
  const word = same ? 'right on' : diff > 0 ? 'over' : 'under';
  return `<div class="vs ${same ? '' : diff > 0 ? 'over' : 'under'}">${head ||
      `<span class="eyebrow">${plan ? `Last ${app.d.n} months vs this` : 'vs budget'}</span>`}<span
      class="v">${same ? '–' : `${fmt(Math.abs(diff))} ${word}`}</span><span class="small">${
      same ? 'spending matched it' : `${pct}% ${word} on spending + annual, per month`}</span></div>`;
}
