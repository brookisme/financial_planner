/**
 * @fileoverview The planning model: pure functions with no DOM, so every forecast is testable.
 *
 * Conventions: amounts are monthly; spending is positive, credits (money in) are stored negative
 * in the data and handled as positive amounts to subtract. Retirement figures are in today's
 * dollars: balances grow at the return rate, are deflated at the inflation rate, then turned into
 * monthly income with the withdrawal rate.
 *
 * License: BSD 3-Clause
 */

import {sum} from './format';
import type {Category, Child, ChildTimeline, FutureState, Partner, Payload, PlannerState,
             RetireState, Settings} from './types';

//
// CONSTANTS
//

/** Social Security benefit as a share of the age-67 amount, by claiming age. */
export const SS_FACTORS: Record<number, number> = {
  62: 0.70, 63: 0.75, 64: 0.80, 65: 0.8667, 66: 0.9333, 67: 1, 68: 1.08, 69: 1.16, 70: 1.24,
};
/** Years of the long-range projection. */
export const PROJECTION_YEARS = 35;

//
// PUBLIC
//

/** Indexed, derived view of the payload. */
export class Data {
  readonly n: number;
  readonly cats: Category[];
  readonly byCat: number[][];
  readonly regular: number[];
  readonly oneTime: number[];
  readonly credits: number[];
  readonly todayYear: number;
  readonly todayMonth: number;
  readonly partners: Partner[];
  readonly children: Child[];
  readonly timelines: ChildTimeline[];
  private readonly index: Map<string, number>;

  constructor(readonly p: Payload) {
    this.n = Math.max(1, p.months.length);
    this.cats = p.categories;
    this.byCat = p.by_cat;
    this.index = new Map(this.cats.map((c, i) => [c.name, i]));
    const kind = (k: string) => this.cats.map((_, i) => i).filter((i) => this.cats[i].kind === k);
    this.regular = kind('spending');
    this.oneTime = kind('one_time');
    this.credits = kind('credit');
    this.todayYear = +p.plan.today.slice(0, 4);
    this.todayMonth = +p.plan.today.slice(5, 7);
    this.partners = p.household.partners;
    this.children = p.household.children;
    this.timelines = p.children;
  }

  /** Category index by name (-1 if unknown). */
  idx(name: string): number {
    return this.index.get(name) ?? -1;
  }

  /** Average per month over the window (credits come out negative). */
  avg(i: number): number {
    return i < 0 ? 0 : sum(this.byCat[i]) / this.n;
  }

  /** A credit category's average as a positive amount. */
  credAvg(i: number): number {
    return -this.avg(i);
  }

  /** The primary partner (the retirement-age slider is their age). */
  get primary(): Partner {
    return this.partners[0] ?? {id: 'none', name: 'You', age: 40, take_home_monthly: 0,
      take_home_note: '', raise_pct: 0, social_security: {at_67: 0, claim_age: null},
      pensions: [], accounts: []};
  }

  /** Credit categories that offset a given category. */
  offsetsOf(name: string): number[] {
    return this.credits.filter((i) => this.cats[i].offsets === name);
  }

  /** Whether a credit is shown inside the planner table (not nested under a one-time cost). */
  isPlannerCredit(i: number): boolean {
    const off = this.cats[i].offsets;
    return !off || this.cats[this.idx(off)]?.kind !== 'one_time';
  }

  /** A child's high-school graduation as a fractional year (June 2034 -> 2034.5). */
  gradT(child: number): number {
    const g = this.timelines[child].graduation;
    return +g.slice(0, 4) + +g.slice(5, 7) / 12;
  }
}

/**
 * Starting settings from the config and the data.
 * @param d The data.
 */
