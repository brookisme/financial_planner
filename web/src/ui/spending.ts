/**
 * @fileoverview Spending (the actuals from your transactions). The chart shows a period: all the
 * data, a typical year (each calendar month's average with the lowest and highest year), a
 * 12-month year you can drag back in time, or a range drawn across the months. Clicking a month
 * shows its days. The category table (average, min, max), the transactions (with an opt-in
 * Recategorize mode) and top merchants all follow the period shown. A budget (or the 12-month
 * average) can be attached: the chart then shows the budgeted line and how far over or under it
 * the period shown was, and the table gets a "vs budget" column.
 *
 * License: BSD 3-Clause
 */

import {$, $in, app, hideTip, showTip} from '../app';
import {esc, fk, fmt, niceStep, sum} from '../format';
import {annualMo} from '../model';
import type {PlannerState, Tx} from '../types';
import {budgetChoices, budgetSt, stripView} from './budgets';
import {openRuleDialog} from './categorize';

//
// CONSTANTS
//
const CREDIT_COLORS = ['--r2', '--r3', '--r4', '--r5', '--r1'];
const MAX_ROWS = 400;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov',
  'Dec'];
const DRAG_PX = 5;

//
// PUBLIC
//

/** Builds the section for the loaded data. */
export function buildSpending(): void {
  const d = app.d;
  const p = d.p;
  A = p.all_by_cat ?? p.by_cat;
  MON = p.all_months ?? p.months;
  LBL = p.all_month_labels ?? p.month_labels;
  TX = [...p.tx, ...(p.other_tx ?? [])];
  monthOf = new Map(MON.map((m, i) => [m, i]));
  yearEnd = MON.length - 1;
  credCats = d.credits;
  d.credits.forEach((c) => on[d.cats[c].name] = d.cats[c].default_on);
  d.costs.forEach((c) => on[d.cats[c].name] = true);
  savCats = d.cats.map((_, i) => i).filter((i) => d.cats[i].kind === 'ignore' &&
      sum(A[i] ?? []) > 0);
  $('actbody').addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (!el.dataset.on) return;
    on[el.dataset.on] = el.checked;
    buildTable();
  });
  $('actbody').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-pick]') as HTMLElement|null;
    if (b) selectCat(b.dataset.pick === '' ? null : +b.dataset.pick!);
  });
  document.querySelectorAll<HTMLButtonElement>('#pview button').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.v as View));
  });
  $('ptools').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement|null;
    if (!b) return;
    if (b.dataset.act === 'back') dayMonth = null;
    else yearEnd = clampEnd(yearEnd + (b.dataset.act === 'later' ? 1 : -1));
    refresh();
  });
  const mf = $('mfilter') as HTMLSelectElement;
  mf.addEventListener('change', () => {
    dayMonth = mf.value === '' ? null : +mf.value;
    refresh();
  });
  $('q').addEventListener('input', drawDetail);
  $('sort').addEventListener('change', drawDetail);
  document.querySelectorAll<HTMLButtonElement>('#xmode button').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.v as Mode));
  });
  $('recat').addEventListener('click', () => {
    recat = !recat;
    $('recat').setAttribute('aria-expanded', String(recat));
    $('recat-note').hidden = !recat;
    $('tx-panel').classList.toggle('recat-on', recat);
  });
  $('txlist').addEventListener('click', (e) => {
    if (!recat) return;
    const tr = (e.target as HTMLElement).closest('tr[data-id]') as HTMLElement|null;
    if (tr) openRuleDialog(tr.dataset.id!);
  });
  wirePointer();
  $('attach').addEventListener('change', () => {
    const v = stripView();
    v.attach = ($('attach') as HTMLSelectElement).value || null;
    v.save();
    refresh();
  });
  fillAttach();
  view = MON.length > 12 ? 'year' : 'all';
  setMode('spend');
}

/** Focuses a category (switching mode if needed). */
export function selectCat(c: number|null): void {
  if (c !== null && !inMode(c)) {
    mode = isCredit(c) ? 'cred' : 'spend';
    markMode();
  }
  selCat = c;
  refresh();
}

/** Rebuilds the attach choices and redraws (after budgets are saved, updated or deleted). */
export function refreshSpending(): void {
  if (!MON.length) return;
  fillAttach();
  refresh();
}

