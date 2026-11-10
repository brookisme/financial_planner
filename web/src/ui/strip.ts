/**
 * @fileoverview The summary rows at the top. The first row is always the actuals for the period
 * selected on the Spending chart (category averages, credits and annual costs from the data); on
 * its right, pick a saved budget to see how far over or under it those months were. More rows can show any saved
 * budget (or the current, unsaved edits in Budgeting) as a plan, each with the same over / under
 * comparison against the actual months.
 *
 * License: BSD 3-Clause
 */

import {$, app, onChange} from '../app';
import {esc, fmt} from '../format';
import {annualComparableMo, type Budget, budget} from '../model';
import type {PlannerState} from '../types';
import {AVG, budgetChoices, budgetSt, savedBudgets, stripView} from './budgets';
import {selectionAvg, selectionLabel} from './spending';

//
// PUBLIC
//

/** Builds the rows and keeps them up to date (Spending redraws them when its period changes). */
export function buildStrip(): void {
  built = true;
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
  if (!built) return;
  const d = app.d;
  const list = savedBudgets();
  const choices = budgetChoices();
  const view = stripView();
  view.rows = view.rows.filter((id) => id === CURRENT || budgetSt(id));
  if (view.cmp && !budgetSt(view.cmp)) view.cmp = null;
  const actual = budget(d, actualSt());
  const planOf = (id: string): [string, PlannerState] => {
    if (id === CURRENT) return ['Current edits in Budgeting', app.S.st];
    if (id === AVG) return [`${d.n}-month average`, app.defs.st];
    return [`Budget “${list.find((x) => x.id === id)!.name}”`, budgetSt(id)!];
  };
  const cmpSel = `<label class="eyebrow" for="strip-cmp">Compare with</label><select
    id="strip-cmp" class="cmp-sel" data-cmp><option value="">Choose a budget</option>${
    choices.map(([v, n]) => `<option value="${esc(v)}"${v === view.cmp ? ' selected' : ''}>${
      esc(n)}</option>`).join('')}</select>`;
  let h = `<div class="strip-head"><span class="eyebrow">Actuals</span><span
    class="small muted">${esc(selectionLabel())}, as selected on the Spending chart</span></div>` +
      row(actual, 'actual', view.cmp ? vsTile(planOf(view.cmp)[1], cmpSel) :
          `<div class="vs">${cmpSel}<span class="small muted">to see if you were over or under
            it</span></div>`);
  view.rows.forEach((id, i) => {
    const [name, st] = planOf(id);
    const b = budget(d, st);
    h += `<div class="strip-head plan"><span class="eyebrow">${esc(name)} · planned</span><button
      class="btn sm" type="button" data-rm="${i}" aria-label="Hide ${esc(name)}">×</button></div>` +
        row(b, 'plan', vsTile(st, '', true));
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
let built = false;

/**
 * The actuals: category averages over the period selected on the Spending chart, with every
 * credit counted (money that really came in), or only the credits a plan has ticked, for a
 * like-for-like comparison with it.
 */
function actualSt(on?: Record<string, boolean>): PlannerState {
  const d = app.d;
  const st = app.defs.st;
  const plan = {...st.plan};
  Object.keys(plan).forEach((n) => plan[n] = selectionAvg(d.idx(n)));
  const annual = d.annual.map((i) => ({name: d.cats[i].name, amt: selectionAvg(i) * 12}));
  return {...st, plan, annual,
    on: on ?? Object.fromEntries(Object.keys(st.on).map((k) => [k, true]))};
}

/**
 * Spending the over / under comparison uses: spending plus annual expenses, without property
 * replacement set-asides (they have no counterpart in the data).
 */
function outgo(st: PlannerState): number {
  return budget(app.d, st).spend + annualComparableMo(app.d, st);
}

/** One row of tiles, with an optional comparison tile on the right. */
function row(b: Budget, cls: string, extra: string): string {
  const d = app.d;
  const parts = [];
  if (d.children.length) parts.push('529s');
  if (d.accounts.some((a) => !a.acct.pre_tax)) parts.push('retirement');
  d.p.savings.forEach((s) => parts.push(s.name));
  if (b.investing) parts.push('investing');
  const tile = (label: string, v: string, note: string, more = '') => `<div${more}><span
    class="eyebrow">${label}</span><span class="v">${v}</span><span class="small muted">${note}</span></div>`;
  return `<div class="strip ${cls}${extra ? ' with-vs' : ''}">` +
      tile('Take-home income', fmt(b.income),
           `${esc(d.partners.map((x) => x.name).join(' + ') || 'Household')}, net`) +
      tile('Spending', fmt(b.spend), b.credits ? `after ${fmt(b.credits)} of credits` :
           'regular categories') +
      tile('Savings', fmt(b.savings + b.investing), esc(parts.join(' + ') || 'none set') +
           (b.pretax ? ` · plus ${fmt(b.pretax)} pre-tax from pay` : '')) +
      tile('Annual expenses', fmt(b.annual), `${fmt(b.annual * 12)}/yr`) +
      tile('Left over each month', `<span class="${b.left < 0 ? 'neg' : 'pos'}">${fmt(b.left)}</span>`,
           `${b.left < 0 ? 'short ' : ''}${fmt(Math.abs(b.left) * 12)} over a year`, ' class="result"') +
      extra + '</div>';
}

/** The over / under tile: the actual months' spending against a plan (its credits only). */
function vsTile(st: PlannerState, head: string, plan = false): string {
  const p = outgo(st);
  const diff = outgo(actualSt(st.on)) - p;
  const pct = p ? Math.round(Math.abs(diff) / p * 100) : 0;
  const same = Math.abs(diff) < 0.5;
  const word = same ? 'right on' : diff > 0 ? 'over' : 'under';
  return `<div class="vs ${same ? '' : diff > 0 ? 'over' : 'under'}">${head ||
      `<span class="eyebrow">${plan ? 'Actuals vs this' : 'vs budget'}</span>`}<span
      class="v">${same ? '–' : `${fmt(Math.abs(diff))} ${word}`}</span><span class="small">${
      same ? 'spending matched it' : `${pct}% ${word} on spending + annual, per month`}</span></div>`;
}