export function defaults(d: Data): Settings {
  const p = d.p;
  const st: PlannerState = {inc: {}, sav: {}, on: {}, plan: {}};
  d.partners.forEach((x) => st.inc[x.id] = x.take_home_monthly);
  st.inc.other = p.other_income_monthly;
  d.children.forEach((c) => st.sav[`529:${c.id}`] = c.college_529.monthly);
  p.savings.forEach((s) => st.sav[`sav:${s.id}`] = s.monthly);
  p.investments.forEach((v) => st.sav[`inv:${v.id}`] = v.monthly);
  [...d.oneTime, ...d.credits].forEach((i) => st.on[d.cats[i].name] = d.cats[i].default_on);
  d.regular.forEach((i) => st.plan[d.cats[i].name] = d.avg(i));
  d.credits.filter((i) => d.isPlannerCredit(i))
      .forEach((i) => st.plan[d.cats[i].name] = d.credAvg(i));
  const col = p.assumptions.college;
  const preset = col.presets[col.default_preset] ?? Object.values(col.presets)[0] ??
      {return_pct: 6, inflation_pct: 4};
  const cs: Settings['cs'] = {};
  d.children.forEach((c) => cs[c.id] = {school: c.school, cost: col.schools[c.school]?.cost ?? 0,
    ret: preset.return_pct, inf: preset.inflation_pct});
  const ra = p.assumptions.retirement;
  const rs: RetireState = {age: ra.default_age, ret: ra.return_pct, inf: ra.inflation_pct,
    wd: ra.withdrawal_pct, ss: true, raise: {}, ssAmt: {}, claim: {}, pen: {}, acct: {}, inv: {}};
  d.partners.forEach((x) => {
    rs.raise[x.id] = x.raise_pct;
    rs.ssAmt[x.id] = x.social_security.at_67;
    rs.claim[x.id] = x.social_security.claim_age;
    x.pensions.forEach((pn, i) => rs.pen[`${x.id}:${i}`] = {on: true, est: {...pn.estimates},
      monthly: pn.monthly});
    x.accounts.forEach((a, i) => rs.acct[`${x.id}:${i}`] = {on: true, bal: a.balance,
      monthly: a.monthly});
  });
  p.investments.forEach((v) => rs.inv[v.id] = {bal: v.balance, ret: v.return_pct});
  const fs: FutureState = {kg: {}, rt: {}, health: ra.health_insurance_monthly, tax: ra.tax_pct,
    nominal: false};
  d.regular.forEach((i) => {
    fs.kg[d.cats[i].name] = d.cats[i].kids_gone_pct;
    fs.rt[d.cats[i].name] = d.cats[i].retired_pct;
  });
  return {st, cs, rs, fs};
}

/**
 * Applies saved settings on top of current defaults. A saved value that still equals the default
 * it was saved against is dropped, so it follows the config if the config changes later. Values
 * whose path no longer exists in the defaults (removed people or categories) are dropped too.
 * @param defs Current defaults.
 * @param saved Saved settings (may be partial).
 * @param base The defaults when they were saved.
 */
export function rebase(defs: Settings, saved: Partial<Settings>|null|undefined,
                       base?: Partial<Settings>|null): Settings {
  const out = clone(defs);
  if (!saved) return out;
  const baseMap = new Map(flatten(base ?? {}).map(([k, v]) => [k, v]));
  const defMap = new Map(flatten(defs).map(([k, v]) => [k, v]));
  for (const [key, value] of flatten(saved)) {
    if (!defMap.has(key)) continue;
    if (base && baseMap.has(key) && same(baseMap.get(key), value)) continue;
    setPath(out as unknown as Record<string, unknown>, JSON.parse(key), value);
  }
  return out;
}

/** Deep copy of plain JSON data. */
export function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

/**
 * Flattens nested plain objects to [JSON path, leaf value] pairs.
 * @param o The object.
 */
export function flatten(o: unknown): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const walk = (v: unknown, path: string[]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.entries(v as Record<string, unknown>).forEach(([k, x]) => walk(x, [...path, k]));
    } else if (path.length) {
      out.push([JSON.stringify(path), v]);
    }
  };
  walk(o, []);
  return out;
}

/** Sets a nested value, creating objects on the way. */
export function setPath(o: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = o;
  path.slice(0, -1).forEach((k) => {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  });
  cur[path[path.length - 1]] = value;
}

// ---------- the monthly budget ----------

/** Planned regular spending (before credits). */
export function regularMo(d: Data, st: PlannerState): number {
  return sum(d.regular.map((i) => st.plan[d.cats[i].name] ?? 0));
}

/**
 * Credits subtracted from spending in the planner (toggled on, not nested under a one-time cost).
 * @param ret In retirement: only credits marked in_retirement continue.
 */
export function creditsMo(d: Data, st: PlannerState, ret = false): number {
  return sum(d.credits.filter((i) => d.isPlannerCredit(i) && st.on[d.cats[i].name] &&
                                     (!ret || d.cats[i].in_retirement))
      .map((i) => st.plan[d.cats[i].name] ?? 0));
}