/** A category's average per month over the period shown (credits as positive amounts). */
export function selectionAvg(c: number): number {
  const s = selection();
  return s.length ? sum(s.map((i) => A[c][i] ?? 0)) / s.length * (isCredit(c) ? -1 : 1) : 0;
}

/** The period shown, e.g. "Jan 25 – Dec 25 (12 months)". */
export function selectionLabel(): string {
  const s = selection();
  if (!s.length) return 'no months';
  const span = s.length === 1 ? LBL[s[0]] : `${LBL[s[0]]} – ${LBL[s[s.length - 1]]}`;
  return `${span} (${s.length} month${s.length === 1 ? '' : 's'})`;
}

//
// INTERNAL
//
type Mode = 'spend'|'cred'|'both';
type View = 'all'|'typical'|'year'|'range';

/** One chart column: a month, a calendar month across years, or a day. */
interface Col {
  label: string;
  month?: number;
  months?: number[];
  day?: string;
}

let selCat: number|null = null;
let mode: Mode = 'spend';
let view: View = 'all';
let yearEnd = 0;
let range: [number, number]|null = null;
let dayMonth: number|null = null;
let recat = false;
let A: number[][] = [];
let MON: string[] = [];
let LBL: string[] = [];
let TX: Tx[] = [];
let monthOf = new Map<string, number>();
let credCats: number[] = [];
let savCats: number[] = [];
let cols: Col[] = [];
let dayTotals = new Map<string, Map<number, number>>();
let drag: {x: number; col: number; end: number; moved: boolean}|null = null;
const on: Record<string, boolean> = {};

const isCredit = (c: number) => app.d.cats[c].kind === 'credit';
const inMode = (c: number) => mode === 'both' ? true : mode === 'cred' ? isCredit(c) : !isCredit(c);
const credCol = (c: number) => CREDIT_COLORS[Math.max(0, credCats.indexOf(c)) %
                                              CREDIT_COLORS.length];
const label = (c: number) => app.d.cats[c].name;
const span = (a: number, b: number) => Array.from({length: b - a + 1}, (_, i) => a + i);

/** Keeps the year's last month where a full year still fits. */
function clampEnd(end: number): number {
  return Math.max(Math.min(11, MON.length - 1), Math.min(MON.length - 1, end));
}

/** Month indices of the period shown (all of them for All data and Typical year). */
function selection(): number[] {
  if (view === 'year') return span(Math.max(0, yearEnd - 11), yearEnd);
  if (view === 'range' && range) return span(range[0], range[1]);
  return span(0, MON.length - 1);
}

/** The attach choices: no budget, the 12-month average, then each saved budget. */
function fillAttach(): void {
  const sel = $('attach') as HTMLSelectElement;
  const v = stripView();
  if (v.attach && !budgetSt(v.attach)) v.attach = null;
  sel.innerHTML = '<option value="">Attach a budget…</option>' + budgetChoices().map(([id, n]) =>
      `<option value="${esc(id)}">${esc(n)}</option>`).join('');
  sel.value = v.attach ?? '';
}

/** The attached budget's settings, if any. */
function attached(): PlannerState|null {
  return budgetSt(stripView().attach);
}

/** A category's budget per month (credits as positive), or null if the budget has no line for it. */
function planned(st: PlannerState, c: number): number|null {
  const d = app.d;
  const kind = d.cats[c].kind;
  if (kind === 'spending' || (kind === 'credit' && d.isPlannerCredit(c))) {
    return st.plan[d.cats[c].name] ?? 0;
  }
  return null;
}

/** A "vs budget" cell: % over (red) or under (green); for money in, more is green. */
function vsCell(actual: number, plan: number|null, moneyIn = false): string {
  if (plan === null) return '<td></td>';
  if (Math.abs(plan) < 0.5) {
    return `<td class="num muted"${Math.abs(actual) < 0.5 ? '' : ' title="Nothing budgeted"'}>–</td>`;
  }
  const pct = Math.round((actual - plan) / plan * 100);
  if (!pct) return '<td class="num muted" title="On budget">0%</td>';
  const good = moneyIn ? pct > 0 : pct < 0;
  return `<td class="num ${good ? 'pos' : 'neg'}">${pct > 0 ? '+' : '−'}${Math.abs(pct)}%</td>`;
}

