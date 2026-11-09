/**
 * @fileoverview Tests for the planning model. The forecast math is checked against closed-form
 * results and hand calculations. All figures are fictional.
 *
 * License: BSD 3-Clause
 */

import {describe, expect, it} from 'vitest';

import {ageWhen, annualMo, budget, clone, compact, contributions, creditsMo, Data, defaults,
        describeData, diffBudget, diffSettings, expand, flatten, fv, incomeAt, interpolatePension,
        kidCalc, rebase, rebaseBudget, results, retireYear, retirementIncome, simulate, spendAt,
        ssFactor} from '../src/model';
import type {Category, Contribution, Payload, SavLine, Settings} from '../src/types';

//
// CONSTANTS
//
const CAT_DEFAULTS: Omit<Category, 'name'> = {kind: 'spending', group: 'Other', flexible: false,
  kids_gone_pct: 0, retired_pct: 0, default_on: false, in_retirement: false, tax: false,
  offsets: null, label: null, note: null};

//
// INTERNAL
//

/** Builds a payload: 2 months of data, two partners, two children. */
function payload(): Payload {
  const cat = (name: string, extra: Partial<Category> = {}): Category =>
      ({name, ...CAT_DEFAULTS, ...extra});
  return {
    error: null, plan_dir: '/tmp/plan',
    plan: {title: 'T', subtitle: '', today: '2026-03', months: 2, currency_symbol: '$'},
    months: ['2026-09', '2026-10'], month_labels: ['Sep 26', 'Oct 26'],
    categories: [
      cat('Groceries', {kids_gone_pct: -50}),                         // 0
      cat('Shopping', {flexible: true, retired_pct: 100}),            // 1
      cat('Income tax', {kind: 'annual', tax: true, default_on: true}),         // 2
      cat('Property tax', {kind: 'annual', tax: true, in_retirement: true}),    // 3
      cat('Furniture', {kind: 'one_time'}),                           // 4
      cat('Reimb', {kind: 'credit', default_on: true, offsets: 'Shopping'}),    // 5
      cat('Refund', {kind: 'credit', default_on: true, offsets: 'Income tax'}), // 6
      cat('Other credits', {kind: 'credit'}),                         // 7
    ],
    by_cat: [[1000, 1200], [400, 600], [2400, 0], [0, 1200], [600, 0], [-100, -300], [-600, 0],
             [-50, -50]],
    tx: [], sources: ['Card'],
    household: {
      partners: [
        {id: 'a', name: 'Partner A', age: 50, take_home_monthly: 8000, take_home_note: '',
         raise_pct: 0, social_security: {at_67: 3000, claim_age: null}, retirement_age: null,
         pensions: [{name: 'Pension', estimates: {55: 1000, 60: 2500, 65: 4500}, monthly: null,
                     service_years_now: 5, grows_with_raises: true}],
         accounts: [{name: '403b', balance: 100000, monthly: 0}]},
        {id: 'b', name: 'Partner B', age: 47, take_home_monthly: 5000, take_home_note: '',
         raise_pct: 0, social_security: {at_67: 2000, claim_age: 62}, retirement_age: null,
         pensions: [],
         accounts: []},
      ],
      children: [
        {id: 'k1', name: 'Older', age: 10, hs_graduation: null,
         college_529: {balance: 40000, ...fixed(800)}, school: 'state', note: ''},
        {id: 'k2', name: 'Younger', age: 6, hs_graduation: null,
         college_529: {balance: 15000, ...fixed(800)}, school: 'state', note: ''},
      ],
    },
    children: [
      {graduation: '2034-06', months_to_graduation: 99, years_to_college: 8,
       college_years: '2034–2038'},
      {graduation: '2038-06', months_to_graduation: 147, years_to_college: 12,
       college_years: '2038–2042'},
    ],
    other_income_monthly: 0,
    savings: [{id: 'em', name: 'Emergency', type: 'savings', balance: 0, max_balance: null,
               overflow_to: null, return_pct: 0, stops_at_retirement: true, ...fixed(500)}],
    investments: [{id: 'br', name: 'Brokerage', type: 'stocks', balance: 0, return_pct: 0,
                   ...fixed(0)}],
    assumptions: {
      retirement: {return_pct: 5.5, inflation_pct: 3, withdrawal_pct: 4, tax_pct: 12,
        health_insurance_monthly: 1200, default_age: 65,
        presets: {mid: {name: 'Mid', return_pct: 5.5, inflation_pct: 3}}},
      college: {schools: {state: {name: 'State school', cost: 40000}},
        presets: {mid: {name: 'Mid', return_pct: 6, inflation_pct: 4}}, default_preset: 'mid',
        graduation_age: 18, years: 4},
    },
    counts: {transactions: 0, in_window: 0}, warnings: [],
  };
}