/** A one-time category's monthly amount net of any toggled-on credits nested under it. */
export function oneTimeNet(d: Data, st: PlannerState, i: number): number {
  const off = d.offsetsOf(d.cats[i].name).filter((c) => st.on[d.cats[c].name]);
  return d.avg(i) - sum(off.map((c) => d.credAvg(c)));
}

/** Monthly set-aside for one-time costs, either the tax ones or the others. */
function oneTimeMo(d: Data, st: PlannerState, tax: boolean, ret: boolean): number {
  return sum(d.oneTime.filter((i) => d.cats[i].tax === tax && st.on[d.cats[i].name] &&
                                     (!ret || d.cats[i].in_retirement))
      .map((i) => oneTimeNet(d, st, i)));
}

/** Tax set-aside per month (tax one-time costs that are on, net of nested credits). */
export function taxMo(d: Data, st: PlannerState, ret = false): number {
  return oneTimeMo(d, st, true, ret);
}

/** Non-tax one-time costs that are toggled on. */
export function extraMo(d: Data, st: PlannerState, ret = false): number {
  return oneTimeMo(d, st, false, ret);
}

/** Take-home income per month. */
export function incomeMo(st: PlannerState): number {
  return sum(Object.values(st.inc));
}

/** Investment contributions per month (keys inv:...). */
export function investingMo(st: PlannerState): number {
  return sum(Object.entries(st.sav).filter(([k]) => k.startsWith('inv:')).map(([, v]) => v));
}

/** One month on paper. */
export interface Budget {
  income: number;
  regular: number;
  credits: number;
  extra: number;
  spend: number;
  savings: number;
  investing: number;
  tax: number;
  left: number;
}

/** The monthly budget for planner settings. */
export function budget(d: Data, st: PlannerState): Budget {
  const income = incomeMo(st);
  const regular = regularMo(d, st);
  const credits = creditsMo(d, st);
  const extra = extraMo(d, st);
  const spend = regular - credits + extra;
  const allSav = sum(Object.values(st.sav));
  const investing = investingMo(st);
  const tax = taxMo(d, st);
  return {income, regular, credits, extra, spend, savings: allSav - investing, investing, tax,
    left: income - spend - allSav - tax};
}

// ---------- college ----------

/**
 * Future value with monthly compounding: start p, add m each month for n months, yearly rate r.
 */
export function fv(p: number, m: number, n: number, r: number): number {
  const i = Math.pow(1 + r, 1 / 12) - 1;
  let b = p;
  for (let k = 0; k < n; k++) b = b * (1 + i) + m;
  return b;
}

/** A child's 529 projection. */
export interface KidResult {
  bal: number;
  cost: number;
  gap: number;
  today: number;
  pct: number;
  need: number;
}

/**
 * Projects a child's 529 to graduation against the inflated cost of college.
 * @param d The data.
 * @param s Settings.
 * @param k Child index.
 */
export function kidCalc(d: Data, s: Settings, k: number): KidResult {
  const child = d.children[k];
  const tl = d.timelines[k];
  const c = s.cs[child.id];
  const m = s.st.sav[`529:${child.id}`] ?? 0;
  const r = c.ret / 100;
  const g = c.inf / 100;
  const months = tl.months_to_graduation;
  const bal = fv(child.college_529.balance, m, months, r);
  let cost = 0;
  for (let j = 0; j < d.p.assumptions.college.years; j++) {
    cost += c.cost * Math.pow(1 + g, tl.years_to_college + j);
  }
  const gap = bal - cost;
  const today = gap / Math.pow(1 + g, months / 12);
  const i = Math.pow(1 + r, 1 / 12) - 1;
  const G = Math.pow(1 + i, months);
  const need = months > 0 ?
      Math.max(0, i > 0 ? (cost - child.college_529.balance * G) * i / (G - 1) :
                          (cost - child.college_529.balance) / months) :
      0;
  return {bal, cost, gap, today, pct: cost ? bal / cost : 0, need};
}

// ---------- retirement ----------

/** Social Security factor for a claiming age (clamped to 62-70, rounded). */
export function ssFactor(age: number): number {
  return SS_FACTORS[Math.min(70, Math.max(62, Math.round(age)))];
}

/**
 * A pension's monthly benefit for retiring at an age, from age -> amount estimates.
 * Linear between estimates, nothing before the first, and after the last either flat or grown
 * with years of service.
 * @param est Estimates by age.
 * @param age Retirement age.
 * @param ageNow Age today.
 * @param serviceNow Years of service today (null: flat after the last estimate).
 */
