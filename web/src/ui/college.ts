/**
 * @fileoverview College 529 cards: one per child, with school type, cost, editable presets and
 * sliders. The 529's balance and monthly contribution come from Budgeting › Savings.
 *
 * License: BSD 3-Clause
 */

import {$, $in, app, changed, num, onChange} from '../app';
import {esc, fmt} from '../format';
import {budget, kidCalc} from '../model';
import {presetPicker} from './presets';

//
// PUBLIC
//

/** Builds the cards (or hides the section when there are no children). */
export function buildCollege(): void {
  const d = app.d;
  const col = d.p.assumptions.college;
  $('college').hidden = !d.children.length;
  $('nav-college').hidden = !d.children.length;
  $('kids').innerHTML = d.children.map((c, k) => {
    const tl = d.timelines[k];
    const id = esc(c.id);
    return `<div class="panel kid" id="kid-${id}">
      <div><h3>${esc(c.name)}</h3><p class="small muted">age ${c.age} · graduates high school ${
        esc(tl.graduation)} · 529 today ${fmt(c.college_529.balance)}${
        c.note ? ` · ${esc(c.note)}` : ''}</p></div>
      <div class="row"><span>Monthly contribution</span><span><span class="num" id="kc-${id}"></span>
        <a class="small" href="#budget">set in Budgeting › Savings</a></span></div>
      <div style="display:grid;gap:6px"><span class="eyebrow">School</span><div class="seg"
        data-f="school">${Object.entries(col.schools).map(([key, s]) =>
          `<button type="button" data-v="${esc(key)}">${esc(s.name)}</button>`).join('')}</div></div>
      <div class="ctl"><label for="ky-${id}">Cost per year today</label><input class="amt"
        id="ky-${id}" type="number" step="1000" inputmode="decimal"></div>
      <fieldset class="scen"><legend class="eyebrow">Return &amp; college cost inflation</legend>
        <div class="presets" id="kp-${id}"></div>
        <div class="ctl"><label for="kr-${id}">Investment return</label><span class="num"
          id="krv-${id}"></span><input type="range" id="kr-${id}" min="0" max="10" step="0.5"></div>
        <div class="ctl"><label for="ki-${id}">College cost inflation</label><span class="num"
          id="kiv-${id}"></span><input type="range" id="ki-${id}" min="0" max="8" step="0.5"></div>
        <span class="small muted">Pick a preset to set both sliders, then fine-tune.</span>
      </fieldset>
      <div class="out" id="ko-${id}"></div>
    </div>`;
  }).join('');
  d.children.forEach((c) => {
    const cs = () => app.S.cs[c.id];
    const card = $(`kid-${c.id}`);
    $in(`ky-${c.id}`).addEventListener('input', (e) => {
      cs().cost = num(e.target as HTMLInputElement);
      changed();
    });
    $in(`kr-${c.id}`).addEventListener('input', (e) => {
      cs().ret = +(e.target as HTMLInputElement).value;
      changed();
    });
    $in(`ki-${c.id}`).addEventListener('input', (e) => {
      cs().inf = +(e.target as HTMLInputElement).value;
      changed();
    });
    card.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => {
      b.addEventListener('click', () => {
        cs().school = b.dataset.v!;
        cs().cost = col.schools[b.dataset.v!].cost;
        changed();
      });
    });
    marks.push(presetPicker($(`kp-${c.id}`), 'college', () => [cs().ret, cs().inf], (ret, inf) => {
      cs().ret = ret;
      cs().inf = inf;
      changed();
    }));
  });
  onChange(updateCollege);
  updateCollege();
}

//
// INTERNAL
//
const marks: Array<() => void> = [];

/** Refreshes every card's inputs and projection. */
function updateCollege(): void {
  const d = app.d;
  const col = d.p.assumptions.college;
  marks.forEach((mark) => mark());
  d.children.forEach((c, k) => {
    const s = app.S.cs[c.id];
    const m = budget(d, app.S.st).amt[`529:${c.id}`] ?? 0;
    const card = $(`kid-${c.id}`);
    $(`kc-${c.id}`).textContent = `${fmt(m)}/mo`;
    const ky = $in(`ky-${c.id}`);
    if (document.activeElement !== ky) ky.value = String(s.cost);
    $in(`kr-${c.id}`).value = String(s.ret);
    $(`krv-${c.id}`).textContent = `${s.ret}%`;
    $in(`ki-${c.id}`).value = String(s.inf);
    $(`kiv-${c.id}`).textContent = `${s.inf}%`;
    card.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === s.school));
    });
    const x = kidCalc(d, app.S, k);
    const cov = Math.round(x.pct * 100);
    $(`ko-${c.id}`).innerHTML = `
      <span class="eyebrow" style="grid-column:1/-1">Covered</span>
      <span class="big ${x.pct >= 1 ? 'pos' : ''}" style="grid-column:1/-1">${cov}%</span>
      <div class="meter ${x.pct >= 1 ? 'full' : ''}" style="grid-column:1/-1" role="img"
        aria-label="${cov} percent covered"><i style="width:${Math.min(100, x.pct * 100)}%"></i></div>
      <span>529 at graduation</span><span class="num">${fmt(x.bal)}</span>
      <span>${col.years}-year cost, ${esc(d.timelines[k].college_years)}</span><span class="num">${
        fmt(x.cost)}</span>
      <span><b>${x.gap >= 0 ? 'Surplus' : 'Shortfall'}</b></span><span class="num ${
        x.gap >= 0 ? 'pos' : 'neg'}"><b>${x.gap >= 0 ? '+' : ''}${fmt(x.gap)}</b></span>
      <span class="muted">…in today's dollars</span><span class="num muted">${
        x.gap >= 0 ? '+' : ''}${fmt(x.today)}</span>
      <span>Monthly needed to fully fund</span><span class="num">${fmt(x.need)}</span>
      <span class="small muted" style="grid-column:1/-1">${x.need > m ?
        `That's ${fmt(x.need - m)} more than ${fmt(m)}/mo.` :
        `${fmt(m)}/mo is enough for this scenario.`}</span>`;
  });
}