/** Contribution fields for a fixed amount per month. */
function fixed(monthly: number): Contribution {
  return {monthly, left_pct: null, min_monthly: null, max_monthly: null, rest: false};
}

/** A planner line with a fixed amount. */
function line(amt: number, extra: Partial<SavLine> = {}): SavLine {
  return {mode: 'fixed', amt, pct: 0, min: null, max: null, ...extra};
}

/** Closed-form future value with monthly compounding of an effective yearly rate. */
function closedFv(p: number, m: number, n: number, r: number): number {
  const i = Math.pow(1 + r, 1 / 12) - 1;
  const g = Math.pow(1 + i, n);
  return i === 0 ? p + m * n : p * g + m * (g - 1) / i;
}

/** Fresh data and default settings. */
function setup(): {d: Data; s: Settings} {
  const d = new Data(payload());
  return {d, s: defaults(d)};
}

//
// PUBLIC
//
describe('future value', () => {
  it('compounds monthly at the effective yearly rate', () => {
    expect(fv(1000, 0, 12, 0.12)).toBeCloseTo(1120, 8);
    expect(fv(0, 100, 12, 0)).toBe(1200);
    for (const [p, m, n, r] of [[40000, 800, 99, 0.06], [5000, 250, 151, 0.04]]) {
      expect(fv(p, m, n, r)).toBeCloseTo(closedFv(p, m, n, r), 6);
    }
  });
});

describe('defaults', () => {
  it('start every category at its average and credits as positive amounts', () => {
    const {d, s} = setup();
    expect(s.st.plan.Groceries).toBe(1100);
    expect(s.st.plan.Reimb).toBe(200);
    expect(s.st.plan.Refund).toBeUndefined();       // nested under an annual cost
    expect(s.st.on).toEqual({Reimb: true, Refund: true, 'Other credits': false});
    expect(s.st.annual).toEqual([{name: 'Income tax', amt: 14400},
                                 {name: 'Property tax', amt: 7200}]);
    expect(s.st.emerg).toBeNull();
    expect(s.st.sav).toEqual({'529:k1': line(800), '529:k2': line(800), 'sav:em': line(500),
      'inv:br': line(0)});
    expect(s.cs.k1).toEqual({school: 'state', cost: 40000, ret: 6, inf: 4});
    expect(s.rs.pen['a:0'].est['60']).toBe(2500);
    expect(d.primary.id).toBe('a');
  });
});

describe('monthly budget', () => {
  it('subtracts toggled credits and adds the annual list as a monthly amount', () => {
    const {d, s} = setup();
    expect(creditsMo(d, s.st)).toBe(200);
    expect(creditsMo(d, s.st, true)).toBe(0);        // reimbursements stop at retirement
    expect(annualMo(s.st)).toBe(1800);               // (14400 + 7200) / 12
    const b = budget(d, s.st);
    expect(b.income).toBe(13000);
    expect(b.regular).toBe(1600);
    expect(b.spend).toBe(1400);
    expect(b.annual).toBe(1800);
    expect(b.savings).toBe(2100);
    expect(b.left).toBe(13000 - 1400 - 1800 - 2100);
    s.st.annual.push({name: 'House', amt: 2400});
    s.st.annual = s.st.annual.filter((a) => a.name !== 'Income tax');
    expect(budget(d, s.st).annual).toBe((7200 + 2400) / 12);
  });
});

