/**
 * @fileoverview Settings (the gear icon): a form-based editor for everything in the plan's YAML.
 * Each save goes straight to the config files through the server, which validates it first.
 *
 * License: BSD 3-Clause
 */

import {ApiError, get, send, upload} from '../api';
import {esc, fmt} from '../format';
import {renderCategorizeTab} from './categorize';

//
// CONSTANTS
//
const TABS: Array<[string, string]> = [['household', 'Household'], ['money', 'Savings & income'],
  ['assumptions', 'Assumptions'], ['sources', 'Data sources'], ['categories', 'Categories'],
  ['categorize', 'Categorize'], ['share', 'Share plan']];
const KINDS: Array<[string, string]> = [['spending', 'Regular'], ['one_time', 'One-time'],
  ['credit', 'Credit (money in)'], ['ignore', 'Ignore']];
const CLAIM_AGES = [62, 63, 64, 65, 66, 67, 68, 69, 70];

//
// PUBLIC
//

/** Whether a settings save happened since the page loaded (the main page then reloads). */
export function settingsDirty(): boolean {
  return dirty;
}

/**
 * Shows the settings view.
 * @param tab Tab id from the URL (#settings/<tab>).
 */
export async function showSettings(tab = 'household'): Promise<void> {
  current = TABS.some(([k]) => k === tab) ? tab : 'household';
  const root = document.getElementById('settings')!;
  root.innerHTML = '<p class="muted">Loading settings…</p>';
  try {
    cfg = await get<ConfigResponse>('/api/config');
  } catch (err) {
    root.innerHTML = `<p class="msg err">${esc((err as Error).message)}</p>`;
    return;
  }
  root.innerHTML = `<div class="sec-head"><h2 id="settings-title">Settings</h2>
      <a class="btn" href="#planner" style="text-decoration:none">Back to the budget</a></div>
    <p class="small muted">Plan folder <span class="mono">${esc(cfg.plan_dir)}</span>. Changes are
      saved to the YAML files in its <span class="mono">config</span> folder (you can also edit
      them by hand). Keep this folder private: it holds your financial data.</p>
    ${cfg.error ? `<div class="banner err"><b>The config has a problem.</b><span class="mono"
      style="white-space:pre-wrap">${esc(cfg.error)}</span><span class="small">Fix it here or in
      the YAML files. The rest of the app opens once it's valid.</span></div>` : ''}
    <nav class="stabs" role="tablist" aria-label="Settings sections">${TABS.map(([k, l]) =>
      `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === current}">${l}</button>`)
      .join('')}</nav>
    <div id="st-body" style="display:grid;gap:14px"></div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      location.hash = `#settings/${b.dataset.tab}`;
    });
  });
  renderTab();
}

//
// INTERNAL
//
type Dict = Record<string, unknown>;
interface ConfigResponse {
  raw: Dict;
  owners: Record<string, string>;
  error: string|null;
  plan_dir: string;
  files: string[];
}
let cfg: ConfigResponse;
let current = 'household';
let dirty = false;

/** Renders the current tab. */
function renderTab(): void {
  const body = document.getElementById('st-body')!;
  const render: Record<string, (el: HTMLElement) => void> = {
    household: renderHousehold, money: renderMoney, assumptions: renderAssumptions,
    sources: renderSources, categories: renderCategories, share: renderShare,
    categorize: (el) => renderCategorizeTab(el, () => {
      dirty = true;
    }),
  };
  render[current](body);
}

/** Saves one config section, then refreshes the settings data. */
async function save(section: string, value: unknown): Promise<void> {
  await send('PUT', `/api/config/${section}`, value);
  dirty = true;
  cfg = await get<ConfigResponse>('/api/config');
}

/** Shows a save result in a message element. */
function report(el: Element|null, err?: unknown, ok = 'Saved.'): void {
  if (!el) return;
  el.className = `msg ${err ? 'err' : 'ok'}`;
  el.textContent = err ? (err instanceof ApiError ? err.message : String(err)) : ok;
}

/** A config section as a copy (so edits don't touch cfg until saved). */
function section<T>(key: string, fallback: T): T {
  const v = cfg.raw[key];
  return v === undefined ? fallback : JSON.parse(JSON.stringify(v)) as T;
}

/** In which YAML file a section lives. */
function fileOf(key: string): string {
  return cfg.owners[key] ?? 'a new file';
}

// ---------- form helpers ----------

