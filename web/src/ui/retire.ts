/**
 * @fileoverview Retirement: age slider, income breakdown, stacked chart by age, summary table,
 * and panels for every pension, account, investment and Social Security.
 *
 * License: BSD 3-Clause
 */

import {$, $in, app, changed, hideTip, num, onChange, showTip} from '../app';
import {esc, fk, fmt, niceStep, sum} from '../format';
import {ageWhen, budget, clone, drawPct, type IncomePart, overflowTarget, retirementIncome,
        retirementSavings, retireSavings, retireYear, spendAt, spendToday,
        ssFactor} from '../model';
import {presetPicker} from './presets';

//
// CONSTANTS
//
const TABLE_AGES = [55, 58, 60, 62, 65, 67, 70];
const FOLD_KEY = 'fp-retire-folded';

//
// PUBLIC
//

/** Builds the retirement section. */
export function buildRetire(): void {
  const d = app.d;
  const p = d.primary;
  lo = Math.max(55, Math.ceil(p.age));
  hi = Math.max(lo + 5, 70);
  const ra = $in('ra');
  ra.min = String(lo);
  ra.max = String(Math.max(hi, 75));
  $('ra-who').textContent = `${p.name} retires at`;
  $('retire-sub').textContent = `Monthly income at each retirement age, in today's dollars. ${
      d.partners.map((x) => `${x.name} is ${x.age}`).join(', ')}.${d.partners.length > 1 ?
      ` The chart and table follow ${p.name}'s age.` : ''}`;
  buildOthers();
  buildPanels();
  buildAssumptions();
  buildFolds();
  ra.addEventListener('input', () => {
    app.S.rs.age = +ra.value;
    changed();
  });
  $('r-reset').addEventListener('click', () => {
    app.S.rs = clone(app.defs.rs);
    fillRetire();
    changed();
  });
  onChange(drawRetire);
  fillRetire();
  drawRetire();
}

/** Fills every retirement input from the settings. */
export function fillRetire(): void {
  const rs = app.S.rs;
  $in('ra').value = String(rs.age);
  $in('r-ret').value = String(rs.ret);
  $in('r-inf').value = String(rs.inf);
  $in('r-wd').value = String(rs.wd);
  drawOthers();
  document.querySelectorAll<HTMLInputElement>('[data-r]').forEach((el) => {
    const v = getR(el.dataset.r!);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.dataset.r!.startsWith('draw|')) el.value = String(v ?? rs.wd);
    else el.value = v == null ? '' : String(v);
  });
  document.querySelectorAll<HTMLSelectElement>('select[data-claim]').forEach((el) => {
    const v = rs.claim[el.dataset.claim!];
    el.value = v == null ? '' : String(v);
  });
}

//
// INTERNAL
//
let lo = 55;
let hi = 70;
let markPreset: () => void = () => {};

/** Retirement-age controls for partners after the first. */
function buildOthers(): void {
  const d = app.d;
  const box = $('ra-others');
  const others = d.partners.slice(1);
  box.hidden = !others.length;
  box.innerHTML = others.map((p) => {
    const min = Math.max(50, Math.ceil(p.age));
    return `<div class="ctl"><div class="agehead"><span class="eyebrow">${esc(p.name)} retires at</span><span
      class="big num" id="rao-v-${esc(p.id)}"></span><span class="muted" id="rao-when-${
      esc(p.id)}"></span></div><label class="small" title="While locked, moving either slider
      moves both"><input type="checkbox" data-same="${esc(p.id)}"> lock: retire the same year as
      ${esc(d.primary.name)}</label><input type="range" data-rao="${esc(p.id)}" min="${
      min}" max="${Math.max(min + 5, 75)}" step="1" aria-label="${esc(p.name)} retirement age"></div>`;
  }).join('');
  box.querySelectorAll<HTMLInputElement>('[data-rao]').forEach((el) => {
    el.addEventListener('input', () => {
      const id = el.dataset.rao!;
      const rs = app.S.rs;
      if (rs.ages[id] == null) {
        // locked: move the primary partner so both still retire the same year
        const p = d.partners.find((x) => x.id === id)!;
        const ra = $in('ra');
        rs.age = Math.max(+ra.min, Math.min(+ra.max, Math.round(+el.value - p.age + d.primary.age)));
      } else {
        rs.ages[id] = +el.value;
      }
      changed();
    });
  });
  box.querySelectorAll<HTMLInputElement>('[data-same]').forEach((el) => {
    el.addEventListener('change', () => {
      const id = el.dataset.same!;
      const p = d.partners.find((x) => x.id === id)!;
      app.S.rs.ages[id] = el.checked ? null : Math.round(ageWhen(d, p, app.S.rs.age));
      changed();
    });
  });
}