describe('contributions', () => {
  it('takes fixed amounts first, then a share of the rest for each percent line', () => {
    const pct = (p: number, extra: Partial<SavLine> = {}) => line(0, {mode: 'pct', pct: p, ...extra});
    const c = contributions([['a', line(1000)], ['b', pct(50)], ['c', pct(10, {max: 100})],
                             ['d', pct(10, {min: 500})]], 5000);
    expect(c.amt).toEqual({a: 1000, b: 2000, c: 100, d: 500});
    expect(c.left).toBe(1400);
    expect(contributions([['x', pct(50, {min: 200})]], -100)).toEqual({amt: {x: 200}, left: -300});
  });

  it('splits whatever is left after fixed and percent lines evenly between rest lines', () => {
    const rest = line(300, {mode: 'rest'});      // its old fixed amount must not count
    const c = contributions([['a', line(1000)], ['b', line(0, {mode: 'pct', pct: 25})],
                             ['r1', rest], ['r2', rest]], 5000);
    expect(c.amt).toEqual({a: 1000, b: 1000, r1: 1500, r2: 1500});
    expect(c.left).toBe(0);
    expect(contributions([['r', rest]], -50)).toEqual({amt: {r: 0}, left: -50});
  });

  it('puts a percent of the left-over into a line in the budget', () => {
    const {d, s} = setup();
    expect(budget(d, s.st).left).toBe(7700);
    s.st.sav['inv:br'] = line(0, {mode: 'pct', pct: 25});
    const b = budget(d, s.st);
    expect(b.amt['inv:br']).toBe(1925);
    expect(b.investing).toBe(1925);
    expect(b.left).toBe(5775);
  });

  it('recomputes percent lines each year from that year\'s left-over', () => {
    const {d, s} = setup();
    s.st.sav['inv:br'] = line(0, {mode: 'pct', pct: 50});
    expect(spendAt(d, s, 2030).savings).toBe(2100 + 3850);
    expect(spendAt(d, s, 2035).savings).toBeCloseTo(1300 + 8775 / 2, 8);   // older child out
  });
});

describe('savings with a max', () => {
  it('fills to the max, then sends the rest to the overflow investment', () => {
    const p = payload();
    Object.assign(p.savings[0], {balance: 9000, max_balance: 10000});
    const d = new Data(p);
    const s = defaults(d);
    const sim = simulate(d, s);
    expect(sim.full['sav:em']).toBe(2026);
    expect(sim.years.get(2027)!.bal['sav:em']).toBe(10000);
    expect(sim.at['inv:br']).toBe(500 * 178);
    expect(retirementIncome(d, s, 65).parts.find((x) => x.kind === 'investment')!.balance)
        .toBe(500 * 178);
    expect(budget(d, s.st).overflow).toEqual({});
    p.savings[0].balance = 10000;
    const b = budget(new Data(p), s.st);
    expect(b.overflow).toEqual({'sav:em': 'br'});
    expect([b.savings, b.investing]).toEqual([1600, 500]);
  });

  it('never fills when the max is out of reach', () => {
    const p = payload();
    Object.assign(p.savings[0], {max_balance: 1e9});
    const d = new Data(p);
    expect(simulate(d, defaults(d)).full['sav:em']).toBeNull();
  });
});

