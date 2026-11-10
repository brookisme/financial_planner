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
import type {Category, Child, ChildTimeline, Contribution, CostKind, FutureState, Partner,
             Payload, PlannerState, RetireState, SavingsAccount, SavLine,
             Settings} from './types';

//
// CONSTANTS
//

/** Social Security benefit as a share of the age-67 amount, by claiming age. */
export const SS_FACTORS: Record<number, number> = {
  62: 0.70, 63: 0.75, 64: 0.80, 65: 0.8667, 66: 0.9333, 67: 1, 68: 1.08, 69: 1.16, 70: 1.24,
};
/** Years of the long-range projection. */
export const PROJECTION_YEARS = 35;
/** Category kinds kept out of the averages, each with its own planner panel. */
export const COST_KINDS: CostKind[] = ['annual', 'one_time', 'emergency'];

//
// PUBLIC
//

/** Indexed, derived view of the payload. */
export class Data {
  readonly n: number;
  readonly cats: Category[];
  readonly byCat: number[][];
  readonly regular: number[];
  readonly annual: number[];
  readonly oneTime: number[];
  readonly emergency: number[];
  readonly costs: number[];
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
    this.annual = kind('annual');
    this.oneTime = kind('one_time');
    this.emergency = kind('emergency');
    this.costs = [...this.annual, ...this.oneTime, ...this.emergency];
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
      retirement_age: null, pensions: [], accounts: []};
  }

  /** Credit categories that offset a given category. */
  offsetsOf(name: string): number[] {
    return this.credits.filter((i) => this.cats[i].offsets === name);
  }

  /**
   * Whether a credit is planned in budgets (it reduces spending). Credits against 1-time or
   * emergency costs are not: budgets have no line for those costs.
   */
  isPlannerCredit(i: number): boolean {
    const k = this.cats[this.idx(this.cats[i].offsets ?? '')]?.kind;
    return k !== 'one_time' && k !== 'emergency';
  }

  /** Emergency funds (they pay for emergency costs, in config order). */
  get funds(): SavingsAccount[] {
    return this.p.savings.filter((s) => s.type === 'emergency');
  }

  /** Every contribution key: 529s, then savings, then investments. */
  get savKeys(): string[] {
    return [...this.children.map((c) => `529:${c.id}`), ...this.p.savings.map((s) => `sav:${s.id}`),
      ...this.p.investments.map((v) => `inv:${v.id}`)];
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
  const st: PlannerState = {inc: {}, sav: {}, on: {}, plan: {},
    annual: d.annual.map((i) => ({name: d.cats[i].name, amt: Math.round(d.avg(i) * 12)})),
    emerg: null};
  d.partners.forEach((x) => st.inc[x.id] = x.take_home_monthly);
  st.inc.other = p.other_income_monthly;
  d.children.forEach((c) => st.sav[`529:${c.id}`] = savLine(c.college_529));
  p.savings.forEach((s) => st.sav[`sav:${s.id}`] = savLine(s));
  p.investments.forEach((v) => st.sav[`inv:${v.id}`] = savLine(v));
  d.credits.forEach((i) => st.on[d.cats[i].name] = d.cats[i].default_on);
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
  const rs: RetireState = {age: d.partners[0]?.retirement_age ?? ra.default_age,
    ret: ra.return_pct, inf: ra.inflation_pct, wd: ra.withdrawal_pct, ss: true, ages: {},
    raise: {}, ssAmt: {}, claim: {}, pen: {}, acct: {}, inv: {}, draw: {}};
  d.partners.forEach((x, i) => {
    if (i > 0) rs.ages[x.id] = x.retirement_age ?? null;
    rs.raise[x.id] = x.raise_pct;
    rs.ssAmt[x.id] = x.social_security.at_67;
    rs.claim[x.id] = x.social_security.claim_age;
    x.pensions.forEach((pn, i) => rs.pen[`${x.id}:${i}`] = {on: true, est: {...pn.estimates},
      monthly: pn.monthly});
    x.accounts.forEach((a, i) => {
      rs.acct[`${x.id}:${i}`] = {on: true, bal: a.balance, monthly: a.monthly};
      rs.draw[`acct:${x.id}:${i}`] = null;
    });
  });
  p.investments.forEach((v) => {
    rs.inv[v.id] = {bal: v.balance, ret: v.return_pct};
    rs.draw[`inv:${v.id}`] = null;
  });
  retireSavings(d).forEach((s) => rs.draw[`sav:${s.id}`] = null);
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
  saved = upgrade(saved);
  base = base && upgrade(base);
  const baseMap = new Map(flatten(base ?? {}).map(([k, v]) => [k, v]));
  const defMap = new Map(flatten(defs).map(([k, v]) => [k, v]));
  for (const [key, value] of flatten(saved)) {
    if (!defMap.has(key)) continue;
    if (base && baseMap.has(key) && same(baseMap.get(key), value)) continue;
    setPath(out as unknown as Record<string, unknown>, JSON.parse(key), value);
  }
  return out;
}

