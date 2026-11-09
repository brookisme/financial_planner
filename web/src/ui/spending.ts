/**
 * @fileoverview Explore spending: spending / credits / both, category chips, the monthly chart,
 * KPIs, top merchants and the transaction list (with an opt-in Recategorize mode).
 *
 * License: BSD 3-Clause
 */

import {$, $in, app, hideTip, onChange, showTip} from '../app';
import {esc, fk, fmt, niceStep, sum} from '../format';
import {budget} from '../model';
import type {Tx} from '../types';
import {openRuleDialog} from './categorize';

//
// CONSTANTS
//
const CREDIT_COLORS = ['--r2', '--r3', '--r4', '--r5', '--r1'];
const MAX_ROWS = 400;

//
// PUBLIC
//

/** Builds the explorer for the loaded data. */
export function buildExplorer(): void {
  const d = app.d;
  monthOf = new Map(d.p.months.map((m, i) => [m, i]));
  spendOT = d.costs;
  credCats = d.credits;
  REG_M = d.p.months.map((_, m) => sum(d.regular.map((c) => d.byCat[c][m])));
  OT_M = d.p.months.map((_, m) => sum(spendOT.map((c) => d.byCat[c][m])));
  CR_M = d.p.months.map((_, m) => -sum(credCats.map((c) => d.byCat[c][m])));
  const mf = $('mfilter') as HTMLSelectElement;
  mf.innerHTML = '<option value="">All months</option>' +
      d.p.month_labels.map((l, i) => `<option value="${i}">${esc(l)}</option>`).join('');
  mf.addEventListener('change', () => {
    selMonth = mf.value === '' ? null : +mf.value;
    drawChart();
    drawDetail();
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
  onChange(drawChart);
  setMode('spend');
}

/** Focuses a category (switching mode if needed). */
export function selectCat(c: number|null): void {
  if (c !== null && !inMode(c)) {
    mode = isCredit(c) ? 'cred' : 'spend';
    markMode();
  }
  selCat = c;
  buildChips();
  drawChart();
  drawDetail();
}

//
// INTERNAL
//
type Mode = 'spend'|'cred'|'both';
let selCat: number|null = null;
let selMonth: number|null = null;
let mode: Mode = 'spend';
let recat = false;
let monthOf = new Map<string, number>();
let spendOT: number[] = [];
let credCats: number[] = [];
let REG_M: number[] = [];
let OT_M: number[] = [];
let CR_M: number[] = [];

const isCredit = (c: number) => app.d.cats[c].kind === 'credit';
const isOne = (c: number) => app.d.cats[c].kind === 'one_time';
const inMode = (c: number) => mode === 'both' ? true : mode === 'cred' ? isCredit(c) : !isCredit(c);
const credCol = (c: number) => CREDIT_COLORS[Math.max(0, credCats.indexOf(c)) %
                                              CREDIT_COLORS.length];
const label = (c: number) => app.d.cats[c].name;

/** Sets the spending / credits / both mode. */
function setMode(v: Mode): void {
  mode = v;
  selCat = null;
  markMode();
  buildChips();
  drawChart();
  drawDetail();
}

/** Marks the active mode button. */
function markMode(): void {
  document.querySelectorAll<HTMLButtonElement>('#xmode button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === mode));
  });
}

/** Chip text: prefix, name and amount. */
function chipText(c: number): string {
  const d = app.d;
  const pre = isOne(c) ? 'One-time: ' : isCredit(c) ? 'Credits: ' : '';
  const amt = isOne(c) ? fk(Math.abs(sum(d.byCat[c]))) : `${fk(Math.abs(d.avg(c)))}/mo`;
  return `${pre}${esc(label(c))} <span class="num">${amt}</span>`;
}

/** The category chips. */
function buildChips(): void {
  const d = app.d;
  const spendOrder = [...d.regular].sort((a, b) => d.avg(b) - d.avg(a)).concat(spendOT);
  const order = mode === 'cred' ? credCats : mode === 'both' ? spendOrder.concat(credCats) :
      spendOrder;
  const allLbl = {spend: 'All spending', cred: 'All credits', both: 'Spending & credits'}[mode];
  const chips = $('chips');
  chips.innerHTML = `<button class="chip" type="button" data-cat="" aria-pressed="${
      selCat === null}">${allLbl}</button>` + order.map((c) => `<button class="chip${
      isOne(c) || isCredit(c) ? ' ot' : ''}" type="button" data-cat="${c}" aria-pressed="${
      selCat === c}">${chipText(c)}</button>`).join('');
  chips.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => {
    b.addEventListener('click', () => selectCat(b.dataset.cat === '' ? null : +b.dataset.cat!));
  });
}

