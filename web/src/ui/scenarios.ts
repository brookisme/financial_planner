/**
 * @fileoverview Scenarios: save / update / delete / reset, compare two scenarios (summary cards
 * with collapsible details) and share scenarios as codes or files.
 *
 * License: BSD 3-Clause
 */

import {get, send} from '../api';
import {$, $in, app, changed, onChange} from '../app';
import {esc, fmt} from '../format';
import {clone, compact, diffSettings, expand, rebase, results, type ResultRow,
        type SettingDiff} from '../model';
import type {Scenario, Settings} from '../types';
import {fillFuture} from './future';
import {fillPlanner} from './planner';
import {fillRetire} from './retire';

//
// CONSTANTS
//
const CODE_PREFIX = 'FP1:';

//
// PUBLIC
//

/** Loads saved scenarios and wires the bar. */
export async function buildScenarios(): Promise<void> {
  const saved = await get<{scenarios?: {list?: Scenario[]; active?: string|null}}>('/api/state');
  scen = {list: saved.scenarios?.list ?? [], active: saved.scenarios?.active ?? null};
  wireBar();
  wireShare();
  wireCompare();
  onChange(touch);
  renderBar();
}

//
// INTERNAL
//
let scen: {list: Scenario[]; active: string|null} = {list: [], active: null};
let pendingSwitch: string|null = null;
let pendingDel = false;
let pendingReset = false;
const cmpOpen = new Set<string>();

/** Current settings as a plain snapshot. */
const snap = (): Settings => clone(app.S);

/** A scenario's settings on top of the current defaults. */
const settingsOf = (x: Scenario): Settings => rebase(app.defs, x, x.base);

/** The scenario being shown, if any. */
const activeSc = (): Scenario|null => scen.list.find((x) => x.id === scen.active) ?? null;

/** Random-enough id for scenarios. */
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Saves the scenario list to the plan folder. */
function scSave(): void {
  send('PUT', '/api/state/scenarios', scen).catch(() => {});
}

/** Whether the current settings differ from a scenario. */
function dirtyFrom(x: Scenario): boolean {
  return diffSettings(app.d, settingsOf(x), snap()).length > 0;
}

/** Loads settings onto the page. */
function applyState(S: Settings): void {
  app.S = clone(S);
  fillPlanner();
  fillRetire();
  fillFuture();
  changed();
}

/** Refreshes the bar after any change and cancels pending confirmations. */
function touch(): void {
  pendingSwitch = null;
  pendingDel = false;
  pendingReset = false;
  renderBar();
}

/** Scenario tabs, state line and button labels. */
function renderBar(): void {
  const a = activeSc();
  const dirty = a ? dirtyFrom(a) : null;
  const tabs = $('sb-tabs');
  tabs.innerHTML = scen.list.length ? scen.list.map((x) => `<button type="button" class="chip"
      data-id="${esc(x.id)}" aria-pressed="${x.id === scen.active}">${esc(x.name)}${
      x.id === scen.active && dirty ? ' •' : ''}</button>`).join('') :
      '<span class="small muted">No saved scenarios yet. Name your current settings and save them.</span>';
  $('sb-state').textContent = pendingSwitch ?
      'Unsaved changes will be lost. Click the tab again to switch.' :
      a ? (dirty ? `Unsaved changes to "${a.name}"` : `Showing "${a.name}"`) :
      'Current settings (not saved as a scenario)';
  const up = $('sb-update') as HTMLButtonElement;
  up.hidden = !a;
  up.textContent = a ? `Update "${a.name}"` : 'Update';
  up.disabled = !!a && !dirty;
  const del = $('sb-del');
  del.hidden = !a;
  del.textContent = pendingDel ? 'Click again to delete' : 'Delete';
  $('sb-reset').textContent = pendingReset ? 'Click again to reset' : 'Reset everything';
  const cmp = $('sb-cmp') as HTMLButtonElement;
  cmp.disabled = scen.list.length === 0;
  cmp.title = scen.list.length ? '' : 'Save a scenario first';
  tabs.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.id!;
      if (id === scen.active) return;
      const cur = activeSc();
      const dirtyNow = cur ? dirtyFrom(cur) :
          !scen.list.some((x) => !dirtyFrom(x)) && diffSettings(app.d, app.defs, snap()).length > 0;
      if (dirtyNow && pendingSwitch !== id) {
        pendingSwitch = id;
        renderBar();
        return;
      }
      pendingSwitch = null;
      scen.active = id;
      scSave();
      applyState(settingsOf(scen.list.find((x) => x.id === id)!));
    });
  });
  renderCompare();
  renderShare();
}