/** A labeled input bound to data-k. */
function input(k: string, label: string, value: unknown, type = 'text', hint = '',
               attrs = ''): string {
  const v = value === null || value === undefined ? '' : String(value);
  return `<label class="field"><span>${esc(label)}</span><input data-k="${esc(k)}" type="${type}"
    value="${esc(v)}" ${type === 'number' ? 'step="any" inputmode="decimal"' : ''} ${attrs}>${
    hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
}

/** A labeled checkbox bound to data-k. */
function check(k: string, label: string, value: unknown): string {
  return `<label class="field check"><input data-k="${esc(k)}" type="checkbox"${
      value ? ' checked' : ''}>${esc(label)}</label>`;
}

/** A labeled select bound to data-k. */
function select(k: string, label: string, options: Array<[string, string]>, value: unknown,
                hint = ''): string {
  return `<label class="field"><span>${esc(label)}</span><select data-k="${esc(k)}">${
      options.map(([v, l]) => `<option value="${esc(v)}"${String(value ?? '') === v ?
          ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${
      hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
}

/**
 * Reads data-k fields under root into a nested object ("a.b" keys nest). Numbers become numbers,
 * empty numbers are left out (so defaults apply), checkboxes become booleans.
 */
function readFields(root: Element): Dict {
  const out: Dict = {};
  root.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-k]').forEach((el) => {
    const list = el.closest('[data-list]');
    if (list && root.contains(list)) return;   // belongs to a list editor inside root
    const path = el.dataset.k!.split('.');
    let v: unknown;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked;
    else if (el instanceof HTMLInputElement && el.type === 'number') {
      if (el.value.trim() === '') return;
      v = +el.value;
    } else {
      v = el.value.trim();
      if (v === '' && el.dataset.optional !== undefined) return;
    }
    let cur = out;
    path.slice(0, -1).forEach((p) => cur = (cur[p] ??= {}) as Dict);
    cur[path[path.length - 1]] = v;
  });
  return out;
}

/** Rows of a list editor (each row is a data-row element). */
function readRows(root: Element, list: string): Dict[] {
  return [...root.querySelectorAll(`[data-list="${list}"] > [data-row]`)].map((row) =>
    readFields(row));
}

/** A list editor: rows built by rowHtml, an add button and remove buttons. */
function listEditor(list: string, rows: Dict[], rowHtml: (r: Dict) => string,
                    addLabel: string): string {
  return `<div class="listed" data-list="${list}">${rows.map((r) => `<div class="item"
    data-row>${rowHtml(r)}<button class="btn sm danger" type="button" data-rm>Remove</button></div>`)
    .join('')}</div><button class="btn sm add" type="button" data-add="${list}">${esc(addLabel)}</button>`;
}

/** Wires add / remove buttons for list editors under root. */
function wireLists(root: Element, templates: Record<string, () => string>): void {
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('[data-rm]')) t.closest('[data-row]')!.remove();
    const add = t.closest('[data-add]') as HTMLElement|null;
    if (add) {
      const list = root.querySelector(`[data-list="${add.dataset.add}"]`)!;
      const div = document.createElement('div');
      div.className = 'item';
      div.dataset.row = '';
      div.innerHTML = `${templates[add.dataset.add!]()}<button class="btn sm danger" type="button"
        data-rm>Remove</button>`;
      list.appendChild(div);
      (div.querySelector('input,select') as HTMLElement|null)?.focus();
    }
  });
}

/** Opens a form in the shared dialog; onSave returns a promise (errors are shown). */
function formDialog(title: string, html: string, onSave: (form: HTMLElement) => Promise<void>,
                    templates: Record<string, () => string> = {}): void {
  const dlg = document.getElementById('dlg') as HTMLDialogElement;
  dlg.innerHTML = `<div class="form"><div class="dlg-head"><h3>${esc(title)}</h3><button
      class="btn sm" type="button" data-x>Close</button></div><div class="dlg-body" id="fd-body">${
      html}<p class="msg" id="fd-msg"></p></div><div class="dlg-foot"><button class="btn"
      type="button" data-x>Cancel</button><button class="btn primary" type="button"
      id="fd-save">Save</button></div></div>`;
  const body = dlg.querySelector<HTMLElement>('#fd-body')!;
  wireLists(body, templates);
  dlg.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.querySelector('#fd-save')!.addEventListener('click', async () => {
    try {
      await onSave(body);
      dlg.close();
      renderTab();
    } catch (err) {
      report(dlg.querySelector('#fd-msg'), err);
    }
  });
  dlg.showModal();
}

/** A two-click remove button handler. */
function confirmClick(b: HTMLButtonElement, action: () => void): void {
  let armed = false;
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = 'Click again to remove';
      return;
    }
    action();
  });
}

// ---------- household ----------

/** Partners and children. */
function renderHousehold(el: HTMLElement): void {
  const hh = section<{partners?: Dict[]; children?: Dict[]}>('household', {});
  const partners = hh.partners ?? [];
  const children = hh.children ?? [];
  const money = (v: unknown) => fmt(+(v as number) || 0);
  el.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Partners</h3><span class="small muted">Saved in ${
        esc(fileOf('household'))}. The first partner's age drives the retirement slider.</span></div>
      <div class="cards">${partners.map((p, i) => `<div class="card"><div class="card-head"><b>${
        esc(p.name)}</b><span class="small muted">age ${esc(p.age)}</span></div>
        <div class="row"><span>Take-home / mo</span><span class="num">${money(p.take_home_monthly)}</span></div>
        <div class="row"><span>Social Security at 67</span><span class="num">${
          money((p.social_security as Dict|undefined)?.at_67)}</span></div>
        <div class="small muted">${((p.pensions as unknown[]) ?? []).length} pension(s), ${
          ((p.accounts as unknown[]) ?? []).length} retirement account(s)</div>
        <div class="card-actions"><button class="btn sm" type="button" data-edit-p="${i}">Edit</button>${
          partners.length > 1 ? `<button class="btn sm danger" type="button" data-rm-p="${i}">Remove</button>` : ''}</div>
        </div>`).join('')}
        <button class="card btn add" type="button" id="add-partner" style="place-content:center;min-height:120px">+ Add partner</button></div>
    </div>
    <div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Children</h3><span class="small muted">Each child gets a 529 card.</span></div>
      <div class="cards">${children.map((c, i) => `<div class="card"><div class="card-head"><b>${
        esc(c.name)}</b><span class="small muted">age ${esc(c.age)}</span></div>
        <div class="row"><span>529 balance</span><span class="num">${
          money((c.college_529 as Dict|undefined)?.balance)}</span></div>
        <div class="row"><span>529 per month</span><span class="num">${
          money((c.college_529 as Dict|undefined)?.monthly)}</span></div>
        <div class="card-actions"><button class="btn sm" type="button" data-edit-c="${i}">Edit</button><button
          class="btn sm danger" type="button" data-rm-c="${i}">Remove</button></div></div>`).join('')}
        <button class="card btn add" type="button" id="add-child" style="place-content:center;min-height:120px">+ Add child</button></div>
    </div><p class="msg" id="hh-msg"></p>`;
  const msg = el.querySelector('#hh-msg');
  const saveHH = async () => save('household', {...hh, partners, children});
  el.querySelector('#add-partner')!.addEventListener('click', () => partnerForm(null, partners,
      saveHH));
  el.querySelector('#add-child')!.addEventListener('click', () => childForm(null, children, saveHH));
  el.querySelectorAll<HTMLButtonElement>('[data-edit-p]').forEach((b) => b.addEventListener(
      'click', () => partnerForm(+b.dataset.editP!, partners, saveHH)));
  el.querySelectorAll<HTMLButtonElement>('[data-edit-c]').forEach((b) => b.addEventListener(
      'click', () => childForm(+b.dataset.editC!, children, saveHH)));
  el.querySelectorAll<HTMLButtonElement>('[data-rm-p]').forEach((b) => confirmClick(b, () => {
    partners.splice(+b.dataset.rmP!, 1);
    saveHH().then(() => renderTab(), (err) => report(msg, err));
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-rm-c]').forEach((b) => confirmClick(b, () => {
    children.splice(+b.dataset.rmC!, 1);
    saveHH().then(() => renderTab(), (err) => report(msg, err));
  }));
}

/** Text form of pension estimates: "55: 900, 60: 2800". */
function estimatesText(est: unknown): string {
  return Object.entries((est as Dict) ?? {}).map(([a, v]) => `${a}: ${v}`).join(', ');
}

/** Parses "55: 900, 60: 2800" into {55: 900, 60: 2800}. */
function parseEstimates(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  text.split(/[,;\n]/).forEach((part) => {
    const m = part.match(/^\s*(\d{2})\s*[:=]\s*\$?([\d,.]+)\s*$/);
    if (m) out[m[1]] = +m[2].replace(/,/g, '');
    else if (part.trim()) throw new Error(`Couldn't read "${part.trim()}". Use age: amount, e.g. 60: 2800`);
  });
  return out;
}

/** Add / edit a partner. */
function partnerForm(i: number|null, partners: Dict[], saveHH: () => Promise<void>): void {
  const p: Dict = i === null ? {name: `Partner ${String.fromCharCode(65 + partners.length)}`,
    age: 40} : partners[i];
  const ss = (p.social_security as Dict|undefined) ?? {};
  const pensionRow = (r: Dict = {}) => input('name', 'Pension name', r.name ?? 'Pension') +
      input('estimates', 'Estimates by age', estimatesText(r.estimates), 'text',
            'age: monthly, e.g. 55: 900, 60: 2800, 65: 5800') +
      input('monthly', 'Or a flat monthly amount', r.monthly, 'number') +
      input('service_years_now', 'Years of service today', r.service_years_now, 'number',
            'optional: grows the benefit after the last age');
  const accountRow = (r: Dict = {}) => input('name', 'Account', r.name ?? '401(k)') +
      input('balance', 'Balance today', r.balance ?? 0, 'number') +
      input('monthly', 'Added per month', r.monthly ?? 0, 'number');
  const html = `<div class="fgrid">
      ${input('name', 'Name', p.name, 'text', 'A generic name is safest, e.g. Partner A')}
      ${input('age', 'Age', p.age, 'number')}
      ${input('take_home_monthly', 'Take-home pay per month', p.take_home_monthly ?? 0, 'number')}
      ${input('take_home_note', 'Where that number came from', p.take_home_note ?? '', 'text', '',
              'data-optional')}
      ${input('raise_pct', 'Yearly raise above inflation (%)', p.raise_pct ?? 0, 'number')}
      ${input('social_security.at_67', 'Social Security at 67 (per month)', ss.at_67 ?? 0, 'number',
              'From the Social Security statement')}
      ${select('social_security.claim_age', 'Claims Social Security at', [['', 'When retiring (62+)'],
        ...CLAIM_AGES.map((a) => [String(a), String(a)] as [string, string])], ss.claim_age ?? '')}
    </div>
    <div class="subhead">Pensions</div>
    ${listEditor('pensions', (p.pensions as Dict[]) ?? [], pensionRow, '+ Add pension')}
    <div class="subhead">Retirement accounts</div>
    ${listEditor('accounts', (p.accounts as Dict[]) ?? [], accountRow, '+ Add account')}`;
  formDialog(i === null ? 'Add partner' : `Edit ${p.name}`, html, async (form) => {
    const top = readFields(form);
    const s = (top.social_security as Dict) ?? {};
    const next: Dict = {...(i === null ? {} : partners[i]), ...top,
      social_security: {at_67: s.at_67 ?? 0, ...(s.claim_age ? {claim_age: +(s.claim_age as string)} : {})},
      pensions: readRows(form, 'pensions').map((r) => {
        const out: Dict = {name: r.name, estimates: parseEstimates(String(r.estimates ?? ''))};
        if (r.monthly !== undefined) out.monthly = r.monthly;
        if (r.service_years_now !== undefined) out.service_years_now = r.service_years_now;
        return out;
      }),
      accounts: readRows(form, 'accounts')};
    if (!top.take_home_note) delete next.take_home_note;
    const list = partners.slice();
    if (i === null) list.push(next);
    else list[i] = next;
    partners.splice(0, partners.length, ...list);
    await saveHH();
  }, {pensions: () => pensionRow(), accounts: () => accountRow()});
}

/** Add / edit a child. */
function childForm(i: number|null, children: Dict[], saveHH: () => Promise<void>): void {
  const c: Dict = i === null ? {name: `Child ${children.length + 1}`, age: 5} : children[i];
  const col = (c.college_529 as Dict|undefined) ?? {};
  const schools = schoolOptions();
  const html = `<div class="fgrid">
      ${input('name', 'Name', c.name, 'text', 'A generic name is safest, e.g. Child 1')}
      ${input('age', 'Age', c.age, 'number')}
      ${input('hs_graduation', 'High school graduation (YYYY-MM)', c.hs_graduation ?? '', 'text',
              'Optional: estimated from age if empty', 'data-optional placeholder="2034-06"')}
      ${input('college_529.balance', '529 balance today', col.balance ?? 0, 'number')}
      ${input('college_529.monthly', '529 contribution per month', col.monthly ?? 0, 'number')}
      ${select('school', 'Planned school', schools, c.school ?? schools[0]?.[0])}
      ${input('note', 'Note for the card', c.note ?? '', 'text', '', 'data-optional')}
    </div>`;
  formDialog(i === null ? 'Add child' : `Edit ${c.name}`, html, async (form) => {
    const next = {...(i === null ? {} : children[i]), ...readFields(form)};
    if (!(next as Dict).hs_graduation) delete (next as Dict).hs_graduation;
    if (!(next as Dict).note) delete (next as Dict).note;
    const list = children.slice();
    if (i === null) list.push(next);
    else list[i] = next;
    children.splice(0, children.length, ...list);
    await saveHH();
  });
}

/** School choices from the config (or the built-in defaults). */
function schoolOptions(): Array<[string, string]> {
  const schools = ((cfg.raw.assumptions as Dict|undefined)?.college as Dict|undefined)?.schools as
      Record<string, Dict>|undefined;
  const list = schools ?? {public: {name: 'Public in-state'}, flagship: {name: 'Flagship in-state'},
    private: {name: 'Private'}};
  return Object.entries(list).map(([k, v]) => [k, String(v.name ?? k)]);
}

// ---------- money ----------

/** Other income, savings accounts and investments. */
function renderMoney(el: HTMLElement): void {
  const savings = section<Dict[]>('savings', []);
  const investments = section<Dict[]>('investments', []);
  const savRow = (r: Dict = {}) => input('name', 'Name', r.name ?? 'Savings') +
      input('monthly', 'Per month', r.monthly ?? 0, 'number') +
      check('stops_at_retirement', 'Stops at retirement', r.stops_at_retirement ?? true);
  const invRow = (r: Dict = {}) => input('name', 'Name', r.name ?? 'Brokerage') +
      input('balance', 'Balance today', r.balance ?? 0, 'number') +
      input('return_pct', 'Yearly return (%)', r.return_pct ?? 0, 'number') +
      input('monthly', 'Added per month', r.monthly ?? 0, 'number');
  el.innerHTML = `<div class="panel form">
      <h3>Other income</h3>
      <div class="fgrid">${input('other', 'Other take-home income per month',
        cfg.raw.other_income_monthly ?? 0, 'number')}</div>
      <h3>Savings</h3><p class="small muted">Money moved to savings every month. It shows in the
        planner's Savings box.</p>
      ${listEditor('savings', savings, savRow, '+ Add savings')}
      <h3>Investments</h3><p class="small muted">Brokerage or stock accounts. Each grows at its own
        return (0% = off) and becomes retirement income.</p>
      ${listEditor('investments', investments, invRow, '+ Add investment account')}
      <div class="btns"><button class="btn primary" type="button" id="m-save">Save</button></div>
      <p class="msg" id="m-msg"></p></div>`;
  wireLists(el, {savings: () => savRow(), investments: () => invRow()});
  el.querySelector('#m-save')!.addEventListener('click', async () => {
    const msg = el.querySelector('#m-msg');
    try {
      const other = (el.querySelector('[data-k="other"]') as HTMLInputElement).value;
      await save('other_income_monthly', +other || 0);
      await save('savings', mergeIds(savings, readRows(el, 'savings')));
      await save('investments', mergeIds(investments, readRows(el, 'investments')));
      report(msg);
    } catch (err) {
      report(msg, err);
    }
  });
}

/** Keeps the ids of rows that were already there (matched by position). */
function mergeIds(before: Dict[], after: Dict[]): Dict[] {
  return after.map((r, i) => before[i]?.id && before[i].name === r.name ?
      {id: before[i].id, ...r} : r);
}

// ---------- assumptions ----------

/** Titles, retirement and college assumptions. */
function renderAssumptions(el: HTMLElement): void {
  const plan = section<Dict>('plan', {});
  const asm = section<Dict>('assumptions', {});
  const ret = (asm.retirement as Dict) ?? {};
  const col = (asm.college as Dict) ?? {};
  const toRows = (o: unknown) => Object.entries((o as Record<string, Dict>) ?? {})
      .map(([key, v]) => ({key, ...v}));
  const presetRow = (r: Dict = {}) => input('key', 'Key', r.key ?? '') +
      input('name', 'Name', r.name ?? '') + input('return_pct', 'Return %', r.return_pct ?? 5,
                                                  'number') +
      input('inflation_pct', 'Inflation %', r.inflation_pct ?? 3, 'number');
  const schoolRow = (r: Dict = {}) => input('key', 'Key', r.key ?? '') +
      input('name', 'Name', r.name ?? '') + input('cost', 'Cost per year today', r.cost ?? 30000,
                                                  'number');
  el.innerHTML = `<div class="panel form"><h3>Plan</h3><div class="fgrid">
      ${input('plan.title', 'Title', plan.title ?? 'Household Budget')}
      ${input('plan.subtitle', 'Subtitle', plan.subtitle ?? '', 'text',
              'Empty: a line naming your data sources and months', 'data-optional')}
      ${input('plan.months', 'Months to average', plan.months ?? 12, 'number',
              'The most recent N months of transactions')}
      ${input('plan.last_month', 'Last month to average (YYYY-MM)', plan.last_month ?? '', 'text',
              'Empty: the month of the newest transaction', 'data-optional')}
      ${input('plan.today', 'Today (YYYY-MM)', plan.today ?? '', 'text',
              'Empty: the month after the averaging window', 'data-optional')}
      ${input('plan.currency_symbol', 'Currency symbol', plan.currency_symbol ?? '$')}</div>
    <h3>Retirement</h3><div class="fgrid">
      ${input('r.default_age', 'Starting retirement age', ret.default_age ?? 65, 'number')}
      ${input('r.return_pct', 'Investment return (%)', ret.return_pct ?? 5.5, 'number')}
      ${input('r.inflation_pct', 'Inflation (%)', ret.inflation_pct ?? 3, 'number')}
      ${input('r.withdrawal_pct', 'Yearly withdrawal (%)', ret.withdrawal_pct ?? 4, 'number')}
      ${input('r.tax_pct', 'Income tax in retirement (%)', ret.tax_pct ?? 12, 'number')}
      ${input('r.health_insurance_monthly', 'Health insurance after retiring (/mo)',
              ret.health_insurance_monthly ?? 0, 'number')}</div>
    <div class="subhead">Return &amp; inflation presets</div>
    ${listEditor('rpresets', toRows(ret.presets), presetRow, '+ Add preset')}
    <h3>College</h3><div class="fgrid">
      ${input('c.graduation_age', 'Age at high school graduation', col.graduation_age ?? 18, 'number')}
      ${input('c.years', 'Years of college', col.years ?? 4, 'number')}
      ${input('c.default_preset', 'Starting preset (key)', col.default_preset ?? 'mid')}</div>
    <div class="subhead">Schools</div>
    ${listEditor('schools', toRows(col.schools), schoolRow, '+ Add school')}
    <div class="subhead">Return &amp; college cost presets</div>
    ${listEditor('cpresets', toRows(col.presets), presetRow, '+ Add preset')}
    <p class="small muted">Leave a preset or school list empty to use the built-in defaults.</p>
    <div class="btns"><button class="btn primary" type="button" id="a-save">Save</button></div>
    <p class="msg" id="a-msg"></p></div>`;
  wireLists(el, {rpresets: () => presetRow(), cpresets: () => presetRow(),
    schools: () => schoolRow()});
  const keyed = (rows: Dict[]) => {
    const out: Record<string, Dict> = {};
    rows.forEach(({key, ...rest}) => {
      if (key) out[String(key)] = rest;
    });
    return Object.keys(out).length ? out : undefined;
  };
  el.querySelector('#a-save')!.addEventListener('click', async () => {
    const msg = el.querySelector('#a-msg');
    const top = el.querySelector('.form')!;
    const all: Dict = {};
    top.querySelectorAll<HTMLInputElement>(':scope > .fgrid [data-k]').forEach((inp) => {
      const v = inp.type === 'number' ? (inp.value === '' ? undefined : +inp.value) :
          inp.value.trim();
      if (v === '' || v === undefined) return;
      all[inp.dataset.k!] = v;
    });
    const pick = (prefix: string) => Object.fromEntries(Object.entries(all)
        .filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
    const nextRet: Dict = {...ret, ...pick('r.')};
    const rp = keyed(readRows(el, 'rpresets'));
    if (rp) nextRet.presets = rp;
    else delete nextRet.presets;
    const nextCol: Dict = {...col, ...pick('c.')};
    const sc = keyed(readRows(el, 'schools'));
    const cp = keyed(readRows(el, 'cpresets'));
    if (sc) nextCol.schools = sc;
    else delete nextCol.schools;
    if (cp) nextCol.presets = cp;
    else delete nextCol.presets;
    try {
      await save('plan', pick('plan.'));
      await save('assumptions', {...asm, retirement: nextRet, college: nextCol});
      report(msg);
    } catch (err) {
      report(msg, err);
    }
  });
}

// ---------- data sources ----------

/** The list of CSV sources. */
function renderSources(el: HTMLElement): void {
  const sources = section<Dict[]>('sources', []);
  const describe = (s: Dict) => {
    const amt = (s.amount as Dict) ?? {};
    return amt.column ? `amount in "${amt.column}" (money out is ${amt.outflow ?? 'negative'})` :
        `money out in "${amt.debit ?? '–'}", money in in "${amt.credit ?? '–'}"`;
  };
  el.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Data sources</h3><span class="small muted">One per kind of CSV
        export (a card, a checking account…). Saved in ${esc(fileOf('sources'))}.</span></div>
      <p class="small muted">CSV files live in the plan's <span class="mono">data</span> folder: ${
        cfg.files.length ? cfg.files.map((f) => `<span class="mono">${esc(f)}</span>`).join(', ') :
        'none yet'}.</p>
      <div class="cards">${sources.map((s, i) => `<div class="card"><b>${esc(s.name)}</b>
        <span class="small mono">${esc([s.files].flat().join(', '))}</span>
        <span class="small muted">date "${esc((s.date as Dict)?.column)}", ${esc(describe(s))}</span>
        <div class="card-actions"><button class="btn sm" type="button" data-edit="${i}">Edit</button>
          <button class="btn sm danger" type="button" data-rm="${i}">Remove</button></div></div>`)
        .join('')}
        <button class="card btn add" type="button" id="add-src" style="place-content:center;min-height:110px">+ Add data source</button></div>
      <p class="msg" id="src-msg"></p></div>`;
  const msg = el.querySelector('#src-msg');
  el.querySelector('#add-src')!.addEventListener('click', () => sourceForm(null, sources));
  el.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) => b.addEventListener('click',
      () => sourceForm(+b.dataset.edit!, sources)));
  el.querySelectorAll<HTMLButtonElement>('.card [data-rm]').forEach((b) => confirmClick(b, () => {
    sources.splice(+b.dataset.rm!, 1);
    save('sources', sources).then(() => renderTab(), (err) => report(msg, err));
  }));
}

/** Add / edit a source, with column detection and a live preview. */
function sourceForm(i: number|null, sources: Dict[]): void {
  const s: Dict = i === null ? {name: `Account ${sources.length + 1}`} : sources[i];
  const amt = (s.amount as Dict) ?? {};
  const date = (s.date as Dict) ?? {};
  const files = [s.files].flat().filter(Boolean) as string[];
  const html = `<div class="fgrid">
      ${input('name', 'Name', s.name, 'text', 'e.g. Visa card, Joint checking')}
      <label class="field"><span>File(s)</span><input data-k="files" type="text" list="src-files"
        value="${esc(files.join(', '))}"><span class="hint">A file in data/ or a pattern like
        data/visa*.csv (comma separated)</span><datalist id="src-files">${cfg.files.map((f) =>
          `<option value="${esc(f)}">`).join('')}</datalist></label>
      <label class="field"><span>Add a CSV to data/</span><input type="file" id="src-up"
        accept=".csv,text/csv"></label>
      ${input('skip_rows', 'Lines before the header row', s.skip_rows ?? 0, 'number')}
      ${input('delimiter', 'Separator', s.delimiter ?? ',')}
    </div>
    <div class="btns"><button class="btn sm" type="button" id="src-read">Read columns from the file</button></div>
    <p class="small muted" id="src-cols"></p>
    <div class="fgrid" id="src-map">
      ${colSelect('date.column', 'Date column', [], date.column)}
      ${input('date.format', 'Date format', date.format ?? '', 'text',
              'Empty = detect. e.g. %m/%d/%Y', 'data-optional')}
      ${input('description', 'Description column(s)', [s.description].flat().filter(Boolean)
        .join(', '), 'text', 'Comma separated; joined with a space', 'list="src-col-list"')}
      ${select('style', 'Amounts are in', [['one', 'one signed column'],
        ['two', 'separate money-out / money-in columns']], amt.column ? 'one' : (amt.debit ||
        amt.credit) ? 'two' : 'one')}
      ${colSelect('amount.column', 'Amount column', [], amt.column)}
      ${select('amount.outflow', 'Money going out is', [['negative', 'negative (most banks)'],
        ['positive', 'positive (most cards)']], amt.outflow ?? 'negative')}
      ${colSelect('amount.debit', 'Money-out column', [], amt.debit)}
      ${colSelect('amount.credit', 'Money-in column', [], amt.credit)}
      ${colSelect('category_column', "Bank's category column (optional)", [], s.category_column,
                  true)}
    </div><datalist id="src-col-list"></datalist>
    <div class="subhead">Bank category → plan category (optional)</div>
    ${listEditor('catmap', Object.entries((s.category_map as Dict) ?? {}).map(([k, v]) =>
      ({bank: k, plan: v})), catMapRow, '+ Add mapping')}
    <div class="btns"><button class="btn sm" type="button" id="src-pv">Preview</button></div>
    <div class="pv" id="src-pv-out"></div>`;
  const build = (form: HTMLElement): Dict => {
    const f = readFields(form);
    const out: Dict = {name: f.name, files: String(f.files ?? '').split(',').map((x) => x.trim())
        .filter(Boolean), date: {column: (f.date as Dict)?.column,
          ...((f.date as Dict)?.format ? {format: (f.date as Dict).format} : {})},
      description: String(f.description ?? '').split(',').map((x) => x.trim()).filter(Boolean)};
    const a = (f.amount as Dict) ?? {};
    out.amount = f.style === 'two' ? {...(a.debit ? {debit: a.debit} : {}),
      ...(a.credit ? {credit: a.credit} : {})} : {column: a.column, outflow: a.outflow};
    if (f.category_column) out.category_column = f.category_column;
    const map: Dict = {};
    readRows(form, 'catmap').forEach((r) => {
      if (r.bank && r.plan) map[String(r.bank)] = r.plan;
    });
    if (Object.keys(map).length) out.category_map = map;
    if (f.skip_rows) out.skip_rows = f.skip_rows;
    if (f.delimiter && f.delimiter !== ',') out.delimiter = f.delimiter;
    if (i !== null && sources[i].encoding) out.encoding = sources[i].encoding;
    return out;
  };
  formDialog(i === null ? 'Add data source' : `Edit ${s.name}`, html, async (form) => {
    const list = sources.slice();
    const next = build(form);
    if (i === null) list.push(next);
    else list[i] = next;
    await save('sources', list);
  }, {catmap: () => catMapRow()});
  const form = document.getElementById('fd-body')!;
  const filesInput = form.querySelector<HTMLInputElement>('[data-k="files"]')!;
  const styleSel = form.querySelector<HTMLSelectElement>('[data-k="style"]')!;
  const syncStyle = () => {
    const two = styleSel.value === 'two';
    ['amount.column', 'amount.outflow'].forEach((k) => (form.querySelector(`[data-k="${k}"]`)!
        .closest('.field') as HTMLElement).hidden = two);
    ['amount.debit', 'amount.credit'].forEach((k) => (form.querySelector(`[data-k="${k}"]`)!
        .closest('.field') as HTMLElement).hidden = !two);
  };
  styleSel.addEventListener('change', syncStyle);
  syncStyle();
  const setColumns = (cols: string[], guess: Dict = {}) => {
    form.querySelectorAll<HTMLSelectElement>('select[data-col]').forEach((sel) => {
      const keep = sel.value || String(guessFor(sel.dataset.k!, guess) ?? '');
      sel.innerHTML = (sel.dataset.optionalCol !== undefined ? '<option value="">(none)</option>' :
          '') + cols.map((c) => `<option${c === keep ? ' selected' : ''}>${esc(c)}</option>`).join('');
    });
    form.querySelector('#src-col-list')!.innerHTML = cols.map((c) => `<option value="${esc(c)}">`)
        .join('');
    const desc = form.querySelector<HTMLInputElement>('[data-k="description"]')!;
    if (!desc.value && guess.description) desc.value = String(guess.description);
    if (guess.date_format) {
      const fmtIn = form.querySelector<HTMLInputElement>('[data-k="date.format"]')!;
      if (!fmtIn.value) fmtIn.placeholder = `detected: ${guess.date_format}`;
    }
    if (!amt.column && !amt.debit && !amt.credit) {
      styleSel.value = guess.debit || guess.credit ? 'two' : 'one';
      if (guess.outflow) {
        form.querySelector<HTMLSelectElement>('[data-k="amount.outflow"]')!.value =
            String(guess.outflow);
      }
      syncStyle();
    }
  };
  const readColumns = async () => {
    const pattern = filesInput.value.split(',')[0]?.trim() ?? '';
    const file = /[*?]/.test(pattern) ? cfg.files.find((f) => globRe(pattern).test(f)) : pattern;
    const out = form.querySelector('#src-cols')!;
    if (!file) {
      out.textContent = 'No file in data/ matches that yet. Add a CSV or type its name.';
      return;
    }
    try {
      const skip = form.querySelector<HTMLInputElement>('[data-k="skip_rows"]')!.value || '0';
      const delim = form.querySelector<HTMLInputElement>('[data-k="delimiter"]')!.value || ',';
      const info = await get<{columns: string[]; rows: number; guess: Dict}>(
          `/api/inspect?file=${encodeURIComponent(file)}&skip_rows=${skip}&delimiter=${
              encodeURIComponent(delim)}`);
      out.textContent = `${info.rows} rows · columns: ${info.columns.join(', ')}`;
      setColumns(info.columns, info.guess);
    } catch (err) {
      out.textContent = (err as Error).message;
    }
  };
  form.querySelector('#src-read')!.addEventListener('click', readColumns);
  form.querySelector<HTMLInputElement>('#src-up')!.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const res = await upload<{file: string}>(`/api/files?name=${encodeURIComponent(f.name)}`, f);
      filesInput.value = res.file;
      cfg.files = [...new Set([...cfg.files, res.file])];
      await readColumns();
    } catch (err) {
      form.querySelector('#src-cols')!.textContent = (err as Error).message;
    }
  });
  form.querySelector('#src-pv')!.addEventListener('click', async () => {
    const out = form.querySelector('#src-pv-out')!;
    try {
      const res = await send<{count: number; skipped: number; errors: string[];
        sample: Array<{date: string; description: string; amount: number; bank_category: string}>}>(
          'POST', '/api/sources/preview', build(form));
      out.innerHTML = `<b>${res.count} transactions read</b>${res.skipped ?
          ` · ${res.skipped} rows skipped (unreadable date or amount)` : ''}${res.errors.map((x) =>
          `<div class="msg err">${esc(x)}</div>`).join('')}<table>${res.sample.map((r) => `<tr><td
          class="mono">${esc(r.date)}</td><td>${esc(r.description)}</td><td class="mono"
          style="text-align:right">${fmt(r.amount, 2)}</td><td class="muted">${
          r.amount < 0 ? 'money in' : 'money out'}</td></tr>`).join('')}</table>`;
    } catch (err) {
      out.innerHTML = `<div class="msg err">${esc((err as Error).message)}</div>`;
    }
  });
  if (files.length) readColumns();
  else setColumns([]);
}

/** A simple glob (* and ?) as a regular expression. */
function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`);
}

