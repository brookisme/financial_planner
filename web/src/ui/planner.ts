/**
 * @fileoverview Budgeting: the category table (Planned / mo, a Compare
 * column and the difference, with credit sub-rows and a summary of annual expenses, emergency
 * costs and savings), income, savings (fixed, a share of the left-over or the rest), the annual
 * expenses list and emergency fund costs.
 *
 * License: BSD 3-Clause
 */

import {$, $in, app, changed, num, onChange, scrollToEl} from '../app';
import {esc, fmt, sum} from '../format';
import {budget, clone, overflowTarget, rebaseBudget, simulate} from '../model';
import type {PlannerState, SavLine} from '../types';
import {budgetChoices, budgetSt, savedBudgets} from './budgets';
import {buildFolds} from './folds';
import {selectCat, selectionAvg, selectionLabel} from './spending';

//
// PUBLIC
//

/** Builds Budgeting for the loaded data. */
export function buildPlanner(): void {
  const d = app.d;
  $('planner-sub').textContent = `Planned / mo starts at each category's ${d.n}-month ` +
      'average. Type a new number to try a change, and save it as a budget.';
  buildTable();
  buildSide();
  buildFolds($('p-side'), $('p-fold-all'), 'fp-budget-folded');
  $('cmp-sel').addEventListener('change', () => {
    cmpKey = ($('cmp-sel') as HTMLSelectElement).value;
    update();
  });
  refreshCompare();
  onChange(update);
  update();
}

/** Fills every input from the settings (after loading a budget or resetting). */
export function fillPlanner(): void {
  const {d, S} = app;
  const plan = (i: number) => {
    const el = document.getElementById(`p-${i}`) as HTMLInputElement|null;
    if (el) el.value = String(Math.round(S.st.plan[d.cats[i].name] ?? 0));
  };
  d.regular.forEach(plan);
  d.credits.forEach(plan);
  document.querySelectorAll<HTMLInputElement>('[data-tg]').forEach((el) => {
    el.checked = !!S.st.on[el.dataset.tg!];
  });
  document.querySelectorAll<HTMLInputElement>('[data-inc]').forEach((el) => {
    el.value = String(S.st.inc[el.dataset.inc!] ?? 0);
  });
  document.querySelectorAll<HTMLInputElement>('[data-sav]').forEach((el) => {
    const v = S.st.sav[el.dataset.sav!]?.[el.dataset.f as keyof SavLine];
    el.value = v == null ? '' : String(v);
  });
  $in('em-amt').value = S.st.emerg == null ? '' : String(S.st.emerg);
  renderAnnual();
}