/** Redraws everything that follows the period. */
function refresh(): void {
  markView();
  buildTable();
  drawChart();
  drawDetail();
}

/** Sets the spending / credits / both mode. */
function setMode(v: Mode): void {
  mode = v;
  selCat = null;
  markMode();
  refresh();
}

/** Sets the period view. */
function setView(v: View): void {
  if (v === 'range' && !range) return;
  view = v;
  dayMonth = null;
  refresh();
}

/** Marks the active mode button. */
function markMode(): void {
  document.querySelectorAll<HTMLButtonElement>('#xmode button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === mode));
  });
}

/** Marks the period buttons and fills the period tools and hint. */
function markView(): void {
  document.querySelectorAll<HTMLButtonElement>('#pview button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === view));
    if (b.dataset.v === 'range') b.disabled = !range;
  });
  const s = selection();
  const tools = $('ptools');
  if (dayMonth !== null) {
    tools.innerHTML = `<button class="btn sm" type="button" data-act="back">← Back to months</button>`;
  } else if (view === 'year' && MON.length > 12) {
    tools.innerHTML = `<button class="btn sm" type="button" data-act="earlier"
      aria-label="One month earlier"${yearEnd <= 11 ? ' disabled' : ''}>‹</button><button
      class="btn sm" type="button" data-act="later" aria-label="One month later"${
      yearEnd >= MON.length - 1 ? ' disabled' : ''}>›</button>`;
  } else {
    tools.innerHTML = '';
  }
  $('plabel').textContent = dayMonth !== null ? `Days of ${LBL[dayMonth]}` :
      view === 'typical' ? `Average of each month over ${MON.length} months` : selectionLabel();
  $('chart-hint').textContent = dayMonth !== null ?
      'Each day of the month. Back returns to the months.' :
      view === 'all' ? 'Drag across months to select a period. Click a month to see its days.' :
      view === 'year' ? 'Drag sideways (or use ‹ ›) to move the year. Click a month to see its days.' :
      view === 'range' ? 'The selected months. Click a month to see its days; pick All data to ' +
          'select another period.' :
      'Each calendar month\'s average across all your data; the line marks its lowest and ' +
          'highest year.';
  const mf = $('mfilter') as HTMLSelectElement;
  mf.innerHTML = '<option value="">All months shown</option>' +
      s.map((i) => `<option value="${i}">${esc(LBL[i])}</option>`).join('');
  mf.value = dayMonth === null ? '' : String(dayMonth);
}

/**
 * The category table for the period and mode: regular spending by group, then annual / 1-time /
 * emergency costs and savings transfers (each with a toggle), with credits nested under the
 * category they offset or listed below. Totals count only what is ticked.
 */
