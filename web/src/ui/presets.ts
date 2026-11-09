/**
 * @fileoverview Editable return / inflation presets for the College 529 cards and Retirement.
 * Pick one to set both sliders, or edit the list: change a label, return or inflation, add one,
 * remove any (including the starting ones), or keep none. Saved with the plan; the first time,
 * the list starts from the presets in the config.
 *
 * License: BSD 3-Clause
 */

import {get, send} from '../api';
import {app} from '../app';
import {esc} from '../format';

//
// CONSTANTS
//
const SAVE_DELAY_MS = 400;

//
// PUBLIC
//

/** One preset: a label and its yearly return and inflation (%). */
export interface PresetItem {
  name: string;
  ret: number;
  inf: number;
}

/** Which list: college (529 cards) or retirement. */
export type PresetKind = 'college'|'retire';

/** Loads the saved lists (or the config's presets the first time). */
export async function loadPresets(): Promise<void> {
  const saved = await get<{presets?: Partial<Record<PresetKind, PresetItem[]>>}>('/api/state');
  const a = app.d.p.assumptions;
  const fromConfig = (x: Record<string, {name: string; return_pct: number; inflation_pct: number}>) =>
      Object.values(x).map((p) => ({name: p.name, ret: p.return_pct, inf: p.inflation_pct}));
  lists = {college: saved.presets?.college ?? fromConfig(a.college.presets),
    retire: saved.presets?.retire ?? fromConfig(a.retirement.presets)};
}

/**
 * Puts a preset picker (with an edit mode) into host.
 * @param host The element to fill.
 * @param kind Which list.
 * @param current The [return, inflation] in use, to mark the matching preset.
 * @param apply Sets the return and inflation when a preset is picked.
 * @return A function that re-marks the preset in use (call after the sliders change).
 */
export function presetPicker(host: HTMLElement, kind: PresetKind, current: () => [number, number],
                             apply: (ret: number, inf: number) => void): () => void {
  const ed: Editor = {host, kind, current, apply, editing: false};
  editors.push(ed);
  host.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button');
    if (!t) return;
    const list = lists[kind];
    const i = +(t.closest('[data-i]') as HTMLElement|null)?.dataset.i!;
    if (t.dataset.pi !== undefined) {
      const p = list[+t.dataset.pi];
      apply(p.ret, p.inf);
    } else if (t.dataset.pe !== undefined) {
      ed.editing = true;
      render(ed);
    } else if (t.dataset.pd !== undefined) {
      ed.editing = false;
      renderAll(kind);
    } else if (t.dataset.px !== undefined) {
      list.splice(i, 1);
      save();
      renderAll(kind);
    } else if (t.dataset.pa !== undefined) {
      const [ret, inf] = current();
      list.push({name: `Preset ${list.length + 1}`, ret, inf});
      save();
      renderAll(kind);
      const rows = host.querySelectorAll<HTMLElement>('.pr-row');
      rows[rows.length - 1]?.querySelector('input')?.select();
    }
  });
  host.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const row = el.closest('[data-i]') as HTMLElement|null;
    if (!row || !el.dataset.pf) return;
    const p = lists[kind][+row.dataset.i!];
    if (el.dataset.pf === 'name') p.name = el.value;
    else p[el.dataset.pf as 'ret'|'inf'] = parseFloat(el.value) || 0;
    save();
    editors.filter((x) => x.kind === kind && x !== ed).forEach(render);
  });
  render(ed);
  return () => {
    if (!ed.editing) render(ed);
  };
}

//
// INTERNAL
//
interface Editor {
  host: HTMLElement;
  kind: PresetKind;
  current: () => [number, number];
  apply: (ret: number, inf: number) => void;
  editing: boolean;
}

let lists: Record<PresetKind, PresetItem[]> = {college: [], retire: []};
const editors: Editor[] = [];
let timer = 0;

/** Saves both lists to the plan folder (debounced). */
function save(): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    send('PUT', '/api/state/presets', lists).catch(() => {});
  }, SAVE_DELAY_MS);
}

/** Re-renders every picker of a kind. */
function renderAll(kind: PresetKind): void {
  editors.filter((x) => x.kind === kind).forEach(render);
}

/** The picker (chips) or the editor (rows) for one host. */
function render(ed: Editor): void {
  const list = lists[ed.kind];
  if (ed.editing) {
    ed.host.innerHTML = `<div class="pr-edit">${list.map((p, i) => `<div class="pr-row"
      data-i="${i}"><input type="text" data-pf="name" value="${esc(p.name)}"
      aria-label="Preset name"><label>return <input class="amt" type="number" step="0.5"
      data-pf="ret" value="${p.ret}" aria-label="${esc(p.name)} return">%</label><label>inflation
      <input class="amt" type="number" step="0.25" data-pf="inf" value="${p.inf}"
      aria-label="${esc(p.name)} inflation">%</label><button class="btn sm" type="button" data-px
      aria-label="Remove ${esc(p.name)}">×</button></div>`).join('') ||
      '<p class="small muted">No presets.</p>'}<div class="btns"><button class="btn sm add"
      type="button" data-pa>+ Add preset</button><button class="btn sm primary" type="button"
      data-pd>Done</button></div></div>`;
    return;
  }
  const [ret, inf] = ed.current();
  ed.host.innerHTML = `<div class="chips">${list.map((p, i) => `<button type="button" class="chip"
    data-pi="${i}" aria-pressed="${p.ret === ret && p.inf === inf}">${esc(p.name)} <span
    class="num">${p.ret}% / ${p.inf}%</span></button>`).join('')}<button class="btn sm" type="button"
    data-pe>${list.length ? 'Edit presets' : 'Add presets'}</button></div>`;
}