/** Rebuilds the Compare choices (12-month average and every saved budget). */
export function refreshCompare(): void {
  const sel = $('cmp-sel') as HTMLSelectElement;
  const list = savedBudgets();
  if (cmpKey !== 'avg' && !list.some((b) => b.id === cmpKey)) cmpKey = 'avg';
  sel.innerHTML = `<option value="avg">${app.d.n}-mo avg</option>` + list.map((b) =>
      `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  sel.value = cmpKey;
  if (document.getElementById('psum')?.childElementCount) update();
}

//
// INTERNAL
//
const FILL_CHART = '__chart';
let cmpKey = 'avg';

/** The planner settings in the Compare column. */
function compareSt(): PlannerState {
  const b = savedBudgets().find((x) => x.id === cmpKey);
  return b ? rebaseBudget(app.defs.st, b.st, b.base) : app.defs.st;
}

/** The category table with group headings, credit sub-rows, totals and the summary. */
function buildTable(): void {
  const d = app.d;
  const groups: string[] = [];
  d.regular.forEach((i) => {
    if (!groups.includes(d.cats[i].group)) groups.push(d.cats[i].group);
  });
  let h = '';
  groups.forEach((g) => {
    h += `<tr class="group"><td colspan="4">${esc(g)}</td></tr>`;
    d.regular.filter((i) => d.cats[i].group === g).sort((a, b) => d.avg(b) - d.avg(a))
        .forEach((i) => {
          const subs = d.offsetsOf(d.cats[i].name).filter((c) => d.isPlannerCredit(c));
          h += `<tr><td><button class="cat-link" data-cat="${i}" type="button">${
              esc(d.cats[i].name)}</button>${subs.length ?
              ' <span class="small muted">expenses</span>' : ''}</td>
            <td><input class="amt" type="number" step="25" inputmode="decimal" id="p-${i}"
              data-cat="${i}" aria-label="Planned monthly ${esc(d.cats[i].name)}"></td>
            <td class="num" id="c-${i}"></td><td><span class="delta num" id="d-${i}"></span></td></tr>`;
          if (subs.length) {
            h += subs.map(creditRow).join('') +
                `<tr class="subtot"><td style="padding-left:22px">${esc(d.cats[i].name)}, net</td>
                <td class="num" id="net-p-${i}" style="padding-right:14px"></td>
                <td class="num" id="net-c-${i}"></td><td></td></tr>`;
          }
        });
  });
  h += `<tr class="total"><td>Total regular spending</td>
    <td class="num" id="t-p" style="padding-right:14px"></td><td class="num" id="t-c"></td>
    <td><span class="delta num" id="t-d"></span></td></tr>`;
  // credits not shown under a regular category (none, an annual cost, or a name that isn't one)
  const loose = d.credits.filter((c) => d.isPlannerCredit(c) &&
                                        !d.regular.includes(d.idx(d.cats[c].offsets ?? '')));
  if (loose.length) h += loose.map(creditRow).join('');
  const body = $('ptbody');
  body.innerHTML = h;
  body.querySelectorAll<HTMLInputElement>('input.amt').forEach((inp) => {
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      app.S.st.plan[d.cats[+inp.dataset.cat!].name] = isNaN(v) ? 0 : v;
      changed();
    });
  });
  bindToggles(body);
  body.querySelectorAll<HTMLButtonElement>('.cat-link').forEach((b) => {
    b.addEventListener('click', () => {
      selectCat(+b.dataset.cat!);
      scrollToEl($('spending'));
    });
  });
  const sumRow = (id: string, label: string, cls = '') => `<tr class="${cls}"><td>${label}</td>
    <td class="num" id="sp-${id}" style="padding-right:14px"></td><td class="num" id="sc-${id}"></td>
    <td><span class="delta num" id="sd-${id}"></span></td></tr>`;
  $('psum').innerHTML = sumRow('net', 'Net spending') + sumRow('an', 'Annual expenses') +
      sumRow('em', 'Emergency fund costs <span class="small muted" id="em-how"></span>') +
      savLabels().map(([k, label]) => sumRow(k.replace(':', '-'), esc(label))).join('') +
      sumRow('tot', 'Monthly total, spending + savings', 'total');
}

/** A credit row with its on/off toggle. */
function creditRow(c: number): string {
  const cat = app.d.cats[c];
  const name = cat.label || cat.name;
  return `<tr class="credit" id="row-${c}"><td style="padding-left:22px">
    <label class="toggle" style="align-items:center"><input type="checkbox"
      data-tg="${esc(cat.name)}"><span>− <button class="cat-link" data-cat="${c}" type="button">${
      esc(name)}</button>${cat.note ? ` <span class="small muted">${esc(cat.note)}</span>` : ''}
    </span></label></td>
    <td><input class="amt" type="number" step="25" inputmode="decimal" id="p-${c}" data-cat="${c}"
      aria-label="Planned monthly ${esc(name)}"></td>
    <td class="num" id="c-${c}"></td><td><span class="delta num" id="d-${c}"></span></td></tr>`;
}

/** Every savings line as [key, label]. */
function savLabels(): Array<[string, string]> {
  const d = app.d;
  return [...d.children.map((c): [string, string] => [`529:${c.id}`, `529, ${c.name}`]),
    ...d.accounts.map((a): [string, string] => [a.key, a.acct.pre_tax ?
      `${a.acct.name} (pre-tax)` : a.acct.name]),
    ...d.p.savings.map((s): [string, string] => [`sav:${s.id}`, s.name]),
    ...d.p.investments.map((v): [string, string] => [`inv:${v.id}`, v.name])];
}

/** Wires checkboxes with data-tg (credit toggles). */
function bindToggles(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>('[data-tg]').forEach((el) => {
    el.addEventListener('change', () => {
      app.S.st.on[el.dataset.tg!] = el.checked;
      changed();
    });
  });
}

/** Income, savings, annual expenses and emergency fund panels. */
function buildSide(): void {
  const {d} = app;
  const p = d.p;
  const row = (key: string, attr: string, label: string, note = '') =>
      `<div class="row"><label for="${attr}-${esc(key)}">${esc(label)}${note ?
          ` <span class="small muted">· ${esc(note)}</span>` : ''}</label><input class="amt"
        id="${attr}-${esc(key)}" data-${attr}="${esc(key)}" type="number" step="50"
        inputmode="decimal"></div>`;
  $('inc-rows').innerHTML = d.partners.map((x) => row(x.id, 'inc', x.name, x.take_home_note))
      .join('') + row('other', 'inc', 'Other income') +
      d.props.filter((x) => x.rent_monthly || x.type === 'rental').map((x) =>
        row(`prop:${x.id}`, 'inc', `Rent, ${x.name}`, 'after its costs')).join('');
  const kind = {stocks: 'stocks', bonds: 'bonds', savings: 'savings', emergency: 'emergency fund'};
  $('sav-rows').innerHTML =
      d.children.map((c) => savRow(`529:${c.id}`, `529, ${c.name}`)).join('') +
      d.accounts.map((a) => savRow(a.key, a.acct.name, `${a.partner.name} · ${
        a.acct.pre_tax ? 'pre-tax' : 'post-tax'}`)).join('') +
      p.savings.map((s) => savRow(`sav:${s.id}`, s.name, kind[s.type])).join('') +
      p.investments.map((v) => savRow(`inv:${v.id}`, v.name, kind[v.type])).join('');
  $('sav-note').textContent = [
    d.children.length ? '529 contributions stop at each child\'s high school graduation.' : '',
    d.accounts.length ? 'Retirement accounts stop when their partner retires. A pre-tax one ' +
        'on $/mo comes out of pay before take-home, so it doesn\'t change what\'s left over.' : '',
    p.investments.length ? 'Investments are added to their balance in Retirement and stop at ' +
        'retirement.' : '',
    'Fixed amounts come off first; "% left" takes a share of what is left after spending, ' +
        'annual expenses and the fixed amounts; "rest" splits whatever is still left evenly.',
  ].filter(Boolean).join(' ');
  const side = $('sav-rows').closest('.side') as HTMLElement;
  side.querySelectorAll<HTMLInputElement>('[data-inc]').forEach((el) => {
    el.addEventListener('input', () => {
      app.S.st.inc[el.dataset.inc!] = num(el);
      changed();
    });
  });
  side.querySelectorAll<HTMLInputElement>('[data-sav]').forEach((el) => {
    el.addEventListener('input', () => {
      const f = el.dataset.f as 'amt'|'pct'|'min'|'max';
      const line = app.S.st.sav[el.dataset.sav!];
      if (f === 'min' || f === 'max') line[f] = el.value === '' ? null : num(el);
      else line[f] = num(el);
      changed();
    });
  });
  side.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      app.S.st.sav[b.dataset.key!].mode = b.dataset.mode as SavLine['mode'];
      changed();
    });
  });
  wireAnnual();
  $in('em-amt').addEventListener('input', () => {
    const el = $in('em-amt');
    app.S.st.emerg = el.value === '' ? null : num(el);
    changed();
  });
  const flex = d.regular.filter((i) => d.cats[i].flexible);
  $('trim').hidden = !flex.length;
  $('trim-note').textContent = (flex.length ? `Flexible spending = ${
      flex.map((i) => d.cats[i].name.toLowerCase()).join(', ')}. ` : '') +
      'Your changes are saved with the plan.';
  $('reset').addEventListener('click', () => {
    app.S.st = clone(app.defs.st);
    fillPlanner();
    changed();
  });
  // the Planned / mo header is a menu: fill the column from the chart, the average or a budget
  const fillSel = $('fill-sel') as HTMLSelectElement;
  const fillOptions = () => {
    fillSel.innerHTML = '<option value="">Planned / mo</option><optgroup label="Fill from">' +
        [[FILL_CHART, `Spending chart: ${selectionLabel()}`], ...budgetChoices()].map(([v, n]) =>
          `<option value="${esc(v)}">${esc(n)}</option>`).join('') + '</optgroup>';
  };
  fillSel.addEventListener('focus', fillOptions);
  fillSel.addEventListener('mousedown', fillOptions);
  fillSel.addEventListener('change', () => {
    const v = fillSel.value;
    const from = v === FILL_CHART ? null : budgetSt(v);
    if (!v || (v !== FILL_CHART && !from)) return;
    const st = app.S.st;
    [...d.regular, ...d.credits.filter((c) => d.isPlannerCredit(c))].forEach((i) => {
      const n = d.cats[i].name;
      st.plan[n] = from ? from.plan[n] ?? 0 : Math.round(selectionAvg(i));
    });
    if (from) d.credits.forEach((c) => st.on[d.cats[c].name] = !!from.on[d.cats[c].name]);
    const what = fillSel.selectedOptions[0].textContent;
    fillSel.value = '';
    fillPlanner();
    changed();
    $('trim-note').textContent = `Planned / mo filled from ${what}.`;
  });
  fillOptions();
  $('trim').addEventListener('click', () => {
    flex.forEach((i) => app.S.st.plan[d.cats[i].name] = Math.round(d.avg(i) * 0.9));
    fillPlanner();
    changed();
  });
  fillPlanner();
}

/** The annual expenses list: one row per item (label, yearly amount, remove). */
function renderAnnual(): void {
  $('an-rows').innerHTML = (app.S.st.annual ?? []).map((a, i) => `<div class="an-row"
    data-i="${i}"><input type="text" data-af="name" value="${esc(a.name)}" placeholder="e.g. Taxes"
    aria-label="Annual expense name"><input class="amt" type="number" step="100" inputmode="decimal"
    data-af="amt" value="${a.amt}" aria-label="${esc(a.name || 'Annual expense')} per year"><button
    class="btn sm" type="button" data-arm aria-label="Remove ${esc(a.name || 'this expense')}">×</button>
    </div>`).join('') || '<p class="small muted">No annual expenses. Add taxes, insurance…</p>';
}

/** Edits, adds and removes annual expenses. */
function wireAnnual(): void {
  const rows = $('an-rows');
  rows.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const i = +(el.closest('[data-i]') as HTMLElement).dataset.i!;
    const item = app.S.st.annual[i];
    if (el.dataset.af === 'name') item.name = el.value;
    else item.amt = num(el);
    changed();
  });
  rows.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-arm]');
    if (!b) return;
    const i = +(b.closest('[data-i]') as HTMLElement).dataset.i!;
    app.S.st.annual.splice(i, 1);
    renderAnnual();
    changed();
  });
  $('an-add').addEventListener('click', () => {
    app.S.st.annual.push({name: '', amt: 0});
    renderAnnual();
    changed();
    (rows.querySelector('.an-row:last-child input') as HTMLInputElement|null)?.focus();
  });
}

/** Recomputes the compare column, differences, totals, savings and the strip. */
function update(): void {
  const {d, S} = app;
  const st = S.st;
  const cs = compareSt();
  const setDiff = (el: HTMLElement, p: number, c: number, goodUp: boolean) => {
    const dv = Math.abs(p - c) < 0.5 ? 0 : Math.round(p - c);
    el.textContent = dv ? (dv > 0 ? '+' : '−') + fmt(Math.abs(dv)) : '';
    el.className = dv ? `delta num ${dv > 0 === goodUp ? 'pos' : 'neg'}` : 'delta num';
    return dv;
  };
  const cell = (i: number, goodUp: boolean) => {
    const n = d.cats[i].name;
    const p = st.plan[n] ?? 0;
    const c = cs.plan[n] ?? 0;
    $(`c-${i}`).textContent = fmt(c);
    const dv = setDiff($(`d-${i}`), p, c, goodUp);
    $(`p-${i}`).classList.toggle('changed', !!dv);
  };
  d.regular.forEach((i) => cell(i, false));
  d.credits.filter((c) => d.isPlannerCredit(c)).forEach((c) => {
    cell(c, true);
    $(`row-${c}`).classList.toggle('pane-off', !st.on[d.cats[c].name]);
  });
  const net = (s: PlannerState, i: number) => (s.plan[d.cats[i].name] ?? 0) -
      sum(d.offsetsOf(d.cats[i].name).filter((c) => s.on[d.cats[c].name])
          .map((c) => s.plan[d.cats[c].name] ?? 0));
  d.regular.forEach((i) => {
    const el = document.getElementById(`net-p-${i}`);
    if (!el) return;
    el.textContent = fmt(net(st, i));
    $(`net-c-${i}`).textContent = fmt(net(cs, i));
  });
  const reg = (s: PlannerState) => sum(d.regular.map((i) => s.plan[d.cats[i].name] ?? 0));
  $('t-p').textContent = fmt(reg(st));
  $('t-c').textContent = fmt(reg(cs));
  setDiff($('t-d'), reg(st), reg(cs), false);
  const bp = budget(d, st);
  const bc = budget(d, cs);
  const sumLine = (id: string, p: number, c: number, goodUp: boolean) => {
    $(`sp-${id}`).textContent = fmt(p);
    $(`sc-${id}`).textContent = fmt(c);
    setDiff($(`sd-${id}`), p, c, goodUp);
  };
  const fund = d.funds.length > 0;
  sumLine('net', bp.spend - (fund ? 0 : bp.emergency), bc.spend - (fund ? 0 : bc.emergency), false);
  sumLine('an', bp.annual, bc.annual, false);
  sumLine('em', bp.emergency, bc.emergency, false);
  $('em-how').textContent = fund ? '(paid from the fund, not in the total)' : '';
  savLabels().forEach(([k, label]) => {
    const id = k.replace(':', '-');
    sumLine(id, bp.amt[k] ?? 0, bc.amt[k] ?? 0, true);
    const cell = $(`sp-${id}`).previousElementSibling!;
    cell.textContent = d.fromPay(k, st.sav[k]) ? `${label}, from pay (not in the total)` : label;
  });
  const total = (b: typeof bp) => b.spend + b.annual + b.savings + b.investing;
  sumLine('tot', total(bp), total(bc), false);
  $('an-total').textContent = `${fmt(sum(st.annual.map((a) => a.amt)))}/yr · ${fmt(bp.annual)}/mo`;
  updateSavings();
}

/** One contribution line: a fixed amount, a percent of the left-over with min / max, or the rest. */
function savRow(key: string, label: string, note = ''): string {
  const k = esc(key);
  if (label.toLowerCase().includes(note)) note = '';
  const inp = (f: string, cls: string, aria: string, step = 50) => `<input class="${cls}"
    type="number" step="${step}" inputmode="decimal" data-sav="${k}" data-f="${f}"
    aria-label="${esc(label)} ${aria}">`;
  return `<div class="savline" data-line="${k}"><div class="row"><span>${esc(label)}${note ?
      ` <span class="small muted">· ${esc(note)}</span>` : ''}</span><span class="ctls"><span
      class="seg sm" role="group" aria-label="${esc(label)} contribution type"><button
      type="button" data-key="${k}" data-mode="fixed">$/mo</button><button type="button"
      data-key="${k}" data-mode="pct">% left</button><button type="button" data-key="${k}"
      data-mode="rest" title="An even share of whatever is left after everything else">rest</button></span><span
      data-show="fixed">${inp('amt', 'amt', 'per month')}</span><span data-show="pct">${
      inp('pct', 'amt pct', 'percent of left-over', 5)}%</span><span data-show="rest"
      class="num" data-rest="${k}"></span></span></div>
    <div class="pctrow" data-show="pct">min ${inp('min', 'amt', 'at least per month')} max ${
      inp('max', 'amt', 'at most per month')} <span class="num" data-out="${k}"></span></div>
    <span class="small muted" data-note="${k}"></span></div>`;
}

/** Contribution modes, computed amounts, fund balances and the emergency note. */
function updateSavings(): void {
  const {d, S} = app;
  const b = budget(d, S.st);
  const sim = simulate(d, S);
  const invName = (id: string) => d.p.investments.find((v) => v.id === id)?.name ?? id;
  document.querySelectorAll<HTMLElement>('[data-line]').forEach((el) => {
    const key = el.dataset.line!;
    const line = S.st.sav[key];
    el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === line.mode));
    });
    el.querySelectorAll<HTMLElement>('[data-show]').forEach((x) => {
      x.hidden = x.dataset.show !== line.mode;
    });
    el.querySelector<HTMLElement>('[data-out]')!.textContent = `= ${fmt(b.amt[key] ?? 0)}/mo`;
    el.querySelector<HTMLElement>('[data-rest]')!.textContent = `${fmt(b.amt[key] ?? 0)}/mo`;
    const note: string[] = [];
    const ac = d.accounts.find((x) => x.key === key)?.acct;
    if (ac?.pre_tax) {
      note.push(line.mode === 'fixed' ? 'from pay, before take-home' :
          'from the left-over, like the other lines');
    }
    if (ac?.employer_monthly) note.push(`+ ${fmt(ac.employer_monthly)}/mo from the employer`);
    const sv = d.p.savings.find((x) => `sav:${x.id}` === key);
    if (sv) {
      note.push(`${fmt(sv.balance)} today${sv.max_balance != null ?
          ` of ${fmt(sv.max_balance)} max` : ''}`);
      if (sv.max_balance != null) {
        const full = sim.full[key];
        const to = overflowTarget(d, sv);
        note.push(full == null ? 'won\'t reach the max at this rate' :
            full <= d.todayYear ? 'at the max' : `reaches the max in ${full}`);
        if (to) note.push(`then goes to ${invName(to)}`);
      }
    }
    el.querySelector<HTMLElement>('[data-note]')!.textContent = note.join(' · ');
  });
  const fundIn = sum(d.funds.map((f) => b.amt[`sav:${f.id}`] ?? 0));
  $in('em-amt').placeholder = String(Math.round(fundIn));
  const names = d.funds.map((f) => f.name).join(' and ');
  const change = fundIn - b.emergency;
  $('em-note').textContent = d.funds.length ?
      `Paid from ${names}, not the monthly budget. ${fmt(fundIn)}/mo goes in, so it ${
        Math.abs(change) < 0.5 ? 'holds steady' : change > 0 ?
            `grows ${fmt(change)}/mo` : `shrinks ${fmt(-change)}/mo`}. Empty = the same as ` +
          'what goes in. Whatever the fund can\'t cover comes out of that month.' :
      'No emergency fund in Settings › Savings & income, so this counts as monthly spending.';
}