function buildTable(): void {
  const d = app.d;
  const months = selection();
  const n = Math.max(1, months.length);
  const signed = (c: number) => months.map((m) => (isCredit(c) ? -1 : 1) * (A[c][m] ?? 0));
  const stats = (v: number[]) => [sum(v) / n, Math.min(...v), Math.max(...v)];
  const cells = (v: number[], neg = false) => stats(v).map((x) =>
      `<td class="num">${neg ? `(${fmt(x)})` : fmt(x)}</td>`).join('');
  const nameCell = (c: number, pad = 0, toggle = false, pick = true) => {
    const cat = d.cats[c];
    const nm = esc(isCredit(c) ? cat.label || cat.name : cat.name);
    const link = pick ? `<button class="cat-link" type="button" data-pick="${c}">${nm}</button>` :
        nm;
    return `<td${pad ? ` style="padding-left:${pad}px"` : ''}>${toggle ? `<label class="tg"><input
      type="checkbox" data-on="${esc(cat.name)}"${on[cat.name] ? ' checked' : ''}>${
      isCredit(c) ? '− ' : ''}${link}</label>` : link}</td>`;
  };
  const st = attached();
  const ncol = st ? 5 : 4;
  const vs = (actual: number[], plan: number|null, moneyIn = false) =>
      st ? vsCell(sum(actual) / n, plan, moneyIn) : '';
  const row = (c: number, pad = 0, toggle = false, pick = true) => {
    const off = toggle && !on[d.cats[c].name];
    return `<tr class="${[isCredit(c) ? 'credit' : '', off ? 'off' : '', selCat === c ? 'sel' : '']
        .join(' ').trim()}">${nameCell(c, pad, toggle, pick)}${cells(signed(c), isCredit(c))}${
        vs(signed(c), st && planned(st, c), isCredit(c))}</tr>`;
  };
  const totalRow = (lbl: string, series: number[], pick = false, plan: number|null = null,
                    moneyIn = false) => `<tr class="total${
      pick && selCat === null ? ' sel' : ''}"><td>${pick ? `<button class="cat-link" type="button"
      data-pick="">${esc(lbl)}</button>` : esc(lbl)}</td>${cells(series)}${
      vs(series, plan, moneyIn)}</tr>`;
  const planSum = (list: number[]) => st ? sum(list.map((c) => planned(st, c) ?? 0)) : null;
  const series = (list: number[]) => months.map((m) => sum(list.map((c) =>
      (isCredit(c) ? -1 : 1) * (A[c][m] ?? 0))));
  const groups: string[] = [];
  d.regular.forEach((i) => {
    if (!groups.includes(d.cats[i].group)) groups.push(d.cats[i].group);
  });
  const withCredits = mode === 'both';
  let h = '';
  const counted: number[] = [];
  const credCount: number[] = [];
  if (mode !== 'cred') {
    groups.forEach((g) => {
      h += `<tr class="group"><td colspan="${ncol}">${esc(g)}</td></tr>`;
      d.regular.filter((i) => d.cats[i].group === g).sort((a, b) => d.avg(b) - d.avg(a))
          .forEach((i) => {
            h += row(i);
            counted.push(i);
            if (withCredits) {
              d.offsetsOf(d.cats[i].name).forEach((c) => {
                h += row(c, 22, true);
                if (on[d.cats[c].name]) credCount.push(c);
              });
            }
          });
    });
    h += totalRow('Regular spending', series(d.regular), false, planSum(d.regular));
    if (d.costs.length) {
      h += `<tr class="group"><td colspan="${ncol}">Annual, 1-time &amp; emergency</td></tr>`;
      d.costs.forEach((i) => {
        h += row(i, 0, true);
        if (on[d.cats[i].name]) counted.push(i);
        if (withCredits) {
          d.offsetsOf(d.cats[i].name).forEach((c) => {
            h += row(c, 22, true);
            if (on[d.cats[c].name] && on[d.cats[i].name]) credCount.push(c);
          });
        }
      });
    }
    if (savCats.length) {
      h += `<tr class="group"><td colspan="${ncol}">Savings &amp; transfers</td></tr>`;
      savCats.forEach((i) => {
        h += row(i, 0, true, false);
        if (on[d.cats[i].name]) counted.push(i);
      });
    }
  }
  if (mode !== 'spend') {
    const loose = mode === 'cred' ? d.credits : d.credits.filter((c) => !d.cats[c].offsets);
    if (loose.length) {
      h += `<tr class="group"><td colspan="${ncol}">${mode === 'cred' ? 'Credits' :
          'Other credits'}</td></tr>`;
      loose.forEach((c) => h += row(c, 0, true));
      credCount.push(...loose.filter((c) => on[d.cats[c].name]));
    }
  }
  if (mode === 'cred') {
    h += totalRow('All credits', series(credCount), true, planSum(credCount), true);
  } else {
    const spent = series(counted);
    const cred = series(credCount);
    // vs budget compares like for like: regular + annual costs (no 1-time, emergency or savings)
    // minus the credits a budget plans for
    const planCred = credCount.filter((c) => d.isPlannerCredit(c));
    const plan = st ? (planSum(d.regular) ?? 0) + annualMo(st) - (planSum(planCred) ?? 0) : null;
    const like = series(counted.filter((c) => ['spending', 'annual'].includes(d.cats[c].kind)));
    const likeCred = series(planCred);
    h += totalRow(mode === 'both' ? 'Net (ticked)' : 'Total (ticked)',
                  spent.map((v, i) => v - cred[i]), true);
    if (st) {
      h += `<tr class="vsrow"><td class="small muted" colspan="4">vs budget: regular + annual
        costs${mode === 'both' ? ', after ticked credits' : ''} (budgets have no 1-time or
        emergency lines)</td>${vsCell(sum(like.map((v, i) => v - likeCred[i])) / n, plan)}</tr>`;
    }
  }
  $('actbody').innerHTML = h;
  $('act-avg-head').textContent = 'Avg / mo';
  $('act-vs-head').hidden = !st;
  $('act-note').textContent = `${selectionLabel()}. ${mode === 'cred' ?
      'Money in, as positive amounts.' : 'Ticked rows count in the total.'}`;
}