/** The monthly bar chart (spending up, credits down). */
function drawChart(): void {
  const d = app.d;
  const M = d.p.month_labels;
  const svg = $('mchart');
  const W = 960;
  const H = 300;
  const L = 52;
  const R = 12;
  const T = 14;
  const B = 30;
  const pw = W - L - R;
  const ph = H - T - B;
  const bw = pw / M.length;
  const b = budget(d, app.S.st);
  const savTot = b.savings + b.investing;
  type Series = {col: string; v: number[]; name: string};
  let up: Series[] = [];
  let down: Series[] = [];
  let lines: Array<{cls: string; v: number}> = [];
  let title: string;
  let leg: string;
  const sw = (col: string, name: string) =>
      `<span><i class="sw" style="background:${col}"></i>${esc(name)}</span>`;
  if (selCat === null) {
    if (mode === 'cred') {
      up = credCats.map((c) => ({col: `var(${credCol(c)})`, v: d.byCat[c].map((x) => -x),
        name: label(c)}));
      const a = sum(CR_M) / d.n;
      lines = [{cls: 'avgline', v: a}];
      title = 'All credits by month';
      leg = up.map((x) => sw(x.col, x.name)).join('') +
          `<span><i class="ln"></i>Avg ${fmt(a)}/mo</span>`;
    } else {
      up = [{col: 'var(--accent)', v: REG_M, name: 'Regular'},
            {col: 'var(--onetime)', v: OT_M, name: 'One-time'}];
      if (mode === 'both') {
        down = [{col: 'var(--r2)', v: CR_M, name: 'Credits'}];
        title = 'Spending (above) and credits (below) by month';
        leg = sw('var(--accent)', 'Regular spending') + sw('var(--onetime)', 'One-time spending') +
            sw('var(--r2)', 'Credits');
      } else {
        const a = sum(REG_M) / d.n;
        lines = [{cls: 'avgline', v: a}, {cls: 'saveline', v: a + savTot}];
        title = 'All spending by month';
        leg = sw('var(--accent)', 'Regular') + sw('var(--onetime)', 'One-time') +
            `<span><i class="ln"></i>Avg regular ${fmt(a)}</span><span><i class="ln save"></i>+ savings ${
                fmt(a + savTot)}</span>`;
      }
    }
  } else {
    const neg = isCredit(selCat);
    const v = neg ? d.byCat[selCat].map((x) => -x) : d.byCat[selCat];
    const col = neg ? `var(${credCol(selCat)})` : 'var(--accent)';
    up = [{col, v, name: label(selCat)}];
    if (!isOne(selCat)) lines = [{cls: 'avgline', v: sum(v) / d.n}];
    title = `${isOne(selCat) ? 'One-time: ' : neg ? 'Credits: ' : ''}${label(selCat)} by month`;
    leg = sw(col, label(selCat)) + (isOne(selCat) ? '' :
        `<span><i class="ln"></i>Avg ${fmt(sum(v) / d.n)}/mo</span>`);
  }
  $('chart-title').textContent = title;
  $('legend').innerHTML = leg;
  const upT = M.map((_, m) => sum(up.map((x) => Math.max(x.v[m], 0))));
  const dnT = M.map((_, m) => sum(down.map((x) => Math.max(x.v[m], 0))));
  const maxU = Math.max(...upT, ...lines.map((l) => l.v), 1);
  const maxD = Math.max(...dnT, 0);
  const step = niceStep(maxU + maxD);
  const topU = Math.ceil(maxU / step) * step;
  const topD = maxD ? Math.ceil(maxD / step) * step : 0;
  const span = topU + topD;
  const y = (v: number) => T + ph * (topU - v) / span;
  let g = '';
  for (let v = -topD; v <= topU + 1e-6; v += step) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${
        L - 8}" y="${y(v) + 4}" text-anchor="end">${v < 0 ? '−' : ''}${fk(Math.abs(v))}</text>`;
  }
  if (topD) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--ink3);stroke-width:1.5"/>`;
  }
  M.forEach((lab, m) => {
    const x = L + m * bw + bw * 0.18;
    const w = bw * 0.64;
    let bars = '';
    let base = y(0);
    up.forEach((s) => {
      const h = ph * Math.max(s.v[m], 0) / span;
      if (h > 0.5) {
        base -= h;
        bars += `<rect x="${x}" y="${base}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="3" style="fill:${s.col}"/>`;
      }
    });
    base = y(0);
    down.forEach((s) => {
      const h = ph * Math.max(s.v[m], 0) / span;
      if (h > 0.5) {
        bars += `<rect x="${x}" y="${base + 2}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="3" style="fill:${s.col}"/>`;
        base += h;
      }
    });
    let tip = `<b>${esc(lab)}</b>`;
    up.concat(down).forEach((s) => {
      if (Math.abs(s.v[m]) >= 0.5) tip += `<br>${esc(s.name)} ${fmt(s.v[m])}`;
    });
    if (selCat === null && mode === 'both') tip += `<br><b>Net spending ${fmt(upT[m] - dnT[m])}</b>`;
    else if (up.length > 1) tip += `<br><b>Total ${fmt(upT[m])}</b>`;
    if (selCat !== null) {
      const n = d.p.tx.filter((t) => t[3] === selCat && monthOf.get(t[0].slice(0, 7)) === m)
          .length;
      tip += ` · ${n} transaction${n === 1 ? '' : 's'}`;
    }
    const on = selMonth === m;
    g += `<g class="m" data-m="${m}" data-tip="${tip.replace(/"/g, '&quot;')}">${bars}<rect class="hit" x="${
        L + m * bw}" y="${T}" width="${bw}" height="${ph}"/><text x="${L + m * bw + bw / 2}" y="${
        H - 10}" text-anchor="middle" ${on ? 'class="month-on" style="font-weight:600"' : ''}>${
        on ? '▸ ' : ''}${esc(lab)}</text></g>`;
  });
  lines.forEach((l) => {
    g += `<line class="${l.cls}" x1="${L}" x2="${W - R}" y1="${y(l.v)}" y2="${y(l.v)}"/>`;
  });
  svg.innerHTML = g;
  svg.querySelectorAll<SVGGElement>('g.m').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip!));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', () => {
      const m = +el.dataset.m!;
      selMonth = selMonth === m ? null : m;
      ($('mfilter') as HTMLSelectElement).value = selMonth === null ? '' : String(selMonth);
      drawChart();
      drawDetail();
    });
  });
}

