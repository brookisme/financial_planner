/**
 * @fileoverview Property: one card per home, car, rental or other thing owned, with its value,
 * loan and equity over time, the loan's payoff, a car's replacement and a rental's rent. Values
 * are in dollars of each year. Property is set up in Settings › Property; the replacement
 * set-aside is an annual expense and rent is an income line in Budgeting.
 *
 * License: BSD 3-Clause
 */

import {$, app, onChange} from '../app';
import {esc, fk, fmt, niceStep, sum} from '../format';
import {loanBalance, loanInterest, loanMonths, payoffT, PROJECTION_YEARS, propertyEquity,
        propertyValue, replaceMo, replacePrice, replaceYear, retireYear} from '../model';
import type {Property} from '../types';

//
// CONSTANTS
//
const TYPES: Record<Property['type'], string> = {home: 'Home', car: 'Car', rental: 'Rental',
  other: 'Other'};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov',
  'Dec'];

//
// PUBLIC
//

/** Builds the cards (or hides the section when there is no property). */
export function buildProperty(): void {
  const d = app.d;
  $('property').hidden = !d.props.length;
  $('nav-property').hidden = !d.props.length;
  $('props').innerHTML = d.props.map((x) => `<div class="panel kid" id="pr-${esc(x.id)}">
      <div><h3>${esc(x.name)}</h3><p class="small muted">${TYPES[x.type]}${
        x.life_years != null ? ` · ${x.age_years} of ${x.life_years} years old` : ''}${
        x.loan && x.loan.balance > 0 ? ` · loan at ${x.loan.rate_pct}%` : ''}</p></div>
      <svg class="chart" id="prc-${esc(x.id)}" viewBox="0 0 480 220" role="img"
        aria-label="${esc(x.name)}: value, loan and equity by year"></svg>
      <div class="legend small"><span><i class="sw" style="background:var(--accent);height:3px;border-radius:0"></i>Value</span>${
        x.loan && x.loan.balance > 0 ? '<span><i class="sw" style="background:var(--neg);height:3px;border-radius:0"></i>Owed</span>' +
        '<span><i class="sw" style="background:var(--ink);height:3px;border-radius:0"></i>Equity' +
        '</span>' : ''}</div>
      <div class="out" id="pro-${esc(x.id)}"></div>
    </div>`).join('');
  onChange(updateProperty);
  updateProperty();
}

//
// INTERNAL
//

/** Refreshes the totals and every card. */
function updateProperty(): void {
  const d = app.d;
  if (!d.props.length) return;
  const S = app.S;
  const inf = S.rs.inf;
  const RY = retireYear(d, S.rs);
  const tR = Math.max(0, RY - d.todayT);
  const owed = sum(d.props.map((x) => x.loan?.balance ?? 0));
  const eqNow = sum(d.props.map((x) => propertyEquity(x, 0, inf)));
  const eqR = sum(d.props.map((x) => propertyEquity(x, tR, inf)));
  $('pr-totals').innerHTML = `<div><span class="eyebrow">Equity today</span><span class="v num">${
    fmt(eqNow)}</span><span class="small muted">worth ${fmt(eqNow + owed)} · owed ${
    fmt(owed)}</span></div><div><span class="eyebrow">Equity at retirement</span><span
    class="v num">${fmt(eqR)}</span><span class="small muted">in ${RY - 1} dollars · ${
    fmt(eqR / Math.pow(1 + inf / 100, tR))} in today's dollars</span></div>`;
  d.props.forEach((x) => {
    drawChart(x, RY);
    const rows: Array<[string, string]> = [['Worth today', fmt(x.value)]];
    const l = x.loan;
    if (l && l.balance > 0) {
      const t = payoffT(d, x)!;
      const n = loanMonths(l);
      rows.push(['Owed today', fmt(l.balance)], ['Equity today', fmt(x.value - l.balance)],
                ['Payment', `${fmt(l.payment_monthly)}/mo`],
                ['Paid off', `${MONTHS[Math.round((t % 1) * 12) % 12]} ${
                  Math.floor(t + 1e-9)} · ${yearsText(n / 12)}`],
                ['Interest still to pay', fmt(loanInterest(l))]);
      if (l.category) {
        rows.push(['', `<span class="small muted">From then on the projections drop ${
          fmt(l.payment_monthly)}/mo from ${esc(l.category)}.</span>`]);
      }
    }
    const ry = replaceYear(d, x);
    if (ry != null) {
      const item = S.st.annual.find((a) => a.name === `Replace ${x.name}`);
      const left = x.life_years! - x.age_years;
      rows.push(['Replaced', `${ry}, then every ${yearsText(x.life_years!)}`],
                [`Costs then (${ry} dollars)`, fmt(replacePrice(x, left, S.rs.inf))],
                ['Set aside to replace', `${fmt(item ? item.amt / 12 : replaceMo(x, S.rs.inf))}/mo`]);
      rows.push(['', `<span class="small muted">${item ? 'In Budgeting › Annual expenses as "' +
        esc(item.name) + '".' : 'Not in this budget\'s annual expenses: add "Replace ' +
        esc(x.name) + '" there to count it.'}</span>`]);
    }
    const rent = S.st.inc[`prop:${x.id}`];
    if (rent != null) rows.push(['Rent, after its costs', `${fmt(rent)}/mo, in income`]);
    rows.push(['Equity at retirement', fmt(propertyEquity(x, tR, inf))]);
    $(`pro-${x.id}`).innerHTML = rows.map(([k, v]) => k ? `<span>${k}</span><span class="num">${
      v}</span>` : `<span style="grid-column:1/-1">${v}</span>`).join('');
  });
}