/** Shows each other partner's retirement age and year. */
function drawOthers(): void {
  const {d, S} = app;
  const R = retirementIncome(d, S, S.rs.age);
  d.partners.slice(1).forEach((p) => {
    const own = S.rs.ages[p.id];
    const age = R.ages[p.id];
    const yr = R.years[p.id] - 1;
    $(`rao-v-${p.id}`).textContent = String(Math.floor(age));
    $(`rao-when-${p.id}`).textContent = `${yr} · ${Math.max(0, yr - Math.floor(d.todayYear))} years from now`;
    const same = document.querySelector<HTMLInputElement>(`[data-same="${CSS.escape(p.id)}"]`)!;
    same.checked = own == null;
    document.querySelector<HTMLInputElement>(`[data-rao="${CSS.escape(p.id)}"]`)!.value =
        String(Math.round(age));
  });
}

/** Color for an income part. */
function partColor(x: IncomePart): string {
  if (x.kind === 'pension') return '--r1';
  if (x.kind === 'investment') return '--r5';
  if (x.kind === 'savings') return '--onetime';
  if (x.kind === 'ss') return '--r4';
  return x.partner === app.d.primary.id ? '--r2' : '--r3';
}

/** Reads a dotted settings path under rs (e.g. "pen.a:0.est.55"). */
function getR(path: string): unknown {
  const parts = splitPath(path);
  let cur: unknown = app.S.rs;
  for (const k of parts) cur = (cur as Record<string, unknown>)?.[k];
  return cur;
}

/** Writes a dotted settings path under rs. */
function setR(path: string, v: unknown): void {
  const parts = splitPath(path);
  let cur = app.S.rs as unknown as Record<string, unknown>;
  parts.slice(0, -1).forEach((k) => cur = cur[k] as Record<string, unknown>);
  cur[parts[parts.length - 1]] = v;
}

/** Splits "pen|a:0|est|55" style paths. */
function splitPath(path: string): string[] {
  return path.split('|');
}

/** A yearly-withdrawal slider for one account (key like acct:a:0, inv:stocks, sav:savings). */
function drawCtl(key: string): string {
  return `<div class="ctl"><label>Yearly withdrawal <span class="small muted">for living
    expenses</span></label><span class="num" data-drawv="${esc(key)}"></span><input type="range"
    min="2" max="8" step="0.25" data-r="draw|${esc(key)}" aria-label="Yearly withdrawal"></div>`;
}

/** A numeric input bound to a settings path. */
function numInput(path: string, label: string, step = 50, wide = false): string {
  return `<div class="row"><label>${esc(label)}</label><input class="amt" type="number" step="${
      step}" inputmode="decimal" data-r="${esc(path)}"${wide ? ' style="width:120px"' : ''}></div>`;
}

