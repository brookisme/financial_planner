/**
 * @fileoverview Categorizing transactions: the rule dialog (opened from a transaction or as a new
 * rule) and the Settings > Categorize tab with the full, sortable transaction table and the rule
 * list.
 *
 * License: BSD 3-Clause
 */

import {ApiError, get, send} from '../api';
import {saveNow} from '../app';
import {esc, fmt} from '../format';
import type {Category} from '../types';

//
// CONSTANTS
//
const PREVIEW_DELAY_MS = 250;
const MAX_TABLE_ROWS = 1500;
const KINDS: Array<[string, string]> = [['spending', 'Regular spending'],
  ['one_time', 'One-time cost'], ['credit', 'Credit (money in)'], ['ignore', 'Ignore (transfer, pay)']];

//
// PUBLIC
//

/** A transaction row from /api/transactions. */
export interface TxRow {
  id: string;
  date: string;
  description: string;
  amount: number;
  source: string;
  bank_category: string;
  category: string;
  how: 'row'|'rule'|'bank'|'default';
  rule: number|null;
  in_window: boolean;
  raw: Record<string, string>;
}

/** A rule as stored in the config. */
export type RuleDict = Record<string, unknown> & {category: string};

/** What /api/transactions returns. */
export interface TxData {
  rows: TxRow[];
  rules: RuleDict[];
  categories: Category[];
  sources: string[];
  months: string[];
}

/** Fetches every transaction with its category. */
export async function loadTx(): Promise<TxData> {
  txData = await get<TxData>('/api/transactions');
  return txData;
}

/**
 * Opens the rule dialog.
 * @param txId A transaction to start from, or null for a blank rule.
 * @param onSaved Called after saving; defaults to reloading the page.
 */
