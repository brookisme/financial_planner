/**
 * @fileoverview Spending over time: a yearly chart of money in and out, life-stage table, and the
 * editable per-category changes for "kids gone" and "retired".
 *
 * License: BSD 3-Clause
 */

import {$, $in, app, changed, hideTip, num, onChange, showTip} from '../app';
import {esc, fk, fmt, niceStep} from '../format';
import {clone, deflator, incomeAt, PROJECTION_YEARS, retireYear, retirementIncome, simulate,
        spendAt} from '../model';

//
// PUBLIC
//

/** Builds the section. */
export function buildFuture(): void {
  const d = app.d;
  $('f-cats').innerHTML = [...d.regular].sort((a, b) => d.avg(b) - d.avg(a)).map((c) => {
    const n = esc(d.cats[c].name);
    return `<tr><td>${n}</td><td class="num" id="fc-t-${c}"></td>
      <td><span style="display:inline-flex;align-items:center;gap:3px"><input class="amt"
        style="width:64px" type="number" step="5" inputmode="decimal" data-c="${c}" data-f="kg"
        aria-label="${n} change when children are gone, percent">%</span></td>
      <td><span style="display:inline-flex;align-items:center;gap:3px"><input class="amt"
        style="width:64px" type="number" step="5" inputmode="decimal" data-c="${c}" data-f="rt"
        aria-label="${n} change in retirement, percent">%</span></td>
      <td class="num" id="fc-r-${c}"></td></tr>`;
  }).join('') + `<tr class="total"><td>Living costs</td><td class="num" id="fc-t-tot"></td><td></td>
    <td></td><td class="num" id="fc-r-tot"></td></tr>`;
  document.querySelectorAll<HTMLInputElement>('#f-cats input').forEach((inp) => {
    inp.addEventListener('input', () => {
      app.S.fs[inp.dataset.f as 'kg'|'rt'][d.cats[+inp.dataset.c!].name] = num(inp);
      changed();
    });
  });
  $in('f-health').addEventListener('input', () => {
    app.S.fs.health = num($in('f-health'));
    changed();
  });
  $in('f-tax').addEventListener('input', () => {
    app.S.fs.tax = num($in('f-tax'));
    changed();
  });
  document.querySelectorAll<HTMLButtonElement>('#f-view button').forEach((b) => {
    b.addEventListener('click', () => {
      app.S.fs.nominal = b.dataset.v === 'nom';
      changed();
    });
  });
  $('f-reset').addEventListener('click', () => {
    const nominal = app.S.fs.nominal;
    app.S.fs = clone(app.defs.fs);
    app.S.fs.nominal = nominal;
    fillFuture();
    changed();
  });
  const grads = d.children.map((c, k) => `${c.name} finishes high school in ${
      d.timelines[k].graduation}`);
  $('f-built').textContent = `${grads.length ? `${grads.join('; ')}. Each 529 contribution stops ` +
      'at that graduation. ' : ''}Savings marked to stop at retirement, investment ` +
      'contributions, and credits and costs not marked "in retirement" stop at retirement. ' +
      'Contributions set as "% left" follow each year\'s left-over. Income before retirement is today\'s take-home, kept up with inflation plus ' +
      'any yearly raise set in Retirement assumptions.';
  onChange(drawFuture);
  fillFuture();
  drawFuture();
}

/** Fills the inputs from the settings. */
export function fillFuture(): void {
  const {d, S} = app;
  document.querySelectorAll<HTMLInputElement>('#f-cats input').forEach((inp) => {
    inp.value = String(S.fs[inp.dataset.f as 'kg'|'rt'][d.cats[+inp.dataset.c!].name] ?? 0);
  });
  $in('f-health').value = String(S.fs.health);
  $in('f-tax').value = String(S.fs.tax);
}

//
// INTERNAL
//