/** Save / update / delete / reset buttons. */
function wireBar(): void {
  const bar = $('scenarios');
  // Edits inside the bar must not count as page edits (that would cancel confirmations).
  bar.addEventListener('input', (e) => e.stopPropagation());
  $('sb-save').addEventListener('click', () => {
    const inp = $in('sb-name');
    const name = inp.value.trim() || `Scenario ${scen.list.length + 1}`;
    const x: Scenario = {id: newId(), name, saved: new Date().toISOString(), ...snap(),
      base: clone(app.defs)};
    scen.list.push(x);
    scen.active = x.id;
    inp.value = '';
    scSave();
    renderBar();
  });
  $in('sb-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('sb-save').click();
  });
  $('sb-update').addEventListener('click', () => {
    const a = activeSc();
    if (!a) return;
    Object.assign(a, snap(), {saved: new Date().toISOString(), base: clone(app.defs)});
    scSave();
    renderBar();
  });
  $('sb-del').addEventListener('click', () => {
    if (!pendingDel) {
      pendingDel = true;
      renderBar();
      return;
    }
    pendingDel = false;
    scen.list = scen.list.filter((x) => x.id !== scen.active);
    scen.active = null;
    scSave();
    renderBar();
  });
  $('sb-reset').addEventListener('click', () => {
    if (!pendingReset) {
      pendingReset = true;
      renderBar();
      return;
    }
    pendingReset = false;
    scen.active = null;
    scSave();
    applyState(app.defs);
  });
  bar.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      if ($(b.dataset.close!).getAttribute('aria-expanded') === 'true') openPanel(b.dataset.close!);
    });
  });
  $('sb-cmp').addEventListener('click', () => openPanel('sb-cmp'));
  $('sb-share-btn').addEventListener('click', () => openPanel('sb-share-btn'));
}

/** Opens one of the two panels (and closes the other). */
function openPanel(btnId: string): void {
  [['sb-cmp', 'sb-compare'], ['sb-share-btn', 'sb-share']].forEach(([b, pnl]) => {
    const open = b === btnId && $(pnl).hidden;
    $(pnl).hidden = !open;
    $(b).setAttribute('aria-expanded', String(open));
  });
  $('sh-msg').textContent = '';
  renderShare();
  renderCompare();
}

// ---------- compare ----------

/** Compare selectors and the details toggles. */
function wireCompare(): void {
  ['cmp-a', 'cmp-b'].forEach((id) => $(id).addEventListener('change', renderCompare));
  $('cmp-cards').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-det]') as HTMLElement|null;
    if (!b) return;
    const k = b.dataset.det!;
    if (cmpOpen.has(k)) cmpOpen.delete(k);
    else cmpOpen.add(k);
    renderCompare();
    (document.querySelector(`[data-det="${k}"]`) as HTMLElement|null)?.focus();
  });
}

