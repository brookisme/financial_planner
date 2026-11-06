/**
 * @fileoverview Types shared by the model and the UI: the payload the server sends and the four
 * groups of adjustable settings (planner, college, retirement, spending over time).
 *
 * License: BSD 3-Clause
 */

//
// PUBLIC
//

/** Category kinds; see the Python schema for their meaning. */
export type Kind = 'spending'|'one_time'|'credit'|'ignore';

/** A category as configured. */
export interface Category {
  name: string;
  kind: Kind;
  group: string;
  flexible: boolean;
  kids_gone_pct: number;
  retired_pct: number;
  default_on: boolean;
  in_retirement: boolean;
  tax: boolean;
  offsets: string|null;
  label: string|null;
  note: string|null;
}

/** A defined-benefit pension. */
export interface Pension {
  name: string;
  estimates: Record<string, number>;
  monthly: number|null;
  service_years_now: number|null;
  grows_with_raises: boolean;
}

/** A retirement account. */
export interface Account {
  name: string;
  balance: number;
  monthly: number;
}

/** One adult. */
export interface Partner {
  id: string;
  name: string;
  age: number;
  take_home_monthly: number;
  take_home_note: string;
  raise_pct: number;
  social_security: {at_67: number; claim_age: number|null};
  pensions: Pension[];
  accounts: Account[];
}

/** One child. */
export interface Child {
  id: string;
  name: string;
  age: number;
  hs_graduation: string|null;
  college_529: {balance: number; monthly: number};
  school: string;
  note: string;
}

/** Derived graduation timeline for a child. */
export interface ChildTimeline {
  graduation: string;
  months_to_graduation: number;
  years_to_college: number;
  college_years: string;
}

/** A named return / inflation pair. */
export interface Preset {
  name: string;
  return_pct: number;
  inflation_pct: number;
}

/** Model assumptions. */
export interface Assumptions {
  retirement: {
    return_pct: number; inflation_pct: number; withdrawal_pct: number; tax_pct: number;
    health_insurance_monthly: number; default_age: number; presets: Record<string, Preset>;
  };
  college: {
    schools: Record<string, {name: string; cost: number}>;
    presets: Record<string, Preset>;
    default_preset: string;
    graduation_age: number;
    years: number;
  };
}

/** A transaction: [date, description, amount (out +), category index, source index, id]. */
export type Tx = [string, string, number, number, number, string];

/** Everything the server sends for the main page. */
export interface Payload {
  error: string|null;
  plan_dir: string;
  plan: {title: string; subtitle: string; today: string; months: number;
         currency_symbol: string};
  months: string[];
  month_labels: string[];
  categories: Category[];
  by_cat: number[][];
  tx: Tx[];
  sources: string[];
  household: {partners: Partner[]; children: Child[]};
  children: ChildTimeline[];
  other_income_monthly: number;
  savings: Array<{id: string; name: string; monthly: number; stops_at_retirement: boolean}>;
  investments: Array<{id: string; name: string; balance: number; return_pct: number;
                      monthly: number}>;
  assumptions: Assumptions;
  counts: {transactions: number; in_window: number};
  warnings: string[];
}

/**
 * Planner settings. Keys: `inc` by partner id plus `other`; `sav` by `529:<child>`,
 * `sav:<id>`, `inv:<id>`; `on` (toggles) and `plan` (monthly amounts) by category name.
 */
export interface PlannerState {
  inc: Record<string, number>;
  sav: Record<string, number>;
  on: Record<string, boolean>;
  plan: Record<string, number>;
}

/** College settings per child id. */
export type CollegeState = Record<string, {school: string; ret: number; inf: number;
                                          cost: number}>;

/** Retirement settings. Pension / account keys are `<partner id>:<index>`. */
export interface RetireState {
  age: number;
  ret: number;
  inf: number;
  wd: number;
  ss: boolean;
  raise: Record<string, number>;
  ssAmt: Record<string, number>;
  claim: Record<string, number|null>;
  pen: Record<string, {on: boolean; est: Record<string, number>; monthly: number|null}>;
  acct: Record<string, {on: boolean; bal: number; monthly: number}>;
  inv: Record<string, {bal: number; ret: number}>;
}

/** Spending-over-time settings: % changes by category name. */
export interface FutureState {
  kg: Record<string, number>;
  rt: Record<string, number>;
  health: number;
  tax: number;
  nominal: boolean;
}

/** All adjustable settings. */
export interface Settings {
  st: PlannerState;
  cs: CollegeState;
  rs: RetireState;
  fs: FutureState;
}

/** A saved scenario. `base` holds the defaults when it was saved (see model.rebase). */
export interface Scenario extends Settings {
  id: string;
  name: string;
  saved: string;
  base?: Settings;
}