/** Redraws the chart, tables and caption. */
function drawFuture(): void {
  const {d, S} = app;
  document.querySelectorAll<HTMLButtonElement>('#f-view button').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.v === 'nom') === S.fs.nominal));
  });
  const RY = retireYear(d, S.rs);
  const R = retirementIncome(d, S, S.rs.age);
  const rS = spendAt(d, S, RY);
  const now = spendAt(d, S, d.todayYear);
  const early: Array<[number, string]> = d.partners.filter((p) => R.years[p.id] < RY)
      .map((p) => [R.years[p.id], `${p.name} retired`]);
  const retired = early.length ? 'All retired' : 'Retired';
  d.regular.forEach((c) => {
    $(`fc-t-${c}`).textContent = fmt(S.st.plan[d.cats[c].name] ?? 0);
    $(`fc-r-${c}`).textContent = fmt(rS.cats[d.cats[c].name]);
  });
  $('fc-t-tot').textContent = fmt(now.living);
  $('fc-r-tot').textContent = fmt(rS.living);
  const years: number[] = [];
  for (let y = d.todayYear; y < d.todayYear + PROJECTION_YEARS; y++) years.push(y);
  const rows = years.map((y) => {
    const s = spendAt(d, S, y);
    const k = deflator(d, S, y);
    return {y, out: s.spend * k, sav: s.savings * k, inc: incomeAt(d, S, y) * k, s};
  });
  const svg = $('fchart');
  const W = 960;
  const H = 320;
  const L = 56;
  const Rr = 12;
  const events: Array<[number, string]> = d.children.map((c, k) =>
      [Math.floor(d.gradT(k)), `${c.name} out`] as [number, string])
      .concat(early, [[RY, retired]]).filter(([yr]) => yr >= years[0] && yr <= years[years.length - 1]);
  const T = 16 + events.length * 12;
  const B = 30;
  const pw = W - L - Rr;
  const ph = H - T - B;
  const bw = pw / years.length;
  const max = Math.max(...rows.map((r) => Math.max(r.out + r.sav, r.inc)), 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => T + ph - (v / top) * ph;
  let g = '';
  for (let v = 0; v <= top + 1e-6; v += step) {
    g += `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}"/><text x="${
        L - 8}" y="${y(v) + 4}" text-anchor="end">${fk(v)}</text>`;
  }
  events.forEach(([yr, lbl], j) => {
    const x = L + (yr - years[0]) * bw;
    g += `<line x1="${x}" x2="${x}" y1="${T - 6}" y2="${T + ph}" style="stroke:var(--ink3);stroke-width:1;stroke-dasharray:3 3"/><text x="${
        x + 4}" y="${10 + j * 12}" style="fill:var(--ink)">${esc(lbl)} ${yr}</text>`;
  });
  let path = '';
  rows.forEach((r, i) => {
    const bx = L + i * bw + bw * 0.14;
    const w = bw * 0.72;
    const h1 = ph * r.out / top;
    const h2 = ph * r.sav / top;
    const left = r.inc - r.out - r.sav;
    const k = deflator(d, S, r.y);
    const ages = d.partners.map((p) => `${p.name} ${Math.floor(p.age + r.y - d.todayYear)}`)
        .join(', ');
    const tip = `<b>${r.y}</b> · ${esc(ages)}<br>${r.s.kids} of ${d.children.length} children at home${
        r.s.ret ? ' · retired' : ''}<br>Living ${fmt(r.s.living * k)}` +
        (r.s.annual ? `<br>Annual expenses ${fmt(r.s.annual * k)}` : '') +
        (r.s.health ? `<br>Health insurance ${fmt(r.s.health * k)}` : '') +
        (r.s.emergency ? `<br>Emergency costs ${fmt(r.s.emergency * k)} (from the fund)` : '') +
        (r.s.short ? `<br>Emergency costs the fund can't cover ${fmt(r.s.short * k)}` : '') +
        (r.sav ? `<br>Savings ${fmt(r.sav)}` : '') + `<br>Income ${fmt(r.inc)}<br><b>${
        left >= 0 ? 'Left over' : 'Short'} ${fmt(Math.abs(left))}/mo</b>`;
    g += `<g class="m" data-tip="${tip.replace(/"/g, '&quot;')}"><rect x="${bx}" y="${
        T + ph - h1}" width="${w}" height="${Math.max(h1, 0)}" rx="2" class="sel"/>` +
        (h2 > 0.5 ? `<rect x="${bx}" y="${T + ph - h1 - h2}" width="${w}" height="${
            Math.max(h2 - 2, 0.5)}" rx="2" style="fill:var(--save)"/>` : '') +
        `<rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ph}"/>` +
        ((r.y % 5 === 0 || i === 0) ? `<text x="${L + i * bw + bw / 2}" y="${
            H - 10}" text-anchor="middle">${r.y}</text>` : '') + '</g>';
    const x0 = L + i * bw;
    path += `${i ? 'L' : 'M'}${x0},${y(r.inc)}L${x0 + bw},${y(r.inc)}`;
  });
  g += `<path d="${path}" style="fill:none;stroke:var(--ink);stroke-width:2.5;pointer-events:none"/>`;
  svg.innerHTML = g;
  svg.querySelectorAll<SVGGElement>('g.m').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip!));
    el.addEventListener('mouseleave', hideTip);
  });
  $('f-cap').textContent = S.fs.nominal ?
      `Future dollars at ${S.rs.inf}% inflation. A ${fmt(now.spend)}/mo budget today is ${
          fmt(now.spend * deflator(d, S, RY))}/mo in ${RY} money with the same buying power.` :
      `In today's dollars, so years compare directly. Switch to "With inflation" to see actual ` +
      `amounts each year (${S.rs.inf}% a year, set in Retirement assumptions).`;
  const stages: Array<[number, string]> = [[d.todayYear, 'Today']];
  d.children.forEach((c, k) => {
    const yr = Math.floor(d.gradT(k)) + 1;
    if (yr < RY) stages.push([yr, `${c.name} out`]);
  });
  stages.push(...early, [RY, retired]);
  const ssDone = R.fullYear;
  if (ssDone > RY) stages.push([ssDone, 'All Social Security started']);
  stages.sort((a, b) => a[0] - b[0]);
  const dl = S.fs.nominal ? ' (with inflation)' : " (today's $)";
  $('f-phases').innerHTML = `<tr><th>Stage</th><th>Year</th><th>Ages</th><th>Living costs</th><th>Annual expenses</th><th>Health ins.</th><th>Savings</th><th>Total out</th><th>Income${
      dl}</th><th>Left over</th></tr>` + stages.map(([yr, lbl]) => {
    const s = spendAt(d, S, yr);
    const k = deflator(d, S, yr);
    const inc = incomeAt(d, S, yr) * k;
    const out = (s.spend + s.savings) * k;
    const df = inc - out;
    return `<tr><td>${esc(lbl)}</td><td>${yr}</td><td>${d.partners.map((p) =>
        Math.floor(p.age + yr - d.todayYear)).join(' / ')}</td><td>${fmt(s.living * k)}</td><td>${
        fmt(s.annual * k)}</td><td>${fmt(s.health * k)}</td><td>${fmt(s.savings * k)}</td><td>${
        fmt(out)}</td><td>${fmt(inc)}</td><td class="${df >= 0 ? 'pos' : 'neg'}">${
        df >= 0 ? '+' : ''}${fmt(df)}</td></tr>`;
  }).join('');
  drawBalances(stages);
}