/** Side panels: pensions, accounts, investments, Social Security. */
function buildPanels(): void {
  const d = app.d;
  let h = '';
  d.partners.forEach((p) => {
    p.pensions.forEach((pn, i) => {
      const key = `${p.id}:${i}`;
      const ests = Object.keys(pn.estimates).sort((a, b) => +a - +b);
      h += `<div class="panel" data-pane="pen|${esc(key)}|on"><label class="toggle"><input
        type="checkbox" data-r="pen|${esc(key)}|on"><h3>${esc(pn.name)} <span class="small muted">${
        esc(p.name)}</span></h3></label>` + (pn.monthly != null ?
          numInput(`pen|${key}|monthly`, 'Monthly benefit') :
          `<p class="small muted">Monthly estimates by retirement age. Ages in between are
            interpolated${pn.service_years_now != null ?
              '; after the last age it grows with years of service' : ''}.</p>
          <div class="est">${ests.map((a) => `<label>Age ${esc(a)}<input class="amt"
            type="number" step="50" inputmode="decimal" data-r="pen|${esc(key)}|est|${esc(a)}">
            </label>`).join('')}</div>`) + '</div>';
    });
    p.accounts.forEach((ac, i) => {
      const key = `${p.id}:${i}`;
      h += `<div class="panel" data-pane="acct|${esc(key)}|on"><label class="toggle"><input
        type="checkbox" data-r="acct|${esc(key)}|on"><h3>${esc(ac.name)} <span class="small muted">${
        esc(p.name)}</span></h3></label>${numInput(`acct|${key}|bal`, 'Balance today', 1000, true)}${
        numInput(`acct|${key}|monthly`, 'Adding per month')}${drawCtl(`acct:${key}`)}<p
        class="small muted">Grows at the return rate; contributions continue until retirement.</p></div>`;
    });
  });
  d.p.investments.forEach((v) => {
    h += `<div class="panel" id="pn-inv-${esc(v.id)}"><h3>${esc(v.name)}</h3>${
        numInput(`inv|${v.id}|bal`, 'Balance today', 1000, true)}
      <div class="row"><span>Adding per month</span><span><span class="num" id="r-ic-${
        esc(v.id)}"></span> <a class="small" href="#budget">set in Budgeting</a></span></div>
      <div class="ctl"><label>Return on this account</label><span class="num" id="r-ir-${
        esc(v.id)}"></span><input type="range" min="0" max="10" step="0.5" data-r="inv|${
        esc(v.id)}|ret"></div>${drawCtl(`inv:${v.id}`)}
      <p class="small muted" id="r-inote-${esc(v.id)}"></p></div>`;
  });
  retireSavings(d).forEach((sv) => {
    h += `<div class="panel" id="pn-sav-${esc(sv.id)}"><h3>${esc(sv.name)}</h3>
      <div class="row"><span>Balance today</span><span class="num">${fmt(sv.balance)}</span></div>
      <div class="row"><span>Adding per month</span><span><span class="num" id="r-sc-${
        esc(sv.id)}"></span> <a class="small" href="#budget">set in Budgeting</a></span></div>
      <div class="row"><span>Interest</span><span class="num">${sv.return_pct}%</span></div>
      ${drawCtl(`sav:${sv.id}`)}
      <p class="small muted">${sv.stops_at_retirement ? 'Contributions stop at retirement. ' :
        ''}Its balance at retirement becomes monthly income at its withdrawal rate. Balance and
        interest are set in Settings › Savings &amp; income.</p></div>`;
  });
  if (d.partners.length) {
    h += `<div class="panel" data-pane="ss"><label class="toggle"><input type="checkbox"
      data-r="ss"><h3>Social Security</h3></label><p class="small muted">Monthly benefit at full
      retirement age (67), in today's dollars. Get real estimates from your Social Security
      statement.</p>` + d.partners.map((p) => numInput(`ssAmt|${p.id}`, `${p.name} at 67`) +
        `<div class="row"><label for="claim-${esc(p.id)}">${esc(p.name)} claims at</label><select
          id="claim-${esc(p.id)}" data-claim="${esc(p.id)}" class="amt" style="width:auto"><option
          value="">when retiring (62+)</option>${[62, 63, 64, 65, 66, 67, 68, 69, 70].map((a) =>
            `<option value="${a}">${a}</option>`).join('')}</select></div>`).join('') +
      `<p class="small muted">Claiming at 62 pays 70% of the age-67 amount, and waiting until 70
      pays 124%. A benefit starts at the chosen age, or at retirement if that's later.</p></div>`;
  }
  const box = $('r-panels');
  box.innerHTML = h;
  box.querySelectorAll<HTMLInputElement>('[data-r]').forEach((el) => {
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      setR(el.dataset.r!, el.type === 'checkbox' ? el.checked :
          el.type === 'range' ? +el.value : num(el));
      changed();
    });
  });
  box.querySelectorAll<HTMLSelectElement>('select[data-claim]').forEach((el) => {
    el.addEventListener('change', () => {
      app.S.rs.claim[el.dataset.claim!] = el.value === '' ? null : +el.value;
      changed();
    });
  });
}