/** The chart's columns for the view: months, calendar months, or the days of one month. */
function buildCols(): Col[] {
  if (dayMonth !== null) {
    const ym = MON[dayMonth];
    const days = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
    dayTotals = new Map();
    TX.filter((t) => t[0].startsWith(ym)).forEach((t) => {
      const m = dayTotals.get(t[0]) ?? new Map<number, number>();
      m.set(t[3], (m.get(t[3]) ?? 0) + t[2]);
      dayTotals.set(t[0], m);
    });
    return span(1, days).map((n) => ({label: String(n), day: `${ym}-${String(n).padStart(2, '0')}`}));
  }
  if (view === 'typical') {
    return MONTH_NAMES.map((name, k) => ({label: name,
      months: MON.map((m, i) => +m.slice(5, 7) === k + 1 ? i : -1).filter((i) => i >= 0)}));
  }
  return selection().map((i) => ({label: LBL[i], month: i}));
}

/** A category's amount in one month (positive = money out, credits as stored). */
function raw(c: number, i: number): number {
  return A[c][i] ?? 0;
}

/** Total of categories in a column (credits turned positive). */
function colValue(col: Col, cats: number[]): number {
  const one = (c: number, i: number) => (isCredit(c) ? -1 : 1) * raw(c, i);
  if (col.day) {
    const m = dayTotals.get(col.day);
    return m ? sum(cats.map((c) => (isCredit(c) ? -1 : 1) * (m.get(c) ?? 0))) : 0;
  }
  if (col.months) {
    return col.months.length ?
        sum(col.months.map((i) => sum(cats.map((c) => one(c, i))))) / col.months.length : 0;
  }
  return sum(cats.map((c) => one(c, col.month!)));
}

/** Lowest and highest year of a calendar-month column. */
function colSpread(col: Col, cats: number[]): [number, number]|null {
  if (!col.months || col.months.length < 2) return null;
  const v = col.months.map((i) => sum(cats.map((c) => (isCredit(c) ? -1 : 1) * raw(c, i))));
  return [Math.min(...v), Math.max(...v)];
}