export async function openRuleDialog(txId: string|null,
                                     onSaved: () => void = reloadPage): Promise<void> {
  const data = txData ?? await loadTx();
  const tx = txId ? data.rows.find((r) => r.id === txId) ?? null : null;
  const dlg = document.getElementById('dlg') as HTMLDialogElement;
  const fields = ['description', 'category', 'source',
    ...(tx ? Object.keys(tx.raw) : [...new Set(data.rows.slice(0, 50)
        .flatMap((r) => Object.keys(r.raw)))])];
  const fieldOpts = (sel: string) => [...new Set(fields)].map((f) => `<option value="${esc(f)}"${
      f === sel ? ' selected' : ''}>${esc(f === 'category' ? "bank's category" : f)}</option>`)
      .join('');
  const guess = tx ? merchant(tx.description) : '';
  const howText = tx ? describeHow(tx, data) : '';
  dlg.innerHTML = `<form method="dialog" class="form" id="rule-form">
    <div class="dlg-head"><h3>${tx ? 'Categorize a transaction' : 'New rule'}</h3>
      <button class="btn sm" type="button" data-x>Close</button></div>
    <div class="dlg-body">
      ${tx ? `<div class="panel" style="padding:10px 12px;display:grid;gap:2px">
        <span class="mono">${esc(tx.date)} · ${esc(tx.source)}</span>
        <b>${esc(tx.description)}</b>
        <span class="small">${fmt(tx.amount, 2)} ${tx.amount < 0 ? '(money in)' : ''} · now
          <b>${esc(tx.category)}</b> <span class="muted">${esc(howText)}</span></span></div>` : ''}
      <label class="field"><span>Category</span><select id="rd-cat">${catOptions(data.categories,
        tx?.category)}<option value="__new">New category…</option></select></label>
      <div class="fgrid" id="rd-new" hidden>
        <label class="field"><span>New category name</span><input id="rd-new-name" type="text"></label>
        <label class="field"><span>Kind</span><select id="rd-new-kind">${KINDS.map(([k, l]) =>
          `<option value="${k}">${l}</option>`).join('')}</select></label>
      </div>
      <div class="ops" role="radiogroup" aria-label="Which transactions">
        ${tx ? `<label><input type="radio" name="op" value="row" checked><span class="opbody">
          <b>Just this transaction</b><span class="small muted">Always wins over other rules.</span>
          </span></label>` : ''}
        <label><input type="radio" name="op" value="contains"${tx ? '' : ' checked'}><span
          class="opbody"><b>Where a field contains text</b><span class="inline"><select
          id="rd-c-field">${fieldOpts('description')}</select> contains <input type="text"
          id="rd-c-text" value="${esc(guess)}"></span></span></label>
        <label><input type="radio" name="op" value="any"><span class="opbody"><b>Where any field
          contains text</b><span class="inline"><input type="text" id="rd-a-text" value="${
          esc(guess)}"></span></span></label>
        <label><input type="radio" name="op" value="matches"><span class="opbody"><b>Where a field
          matches a pattern</b><span class="inline"><select id="rd-m-field">${
          fieldOpts('description')}</select> matches <input type="text" id="rd-m-text" value="${
          esc(guess ? `^${guess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : '')}"></span><span
          class="small muted">A regular expression, e.g. <span class="mono">COFFEE|CAFE</span>.
          Case is ignored.</span></span></label>
        <label><input type="radio" name="op" value="similar"><span class="opbody"><b>Similar to
          ${tx ? "this transaction's" : 'some text in a'} field</b><span class="inline"><select
          id="rd-s-field">${fieldOpts('description')}</select>${tx ? '' :
          ' similar to <input type="text" id="rd-s-text">'} at least <input type="number"
          id="rd-s-thr" min="50" max="100" step="5" value="85" style="width:64px">% alike</span><span
          class="small muted">Ignores store numbers and codes, e.g. "STORE #401" and
          "STORE #988".</span></span></label>
      </div>
      <details><summary class="small">Only some transactions (optional)</summary>
        <div class="fgrid" style="margin-top:8px">
          <label class="field"><span>Source</span><select id="rd-src"><option value="">Any</option>${
            data.sources.map((s) => `<option>${esc(s)}</option>`)
            .join('')}</select></label>
          <label class="field"><span>Direction</span><select id="rd-dir"><option value="">Money in or
            out</option><option value="debit">Money out</option><option value="credit">Money in
            </option></select></label>
          <label class="field"><span>Smallest amount</span><input id="rd-min" type="number"
            step="1"></label>
          <label class="field"><span>Largest amount</span><input id="rd-max" type="number"
            step="1"></label>
        </div></details>
      <div class="pv" id="rd-pv" aria-live="polite"></div>
      <p class="msg err" id="rd-err"></p>
    </div>
    <div class="dlg-foot"><button class="btn" type="button" data-x>Cancel</button><button
      class="btn primary" type="button" id="rd-save">Save rule</button></div></form>`;
  const $d = (id: string) => dlg.querySelector<HTMLInputElement>(`#${id}`)!;
  const op = () => (dlg.querySelector('input[name=op]:checked') as HTMLInputElement).value;
  const build = (): RuleDict|null => {
    const catSel = $d('rd-cat').value;
    const category = catSel === '__new' ? $d('rd-new-name').value.trim() : catSel;
    if (!category) return null;
    const r: RuleDict = {category};
    switch (op()) {
      case 'row': r.row = tx!.id; break;
      case 'contains': r.field = $d('rd-c-field').value; r.contains = $d('rd-c-text').value; break;
      case 'any': r.field = '*'; r.contains = $d('rd-a-text').value; break;
      case 'matches': r.field = $d('rd-m-field').value; r.matches = $d('rd-m-text').value; break;
      default: {
        const f = $d('rd-s-field').value;
        r.field = f;
        r.similar_to = tx ? fieldOf(tx, f) : $d('rd-s-text').value;
        r.threshold = Math.min(1, Math.max(0.5, (+$d('rd-s-thr').value || 85) / 100));
      }
    }
    if (op() !== 'row') {
      if ($d('rd-src').value) r.source = $d('rd-src').value;
      if ($d('rd-dir').value) r.direction = $d('rd-dir').value;
      if ($d('rd-min').value) r.min_amount = +$d('rd-min').value;
      if ($d('rd-max').value) r.max_amount = +$d('rd-max').value;
    }
    if (r.field === 'description') delete r.field;
    return r;
  };
  let timer = 0;
  const preview = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const r = build();
      const pv = $d('rd-pv');
      if (!r) {
        pv.innerHTML = '<span class="muted">Pick a category.</span>';
        return;
      }
      try {
        const res = await send<{matched: number; changed: number; blocked: number;
          sample: Array<{date: string; description: string; amount: number; category: string}>}>(
            'POST', '/api/rules/preview', {...r, category: r.category || 'x'});
        pv.innerHTML = `<b>Matches ${res.matched} transaction${res.matched === 1 ? '' : 's'}</b>${
            res.matched ? ` · ${res.changed} would change to ${esc(r.category)}` : ''}${
            res.blocked ? ` · ${res.blocked} pinned by "just this transaction" rules stay as they are` :
            ''}${res.sample.length ? `<table>${res.sample.map((s) => `<tr><td class="mono">${
            esc(s.date)}</td><td>${esc(s.description)}</td><td class="mono" style="text-align:right">${
            fmt(s.amount, 2)}</td><td class="muted">${esc(s.category)}</td></tr>`).join('')}</table>` :
            ''}`;
        $d('rd-err').textContent = '';
      } catch (err) {
        pv.innerHTML = '';
        $d('rd-err').textContent = (err as Error).message;
      }
    }, PREVIEW_DELAY_MS);
  };
  dlg.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('input', preview);
  dlg.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).id === 'rd-cat') {
      ($d('rd-new') as HTMLElement).hidden = $d('rd-cat').value !== '__new';
    }
    preview();
  });
  // Focusing an operation's text box selects that operation.
  dlg.querySelectorAll('.ops label').forEach((lab) => {
    lab.addEventListener('focusin', () => {
      (lab.querySelector('input[type=radio]') as HTMLInputElement).checked = true;
      preview();
    });
  });
  $d('rd-save').addEventListener('click', async () => {
    const r = build();
    if (!r) {
      $d('rd-err').textContent = 'Pick a category (or name the new one).';
      return;
    }
    try {
      if ($d('rd-cat').value === '__new') {
        await addCategory(r.category, $d('rd-new-kind').value);
      }
      await send('POST', '/api/rules', r);
      dlg.close();
      txData = null;
      onSaved();
    } catch (err) {
      $d('rd-err').textContent = err instanceof ApiError ? err.message : String(err);
    }
  });
  dlg.showModal();
  preview();
}