describe('emergency costs', () => {
  /** The fixture, with the savings account as an emergency fund holding 3000 if asked. */
  function withEmergency(fund: boolean): {d: Data; s: Settings} {
    const p = payload();
    if (fund) Object.assign(p.savings[0], {type: 'emergency', balance: 3000});
    const d = new Data(p);
    return {d, s: defaults(d)};
  }

  it('count as spending when there is no emergency fund', () => {
    const {d, s} = withEmergency(false);
    expect(budget(d, s.st).emergency).toBe(0);
    s.st.emerg = 600;
    expect(budget(d, s.st).spend).toBe(2000);
    expect(spendAt(d, s, 2030).spend).toBe(2000 + 1800);
  });

  it('default to what goes into the fund, so it holds steady', () => {
    const {d, s} = withEmergency(true);
    expect(budget(d, s.st).emergency).toBe(500);
    expect(simulate(d, s).years.get(2030)!.bal['sav:em']).toBe(3000);
  });

  it('come out of the emergency fund, and only the uncovered part hits the month', () => {
    const {d, s} = withEmergency(true);
    s.st.emerg = 600;
    const b = budget(d, s.st);
    expect([b.spend, b.emergency, b.left]).toEqual([1400, 600, 7700]);
    // 3000 + 500/mo in - 600/mo out: covered for 25 months, then 100/mo short
    expect(spendAt(d, s, 2026)).toMatchObject({emergency: 600, short: 0, spend: 3200});
    expect(spendAt(d, s, 2028).short).toBeCloseTo(100 * 9 / 12, 8);
    expect(spendAt(d, s, 2029)).toMatchObject({short: 100, spend: 3300});
  });
});

describe('college', () => {
  it('compares the balance at graduation with the inflated cost of college', () => {
    const {d, s} = setup();
    const x = kidCalc(d, s, 0);
    let cost = 0;
    for (let j = 0; j < 4; j++) cost += 40000 * Math.pow(1.04, 8 + j);
    expect(x.bal).toBeCloseTo(closedFv(40000, 800, 99, 0.06), 6);
    expect(x.cost).toBeCloseTo(cost, 6);
    expect(x.pct).toBeCloseTo(x.bal / cost, 10);
    expect(x.today).toBeCloseTo(x.gap / Math.pow(1.04, 99 / 12), 6);
  });

  it('monthly-needed exactly funds college', () => {
    const {d, s} = setup();
    const x = kidCalc(d, s, 1);
    s.st.sav['529:k2'].amt = x.need;
    expect(kidCalc(d, s, 1).gap).toBeCloseTo(0, 4);
  });

  it('handles a zero return without dividing by zero', () => {
    const {d, s} = setup();
    s.cs.k1.ret = 0;
    const x = kidCalc(d, s, 0);
    s.st.sav['529:k1'].amt = x.need;
    expect(kidCalc(d, s, 0).gap).toBeCloseTo(0, 4);
  });
});