export function interpolatePension(est: Record<string, number>, age: number, ageNow: number,
                                   serviceNow: number|null): number {
  const pts = Object.entries(est).map(([a, v]) => [+a, +v]).filter(([a]) => !isNaN(a))
      .sort((x, y) => x[0] - y[0]);
  if (!pts.length || age < pts[0][0]) return 0;
  for (let j = 1; j < pts.length; j++) {
    const [a0, v0] = pts[j - 1];
    const [a1, v1] = pts[j];
    if (age <= a1) return v0 + (v1 - v0) * (age - a0) / (a1 - a0);
  }
  const [aL, vL] = pts[pts.length - 1];
  if (serviceNow == null) return vL;
  return vL * (serviceNow + age - ageNow) / (serviceNow + aL - ageNow);
}

/** One income source at retirement. */
export interface IncomePart {
  kind: 'pension'|'account'|'investment'|'ss';
  key: string;
  name: string;
  partner: string;
  value: number;
  balance?: number;
  started: boolean;
  start?: number;
  claimAge?: number;
}

/** Retirement income for one retirement age. */
export interface RetireResult {
  age: number;
  yrs: number;
  parts: IncomePart[];
  total: number;
  later: number;
  full: number;
  fullYear: number;
  ages: Record<string, number>;
}

/** A partner's age when the primary partner is a given age. */
export function ageWhen(d: Data, partner: Partner, primaryAge: number): number {
  return partner.age + (primaryAge - d.primary.age);
}

/** Calendar year a partner reaches an age. */
export function yearAtAge(d: Data, partner: Partner, age: number): number {
  return Math.round(d.todayYear - partner.age) + age;
}

/** First full calendar year of retirement. */
export function retireYear(d: Data, rs: RetireState): number {
  return Math.round(d.todayYear - d.primary.age) + 1 + rs.age;
}

/**
 * Monthly retirement income (today's dollars, before tax) if the primary partner retires at a.
 * @param d The data.
 * @param s Settings.
 * @param a Primary partner's retirement age.
 */
export function retirementIncome(d: Data, s: Settings, a: number): RetireResult {
  const rs = s.rs;
  const yrs = a - d.primary.age;
  const months = Math.round(yrs * 12);
  const r = rs.ret / 100;
  const inf = Math.pow(1 + rs.inf / 100, yrs);
  const wd = rs.wd / 100 / 12;
  const parts: IncomePart[] = [];
  const ages: Record<string, number> = {};
  d.partners.forEach((p) => {
    const ageR = ageWhen(d, p, a);
    ages[p.id] = ageR;
    p.pensions.forEach((pn, i) => {
      const key = `${p.id}:${i}`;
      const st = rs.pen[key];
      if (!st?.on) return;
      let v = st.monthly != null ? st.monthly :
          interpolatePension(st.est, ageR, p.age, pn.service_years_now);
      if (pn.grows_with_raises) {
        v *= Math.pow(1 + (rs.raise[p.id] ?? 0) / 100, Math.max(0, ageR - p.age - 1.5));
      }
      parts.push({kind: 'pension', key, name: pn.name, partner: p.id, value: v, started: true});
    });
    p.accounts.forEach((ac, i) => {
      const key = `${p.id}:${i}`;
      const st = rs.acct[key];
      if (!st?.on) return;
      const bal = fv(st.bal, st.monthly, months, r);
      parts.push({kind: 'account', key, name: ac.name, partner: p.id, value: bal / inf * wd,
        balance: bal, started: true});
    });
  });
  d.p.investments.forEach((v) => {
    const st = rs.inv[v.id];
    if (!st) return;
    const bal = fv(st.bal, s.st.sav[`inv:${v.id}`] ?? 0, months, st.ret / 100);
    if (bal <= 0) return;
    parts.push({kind: 'investment', key: v.id, name: v.name, partner: '', value: bal / inf * wd,
      balance: bal, started: true});
  });
  if (rs.ss) {
    d.partners.forEach((p) => {
      const ageR = ages[p.id];
      const want = rs.claim[p.id];
      const claimAge = want == null ? Math.max(62, ageR) : Math.min(70, Math.max(want, ageR));
      const value = (rs.ssAmt[p.id] ?? 0) * ssFactor(claimAge);
      if (!value) return;
      parts.push({kind: 'ss', key: p.id, name: `${p.name} Social Security`, partner: p.id, value,
        started: ageR >= claimAge - 0.01, claimAge,
        start: yearAtAge(d, p, Math.ceil(claimAge - 0.01))});
    });
  }
  const total = sum(parts.filter((x) => x.started).map((x) => x.value));
  const pending = parts.filter((x) => !x.started);
  const later = sum(pending.map((x) => x.value));
  return {age: a, yrs, parts, total, later, full: total + later,
    fullYear: Math.max(0, ...pending.map((x) => x.start ?? 0)), ages};
}