/**
 * Renders the Categorize tab.
 * @param root Element to render into.
 * @param markDirty Called when rules change (so the main page reloads on leaving settings).
 */
export async function renderCategorizeTab(root: HTMLElement, markDirty: () => void): Promise<void> {
  root.innerHTML = '<p class="muted">Loading transactions…</p>';
  let data: TxData;
  try {
    data = await loadTx();
  } catch (err) {
    root.innerHTML = `<p class="msg err">${esc((err as Error).message)}</p>`;
    return;
  }
  const refresh = () => {
    markDirty();
    renderCategorizeTab(root, markDirty);
  };
  root.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Transactions</h3><span class="btns"><button class="btn primary sm"
        type="button" id="ct-new">New rule</button></span></div>
      <p class="small muted">Click a transaction to set its category or turn it into a rule. Click
        a column heading to sort.</p>
      <div class="filters">
        <input type="search" id="ct-q" placeholder="Search description" aria-label="Search">
        <select id="ct-cat" aria-label="Category"><option value="">All categories</option>${
          data.categories.map((c) => `<option>${esc(c.name)}</option>`).join('')}</select>
        <select id="ct-src" aria-label="Source"><option value="">All sources</option>${
          data.sources.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
        <select id="ct-how" aria-label="Matched by"><option value="">Matched by anything</option>
          <option value="default">No rule (default)</option><option value="rule">A rule</option>
          <option value="row">Just-this-row rules</option><option value="bank">Bank category</option>
        </select>
        <label class="small" style="display:inline-flex;gap:6px;align-items:center"><input
          type="checkbox" id="ct-win" checked>Averaging window only</label>
        <span class="small muted" id="ct-count"></span>
      </div>
      <div class="tall"><table class="dtable" id="ct-table"><thead><tr>
        <th data-k="date">Date</th><th data-k="description">Description</th>
        <th data-k="source">Source</th><th data-k="amount" class="r">Amount</th>
        <th data-k="category">Category</th><th data-k="how">Set by</th></tr></thead>
        <tbody></tbody></table></div>
    </div>
    <div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Rules</h3><span class="small muted">Row rules always win; then the
        first match from the top.</span></div>
      <div class="tall" style="max-height:420px"><table class="dtable edit" id="ct-rules"><thead><tr>
        <th>#</th><th>When</th><th>Category</th><th class="r">Rows</th><th></th></tr></thead>
        <tbody></tbody></table></div>
      <p class="msg" id="ct-msg"></p>
    </div>`;
  const q = root.querySelector<HTMLInputElement>('#ct-q')!;
  const fCat = root.querySelector<HTMLSelectElement>('#ct-cat')!;
  const fSrc = root.querySelector<HTMLSelectElement>('#ct-src')!;
  const fHow = root.querySelector<HTMLSelectElement>('#ct-how')!;
  const fWin = root.querySelector<HTMLInputElement>('#ct-win')!;
  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    let rows = data.rows.filter((r) => (!fWin.checked || r.in_window) &&
        (!fCat.value || r.category === fCat.value) && (!fSrc.value || r.source === fSrc.value) &&
        (!fHow.value || r.how === fHow.value) &&
        (!needle || r.description.toLowerCase().includes(needle)));
    const k = sort.key as keyof TxRow;
    rows = rows.slice().sort((a, b) => {
      const x = a[k] as string|number;
      const y = b[k] as string|number;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(
          String(y));
      return sort.dir * c;
    });
    root.querySelector('#ct-count')!.textContent = `${rows.length} transaction${
        rows.length === 1 ? '' : 's'}${rows.length > MAX_TABLE_ROWS ? ` · first ${MAX_TABLE_ROWS} shown` : ''}`;
    root.querySelector('#ct-table tbody')!.innerHTML = rows.slice(0, MAX_TABLE_ROWS).map((r) =>
        `<tr data-id="${esc(r.id)}"><td class="d">${esc(r.date)}</td><td>${esc(r.description)}</td>
        <td>${esc(r.source)}</td><td class="r">${fmt(r.amount, 2)}</td><td>${esc(r.category)}</td>
        <td class="how">${esc(describeHow(r, data))}</td></tr>`).join('') ||
        '<tr><td colspan="6" class="muted">No transactions match.</td></tr>';
    root.querySelectorAll<HTMLElement>('#ct-table th').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.k === sort.key ?
          (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    });
  };
  [q, fCat, fSrc, fHow, fWin].forEach((el) => el.addEventListener('input', draw));
  root.querySelectorAll<HTMLElement>('#ct-table th').forEach((th) => {
    th.addEventListener('click', () => {
      sort = {key: th.dataset.k!, dir: sort.key === th.dataset.k ? -sort.dir as 1|-1 :
          (th.dataset.k === 'amount' || th.dataset.k === 'date' ? -1 : 1)};
      draw();
    });
  });
  root.querySelector('#ct-table tbody')!.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-id]') as HTMLElement|null;
    if (tr) openRuleDialog(tr.dataset.id!, refresh);
  });
  root.querySelector('#ct-new')!.addEventListener('click', () => openRuleDialog(null, refresh));
  drawRules(root, data, refresh);
  draw();
}

/** One-line description of a rule. */
export function describeRule(r: RuleDict): string {
  const f = (r.field as string|undefined) ?? 'description';
  const where = f === '*' ? 'any field' : f === 'category' ? "bank's category" : f;
  let s: string;
  if (r.row) s = 'this transaction only';
  else if (r.equals != null) s = `${where} is "${r.equals}"`;
  else if (r.contains != null) s = `${where} contains "${r.contains}"`;
  else if (r.matches != null) s = `${where} matches /${r.matches}/`;
  else s = `${where} is ${Math.round(((r.threshold as number|undefined) ?? 0.85) * 100)}% like "${
      r.similar_to}"`;
  const extra = [];
  if (r.source) extra.push(`from ${r.source}`);
  if (r.direction) extra.push(r.direction === 'debit' ? 'money out' : 'money in');
  if (r.min_amount != null) extra.push(`≥ ${fmt(r.min_amount as number)}`);
  if (r.max_amount != null) extra.push(`≤ ${fmt(r.max_amount as number)}`);
  return s + (extra.length ? ` (${extra.join(', ')})` : '');
}