/** The bar chart for the period (spending up, credits down). */
function drawChart(): void {
  const d = app.d;
  cols = buildCols();
  const svg = $('mchart');
  const W = 960;
  const H = 300;
  const L = 52;
  const R = 12;
  const T = 14;
  const B = 30;
  const pw = W - L - R;
  const ph = H - T - B;
  const bw = pw / Math.max(1, cols.length);
  type Series = {col: string; cats: number[]; name: string};
  let up: Series[];
  let down: Series[] = [];
  let avgOf: number[] = [];
  const unit = dayMonth !== null ? 'day' : 'mo';
  const sw = (col: string, name: string) =>
      `<span><i class="sw" style="background:${col}"></i>${esc(name)}</span>`;
  let title: string;
  let leg: string;
  if (selCat === null) {
    if (mode === 'cred') {
      up = credCats.map((c) => ({col: `var(${credCol(c)})`, cats: [c], name: label(c)}));
      avgOf = credCats;
      title = 'All credits';
      leg = up.map((x) => sw(x.col, x.name)).join('');
    } else {
      up = [{col: 'var(--accent)', cats: d.regular, name: 'Regular'},
            {col: 'var(--onetime)', cats: d.costs, name: 'Annual, 1-time & emergency'}];
      avgOf = d.regular;
      if (mode === 'both') {
        down = [{col: 'var(--r2)', cats: credCats, name: 'Credits'}];
        title = 'Spending (above) and credits (below)';
        leg = sw('var(--accent)', 'Regular') + sw('var(--onetime)', 'Annual, 1-time & emergency') +
            sw('var(--r2)', 'Credits');
      } else {
        title = 'All spending';
        leg = sw('var(--accent)', 'Regular') + sw('var(--onetime)', 'Annual, 1-time & emergency');
      }
    }
  } else {
    const col = isCredit(selCat) ? `var(${credCol(selCat)})` : 'var(--accent)';
    up = [{col, cats: [selCat], name: label(selCat)}];
    avgOf = [selCat];
    title = `${isCredit(selCat) ? 'Credits: ' : ''}${label(selCat)}`;
    leg = sw(col, label(selCat));
  }
  const avg = cols.length ? sum(cols.map((c) => colValue(c, avgOf))) / cols.length : 0;
  const avgName = selCat === null && mode !== 'cred' ? 'Avg regular' : 'Avg';
  const st = attached();
  const monthly = !st ? null : selCat !== null ? planned(st, selCat) : mode === 'cred' ?
      sum(credCats.map((c) => planned(st, c) ?? 0)) :
      sum(d.regular.map((c) => planned(st, c) ?? 0)) + annualMo(st);
  const days = dayMonth !== null ? cols.length : 1;
  const bud = monthly === null ? null : monthly / days;
  leg += `<span><i class="ln"></i>${avgName} ${fmt(avg)}/${unit}</span>` +
      (bud === null ? '' : `<span><i class="ln bud"></i>Budget ${fmt(bud)}/${unit}</span>`) +
      (view === 'typical' && dayMonth === null ? '<span>│ lowest – highest year</span>' : '');
  title += dayMonth !== null ? ` by day, ${LBL[dayMonth]}` :
      view === 'typical' ? ', typical year' : ' by month';
  $('chart-title').textContent = title;
  $('legend').innerHTML = leg;
  const upCats = up.flatMap((s) => s.cats);
  const spreads = cols.map((c) => dayMonth === null ? colSpread(c, upCats) : null);
  const upT = cols.map((c) => sum(up.map((s) => Math.max(colValue(c, s.cats), 0))));
  const dnT = cols.map((c) => sum(down.map((s) => Math.max(colValue(c, s.cats), 0))));
  const maxU = Math.max(...upT, ...spreads.map((s) => s ? s[1] : 0), avg, bud ?? 0, 1);
  const moneyIn = selCat !== null ? isCredit(selCat) : mode === 'cred';
  // Like for like: budgets have no 1-time purchases, and emergency costs come from the fund.
  const vsCats = selCat === null && mode !== 'cred' ? [...d.regular, ...d.annual] : upCats;
  const vsT = cols.map((c) => colValue(c, vsCats));
  const actualMo = dayMonth !== null ? sum(vsT) : cols.length ? sum(vsT) / cols.length : 0;
  const vsEl = $('attach-vs');
  if (monthly === null || Math.abs(monthly) < 0.5) {
    vsEl.textContent = st ? 'Nothing budgeted for this' : '';
    vsEl.className = 'attach-vs';
  } else {
    const diff = actualMo - monthly;
    const pct = Math.round(Math.abs(diff) / monthly * 100);
    const over = diff > 0;
    vsEl.textContent = Math.abs(diff) < 0.5 ? 'On budget' : `${fmt(Math.abs(diff))}/mo ${
        over ? 'over' : 'under'} budget (${pct}%)${dayMonth !== null ? ` in ${LBL[dayMonth]}` : ''}`;
    vsEl.className = `attach-vs ${Math.abs(diff) < 0.5 ? '' : over !== moneyIn ? 'over' : 'under'}`;
  }
  const maxD = Math.max(...dnT, 0);
  const step = niceStep(maxU + maxD);
  const topU = Math.ceil(maxU / step) * step;
  const topD = maxD ? Math.ceil(maxD / step) * step : 0;
  const yspan = topU + topD;
  const y = (v: number) => T + ph * (topU - v) / yspan;
  let g = '';
  for (let v = -topD; v <= topU + 1e-6; v += step) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${
        L - 8}" y="${y(v) + 4}" text-anchor="end">${v < 0 ? '−' : ''}${fk(Math.abs(v))}</text>`;
  }
  if (topD) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--ink3);stroke-width:1.5"/>`;
  }
  const every = Math.ceil(cols.length / (dayMonth !== null ? 16 : 14));
  cols.forEach((col, k) => {
    const x = L + k * bw + bw * 0.18;
    const w = bw * 0.64;
    let bars = '';
    let base = y(0);
    up.forEach((s) => {
      const h = ph * Math.max(colValue(col, s.cats), 0) / yspan;
      if (h > 0.5) {
        base -= h;
        bars += `<rect x="${x}" y="${base}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="3" style="fill:${s.col}"/>`;
      }
    });
    base = y(0);
    down.forEach((s) => {
      const h = ph * Math.max(colValue(col, s.cats), 0) / yspan;
      if (h > 0.5) {
        bars += `<rect x="${x}" y="${base + 2}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="3" style="fill:${s.col}"/>`;
        base += h;
      }
    });
    const sp = spreads[k];
    if (sp) {
      const cx = L + k * bw + bw / 2;
      bars += `<line class="whisk" x1="${cx}" x2="${cx}" y1="${y(sp[1])}" y2="${y(sp[0])}"/><line
        class="whisk" x1="${cx - 6}" x2="${cx + 6}" y1="${y(sp[1])}" y2="${y(sp[1])}"/><line
        class="whisk" x1="${cx - 6}" x2="${cx + 6}" y1="${y(sp[0])}" y2="${y(sp[0])}"/>`;
    }
    const head = col.day ? `${LBL[dayMonth!]} ${col.label}` : col.months ?
        `${col.label}, average of ${col.months.length} year${col.months.length === 1 ? '' : 's'}` :
        LBL[col.month!];
    let tip = `<b>${esc(head)}</b>`;
    up.concat(down).forEach((s) => {
      const v = colValue(col, s.cats);
      if (Math.abs(v) >= 0.5) tip += `<br>${esc(s.name)} ${fmt(v)}`;
    });
    if (selCat === null && mode === 'both') tip += `<br><b>Net ${fmt(upT[k] - dnT[k])}</b>`;
    else if (up.length > 1) tip += `<br><b>Total ${fmt(upT[k])}</b>`;
    if (sp) tip += `<br>Lowest ${fmt(sp[0])} · highest ${fmt(sp[1])}`;
    const lab = k % every === 0 || cols.length <= 14 ? `<text x="${L + k * bw + bw / 2}" y="${
        H - 10}" text-anchor="middle">${esc(col.label)}</text>` : '';
    g += `<g class="m" data-k="${k}" data-tip="${tip.replace(/"/g, '&quot;')}">${bars}<rect class="hit" x="${
        L + k * bw}" y="${T}" width="${bw}" height="${ph}"/>${lab}</g>`;
  });
  if (bud !== null) {
    g += `<line class="budline" x1="${L}" x2="${W - R}" y1="${y(bud)}" y2="${y(bud)}"/>`;
  }
  g += `<line class="avgline" x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}"/>` +
      `<rect id="brush" class="brush" x="0" y="${T}" width="0" height="${ph}" visibility="hidden"/>`;
  svg.innerHTML = g;
  svg.dataset.l = String(L);
  svg.dataset.bw = String(bw);
  svg.querySelectorAll<SVGGElement>('g.m').forEach((el) => {
    el.addEventListener('mousemove', (e) => {
      if (!drag?.moved) showTip(e, el.dataset.tip!);
    });
    el.addEventListener('mouseleave', hideTip);
  });
  svg.classList.toggle('pan', view === 'year' && dayMonth === null && MON.length > 12);
  svg.classList.toggle('brushable', view === 'all' && dayMonth === null);
}