describe('pensions and Social Security', () => {
  it('interpolates estimates and grows with service after the last one', () => {
    const est = {55: 1000, 60: 2500, 65: 4500};
    expect(interpolatePension(est, 54, 50, 5)).toBe(0);
    expect(interpolatePension(est, 57, 50, 5)).toBeCloseTo(1000 + (2500 - 1000) * 2 / 5, 8);
    expect(interpolatePension(est, 65, 50, 5)).toBe(4500);
    expect(interpolatePension(est, 67, 50, 5)).toBeCloseTo(4500 * (5 + 17) / (5 + 15), 8);
    expect(interpolatePension(est, 67, 50, null)).toBe(4500);
  });

  it('uses the claiming-age table, clamped to 62-70', () => {
    expect(ssFactor(60)).toBe(0.7);
    expect(ssFactor(67)).toBe(1);
    expect(ssFactor(75)).toBe(1.24);
  });

  it('times each partner\'s Social Security', () => {
    const {d, s} = setup();
    const R = retirementIncome(d, s, 60);
    const a = R.parts.find((x) => x.kind === 'ss' && x.partner === 'a')!;
    const b = R.parts.find((x) => x.kind === 'ss' && x.partner === 'b')!;
    expect(ageWhen(d, d.partners[1], 60)).toBe(57);
    expect(a.started).toBe(false);                    // A can't claim before 62
    expect(a.claimAge).toBe(62);
    expect(a.start).toBe(1976 + 62);
    expect(a.value).toBeCloseTo(3000 * 0.7, 8);
    expect(b.started).toBe(false);
    expect(b.start).toBe(1979 + 62);
    expect(R.fullYear).toBe(2041);
    expect(R.later).toBeCloseTo(3000 * 0.7 + 2000 * 0.7, 8);
    const late = retirementIncome(d, s, 70);
    expect(late.parts.find((x) => x.partner === 'a' && x.kind === 'ss')!.value)
        .toBeCloseTo(3000 * 1.24, 8);
  });

  it('turns balances into today\'s-dollar income with the withdrawal rate', () => {
    const {d, s} = setup();
    const R = retirementIncome(d, s, 65);
    const acct = R.parts.find((x) => x.kind === 'account')!;
    const bal = 100000 * Math.pow(1.055, 15);
    expect(acct.balance).toBeCloseTo(bal, 4);
    expect(acct.value).toBeCloseTo(bal / Math.pow(1.03, 15) * 0.04 / 12, 6);
    expect(R.parts.some((x) => x.kind === 'investment')).toBe(false);   // $0 brokerage is off
    s.rs.inv.br = {bal: 50000, ret: 6};
    s.st.sav['inv:br'].amt = 500;
    const inv = retirementIncome(d, s, 65).parts.find((x) => x.kind === 'investment')!;
    expect(inv.balance).toBeCloseTo(closedFv(50000, 500, 180, 0.06), 4);
  });

  it('draws each account at its own rate and adds the savings account', () => {
    const {d, s} = setup();
    expect(s.rs.draw).toEqual({'acct:a:0': null, 'inv:br': null, 'sav:em': null});
    const R = retirementIncome(d, s, 65);
    const acct = R.parts.find((x) => x.kind === 'account')!;
    const sav = R.parts.find((x) => x.kind === 'savings')!;
    expect(sav.balance).toBe(500 * 180);                 // $500/mo for 15 years, no interest
    expect(sav.value).toBeCloseTo(90000 / Math.pow(1.03, 15) * 0.04 / 12, 6);
    s.rs.draw['acct:a:0'] = 5;
    const acct5 = retirementIncome(d, s, 65).parts.find((x) => x.kind === 'account')!;
    expect(acct5.value).toBeCloseTo(acct.value * 5 / 4, 6);
    expect(incomeAt(d, s, 2041)).toBe(13000);             // savings pay out once retired
  });

  it('scales the pension with real raises', () => {
    const {d, s} = setup();
    const flat = retirementIncome(d, s, 60).parts.find((x) => x.kind === 'pension')!.value;
    s.rs.raise.a = 2;
    const raised = retirementIncome(d, s, 60).parts.find((x) => x.kind === 'pension')!.value;
    expect(raised).toBeCloseTo(flat * Math.pow(1.02, 10 - 1.5), 8);
  });
});

