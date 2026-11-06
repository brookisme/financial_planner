/**
 * @fileoverview Entry point: loads the plan, builds every section and routes between the main
 * page, Help and Settings.
 *
 * License: BSD 3-Clause
 */

import {$, app, load} from './app';
import {esc, setCurrency} from './format';
import {describeData} from './model';
import {buildCollege} from './ui/college';
import {buildExplorer} from './ui/explorer';
import {buildFuture} from './ui/future';
import {buildHelp} from './ui/help';
import {buildPlanner} from './ui/planner';
import {buildRetire} from './ui/retire';
import {buildScenarios} from './ui/scenarios';
import {settingsDirty, showSettings} from './ui/settings';
import {buildTheme} from './ui/theme';

//
// INTERNAL
//
let ready = false;

/** Shows the main page, Help or Settings for the current hash. */
function route(): void {
  const hash = location.hash;
  const settings = hash.startsWith('#settings');
  const help = hash === '#help';
  if (!settings && !help && settingsDirty()) {
    sessionStorage.setItem('fp-hash', hash);
    location.reload();
    return;
  }
  $('app-main').hidden = settings || help || !ready;
  $('help').hidden = !help;
  $('settings').hidden = !settings;
  $('gear').classList.toggle('on', settings);
  document.querySelectorAll('nav.tabs a').forEach((a) => {
    a.classList.toggle('on', help && a.getAttribute('href') === '#help');
  });
  if (settings) {
    showSettings(hash.split('/')[1]);
    window.scrollTo(0, 0);
  }
  if (help) window.scrollTo(0, 0);
}

/** Message when there is nothing to show yet, or the config is broken. */
function banner(html: string, err = false): void {
  $('banners').insertAdjacentHTML('beforeend',
      `<div class="banner${err ? ' err' : ''}">${html}</div>`);
}

/** Loads and builds everything. */
async function start(): Promise<void> {
  buildHelp();
  buildTheme();
  window.addEventListener('hashchange', route);
  let p;
  try {
    p = await load();
  } catch (err) {
    banner(`<b>Couldn't reach the planner.</b> ${esc((err as Error).message)}`, true);
    return;
  }
  if (p.error) {
    banner(`<b>The plan's config needs fixing.</b><span class="mono" style="white-space:pre-wrap">${
        esc(p.error)}</span><a href="#settings">Open Settings</a>`, true);
    if (!location.hash.startsWith('#settings')) location.hash = '#settings';
    route();
    return;
  }
  setCurrency(p.plan.currency_symbol);
  document.title = p.plan.title;
  $('title').textContent = p.plan.title;
  $('subtitle').textContent = p.plan.subtitle || describeData(p);
  const months = p.month_labels;
  $('eyebrow').textContent = months.length ?
      `${p.plan.title} · ${months[0]} – ${months[months.length - 1]} data` : p.plan.title;
  p.warnings.forEach((w) => banner(esc(w)));
  if (!p.counts.transactions) {
    banner(`<b>No transactions yet.</b> Add your bank and card CSV exports under
      <a href="#settings/sources">Settings › Data sources</a>, and your household under
      <a href="#settings/household">Settings › Household</a>.`);
  }
  if (!app.d.partners.length) {
    banner('<b>No partners yet.</b> Add at least one under <a href="#settings/household">' +
        'Settings › Household</a> to see income and retirement.');
  }
  buildPlanner();
  buildExplorer();
  buildCollege();
  buildRetire();
  buildFuture();
  await buildScenarios();
  ready = true;
  const back = sessionStorage.getItem('fp-hash');
  sessionStorage.removeItem('fp-hash');
  if (back !== null && location.hash !== back) location.hash = back;
  route();
  const y = sessionStorage.getItem('fp-scroll');
  sessionStorage.removeItem('fp-scroll');
  if (y) window.scrollTo(0, +y);
}

start();