/**
 * A saved budget's planner settings on top of the current defaults (see rebase).
 * @param defs Current planner defaults.
 * @param saved The budget's settings.
 * @param base The planner defaults when it was saved.
 */
export function rebaseBudget(defs: PlannerState, saved: PlannerState,
                             base?: PlannerState|null): PlannerState {
  const wrap = (st: PlannerState) => ({st}) as unknown as Settings;
  return rebase(wrap(defs), wrap(saved), base ? wrap(base) : null).st;
}

/** Budget settings that differ between two budgets (see diffSettings). */
export function diffBudget(d: Data, a: PlannerState, b: PlannerState): SettingDiff[] {
  const wrap = (st: PlannerState) => ({st}) as unknown as Settings;
  return diffSettings(d, wrap(a), wrap(b));
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

/**
 * The line under the title when plan.subtitle is empty: which sources (by configured name) the
 * numbers come from, how many transactions over which months, and where take-home pay came from.
 * @param p The payload.
 */
export function describeData(p: Payload): string {
  const counts = new Map<number, number>();
  p.tx.forEach((t) => counts.set(t[4], (counts.get(t[4]) ?? 0) + 1));
  const used = p.sources.filter((_, i) => counts.get(i));
  if (!used.length) return 'No transactions yet: add your CSV exports in Settings › Data sources.';
  const list = (xs: string[]) => xs.length < 2 ? xs.join('') :
      `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  const months = p.month_labels;
  let s = `Built from ${list(used)} (${p.tx.length.toLocaleString('en-US')} transactions, ${
      months[0]} – ${months[months.length - 1]}).`;
  const notes = p.household.partners.filter((x) => x.take_home_note)
      .map((x) => `${x.name} (${x.take_home_note})`);
  if (notes.length) s += ` Take-home pay: ${notes.join(', ')}.`;
  return `${s} Change any number in Budgeting to see what it does to the month.`;
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

/** A cost category's monthly amount net of any toggled-on credits nested under it. */
export function oneTimeNet(d: Data, st: PlannerState, i: number): number {
  const off = d.offsetsOf(d.cats[i].name).filter((c) => st.on[d.cats[c].name]);
  return d.avg(i) - sum(off.map((c) => d.credAvg(c)));
}

/** Annual expenses per month: the budget's yearly list ÷ 12. */
export function annualMo(st: PlannerState): number {
  return sum((st.annual ?? []).map((a) => a.amt)) / 12;
}

/**
 * Emergency fund costs per month: the budget's number, or (when empty) what goes into the
 * emergency funds, so by default they neither grow nor shrink.
 */
export function emergencyMo(d: Data, st: PlannerState): number {
  return budget(d, st).emergency;
}

/** Take-home income per month. */
export function incomeMo(st: PlannerState): number {
  return sum(Object.values(st.inc));
}

/** A planner contribution line from a config entry. */
export function savLine(c: Contribution): SavLine {
  return {mode: c.rest ? 'rest' : c.left_pct == null ? 'fixed' : 'pct', amt: c.monthly,
    pct: c.left_pct ?? 0, min: c.min_monthly, max: c.max_monthly};
}

/**
 * Splits what is free each month between contribution lines. Fixed lines come off first; every
 * percent line then takes its share of what remains (the same base for all of them), kept between
 * its min and max; 'rest' lines split whatever is still left evenly.
 * @param lines [key, line] pairs that are contributing this month.
 * @param free Income minus spending and taxes.
 * @return Amount per key and what is left over after all of them.
 */
export function contributions(lines: Array<[string, SavLine|undefined]>, free: number):
    {amt: Record<string, number>; left: number} {
  const amt: Record<string, number> = {};
  let base = free;
  lines.forEach(([k, l]) => {
    if (l && l.mode !== 'pct' && l.mode !== 'rest') {
      amt[k] = l.amt;
      base -= l.amt;
    }
  });
  let left = base;
  lines.forEach(([k, l]) => {
    if (l?.mode !== 'pct') return;
    let v = Math.max(0, base) * l.pct / 100;
    if (l.min != null) v = Math.max(v, l.min);
    if (l.max != null) v = Math.min(v, l.max);
    amt[k] = v;
    left -= v;
  });
  const rest = lines.filter(([, l]) => l?.mode === 'rest');
  const share = rest.length ? Math.max(0, left) / rest.length : 0;
  rest.forEach(([k]) => {
    amt[k] = share;
    left -= share;
  });
  return {amt, left};
}

/** The investment a savings account sends contributions to once it reaches its max. */
export function overflowTarget(d: Data, sv: SavingsAccount): string|null {
  if (sv.max_balance == null) return null;
  return sv.overflow_to ?? d.p.investments[0]?.id ?? null;
}

/** One month on paper. */
export interface Budget {
  income: number;
  regular: number;
  credits: number;
  annual: number;
  emergency: number;
  spend: number;
  savings: number;
  investing: number;
  amt: Record<string, number>;
  overflow: Record<string, string>;
  left: number;
}

/**
 * The monthly budget. Spending is planned categories minus ticked credits; annual expenses are
 * the yearly list ÷ 12. Emergency fund costs are paid from the emergency funds (so they are not
 * in spending) unless there is no emergency fund. A savings account already at its max sends its
 * contribution to its overflow investment.
 */
export function budget(d: Data, st: PlannerState): Budget {
  const income = incomeMo(st);
  const regular = regularMo(d, st);
  const credits = creditsMo(d, st);
  const annual = annualMo(st);
  const spend = regular - credits + (d.funds.length ? 0 : st.emerg ?? 0);
  const {amt, left} = contributions(d.savKeys.map((k) => [k, st.sav[k]]), income - spend - annual);
  const emergency = st.emerg ?? sum(d.funds.map((f) => amt[`sav:${f.id}`] ?? 0));
  const overflow: Record<string, string> = {};
  d.p.savings.forEach((sv) => {
    const to = overflowTarget(d, sv);
    if (to && sv.balance >= sv.max_balance!) overflow[`sav:${sv.id}`] = to;
  });
  const isInv = (k: string) => k.startsWith('inv:') || k in overflow;
  const investing = sum(Object.entries(amt).filter(([k]) => isInv(k)).map(([, v]) => v));
  const savings = sum(Object.entries(amt).filter(([k]) => !isInv(k)).map(([, v]) => v));
  return {income, regular, credits, annual, emergency, spend, savings, investing, amt, overflow,
    left};
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
  const r = c.ret / 100;
  const g = c.inf / 100;
  const months = tl.months_to_graduation;
  const bal = simulate(d, s).at[`529:${child.id}`];
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

/** Savings accounts (not emergency funds) that become retirement income. */
export function retireSavings(d: Data): SavingsAccount[] {
  return d.p.savings.filter((s) => s.type === 'savings');
}

/** An account's yearly withdrawal % (its own, or the default). */
export function drawPct(rs: RetireState, key: string): number {
  return rs.draw?.[key] ?? rs.wd;
}

/** One income source at retirement. */
export interface IncomePart {
  kind: 'pension'|'account'|'investment'|'savings'|'ss';
  key: string;
  name: string;
  partner: string;
  value: number;
  balance?: number;
  invested?: number;
  yrs?: number;
  started: boolean;
  start?: number;
  claimAge?: number;
}

/** Retirement income once everyone has retired, for one primary retirement age. */
export interface RetireResult {
  age: number;
  yrs: number;
  year: number;
  years: Record<string, number>;
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

/**
 * A partner's retirement age: the slider for the primary partner, their own age if set, otherwise
 * the age they are when the primary partner retires (same year).
 * @param d The data.
 * @param rs Retirement settings.
 * @param p The partner.
 * @param a Primary partner's retirement age (defaults to the slider).
 */
export function partnerRetireAge(d: Data, rs: RetireState, p: Partner, a = rs.age): number {
  if (p.id === d.primary.id) return a;
  const own = rs.ages?.[p.id];
  return own == null ? ageWhen(d, p, a) : own;
}

/** First full calendar year a partner is retired. */
export function partnerRetireYear(d: Data, rs: RetireState, p: Partner, a = rs.age): number {
  const own = p.id === d.primary.id ? null : rs.ages?.[p.id];
  return own == null ? Math.round(d.todayYear - d.primary.age) + 1 + a :
      Math.round(d.todayYear - p.age) + 1 + own;
}

/** First full calendar year everyone is retired (spending switches to retirement). */
export function retireYear(d: Data, rs: RetireState, a = rs.age): number {
  const first = Math.round(d.todayYear - d.primary.age) + 1 + a;
  return Math.max(first, ...d.partners.map((p) => partnerRetireYear(d, rs, p, a)));
}

/**
 * Monthly retirement income (today's dollars, before tax) once everyone has retired, if the
 * primary partner retires at a. Each partner's pensions and accounts follow their own retirement
 * age; investments use their simulated balances (see simulate).
 * @param d The data.
 * @param s Settings.
 * @param a Primary partner's retirement age.
 */
export function retirementIncome(d: Data, s: Settings, a: number): RetireResult {
  const base = baseRetirement(d, s, a);
  const sim = simulate(d, s, a);
  const inv = investmentParts(d, s, base.yrs, sim.at, sim.paid);
  const parts = [...base.parts.filter((x) => x.kind !== 'ss'), ...inv,
    ...base.parts.filter((x) => x.kind === 'ss')];
  const total = sum(parts.filter((x) => x.started).map((x) => x.value));
  const pending = parts.filter((x) => !x.started);
  const later = sum(pending.map((x) => x.value));
  return {...base, parts, total, later, full: total + later,
    fullYear: Math.max(0, ...pending.map((x) => x.start ?? 0))};
}

/**
 * What the retirement accounts, investments and savings account add up to when the last partner
 * retires: the money put in (balances today plus every contribution) and the estimated total
 * with returns, in dollars of that year and in today's dollars.
 */
export function retirementSavings(d: Data, s: Settings, a = s.rs.age):
    {invested: number; total: number; today: number; year: number} {
  const R = retirementIncome(d, s, a);
  const parts = R.parts.filter((x) => x.balance !== undefined);
  const total = sum(parts.map((x) => x.balance!));
  return {invested: sum(parts.map((x) => x.invested ?? 0)), total,
    today: sum(parts.map((x) => x.balance! / Math.pow(1 + s.rs.inf / 100, x.yrs ?? R.yrs))),
    year: R.year};
}

/** One year of the long-range projection (monthly amounts, today's dollars). */
export interface YearSpend {
  y: number;
  kids: number;
  ret: boolean;
  cats: Record<string, number>;
  living: number;
  annual: number;
  health: number;
  emergency: number;
  short: number;
  spend: number;
  savings: number;
}

/**
 * Monthly spending in a calendar year: categories change as children leave home (partly while
 * some are still home) and again after retiring; credits and contributions stop on schedule.
 * Emergency costs come out of the emergency funds; only what the funds can't cover (`short`) is
 * in `spend`. `savings` is what the simulation puts into 529s, savings and investments.
 * @param d The data.
 * @param s Settings.
 * @param y Calendar year.
 */
export function spendAt(d: Data, s: Settings, y: number): YearSpend {
  const x = spendingAt(d, s, y, retireYear(d, s.rs));
  const sy = simulate(d, s).years.get(y);
  const short = sy?.short ?? 0;
  return {...x, short, spend: x.spend + short, savings: sy?.saved ?? 0};
}

/**
 * Take-home income per month in a calendar year: each partner's pay grows with real raises until
 * they retire, then their pensions and accounts pay out (after tax), with Social Security added
 * from each claim year. Other income and investments switch over once everyone has retired.
 */
export function incomeAt(d: Data, s: Settings, y: number): number {
  return incomeFrom(d, s, retirementIncome(d, s, s.rs.age), y);
}

// ---------- balances over time ----------

/** One calendar year of the simulation (monthly averages over the months simulated). */
export interface SimYear {
  y: number;
  months: number;
  saved: number;
  contrib: Record<string, number>;
  overflow: number;
  emergency: number;
  short: number;
  left: number;
  bal: Record<string, number>;
}

/** Month-by-month balances of every 529, savings account and investment. */
export interface Sim {
  years: Map<number, SimYear>;
  at: Record<string, number>;
  paid: Record<string, number>;
  full: Record<string, number|null>;
}

/**
 * Runs every contribution account month by month from today, for a primary retirement age.
 * Each month: balances grow at their own rate; emergency costs are paid from the emergency funds
 * (what they can't cover reduces that month's left-over); contributions are split with
 * `contributions` from that year's income minus spending; a savings account at its max sends the
 * rest to its overflow investment. 529s stop at graduation, investments and savings marked
 * stops_at_retirement stop once everyone has retired.
 *
 * `at` holds each 529's balance at graduation and each investment's when the last partner
 * retires; `full` the year each savings account with a max first reaches it (null: never).
 * @param d The data.
 * @param s Settings.
 * @param a Primary partner's retirement age.
 */
export function simulate(d: Data, s: Settings, a = s.rs.age): Sim {
  const key = JSON.stringify([s.st, s.cs, s.rs, s.fs.health, s.fs.tax, s.fs.kg, s.fs.rt, a]);
  let memo = SIM_CACHE.get(d);
  if (!memo) SIM_CACHE.set(d, memo = new Map());
  const hit = memo.get(key);
  if (hit) return hit;
  const {st, rs, cs} = s;
  const base = baseRetirement(d, s, a);
  const RY = base.year;
  const invMonth = Math.round(base.yrs * 12);
  const start = d.todayMonth - 1;
  const n = (Math.max(d.todayYear + PROJECTION_YEARS, RY + 1) - d.todayYear) * 12 - start;
  const mr = (pct: number) => Math.pow(1 + pct / 100, 1 / 12) - 1;
  interface Acct {key: string; bal: number; i: number; until: number; stops: boolean;
                  cap: number|null; to: string|null; fund: boolean}
  const accts: Acct[] = [
    ...d.children.map((c, k) => ({key: `529:${c.id}`, bal: c.college_529.balance,
      i: mr(cs[c.id]?.ret ?? 0), until: d.timelines[k].months_to_graduation, stops: false,
      cap: null, to: null, fund: false})),
    ...d.p.savings.map((sv) => {
      const to = overflowTarget(d, sv);
      return {key: `sav:${sv.id}`, bal: sv.balance, i: mr(sv.return_pct), until: Infinity,
        stops: sv.stops_at_retirement, cap: sv.max_balance, to: to && `inv:${to}`,
        fund: sv.type === 'emergency'};
    }),
    ...d.p.investments.map((v) => ({key: `inv:${v.id}`, bal: rs.inv[v.id]?.bal ?? v.balance,
      i: mr(rs.inv[v.id]?.ret ?? v.return_pct), until: Infinity, stops: true, cap: null,
      to: null, fund: false})),
  ];
  const byKey = new Map(accts.map((x) => [x.key, x]));
  const at: Record<string, number> = {};
  const full: Record<string, number|null> = {};
  accts.forEach((x) => {
    if (x.cap != null) full[x.key] = x.bal >= x.cap - 0.5 ? d.todayYear : null;
  });
  const years = new Map<number, SimYear>();
  let inv: IncomePart[]|null = null;
  const flows = new Map<number, {free: number; emergency: number}>();
  const flowsAt = (y: number) => {
    let f = flows.get(y);
    if (!f) {
      const x = spendingAt(d, s, y, RY);
      if (y >= RY && !inv) {
        snapshot('inv:');
        inv = investmentParts(d, s, base.yrs, snapshot('sav:'));
      }
      const income = incomeFrom(d, s, {...base, parts: [...base.parts, ...(inv ?? [])]}, y);
      f = {free: income - x.spend, emergency: x.emergency};
      flows.set(y, f);
    }
    return f;
  };
  const put: Record<string, number> = Object.fromEntries(accts.map((x) => [x.key, x.bal]));
  const paid: Record<string, number> = {};
  const snapshot = (prefix: string) => {
    accts.filter((x) => x.key.startsWith(prefix) && !(x.key in at)).forEach((x) => {
      at[x.key] = x.bal;
      paid[x.key] = put[x.key];
    });
    return at;
  };
  for (let m = 0; m < n; m++) {
    const y = d.todayYear + Math.floor((start + m) / 12);
    const ret = y >= RY;
    accts.forEach((x) => {
      if (x.key.startsWith('529:') && m === x.until) at[x.key] = x.bal;
    });
    if (m === invMonth) {
      snapshot('inv:');
      snapshot('sav:');
    }
    const f = flowsAt(y);
    let need = f.emergency;
    accts.filter((x) => x.fund).forEach((x) => {
      const take = Math.min(Math.max(0, x.bal), need);
      x.bal -= take;
      need -= take;
    });
    const active = accts.filter((x) => m < x.until && !(ret && x.stops));
    const c = contributions(active.map((x) => [x.key, st.sav[x.key]]), f.free - need);
    accts.forEach((x) => x.bal *= 1 + x.i);
    let overflow = 0;
    let kept = 0;
    active.forEach((x) => {
      let v = c.amt[x.key] ?? 0;
      if (x.cap != null) {
        const into = Math.max(0, Math.min(v, x.cap - x.bal));
        const spill = v - into;
        v = into;
        const target = x.to ? byKey.get(x.to) : undefined;
        if (spill > 0 && target) {
          target.bal += spill;
          put[target.key] += spill;
          overflow += spill;
        } else {
          kept += spill;
        }
      }
      x.bal += v;
      put[x.key] += v;
      if (x.cap != null && full[x.key] == null && x.bal >= x.cap - 0.5) full[x.key] = y;
    });
    let yr = years.get(y);
    if (!yr) {
      yr = {y, months: 0, saved: 0, contrib: {}, overflow: 0, emergency: 0, short: 0, left: 0,
        bal: {}};
      years.set(y, yr);
    }
    yr.months++;
    Object.entries(c.amt).forEach(([k, v]) => yr!.contrib[k] = (yr!.contrib[k] ?? 0) + v);
    yr.saved += sum(Object.values(c.amt)) - kept;
    yr.overflow += overflow;
    yr.emergency += f.emergency - need;
    yr.short += need;
    yr.left += c.left + kept;
    accts.forEach((x) => yr!.bal[x.key] = x.bal);
  }
  accts.forEach((x) => {
    if (!(x.key in at)) at[x.key] = x.bal;
    if (!(x.key in paid)) paid[x.key] = put[x.key];
  });
  years.forEach((yr) => {
    const k = yr.months;
    Object.keys(yr.contrib).forEach((c) => yr.contrib[c] /= k);
    yr.saved /= k;
    yr.overflow /= k;
    yr.emergency /= k;
    yr.short /= k;
    yr.left /= k;
  });
  const sim = {years, at, paid, full};
  if (memo.size > 200) memo.clear();
  memo.set(key, sim);
  return sim;
}

/** Inflation multiplier for showing a year in future dollars (1 in today's dollars). */
export function deflator(d: Data, s: Settings, y: number): number {
  return s.fs.nominal ? Math.pow(1 + s.rs.inf / 100, y - d.todayYear) : 1;
}

/** Monthly spending today (planned, after credits, plus annual expenses). */
export function spendToday(d: Data, st: PlannerState): number {
  return regularMo(d, st) - creditsMo(d, st) + annualMo(st);
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
    ['Savings', b.savings, 0], ['Investing', b.investing, 0], ['Annual expenses', b.annual, -1],
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
  rows.push(['Retirement', null]);
  d.partners.forEach((p) => rows.push([d.partners.length > 1 ?
      `Retirement age (${p.name})` : 'Retirement age', R.ages[p.id], 0, 'age']));
  rows.push(['First full year retired', ry, 0, 'year'],
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
      const list: Array<{id: string; name: string}> = type === 'inv' ? d.p.investments :
          d.p.savings;
      const name = type === '529' ? `529, ${kid(id)}` : list.find((x) => x.id === id)?.name ?? id;
      const what: Record<string, string> = {mode: 'contribution', amt: 'per month',
        pct: 'share of left-over', min: 'at least per month', max: 'at most per month'};
      return `${name}: ${what[leaf] ?? leaf}`;
    }
    if (k === 'on') return catLabel(sub);
    if (k === 'annual') return 'Annual expenses';
    if (k === 'emerg') return 'Emergency fund costs / mo';
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
    if (k === 'ages') return `${who(sub)} retirement age`;
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
    if (k === 'draw') {
      const [kind, ...rest] = sub.split(':');
      const id = rest.join(':');
      const name = kind === 'acct' ? accountName(id) : kind === 'inv' ?
          d.p.investments.find((x) => x.id === id)?.name ?? id :
          d.p.savings.find((x) => x.id === id)?.name ?? id;
      return `${name}: yearly withdrawal`;
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
  if (Array.isArray(v)) {
    const total = sum(v.map((x: {amt: number}) => x.amt));
    return `${v.length} item${v.length === 1 ? '' : 's'}, ${d.p.plan.currency_symbol}${
        Math.round(total).toLocaleString('en-US')}/yr`;
  }
  if (v === null) {
    if (path[1] === 'sav') return 'none';
    if (path[1] === 'emerg') return 'same as the fund contribution';
    if (path[1] === 'draw') return 'the default rate';
    return path[1] === 'ages' ? `same year as ${d.primary.name}` : 'at retirement';
  }
  if (path[1] === 'sav' && path[3] === 'mode') {
    return v === 'pct' ? '% of left-over' : v === 'rest' ? 'the rest' : 'fixed';
  }
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (path[0] === 'cs' && path[2] === 'school') {
    return d.p.assumptions.college.schools[String(v)]?.name ?? String(v);
  }
  if (typeof v !== 'number') return String(v);
  if (path[0] === 'fs' && (path[1] === 'kg' || path[1] === 'rt')) return `${v > 0 ? '+' : ''}${v}%`;
  if (isPct(path)) return `${v}%`;
  if (['age', 'ages', 'claim'].includes(path[1])) return String(v);
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
    if (path[1] === 'sav' && path.length === 3 && typeof v === 'number') path = [...path, 'amt'];
    if (known.has(JSON.stringify(path))) setPath(out, path, v);
  });
  return out as unknown as Settings;
}

//
// INTERNAL
//
const SIM_CACHE = new WeakMap<Data, Map<string, Sim>>();
const SKIP = new Set([JSON.stringify(['fs', 'nominal'])]);
const PCT_KEYS = new Set(['raise', 'ret', 'inf', 'wd', 'tax', 'draw']);

/** Whether a settings path holds a percentage. */
function isPct(path: string[]): boolean {
  if (path[0] === 'rs' && path[1] === 'inv') return path[3] === 'ret';
  if (path[0] === 'cs') return path[2] === 'ret' || path[2] === 'inf';
  if (path[1] === 'sav') return path[3] === 'pct';
  return path[0] !== 'st' && PCT_KEYS.has(path[1]);
}

/** Equality for leaf values. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Settings saved before contributions had modes: plain numbers become fixed lines. */
function upgrade<T extends Partial<Settings>>(s: T): T {
  const sav = s.st?.sav as Record<string, unknown>|undefined;
  if (!sav || !Object.values(sav).some((v) => typeof v === 'number')) return s;
  const out = clone(s);
  const o = out.st!.sav as Record<string, unknown>;
  Object.entries(o).forEach(([k, v]) => {
    if (typeof v === 'number') o[k] = {mode: 'fixed', amt: v};
  });
  return out;
}

/**
 * Retirement income without the investments: pensions, accounts and Social Security, with each
 * partner's retirement age and year.
 */
function baseRetirement(d: Data, s: Settings, a: number):
    Pick<RetireResult, 'age'|'yrs'|'year'|'years'|'ages'|'parts'> {
  const rs = s.rs;
  const year = retireYear(d, rs, a);
  const yrs = Math.max(a - d.primary.age, ...d.partners.map((p) =>
      partnerRetireAge(d, rs, p, a) - p.age));
  const r = rs.ret / 100;
  const real = (y: number) => Math.pow(1 + rs.inf / 100, y);
  const parts: IncomePart[] = [];
  const ages: Record<string, number> = {};
  const years: Record<string, number> = {};
  d.partners.forEach((p) => {
    const ageR = partnerRetireAge(d, rs, p, a);
    const pYrs = ageR - p.age;
    ages[p.id] = ageR;
    years[p.id] = partnerRetireYear(d, rs, p, a);
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
      const bal = fv(st.bal, st.monthly, Math.round(pYrs * 12), r);
      const w = drawPct(rs, `acct:${key}`) / 100 / 12;
      parts.push({kind: 'account', key, name: ac.name, partner: p.id, value: bal / real(pYrs) * w,
        balance: bal, invested: st.bal + st.monthly * Math.round(pYrs * 12), yrs: pYrs,
        started: true});
    });
  });
  if (rs.ss) {
    d.partners.forEach((p) => {
      const ageR = ages[p.id];
      const want = rs.claim[p.id];
      const claimAge = want == null ? Math.max(62, ageR) : Math.min(70, Math.max(want, ageR));
      const value = (rs.ssAmt[p.id] ?? 0) * ssFactor(claimAge);
      if (!value) return;
      const ageThen = ageR + year - years[p.id];
      parts.push({kind: 'ss', key: p.id, name: `${p.name} Social Security`, partner: p.id, value,
        started: ageThen >= claimAge - 0.01, claimAge,
        start: yearAtAge(d, p, Math.ceil(claimAge - 0.01))});
    });
  }
  return {age: a, yrs, year, years, ages, parts};
}

/**
 * Investment and savings-account income from balances at retirement (keys inv:<id>, sav:<id>),
 * each at its own withdrawal rate.
 */
function investmentParts(d: Data, s: Settings, yrs: number, bals: Record<string, number>,
                         paid: Record<string, number> = {}): IncomePart[] {
  const real = Math.pow(1 + s.rs.inf / 100, yrs);
  const out: IncomePart[] = [];
  const add = (kind: 'investment'|'savings', id: string, name: string) => {
    const key = `${kind === 'investment' ? 'inv' : 'sav'}:${id}`;
    const bal = bals[key] ?? 0;
    if (bal <= 0) return;
    out.push({kind, key: id, name, partner: '', value: bal / real * drawPct(s.rs, key) / 100 / 12,
      balance: bal, invested: paid[key], yrs, started: true});
  };
  d.p.investments.forEach((v) => {
    if (s.rs.inv[v.id]) add('investment', v.id, v.name);
  });
  retireSavings(d).forEach((sv) => add('savings', sv.id, sv.name));
  return out;
}

/** Take-home income in a year from retirement results (see incomeAt). */
function incomeFrom(d: Data, s: Settings, R: Pick<RetireResult, 'year'|'years'|'parts'>,
                    y: number): number {
  const {st, rs, fs} = s;
  const n = Math.max(0, y - d.todayYear);
  const pay = sum(d.partners.filter((p) => y < R.years[p.id]).map((p) =>
      (st.inc[p.id] ?? 0) * Math.pow(1 + (rs.raise[p.id] ?? 0) / 100, n))) +
      (y < R.year ? st.inc.other ?? 0 : 0);
  const paid = sum(R.parts.filter((x) => x.kind === 'investment' || x.kind === 'savings' ?
      y >= R.year :
      y >= R.years[x.partner] && (x.kind !== 'ss' || y >= (x.start ?? 0))).map((x) => x.value));
  return pay + paid * (1 - fs.tax / 100);
}

/** Spending in a year, without contributions (see spendAt). */
function spendingAt(d: Data, s: Settings, y: number, retYear: number):
    Omit<YearSpend, 'savings'|'short'> {
  const {st, fs} = s;
  const t = y + 0.5;
  const total = d.children.length;
  const kids = d.children.filter((_, k) => t < d.gradT(k)).length;
  const gone = total ? (total - kids) / total : 0;
  const ret = y >= retYear;
  const cats: Record<string, number> = {};
  let living = 0;
  d.regular.forEach((i) => {
    const n = d.cats[i].name;
    let v = (st.plan[n] ?? 0) * Math.max(0, 1 + gone * (fs.kg[n] ?? 0) / 100);
    if (ret) v *= Math.max(0, 1 + (fs.rt[n] ?? 0) / 100);
    cats[n] = v;
    living += v;
  });
  const em = emergencyMo(d, st);
  living += -creditsMo(d, st, ret) + (d.funds.length ? 0 : em);
  const annual = annualMo(st);
  const health = ret ? fs.health : 0;
  return {y, kids, ret, cats, living, annual, health, emergency: d.funds.length ? em : 0,
    spend: living + annual + health};
}