/** The comparison: a summary card per section plus opened details. */
function renderCompare(): void {
  if ($('sb-compare').hidden) return;
  const d = app.d;
  const opts: Array<[string, string]> = [['current', 'Current settings'],
    ...scen.list.map((x) => [x.id, x.name] as [string, string])];
  ['cmp-a', 'cmp-b'].forEach((id, i) => {
    const sel = $(id) as HTMLSelectElement;
    const prev = sel.value;
    sel.innerHTML = opts.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('');
    sel.value = opts.some((o) => o[0] === prev) ? prev : (opts[i] ?? opts[0])[0];
  });
  const pick = (v: string) => v === 'current' ? snap() :
      settingsOf(scen.list.find((x) => x.id === v)!);
  const A = pick(($('cmp-a') as HTMLSelectElement).value);
  const B = pick(($('cmp-b') as HTMLSelectElement).value);
  const nameOf = (id: string) => esc(opts.find((o) => o[0] === ($(id) as HTMLSelectElement)
      .value)![1]);
  const nA = nameOf('cmp-a');
  const nB = nameOf('cmp-b');
  const ra = results(d, A);
  const rb = results(d, B);
  type Row = {lbl: string; a: number; b: number; d: number; good: number; kind?: string};
  const show = (v: number, kind?: string) => Number.isNaN(v) ? '–' :
      kind === 'age' || kind === 'year' ? String(v) : kind === 'pct' ? `${v}%` : fmt(v);
  const same = (x: number) => Number.isNaN(x) || Math.abs(x) < 0.5;
  const dStr = (x: number, kind?: string) => same(x) ? '–' :
      (kind === 'age' || kind === 'year') ? `${x > 0 ? '+' : '−'}${Math.abs(x)} yr${
          Math.abs(x) === 1 ? '' : 's'}` :
      kind === 'pct' ? `${x > 0 ? '+' : '−'}${Math.abs(x)} pts` :
      `${x > 0 ? '+' : '−'}${fmt(Math.abs(x))}`;
  const dCls = (x: number, good: number) => same(x) || !good ? '' : x * good > 0 ? 'pos' : 'neg';
  const SEC: Record<string, string> = {'Monthly budget today': 'budget',
    'Before retirement': 'budget', 'College 529s': 'college', 'Retirement': 'retire'};
  const rows: Record<string, Array<Row|{head: string}>> = {budget: [], college: [], retire: []};
  const R: Record<string, Row> = {};
  let sec = 'budget';
  ra.forEach((row: ResultRow, i) => {
    if (row[1] === null) {
      sec = SEC[row[0]] ?? sec;
      rows[sec].push({head: row[0]});
      return;
    }
    const b = rb[i][1] as number;
    const r: Row = {lbl: row[0], a: row[1], b, d: b - row[1], good: row[2] ?? 0, kind: row[3]};
    rows[sec].push(r);
    R[r.lbl] = r;
  });
  const diffs = diffSettings(d, A, B);
  const dif: Record<string, SettingDiff[]> = {budget: [], college: [], retire: []};
  diffs.forEach((x) => {
    dif[x[4]].push(x);
    if (x[3][0] === 'st' && x[3][1] === 'sav' && x[3][2].startsWith('529:')) dif.college.push(x);
  });
  const money = (x: number, more: string, less: string) =>
      `${fmt(Math.abs(x))}/mo ${x > 0 ? more : less}`;
  const sumB: string[] = [];
  const nPlan = dif.budget.filter((x) => x[3][1] === 'plan').length;
  const dSp = R['Spending (net)'].d;
  if (nPlan || !same(dSp)) {
    sumB.push((nPlan ? `${nPlan} spending categor${nPlan === 1 ? 'y' : 'ies'} changed` +
        (same(dSp) ? ', same total' : ': ') : '') +
        (same(dSp) ? '' : `<b>${money(dSp, 'more spending', 'less spending')}</b>`));
  }
  const inv = R.Investing;
  if (!same(inv.d)) {
    sumB.push(`<b>${money(inv.d, 'more invested', 'less invested')}</b> (${fmt(inv.a)} → ${
        fmt(inv.b)})`);
  }
  const sv = R.Savings;
  if (!same(sv.d)) sumB.push(money(sv.d, 'more saved', 'less saved'));
  const inc = R['Take-home income'];
  if (!same(inc.d)) sumB.push(money(inc.d, 'more take-home income', 'less take-home income'));
  const tx = R['Tax set-aside'];
  if (!same(tx.d)) sumB.push(money(tx.d, 'more set aside for taxes', 'less set aside for taxes'));
  const listed = (list: SettingDiff[], n = 3) => list.slice(0, n)
      .map(([l, a, b]) => `${esc(l)}: ${esc(a)} → ${esc(b)}`)
      .concat(list.length > n ? [`and ${list.length - n} more, in the details`] : []);
  const tile = (lbl: string, r: Row, sub = '') => `<div class="cmp-tile"><span class="eyebrow">${
      esc(lbl)}</span>` + (same(r.d) ?
      `<span class="big muted">same</span><span class="small muted">${show(r.a, r.kind)}${
          sub ? ` · ${sub}` : ''}</span>` :
      `<span class="big num ${dCls(r.d, r.good)}">${dStr(r.d, r.kind)}</span><span class="small muted">${
          show(r.a, r.kind)} → ${show(r.b, r.kind)}${sub ? ` · ${sub}` : ''}</span>`) + '</div>';
  const saveR: Row = {lbl: '', a: sv.a + inv.a, b: sv.b + inv.b, d: sv.d + inv.d, good: 0};
  const kidTiles = d.children.map((c) => {
    const cov = R[`${c.name}: share of college covered`];
    const g = R[`${c.name}: surplus / shortfall, today's $`];
    return tile(`${c.name} covered`, cov, same(g.d) ? '' :
        `${g.b < 0 ? 'shortfall' : 'surplus'} ${g.d > 0 ? '+' : '−'}${fmt(Math.abs(g.d))} in today’s $`);
  }).join('');
  const ageRow = R[`Retirement age (${d.primary.name})`];
  const tiles: Record<string, string> = {
    budget: tile('Left over / month', R['Left over each month']) +
        tile('Spending / month', R['Spending (net)']) + tile('Saved + invested', saveR),
    college: kidTiles || '<p class="small muted">No children in this plan.</p>',
    retire: tile('At retirement', R['Gap / surplus at retirement'], 'surplus or gap / mo') +
        tile('Long run', R['Gap / surplus, long run'], 'once all Social Security starts') +
        (same(ageRow.d) ? tile('Income after tax', R['Income after tax, at retirement']) :
            tile('Retirement age', ageRow)),
  };
  const sums: Record<string, string[]> = {budget: sumB, college: listed(dif.college),
    retire: listed(dif.retire)};
  const titles: Record<string, string> = {budget: 'Monthly budget', college: 'College 529s',
    retire: 'Retirement'};
  const keys = ['budget', 'college', 'retire'].filter((k) => k !== 'college' || d.children.length);
  const resTable = (list: Array<Row|{head: string}>) => `<div class="ptable-scroll"><table
    class="rtable cmp"><tr><th>Result</th><th>${nA}</th><th>${nB}</th><th>Difference</th></tr>` +
      list.map((r) => 'head' in r ? `<tr class="grp"><td colspan="4">${esc(r.head)}</td></tr>` :
          `<tr><td>${esc(r.lbl)}</td><td>${show(r.a, r.kind)}</td><td>${show(r.b, r.kind)}</td><td class="${
              dCls(r.d, r.good)}">${dStr(r.d, r.kind)}</td></tr>`).join('') + '</table></div>';
  const setTable = (list: SettingDiff[]) => list.length ? `<div class="ptable-scroll"><table
    class="rtable cmp"><tr><th>Setting</th><th>${nA}</th><th>${nB}</th></tr>` +
      list.map(([l, a, b]) => `<tr><td>${esc(l)}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`)
          .join('') + '</table></div>' : '<p class="small muted">No settings differ here.</p>';
  $('cmp-note').innerHTML = diffs.length ?
      `<span><b>${diffs.length}</b> setting${diffs.length === 1 ? '' : 's'} differ.</span><span>Differences show <b>${
          nB}</b> compared with <b>${nA}</b>. Green is better, red is worse.</span>` :
      '<span>These two have the same settings.</span>';
  $('cmp-cards').style.gridTemplateColumns = `repeat(${keys.length},minmax(0,1fr))`;
  $('cmp-cards').innerHTML = keys.map((k) => {
    const n = dif[k].length;
    const on = cmpOpen.has(k);
    return `<div class="cmp-card${on ? ' open' : ''}"><div class="cmp-head"><h3>${titles[k]}</h3><span
      class="cmp-tools"><span class="cmp-count ${n ? 'on' : ''}">${n ? `${n} change${
        n === 1 ? '' : 's'}` : 'no changes'}</span><button class="btn toggle" type="button"
        data-det="${k}" aria-expanded="${on}" aria-controls="cmp-det-${k}">Details</button></span></div>` +
        (sums[k].length ? `<ul class="cmp-sum">${sums[k].map((x) => `<li>${x}</li>`).join('')}</ul>` :
            '') + `<div class="cmp-tiles">${tiles[k]}</div></div>`;
  }).join('');
  $('cmp-dets').innerHTML = keys.filter((k) => cmpOpen.has(k)).map((k) => `<div class="cmp-det"
    id="cmp-det-${k}"><h3>${titles[k]}: details</h3><h4>Results</h4>${resTable(rows[k])}<h4>Settings that differ</h4>${
      setTable(dif[k])}</div>`).join('');
}