/** A select for a CSV column (options filled after reading the file). */
function colSelect(k: string, label: string, cols: string[], value: unknown,
                   optional = false): string {
  const v = value ? String(value) : '';
  const opts = [...new Set([...(v ? [v] : []), ...cols])];
  return `<label class="field"><span>${esc(label)}</span><select data-k="${esc(k)}" data-col${
      optional ? ' data-optional-col data-optional' : ''}>${optional ?
      '<option value="">(none)</option>' : ''}${opts.map((c) => `<option${c === v ? ' selected' :
      ''}>${esc(c)}</option>`).join('')}</select></label>`;
}

/** Which inspect guess fills which column select. */
function guessFor(k: string, guess: Dict): unknown {
  return {'date.column': guess.date, 'amount.column': guess.amount, 'amount.debit': guess.debit,
    'amount.credit': guess.credit, category_column: guess.category}[k];
}

/** A bank-category mapping row. */
function catMapRow(r: Dict = {}): string {
  return input('bank', "Bank's category", r.bank ?? '') + input('plan', 'Plan category',
      r.plan ?? '', 'text', '', 'list="cat-names"') + catNamesDatalist();
}

/** Datalist of category names (for typing a plan category). */
function catNamesDatalist(): string {
  const cats = (cfg.raw.categories as Dict[]|undefined) ?? [];
  return `<datalist id="cat-names">${cats.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>`;
}