describe('spending over time', () => {
  it('applies the kids-gone change proportionally and retirement changes on top', () => {
    const {d, s} = setup();
    expect(retireYear(d, s.rs)).toBe(2042);
    expect(spendAt(d, s, 2030).cats.Groceries).toBe(1100);
    expect(spendAt(d, s, 2035).kids).toBe(1);
    expect(spendAt(d, s, 2035).cats.Groceries).toBe(1100 * 0.75);
    s.rs.age = 70;
    expect(spendAt(d, s, 2040).cats.Groceries).toBe(550);
    expect(spendAt(d, s, 2048).cats.Shopping).toBe(1000);    // +100% in retirement
  });

  it('stops 529s at graduation and savings at retirement and adds health insurance', () => {
    const {d, s} = setup();
    expect(spendAt(d, s, 2030).savings).toBe(2100);
    expect(spendAt(d, s, 2035).savings).toBe(1300);
    const r = spendAt(d, s, 2043);
    expect(r.ret).toBe(true);
    expect(r.savings).toBe(0);
    expect(r.health).toBe(1200);
    expect(r.annual).toBe(1800);                     // annual expenses continue
  });

  it('grows income with raises, then switches to retirement income after tax', () => {
    const {d, s} = setup();
    s.rs.raise.b = 1;
    expect(incomeAt(d, s, 2026)).toBe(13000);
    expect(incomeAt(d, s, 2028)).toBeCloseTo(8000 + 5000 * 1.01 * 1.01, 8);
    const R = retirementIncome(d, s, 65);
    const early = R.parts.filter((x) => x.kind !== 'ss');
    const atRet = early.reduce((t, x) => t + x.value, 0) +
        R.parts.filter((x) => x.kind === 'ss' && (x.start ?? 0) <= 2042)
            .reduce((t, x) => t + x.value, 0);
    expect(incomeAt(d, s, 2042)).toBeCloseTo(atRet * 0.88, 8);
  });
});

describe('separate retirement ages', () => {
  it('defaults to the same year as the first partner', () => {
    const {d, s} = setup();
    expect(s.rs.ages).toEqual({b: null});
    const R = retirementIncome(d, s, 65);
    expect(R.ages.b).toBe(62);
    expect(R.years).toEqual({a: 2042, b: 2042});
  });

  it('pays the earlier retiree\'s Social Security while the other still works', () => {
    const {d, s} = setup();
    s.rs.ages.b = 60;
    expect(retireYear(d, s.rs)).toBe(2042);
    expect(retirementIncome(d, s, 65).years.b).toBe(2040);
    expect(incomeAt(d, s, 2039)).toBe(13000);
    expect(incomeAt(d, s, 2040)).toBe(8000);                          // B retired, no SS yet
    expect(incomeAt(d, s, 2041)).toBeCloseTo(8000 + 2000 * 0.7 * 0.88, 8);
  });

  it('waits for the later retiree before spending switches to retirement', () => {
    const {d, s} = setup();
    s.rs.ages.b = 70;
    const R = retirementIncome(d, s, 65);
    expect(retireYear(d, s.rs)).toBe(2050);
    expect(R.year).toBe(2050);
    expect(spendAt(d, s, 2045).ret).toBe(false);
    const a = R.parts.filter((x) => x.partner === 'a' && x.kind !== 'ss')
        .reduce((t, x) => t + x.value, 0);
    const ssA = R.parts.find((x) => x.kind === 'ss' && x.partner === 'a')!;
    expect(ssA.started).toBe(true);
    expect(incomeAt(d, s, 2045)).toBeCloseTo(5000 + (a + ssA.value) * 0.88, 8);
    expect(results(d, s).find((r) => r[0] === 'Retirement age (Partner B)')![1]).toBe(70);
  });

  it('labels the setting in scenario comparisons', () => {
    const {d, s} = setup();
    const b = clone(s);
    b.rs.ages.b = 60;
    expect(diffSettings(d, s, b).map((x) => [x[0], x[1], x[2]])).toEqual([
      ['Partner B retirement age', 'same year as Partner A', '60']]);
  });
});

