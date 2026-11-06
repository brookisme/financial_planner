/**
 * @fileoverview The summary strip and the monthly planner: category table (grouped, with credit
 * sub-rows), income, savings and one-time cost toggles.
 *
 * License: BSD 3-Clause
 */

import {$, app, changed, num, onChange, scrollToEl} from '../app';
import {esc, fk, fmt, sum} from '../format';
import {budget, clone, oneTimeNet} from '../model';
import {selectCat} from './explorer';

//
// PUBLIC
//

/** Builds the planner for the loaded data. */
export function buildPlanner(): void {
  const d = app.d;
  $('avg-head').textContent = `${d.n}-mo avg`;
  $('planner-sub').textContent =
      `Starts at each category's ${d.n}-month average. Type a new number to try a change.`;
  buildTable();
  buildSide();
  onChange(update);
  update();
}

/** Fills every input from the settings (after loading a scenario or resetting). */
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
    el.value = String(S.st.sav[el.dataset.sav!] ?? 0);
  });
}

//
// INTERNAL
//

/** The category table with group headings, credit sub-rows and totals. */
function buildTable(): void {
  const d = app.d;
  const groups: string[] = [];
  d.regular.forEach((i) => {
    if (!groups.includes(d.cats[i].group)) groups.push(d.cats[i].group);
  });
  let h = '';
  const range = (i: number, sign = 1) => {
    const v = d.byCat[i].map((x) => x * sign);
    return `${fk(Math.min(...v))} – ${fk(Math.max(...v))}`;
  };
  groups.forEach((g) => {
    h += `<tr class="group"><td colspan="5">${esc(g)}</td></tr>`;
    d.regular.filter((i) => d.cats[i].group === g).sort((a, b) => d.avg(b) - d.avg(a))
        .forEach((i) => {
          const subs = d.offsetsOf(d.cats[i].name).filter((c) => d.isPlannerCredit(c));
          h += `<tr><td><button class="cat-link" data-cat="${i}" type="button">${
              esc(d.cats[i].name)}</button>${subs.length ?
              ' <span class="small muted">expenses</span>' : ''}</td>
            <td class="num">${fmt(d.avg(i))}</td><td class="range num">${range(i)}</td>
            <td><input class="amt" type="number" step="25" inputmode="decimal" id="p-${i}"
              data-cat="${i}" aria-label="Planned monthly ${esc(d.cats[i].name)}"></td>
            <td><span class="delta num" id="d-${i}"></span></td></tr>`;
          if (subs.length) {
            h += subs.map((c) => creditRow(c, range(c, -1))).join('') +
                `<tr class="subtot"><td style="padding-left:22px">${esc(d.cats[i].name)}, net</td>
                <td class="num" id="net-avg-${i}"></td><td></td>
                <td class="num" id="net-plan-${i}" style="padding-right:14px"></td><td></td></tr>`;
          }
        });
  });
  h += `<tr class="total"><td>Total regular spending</td><td class="num" id="t-avg"></td><td></td>
    <td class="num" id="t-plan" style="padding-right:14px"></td>
    <td><span class="delta num" id="t-d"></span></td></tr>`;
  const loose = d.credits.filter((c) => d.isPlannerCredit(c) && !d.cats[c].offsets);
  if (loose.length) {
    h += loose.map((c) => creditRow(c, range(c, -1))).join('') +
        `<tr class="total"><td>Net spending</td><td class="num" id="n-avg"></td><td></td>
        <td class="num" id="n-plan" style="padding-right:14px"></td><td></td></tr>`;
  }
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
      scrollToEl($('explore'));
    });
  });
}

/** A credit row with its on/off toggle. */
function creditRow(c: number, range: string): string {
  const cat = app.d.cats[c];
  const name = cat.label || cat.name;
  return `<tr class="credit" id="row-${c}"><td style="padding-left:22px">
    <label class="toggle" style="align-items:center"><input type="checkbox"
      data-tg="${esc(cat.name)}"><span>− <button class="cat-link" data-cat="${c}" type="button">${
      esc(name)}</button>${cat.note ? ` <span class="small muted">${esc(cat.note)}</span>` : ''}
    </span></label></td>
    <td class="num">(${fmt(app.d.credAvg(c))})</td><td class="range num">${range}</td>
    <td><input class="amt" type="number" step="25" inputmode="decimal" id="p-${c}" data-cat="${c}"
      aria-label="Planned monthly ${esc(name)}"></td>
    <td><span class="delta num" id="d-${c}"></span></td></tr>`;
}