/** One year of the long-range projection (monthly amounts, today's dollars). */
export interface YearSpend {
  y: number;
  kids: number;
  ret: boolean;
  cats: Record<string, number>;
  living: number;
  tax: number;
  health: number;
  spend: number;
  savings: number;
}

/**
 * Monthly spending in a calendar year: categories change as children leave home (partly while
 * some are still home) and again after retiring; credits and contributions stop on schedule.
 * @param d The data.
 * @param s Settings.
 * @param y Calendar year.
 */
export function spendAt(d: Data, s: Settings, y: number): YearSpend {
  const {st, fs} = s;
  const t = y + 0.5;
  const total = d.children.length;
  const kids = d.children.filter((_, k) => t < d.gradT(k)).length;
  const gone = total ? (total - kids) / total : 0;
  const ret = y >= retireYear(d, s.rs);
  const cats: Record<string, number> = {};
  let living = 0;
  d.regular.forEach((i) => {
    const n = d.cats[i].name;
    let v = (st.plan[n] ?? 0) * Math.max(0, 1 + gone * (fs.kg[n] ?? 0) / 100);
    if (ret) v *= Math.max(0, 1 + (fs.rt[n] ?? 0) / 100);
    cats[n] = v;
    living += v;
  });
  living += extraMo(d, st, ret) - creditsMo(d, st, ret);
  const tax = taxMo(d, st, ret);
  const health = ret ? fs.health : 0;
  let savings = 0;
  d.children.forEach((c, k) => {
    if (t < d.gradT(k)) savings += st.sav[`529:${c.id}`] ?? 0;
  });
  d.p.savings.forEach((sv) => {
    if (!(ret && sv.stops_at_retirement)) savings += st.sav[`sav:${sv.id}`] ?? 0;
  });
  if (!ret) savings += investingMo(st);
  return {y, kids, ret, cats, living, tax, health, spend: living + tax + health, savings};
}

/**
 * Take-home income per month in a calendar year: pay grows with real raises until retirement,
 * then retirement income after tax, with Social Security added from each claim year.
 */
export function incomeAt(d: Data, s: Settings, y: number): number {
  const {st, rs, fs} = s;
  if (y < retireYear(d, rs)) {
    const n = Math.max(0, y - d.todayYear);
    return sum(d.partners.map((p) => (st.inc[p.id] ?? 0) *
                                     Math.pow(1 + (rs.raise[p.id] ?? 0) / 100, n))) +
        (st.inc.other ?? 0);
  }
  const R = retirementIncome(d, s, rs.age);
  const v = sum(R.parts.filter((x) => x.kind !== 'ss' || y >= (x.start ?? 0))
      .map((x) => x.value));
  return v * (1 - fs.tax / 100);
}

/** Inflation multiplier for showing a year in future dollars (1 in today's dollars). */
export function deflator(d: Data, s: Settings, y: number): number {
  return s.fs.nominal ? Math.pow(1 + s.rs.inf / 100, y - d.todayYear) : 1;
}

/** Monthly spending today (planned, after credits, plus tax set-aside). */
export function spendToday(d: Data, st: PlannerState): number {
  return regularMo(d, st) - creditsMo(d, st) + taxMo(d, st);
}

// ---------- comparing scenarios ----------

/** A result row: [label, value, good direction (1, -1 or 0), kind] or a heading [label, null]. */
export type ResultRow = [string, number|null, number?, string?];