/** Adds a category to the config if it isn't there yet. */
export async function addCategory(name: string, kind: string): Promise<void> {
  const cfg = await get<{raw: Record<string, unknown>}>('/api/config');
  const cats = (cfg.raw.categories as Array<Record<string, unknown>>|undefined) ?? [];
  if (cats.some((c) => c.name === name)) return;
  await send('PUT', '/api/config/categories', [...cats, {name, kind}]);
}

//
// INTERNAL
//
let txData: TxData|null = null;
let sort: {key: string; dir: 1|-1} = {key: 'date', dir: -1};

/** Save state and reload the page so every section uses the new categories. */
async function reloadPage(): Promise<void> {
  await saveNow().catch(() => {});
  sessionStorage.setItem('fp-scroll', String(window.scrollY));
  location.reload();
}

/** Category <option>s grouped by kind. */
function catOptions(cats: Category[], selected?: string): string {
  return KINDS.map(([k, l]) => {
    const list = cats.filter((c) => c.kind === k);
    return list.length ? `<optgroup label="${l}">${list.map((c) => `<option${
        c.name === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
}

/** A field's value on a transaction row (matches the server's Transaction.field). */
function fieldOf(tx: TxRow, f: string): string {
  if (f === 'description') return tx.description;
  if (f === 'category') return tx.bank_category;
  if (f === 'source') return tx.source;
  return tx.raw[f] ?? '';
}

/** A merchant-ish guess for prefilling "contains". */
function merchant(desc: string): string {
  return desc.replace(/^(SQ|TST|SP|DD|PB|EB|ACT|PAYPAL)\s*\*\s*/i, '').replace(/[*#].*$/, '')
      .replace(/\s+\d[\d\s-]*.*$/, '').trim().toUpperCase();
}

/** How a row got its category, in words. */
function describeHow(r: TxRow, data: TxData): string {
  if (r.how === 'row') return 'pinned by a just-this-row rule';
  if (r.how === 'rule' && r.rule != null) {
    return `rule ${r.rule + 1}: ${describeRule(data.rules[r.rule])}`;
  }
  if (r.how === 'bank') return `bank category "${r.bank_category}"`;
  return 'no rule matched (default)';
}

/** The rule list with move / delete. */
function drawRules(root: HTMLElement, data: TxData, refresh: () => void): void {
  const counts = new Map<number, number>();
  data.rows.forEach((r) => {
    if (r.rule != null) counts.set(r.rule, (counts.get(r.rule) ?? 0) + 1);
  });
  const body = root.querySelector('#ct-rules tbody')!;
  body.innerHTML = data.rules.map((r, i) => `<tr><td class="d">${i + 1}</td><td>${
      esc(describeRule(r))}</td><td>${esc(r.category)}</td><td class="r">${counts.get(i) ?? 0}</td>
      <td style="white-space:nowrap"><button class="btn sm" type="button" data-mv="${i}" data-by="-1"
        aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button> <button class="btn sm"
        type="button" data-mv="${i}" data-by="1" aria-label="Move down"${
        i === data.rules.length - 1 ? ' disabled' : ''}>↓</button> <button class="btn sm danger"
        type="button" data-del="${i}">Delete</button></td></tr>`).join('') ||
      '<tr><td colspan="5" class="muted">No rules yet.</td></tr>';
  const msg = root.querySelector('#ct-msg')!;
  const save = async (rules: RuleDict[]) => {
    try {
      await send('PUT', '/api/config/rules', rules);
      txData = null;
      refresh();
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = (err as Error).message;
    }
  };
  body.querySelectorAll<HTMLButtonElement>('[data-mv]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = +b.dataset.mv!;
      const j = i + +b.dataset.by!;
      const rules = data.rules.slice();
      [rules[i], rules[j]] = [rules[j], rules[i]];
      save(rules);
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
    let armed = false;
    b.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        b.textContent = 'Click again';
        return;
      }
      save(data.rules.filter((_, i) => i !== +b.dataset.del!));
    });
  });
}