// ---------- share ----------

/** What "send" sends: the active scenario, or the current settings if edited / unsaved. */
function sendable(): Scenario {
  const a = activeSc();
  if (a && !dirtyFrom(a)) return {...a, ...settingsOf(a)};
  const name = a ? `${a.name} (edited)` : ($in('sb-name').value.trim() || 'Shared settings');
  return {id: a ? a.id : newId(), name, saved: new Date().toISOString(), ...snap()};
}

/** Share code for scenarios. */
function shareCode(list: Scenario[]): string {
  const json = JSON.stringify({s: list.map((x) => compact(app.d, x))});
  return CODE_PREFIX + btoa(unescape(encodeURIComponent(json)));
}

/** Parses a share code or a scenario / backup file. */
function parseIncoming(text: string): Scenario[] {
  const t = text.trim();
  const data = t.startsWith(CODE_PREFIX) ?
      JSON.parse(decodeURIComponent(escape(atob(t.slice(CODE_PREFIX.length).replace(/\s+/g, ''))))) :
      JSON.parse(t);
  if (Array.isArray(data.s)) {
    return data.s.map((c: {id?: string; name?: string; saved?: string;
                           d?: Array<[string[], unknown]>}) => ({
      id: c.id || newId(), name: c.name || 'Shared scenario',
      saved: c.saved || new Date().toISOString(), ...expand(app.d, c), base: clone(app.defs)}));
  }
  if (Array.isArray(data.scenarios)) {
    return data.scenarios.map((x: Scenario) => ({...x, id: x.id || newId()}));
  }
  throw new Error('not a scenario');
}