/**
 * Makes every card in the right column collapsible to its title line (so a change in a lower
 * card is visible in the chart without scrolling). Folded cards are remembered in this browser.
 */
function buildFolds(): void {
  const side = $('r-side');
  const panels = [...side.querySelectorAll<HTMLElement>('.panel')];
  let folded = new Set<string>();
  try {
    folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]);
  } catch {
    // storage unavailable: start with everything open
  }
  const keyOf = (el: HTMLElement) => el.querySelector('h3')?.textContent?.trim() ?? '';
  const store = () => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...folded]));
    } catch {
      // not remembered, which is fine
    }
  };
  const set = (el: HTMLElement, on: boolean) => {
    el.classList.toggle('folded', on);
    const b = el.querySelector<HTMLButtonElement>(':scope > .fold')!;
    b.setAttribute('aria-expanded', String(!on));
    b.textContent = on ? '▸' : '▾';
    if (on) folded.add(keyOf(el));
    else folded.delete(keyOf(el));
  };
  const allBtn = $('r-fold-all');
  const markAll = () => {
    allBtn.textContent = panels.every((p) => p.classList.contains('folded')) ? 'Expand all' :
        'Collapse all';
  };
  panels.forEach((el) => {
    el.classList.add('foldable');
    el.insertAdjacentHTML('afterbegin', `<button class="fold" type="button" aria-expanded="true"
      aria-label="Show or hide ${esc(keyOf(el))}">▾</button>`);
    set(el, folded.has(keyOf(el)));
    el.querySelector(':scope > .fold')!.addEventListener('click', () => {
      set(el, !el.classList.contains('folded'));
      store();
      markAll();
    });
  });
  allBtn.addEventListener('click', () => {
    const fold = allBtn.textContent === 'Collapse all';
    panels.forEach((el) => set(el, fold));
    store();
    markAll();
  });
  markAll();
}

/** Raises, presets and the rate sliders. */
function buildAssumptions(): void {
  const d = app.d;
  $('r-raises').innerHTML = d.partners.map((p) => `<div class="ctl"><label>${esc(p.name)} yearly
    raise <span class="small muted">above inflation</span></label><span class="num" id="raise-v-${
    esc(p.id)}"></span><input type="range" min="0" max="5" step="0.25" data-r="raise|${
    esc(p.id)}"></div>`).join('');
  $('r-raises').querySelectorAll<HTMLInputElement>('[data-r]').forEach((el) => {
    el.addEventListener('input', () => {
      setR(el.dataset.r!, +el.value);
      changed();
    });
  });
  markPreset = presetPicker($('r-scen'), 'retire', () => [app.S.rs.ret, app.S.rs.inf],
                            (ret, inf) => {
                              app.S.rs.ret = ret;
                              app.S.rs.inf = inf;
                              fillRetire();
                              changed();
                            });
  ([['r-ret', 'ret'], ['r-inf', 'inf'], ['r-wd', 'wd']] as const).forEach(([id, key]) => {
    $in(id).addEventListener('input', () => {
      app.S.rs[key] = +$in(id).value;
      changed();
    });
  });
}