/** Key results for settings, grouped under headings, computed with the same model. */
export function results(d: Data, s: Settings): ResultRow[] {
  const b = budget(d, s.st);
  const ry = retireYear(d, s.rs);
  const R = retirementIncome(d, s, s.rs.age);
  const net = 1 - s.fs.tax / 100;
  const spR = spendAt(d, s, ry).spend;
  const stage = (y: number) => {
    const x = spendAt(d, s, y);
    return incomeAt(d, s, y) - x.spend - x.savings;
  };
  const rows: ResultRow[] = [
    ['Monthly budget today', null],
    ['Take-home income', b.income, 1], ['Spending (net)', b.spend, -1],
    ['Savings', b.savings, 0], ['Investing', b.investing, 0], ['Tax set-aside', b.tax, -1],
    ['Left over each month', b.left, 1], ['Left over each year', b.left * 12, 1],
    ['Before retirement', null],
  ];
  d.children.forEach((c, k) => {
    const y = Math.floor(d.gradT(k)) + 1;
    rows.push([`Left over, ${c.name} out (${y})`, y < ry ? stage(y) : NaN, 1]);
  });
  rows.push(['College 529s', null]);
  d.children.forEach((c, k) => {
    const x = kidCalc(d, s, k);
    rows.push([`${c.name}: share of college covered`, Math.round(x.pct * 100), 1, 'pct']);
    rows.push([`${c.name}: surplus / shortfall, today's $`, x.today, 1]);
  });
  rows.push(['Retirement', null],
            [`Retirement age (${d.primary.name})`, s.rs.age, 0, 'age'],
            ['First full year retired', ry, 0, 'year'],
            ['Income after tax, at retirement', R.total * net, 1],
            ['Income after tax, once all Social Security starts', R.full * net, 1],
            ['Projected spending in retirement', spR, -1],
            ['Gap / surplus at retirement', R.total * net - spR, 1],
            ['Gap / surplus, long run', R.full * net - spR, 1]);
  return rows;
}

/** A setting that differs: [label, value A, value B, path, section]. */
export type SettingDiff = [string, string, string, string[], 'budget'|'college'|'retire'];

/**
 * Settings that differ between two snapshots, with readable labels and values.
 * @param d The data.
 * @param A First settings.
 * @param B Second settings.
 */
export function diffSettings(d: Data, A: Settings, B: Settings): SettingDiff[] {
  const a = new Map(flatten(A));
  const b = new Map(flatten(B));
  const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => !SKIP.has(k));
  const out: SettingDiff[] = [];
  for (const key of keys) {
    const x = a.get(key);
    const y = b.get(key);
    const path = JSON.parse(key) as string[];
    const pct = isPct(path);
    const differs = typeof x === 'number' && typeof y === 'number' ?
        (Math.abs(x - y) >= 0.5 || (pct && x !== y)) : !same(x, y);
    if (!differs) continue;
    out.push([settingLabel(d, path), settingVal(d, path, x), settingVal(d, path, y), path,
              sectionOf(path)]);
  }
  return out;
}

/** A readable name for a settings path. */
export function settingLabel(d: Data, path: string[]): string {
  const [g, k, sub, leaf] = path;
  const who = (id: string) => d.partners.find((p) => p.id === id)?.name ?? id;
  const kid = (id: string) => d.children.find((c) => c.id === id)?.name ?? id;
  const catLabel = (n: string) => d.cats[d.idx(n)]?.label ?? n;
  const pensionName = (key: string) => {
    const [pid, i] = key.split(':');
    return d.partners.find((p) => p.id === pid)?.pensions[+i]?.name ?? key;
  };
  const accountName = (key: string) => {
    const [pid, i] = key.split(':');
    return d.partners.find((p) => p.id === pid)?.accounts[+i]?.name ?? key;
  };
  if (g === 'st') {
    if (k === 'inc') return sub === 'other' ? 'Other income' : `${who(sub)} take-home`;
    if (k === 'sav') {
      const [type, id] = [sub.slice(0, sub.indexOf(':')), sub.slice(sub.indexOf(':') + 1)];
      if (type === '529') return `529, ${kid(id)}`;
      const list = type === 'inv' ? d.p.investments : d.p.savings;
      const name = list.find((x) => x.id === id)?.name ?? id;
      return type === 'inv' ? `${name} per month` : name;
    }
    if (k === 'on') return catLabel(sub);
    if (k === 'plan') return `Planned: ${sub}`;
  }
  if (g === 'cs') {
    const what: Record<string, string> = {school: 'school', cost: 'cost per year',
      ret: '529 return', inf: 'college cost inflation'};
    return `${kid(k)}: ${what[sub] ?? sub}`;
  }
  if (g === 'rs') {
    const simple: Record<string, string> = {age: 'Retirement age', ret: 'Investment return',
      inf: 'Inflation', wd: 'Yearly withdrawal', ss: 'Social Security'};
    if (simple[k]) return simple[k];
    if (k === 'raise') return `${who(sub)} yearly raise`;
    if (k === 'ssAmt') return `${who(sub)} Social Security at 67`;
    if (k === 'claim') return `${who(sub)} claims Social Security at`;
    if (k === 'pen') {
      return `${pensionName(sub)}: ${leaf === 'on' ? 'included' :
          leaf === 'monthly' ? 'monthly' : `estimate at ${path[4]}`}`;
    }
    if (k === 'acct') {
      return `${accountName(sub)}: ${{on: 'included', bal: 'balance', monthly: 'per month'}[
          leaf] ?? leaf}`;
    }
    if (k === 'inv') {
      const name = d.p.investments.find((x) => x.id === sub)?.name ?? sub;
      return `${name}: ${leaf === 'bal' ? 'balance today' : 'return'}`;
    }
  }
  if (g === 'fs') {
    if (k === 'kg') return `Kids-gone change: ${sub}`;
    if (k === 'rt') return `Retirement change: ${sub}`;
    if (k === 'health') return 'Retiree health insurance';
    if (k === 'tax') return 'Retirement tax rate';
  }
  return path.join(' › ');
}