/** Chart pointer handling: click a month for its days, drag to select (All) or pan (Year). */
function wirePointer(): void {
  const svg = $('mchart') as unknown as SVGSVGElement;
  const colAt = (clientX: number) => {
    const r = svg.getBoundingClientRect();
    const x = (clientX - r.left) * 960 / r.width;
    const k = Math.floor((x - +svg.dataset.l!) / +svg.dataset.bw!);
    return Math.max(0, Math.min(cols.length - 1, k));
  };
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = {x: e.clientX, col: colAt(e.clientX), end: yearEnd, moved: false};
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) < DRAG_PX) return;
    drag.moved = true;
    hideTip();
    if (dayMonth !== null) return;
    if (view === 'year') {
      const r = svg.getBoundingClientRect();
      const shift = Math.round((e.clientX - drag.x) * 960 / r.width / +svg.dataset.bw!);
      const end = clampEnd(drag.end - shift);
      if (end !== yearEnd) {
        yearEnd = end;
        drawChart();
        markView();
      }
    } else if (view === 'all') {
      const a = Math.min(drag.col, colAt(e.clientX));
      const b = Math.max(drag.col, colAt(e.clientX));
      const brush = svg.querySelector('#brush')!;
      const l = +svg.dataset.l!;
      const bw = +svg.dataset.bw!;
      brush.setAttribute('x', String(l + a * bw));
      brush.setAttribute('width', String((b - a + 1) * bw));
      brush.setAttribute('visibility', 'visible');
    }
  });
  svg.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d0 = drag;
    drag = null;
    if (!d0.moved) {
      const col = cols[colAt(e.clientX)];
      if (col?.month !== undefined) {
        dayMonth = col.month;
        refresh();
      }
      return;
    }
    if (dayMonth !== null) return;
    if (view === 'all') {
      const a = cols[Math.min(d0.col, colAt(e.clientX))].month!;
      const b = cols[Math.max(d0.col, colAt(e.clientX))].month!;
      range = [a, b];
      view = 'range';
    }
    refresh();
  });
  svg.addEventListener('pointercancel', () => drag = null);
}