/** Simplifies a description to a merchant name for the top-merchants list. */
function merchKey(desc: string): string {
  return desc.replace(/^(SQ|TST|SP|DD|PB|EB|ACT|RF|FH|IN|COT|TCB|CKE|SPO)\s*\*\s*/i, '$1 ')
      .replace(/[*#].*$/, '').replace(/\s+\d[\d\s-]*.*$/, '').replace(/\s+(INC|LLC)\.?$/i, '')
      .trim().toUpperCase();
}

/** KPIs, top merchants and the transaction list. */
function drawDetail(): void {
  const d = app.d;
  const M = d.p.month_labels;
  const pool = d.p.tx.filter((t) => selCat === null ? inMode(t[3]) : t[3] === selCat);
  const credView = selCat !== null ? isCredit(selCat) : mode === 'cred';
  const sg = credView ? -1 : 1;
  const mixed = selCat === null && mode === 'both';
  const kpi = (lbl: string, v: string, sub = '') => `<div class="kpi"><span class="eyebrow">${
      lbl}</span><span class="v">${v}</span>${sub ? `<span class="small muted">${sub}</span>` : ''}</div>`;
  const k = $('kpis');
  if (selCat !== null && isOne(selCat)) {
    const vals = d.byCat[selCat].map((x) => x * sg);
    const total = sum(vals);
    k.innerHTML = kpi('Total', fmt(total)) + kpi('Per month', fmt(total / d.n)) +
        kpi('Transactions', String(pool.length)) +
        kpi('Months', vals.map((v, i) => v > 0 ? M[i].slice(0, 3) : null).filter(Boolean)
            .join(', '));
  } else if (mixed) {
    const spend = sum(REG_M) + sum(OT_M);
    const cred = sum(CR_M);
    k.innerHTML = kpi('Spending / mo', fmt(spend / d.n), 'incl. one-time') +
        kpi('Credits / mo', fmt(cred / d.n)) + kpi('Net / mo', fmt((spend - cred) / d.n)) +
        kpi(`${d.n}-month net`, fmt(spend - cred));
  } else {
    const vals = selCat === null ? (mode === 'cred' ? CR_M : REG_M) :
        d.byCat[selCat].map((x) => x * sg);
    const hiM = vals.indexOf(Math.max(...vals));
    const loM = vals.indexOf(Math.min(...vals));
    k.innerHTML = kpi('Avg / month', fmt(sum(vals) / d.n)) + kpi('High', fmt(vals[hiM]), M[hiM]) +
        kpi('Low', fmt(vals[loM]), M[loM]) +
        kpi(`${d.n}-month total`, fmt(sum(vals)),
            selCat === null && mode === 'spend' ? 'regular only' : '');
  }
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
  let list: Tx[] = pool.filter((t) => (selMonth === null || monthOf.get(t[0].slice(0, 7)) ===
      selMonth) && (!q || t[1].toLowerCase().includes(q)));
  list = ($('sort') as HTMLSelectElement).value === 'amt' ?
      list.slice().sort((a, b) => Math.abs(b[2]) - Math.abs(a[2])) :
      list.slice().sort((a, b) => b[0].localeCompare(a[0]));
  const shown = list.slice(0, MAX_ROWS);
  const lt = sum(list.map((t) => t[2]));
  $('tx-count').textContent = `${list.length} · ${mixed ? `net ${fmt(lt)}` : fmt(sg * lt)}` +
      (list.length > MAX_ROWS ? ` · first ${MAX_ROWS} shown` : '');
  $('txlist').innerHTML = shown.map((t) => `<tr data-id="${esc(t[5])}"><td class="d">${
      t[0].slice(5)}</td><td>${esc(t[1])}${selCat === null ? ` <span class="tag">${
      esc(label(t[3]))}</span>` : ''}</td><td class="r">${fmt(credView ? -t[2] : t[2], 2)}</td></tr>`)
      .join('') || '<tr><td class="muted">No transactions match.</td></tr>';
}