/** Adds incoming scenarios; a known id is updated if the incoming copy is newer. */
function addIncoming(list: Scenario[]): string {
  const added: string[] = [];
  const updated: string[] = [];
  let unchanged = 0;
  list.forEach((x) => {
    const have = scen.list.find((y) => y.id === x.id);
    if (have) {
      if ((x.saved || '') > (have.saved || '')) {
        Object.assign(have, x);
        updated.push(have.name);
        if (have.id === scen.active) applyState(settingsOf(have));
      } else {
        unchanged++;
      }
      return;
    }
    let n = x.name;
    let k = 2;
    while (scen.list.some((y) => y.name === n)) n = `${x.name} (${k++})`;
    scen.list.push({...x, name: n});
    added.push(n);
  });
  scSave();
  renderBar();
  const parts = [];
  if (added.length) parts.push(`Added ${added.map((n) => `"${n}"`).join(', ')}`);
  if (updated.length) {
    parts.push(`Updated ${updated.map((n) => `"${n}"`).join(', ')} with the newer version`);
  }
  if (unchanged) parts.push(`${unchanged} already up to date`);
  return `${parts.join('. ')}.`;
}

/** Fills the "send" side of the share panel. */
function renderShare(): void {
  if ($('sb-share').hidden) return;
  const x = sendable();
  const a = activeSc();
  $('sh-what').textContent = a && x.name === a.name ? `"${a.name}"` :
      a ? `"${a.name}" with your unsaved changes` : 'your current settings (not saved as a scenario)';
  ($('sh-code') as HTMLTextAreaElement).value = shareCode([x]);
}

/** Triggers a file download. */
function download(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Share panel buttons. */
function wireShare(): void {
  const msg = $('sh-msg');
  $('sh-copy').addEventListener('click', () => {
    renderShare();
    const ta = $('sh-code') as HTMLTextAreaElement;
    const fallback = () => {
      ta.focus();
      ta.select();
      msg.textContent = 'The code is selected. Press Cmd+C (or Ctrl+C) to copy it.';
    };
    try {
      navigator.clipboard.writeText(ta.value).then(() => {
        msg.textContent = 'Copied. Paste it into a message or email.';
      }, fallback);
    } catch {
      fallback();
    }
  });
  $('sh-file').addEventListener('click', () => {
    const x = sendable();
    const slug = x.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
    download(`scenario-${slug}.json`, JSON.stringify({app: 'financial-planner',
      s: [compact(app.d, x)]}, null, 2));
    msg.textContent = `Saved scenario-${slug}.json. Attach it to a message or email.`;
  });
  $('sh-all').addEventListener('click', () => {
    download('financial-planner-scenarios.json', JSON.stringify({app: 'financial-planner',
      version: 1, exported: new Date().toISOString(), scenarios: scen.list}, null, 2));
    msg.textContent = `Backed up ${scen.list.length} scenario${scen.list.length === 1 ? '' : 's'}.`;
  });
  $('sh-add').addEventListener('click', () => {
    const ta = $('sh-paste') as HTMLTextAreaElement;
    try {
      msg.textContent = addIncoming(parseIncoming(ta.value));
      ta.value = '';
    } catch {
      msg.textContent = `That doesn't look like a share code. It should start with ${
          CODE_PREFIX} and be pasted in full.`;
    }
  });
  $in('sh-open').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    Promise.all(files.map((f) => f.text())).then((texts) => {
      msg.textContent = addIncoming(texts.flatMap(parseIncoming));
    }).catch(() => {
      msg.textContent = "One of those files isn't a scenario file.";
    });
    input.value = '';
  });
}