/** Redraws the breakdown, chart and table. */
function drawRetire(): void {
  const {d, S} = app;
  const rs = S.rs;
  $in('ra').value = String(rs.age);
  drawOthers();
  document.querySelectorAll<HTMLElement>('[data-pane]').forEach((el) => {
    el.classList.toggle('pane-off', !getR(el.dataset.pane!));
  });
  $('r-ret-v').textContent = `${rs.ret}%`;
  $('r-inf-v').textContent = `${rs.inf}%`;
  $('r-wd-v').textContent = `${rs.wd}%`;
  d.partners.forEach((p) => {
    const el = document.getElementById(`raise-v-${p.id}`);
    if (el) el.textContent = `${rs.raise[p.id] ?? 0}%`;
    const r = document.querySelector<HTMLInputElement>(`[data-r="raise|${CSS.escape(p.id)}"]`);
    if (r) r.value = String(rs.raise[p.id] ?? 0);
  });
  markPreset();
  const tot = retirementSavings(d, S);
  $('r-totals').innerHTML = `<div><span class="eyebrow">Put in by retirement</span><span
    class="v num">${fmt(tot.invested)}</span><span class="small muted">balances today plus every
    contribution until ${tot.year - 1}</span></div><div><span class="eyebrow">Estimated total at
    retirement</span><span class="v num">${fmt(tot.total)}</span><span class="small muted">with
    returns, in ${tot.year - 1} dollars · ${fmt(tot.today)} in today's dollars</span></div>`;
  document.querySelectorAll<HTMLElement>('[data-drawv]').forEach((el) => {
    const key = el.dataset.drawv!;
    el.textContent = `${drawPct(rs, key)}%`;
    const r = document.querySelector<HTMLInputElement>(`[data-r="draw|${CSS.escape(key)}"]`);
    if (r && document.activeElement !== r) r.value = String(drawPct(rs, key));
  });
  retireSavings(d).forEach((sv) => {
    $(`r-sc-${sv.id}`).textContent = fmt(budget(d, S.st).amt[`sav:${sv.id}`] ?? 0);
  });
  d.p.investments.forEach((v) => {
    const st = rs.inv[v.id];
    const monthly = budget(d, S.st).amt[`inv:${v.id}`] ?? 0;
    const fed = d.p.savings.filter((sv) => overflowTarget(d, sv) === v.id).map((sv) => sv.name);
    const on = st.bal > 0 || monthly > 0 || fed.length > 0;
    $(`pn-inv-${v.id}`).classList.toggle('pane-off', !on);
    $(`r-ic-${v.id}`).textContent = fmt(monthly);
    $(`r-ir-${v.id}`).textContent = `${st.ret}%`;
    $(`r-inote-${v.id}`).textContent = !on ?
        'Off until you enter a balance here or a monthly amount in Budgeting.' :
        `Its own return rate, separate from the presets.${fed.length ? ` Also gets what ${
            fed.join(' and ')} adds once full.` : ''}${st.ret < rs.inf ?
            ` At ${st.ret}% it grows slower than ${rs.inf}% inflation, so it loses buying power.` :
            ''} Turned into monthly income at its withdrawal rate.`;
  });
  const R = retirementIncome(d, S, rs.age);
  const ry = retireYear(d, rs);
  const sp = spendAt(d, S, ry).spend;
  const staggered = d.partners.some((p) => R.years[p.id] !== ry);
  const net = 1 - S.fs.tax / 100;
  const today = spendToday(d, S.st);
  $('ra-v').textContent = String(rs.age);
  $('ra-when').textContent = `${R.years[d.primary.id] - 1} · ${
      Math.round(rs.age - d.primary.age)} years from now`;
  const who = (id: string) => d.partners.find((p) => p.id === id)?.name ?? '';
  const row = (x: IncomePart) => {
    let sub = '';
    if (x.balance != null) {
      sub = `${fmt(x.balance)} balance · ${
          fmt(x.balance / Math.pow(1 + rs.inf / 100, x.yrs ?? R.yrs))} in today's $`;
    }
    if (x.kind === 'pension') sub = who(x.partner);
    if (x.kind === 'ss') {
      sub = x.started ? `claimed at ${Math.floor(x.claimAge!)} · ${
          Math.round(ssFactor(x.claimAge!) * 100)}% of age-67 amount` :
          `starts ${x.start} at ${Math.ceil(x.claimAge! - 0.01)}: +${fmt(x.value)}/mo`;
    }
    return `<i class="sw" style="background:var(${partColor(x)})"></i><span>${esc(x.name)}${
        sub ? ` <span class="small muted">${esc(sub)}</span>` : ''}</span><span class="num">${
        fmt(x.started ? x.value : 0)}/mo</span>`;
  };
  const gapRow = (lbl: string, v: number) => {
    const c = sp ? v / sp : 0;
    const ok = c >= 1;
    return `<span></span><span><b>${ok ? lbl.replace('Gap', 'Surplus') : lbl}</b> <span
      class="small muted">${Math.round(c * 100)}% covered</span></span><span class="num ${
      ok ? 'pos' : 'neg'}"><b>${ok ? '+' : ''}${fmt(v - sp)}</b></span>`;
  };
  $('r-parts').innerHTML = R.parts.map(row).join('') +
      `<span></span><span class="tot">Income ${staggered ? `once everyone is retired (${ry - 1})` :
        'at retirement'}, before tax</span><span class="num tot">${
        fmt(R.total)}/mo</span>` +
      `<span></span><span class="muted">Income tax (${S.fs.tax}%)</span><span class="num muted">(${
        fmt(R.total * S.fs.tax / 100)})</span>` +
      `<span></span><span><b>After tax</b></span><span class="num"><b>${fmt(R.total * net)}/mo</b></span>` +
      (R.later > 0 ? `<span></span><span><b>After tax, once all Social Security starts</b> <span
        class="small muted">from ${R.fullYear}</span></span><span class="num"><b>${
        fmt(R.full * net)}/mo</b></span>` : '') +
      `<span></span><span>Projected spending in retirement <span class="small muted">children
        gone, retirement changes, health insurance · today it's ${fmt(today)}</span></span><span
        class="num">${fmt(sp)}/mo</span>` +
      gapRow(R.later > 0 ? 'Gap at retirement' : 'Gap each month', R.total * net) +
      (R.later > 0 ? gapRow(`Gap from ${R.fullYear} on`, R.full * net) : '');
  // legend
  const kinds: Array<[string, string]> = [];
  R.parts.forEach((x) => {
    const lbl = x.kind === 'pension' ? 'Pensions' : x.kind === 'investment' ? 'Investments' :
        x.kind === 'savings' ? 'Savings' : x.kind === 'ss' ? 'Social Security' :
        x.partner === d.primary.id ? `${d.primary.name}'s accounts` : 'Other accounts';
    if (!kinds.some(([l]) => l === lbl)) kinds.push([lbl, partColor(x)]);
  });
  $('r-legend').innerHTML = kinds.map(([l, c]) => `<span><i class="sw" style="background:var(${
      c})"></i>${esc(l)}</span>`).join('') +
      `<span><i class="sw" style="border:2px solid var(--r4);background:transparent"></i>Social Security starting later</span><span><i class="ln proj"></i>Projected retirement spending</span><span><i class="ln today"></i>Spending today</span>`;
  drawChart(today);
  drawTable();
}