// ---------- share plan ----------

/** Save the whole plan as one file; how to open one. */
function renderShare(el: HTMLElement): void {
  el.innerHTML = `<div class="panel form">
      <h3>Send your whole plan</h3>
      <p class="small">Saves everything in this plan as one <span class="mono">.zip</span> file:
        settings, categories and rules, your CSV files, and (if ticked) your planner edits and
        saved scenarios. Send it by AirDrop or Messages; the other person opens it in their
        Financial Planner and sees exactly what you see.</p>
      <label class="field check"><input type="checkbox" id="sh-state" checked>Include my planner
        edits and saved scenarios</label>
      <div class="btns"><a class="btn primary" id="sh-dl" href="/api/plan/export" download>Save plan
        as a file</a></div>
      <div class="banner"><b>This file contains your real transactions and finances.</b>
        <span class="small">Share it only with people you trust, privately (AirDrop, Messages,
        email to them). Don't post it or put it in a public folder.</span></div>
    </div>
    <div class="panel form">
      <h3>Open a plan someone sent you</h3>
      <ul class="small" style="margin:0;padding-left:1.2em;display:grid;gap:4px">
        <li><b>Desktop app (Mac):</b> menu-bar icon › <i>Open Plan File…</i> and pick the
          <span class="mono">.zip</span>. You can keep both plans or replace yours (yours is kept
          as a backup folder). New users get the same choice on the first launch.</li>
        <li><b>Command line:</b> <span class="mono">financial_plan import "Household Budget
          2026-11-06.zip"</span></li>
        <li><b>By hand:</b> double-click the <span class="mono">.zip</span> in Finder. The folder
          it makes is a plan; open it with <i>Change Plan Folder…</i>.</li>
      </ul>
      <p class="small muted">Only want to share a what-if? Use <i>Share</i> in the Scenarios bar
        instead: it sends just the numbers, not your data.</p>
    </div>`;
  const box = el.querySelector<HTMLInputElement>('#sh-state')!;
  const link = el.querySelector<HTMLAnchorElement>('#sh-dl')!;
  box.addEventListener('change', () => {
    link.href = box.checked ? '/api/plan/export' : '/api/plan/export?state=false';
  });
}

