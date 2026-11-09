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
export type Kind = 'spending'|'annual'|'one_time'|'emergency'|'credit'|'ignore';

/** Cost kinds kept out of the averages, each with its own planner panel. */
export type CostKind = 'annual'|'one_time'|'emergency';

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
  retirement_age: number|null;
  pensions: Pension[];
  accounts: Account[];
}

/** Contribution fields shared by 529s, savings and investments (see Python schema). */
export interface Contribution {
  monthly: number;
  left_pct: number|null;
  min_monthly: number|null;
  max_monthly: number|null;
  rest: boolean;
}

/** A savings account or emergency fund. */
export interface SavingsAccount extends Contribution {
  id: string;
  name: string;
  type: 'savings'|'emergency';
  balance: number;
  max_balance: number|null;
  overflow_to: string|null;
  return_pct: number;
  stops_at_retirement: boolean;
}

/** A stock or bond account. */
export interface Investment extends Contribution {
  id: string;
  name: string;
  type: 'stocks'|'bonds';
  balance: number;
  return_pct: number;
}

/** One child. */
export interface Child {
  id: string;
  name: string;
  age: number;
  hs_graduation: string|null;
  college_529: Contribution & {balance: number};
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
  all_months?: string[];
  all_month_labels?: string[];
  all_by_cat?: number[][];
  other_tx?: Tx[];
  sources: string[];
  household: {partners: Partner[]; children: Child[]};
  children: ChildTimeline[];
  other_income_monthly: number;
  savings: SavingsAccount[];
  investments: Investment[];
  assumptions: Assumptions;
  counts: {transactions: number; in_window: number};
  warnings: string[];
}

/**
 * One contribution line in the budget: a fixed amount per month, a percent of what is left over
 * each month kept between an optional min and max, or an even share of whatever is left after
 * everything else ('rest').
 */
export interface SavLine {
  mode: 'fixed'|'pct'|'rest';
  amt: number;
  pct: number;
  min: number|null;
  max: number|null;
}

/** One annual expense in a budget: a label and its yearly amount. */
export interface AnnualItem {
  name: string;
  amt: number;
}

/**
 * Budget settings. Keys: `inc` by partner id plus `other`; `sav` by `529:<child>`,
 * `sav:<id>`, `inv:<id>`; `on` (credit toggles) and `plan` (monthly amounts) by category name.
 * `annual` is the budget's own list of yearly expenses; `emerg` the emergency fund costs per month
 * (null: the same as what goes into the emergency funds).
 */
export interface PlannerState {
  inc: Record<string, number>;
  sav: Record<string, SavLine>;
  on: Record<string, boolean>;
  plan: Record<string, number>;
  annual: AnnualItem[];
  emerg: number|null;
}

/** A saved budget: planner settings only. `base` holds the defaults when it was saved. */
export interface SavedBudget {
  id: string;
  name: string;
  saved: string;
  st: PlannerState;
  base?: PlannerState;
}

/** College settings per child id. */
export type CollegeState = Record<string, {school: string; ret: number; inf: number;
                                          cost: number}>;

/**
 * Retirement settings. `age` is the primary partner's retirement age; `ages` holds the other
 * partners' (null: the same year as the primary). Pension / account keys are
 * `<partner id>:<index>`. `draw` is each account's yearly withdrawal % (keys `acct:<p>:<i>`,
 * `inv:<id>`, `sav:<id>`; null: the default `wd`).
 */
export interface RetireState {
  age: number;
  ages: Record<string, number|null>;
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
  draw: Record<string, number|null>;
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