/** Simplifies a description to a merchant name for the top-merchants list. */
function merchKey(desc: string): string {
  return desc.replace(/^(SQ|TST|SP|DD|PB|EB|ACT|RF|FH|IN|COT|TCB|CKE|SPO)\s*\*\s*/i, '$1 ')
      .replace(/[*#].*$/, '').replace(/\s+\d[\d\s-]*.*$/, '').replace(/\s+(INC|LLC)\.?$/i, '')
      .trim().toUpperCase();
}

/** Top merchants and the transaction list for the period (or the month whose days show). */
function drawDetail(): void {
  const months = new Set(dayMonth !== null ? [dayMonth] : selection());
  const pool = TX.filter((t) => (selCat === null ? inMode(t[3]) : t[3] === selCat) &&
      months.has(monthOf.get(t[0].slice(0, 7)) ?? -1));
  const credView = selCat !== null ? isCredit(selCat) : mode === 'cred';
  const sg = credView ? -1 : 1;
  const mixed = selCat === null && mode === 'both';
  const mm = new Map<string, [number, number, number]>();
  pool.forEach((t) => {
    const key = merchKey(t[1]) || t[1];
    const e = mm.get(key) ?? [0, 0, t[3]];
    e[0] += sg * t[2];
    e[1]++;
    mm.set(key, e);
  });
  const top = [...mm.entries()].sort((a, b) => Math.abs(b[1][0]) - Math.abs(a[1][0])).slice(0, 10);
  const mx = top.length ? Math.abs(top[0][1][0]) || 1 : 1;
  $('merchants').innerHTML = top.map(([n, [v, c, cat]]) => `<tr><td>${esc(n)}<div class="bar" style="width:${
      Math.max(2, 100 * Math.abs(v) / mx)}%;${isCredit(cat) ? `background:var(${credCol(cat)})` :
      ''}"></div></td><td class="r">${fmt(v)}<div class="small muted">${c}×</div></td></tr>`)
      .join('');
  const q = $in('q').value.trim().toLowerCase();
  let list: Tx[] = pool.filter((t) => !q || t[1].toLowerCase().includes(q));
  list = ($('sort') as HTMLSelectElement).value === 'amt' ?
      list.slice().sort((a, b) => Math.abs(b[2]) - Math.abs(a[2])) :
      list.slice().sort((a, b) => b[0].localeCompare(a[0]));
  const shown = list.slice(0, MAX_ROWS);
  const lt = sum(list.map((t) => t[2]));
  const multiYear = new Set(list.map((t) => t[0].slice(0, 4))).size > 1;
  $('tx-count').textContent = `${list.length} · ${mixed ? `net ${fmt(lt)}` : fmt(sg * lt)}` +
      (list.length > MAX_ROWS ? ` · first ${MAX_ROWS} shown` : '');
  $('txlist').innerHTML = shown.map((t) => `<tr data-id="${esc(t[5])}"><td class="d">${
      multiYear ? t[0] : t[0].slice(5)}</td><td>${esc(t[1])}${selCat === null ? ` <span class="tag">${
      esc(label(t[3]))}</span>` : ''}</td><td class="r">${fmt(credView ? -t[2] : t[2], 2)}</td></tr>`)
      .join('') || '<tr><td class="muted">No transactions match.</td></tr>';
}