describe('scenarios', () => {
  it('rebase keeps edits and follows untouched defaults', () => {
    const {d, s} = setup();
    const saved = clone(s);
    saved.st.plan.Groceries = 900;
    const base = clone(s);
    const newDefaults = clone(s);
    newDefaults.st.plan.Groceries = 1300;
    newDefaults.st.plan.Shopping = 777;
    const out = rebase(newDefaults, saved, base);
    expect(out.st.plan.Groceries).toBe(900);
    expect(out.st.plan.Shopping).toBe(777);
    expect(rebase(defaults(d), {st: {plan: {Gone: 5}}} as never).st.plan.Gone).toBeUndefined();
  });

  it('rebases and diffs budgets on their own', () => {
    const {d, s} = setup();
    const saved = clone(s.st);
    saved.plan.Groceries = 900;
    saved.annual = [{name: 'House', amt: 1200}];
    const defs = clone(s.st);
    defs.plan.Shopping = 777;
    const out = rebaseBudget(defs, saved, s.st);
    expect([out.plan.Groceries, out.plan.Shopping]).toEqual([900, 777]);
    expect(out.annual).toEqual([{name: 'House', amt: 1200}]);
    expect(diffBudget(d, s.st, saved).map((x) => x[0])).toEqual(['Planned: Groceries',
      'Annual expenses']);
  });

  it('upgrades saved amounts from before contribution modes', () => {
    const {d} = setup();
    const out = rebase(defaults(d), {st: {sav: {'inv:br': 300}}} as never);
    expect(out.st.sav['inv:br']).toEqual(line(300));
    expect(expand(d, {d: [[['st', 'sav', 'inv:br'], 300]]}).st.sav['inv:br'].amt).toBe(300);
  });

  it('labels contribution modes in comparisons', () => {
    const {d, s} = setup();
    const b = clone(s);
    b.st.sav['sav:em'] = line(500, {mode: 'pct', pct: 20});
    expect(diffSettings(d, s, b).map((x) => [x[0], x[1], x[2]])).toEqual([
      ['Emergency: contribution', 'fixed', '% of left-over'],
      ['Emergency: share of left-over', '0%', '20%']]);
  });

  it('compact / expand round-trips only the differences', () => {
    const {d, s} = setup();
    s.rs.age = 62;
    s.cs.k2.school = 'state';
    s.cs.k2.cost = 50000;
    s.st.on['Other credits'] = true;
    const c = compact(d, {id: 'x', name: 'n', saved: 't', ...s});
    expect(c.d).toEqual([[['st', 'on', 'Other credits'], true], [['cs', 'k2', 'cost'], 50000],
                         [['rs', 'age'], 62]]);
    expect(flatten(expand(d, c))).toEqual(flatten(s));
  });

  it('diffs settings with readable labels and sections', () => {
    const {d, s} = setup();
    const b = clone(s);
    b.rs.age = 62;
    b.st.sav['inv:br'].amt = 500;
    b.cs.k1.inf = 5;
    expect(diffSettings(d, s, b).map((x) => [x[0], x[1], x[2], x[4]])).toEqual([
      ['Brokerage: per month', '$0', '$500', 'budget'],
      ['Older: college cost inflation', '4%', '5%', 'college'],
      ['Retirement age', '65', '62', 'retire'],
    ]);
  });

  it('results put each figure under its heading', () => {
    const {d, s} = setup();
    const rows = results(d, s);
    const heads = rows.filter((r) => r[1] === null).map((r) => r[0]);
    expect(heads).toEqual(['Monthly budget today', 'Before retirement', 'College 529s',
                           'Retirement']);
    expect(rows.find((r) => r[0] === 'Older: share of college covered')![1])
        .toBe(Math.round(kidCalc(d, s, 0).pct * 100));
  });
});

describe('data description', () => {
  it('names the sources in use, the transaction count, the months and pay notes', () => {
    const p = payload();
    p.sources = ['Visa card', 'Checking', 'Old card'];
    p.tx = [['2026-09-01', 'A', 1, 0, 0, 'x'], ['2026-10-01', 'B', 2, 0, 1, 'y']];
    p.household.partners[0].take_home_note = 'pay stub';
    expect(describeData(p)).toBe('Built from Visa card and Checking (2 transactions, Sep 26 – ' +
        'Oct 26). Take-home pay: Partner A (pay stub). Change any number in Budgeting to see ' +
        'what it does to the month.');
    p.tx = [];
    expect(describeData(p)).toMatch(/^No transactions yet/);
  });
});