/** Stacked income bars by retirement age with spending lines. */
function drawChart(today: number): void {
  const {d, S} = app;
  const net = 1 - S.fs.tax / 100;
  const ages = [];
  for (let a = lo; a <= hi; a++) ages.push(retirementIncome(d, S, a));
  const svg = $('rchart');
  const W = 960;
  const H = 300;
  const L = 56;
  const Rr = 12;
  const T = 14;
  const B = 30;
  const pw = W - L - Rr;
  const ph = H - T - B;
  const bw = pw / ages.length;
  const base0 = Math.round(d.todayYear - d.primary.age);
  const spA = ages.map((x) => spendAt(d, S, x.year).spend);
  const max = Math.max(today, ...spA, ...ages.map((x) => x.full * net), 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => T + ph - (v / top) * ph;
  let g = '';
  for (let v = 0; v <= top + 1e-6; v += step) {
    g += `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}"/><text x="${
        L - 8}" y="${y(v) + 4}" text-anchor="end">${fk(v)}</text>`;
  }
  const order = ['pension', 'account', 'investment', 'savings', 'ss'];
  ages.forEach((x, i) => {
    const bx = L + i * bw + bw * 0.16;
    const w = bw * 0.68;
    let base = T + ph;
    let segs = '';
    const started = x.parts.filter((p) => p.started)
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    started.forEach((p) => {
      const h = ph * p.value * net / top;
      if (h > 0.5) {
        base -= h;
        segs += `<rect x="${bx}" y="${base}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="2" style="fill:var(${partColor(p)})"/>`;
      }
    });
    if (x.later > 0) {
      const h = ph * x.later * net / top;
      base -= h;
      segs += `<rect x="${bx + 1}" y="${base + 1}" width="${w - 2}" height="${Math.max(h - 3, 0.5)}" rx="2" style="fill:none;stroke:var(--r4);stroke-width:2;stroke-dasharray:4 3"/>`;
    }
    const tip = `<b>Age ${x.age} · ${base0 + x.age}</b>` +
        started.map((p) => `<br>${esc(p.name)} ${fmt(p.value)}`).join('') +
        `<br><b>After tax ${fmt(x.total * net)}/mo</b>` +
        (x.later > 0 ? `<br>+ ${fmt(x.later * net)} Social Security from ${x.fullYear}<br><b>Then ${
            fmt(x.full * net)}/mo</b>` : '') + `<br>Projected spending ${fmt(spA[i])}/mo`;
    g += `<g class="m" data-a="${x.age}" data-tip="${tip.replace(/"/g, '&quot;')}">${segs}<rect class="hit" x="${
        L + i * bw}" y="${T}" width="${bw}" height="${ph}"/><text x="${L + i * bw + bw / 2}" y="${
        H - 10}" text-anchor="middle" ${x.age === S.rs.age ? 'class="selage"' : ''}>${x.age}</text></g>`;
  });
  g += `<line class="halo" x1="${L}" x2="${W - Rr}" y1="${y(today)}" y2="${y(today)}"/><line class="todayline" x1="${
      L}" x2="${W - Rr}" y1="${y(today)}" y2="${y(today)}"/>`;
  ages.forEach((_, i) => {
    const x1 = L + i * bw + bw * 0.08;
    const x2 = L + (i + 1) * bw - bw * 0.08;
    g += `<line class="halo" x1="${x1}" x2="${x2}" y1="${y(spA[i])}" y2="${y(spA[i])}"/><line class="projline" x1="${
        x1}" x2="${x2}" y1="${y(spA[i])}" y2="${y(spA[i])}"/>`;
  });
  svg.innerHTML = g;
  svg.querySelectorAll<SVGGElement>('g.m').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip!));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', () => {
      app.S.rs.age = +el.dataset.a!;
      changed();
    });
  });
}