/** Value, what is owed and equity by year, with the payoff and retirement marked. */
function drawChart(x: Property, RY: number): void {
  const d = app.d;
  const inf = app.S.rs.inf;
  const W = 480;
  const H = 220;
  const L = 48;
  const R = 8;
  const T = 26;
  const B = 22;
  const pw = W - L - R;
  const ph = H - T - B;
  const span = Math.min(PROJECTION_YEARS, Math.max(20, RY - d.todayYear + 5));
  const ts = Array.from({length: span * 4 + 1}, (_, i) => i / 4);
  const val = ts.map((t) => propertyValue(x, t, inf));
  const owe = ts.map((t) => x.loan ? loanBalance(x.loan, Math.round(t * 12)) : 0);
  const max = Math.max(...val, ...owe, 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const px = (t: number) => L + t / span * pw;
  const py = (v: number) => T + ph - Math.max(0, v) / top * ph;
  let g = '';
  for (let v = 0; v <= top + 1e-6; v += step) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}"/><text x="${
      L - 6}" y="${py(v) + 4}" text-anchor="end">${fk(v)}</text>`;
  }
  for (let t = 0; t <= span; t += 5) {
    g += `<text x="${px(t)}" y="${H - 6}" text-anchor="middle">${d.todayYear + t}</text>`;
  }
  const marks: Array<[number, string]> = [[RY - d.todayT, `Retire ${RY}`]];
  const off = payoffT(d, x);
  if (off != null) marks.push([off - d.todayT, `Paid off ${Math.floor(off + 1e-9)}`]);
  marks.filter(([t]) => t > 0 && t <= span).forEach(([t, lbl], j) => {
    g += `<line x1="${px(t)}" x2="${px(t)}" y1="${T - 4}" y2="${T + ph}" style="stroke:var(--ink3);stroke-width:1;stroke-dasharray:3 3"/><text x="${
      px(t) + 3}" y="${10 + j * 12}" style="fill:var(--ink)">${esc(lbl)}</text>`;
  });
  const line = (vs: number[], col: string, w = 2) => `<path d="${vs.map((v, i) =>
    `${i ? 'L' : 'M'}${px(ts[i]).toFixed(1)},${py(v).toFixed(1)}`).join('')}" style="fill:none;stroke:var(${
    col});stroke-width:${w};stroke-linejoin:round"/>`;
  g += line(val, '--accent');
  if (x.loan && x.loan.balance > 0) {
    g += line(owe, '--neg') + line(val.map((v, i) => v - owe[i]), '--ink', 2.5);
  }
  $(`prc-${x.id}`).innerHTML = g;
}

/** "8 years" or "8 years, 3 months". */
function yearsText(y: number): string {
  const m = Math.round(y * 12);
  const yr = Math.floor(m / 12);
  const mo = m % 12;
  return `${yr} year${yr === 1 ? '' : 's'}${mo ? `, ${mo} month${mo === 1 ? '' : 's'}` : ''}`;
}