/** A readable value for a settings path. */
export function settingVal(d: Data, path: string[], v: unknown): string {
  if (v === undefined) return '–';
  if (v === null) return 'at retirement';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (path[0] === 'cs' && path[2] === 'school') {
    return d.p.assumptions.college.schools[String(v)]?.name ?? String(v);
  }
  if (typeof v !== 'number') return String(v);
  if (path[0] === 'fs' && (path[1] === 'kg' || path[1] === 'rt')) return `${v > 0 ? '+' : ''}${v}%`;
  if (isPct(path)) return `${v}%`;
  if (['age', 'claim'].includes(path[1])) return String(v);
  return `${d.p.plan.currency_symbol}${Math.round(v).toLocaleString('en-US')}`;
}

/** Which compare card a setting belongs to. */
export function sectionOf(path: string[]): 'budget'|'college'|'retire' {
  if (path[0] === 'cs') return 'college';
  if (path[0] === 'rs' || path[0] === 'fs') return 'retire';
  return 'budget';
}

/**
 * A compact form of a scenario for share codes: only values that differ from the defaults.
 * @param d The data.
 * @param sc The scenario.
 */
export function compact(d: Data, sc: {id: string; name: string; saved: string} & Settings):
    {id: string; name: string; saved: string; d: Array<[string[], unknown]>} {
  const defs = new Map(flatten(defaults(d)));
  const out: Array<[string[], unknown]> = [];
  for (const [key, v] of flatten({st: sc.st, cs: sc.cs, rs: sc.rs, fs: sc.fs})) {
    if (SKIP.has(key)) continue;
    const def = defs.get(key);
    const differs = typeof v === 'number' && typeof def === 'number' ?
        Math.abs(v - def) > 0.004 : !same(v, def);
    if (differs) out.push([JSON.parse(key), typeof v === 'number' ? Math.round(v * 100) / 100 : v]);
  }
  return {id: sc.id, name: sc.name, saved: sc.saved, d: out};
}

/** Rebuilds full settings from a compact scenario (unknown paths are ignored). */
export function expand(d: Data, c: {d?: Array<[string[], unknown]>}): Settings {
  const defs = defaults(d);
  const out = clone(defs) as unknown as Record<string, unknown>;
  const known = new Set(flatten(defs).map(([k]) => k));
  (c.d ?? []).forEach(([path, v]) => {
    if (known.has(JSON.stringify(path))) setPath(out, path, v);
  });
  return out as unknown as Settings;
}

//
// INTERNAL
//
const SKIP = new Set([JSON.stringify(['fs', 'nominal'])]);
const PCT_KEYS = new Set(['raise', 'ret', 'inf', 'wd', 'tax']);

/** Whether a settings path holds a percentage. */
function isPct(path: string[]): boolean {
  if (path[0] === 'rs' && path[1] === 'inv') return path[3] === 'ret';
  if (path[0] === 'cs') return path[2] === 'ret' || path[2] === 'inf';
  return path[0] !== 'st' && PCT_KEYS.has(path[1]);
}

/** Equality for leaf values. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