/** Wires checkboxes with data-tg (category toggles). */
function bindToggles(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>('[data-tg]').forEach((el) => {
    el.addEventListener('change', () => {
      app.S.st.on[el.dataset.tg!] = el.checked;
      changed();
    });
  });
}

/** Income, savings and one-time panels. */
function buildSide(): void {
  const {d} = app;
  const p = d.p;
  const row = (key: string, attr: string, label: string, note = '') =>
      `<div class="row"><label for="${attr}-${esc(key)}">${esc(label)}${note ?
          ` <span class="small muted">· ${esc(note)}</span>` : ''}</label><input class="amt"
        id="${attr}-${esc(key)}" data-${attr}="${esc(key)}" type="number" step="50"
        inputmode="decimal"></div>`;
  $('inc-rows').innerHTML = d.partners.map((x) => row(x.id, 'inc', x.name, x.take_home_note))
      .join('') + row('other', 'inc', 'Other income');
  $('sav-rows').innerHTML =
      d.children.map((c) => row(`529:${c.id}`, 'sav', `529, ${c.name}`)).join('') +
      p.savings.map((s) => row(`sav:${s.id}`, 'sav', s.name)).join('') +
      p.investments.map((v) => row(`inv:${v.id}`, 'sav', v.name, 'investing')).join('');
  $('sav-note').textContent = (d.children.length ?
      '529 contributions stop at each child\'s high school graduation. ' : '') +
      (p.investments.length ?
          'Investments are added to their balance in Retirement and stop at retirement.' : '');
  const ot = d.oneTime.map((i) => {
    const cat = d.cats[i];
    const total = sum(d.byCat[i]);
    const label = cat.label || `Include ${cat.name.toLowerCase()}`;
    let h = `<label class="toggle"><input type="checkbox" data-tg="${esc(cat.name)}"><span>${
        esc(label)} <span class="num">${fmt(d.avg(i))}</span>/mo <span class="small muted">(${
        fmt(total)} over ${d.n} months${cat.note ? `; ${esc(cat.note)}` : ''})</span></span></label>`;
    d.offsetsOf(cat.name).forEach((c) => {
      const cc = d.cats[c];
      h += `<label class="toggle" style="padding-left:24px"><input type="checkbox"
        data-tg="${esc(cc.name)}" data-parent="${esc(cat.name)}"><span>${
          esc(cc.label || `Subtract ${cc.name.toLowerCase()}`)} <span class="num">${
          fmt(d.credAvg(c))}</span>/mo <span class="small muted">(${fmt(-sum(d.byCat[c]))}${
          cc.note ? `; ${esc(cc.note)}` : ''}). Net: <span class="num" id="ot-net-${i}"></span>/mo
        </span></span></label>`;
    });
    return h;
  }).join('');
  $('ot-rows').innerHTML = ot;
  $('ot-panel').hidden = !d.oneTime.length;
  const side = $('ot-rows').parentElement!.parentElement!;
  bindToggles(side);
  side.querySelectorAll<HTMLInputElement>('[data-inc]').forEach((el) => {
    el.addEventListener('input', () => {
      app.S.st.inc[el.dataset.inc!] = num(el);
      changed();
    });
  });
  side.querySelectorAll<HTMLInputElement>('[data-sav]').forEach((el) => {
    el.addEventListener('input', () => {
      app.S.st.sav[el.dataset.sav!] = num(el);
      changed();
    });
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
  $('trim').addEventListener('click', () => {
    flex.forEach((i) => app.S.st.plan[d.cats[i].name] = Math.round(d.avg(i) * 0.9));
    fillPlanner();
    changed();
  });
  fillPlanner();
}

/** Recomputes deltas, totals and the strip. */
function update(): void {
  const {d, S} = app;
  const st = S.st;
  let tAvg = 0;
  let tPlan = 0;
  const setDelta = (i: number, a: number, p: number, goodUp: boolean) => {
    const dv = Math.abs(p - a) < 0.5 ? 0 : Math.round(p - a);
    const el = $(`d-${i}`);
    el.textContent = dv ? (dv > 0 ? '+' : '−') + fmt(Math.abs(dv)) : '';
    el.className = `delta num ${dv > 0 === goodUp ? 'pos' : 'neg'}`;
    if (!dv) el.className = 'delta num';
    $(`p-${i}`).classList.toggle('changed', !!dv);
  };
  d.regular.forEach((i) => {
    const a = d.avg(i);
    const p = st.plan[d.cats[i].name] ?? 0;
    tAvg += a;
    tPlan += p;
    setDelta(i, a, p, false);
  });
  d.credits.filter((c) => d.isPlannerCredit(c)).forEach((c) => {
    setDelta(c, d.credAvg(c), st.plan[d.cats[c].name] ?? 0, true);
    $(`row-${c}`).classList.toggle('pane-off', !st.on[d.cats[c].name]);
  });
  d.regular.forEach((i) => {
    const el = document.getElementById(`net-avg-${i}`);
    if (!el) return;
    const subs = d.offsetsOf(d.cats[i].name).filter((c) => st.on[d.cats[c].name]);
    el.textContent = fmt(d.avg(i) - sum(subs.map((c) => d.credAvg(c))));
    $(`net-plan-${i}`).textContent = fmt((st.plan[d.cats[i].name] ?? 0) -
        sum(subs.map((c) => st.plan[d.cats[c].name] ?? 0)));
  });
  const onCredits = d.credits.filter((c) => d.isPlannerCredit(c) && st.on[d.cats[c].name]);
  if (document.getElementById('n-avg')) {
    $('n-avg').textContent = fmt(tAvg - sum(onCredits.map((c) => d.credAvg(c))));
    $('n-plan').textContent = fmt(tPlan - sum(onCredits.map((c) => st.plan[d.cats[c].name] ?? 0)));
  }
  const dT = Math.abs(tPlan - tAvg) < 0.5 ? 0 : Math.round(tPlan - tAvg);
  $('t-avg').textContent = fmt(tAvg);
  $('t-plan').textContent = fmt(tPlan);
  const td = $('t-d');
  td.textContent = dT ? (dT > 0 ? '+' : '−') + fmt(Math.abs(dT)) : '';
  td.className = `delta num ${dT > 0 ? 'neg' : dT < 0 ? 'pos' : ''}`;
  d.oneTime.forEach((i) => {
    const el = document.getElementById(`ot-net-${i}`);
    if (el) el.textContent = fmt(oneTimeNet(d, st, i));
    const on = !!st.on[d.cats[i].name];
    document.querySelectorAll<HTMLInputElement>(`[data-parent="${CSS.escape(d.cats[i].name)}"]`)
        .forEach((sub) => {
          sub.disabled = !on;
          sub.parentElement!.classList.toggle('pane-off', !on);
        });
  });
  updateStrip();
}

/** The five figures at the top. */
function updateStrip(): void {
  const {d, S} = app;
  const st = S.st;
  const b = budget(d, st);
  $('s-inc').textContent = fmt(b.income);
  $('s-inc-note').textContent = `${d.partners.map((x) => x.name).join(' + ') || 'Household'}, net`;
  $('s-sp').textContent = fmt(b.spend);
  const extras = d.oneTime.filter((i) => !d.cats[i].tax && st.on[d.cats[i].name])
      .map((i) => `incl. ${d.cats[i].name.toLowerCase()}`);
  $('s-sp-note').textContent = [b.credits ? 'after credits' : 'regular categories', ...extras]
      .join(' · ');
  $('s-sv').textContent = fmt(b.savings + b.investing);
  const parts = [];
  if (d.children.length) parts.push('529s');
  d.p.savings.forEach((s) => parts.push(s.name));
  if (b.investing) parts.push('investments');
  $('s-sv-note').textContent = parts.join(' + ') || 'none set';
  const taxCats = d.oneTime.filter((i) => d.cats[i].tax && st.on[d.cats[i].name]);
  $('s-tx').textContent = taxCats.length ? fmt(b.tax) : 'off';
  const nested = taxCats.flatMap((i) => d.offsetsOf(d.cats[i].name))
      .filter((c) => st.on[d.cats[c].name]);
  $('s-tx-note').textContent = (taxCats.length ?
      taxCats.map((i) => d.cats[i].name.toLowerCase()).join(' + ') : 'none set aside') +
      (nested.length ? `, after ${nested.map((c) => d.cats[c].name.toLowerCase()).join(', ')}` :
          '');
  const L = $('s-left');
  L.textContent = fmt(b.left);
  L.className = `v ${b.left < 0 ? 'neg' : 'pos'}`;
  $('s-left-yr').textContent = `${b.left < 0 ? 'short ' : ''}${fmt(Math.abs(b.left) * 12)} over a year`;
}