// ---------- categories ----------

/** The editable category table. */
function renderCategories(el: HTMLElement): void {
  const cats = section<Dict[]>('categories', []);
  const original = cats.map((c) => String(c.name));
  const row = (c: Dict, i: number) => `<tr data-row data-orig="${i}">
    <td><input data-k="name" value="${esc(c.name ?? '')}" style="width:150px"></td>
    <td><select data-k="kind">${KINDS.map(([k, l]) => `<option value="${k}"${
      (c.kind ?? 'spending') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><input data-k="group" value="${esc(c.group ?? 'Other')}" style="width:100px"></td>
    <td style="text-align:center"><input type="checkbox" data-k="flexible"${c.flexible ? ' checked' : ''}></td>
    <td><input type="number" data-k="kids_gone_pct" value="${esc(c.kids_gone_pct ?? 0)}" style="width:64px"></td>
    <td><input type="number" data-k="retired_pct" value="${esc(c.retired_pct ?? 0)}" style="width:64px"></td>
    <td style="text-align:center"><input type="checkbox" data-k="default_on"${c.default_on ? ' checked' : ''}></td>
    <td style="text-align:center"><input type="checkbox" data-k="in_retirement"${c.in_retirement ? ' checked' : ''}></td>
    <td style="text-align:center"><input type="checkbox" data-k="tax"${c.tax ? ' checked' : ''}></td>
    <td><input data-k="offsets" value="${esc(c.offsets ?? '')}" list="cat-names" style="width:130px"></td>
    <td><input data-k="label" value="${esc(c.label ?? '')}" style="width:160px"></td>
    <td><input data-k="note" value="${esc(c.note ?? '')}" style="width:140px"></td>
    <td style="white-space:nowrap"><button class="btn sm" type="button" data-up aria-label="Move up">↑</button>
      <button class="btn sm danger" type="button" data-del>Remove</button></td></tr>`;
  el.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Categories</h3><span class="small muted">Saved in ${
        esc(fileOf('categories'))}. Renaming a category also updates the rules that use it.</span></div>
      <p class="small muted"><b>Kind:</b> regular spending is averaged in the planner; one-time
        costs get an on/off toggle; credits (money in) can be subtracted; ignore is for transfers,
        card payments and paychecks. <b>Kids gone / retired</b> are % changes used by Spending over
        time. <b>On by default</b>, <b>in retirement</b> and <b>tax</b> apply to one-time costs and
        credits. <b>Offsets</b>: for a credit, the category it reduces.</p>
      <div class="ptable-scroll"><table class="dtable edit" id="cat-table"><thead><tr>
        <th>Name</th><th>Kind</th><th>Group</th><th>Flexible</th><th>Kids gone %</th><th>Retired %</th>
        <th>On by default</th><th>In retirement</th><th>Tax</th><th>Offsets</th><th>Toggle label</th>
        <th>Note</th><th></th></tr></thead><tbody>${cats.map(row).join('')}</tbody></table></div>
      ${catNamesDatalist()}
      <div class="btns"><button class="btn sm add" type="button" id="cat-add">+ Add category</button>
        <button class="btn primary" type="button" id="cat-save">Save categories</button></div>
      <p class="msg" id="cat-msg"></p></div>`;
  const body = el.querySelector('#cat-table tbody')!;
  body.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tr = t.closest('tr')!;
    if (t.matches('[data-del]')) tr.remove();
    if (t.matches('[data-up]') && tr.previousElementSibling) {
      tr.parentElement!.insertBefore(tr, tr.previousElementSibling);
    }
  });
  el.querySelector('#cat-add')!.addEventListener('click', () => {
    body.insertAdjacentHTML('beforeend', row({name: '', group: 'Other'}, -1));
    (body.lastElementChild!.querySelector('input') as HTMLInputElement).focus();
  });
  el.querySelector('#cat-save')!.addEventListener('click', async () => {
    const msg = el.querySelector('#cat-msg');
    const renames = new Map<string, string>();
    const next = [...body.querySelectorAll('tr[data-row]')].map((tr) => {
      const f = readFields(tr);
      const orig = +(tr as HTMLElement).dataset.orig!;
      if (orig >= 0 && original[orig] !== f.name) renames.set(original[orig], String(f.name));
      const out: Dict = {name: f.name};
      if (f.kind !== 'spending') out.kind = f.kind;
      if (f.group && f.group !== 'Other') out.group = f.group;
      ['flexible', 'default_on', 'in_retirement', 'tax'].forEach((k) => {
        if (f[k]) out[k] = true;
      });
      ['kids_gone_pct', 'retired_pct'].forEach((k) => {
        if (f[k]) out[k] = f[k];
      });
      ['offsets', 'label', 'note'].forEach((k) => {
        if (f[k]) out[k] = f[k];
      });
      return out;
    }).filter((c) => c.name);
    next.forEach((c) => {
      if (c.offsets && renames.has(String(c.offsets))) c.offsets = renames.get(String(c.offsets));
    });
    try {
      await save('categories', next);
      if (renames.size) await applyRenames(renames);
      renderTab();
      report(document.getElementById('cat-msg'), undefined, renames.size ?
          `Saved. Updated rules for ${renames.size} renamed categor${
              renames.size === 1 ? 'y' : 'ies'}.` : 'Saved.');
    } catch (err) {
      report(msg, err);
    }
  });
}

/** Points rules, bank-category maps and defaults at renamed categories. */
async function applyRenames(renames: Map<string, string>): Promise<void> {
  const rename = (v: unknown) => renames.get(String(v)) ?? v;
  const rules = section<Dict[]>('rules', []);
  if (rules.some((r) => renames.has(String(r.category)))) {
    await save('rules', rules.map((r) => ({...r, category: rename(r.category)})));
  }
  const sources = section<Dict[]>('sources', []);
  if (sources.some((s) => Object.values((s.category_map as Dict) ?? {}).some((v) =>
    renames.has(String(v))))) {
    await save('sources', sources.map((s) => s.category_map ? {...s, category_map:
        Object.fromEntries(Object.entries(s.category_map as Dict).map(([k, v]) =>
          [k, rename(v)]))} : s));
  }
  for (const key of ['default_category', 'default_credit_category']) {
    if (renames.has(String(cfg.raw[key]))) await save(key, rename(cfg.raw[key]));
  }
}