/** Balances of every 529, savings account and investment at the start of each stage. */
function drawBalances(stages: Array<[number, string]>): void {
  const {d, S} = app;
  const sim = simulate(d, S);
  const names: Array<[string, string]> = [
    ...d.children.map((c) => [`529:${c.id}`, `529, ${c.name}`] as [string, string]),
    ...d.p.savings.map((s) => [`sav:${s.id}`, s.name] as [string, string]),
    ...d.p.investments.map((v) => [`inv:${v.id}`, v.name] as [string, string]),
  ];
  $('f-bal-panel').hidden = !names.length;
  if (!names.length) return;
  const real = (y: number) => S.fs.nominal ? 1 : Math.pow(1 + S.rs.inf / 100, y - d.todayYear);
  const balAt = (key: string, y: number) => (sim.years.get(y - 1)?.bal[key] ?? 0) / real(y);
  const start: Record<string, number> = {};
  d.children.forEach((c) => start[`529:${c.id}`] = c.college_529.balance);
  d.p.savings.forEach((s) => start[`sav:${s.id}`] = s.balance);
  d.p.investments.forEach((v) => start[`inv:${v.id}`] = S.rs.inv[v.id]?.bal ?? v.balance);
  const capped = d.p.savings.filter((s) => s.max_balance != null);
  $('f-bal').innerHTML = `<tr><th>Account</th>${stages.map(([yr, lbl]) =>
      `<th>${esc(lbl)} ${yr}</th>`).join('')}${capped.length ? '<th>Reaches max</th>' : ''}</tr>` +
      names.map(([key, name]) => {
        const sv = capped.find((s) => `sav:${s.id}` === key);
        const full = sv ? sim.full[key] : undefined;
        const kid = d.children.findIndex((c) => `529:${c.id}` === key);
        const spent = (yr: number) => kid >= 0 && yr > Math.floor(d.gradT(kid)) + 1;
        return `<tr><td>${esc(name)}</td>${stages.map(([yr]) => `<td>${spent(yr) ? '–' :
            fmt(yr <= d.todayYear ? start[key] : balAt(key, yr))}</td>`).join('')}${
            capped.length ? `<td>${sv ? (full == null ? 'not at this rate' :
                `${full} (${fmt(sv.max_balance!)})`) : ''}</td>` : ''}</tr>`;
      }).join('');
  $('f-bal-note').textContent = `Balance at the start of each stage${S.fs.nominal ? '' :
      ', in today\'s dollars'}. 529s show until college starts; ` +
      'savings past their max go to their overflow investment; emergency costs come out of ' +
      'emergency funds first.';
}