/** Summary table for a few ages. */
function drawTable(): void {
  const {d, S} = app;
  const net = 1 - S.fs.tax / 100;
  const base0 = Math.round(d.todayYear - d.primary.age);
  const ages = TABLE_AGES.filter((a) => a >= lo && a <= hi);
  if (!ages.includes(S.rs.age)) ages.push(S.rs.age);
  ages.sort((a, b) => a - b);
  const kinds = ['pension', 'account', 'investment', 'savings', 'ss'].filter((k) =>
      retirementIncome(d, S, S.rs.age).parts.some((p) => p.kind === k));
  const names: Record<string, string> = {pension: 'Pensions', account: 'Accounts',
    investment: 'Investments', savings: 'Savings', ss: 'Soc. Sec.'};
  $('rtable').innerHTML = `<tr>${d.partners.map((p) => `<th>${esc(p.name)}</th>`).join('')}<th>Year</th>${
      kinds.map((k) => `<th>${names[k]}</th>`).join('')}<th>After tax</th><th>Once SS starts</th><th>Projected spending</th><th>vs spending, long run</th></tr>` +
      ages.map((a) => {
        const x = retirementIncome(d, S, a);
        const sa = spendAt(d, S, x.year).spend;
        const df = x.full * net - sa;
        return `<tr data-a="${a}" class="${a === S.rs.age ? 'on' : ''}">${d.partners.map((p) =>
            `<td>${Math.floor(x.ages[p.id])}</td>`).join('')}<td>${base0 + a}</td>${kinds.map((k) =>
            `<td>${fmt(sum(x.parts.filter((p) => p.kind === k && p.started).map((p) => p.value)))}</td>`)
            .join('')}<td>${fmt(x.total * net)}</td><td>${x.later > 0 ? `${fmt(x.full * net)} <span class="muted">(${
            x.fullYear})</span>` : '–'}</td><td>${fmt(sa)}</td><td class="${df >= 0 ? 'pos' : 'neg'}">${
            df >= 0 ? '+' : ''}${fmt(df)}</td></tr>`;
      }).join('');
  document.querySelectorAll<HTMLTableRowElement>('#rtable tr[data-a]').forEach((tr) => {
    tr.addEventListener('click', () => {
      app.S.rs.age = +tr.dataset.a!;
      changed();
    });
  });
}
