"use strict";
(() => {
  // src/api.ts
  var WRITE_HEADERS = { "Content-Type": "application/json", "X-Financial-Planner": "1" };
  var ApiError = class extends Error {
  };
  async function get(path) {
    return handle(await fetch(path, { cache: "no-store" }));
  }
  async function send(method, path, body) {
    return handle(await fetch(path, {
      method,
      headers: WRITE_HEADERS,
      body: JSON.stringify(body ?? null)
    }));
  }
  async function upload(path, file) {
    return handle(await fetch(path, {
      method: "POST",
      headers: { "X-Financial-Planner": "1", "Content-Type": "text/csv" },
      body: file
    }));
  }
  async function handle(res) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body.detail ?? body.error ?? res.statusText;
      throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return body;
  }

  // src/format.ts
  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  var currency = "$";
  function setCurrency(symbol) {
    currency = symbol || "$";
  }
  function fmt(v, d = 0) {
    const s = currency + Math.abs(v).toLocaleString(
      "en-US",
      { minimumFractionDigits: d, maximumFractionDigits: d }
    );
    return v < 0 ? `(${s})` : s;
  }
  function fk(v) {
    if (Math.abs(v) < 1e3) return fmt(v);
    const k = Math.abs(v) / 1e3;
    return `${v < 0 ? "-" : ""}${currency}${k.toFixed(Math.abs(v) >= 1e4 ? 0 : 1)}k`;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
  }
  function niceStep(max) {
    const raw2 = max / 5;
    const p = Math.pow(10, Math.floor(Math.log10(raw2 || 1)));
    const n = raw2 / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  function sum(a) {
    return a.reduce((x, y) => x + y, 0);
  }

  // src/model.ts
  var SS_FACTORS = {
    62: 0.7,
    63: 0.75,
    64: 0.8,
    65: 0.8667,
    66: 0.9333,
    67: 1,
    68: 1.08,
    69: 1.16,
    70: 1.24
  };
  var PROJECTION_YEARS = 35;
  var COST_KINDS = ["annual", "one_time", "emergency"];
  var Data = class {
    constructor(p) {
      this.p = p;
      this.n = Math.max(1, p.months.length);
      this.cats = p.categories;
      this.byCat = p.by_cat;
      this.index = new Map(this.cats.map((c, i) => [c.name, i]));
      const kind = (k) => this.cats.map((_, i) => i).filter((i) => this.cats[i].kind === k);
      this.regular = kind("spending");
      this.annual = kind("annual");
      this.oneTime = kind("one_time");
      this.emergency = kind("emergency");
      this.costs = [...this.annual, ...this.oneTime, ...this.emergency];
      this.credits = kind("credit");
      this.todayYear = +p.plan.today.slice(0, 4);
      this.todayMonth = +p.plan.today.slice(5, 7);
      this.partners = p.household.partners;
      this.children = p.household.children;
      this.timelines = p.children;
    }
    /** Category index by name (-1 if unknown). */
    idx(name) {
      return this.index.get(name) ?? -1;
    }
    /** Average per month over the window (credits come out negative). */
    avg(i) {
      return i < 0 ? 0 : sum(this.byCat[i]) / this.n;
    }
    /** A credit category's average as a positive amount. */
    credAvg(i) {
      return -this.avg(i);
    }
    /** The primary partner (the retirement-age slider is their age). */
    get primary() {
      return this.partners[0] ?? {
        id: "none",
        name: "You",
        age: 40,
        take_home_monthly: 0,
        take_home_note: "",
        raise_pct: 0,
        social_security: { at_67: 0, claim_age: null },
        retirement_age: null,
        pensions: [],
        accounts: []
      };
    }
    /** Credit categories that offset a given category. */
    offsetsOf(name) {
      return this.credits.filter((i) => this.cats[i].offsets === name);
    }
    /** Whether a credit is shown inside the planner table (not nested under a cost toggle). */
    isPlannerCredit(i) {
      const off = this.cats[i].offsets;
      const k = this.cats[this.idx(off ?? "")]?.kind;
      return !off || !COST_KINDS.includes(k);
    }
    /** Emergency funds (they pay for emergency costs, in config order). */
    get funds() {
      return this.p.savings.filter((s) => s.type === "emergency");
    }
    /** Every contribution key: 529s, then savings, then investments. */
    get savKeys() {
      return [
        ...this.children.map((c) => `529:${c.id}`),
        ...this.p.savings.map((s) => `sav:${s.id}`),
        ...this.p.investments.map((v) => `inv:${v.id}`)
      ];
    }
    /** A child's high-school graduation as a fractional year (June 2034 -> 2034.5). */
    gradT(child) {
      const g = this.timelines[child].graduation;
      return +g.slice(0, 4) + +g.slice(5, 7) / 12;
    }
  };
  function defaults(d) {
    const p = d.p;
    const st = {
      inc: {},
      sav: {},
      on: {},
      plan: {},
      annual: d.annual.map((i) => ({ name: d.cats[i].name, amt: Math.round(d.avg(i) * 12) })),
      emerg: null
    };
    d.partners.forEach((x) => st.inc[x.id] = x.take_home_monthly);
    st.inc.other = p.other_income_monthly;
    d.children.forEach((c) => st.sav[`529:${c.id}`] = savLine(c.college_529));
    p.savings.forEach((s) => st.sav[`sav:${s.id}`] = savLine(s));
    p.investments.forEach((v) => st.sav[`inv:${v.id}`] = savLine(v));
    d.credits.forEach((i) => st.on[d.cats[i].name] = d.cats[i].default_on);
    d.regular.forEach((i) => st.plan[d.cats[i].name] = d.avg(i));
    d.credits.filter((i) => d.isPlannerCredit(i)).forEach((i) => st.plan[d.cats[i].name] = d.credAvg(i));
    const col = p.assumptions.college;
    const preset = col.presets[col.default_preset] ?? Object.values(col.presets)[0] ?? { return_pct: 6, inflation_pct: 4 };
    const cs = {};
    d.children.forEach((c) => cs[c.id] = {
      school: c.school,
      cost: col.schools[c.school]?.cost ?? 0,
      ret: preset.return_pct,
      inf: preset.inflation_pct
    });
    const ra = p.assumptions.retirement;
    const rs = {
      age: d.partners[0]?.retirement_age ?? ra.default_age,
      ret: ra.return_pct,
      inf: ra.inflation_pct,
      wd: ra.withdrawal_pct,
      ss: true,
      ages: {},
      raise: {},
      ssAmt: {},
      claim: {},
      pen: {},
      acct: {},
      inv: {},
      draw: {}
    };
    d.partners.forEach((x, i) => {
      if (i > 0) rs.ages[x.id] = x.retirement_age ?? null;
      rs.raise[x.id] = x.raise_pct;
      rs.ssAmt[x.id] = x.social_security.at_67;
      rs.claim[x.id] = x.social_security.claim_age;
      x.pensions.forEach((pn, i2) => rs.pen[`${x.id}:${i2}`] = {
        on: true,
        est: { ...pn.estimates },
        monthly: pn.monthly
      });
      x.accounts.forEach((a, i2) => {
        rs.acct[`${x.id}:${i2}`] = { on: true, bal: a.balance, monthly: a.monthly };
        rs.draw[`acct:${x.id}:${i2}`] = null;
      });
    });
    p.investments.forEach((v) => {
      rs.inv[v.id] = { bal: v.balance, ret: v.return_pct };
      rs.draw[`inv:${v.id}`] = null;
    });
    retireSavings(d).forEach((s) => rs.draw[`sav:${s.id}`] = null);
    const fs = {
      kg: {},
      rt: {},
      health: ra.health_insurance_monthly,
      tax: ra.tax_pct,
      nominal: false
    };
    d.regular.forEach((i) => {
      fs.kg[d.cats[i].name] = d.cats[i].kids_gone_pct;
      fs.rt[d.cats[i].name] = d.cats[i].retired_pct;
    });
    return { st, cs, rs, fs };
  }
  function rebase(defs, saved2, base) {
    const out = clone(defs);
    if (!saved2) return out;
    saved2 = upgrade(saved2);
    base = base && upgrade(base);
    const baseMap = new Map(flatten(base ?? {}).map(([k, v]) => [k, v]));
    const defMap = new Map(flatten(defs).map(([k, v]) => [k, v]));
    for (const [key, value] of flatten(saved2)) {
      if (!defMap.has(key)) continue;
      if (base && baseMap.has(key) && same(baseMap.get(key), value)) continue;
      setPath(out, JSON.parse(key), value);
    }
    return out;
  }
  function rebaseBudget(defs, saved2, base) {
    const wrap = (st) => ({ st });
    return rebase(wrap(defs), wrap(saved2), base ? wrap(base) : null).st;
  }
  function diffBudget(d, a, b) {
    const wrap = (st) => ({ st });
    return diffSettings(d, wrap(a), wrap(b));
  }
  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }
  function flatten(o) {
    const out = [];
    const walk = (v, path) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        Object.entries(v).forEach(([k, x]) => walk(x, [...path, k]));
      } else if (path.length) {
        out.push([JSON.stringify(path), v]);
      }
    };
    walk(o, []);
    return out;
  }
  function setPath(o, path, value) {
    let cur = o;
    path.slice(0, -1).forEach((k) => {
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    });
    cur[path[path.length - 1]] = value;
  }
  function describeData(p) {
    const counts = /* @__PURE__ */ new Map();
    p.tx.forEach((t) => counts.set(t[4], (counts.get(t[4]) ?? 0) + 1));
    const used = p.sources.filter((_, i) => counts.get(i));
    if (!used.length) return "No transactions yet: add your CSV exports in Settings \u203A Data sources.";
    const list = (xs) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
    const months = p.month_labels;
    let s = `Built from ${list(used)} (${p.tx.length.toLocaleString("en-US")} transactions, ${months[0]} \u2013 ${months[months.length - 1]}).`;
    const notes = p.household.partners.filter((x) => x.take_home_note).map((x) => `${x.name} (${x.take_home_note})`);
    if (notes.length) s += ` Take-home pay: ${notes.join(", ")}.`;
    return `${s} Change any number in Budgeting to see what it does to the month.`;
  }
  function regularMo(d, st) {
    return sum(d.regular.map((i) => st.plan[d.cats[i].name] ?? 0));
  }
  function creditsMo(d, st, ret = false) {
    return sum(d.credits.filter((i) => d.isPlannerCredit(i) && st.on[d.cats[i].name] && (!ret || d.cats[i].in_retirement)).map((i) => st.plan[d.cats[i].name] ?? 0));
  }
  function annualMo(st) {
    return sum((st.annual ?? []).map((a) => a.amt)) / 12;
  }
  function emergencyMo(d, st) {
    return budget(d, st).emergency;
  }
  function incomeMo(st) {
    return sum(Object.values(st.inc));
  }
  function savLine(c) {
    return {
      mode: c.rest ? "rest" : c.left_pct == null ? "fixed" : "pct",
      amt: c.monthly,
      pct: c.left_pct ?? 0,
      min: c.min_monthly,
      max: c.max_monthly
    };
  }
  function contributions(lines, free) {
    const amt = {};
    let base = free;
    lines.forEach(([k, l]) => {
      if (l && l.mode !== "pct" && l.mode !== "rest") {
        amt[k] = l.amt;
        base -= l.amt;
      }
    });
    let left = base;
    lines.forEach(([k, l]) => {
      if (l?.mode !== "pct") return;
      let v = Math.max(0, base) * l.pct / 100;
      if (l.min != null) v = Math.max(v, l.min);
      if (l.max != null) v = Math.min(v, l.max);
      amt[k] = v;
      left -= v;
    });
    const rest = lines.filter(([, l]) => l?.mode === "rest");
    const share = rest.length ? Math.max(0, left) / rest.length : 0;
    rest.forEach(([k]) => {
      amt[k] = share;
      left -= share;
    });
    return { amt, left };
  }
  function overflowTarget(d, sv) {
    if (sv.max_balance == null) return null;
    return sv.overflow_to ?? d.p.investments[0]?.id ?? null;
  }
  function budget(d, st) {
    const income = incomeMo(st);
    const regular = regularMo(d, st);
    const credits = creditsMo(d, st);
    const annual = annualMo(st);
    const spend = regular - credits + (d.funds.length ? 0 : st.emerg ?? 0);
    const { amt, left } = contributions(d.savKeys.map((k) => [k, st.sav[k]]), income - spend - annual);
    const emergency = st.emerg ?? sum(d.funds.map((f) => amt[`sav:${f.id}`] ?? 0));
    const overflow = {};
    d.p.savings.forEach((sv) => {
      const to = overflowTarget(d, sv);
      if (to && sv.balance >= sv.max_balance) overflow[`sav:${sv.id}`] = to;
    });
    const isInv = (k) => k.startsWith("inv:") || k in overflow;
    const investing = sum(Object.entries(amt).filter(([k]) => isInv(k)).map(([, v]) => v));
    const savings = sum(Object.entries(amt).filter(([k]) => !isInv(k)).map(([, v]) => v));
    return {
      income,
      regular,
      credits,
      annual,
      emergency,
      spend,
      savings,
      investing,
      amt,
      overflow,
      left
    };
  }
  function fv(p, m, n, r) {
    const i = Math.pow(1 + r, 1 / 12) - 1;
    let b = p;
    for (let k = 0; k < n; k++) b = b * (1 + i) + m;
    return b;
  }
  function kidCalc(d, s, k) {
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
    const need = months > 0 ? Math.max(0, i > 0 ? (cost - child.college_529.balance * G) * i / (G - 1) : (cost - child.college_529.balance) / months) : 0;
    return { bal, cost, gap, today, pct: cost ? bal / cost : 0, need };
  }
  function ssFactor(age) {
    return SS_FACTORS[Math.min(70, Math.max(62, Math.round(age)))];
  }
  function interpolatePension(est, age, ageNow, serviceNow) {
    const pts = Object.entries(est).map(([a, v]) => [+a, +v]).filter(([a]) => !isNaN(a)).sort((x, y) => x[0] - y[0]);
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
  function retireSavings(d) {
    return d.p.savings.filter((s) => s.type === "savings");
  }
  function drawPct(rs, key) {
    return rs.draw?.[key] ?? rs.wd;
  }
  function ageWhen(d, partner, primaryAge) {
    return partner.age + (primaryAge - d.primary.age);
  }
  function yearAtAge(d, partner, age) {
    return Math.round(d.todayYear - partner.age) + age;
  }
  function partnerRetireAge(d, rs, p, a = rs.age) {
    if (p.id === d.primary.id) return a;
    const own = rs.ages?.[p.id];
    return own == null ? ageWhen(d, p, a) : own;
  }
  function partnerRetireYear(d, rs, p, a = rs.age) {
    const own = p.id === d.primary.id ? null : rs.ages?.[p.id];
    return own == null ? Math.round(d.todayYear - d.primary.age) + 1 + a : Math.round(d.todayYear - p.age) + 1 + own;
  }
  function retireYear(d, rs, a = rs.age) {
    const first = Math.round(d.todayYear - d.primary.age) + 1 + a;
    return Math.max(first, ...d.partners.map((p) => partnerRetireYear(d, rs, p, a)));
  }
  function retirementIncome(d, s, a) {
    const base = baseRetirement(d, s, a);
    const inv = investmentParts(d, s, base.yrs, simulate(d, s, a).at);
    const parts = [
      ...base.parts.filter((x) => x.kind !== "ss"),
      ...inv,
      ...base.parts.filter((x) => x.kind === "ss")
    ];
    const total = sum(parts.filter((x) => x.started).map((x) => x.value));
    const pending = parts.filter((x) => !x.started);
    const later = sum(pending.map((x) => x.value));
    return {
      ...base,
      parts,
      total,
      later,
      full: total + later,
      fullYear: Math.max(0, ...pending.map((x) => x.start ?? 0))
    };
  }
  function spendAt(d, s, y) {
    const x = spendingAt(d, s, y, retireYear(d, s.rs));
    const sy = simulate(d, s).years.get(y);
    const short = sy?.short ?? 0;
    return { ...x, short, spend: x.spend + short, savings: sy?.saved ?? 0 };
  }
  function incomeAt(d, s, y) {
    return incomeFrom(d, s, retirementIncome(d, s, s.rs.age), y);
  }
  function simulate(d, s, a = s.rs.age) {
    const key = JSON.stringify([s.st, s.cs, s.rs, s.fs.health, s.fs.tax, s.fs.kg, s.fs.rt, a]);
    let memo = SIM_CACHE.get(d);
    if (!memo) SIM_CACHE.set(d, memo = /* @__PURE__ */ new Map());
    const hit = memo.get(key);
    if (hit) return hit;
    const { st, rs, cs } = s;
    const base = baseRetirement(d, s, a);
    const RY = base.year;
    const invMonth = Math.round(base.yrs * 12);
    const start2 = d.todayMonth - 1;
    const n = (Math.max(d.todayYear + PROJECTION_YEARS, RY + 1) - d.todayYear) * 12 - start2;
    const mr = (pct) => Math.pow(1 + pct / 100, 1 / 12) - 1;
    const accts = [
      ...d.children.map((c, k) => ({
        key: `529:${c.id}`,
        bal: c.college_529.balance,
        i: mr(cs[c.id]?.ret ?? 0),
        until: d.timelines[k].months_to_graduation,
        stops: false,
        cap: null,
        to: null,
        fund: false
      })),
      ...d.p.savings.map((sv) => {
        const to = overflowTarget(d, sv);
        return {
          key: `sav:${sv.id}`,
          bal: sv.balance,
          i: mr(sv.return_pct),
          until: Infinity,
          stops: sv.stops_at_retirement,
          cap: sv.max_balance,
          to: to && `inv:${to}`,
          fund: sv.type === "emergency"
        };
      }),
      ...d.p.investments.map((v) => ({
        key: `inv:${v.id}`,
        bal: rs.inv[v.id]?.bal ?? v.balance,
        i: mr(rs.inv[v.id]?.ret ?? v.return_pct),
        until: Infinity,
        stops: true,
        cap: null,
        to: null,
        fund: false
      }))
    ];
    const byKey = new Map(accts.map((x) => [x.key, x]));
    const at = {};
    const full = {};
    accts.forEach((x) => {
      if (x.cap != null) full[x.key] = x.bal >= x.cap - 0.5 ? d.todayYear : null;
    });
    const years = /* @__PURE__ */ new Map();
    let inv = null;
    const flows = /* @__PURE__ */ new Map();
    const flowsAt = (y) => {
      let f = flows.get(y);
      if (!f) {
        const x = spendingAt(d, s, y, RY);
        if (y >= RY && !inv) {
          snapshot("inv:");
          inv = investmentParts(d, s, base.yrs, snapshot("sav:"));
        }
        const income = incomeFrom(d, s, { ...base, parts: [...base.parts, ...inv ?? []] }, y);
        f = { free: income - x.spend, emergency: x.emergency };
        flows.set(y, f);
      }
      return f;
    };
    const snapshot = (prefix) => {
      accts.filter((x) => x.key.startsWith(prefix) && !(x.key in at)).forEach((x) => at[x.key] = x.bal);
      return at;
    };
    for (let m = 0; m < n; m++) {
      const y = d.todayYear + Math.floor((start2 + m) / 12);
      const ret = y >= RY;
      accts.forEach((x) => {
        if (x.key.startsWith("529:") && m === x.until) at[x.key] = x.bal;
      });
      if (m === invMonth) {
        snapshot("inv:");
        snapshot("sav:");
      }
      const f = flowsAt(y);
      let need = f.emergency;
      accts.filter((x) => x.fund).forEach((x) => {
        const take = Math.min(Math.max(0, x.bal), need);
        x.bal -= take;
        need -= take;
      });
      const active2 = accts.filter((x) => m < x.until && !(ret && x.stops));
      const c = contributions(active2.map((x) => [x.key, st.sav[x.key]]), f.free - need);
      accts.forEach((x) => x.bal *= 1 + x.i);
      let overflow = 0;
      let kept = 0;
      active2.forEach((x) => {
        let v = c.amt[x.key] ?? 0;
        if (x.cap != null) {
          const into = Math.max(0, Math.min(v, x.cap - x.bal));
          const spill = v - into;
          v = into;
          const target = x.to ? byKey.get(x.to) : void 0;
          if (spill > 0 && target) {
            target.bal += spill;
            overflow += spill;
          } else {
            kept += spill;
          }
        }
        x.bal += v;
        if (x.cap != null && full[x.key] == null && x.bal >= x.cap - 0.5) full[x.key] = y;
      });
      let yr = years.get(y);
      if (!yr) {
        yr = {
          y,
          months: 0,
          saved: 0,
          contrib: {},
          overflow: 0,
          emergency: 0,
          short: 0,
          left: 0,
          bal: {}
        };
        years.set(y, yr);
      }
      yr.months++;
      Object.entries(c.amt).forEach(([k, v]) => yr.contrib[k] = (yr.contrib[k] ?? 0) + v);
      yr.saved += sum(Object.values(c.amt)) - kept;
      yr.overflow += overflow;
      yr.emergency += f.emergency - need;
      yr.short += need;
      yr.left += c.left + kept;
      accts.forEach((x) => yr.bal[x.key] = x.bal);
    }
    accts.forEach((x) => {
      if (!(x.key in at)) at[x.key] = x.bal;
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
    const sim = { years, at, full };
    if (memo.size > 200) memo.clear();
    memo.set(key, sim);
    return sim;
  }
  function deflator(d, s, y) {
    return s.fs.nominal ? Math.pow(1 + s.rs.inf / 100, y - d.todayYear) : 1;
  }
  function spendToday(d, st) {
    return regularMo(d, st) - creditsMo(d, st) + annualMo(st);
  }
  function diffSettings(d, A2, B) {
    const a = new Map(flatten(A2));
    const b = new Map(flatten(B));
    const keys = [.../* @__PURE__ */ new Set([...a.keys(), ...b.keys()])].filter((k) => !SKIP.has(k));
    const out = [];
    for (const key of keys) {
      const x = a.get(key);
      const y = b.get(key);
      const path = JSON.parse(key);
      const pct = isPct(path);
      const differs = typeof x === "number" && typeof y === "number" ? Math.abs(x - y) >= 0.5 || pct && x !== y : !same(x, y);
      if (!differs) continue;
      out.push([
        settingLabel(d, path),
        settingVal(d, path, x),
        settingVal(d, path, y),
        path,
        sectionOf(path)
      ]);
    }
    return out;
  }
  function settingLabel(d, path) {
    const [g, k, sub, leaf] = path;
    const who = (id) => d.partners.find((p) => p.id === id)?.name ?? id;
    const kid = (id) => d.children.find((c) => c.id === id)?.name ?? id;
    const catLabel = (n) => d.cats[d.idx(n)]?.label ?? n;
    const pensionName = (key) => {
      const [pid, i] = key.split(":");
      return d.partners.find((p) => p.id === pid)?.pensions[+i]?.name ?? key;
    };
    const accountName = (key) => {
      const [pid, i] = key.split(":");
      return d.partners.find((p) => p.id === pid)?.accounts[+i]?.name ?? key;
    };
    if (g === "st") {
      if (k === "inc") return sub === "other" ? "Other income" : `${who(sub)} take-home`;
      if (k === "sav") {
        const [type, id] = [sub.slice(0, sub.indexOf(":")), sub.slice(sub.indexOf(":") + 1)];
        const list = type === "inv" ? d.p.investments : d.p.savings;
        const name = type === "529" ? `529, ${kid(id)}` : list.find((x) => x.id === id)?.name ?? id;
        const what = {
          mode: "contribution",
          amt: "per month",
          pct: "share of left-over",
          min: "at least per month",
          max: "at most per month"
        };
        return `${name}: ${what[leaf] ?? leaf}`;
      }
      if (k === "on") return catLabel(sub);
      if (k === "annual") return "Annual expenses";
      if (k === "emerg") return "Emergency fund costs / mo";
      if (k === "plan") return `Planned: ${sub}`;
    }
    if (g === "cs") {
      const what = {
        school: "school",
        cost: "cost per year",
        ret: "529 return",
        inf: "college cost inflation"
      };
      return `${kid(k)}: ${what[sub] ?? sub}`;
    }
    if (g === "rs") {
      const simple = {
        age: "Retirement age",
        ret: "Investment return",
        inf: "Inflation",
        wd: "Yearly withdrawal",
        ss: "Social Security"
      };
      if (simple[k]) return simple[k];
      if (k === "raise") return `${who(sub)} yearly raise`;
      if (k === "ages") return `${who(sub)} retirement age`;
      if (k === "ssAmt") return `${who(sub)} Social Security at 67`;
      if (k === "claim") return `${who(sub)} claims Social Security at`;
      if (k === "pen") {
        return `${pensionName(sub)}: ${leaf === "on" ? "included" : leaf === "monthly" ? "monthly" : `estimate at ${path[4]}`}`;
      }
      if (k === "acct") {
        return `${accountName(sub)}: ${{ on: "included", bal: "balance", monthly: "per month" }[leaf] ?? leaf}`;
      }
      if (k === "inv") {
        const name = d.p.investments.find((x) => x.id === sub)?.name ?? sub;
        return `${name}: ${leaf === "bal" ? "balance today" : "return"}`;
      }
      if (k === "draw") {
        const [kind, ...rest] = sub.split(":");
        const id = rest.join(":");
        const name = kind === "acct" ? accountName(id) : kind === "inv" ? d.p.investments.find((x) => x.id === id)?.name ?? id : d.p.savings.find((x) => x.id === id)?.name ?? id;
        return `${name}: yearly withdrawal`;
      }
    }
    if (g === "fs") {
      if (k === "kg") return `Kids-gone change: ${sub}`;
      if (k === "rt") return `Retirement change: ${sub}`;
      if (k === "health") return "Retiree health insurance";
      if (k === "tax") return "Retirement tax rate";
    }
    return path.join(" \u203A ");
  }
  function settingVal(d, path, v) {
    if (v === void 0) return "\u2013";
    if (Array.isArray(v)) {
      const total = sum(v.map((x) => x.amt));
      return `${v.length} item${v.length === 1 ? "" : "s"}, ${d.p.plan.currency_symbol}${Math.round(total).toLocaleString("en-US")}/yr`;
    }
    if (v === null) {
      if (path[1] === "sav") return "none";
      if (path[1] === "emerg") return "same as the fund contribution";
      if (path[1] === "draw") return "the default rate";
      return path[1] === "ages" ? `same year as ${d.primary.name}` : "at retirement";
    }
    if (path[1] === "sav" && path[3] === "mode") {
      return v === "pct" ? "% of left-over" : v === "rest" ? "the rest" : "fixed";
    }
    if (typeof v === "boolean") return v ? "On" : "Off";
    if (path[0] === "cs" && path[2] === "school") {
      return d.p.assumptions.college.schools[String(v)]?.name ?? String(v);
    }
    if (typeof v !== "number") return String(v);
    if (path[0] === "fs" && (path[1] === "kg" || path[1] === "rt")) return `${v > 0 ? "+" : ""}${v}%`;
    if (isPct(path)) return `${v}%`;
    if (["age", "ages", "claim"].includes(path[1])) return String(v);
    return `${d.p.plan.currency_symbol}${Math.round(v).toLocaleString("en-US")}`;
  }
  function sectionOf(path) {
    if (path[0] === "cs") return "college";
    if (path[0] === "rs" || path[0] === "fs") return "retire";
    return "budget";
  }
  var SIM_CACHE = /* @__PURE__ */ new WeakMap();
  var SKIP = /* @__PURE__ */ new Set([JSON.stringify(["fs", "nominal"])]);
  var PCT_KEYS = /* @__PURE__ */ new Set(["raise", "ret", "inf", "wd", "tax", "draw"]);
  function isPct(path) {
    if (path[0] === "rs" && path[1] === "inv") return path[3] === "ret";
    if (path[0] === "cs") return path[2] === "ret" || path[2] === "inf";
    if (path[1] === "sav") return path[3] === "pct";
    return path[0] !== "st" && PCT_KEYS.has(path[1]);
  }
  function same(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
  }
  function upgrade(s) {
    const sav = s.st?.sav;
    if (!sav || !Object.values(sav).some((v) => typeof v === "number")) return s;
    const out = clone(s);
    const o = out.st.sav;
    Object.entries(o).forEach(([k, v]) => {
      if (typeof v === "number") o[k] = { mode: "fixed", amt: v };
    });
    return out;
  }
  function baseRetirement(d, s, a) {
    const rs = s.rs;
    const year = retireYear(d, rs, a);
    const yrs = Math.max(a - d.primary.age, ...d.partners.map((p) => partnerRetireAge(d, rs, p, a) - p.age));
    const r = rs.ret / 100;
    const real = (y) => Math.pow(1 + rs.inf / 100, y);
    const parts = [];
    const ages = {};
    const years = {};
    d.partners.forEach((p) => {
      const ageR = partnerRetireAge(d, rs, p, a);
      const pYrs = ageR - p.age;
      ages[p.id] = ageR;
      years[p.id] = partnerRetireYear(d, rs, p, a);
      p.pensions.forEach((pn, i) => {
        const key = `${p.id}:${i}`;
        const st = rs.pen[key];
        if (!st?.on) return;
        let v = st.monthly != null ? st.monthly : interpolatePension(st.est, ageR, p.age, pn.service_years_now);
        if (pn.grows_with_raises) {
          v *= Math.pow(1 + (rs.raise[p.id] ?? 0) / 100, Math.max(0, ageR - p.age - 1.5));
        }
        parts.push({ kind: "pension", key, name: pn.name, partner: p.id, value: v, started: true });
      });
      p.accounts.forEach((ac, i) => {
        const key = `${p.id}:${i}`;
        const st = rs.acct[key];
        if (!st?.on) return;
        const bal = fv(st.bal, st.monthly, Math.round(pYrs * 12), r);
        const w = drawPct(rs, `acct:${key}`) / 100 / 12;
        parts.push({
          kind: "account",
          key,
          name: ac.name,
          partner: p.id,
          value: bal / real(pYrs) * w,
          balance: bal,
          yrs: pYrs,
          started: true
        });
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
        parts.push({
          kind: "ss",
          key: p.id,
          name: `${p.name} Social Security`,
          partner: p.id,
          value,
          started: ageThen >= claimAge - 0.01,
          claimAge,
          start: yearAtAge(d, p, Math.ceil(claimAge - 0.01))
        });
      });
    }
    return { age: a, yrs, year, years, ages, parts };
  }
  function investmentParts(d, s, yrs, bals) {
    const real = Math.pow(1 + s.rs.inf / 100, yrs);
    const out = [];
    const add = (kind, id, name) => {
      const key = `${kind === "investment" ? "inv" : "sav"}:${id}`;
      const bal = bals[key] ?? 0;
      if (bal <= 0) return;
      out.push({
        kind,
        key: id,
        name,
        partner: "",
        value: bal / real * drawPct(s.rs, key) / 100 / 12,
        balance: bal,
        yrs,
        started: true
      });
    };
    d.p.investments.forEach((v) => {
      if (s.rs.inv[v.id]) add("investment", v.id, v.name);
    });
    retireSavings(d).forEach((sv) => add("savings", sv.id, sv.name));
    return out;
  }
  function incomeFrom(d, s, R, y) {
    const { st, rs, fs } = s;
    const n = Math.max(0, y - d.todayYear);
    const pay = sum(d.partners.filter((p) => y < R.years[p.id]).map((p) => (st.inc[p.id] ?? 0) * Math.pow(1 + (rs.raise[p.id] ?? 0) / 100, n))) + (y < R.year ? st.inc.other ?? 0 : 0);
    const paid = sum(R.parts.filter((x) => x.kind === "investment" || x.kind === "savings" ? y >= R.year : y >= R.years[x.partner] && (x.kind !== "ss" || y >= (x.start ?? 0))).map((x) => x.value));
    return pay + paid * (1 - fs.tax / 100);
  }
  function spendingAt(d, s, y, retYear) {
    const { st, fs } = s;
    const t = y + 0.5;
    const total = d.children.length;
    const kids = d.children.filter((_, k) => t < d.gradT(k)).length;
    const gone = total ? (total - kids) / total : 0;
    const ret = y >= retYear;
    const cats = {};
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
    return {
      y,
      kids,
      ret,
      cats,
      living,
      annual,
      health,
      emergency: d.funds.length ? em : 0,
      spend: living + annual + health
    };
  }

  // src/app.ts
  var SAVE_DELAY_MS = 400;
  var app = {
    d: null,
    S: null,
    defs: null
  };
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }
  function $in(id) {
    return $(id);
  }
  function onChange(fn) {
    listeners.push(fn);
  }
  function changed() {
    scheduleSave();
    listeners.forEach((fn) => fn());
  }
  function num(el) {
    const v = parseFloat(el.value);
    return isNaN(v) ? 0 : v;
  }
  async function load() {
    const p = await get("/api/payload");
    if (p.error) return p;
    app.d = new Data(p);
    app.defs = defaults(app.d);
    const state2 = await get("/api/state");
    app.S = rebase(app.defs, state2.ui?.S, state2.ui?.base);
    return p;
  }
  async function saveNow() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    await send("PUT", "/api/state/ui", { S: app.S, base: app.defs });
  }
  function showTip(e, html) {
    const tip = $("tip");
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 250)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  }
  function hideTip() {
    $("tip").hidden = true;
  }
  function scrollToEl(el) {
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  var listeners = [];
  var timer = 0;
  function scheduleSave() {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      send("PUT", "/api/state/ui", { S: app.S, base: app.defs }).catch(() => {
      });
    }, SAVE_DELAY_MS);
  }

  // src/ui/categorize.ts
  var PREVIEW_DELAY_MS = 250;
  var MAX_TABLE_ROWS = 1500;
  var KINDS = [
    ["spending", "Regular spending"],
    ["one_time", "One-time cost"],
    ["credit", "Credit (money in)"],
    ["ignore", "Ignore (transfer, pay)"]
  ];
  async function loadTx() {
    txData = await get("/api/transactions");
    return txData;
  }
  async function openRuleDialog(txId, onSaved = reloadPage) {
    const data = txData ?? await loadTx();
    const tx = txId ? data.rows.find((r) => r.id === txId) ?? null : null;
    const dlg = document.getElementById("dlg");
    const fields = [
      "description",
      "category",
      "source",
      ...tx ? Object.keys(tx.raw) : [...new Set(data.rows.slice(0, 50).flatMap((r) => Object.keys(r.raw)))]
    ];
    const fieldOpts = (sel) => [...new Set(fields)].map((f) => `<option value="${esc(f)}"${f === sel ? " selected" : ""}>${esc(f === "category" ? "bank's category" : f)}</option>`).join("");
    const guess = tx ? merchant(tx.description) : "";
    const howText = tx ? describeHow(tx, data) : "";
    dlg.innerHTML = `<form method="dialog" class="form" id="rule-form">
    <div class="dlg-head"><h3>${tx ? "Categorize a transaction" : "New rule"}</h3>
      <button class="btn sm" type="button" data-x>Close</button></div>
    <div class="dlg-body">
      ${tx ? `<div class="panel" style="padding:10px 12px;display:grid;gap:2px">
        <span class="mono">${esc(tx.date)} \xB7 ${esc(tx.source)}</span>
        <b>${esc(tx.description)}</b>
        <span class="small">${fmt(tx.amount, 2)} ${tx.amount < 0 ? "(money in)" : ""} \xB7 now
          <b>${esc(tx.category)}</b> <span class="muted">${esc(howText)}</span></span></div>` : ""}
      <label class="field"><span>Category</span><select id="rd-cat">${catOptions(
      data.categories,
      tx?.category
    )}<option value="__new">New category\u2026</option></select></label>
      <div class="fgrid" id="rd-new" hidden>
        <label class="field"><span>New category name</span><input id="rd-new-name" type="text"></label>
        <label class="field"><span>Kind</span><select id="rd-new-kind">${KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      </div>
      <div class="ops" role="radiogroup" aria-label="Which transactions">
        ${tx ? `<label><input type="radio" name="op" value="row" checked><span class="opbody">
          <b>Just this transaction</b><span class="small muted">Always wins over other rules.</span>
          </span></label>` : ""}
        <label><input type="radio" name="op" value="contains"${tx ? "" : " checked"}><span
          class="opbody"><b>Where a field contains text</b><span class="inline"><select
          id="rd-c-field">${fieldOpts("description")}</select> contains <input type="text"
          id="rd-c-text" value="${esc(guess)}"></span></span></label>
        <label><input type="radio" name="op" value="any"><span class="opbody"><b>Where any field
          contains text</b><span class="inline"><input type="text" id="rd-a-text" value="${esc(guess)}"></span></span></label>
        <label><input type="radio" name="op" value="matches"><span class="opbody"><b>Where a field
          matches a pattern</b><span class="inline"><select id="rd-m-field">${fieldOpts("description")}</select> matches <input type="text" id="rd-m-text" value="${esc(guess ? `^${guess.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "")}"></span><span
          class="small muted">A regular expression, e.g. <span class="mono">COFFEE|CAFE</span>.
          Case is ignored.</span></span></label>
        <label><input type="radio" name="op" value="similar"><span class="opbody"><b>Similar to
          ${tx ? "this transaction's" : "some text in a"} field</b><span class="inline"><select
          id="rd-s-field">${fieldOpts("description")}</select>${tx ? "" : ' similar to <input type="text" id="rd-s-text">'} at least <input type="number"
          id="rd-s-thr" min="50" max="100" step="5" value="85" style="width:64px">% alike</span><span
          class="small muted">Ignores store numbers and codes, e.g. "STORE #401" and
          "STORE #988".</span></span></label>
      </div>
      <details><summary class="small">Only some transactions (optional)</summary>
        <div class="fgrid" style="margin-top:8px">
          <label class="field"><span>Source</span><select id="rd-src"><option value="">Any</option>${data.sources.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
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
    const $d = (id) => dlg.querySelector(`#${id}`);
    const op = () => dlg.querySelector("input[name=op]:checked").value;
    const build = () => {
      const catSel = $d("rd-cat").value;
      const category = catSel === "__new" ? $d("rd-new-name").value.trim() : catSel;
      if (!category) return null;
      const r = { category };
      switch (op()) {
        case "row":
          r.row = tx.id;
          break;
        case "contains":
          r.field = $d("rd-c-field").value;
          r.contains = $d("rd-c-text").value;
          break;
        case "any":
          r.field = "*";
          r.contains = $d("rd-a-text").value;
          break;
        case "matches":
          r.field = $d("rd-m-field").value;
          r.matches = $d("rd-m-text").value;
          break;
        default: {
          const f = $d("rd-s-field").value;
          r.field = f;
          r.similar_to = tx ? fieldOf(tx, f) : $d("rd-s-text").value;
          r.threshold = Math.min(1, Math.max(0.5, (+$d("rd-s-thr").value || 85) / 100));
        }
      }
      if (op() !== "row") {
        if ($d("rd-src").value) r.source = $d("rd-src").value;
        if ($d("rd-dir").value) r.direction = $d("rd-dir").value;
        if ($d("rd-min").value) r.min_amount = +$d("rd-min").value;
        if ($d("rd-max").value) r.max_amount = +$d("rd-max").value;
      }
      if (r.field === "description") delete r.field;
      return r;
    };
    let timer3 = 0;
    const preview = () => {
      window.clearTimeout(timer3);
      timer3 = window.setTimeout(async () => {
        const r = build();
        const pv = $d("rd-pv");
        if (!r) {
          pv.innerHTML = '<span class="muted">Pick a category.</span>';
          return;
        }
        try {
          const res = await send(
            "POST",
            "/api/rules/preview",
            { ...r, category: r.category || "x" }
          );
          pv.innerHTML = `<b>Matches ${res.matched} transaction${res.matched === 1 ? "" : "s"}</b>${res.matched ? ` \xB7 ${res.changed} would change to ${esc(r.category)}` : ""}${res.blocked ? ` \xB7 ${res.blocked} pinned by "just this transaction" rules stay as they are` : ""}${res.sample.length ? `<table>${res.sample.map((s) => `<tr><td class="mono">${esc(s.date)}</td><td>${esc(s.description)}</td><td class="mono" style="text-align:right">${fmt(s.amount, 2)}</td><td class="muted">${esc(s.category)}</td></tr>`).join("")}</table>` : ""}`;
          $d("rd-err").textContent = "";
        } catch (err) {
          pv.innerHTML = "";
          $d("rd-err").textContent = err.message;
        }
      }, PREVIEW_DELAY_MS);
    };
    dlg.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => dlg.close()));
    dlg.addEventListener("input", preview);
    dlg.addEventListener("change", (e) => {
      if (e.target.id === "rd-cat") {
        $d("rd-new").hidden = $d("rd-cat").value !== "__new";
      }
      preview();
    });
    dlg.querySelectorAll(".ops label").forEach((lab) => {
      lab.addEventListener("focusin", () => {
        lab.querySelector("input[type=radio]").checked = true;
        preview();
      });
    });
    $d("rd-save").addEventListener("click", async () => {
      const r = build();
      if (!r) {
        $d("rd-err").textContent = "Pick a category (or name the new one).";
        return;
      }
      try {
        if ($d("rd-cat").value === "__new") {
          await addCategory(r.category, $d("rd-new-kind").value);
        }
        await send("POST", "/api/rules", r);
        dlg.close();
        txData = null;
        onSaved();
      } catch (err) {
        $d("rd-err").textContent = err instanceof ApiError ? err.message : String(err);
      }
    });
    dlg.showModal();
    preview();
  }
  async function renderCategorizeTab(root, markDirty) {
    root.innerHTML = '<p class="muted">Loading transactions\u2026</p>';
    let data;
    try {
      data = await loadTx();
    } catch (err) {
      root.innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
      return;
    }
    const refresh2 = () => {
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
        <select id="ct-cat" aria-label="Category"><option value="">All categories</option>${data.categories.map((c) => `<option>${esc(c.name)}</option>`).join("")}</select>
        <select id="ct-src" aria-label="Source"><option value="">All sources</option>${data.sources.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
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
    const q = root.querySelector("#ct-q");
    const fCat = root.querySelector("#ct-cat");
    const fSrc = root.querySelector("#ct-src");
    const fHow = root.querySelector("#ct-how");
    const fWin = root.querySelector("#ct-win");
    const draw = () => {
      const needle = q.value.trim().toLowerCase();
      let rows = data.rows.filter((r) => (!fWin.checked || r.in_window) && (!fCat.value || r.category === fCat.value) && (!fSrc.value || r.source === fSrc.value) && (!fHow.value || r.how === fHow.value) && (!needle || r.description.toLowerCase().includes(needle)));
      const k = sort.key;
      rows = rows.slice().sort((a, b) => {
        const x = a[k];
        const y = b[k];
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(
          String(y)
        );
        return sort.dir * c;
      });
      root.querySelector("#ct-count").textContent = `${rows.length} transaction${rows.length === 1 ? "" : "s"}${rows.length > MAX_TABLE_ROWS ? ` \xB7 first ${MAX_TABLE_ROWS} shown` : ""}`;
      root.querySelector("#ct-table tbody").innerHTML = rows.slice(0, MAX_TABLE_ROWS).map((r) => `<tr data-id="${esc(r.id)}"><td class="d">${esc(r.date)}</td><td>${esc(r.description)}</td>
        <td>${esc(r.source)}</td><td class="r">${fmt(r.amount, 2)}</td><td>${esc(r.category)}</td>
        <td class="how">${esc(describeHow(r, data))}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No transactions match.</td></tr>';
      root.querySelectorAll("#ct-table th").forEach((th) => {
        th.setAttribute("aria-sort", th.dataset.k === sort.key ? sort.dir > 0 ? "ascending" : "descending" : "none");
      });
    };
    [q, fCat, fSrc, fHow, fWin].forEach((el) => el.addEventListener("input", draw));
    root.querySelectorAll("#ct-table th").forEach((th) => {
      th.addEventListener("click", () => {
        sort = { key: th.dataset.k, dir: sort.key === th.dataset.k ? -sort.dir : th.dataset.k === "amount" || th.dataset.k === "date" ? -1 : 1 };
        draw();
      });
    });
    root.querySelector("#ct-table tbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openRuleDialog(tr.dataset.id, refresh2);
    });
    root.querySelector("#ct-new").addEventListener("click", () => openRuleDialog(null, refresh2));
    drawRules(root, data, refresh2);
    draw();
  }
  function describeRule(r) {
    const f = r.field ?? "description";
    const where = f === "*" ? "any field" : f === "category" ? "bank's category" : f;
    let s;
    if (r.row) s = "this transaction only";
    else if (r.equals != null) s = `${where} is "${r.equals}"`;
    else if (r.contains != null) s = `${where} contains "${r.contains}"`;
    else if (r.matches != null) s = `${where} matches /${r.matches}/`;
    else s = `${where} is ${Math.round((r.threshold ?? 0.85) * 100)}% like "${r.similar_to}"`;
    const extra = [];
    if (r.source) extra.push(`from ${r.source}`);
    if (r.direction) extra.push(r.direction === "debit" ? "money out" : "money in");
    if (r.min_amount != null) extra.push(`\u2265 ${fmt(r.min_amount)}`);
    if (r.max_amount != null) extra.push(`\u2264 ${fmt(r.max_amount)}`);
    return s + (extra.length ? ` (${extra.join(", ")})` : "");
  }
  async function addCategory(name, kind) {
    const cfg2 = await get("/api/config");
    const cats = cfg2.raw.categories ?? [];
    if (cats.some((c) => c.name === name)) return;
    await send("PUT", "/api/config/categories", [...cats, { name, kind }]);
  }
  var txData = null;
  var sort = { key: "date", dir: -1 };
  async function reloadPage() {
    await saveNow().catch(() => {
    });
    sessionStorage.setItem("fp-scroll", String(window.scrollY));
    location.reload();
  }
  function catOptions(cats, selected) {
    return KINDS.map(([k, l]) => {
      const list = cats.filter((c) => c.kind === k);
      return list.length ? `<optgroup label="${l}">${list.map((c) => `<option${c.name === selected ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>` : "";
    }).join("");
  }
  function fieldOf(tx, f) {
    if (f === "description") return tx.description;
    if (f === "category") return tx.bank_category;
    if (f === "source") return tx.source;
    return tx.raw[f] ?? "";
  }
  function merchant(desc) {
    return desc.replace(/^(SQ|TST|SP|DD|PB|EB|ACT|PAYPAL)\s*\*\s*/i, "").replace(/[*#].*$/, "").replace(/\s+\d[\d\s-]*.*$/, "").trim().toUpperCase();
  }
  function describeHow(r, data) {
    if (r.how === "row") return "pinned by a just-this-row rule";
    if (r.how === "rule" && r.rule != null) {
      return `rule ${r.rule + 1}: ${describeRule(data.rules[r.rule])}`;
    }
    if (r.how === "bank") return `bank category "${r.bank_category}"`;
    return "no rule matched (default)";
  }
  function drawRules(root, data, refresh2) {
    const counts = /* @__PURE__ */ new Map();
    data.rows.forEach((r) => {
      if (r.rule != null) counts.set(r.rule, (counts.get(r.rule) ?? 0) + 1);
    });
    const body = root.querySelector("#ct-rules tbody");
    body.innerHTML = data.rules.map((r, i) => `<tr><td class="d">${i + 1}</td><td>${esc(describeRule(r))}</td><td>${esc(r.category)}</td><td class="r">${counts.get(i) ?? 0}</td>
      <td style="white-space:nowrap"><button class="btn sm" type="button" data-mv="${i}" data-by="-1"
        aria-label="Move up"${i === 0 ? " disabled" : ""}>\u2191</button> <button class="btn sm"
        type="button" data-mv="${i}" data-by="1" aria-label="Move down"${i === data.rules.length - 1 ? " disabled" : ""}>\u2193</button> <button class="btn sm danger"
        type="button" data-del="${i}">Delete</button></td></tr>`).join("") || '<tr><td colspan="5" class="muted">No rules yet.</td></tr>';
    const msg = root.querySelector("#ct-msg");
    const save3 = async (rules) => {
      try {
        await send("PUT", "/api/config/rules", rules);
        txData = null;
        refresh2();
      } catch (err) {
        msg.className = "msg err";
        msg.textContent = err.message;
      }
    };
    body.querySelectorAll("[data-mv]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = +b.dataset.mv;
        const j = i + +b.dataset.by;
        const rules = data.rules.slice();
        [rules[i], rules[j]] = [rules[j], rules[i]];
        save3(rules);
      });
    });
    body.querySelectorAll("[data-del]").forEach((b) => {
      let armed = false;
      b.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          b.textContent = "Click again";
          return;
        }
        save3(data.rules.filter((_, i) => i !== +b.dataset.del));
      });
    });
  }

  // src/ui/spending.ts
  var CREDIT_COLORS = ["--r2", "--r3", "--r4", "--r5", "--r1"];
  var MAX_ROWS = 400;
  var MONTH_NAMES = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  var DRAG_PX = 5;
  function buildSpending() {
    const d = app.d;
    const p = d.p;
    A = p.all_by_cat ?? p.by_cat;
    MON = p.all_months ?? p.months;
    LBL = p.all_month_labels ?? p.month_labels;
    TX = [...p.tx, ...p.other_tx ?? []];
    monthOf = new Map(MON.map((m, i) => [m, i]));
    yearEnd = MON.length - 1;
    credCats = d.credits;
    d.credits.forEach((c) => on[d.cats[c].name] = d.cats[c].default_on);
    d.costs.forEach((c) => on[d.cats[c].name] = true);
    savCats = d.cats.map((_, i) => i).filter((i) => d.cats[i].kind === "ignore" && sum(A[i] ?? []) > 0);
    $("actbody").addEventListener("change", (e) => {
      const el = e.target;
      if (!el.dataset.on) return;
      on[el.dataset.on] = el.checked;
      buildTable();
    });
    $("actbody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (b) selectCat(b.dataset.pick === "" ? null : +b.dataset.pick);
    });
    document.querySelectorAll("#pview button").forEach((b) => {
      b.addEventListener("click", () => setView(b.dataset.v));
    });
    $("ptools").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "back") dayMonth = null;
      else yearEnd = clampEnd(yearEnd + (b.dataset.act === "later" ? 1 : -1));
      refresh();
    });
    const mf = $("mfilter");
    mf.addEventListener("change", () => {
      dayMonth = mf.value === "" ? null : +mf.value;
      refresh();
    });
    $("q").addEventListener("input", drawDetail);
    $("sort").addEventListener("change", drawDetail);
    document.querySelectorAll("#xmode button").forEach((b) => {
      b.addEventListener("click", () => setMode(b.dataset.v));
    });
    $("recat").addEventListener("click", () => {
      recat = !recat;
      $("recat").setAttribute("aria-expanded", String(recat));
      $("recat-note").hidden = !recat;
      $("tx-panel").classList.toggle("recat-on", recat);
    });
    $("txlist").addEventListener("click", (e) => {
      if (!recat) return;
      const tr = e.target.closest("tr[data-id]");
      if (tr) openRuleDialog(tr.dataset.id);
    });
    wirePointer();
    view = MON.length > 12 ? "year" : "all";
    setMode("spend");
  }
  function selectCat(c) {
    if (c !== null && !inMode(c)) {
      mode = isCredit(c) ? "cred" : "spend";
      markMode();
    }
    selCat = c;
    refresh();
  }
  function selectionAvg(c) {
    const s = selection();
    return s.length ? sum(s.map((i) => A[c][i] ?? 0)) / s.length * (isCredit(c) ? -1 : 1) : 0;
  }
  function selectionLabel() {
    const s = selection();
    if (!s.length) return "no months";
    const span2 = s.length === 1 ? LBL[s[0]] : `${LBL[s[0]]} \u2013 ${LBL[s[s.length - 1]]}`;
    return `${span2} (${s.length} month${s.length === 1 ? "" : "s"})`;
  }
  var selCat = null;
  var mode = "spend";
  var view = "all";
  var yearEnd = 0;
  var range = null;
  var dayMonth = null;
  var recat = false;
  var A = [];
  var MON = [];
  var LBL = [];
  var TX = [];
  var monthOf = /* @__PURE__ */ new Map();
  var credCats = [];
  var savCats = [];
  var cols = [];
  var dayTotals = /* @__PURE__ */ new Map();
  var drag = null;
  var on = {};
  var isCredit = (c) => app.d.cats[c].kind === "credit";
  var inMode = (c) => mode === "both" ? true : mode === "cred" ? isCredit(c) : !isCredit(c);
  var credCol = (c) => CREDIT_COLORS[Math.max(0, credCats.indexOf(c)) % CREDIT_COLORS.length];
  var label = (c) => app.d.cats[c].name;
  var span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  function clampEnd(end) {
    return Math.max(Math.min(11, MON.length - 1), Math.min(MON.length - 1, end));
  }
  function selection() {
    if (view === "year") return span(Math.max(0, yearEnd - 11), yearEnd);
    if (view === "range" && range) return span(range[0], range[1]);
    return span(0, MON.length - 1);
  }
  function refresh() {
    markView();
    buildTable();
    drawChart();
    drawDetail();
  }
  function setMode(v) {
    mode = v;
    selCat = null;
    markMode();
    refresh();
  }
  function setView(v) {
    if (v === "range" && !range) return;
    view = v;
    dayMonth = null;
    refresh();
  }
  function markMode() {
    document.querySelectorAll("#xmode button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.v === mode));
    });
  }
  function markView() {
    document.querySelectorAll("#pview button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.v === view));
      if (b.dataset.v === "range") b.disabled = !range;
    });
    const s = selection();
    const tools = $("ptools");
    if (dayMonth !== null) {
      tools.innerHTML = `<button class="btn sm" type="button" data-act="back">\u2190 Back to months</button>`;
    } else if (view === "year" && MON.length > 12) {
      tools.innerHTML = `<button class="btn sm" type="button" data-act="earlier"
      aria-label="One month earlier"${yearEnd <= 11 ? " disabled" : ""}>\u2039</button><button
      class="btn sm" type="button" data-act="later" aria-label="One month later"${yearEnd >= MON.length - 1 ? " disabled" : ""}>\u203A</button>`;
    } else {
      tools.innerHTML = "";
    }
    $("plabel").textContent = dayMonth !== null ? `Days of ${LBL[dayMonth]}` : view === "typical" ? `Average of each month over ${MON.length} months` : selectionLabel();
    $("chart-hint").textContent = dayMonth !== null ? "Each day of the month. Back returns to the months." : view === "all" ? "Drag across months to select a period. Click a month to see its days." : view === "year" ? "Drag sideways (or use \u2039 \u203A) to move the year. Click a month to see its days." : view === "range" ? "The selected months. Click a month to see its days; pick All data to select another period." : "Each calendar month's average across all your data; the line marks its lowest and highest year.";
    const mf = $("mfilter");
    mf.innerHTML = '<option value="">All months shown</option>' + s.map((i) => `<option value="${i}">${esc(LBL[i])}</option>`).join("");
    mf.value = dayMonth === null ? "" : String(dayMonth);
  }
  function buildTable() {
    const d = app.d;
    const months = selection();
    const n = Math.max(1, months.length);
    const signed = (c) => months.map((m) => (isCredit(c) ? -1 : 1) * (A[c][m] ?? 0));
    const stats = (v) => [sum(v) / n, Math.min(...v), Math.max(...v)];
    const cells = (v, neg = false) => stats(v).map((x) => `<td class="num">${neg ? `(${fmt(x)})` : fmt(x)}</td>`).join("");
    const nameCell = (c, pad = 0, toggle = false, pick = true) => {
      const cat = d.cats[c];
      const nm = esc(isCredit(c) ? cat.label || cat.name : cat.name);
      const link = pick ? `<button class="cat-link" type="button" data-pick="${c}">${nm}</button>` : nm;
      return `<td${pad ? ` style="padding-left:${pad}px"` : ""}>${toggle ? `<label class="tg"><input
      type="checkbox" data-on="${esc(cat.name)}"${on[cat.name] ? " checked" : ""}>${isCredit(c) ? "\u2212 " : ""}${link}</label>` : link}</td>`;
    };
    const row2 = (c, pad = 0, toggle = false, pick = true) => {
      const off = toggle && !on[d.cats[c].name];
      return `<tr class="${[isCredit(c) ? "credit" : "", off ? "off" : "", selCat === c ? "sel" : ""].join(" ").trim()}">${nameCell(c, pad, toggle, pick)}${cells(signed(c), isCredit(c))}</tr>`;
    };
    const totalRow = (lbl, series2, pick = false) => `<tr class="total${pick && selCat === null ? " sel" : ""}"><td>${pick ? `<button class="cat-link" type="button"
      data-pick="">${esc(lbl)}</button>` : esc(lbl)}</td>${cells(series2)}</tr>`;
    const series = (list) => months.map((m) => sum(list.map((c) => (isCredit(c) ? -1 : 1) * (A[c][m] ?? 0))));
    const groups = [];
    d.regular.forEach((i) => {
      if (!groups.includes(d.cats[i].group)) groups.push(d.cats[i].group);
    });
    const withCredits = mode === "both";
    let h = "";
    const counted = [];
    const credCount = [];
    if (mode !== "cred") {
      groups.forEach((g) => {
        h += `<tr class="group"><td colspan="4">${esc(g)}</td></tr>`;
        d.regular.filter((i) => d.cats[i].group === g).sort((a, b) => d.avg(b) - d.avg(a)).forEach((i) => {
          h += row2(i);
          counted.push(i);
          if (withCredits) {
            d.offsetsOf(d.cats[i].name).forEach((c) => {
              h += row2(c, 22, true);
              if (on[d.cats[c].name]) credCount.push(c);
            });
          }
        });
      });
      h += totalRow("Regular spending", series(d.regular));
      if (d.costs.length) {
        h += '<tr class="group"><td colspan="4">Annual, 1-time &amp; emergency</td></tr>';
        d.costs.forEach((i) => {
          h += row2(i, 0, true);
          if (on[d.cats[i].name]) counted.push(i);
          if (withCredits) {
            d.offsetsOf(d.cats[i].name).forEach((c) => {
              h += row2(c, 22, true);
              if (on[d.cats[c].name] && on[d.cats[i].name]) credCount.push(c);
            });
          }
        });
      }
      if (savCats.length) {
        h += '<tr class="group"><td colspan="4">Savings &amp; transfers</td></tr>';
        savCats.forEach((i) => {
          h += row2(i, 0, true, false);
          if (on[d.cats[i].name]) counted.push(i);
        });
      }
    }
    if (mode !== "spend") {
      const loose = mode === "cred" ? d.credits : d.credits.filter((c) => !d.cats[c].offsets);
      if (loose.length) {
        h += `<tr class="group"><td colspan="4">${mode === "cred" ? "Credits" : "Other credits"}</td></tr>`;
        loose.forEach((c) => h += row2(c, 0, true));
        credCount.push(...loose.filter((c) => on[d.cats[c].name]));
      }
    }
    if (mode === "cred") {
      h += totalRow("All credits", series(credCount), true);
    } else {
      const spent = series(counted);
      const cred = series(credCount);
      h += totalRow(
        mode === "both" ? "Net (ticked)" : "Total (ticked)",
        spent.map((v, i) => v - cred[i]),
        true
      );
    }
    $("actbody").innerHTML = h;
    $("act-avg-head").textContent = "Avg / mo";
    $("act-note").textContent = `${selectionLabel()}. ${mode === "cred" ? "Money in, as positive amounts." : "Ticked rows count in the total."}`;
  }
  function buildCols() {
    if (dayMonth !== null) {
      const ym = MON[dayMonth];
      const days = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
      dayTotals = /* @__PURE__ */ new Map();
      TX.filter((t) => t[0].startsWith(ym)).forEach((t) => {
        const m = dayTotals.get(t[0]) ?? /* @__PURE__ */ new Map();
        m.set(t[3], (m.get(t[3]) ?? 0) + t[2]);
        dayTotals.set(t[0], m);
      });
      return span(1, days).map((n) => ({ label: String(n), day: `${ym}-${String(n).padStart(2, "0")}` }));
    }
    if (view === "typical") {
      return MONTH_NAMES.map((name, k) => ({
        label: name,
        months: MON.map((m, i) => +m.slice(5, 7) === k + 1 ? i : -1).filter((i) => i >= 0)
      }));
    }
    return selection().map((i) => ({ label: LBL[i], month: i }));
  }
  function raw(c, i) {
    return A[c][i] ?? 0;
  }
  function colValue(col, cats) {
    const one = (c, i) => (isCredit(c) ? -1 : 1) * raw(c, i);
    if (col.day) {
      const m = dayTotals.get(col.day);
      return m ? sum(cats.map((c) => (isCredit(c) ? -1 : 1) * (m.get(c) ?? 0))) : 0;
    }
    if (col.months) {
      return col.months.length ? sum(col.months.map((i) => sum(cats.map((c) => one(c, i))))) / col.months.length : 0;
    }
    return sum(cats.map((c) => one(c, col.month)));
  }
  function colSpread(col, cats) {
    if (!col.months || col.months.length < 2) return null;
    const v = col.months.map((i) => sum(cats.map((c) => (isCredit(c) ? -1 : 1) * raw(c, i))));
    return [Math.min(...v), Math.max(...v)];
  }
  function drawChart() {
    const d = app.d;
    cols = buildCols();
    const svg = $("mchart");
    const W = 960;
    const H = 300;
    const L = 52;
    const R = 12;
    const T = 14;
    const B = 30;
    const pw = W - L - R;
    const ph = H - T - B;
    const bw = pw / Math.max(1, cols.length);
    let up;
    let down = [];
    let avgOf = [];
    const unit = dayMonth !== null ? "day" : "mo";
    const sw = (col, name) => `<span><i class="sw" style="background:${col}"></i>${esc(name)}</span>`;
    let title;
    let leg;
    if (selCat === null) {
      if (mode === "cred") {
        up = credCats.map((c) => ({ col: `var(${credCol(c)})`, cats: [c], name: label(c) }));
        avgOf = credCats;
        title = "All credits";
        leg = up.map((x) => sw(x.col, x.name)).join("");
      } else {
        up = [
          { col: "var(--accent)", cats: d.regular, name: "Regular" },
          { col: "var(--onetime)", cats: d.costs, name: "Annual, 1-time & emergency" }
        ];
        avgOf = d.regular;
        if (mode === "both") {
          down = [{ col: "var(--r2)", cats: credCats, name: "Credits" }];
          title = "Spending (above) and credits (below)";
          leg = sw("var(--accent)", "Regular") + sw("var(--onetime)", "Annual, 1-time & emergency") + sw("var(--r2)", "Credits");
        } else {
          title = "All spending";
          leg = sw("var(--accent)", "Regular") + sw("var(--onetime)", "Annual, 1-time & emergency");
        }
      }
    } else {
      const col = isCredit(selCat) ? `var(${credCol(selCat)})` : "var(--accent)";
      up = [{ col, cats: [selCat], name: label(selCat) }];
      avgOf = [selCat];
      title = `${isCredit(selCat) ? "Credits: " : ""}${label(selCat)}`;
      leg = sw(col, label(selCat));
    }
    const avg = cols.length ? sum(cols.map((c) => colValue(c, avgOf))) / cols.length : 0;
    const avgName = selCat === null && mode !== "cred" ? "Avg regular" : "Avg";
    leg += `<span><i class="ln"></i>${avgName} ${fmt(avg)}/${unit}</span>` + (view === "typical" && dayMonth === null ? "<span>\u2502 lowest \u2013 highest year</span>" : "");
    title += dayMonth !== null ? ` by day, ${LBL[dayMonth]}` : view === "typical" ? ", typical year" : " by month";
    $("chart-title").textContent = title;
    $("legend").innerHTML = leg;
    const upCats = up.flatMap((s) => s.cats);
    const spreads = cols.map((c) => dayMonth === null ? colSpread(c, upCats) : null);
    const upT = cols.map((c) => sum(up.map((s) => Math.max(colValue(c, s.cats), 0))));
    const dnT = cols.map((c) => sum(down.map((s) => Math.max(colValue(c, s.cats), 0))));
    const maxU = Math.max(...upT, ...spreads.map((s) => s ? s[1] : 0), avg, 1);
    const maxD = Math.max(...dnT, 0);
    const step = niceStep(maxU + maxD);
    const topU = Math.ceil(maxU / step) * step;
    const topD = maxD ? Math.ceil(maxD / step) * step : 0;
    const yspan = topU + topD;
    const y = (v) => T + ph * (topU - v) / yspan;
    let g = "";
    for (let v = -topD; v <= topU + 1e-6; v += step) {
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v < 0 ? "\u2212" : ""}${fk(Math.abs(v))}</text>`;
    }
    if (topD) {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--ink3);stroke-width:1.5"/>`;
    }
    const every = Math.ceil(cols.length / (dayMonth !== null ? 16 : 14));
    cols.forEach((col, k) => {
      const x = L + k * bw + bw * 0.18;
      const w = bw * 0.64;
      let bars = "";
      let base = y(0);
      up.forEach((s) => {
        const h = ph * Math.max(colValue(col, s.cats), 0) / yspan;
        if (h > 0.5) {
          base -= h;
          bars += `<rect x="${x}" y="${base}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="3" style="fill:${s.col}"/>`;
        }
      });
      base = y(0);
      down.forEach((s) => {
        const h = ph * Math.max(colValue(col, s.cats), 0) / yspan;
        if (h > 0.5) {
          bars += `<rect x="${x}" y="${base + 2}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="3" style="fill:${s.col}"/>`;
          base += h;
        }
      });
      const sp = spreads[k];
      if (sp) {
        const cx = L + k * bw + bw / 2;
        bars += `<line class="whisk" x1="${cx}" x2="${cx}" y1="${y(sp[1])}" y2="${y(sp[0])}"/><line
        class="whisk" x1="${cx - 6}" x2="${cx + 6}" y1="${y(sp[1])}" y2="${y(sp[1])}"/><line
        class="whisk" x1="${cx - 6}" x2="${cx + 6}" y1="${y(sp[0])}" y2="${y(sp[0])}"/>`;
      }
      const head = col.day ? `${LBL[dayMonth]} ${col.label}` : col.months ? `${col.label}, average of ${col.months.length} year${col.months.length === 1 ? "" : "s"}` : LBL[col.month];
      let tip = `<b>${esc(head)}</b>`;
      up.concat(down).forEach((s) => {
        const v = colValue(col, s.cats);
        if (Math.abs(v) >= 0.5) tip += `<br>${esc(s.name)} ${fmt(v)}`;
      });
      if (selCat === null && mode === "both") tip += `<br><b>Net ${fmt(upT[k] - dnT[k])}</b>`;
      else if (up.length > 1) tip += `<br><b>Total ${fmt(upT[k])}</b>`;
      if (sp) tip += `<br>Lowest ${fmt(sp[0])} \xB7 highest ${fmt(sp[1])}`;
      const lab = k % every === 0 || cols.length <= 14 ? `<text x="${L + k * bw + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(col.label)}</text>` : "";
      g += `<g class="m" data-k="${k}" data-tip="${tip.replace(/"/g, "&quot;")}">${bars}<rect class="hit" x="${L + k * bw}" y="${T}" width="${bw}" height="${ph}"/>${lab}</g>`;
    });
    g += `<line class="avgline" x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}"/><rect id="brush" class="brush" x="0" y="${T}" width="0" height="${ph}" visibility="hidden"/>`;
    svg.innerHTML = g;
    svg.dataset.l = String(L);
    svg.dataset.bw = String(bw);
    svg.querySelectorAll("g.m").forEach((el) => {
      el.addEventListener("mousemove", (e) => {
        if (!drag?.moved) showTip(e, el.dataset.tip);
      });
      el.addEventListener("mouseleave", hideTip);
    });
    svg.classList.toggle("pan", view === "year" && dayMonth === null && MON.length > 12);
    svg.classList.toggle("brushable", view === "all" && dayMonth === null);
  }
  function wirePointer() {
    const svg = $("mchart");
    const colAt = (clientX) => {
      const r = svg.getBoundingClientRect();
      const x = (clientX - r.left) * 960 / r.width;
      const k = Math.floor((x - +svg.dataset.l) / +svg.dataset.bw);
      return Math.max(0, Math.min(cols.length - 1, k));
    };
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, col: colAt(e.clientX), end: yearEnd, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x) < DRAG_PX) return;
      drag.moved = true;
      hideTip();
      if (dayMonth !== null) return;
      if (view === "year") {
        const r = svg.getBoundingClientRect();
        const shift = Math.round((e.clientX - drag.x) * 960 / r.width / +svg.dataset.bw);
        const end = clampEnd(drag.end - shift);
        if (end !== yearEnd) {
          yearEnd = end;
          drawChart();
          markView();
        }
      } else if (view === "all") {
        const a = Math.min(drag.col, colAt(e.clientX));
        const b = Math.max(drag.col, colAt(e.clientX));
        const brush = svg.querySelector("#brush");
        const l = +svg.dataset.l;
        const bw = +svg.dataset.bw;
        brush.setAttribute("x", String(l + a * bw));
        brush.setAttribute("width", String((b - a + 1) * bw));
        brush.setAttribute("visibility", "visible");
      }
    });
    svg.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const d0 = drag;
      drag = null;
      if (!d0.moved) {
        const col = cols[colAt(e.clientX)];
        if (col?.month !== void 0) {
          dayMonth = col.month;
          refresh();
        }
        return;
      }
      if (dayMonth !== null) return;
      if (view === "all") {
        const a = cols[Math.min(d0.col, colAt(e.clientX))].month;
        const b = cols[Math.max(d0.col, colAt(e.clientX))].month;
        range = [a, b];
        view = "range";
      }
      refresh();
    });
    svg.addEventListener("pointercancel", () => drag = null);
  }
  function merchKey(desc) {
    return desc.replace(/^(SQ|TST|SP|DD|PB|EB|ACT|RF|FH|IN|COT|TCB|CKE|SPO)\s*\*\s*/i, "$1 ").replace(/[*#].*$/, "").replace(/\s+\d[\d\s-]*.*$/, "").replace(/\s+(INC|LLC)\.?$/i, "").trim().toUpperCase();
  }
  function drawDetail() {
    const months = new Set(dayMonth !== null ? [dayMonth] : selection());
    const pool = TX.filter((t) => (selCat === null ? inMode(t[3]) : t[3] === selCat) && months.has(monthOf.get(t[0].slice(0, 7)) ?? -1));
    const credView = selCat !== null ? isCredit(selCat) : mode === "cred";
    const sg = credView ? -1 : 1;
    const mixed = selCat === null && mode === "both";
    const mm = /* @__PURE__ */ new Map();
    pool.forEach((t) => {
      const key = merchKey(t[1]) || t[1];
      const e = mm.get(key) ?? [0, 0, t[3]];
      e[0] += sg * t[2];
      e[1]++;
      mm.set(key, e);
    });
    const top = [...mm.entries()].sort((a, b) => Math.abs(b[1][0]) - Math.abs(a[1][0])).slice(0, 10);
    const mx = top.length ? Math.abs(top[0][1][0]) || 1 : 1;
    $("merchants").innerHTML = top.map(([n, [v, c, cat]]) => `<tr><td>${esc(n)}<div class="bar" style="width:${Math.max(2, 100 * Math.abs(v) / mx)}%;${isCredit(cat) ? `background:var(${credCol(cat)})` : ""}"></div></td><td class="r">${fmt(v)}<div class="small muted">${c}\xD7</div></td></tr>`).join("");
    const q = $in("q").value.trim().toLowerCase();
    let list = pool.filter((t) => !q || t[1].toLowerCase().includes(q));
    list = $("sort").value === "amt" ? list.slice().sort((a, b) => Math.abs(b[2]) - Math.abs(a[2])) : list.slice().sort((a, b) => b[0].localeCompare(a[0]));
    const shown = list.slice(0, MAX_ROWS);
    const lt = sum(list.map((t) => t[2]));
    const multiYear = new Set(list.map((t) => t[0].slice(0, 4))).size > 1;
    $("tx-count").textContent = `${list.length} \xB7 ${mixed ? `net ${fmt(lt)}` : fmt(sg * lt)}` + (list.length > MAX_ROWS ? ` \xB7 first ${MAX_ROWS} shown` : "");
    $("txlist").innerHTML = shown.map((t) => `<tr data-id="${esc(t[5])}"><td class="d">${multiYear ? t[0] : t[0].slice(5)}</td><td>${esc(t[1])}${selCat === null ? ` <span class="tag">${esc(label(t[3]))}</span>` : ""}</td><td class="r">${fmt(credView ? -t[2] : t[2], 2)}</td></tr>`).join("") || '<tr><td class="muted">No transactions match.</td></tr>';
  }

  // src/ui/planner.ts
  function buildPlanner() {
    const d = app.d;
    $("planner-sub").textContent = `Planned / mo starts at each category's ${d.n}-month average. Type a new number to try a change, and save it as a budget.`;
    buildTable2();
    buildSide();
    $("cmp-sel").addEventListener("change", () => {
      cmpKey = $("cmp-sel").value;
      update();
    });
    refreshCompare();
    onChange(update);
    update();
  }
  function fillPlanner() {
    const { d, S } = app;
    const plan = (i) => {
      const el = document.getElementById(`p-${i}`);
      if (el) el.value = String(Math.round(S.st.plan[d.cats[i].name] ?? 0));
    };
    d.regular.forEach(plan);
    d.credits.forEach(plan);
    document.querySelectorAll("[data-tg]").forEach((el) => {
      el.checked = !!S.st.on[el.dataset.tg];
    });
    document.querySelectorAll("[data-inc]").forEach((el) => {
      el.value = String(S.st.inc[el.dataset.inc] ?? 0);
    });
    document.querySelectorAll("[data-sav]").forEach((el) => {
      const v = S.st.sav[el.dataset.sav]?.[el.dataset.f];
      el.value = v == null ? "" : String(v);
    });
    $in("em-amt").value = S.st.emerg == null ? "" : String(S.st.emerg);
    renderAnnual();
  }
  function refreshCompare() {
    const sel = $("cmp-sel");
    const list = savedBudgets();
    if (cmpKey !== "avg" && !list.some((b) => b.id === cmpKey)) cmpKey = "avg";
    sel.innerHTML = `<option value="avg">${app.d.n}-mo avg</option>` + list.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
    sel.value = cmpKey;
    if (document.getElementById("psum")?.childElementCount) update();
  }
  var cmpKey = "avg";
  function compareSt() {
    const b = savedBudgets().find((x) => x.id === cmpKey);
    return b ? rebaseBudget(app.defs.st, b.st, b.base) : app.defs.st;
  }
  function buildTable2() {
    const d = app.d;
    const groups = [];
    d.regular.forEach((i) => {
      if (!groups.includes(d.cats[i].group)) groups.push(d.cats[i].group);
    });
    let h = "";
    groups.forEach((g) => {
      h += `<tr class="group"><td colspan="4">${esc(g)}</td></tr>`;
      d.regular.filter((i) => d.cats[i].group === g).sort((a, b) => d.avg(b) - d.avg(a)).forEach((i) => {
        const subs = d.offsetsOf(d.cats[i].name).filter((c) => d.isPlannerCredit(c));
        h += `<tr><td><button class="cat-link" data-cat="${i}" type="button">${esc(d.cats[i].name)}</button>${subs.length ? ' <span class="small muted">expenses</span>' : ""}</td>
            <td><input class="amt" type="number" step="25" inputmode="decimal" id="p-${i}"
              data-cat="${i}" aria-label="Planned monthly ${esc(d.cats[i].name)}"></td>
            <td class="num" id="c-${i}"></td><td><span class="delta num" id="d-${i}"></span></td></tr>`;
        if (subs.length) {
          h += subs.map(creditRow).join("") + `<tr class="subtot"><td style="padding-left:22px">${esc(d.cats[i].name)}, net</td>
                <td class="num" id="net-p-${i}" style="padding-right:14px"></td>
                <td class="num" id="net-c-${i}"></td><td></td></tr>`;
        }
      });
    });
    h += `<tr class="total"><td>Total regular spending</td>
    <td class="num" id="t-p" style="padding-right:14px"></td><td class="num" id="t-c"></td>
    <td><span class="delta num" id="t-d"></span></td></tr>`;
    const loose = d.credits.filter((c) => d.isPlannerCredit(c) && !d.cats[c].offsets);
    if (loose.length) h += loose.map(creditRow).join("");
    const body = $("ptbody");
    body.innerHTML = h;
    body.querySelectorAll("input.amt").forEach((inp) => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        app.S.st.plan[d.cats[+inp.dataset.cat].name] = isNaN(v) ? 0 : v;
        changed();
      });
    });
    bindToggles(body);
    body.querySelectorAll(".cat-link").forEach((b) => {
      b.addEventListener("click", () => {
        selectCat(+b.dataset.cat);
        scrollToEl($("spending"));
      });
    });
    const sumRow = (id, label2, cls = "") => `<tr class="${cls}"><td>${label2}</td>
    <td class="num" id="sp-${id}" style="padding-right:14px"></td><td class="num" id="sc-${id}"></td>
    <td><span class="delta num" id="sd-${id}"></span></td></tr>`;
    $("psum").innerHTML = sumRow("net", "Net spending") + sumRow("an", "Annual expenses") + sumRow("em", 'Emergency fund costs <span class="small muted" id="em-how"></span>') + savLabels().map(([k, label2]) => sumRow(k.replace(":", "-"), esc(label2))).join("") + sumRow("tot", "Monthly total, spending + savings", "total");
  }
  function creditRow(c) {
    const cat = app.d.cats[c];
    const name = cat.label || cat.name;
    return `<tr class="credit" id="row-${c}"><td style="padding-left:22px">
    <label class="toggle" style="align-items:center"><input type="checkbox"
      data-tg="${esc(cat.name)}"><span>\u2212 <button class="cat-link" data-cat="${c}" type="button">${esc(name)}</button>${cat.note ? ` <span class="small muted">${esc(cat.note)}</span>` : ""}
    </span></label></td>
    <td><input class="amt" type="number" step="25" inputmode="decimal" id="p-${c}" data-cat="${c}"
      aria-label="Planned monthly ${esc(name)}"></td>
    <td class="num" id="c-${c}"></td><td><span class="delta num" id="d-${c}"></span></td></tr>`;
  }
  function savLabels() {
    const d = app.d;
    return [
      ...d.children.map((c) => [`529:${c.id}`, `529, ${c.name}`]),
      ...d.p.savings.map((s) => [`sav:${s.id}`, s.name]),
      ...d.p.investments.map((v) => [`inv:${v.id}`, v.name])
    ];
  }
  function bindToggles(root) {
    root.querySelectorAll("[data-tg]").forEach((el) => {
      el.addEventListener("change", () => {
        app.S.st.on[el.dataset.tg] = el.checked;
        changed();
      });
    });
  }
  function buildSide() {
    const { d } = app;
    const p = d.p;
    const row2 = (key, attr, label2, note = "") => `<div class="row"><label for="${attr}-${esc(key)}">${esc(label2)}${note ? ` <span class="small muted">\xB7 ${esc(note)}</span>` : ""}</label><input class="amt"
        id="${attr}-${esc(key)}" data-${attr}="${esc(key)}" type="number" step="50"
        inputmode="decimal"></div>`;
    $("inc-rows").innerHTML = d.partners.map((x) => row2(x.id, "inc", x.name, x.take_home_note)).join("") + row2("other", "inc", "Other income");
    const kind = { stocks: "stocks", bonds: "bonds", savings: "savings", emergency: "emergency fund" };
    $("sav-rows").innerHTML = d.children.map((c) => savRow(`529:${c.id}`, `529, ${c.name}`)).join("") + p.savings.map((s) => savRow(`sav:${s.id}`, s.name, kind[s.type])).join("") + p.investments.map((v) => savRow(`inv:${v.id}`, v.name, kind[v.type])).join("");
    $("sav-note").textContent = [
      d.children.length ? "529 contributions stop at each child's high school graduation." : "",
      p.investments.length ? "Investments are added to their balance in Retirement and stop at retirement." : "",
      'Fixed amounts come off first; "% left" takes a share of what is left after spending, annual expenses and the fixed amounts; "rest" splits whatever is still left evenly.'
    ].filter(Boolean).join(" ");
    const side = $("sav-rows").closest(".side");
    side.querySelectorAll("[data-inc]").forEach((el) => {
      el.addEventListener("input", () => {
        app.S.st.inc[el.dataset.inc] = num(el);
        changed();
      });
    });
    side.querySelectorAll("[data-sav]").forEach((el) => {
      el.addEventListener("input", () => {
        const f = el.dataset.f;
        const line = app.S.st.sav[el.dataset.sav];
        if (f === "min" || f === "max") line[f] = el.value === "" ? null : num(el);
        else line[f] = num(el);
        changed();
      });
    });
    side.querySelectorAll("[data-mode]").forEach((b) => {
      b.addEventListener("click", () => {
        app.S.st.sav[b.dataset.key].mode = b.dataset.mode;
        changed();
      });
    });
    wireAnnual();
    $in("em-amt").addEventListener("input", () => {
      const el = $in("em-amt");
      app.S.st.emerg = el.value === "" ? null : num(el);
      changed();
    });
    const flex = d.regular.filter((i) => d.cats[i].flexible);
    $("trim").hidden = !flex.length;
    $("trim-note").textContent = (flex.length ? `Flexible spending = ${flex.map((i) => d.cats[i].name.toLowerCase()).join(", ")}. ` : "") + "Your changes are saved with the plan.";
    $("reset").addEventListener("click", () => {
      app.S.st = clone(app.defs.st);
      fillPlanner();
      changed();
    });
    const fill = $("fill");
    fill.addEventListener("mouseenter", () => {
      fill.title = `Set Planned / mo to the averages for ${selectionLabel()}, the period shown in Spending`;
    });
    fill.addEventListener("click", () => {
      [...d.regular, ...d.credits.filter((c) => d.isPlannerCredit(c))].forEach((i) => {
        app.S.st.plan[d.cats[i].name] = Math.round(selectionAvg(i));
      });
      fillPlanner();
      changed();
      $("trim-note").textContent = `Filled from Spending: ${selectionLabel()}.`;
    });
    $("trim").addEventListener("click", () => {
      flex.forEach((i) => app.S.st.plan[d.cats[i].name] = Math.round(d.avg(i) * 0.9));
      fillPlanner();
      changed();
    });
    fillPlanner();
  }
  function renderAnnual() {
    $("an-rows").innerHTML = (app.S.st.annual ?? []).map((a, i) => `<div class="an-row"
    data-i="${i}"><input type="text" data-af="name" value="${esc(a.name)}" placeholder="e.g. Taxes"
    aria-label="Annual expense name"><input class="amt" type="number" step="100" inputmode="decimal"
    data-af="amt" value="${a.amt}" aria-label="${esc(a.name || "Annual expense")} per year"><button
    class="btn sm" type="button" data-arm aria-label="Remove ${esc(a.name || "this expense")}">\xD7</button>
    </div>`).join("") || '<p class="small muted">No annual expenses. Add taxes, insurance\u2026</p>';
  }
  function wireAnnual() {
    const rows = $("an-rows");
    rows.addEventListener("input", (e) => {
      const el = e.target;
      const i = +el.closest("[data-i]").dataset.i;
      const item = app.S.st.annual[i];
      if (el.dataset.af === "name") item.name = el.value;
      else item.amt = num(el);
      changed();
    });
    rows.addEventListener("click", (e) => {
      const b = e.target.closest("[data-arm]");
      if (!b) return;
      const i = +b.closest("[data-i]").dataset.i;
      app.S.st.annual.splice(i, 1);
      renderAnnual();
      changed();
    });
    $("an-add").addEventListener("click", () => {
      app.S.st.annual.push({ name: "", amt: 0 });
      renderAnnual();
      changed();
      rows.querySelector(".an-row:last-child input")?.focus();
    });
  }
  function update() {
    const { d, S } = app;
    const st = S.st;
    const cs = compareSt();
    const setDiff = (el, p, c, goodUp) => {
      const dv = Math.abs(p - c) < 0.5 ? 0 : Math.round(p - c);
      el.textContent = dv ? (dv > 0 ? "+" : "\u2212") + fmt(Math.abs(dv)) : "";
      el.className = dv ? `delta num ${dv > 0 === goodUp ? "pos" : "neg"}` : "delta num";
      return dv;
    };
    const cell = (i, goodUp) => {
      const n = d.cats[i].name;
      const p = st.plan[n] ?? 0;
      const c = cs.plan[n] ?? 0;
      $(`c-${i}`).textContent = fmt(c);
      const dv = setDiff($(`d-${i}`), p, c, goodUp);
      $(`p-${i}`).classList.toggle("changed", !!dv);
    };
    d.regular.forEach((i) => cell(i, false));
    d.credits.filter((c) => d.isPlannerCredit(c)).forEach((c) => {
      cell(c, true);
      $(`row-${c}`).classList.toggle("pane-off", !st.on[d.cats[c].name]);
    });
    const net = (s, i) => (s.plan[d.cats[i].name] ?? 0) - sum(d.offsetsOf(d.cats[i].name).filter((c) => s.on[d.cats[c].name]).map((c) => s.plan[d.cats[c].name] ?? 0));
    d.regular.forEach((i) => {
      const el = document.getElementById(`net-p-${i}`);
      if (!el) return;
      el.textContent = fmt(net(st, i));
      $(`net-c-${i}`).textContent = fmt(net(cs, i));
    });
    const reg = (s) => sum(d.regular.map((i) => s.plan[d.cats[i].name] ?? 0));
    $("t-p").textContent = fmt(reg(st));
    $("t-c").textContent = fmt(reg(cs));
    setDiff($("t-d"), reg(st), reg(cs), false);
    const bp = budget(d, st);
    const bc = budget(d, cs);
    const sumLine = (id, p, c, goodUp) => {
      $(`sp-${id}`).textContent = fmt(p);
      $(`sc-${id}`).textContent = fmt(c);
      setDiff($(`sd-${id}`), p, c, goodUp);
    };
    const fund = d.funds.length > 0;
    sumLine("net", bp.spend - (fund ? 0 : bp.emergency), bc.spend - (fund ? 0 : bc.emergency), false);
    sumLine("an", bp.annual, bc.annual, false);
    sumLine("em", bp.emergency, bc.emergency, false);
    $("em-how").textContent = fund ? "(paid from the fund, not in the total)" : "";
    savLabels().forEach(([k]) => sumLine(k.replace(":", "-"), bp.amt[k] ?? 0, bc.amt[k] ?? 0, true));
    const total = (b) => b.spend + b.annual + b.savings + b.investing;
    sumLine("tot", total(bp), total(bc), false);
    $("an-total").textContent = `${fmt(sum(st.annual.map((a) => a.amt)))}/yr \xB7 ${fmt(bp.annual)}/mo`;
    updateSavings();
  }
  function savRow(key, label2, note = "") {
    const k = esc(key);
    if (label2.toLowerCase().includes(note)) note = "";
    const inp = (f, cls, aria, step = 50) => `<input class="${cls}"
    type="number" step="${step}" inputmode="decimal" data-sav="${k}" data-f="${f}"
    aria-label="${esc(label2)} ${aria}">`;
    return `<div class="savline" data-line="${k}"><div class="row"><span>${esc(label2)}${note ? ` <span class="small muted">\xB7 ${esc(note)}</span>` : ""}</span><span class="ctls"><span
      class="seg sm" role="group" aria-label="${esc(label2)} contribution type"><button
      type="button" data-key="${k}" data-mode="fixed">$/mo</button><button type="button"
      data-key="${k}" data-mode="pct">% left</button><button type="button" data-key="${k}"
      data-mode="rest" title="An even share of whatever is left after everything else">rest</button></span><span
      data-show="fixed">${inp("amt", "amt", "per month")}</span><span data-show="pct">${inp("pct", "amt pct", "percent of left-over", 5)}%</span><span data-show="rest"
      class="num" data-rest="${k}"></span></span></div>
    <div class="pctrow" data-show="pct">min ${inp("min", "amt", "at least per month")} max ${inp("max", "amt", "at most per month")} <span class="num" data-out="${k}"></span></div>
    <span class="small muted" data-note="${k}"></span></div>`;
  }
  function updateSavings() {
    const { d, S } = app;
    const b = budget(d, S.st);
    const sim = simulate(d, S);
    const invName = (id) => d.p.investments.find((v) => v.id === id)?.name ?? id;
    document.querySelectorAll("[data-line]").forEach((el) => {
      const key = el.dataset.line;
      const line = S.st.sav[key];
      el.querySelectorAll("[data-mode]").forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.dataset.mode === line.mode));
      });
      el.querySelectorAll("[data-show]").forEach((x) => {
        x.hidden = x.dataset.show !== line.mode;
      });
      el.querySelector("[data-out]").textContent = `= ${fmt(b.amt[key] ?? 0)}/mo`;
      el.querySelector("[data-rest]").textContent = `${fmt(b.amt[key] ?? 0)}/mo`;
      const note = [];
      const sv = d.p.savings.find((x) => `sav:${x.id}` === key);
      if (sv) {
        note.push(`${fmt(sv.balance)} today${sv.max_balance != null ? ` of ${fmt(sv.max_balance)} max` : ""}`);
        if (sv.max_balance != null) {
          const full = sim.full[key];
          const to = overflowTarget(d, sv);
          note.push(full == null ? "won't reach the max at this rate" : full <= d.todayYear ? "at the max" : `reaches the max in ${full}`);
          if (to) note.push(`then goes to ${invName(to)}`);
        }
      }
      el.querySelector("[data-note]").textContent = note.join(" \xB7 ");
    });
    const fundIn = sum(d.funds.map((f) => b.amt[`sav:${f.id}`] ?? 0));
    $in("em-amt").placeholder = String(Math.round(fundIn));
    const names = d.funds.map((f) => f.name).join(" and ");
    const change = fundIn - b.emergency;
    $("em-note").textContent = d.funds.length ? `Paid from ${names}, not the monthly budget. ${fmt(fundIn)}/mo goes in, so it ${Math.abs(change) < 0.5 ? "holds steady" : change > 0 ? `grows ${fmt(change)}/mo` : `shrinks ${fmt(-change)}/mo`}. Empty = the same as what goes in. Whatever the fund can't cover comes out of that month.` : "No emergency fund in Settings \u203A Savings & income, so this counts as monthly spending.";
  }

  // src/ui/strip.ts
  function buildStrip() {
    const host = $("strips");
    host.addEventListener("change", (e) => {
      const el = e.target;
      const view2 = stripView();
      if (el.dataset.cmp !== void 0) view2.cmp = el.value || null;
      if (el.dataset.add !== void 0 && el.value) view2.rows.push(el.value);
      view2.save();
      refreshStrip();
    });
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      const view2 = stripView();
      view2.rows.splice(+b.dataset.rm, 1);
      view2.save();
      refreshStrip();
    });
    onChange(refreshStrip);
    refreshStrip();
  }
  function refreshStrip() {
    const d = app.d;
    const list = savedBudgets();
    const view2 = stripView();
    view2.rows = view2.rows.filter((id) => id === CURRENT || list.some((b) => b.id === id));
    if (view2.cmp && !list.some((b) => b.id === view2.cmp)) view2.cmp = null;
    const actual = budget(d, app.defs.st);
    const planOf = (id) => {
      if (id === CURRENT) return ["Current edits in Budgeting", app.S.st];
      const b = list.find((x) => x.id === id);
      return [`Budget \u201C${b.name}\u201D`, rebaseBudget(app.defs.st, b.st, b.base)];
    };
    const cmpSel = list.length ? `<label class="eyebrow" for="strip-cmp">Compare with</label><select
    id="strip-cmp" class="cmp-sel" data-cmp><option value="">Choose a budget</option>${list.map((b) => `<option value="${esc(b.id)}"${b.id === view2.cmp ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</select>` : "";
    let h = `<div class="strip-head"><span class="eyebrow">Last ${d.n} months \xB7 actual</span><span
    class="small muted">from your transactions</span></div>` + row(actual, "actual", view2.cmp ? vsTile(actual, planOf(view2.cmp)[1], cmpSel) : list.length ? `<div class="vs">${cmpSel}<span class="small muted">to see if you were over
            or under it</span></div>` : "");
    view2.rows.forEach((id, i) => {
      const [name, st] = planOf(id);
      const b = budget(d, st);
      h += `<div class="strip-head plan"><span class="eyebrow">${esc(name)} \xB7 planned</span><button
      class="btn sm" type="button" data-rm="${i}" aria-label="Hide ${esc(name)}">\xD7</button></div>` + row(b, "plan", vsTile(actual, st, "", true));
    });
    const options = [
      ...view2.rows.includes(CURRENT) ? [] : [[CURRENT, "Current edits"]],
      ...list.filter((b) => !view2.rows.includes(b.id)).map((b) => [b.id, b.name])
    ];
    if (list.length && options.length) {
      h += `<div class="strip-add"><select class="cmp-sel" data-add aria-label="Show a budget"><option
      value="">+ Show a budget</option>${options.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join("")}</select></div>`;
    }
    $("strips").innerHTML = h;
  }
  var CURRENT = "__current";
  function outgo(b) {
    return b.spend + b.annual;
  }
  function row(b, cls, extra) {
    const d = app.d;
    const parts = [];
    if (d.children.length) parts.push("529s");
    d.p.savings.forEach((s) => parts.push(s.name));
    if (b.investing) parts.push("investing");
    const tile = (label2, v, note, more = "") => `<div${more}><span
    class="eyebrow">${label2}</span><span class="v">${v}</span><span class="small muted">${note}</span></div>`;
    return `<div class="strip ${cls}${extra ? " with-vs" : ""}">` + tile(
      "Take-home income",
      fmt(b.income),
      `${esc(d.partners.map((x) => x.name).join(" + ") || "Household")}, net`
    ) + tile("Spending", fmt(b.spend), b.credits ? "after credits" : "regular categories") + tile("Savings", fmt(b.savings + b.investing), esc(parts.join(" + ") || "none set")) + tile("Annual expenses", fmt(b.annual), `${fmt(b.annual * 12)}/yr`) + tile(
      "Left over each month",
      `<span class="${b.left < 0 ? "neg" : "pos"}">${fmt(b.left)}</span>`,
      `${b.left < 0 ? "short " : ""}${fmt(Math.abs(b.left) * 12)} over a year`,
      ' class="result"'
    ) + extra + "</div>";
  }
  function vsTile(actual, st, head, plan = false) {
    const p = outgo(budget(app.d, st));
    const diff = outgo(actual) - p;
    const pct = p ? Math.round(Math.abs(diff) / p * 100) : 0;
    const same2 = Math.abs(diff) < 0.5;
    const word = same2 ? "right on" : diff > 0 ? "over" : "under";
    return `<div class="vs ${same2 ? "" : diff > 0 ? "over" : "under"}">${head || `<span class="eyebrow">${plan ? `Last ${app.d.n} months vs this` : "vs budget"}</span>`}<span
      class="v">${same2 ? "\u2013" : `${fmt(Math.abs(diff))} ${word}`}</span><span class="small">${same2 ? "spending matched it" : `${pct}% ${word} on spending + annual, per month`}</span></div>`;
  }

  // src/ui/budgets.ts
  function savedBudgets() {
    return state.list;
  }
  function stripView() {
    state.view ?? (state.view = { cmp: null, rows: [] });
    return Object.assign(state.view, { save: () => send(
      "PUT",
      "/api/state/budgets",
      { ...state, view: { cmp: state.view.cmp, rows: state.view.rows } }
    ).catch(() => {
    }) });
  }
  async function buildBudgets() {
    const saved2 = await get("/api/state");
    state = {
      list: saved2.budgets?.list ?? [],
      active: saved2.budgets?.active ?? null,
      view: saved2.budgets?.view ?? { cmp: null, rows: [] }
    };
    wireBar();
    onChange(touch);
    renderBar();
    refreshCompare();
  }
  var state = { list: [], active: null };
  var pendingSwitch = null;
  var pendingDel = false;
  var pendingReset = false;
  var stOf = (b) => rebaseBudget(app.defs.st, b.st, b.base);
  var active = () => state.list.find((b) => b.id === state.active) ?? null;
  var newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  function dirtyFrom(b) {
    return diffBudget(app.d, stOf(b), app.S.st).length > 0;
  }
  function persist() {
    send("PUT", "/api/state/budgets", {
      ...state,
      view: state.view && { cmp: state.view.cmp, rows: state.view.rows }
    }).catch(() => {
    });
    refreshCompare();
    refreshStrip();
  }
  function apply(st) {
    app.S.st = clone(st);
    fillPlanner();
    changed();
  }
  function touch() {
    pendingSwitch = null;
    pendingDel = false;
    pendingReset = false;
    renderBar();
  }
  function renderBar() {
    const a = active();
    const dirty2 = a ? dirtyFrom(a) : null;
    const tabs = $("bg-tabs");
    tabs.innerHTML = state.list.length ? state.list.map((b) => `<button type="button" class="chip"
      data-id="${esc(b.id)}" aria-pressed="${b.id === state.active}">${esc(b.name)}${b.id === state.active && dirty2 ? " \u2022" : ""}</button>`).join("") : '<span class="small muted">No saved budgets yet. Name this one and save it.</span>';
    $("bg-state").textContent = pendingSwitch ? "Unsaved changes will be lost. Click the budget again to switch." : a ? dirty2 ? `Unsaved changes to "${a.name}"` : `Showing "${a.name}"` : "Not saved as a budget yet";
    const up = $("bg-update");
    up.hidden = !a;
    up.textContent = a ? `Update "${a.name}"` : "Update";
    up.disabled = !!a && !dirty2;
    const del = $("bg-del");
    del.hidden = !a;
    del.textContent = pendingDel ? "Click again to delete" : "Delete";
    $("bg-reset").textContent = pendingReset ? "Click again to start over" : "Start from averages";
    tabs.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id === state.active) return;
        const cur = active();
        const dirtyNow = cur ? dirtyFrom(cur) : !state.list.some((b) => !dirtyFrom(b)) && diffBudget(app.d, app.defs.st, app.S.st).length > 0;
        if (dirtyNow && pendingSwitch !== id) {
          pendingSwitch = id;
          renderBar();
          return;
        }
        pendingSwitch = null;
        state.active = id;
        persist();
        apply(stOf(state.list.find((b) => b.id === id)));
      });
    });
  }
  function wireBar() {
    const bar = $("budgets");
    bar.addEventListener("input", (e) => e.stopPropagation());
    $("bg-save").addEventListener("click", () => {
      const inp = $in("bg-name");
      const name = inp.value.trim() || `Budget ${state.list.length + 1}`;
      const b = {
        id: newId(),
        name,
        saved: (/* @__PURE__ */ new Date()).toISOString(),
        st: clone(app.S.st),
        base: clone(app.defs.st)
      };
      state.list.push(b);
      state.active = b.id;
      inp.value = "";
      persist();
      renderBar();
    });
    $in("bg-name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("bg-save").click();
    });
    $("bg-update").addEventListener("click", () => {
      const a = active();
      if (!a) return;
      Object.assign(a, {
        st: clone(app.S.st),
        base: clone(app.defs.st),
        saved: (/* @__PURE__ */ new Date()).toISOString()
      });
      persist();
      renderBar();
    });
    $("bg-del").addEventListener("click", () => {
      if (!pendingDel) {
        pendingDel = true;
        renderBar();
        return;
      }
      pendingDel = false;
      state.list = state.list.filter((b) => b.id !== state.active);
      state.active = null;
      persist();
      renderBar();
    });
    $("bg-reset").addEventListener("click", () => {
      if (!pendingReset) {
        pendingReset = true;
        renderBar();
        return;
      }
      pendingReset = false;
      state.active = null;
      persist();
      apply(app.defs.st);
    });
  }

  // src/ui/presets.ts
  var SAVE_DELAY_MS2 = 400;
  async function loadPresets() {
    const saved2 = await get("/api/state");
    const a = app.d.p.assumptions;
    const fromConfig = (x) => Object.values(x).map((p) => ({ name: p.name, ret: p.return_pct, inf: p.inflation_pct }));
    lists = {
      college: saved2.presets?.college ?? fromConfig(a.college.presets),
      retire: saved2.presets?.retire ?? fromConfig(a.retirement.presets)
    };
  }
  function presetPicker(host, kind, current2, apply3) {
    const ed = { host, kind, current: current2, apply: apply3, editing: false };
    editors.push(ed);
    host.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const list = lists[kind];
      const i = +t.closest("[data-i]")?.dataset.i;
      if (t.dataset.pi !== void 0) {
        const p = list[+t.dataset.pi];
        apply3(p.ret, p.inf);
      } else if (t.dataset.pe !== void 0) {
        ed.editing = true;
        render(ed);
      } else if (t.dataset.pd !== void 0) {
        ed.editing = false;
        renderAll(kind);
      } else if (t.dataset.px !== void 0) {
        list.splice(i, 1);
        save();
        renderAll(kind);
      } else if (t.dataset.pa !== void 0) {
        const [ret, inf] = current2();
        list.push({ name: `Preset ${list.length + 1}`, ret, inf });
        save();
        renderAll(kind);
        const rows = host.querySelectorAll(".pr-row");
        rows[rows.length - 1]?.querySelector("input")?.select();
      }
    });
    host.addEventListener("input", (e) => {
      const el = e.target;
      const row2 = el.closest("[data-i]");
      if (!row2 || !el.dataset.pf) return;
      const p = lists[kind][+row2.dataset.i];
      if (el.dataset.pf === "name") p.name = el.value;
      else p[el.dataset.pf] = parseFloat(el.value) || 0;
      save();
      editors.filter((x) => x.kind === kind && x !== ed).forEach(render);
    });
    render(ed);
    return () => {
      if (!ed.editing) render(ed);
    };
  }
  var lists = { college: [], retire: [] };
  var editors = [];
  var timer2 = 0;
  function save() {
    if (timer2) window.clearTimeout(timer2);
    timer2 = window.setTimeout(() => {
      timer2 = 0;
      send("PUT", "/api/state/presets", lists).catch(() => {
      });
    }, SAVE_DELAY_MS2);
  }
  function renderAll(kind) {
    editors.filter((x) => x.kind === kind).forEach(render);
  }
  function render(ed) {
    const list = lists[ed.kind];
    if (ed.editing) {
      ed.host.innerHTML = `<div class="pr-edit">${list.map((p, i) => `<div class="pr-row"
      data-i="${i}"><input type="text" data-pf="name" value="${esc(p.name)}"
      aria-label="Preset name"><label>return <input class="amt" type="number" step="0.5"
      data-pf="ret" value="${p.ret}" aria-label="${esc(p.name)} return">%</label><label>inflation
      <input class="amt" type="number" step="0.25" data-pf="inf" value="${p.inf}"
      aria-label="${esc(p.name)} inflation">%</label><button class="btn sm" type="button" data-px
      aria-label="Remove ${esc(p.name)}">\xD7</button></div>`).join("") || '<p class="small muted">No presets.</p>'}<div class="btns"><button class="btn sm add"
      type="button" data-pa>+ Add preset</button><button class="btn sm primary" type="button"
      data-pd>Done</button></div></div>`;
      return;
    }
    const [ret, inf] = ed.current();
    ed.host.innerHTML = `<div class="chips">${list.map((p, i) => `<button type="button" class="chip"
    data-pi="${i}" aria-pressed="${p.ret === ret && p.inf === inf}">${esc(p.name)} <span
    class="num">${p.ret}% / ${p.inf}%</span></button>`).join("")}<button class="btn sm" type="button"
    data-pe>${list.length ? "Edit presets" : "Add presets"}</button></div>`;
  }

  // src/ui/college.ts
  function buildCollege() {
    const d = app.d;
    const col = d.p.assumptions.college;
    $("college").hidden = !d.children.length;
    $("nav-college").hidden = !d.children.length;
    $("kids").innerHTML = d.children.map((c, k) => {
      const tl = d.timelines[k];
      const id = esc(c.id);
      return `<div class="panel kid" id="kid-${id}">
      <div><h3>${esc(c.name)}</h3><p class="small muted">age ${c.age} \xB7 graduates high school ${esc(tl.graduation)} \xB7 529 today ${fmt(c.college_529.balance)}${c.note ? ` \xB7 ${esc(c.note)}` : ""}</p></div>
      <div class="row"><span>Monthly contribution</span><span><span class="num" id="kc-${id}"></span>
        <a class="small" href="#budget">set in Budgeting \u203A Savings</a></span></div>
      <div style="display:grid;gap:6px"><span class="eyebrow">School</span><div class="seg"
        data-f="school">${Object.entries(col.schools).map(([key, s]) => `<button type="button" data-v="${esc(key)}">${esc(s.name)}</button>`).join("")}</div></div>
      <div class="ctl"><label for="ky-${id}">Cost per year today</label><input class="amt"
        id="ky-${id}" type="number" step="1000" inputmode="decimal"></div>
      <fieldset class="scen"><legend class="eyebrow">Return &amp; college cost inflation</legend>
        <div class="presets" id="kp-${id}"></div>
        <div class="ctl"><label for="kr-${id}">Investment return</label><span class="num"
          id="krv-${id}"></span><input type="range" id="kr-${id}" min="0" max="10" step="0.5"></div>
        <div class="ctl"><label for="ki-${id}">College cost inflation</label><span class="num"
          id="kiv-${id}"></span><input type="range" id="ki-${id}" min="0" max="8" step="0.5"></div>
        <span class="small muted">Pick a preset to set both sliders, then fine-tune.</span>
      </fieldset>
      <div class="out" id="ko-${id}"></div>
    </div>`;
    }).join("");
    d.children.forEach((c) => {
      const cs = () => app.S.cs[c.id];
      const card = $(`kid-${c.id}`);
      $in(`ky-${c.id}`).addEventListener("input", (e) => {
        cs().cost = num(e.target);
        changed();
      });
      $in(`kr-${c.id}`).addEventListener("input", (e) => {
        cs().ret = +e.target.value;
        changed();
      });
      $in(`ki-${c.id}`).addEventListener("input", (e) => {
        cs().inf = +e.target.value;
        changed();
      });
      card.querySelectorAll(".seg button").forEach((b) => {
        b.addEventListener("click", () => {
          cs().school = b.dataset.v;
          cs().cost = col.schools[b.dataset.v].cost;
          changed();
        });
      });
      marks.push(presetPicker($(`kp-${c.id}`), "college", () => [cs().ret, cs().inf], (ret, inf) => {
        cs().ret = ret;
        cs().inf = inf;
        changed();
      }));
    });
    onChange(updateCollege);
    updateCollege();
  }
  var marks = [];
  function updateCollege() {
    const d = app.d;
    const col = d.p.assumptions.college;
    marks.forEach((mark) => mark());
    d.children.forEach((c, k) => {
      const s = app.S.cs[c.id];
      const m = budget(d, app.S.st).amt[`529:${c.id}`] ?? 0;
      const card = $(`kid-${c.id}`);
      $(`kc-${c.id}`).textContent = `${fmt(m)}/mo`;
      const ky = $in(`ky-${c.id}`);
      if (document.activeElement !== ky) ky.value = String(s.cost);
      $in(`kr-${c.id}`).value = String(s.ret);
      $(`krv-${c.id}`).textContent = `${s.ret}%`;
      $in(`ki-${c.id}`).value = String(s.inf);
      $(`kiv-${c.id}`).textContent = `${s.inf}%`;
      card.querySelectorAll(".seg button").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.v === s.school));
      });
      const x = kidCalc(d, app.S, k);
      const cov = Math.round(x.pct * 100);
      $(`ko-${c.id}`).innerHTML = `
      <span class="eyebrow" style="grid-column:1/-1">Covered</span>
      <span class="big ${x.pct >= 1 ? "pos" : ""}" style="grid-column:1/-1">${cov}%</span>
      <div class="meter ${x.pct >= 1 ? "full" : ""}" style="grid-column:1/-1" role="img"
        aria-label="${cov} percent covered"><i style="width:${Math.min(100, x.pct * 100)}%"></i></div>
      <span>529 at graduation</span><span class="num">${fmt(x.bal)}</span>
      <span>${col.years}-year cost, ${esc(d.timelines[k].college_years)}</span><span class="num">${fmt(x.cost)}</span>
      <span><b>${x.gap >= 0 ? "Surplus" : "Shortfall"}</b></span><span class="num ${x.gap >= 0 ? "pos" : "neg"}"><b>${x.gap >= 0 ? "+" : ""}${fmt(x.gap)}</b></span>
      <span class="muted">\u2026in today's dollars</span><span class="num muted">${x.gap >= 0 ? "+" : ""}${fmt(x.today)}</span>
      <span>Monthly needed to fully fund</span><span class="num">${fmt(x.need)}</span>
      <span class="small muted" style="grid-column:1/-1">${x.need > m ? `That's ${fmt(x.need - m)} more than ${fmt(m)}/mo.` : `${fmt(m)}/mo is enough for this scenario.`}</span>`;
    });
  }

  // src/ui/future.ts
  function buildFuture() {
    const d = app.d;
    $("f-cats").innerHTML = [...d.regular].sort((a, b) => d.avg(b) - d.avg(a)).map((c) => {
      const n = esc(d.cats[c].name);
      return `<tr><td>${n}</td><td class="num" id="fc-t-${c}"></td>
      <td><span style="display:inline-flex;align-items:center;gap:3px"><input class="amt"
        style="width:64px" type="number" step="5" inputmode="decimal" data-c="${c}" data-f="kg"
        aria-label="${n} change when children are gone, percent">%</span></td>
      <td><span style="display:inline-flex;align-items:center;gap:3px"><input class="amt"
        style="width:64px" type="number" step="5" inputmode="decimal" data-c="${c}" data-f="rt"
        aria-label="${n} change in retirement, percent">%</span></td>
      <td class="num" id="fc-r-${c}"></td></tr>`;
    }).join("") + `<tr class="total"><td>Living costs</td><td class="num" id="fc-t-tot"></td><td></td>
    <td></td><td class="num" id="fc-r-tot"></td></tr>`;
    document.querySelectorAll("#f-cats input").forEach((inp) => {
      inp.addEventListener("input", () => {
        app.S.fs[inp.dataset.f][d.cats[+inp.dataset.c].name] = num(inp);
        changed();
      });
    });
    $in("f-health").addEventListener("input", () => {
      app.S.fs.health = num($in("f-health"));
      changed();
    });
    $in("f-tax").addEventListener("input", () => {
      app.S.fs.tax = num($in("f-tax"));
      changed();
    });
    document.querySelectorAll("#f-view button").forEach((b) => {
      b.addEventListener("click", () => {
        app.S.fs.nominal = b.dataset.v === "nom";
        changed();
      });
    });
    $("f-reset").addEventListener("click", () => {
      const nominal = app.S.fs.nominal;
      app.S.fs = clone(app.defs.fs);
      app.S.fs.nominal = nominal;
      fillFuture();
      changed();
    });
    const grads = d.children.map((c, k) => `${c.name} finishes high school in ${d.timelines[k].graduation}`);
    $("f-built").textContent = `${grads.length ? `${grads.join("; ")}. Each 529 contribution stops at that graduation. ` : ""}Savings marked to stop at retirement, investment contributions, and credits and costs not marked "in retirement" stop at retirement. Contributions set as "% left" follow each year's left-over. Income before retirement is today's take-home, kept up with inflation plus any yearly raise set in Retirement assumptions.`;
    onChange(drawFuture);
    fillFuture();
    drawFuture();
  }
  function fillFuture() {
    const { d, S } = app;
    document.querySelectorAll("#f-cats input").forEach((inp) => {
      inp.value = String(S.fs[inp.dataset.f][d.cats[+inp.dataset.c].name] ?? 0);
    });
    $in("f-health").value = String(S.fs.health);
    $in("f-tax").value = String(S.fs.tax);
  }
  function drawFuture() {
    const { d, S } = app;
    document.querySelectorAll("#f-view button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.v === "nom" === S.fs.nominal));
    });
    const RY = retireYear(d, S.rs);
    const R = retirementIncome(d, S, S.rs.age);
    const rS = spendAt(d, S, RY);
    const now = spendAt(d, S, d.todayYear);
    const early = d.partners.filter((p) => R.years[p.id] < RY).map((p) => [R.years[p.id], `${p.name} retired`]);
    const retired = early.length ? "All retired" : "Retired";
    d.regular.forEach((c) => {
      $(`fc-t-${c}`).textContent = fmt(S.st.plan[d.cats[c].name] ?? 0);
      $(`fc-r-${c}`).textContent = fmt(rS.cats[d.cats[c].name]);
    });
    $("fc-t-tot").textContent = fmt(now.living);
    $("fc-r-tot").textContent = fmt(rS.living);
    const years = [];
    for (let y2 = d.todayYear; y2 < d.todayYear + PROJECTION_YEARS; y2++) years.push(y2);
    const rows = years.map((y2) => {
      const s = spendAt(d, S, y2);
      const k = deflator(d, S, y2);
      return { y: y2, out: s.spend * k, sav: s.savings * k, inc: incomeAt(d, S, y2) * k, s };
    });
    const svg = $("fchart");
    const W = 960;
    const H = 320;
    const L = 56;
    const Rr = 12;
    const events = d.children.map((c, k) => [Math.floor(d.gradT(k)), `${c.name} out`]).concat(early, [[RY, retired]]).filter(([yr]) => yr >= years[0] && yr <= years[years.length - 1]);
    const T = 16 + events.length * 12;
    const B = 30;
    const pw = W - L - Rr;
    const ph = H - T - B;
    const bw = pw / years.length;
    const max = Math.max(...rows.map((r) => Math.max(r.out + r.sav, r.inc)), 1);
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + ph - v / top * ph;
    let g = "";
    for (let v = 0; v <= top + 1e-6; v += step) {
      g += `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fk(v)}</text>`;
    }
    events.forEach(([yr, lbl], j) => {
      const x = L + (yr - years[0]) * bw;
      g += `<line x1="${x}" x2="${x}" y1="${T - 6}" y2="${T + ph}" style="stroke:var(--ink3);stroke-width:1;stroke-dasharray:3 3"/><text x="${x + 4}" y="${10 + j * 12}" style="fill:var(--ink)">${esc(lbl)} ${yr}</text>`;
    });
    let path = "";
    rows.forEach((r, i) => {
      const bx = L + i * bw + bw * 0.14;
      const w = bw * 0.72;
      const h1 = ph * r.out / top;
      const h2 = ph * r.sav / top;
      const left = r.inc - r.out - r.sav;
      const k = deflator(d, S, r.y);
      const ages = d.partners.map((p) => `${p.name} ${Math.floor(p.age + r.y - d.todayYear)}`).join(", ");
      const tip = `<b>${r.y}</b> \xB7 ${esc(ages)}<br>${r.s.kids} of ${d.children.length} children at home${r.s.ret ? " \xB7 retired" : ""}<br>Living ${fmt(r.s.living * k)}` + (r.s.annual ? `<br>Annual expenses ${fmt(r.s.annual * k)}` : "") + (r.s.health ? `<br>Health insurance ${fmt(r.s.health * k)}` : "") + (r.s.emergency ? `<br>Emergency costs ${fmt(r.s.emergency * k)} (from the fund)` : "") + (r.s.short ? `<br>Emergency costs the fund can't cover ${fmt(r.s.short * k)}` : "") + (r.sav ? `<br>Savings ${fmt(r.sav)}` : "") + `<br>Income ${fmt(r.inc)}<br><b>${left >= 0 ? "Left over" : "Short"} ${fmt(Math.abs(left))}/mo</b>`;
      g += `<g class="m" data-tip="${tip.replace(/"/g, "&quot;")}"><rect x="${bx}" y="${T + ph - h1}" width="${w}" height="${Math.max(h1, 0)}" rx="2" class="sel"/>` + (h2 > 0.5 ? `<rect x="${bx}" y="${T + ph - h1 - h2}" width="${w}" height="${Math.max(h2 - 2, 0.5)}" rx="2" style="fill:var(--save)"/>` : "") + `<rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ph}"/>` + (r.y % 5 === 0 || i === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle">${r.y}</text>` : "") + "</g>";
      const x0 = L + i * bw;
      path += `${i ? "L" : "M"}${x0},${y(r.inc)}L${x0 + bw},${y(r.inc)}`;
    });
    g += `<path d="${path}" style="fill:none;stroke:var(--ink);stroke-width:2.5;pointer-events:none"/>`;
    svg.innerHTML = g;
    svg.querySelectorAll("g.m").forEach((el) => {
      el.addEventListener("mousemove", (e) => showTip(e, el.dataset.tip));
      el.addEventListener("mouseleave", hideTip);
    });
    $("f-cap").textContent = S.fs.nominal ? `Future dollars at ${S.rs.inf}% inflation. A ${fmt(now.spend)}/mo budget today is ${fmt(now.spend * deflator(d, S, RY))}/mo in ${RY} money with the same buying power.` : `In today's dollars, so years compare directly. Switch to "With inflation" to see actual amounts each year (${S.rs.inf}% a year, set in Retirement assumptions).`;
    const stages = [[d.todayYear, "Today"]];
    d.children.forEach((c, k) => {
      const yr = Math.floor(d.gradT(k)) + 1;
      if (yr < RY) stages.push([yr, `${c.name} out`]);
    });
    stages.push(...early, [RY, retired]);
    const ssDone = R.fullYear;
    if (ssDone > RY) stages.push([ssDone, "All Social Security started"]);
    stages.sort((a, b) => a[0] - b[0]);
    const dl = S.fs.nominal ? " (with inflation)" : " (today's $)";
    $("f-phases").innerHTML = `<tr><th>Stage</th><th>Year</th><th>Ages</th><th>Living costs</th><th>Annual expenses</th><th>Health ins.</th><th>Savings</th><th>Total out</th><th>Income${dl}</th><th>Left over</th></tr>` + stages.map(([yr, lbl]) => {
      const s = spendAt(d, S, yr);
      const k = deflator(d, S, yr);
      const inc = incomeAt(d, S, yr) * k;
      const out = (s.spend + s.savings) * k;
      const df = inc - out;
      return `<tr><td>${esc(lbl)}</td><td>${yr}</td><td>${d.partners.map((p) => Math.floor(p.age + yr - d.todayYear)).join(" / ")}</td><td>${fmt(s.living * k)}</td><td>${fmt(s.annual * k)}</td><td>${fmt(s.health * k)}</td><td>${fmt(s.savings * k)}</td><td>${fmt(out)}</td><td>${fmt(inc)}</td><td class="${df >= 0 ? "pos" : "neg"}">${df >= 0 ? "+" : ""}${fmt(df)}</td></tr>`;
    }).join("");
    drawBalances(stages);
  }
  function drawBalances(stages) {
    const { d, S } = app;
    const sim = simulate(d, S);
    const names = [
      ...d.children.map((c) => [`529:${c.id}`, `529, ${c.name}`]),
      ...d.p.savings.map((s) => [`sav:${s.id}`, s.name]),
      ...d.p.investments.map((v) => [`inv:${v.id}`, v.name])
    ];
    $("f-bal-panel").hidden = !names.length;
    if (!names.length) return;
    const real = (y) => S.fs.nominal ? 1 : Math.pow(1 + S.rs.inf / 100, y - d.todayYear);
    const balAt = (key, y) => (sim.years.get(y - 1)?.bal[key] ?? 0) / real(y);
    const start2 = {};
    d.children.forEach((c) => start2[`529:${c.id}`] = c.college_529.balance);
    d.p.savings.forEach((s) => start2[`sav:${s.id}`] = s.balance);
    d.p.investments.forEach((v) => start2[`inv:${v.id}`] = S.rs.inv[v.id]?.bal ?? v.balance);
    const capped = d.p.savings.filter((s) => s.max_balance != null);
    $("f-bal").innerHTML = `<tr><th>Account</th>${stages.map(([yr, lbl]) => `<th>${esc(lbl)} ${yr}</th>`).join("")}${capped.length ? "<th>Reaches max</th>" : ""}</tr>` + names.map(([key, name]) => {
      const sv = capped.find((s) => `sav:${s.id}` === key);
      const full = sv ? sim.full[key] : void 0;
      const kid = d.children.findIndex((c) => `529:${c.id}` === key);
      const spent = (yr) => kid >= 0 && yr > Math.floor(d.gradT(kid)) + 1;
      return `<tr><td>${esc(name)}</td>${stages.map(([yr]) => `<td>${spent(yr) ? "\u2013" : fmt(yr <= d.todayYear ? start2[key] : balAt(key, yr))}</td>`).join("")}${capped.length ? `<td>${sv ? full == null ? "not at this rate" : `${full} (${fmt(sv.max_balance)})` : ""}</td>` : ""}</tr>`;
    }).join("");
    $("f-bal-note").textContent = `Balance at the start of each stage${S.fs.nominal ? "" : ", in today's dollars"}. 529s show until college starts; savings past their max go to their overflow investment; emergency costs come out of emergency funds first.`;
  }

  // src/ui/help.ts
  var TOPICS = [
    ["h-start", "Quick start"],
    ["h-setup", "Setting up"],
    ["h-explore", "Spending"],
    ["h-planner", "Budgeting"],
    ["h-scen", "Sharing"],
    ["h-cat", "Categorizing"],
    ["h-college", "College 529s"],
    ["h-retire", "Retirement"],
    ["h-future", "Spending over time"],
    ["h-privacy", "Privacy"],
    ["h-faq", "Questions"]
  ];
  var BODY = `
<h3 id="h-start">Quick start</h3>
<ol>
  <li><b>Look at your spending.</b> <i>Spending</i> shows what your transactions say: each
    category's monthly average, lowest and highest month, and every transaction behind it.</li>
  <li><b>Make a budget.</b> In <i>Budgeting</i> every category starts at its average. Type a new
    number and the strip at the top updates. Changed boxes turn blue.</li>
  <li><b>Save it.</b> Name it in the Budgets bar and click <i>Save as new</i>. Pick any saved
    budget (or the average) in the Compare column to see the difference line by line.</li>
  <li><b>Look at the long view.</b> <i>Retirement</i> shows income at each retirement age.
    <i>Spending over time</i> shows how costs change as children leave home.</li>
</ol>
<p class="note">Your changes are saved in the plan folder on this computer. Nothing is sent
  anywhere.</p>

<h3 id="h-setup">Setting up</h3>
<p>Everything about your household lives in the plan's <span class="mono">config</span> folder as
  YAML files. You can edit them by hand or use <b>Settings</b> (the gear, top right):</p>
<table class="help-table">
  <tr><td>Household</td><td>Partners (age, take-home pay, raises, Social Security, pensions,
    retirement accounts) and children (age, 529).</td></tr>
  <tr><td>Savings &amp; income</td><td>Other income, savings accounts and emergency funds (with an
    optional max balance), and stock and bond accounts.</td></tr>
  <tr><td>Assumptions</td><td>Titles, how many months to average, retirement and college
    assumptions and presets.</td></tr>
  <tr><td>Data sources</td><td>One per kind of CSV export. Pick the file, click <i>Read columns</i>,
    check the date, description and amount columns, then <i>Preview</i>.</td></tr>
  <tr><td>Categories</td><td>Names, kinds (regular, annual expense, 1-time purchase, emergency fund
    cost, credit, ignore), planner groups and
    how each changes when the kids leave or you retire.</td></tr>
  <tr><td>Categorize</td><td>Every transaction, sortable and filterable, plus the rule list.</td></tr>
</table>
<p>Export CSVs from your bank and card websites into the plan's <span class="mono">data</span>
  folder (or upload them under Data sources). New exports with the same layout are picked up
  automatically if the source's file pattern matches them.</p>

<h3 id="h-scen">Sharing</h3>
<p>To give someone <b>everything</b> (settings, data, budgets), use Settings \u203A <i>Share plan</i>
  \u203A <i>Save plan as a file</i>. They open it from the Mac app's menu-bar icon \u203A <i>Open Plan
  File\u2026</i>. That file contains your real transactions: share it privately.</p>

<h3 id="h-explore">Spending</h3>
<ul>
  <li>The chart shows each month. Click a month to filter the transactions.</li>
  <li><b>Spending / Credits / Both</b> chooses the rows in the table. Each row shows the monthly
    average, the lowest and the highest month. Click a category to see it in the chart.</li>
  <li><b>Credits</b> sit under the category they offset (in <i>Both</i>), or in their own list.
    Annual, 1-time and emergency costs, and savings transfers, have a tick box: ticked rows count
    in the total.</li>
  <li><b>Recategorize</b> (above the transactions) turns on editing: click a transaction to change
    its category or make a rule from it. It's off by default so nothing changes by accident.</li>
</ul>

<h3 id="h-planner">Budgeting</h3>
<table class="help-table">
  <tr><td>Budgets bar</td><td>Save the current budget under a name, click one to load it (a
    <b>\u2022</b> means unsaved changes), update or delete it, or start from the averages again. A
    budget holds only Budgeting: categories, income, savings, annual expenses and emergency costs.
    529 cards and Retirement are not part of it.</td></tr>
  <tr><td>Planned / mo</td><td>Your budget. Starts at each category's average.</td></tr>
  <tr><td>Compare</td><td>Pick the average or any saved budget; <i>Difference</i> is planned
    minus compare (green is better).</td></tr>
  <tr><td>Below the table</td><td>Net spending, annual expenses, emergency fund costs, each savings
    line and the monthly total of spending plus savings.</td></tr>
</table>
<ul>
  <li><b>Savings</b>: each 529, savings account, emergency fund and investment adds a fixed
    <b>$/mo</b>, <b>% left</b> (a share of what is left after spending, annual expenses and the
    fixed amounts, kept between an optional min and max) or <b>rest</b> (whatever is still left,
    split evenly between every "rest" line). A savings account with a max balance sends the rest
    to an investment once it's full; the note under it says when.</li>
  <li><b>Annual expenses</b>: add as many as you like (+ Add, a name and a yearly amount; \xD7 to
    remove). Their total \xF7 12 counts each month.</li>
  <li><b>Emergency fund costs</b>: what you expect to take out of the emergency fund each month.
    Empty means the same as what goes in, so the fund holds steady; more makes it shrink, less
    makes it grow. With no emergency fund it counts as spending.</li>
  <li><i>Try 10% less on flexible spending</i> trims the categories marked flexible.</li>
</ul>

<h3 id="h-cat">Categorizing</h3>
<p>Each transaction gets one category. In order:</p>
<ol>
  <li><b>Just this transaction</b> rules always win.</li>
  <li>Otherwise the <b>first matching rule</b> from the top of the list.</li>
  <li>Otherwise the bank's own category, if the source maps it.</li>
  <li>Otherwise <i>Other</i> (money out) or <i>Other credits</i> (money in).</li>
</ol>
<p>A rule can match when a field <b>contains</b> text, <b>matches</b> a pattern, when <b>any
  field</b> contains text, or when a field is <b>similar</b> to a transaction's (store numbers and
  codes are ignored). Filters can limit a rule to one source, money in or out, or an amount range.
  The rule dialog shows how many transactions a rule matches before you save it.</p>

<h3 id="h-college">College 529s</h3>
<p>One card per child: school type and yearly cost, then a return / cost-growth preset you can
  fine-tune. Each card shows how much of college is covered, the surplus or shortfall (also in
  today's dollars) and the monthly amount that would fully fund it.</p>

<h3 id="h-retire">Retirement</h3>
<ul>
  <li><b>The sliders</b>: the big one is the first partner's retirement age (the chart and table
    follow it). Each other partner retires the same year unless you untick <i>same year as</i> and
    set their own age.</li>
  <li><b>Income</b>: pensions, retirement accounts, investments and Social Security, before and
    after the retirement tax rate. Social Security that starts later is drawn as a dashed outline.</li>
  <li><b>Comparison</b> is against <i>projected</i> retirement spending (children gone,
    retirement changes, health insurance), not today's spending.</li>
  <li>All figures are in today's dollars.</li>
</ul>

<h3 id="h-future">Spending over time</h3>
<p>Money in and out for each year, with markers when each child finishes high school and when you
  retire. Each category has an editable % for "kids gone" and "retired".</p>

<h3 id="h-privacy">Privacy</h3>
<ul>
  <li>The app runs only on this computer (it listens on 127.0.0.1) and never uploads anything.</li>
  <li>Your plan folder holds real financial data. Don't put it in a public repository, a shared
    drive or anywhere on the internet.</li>
  <li>Use generic names (Partner A, Child 1) and leave out account numbers, birthdates and
    employers' names.</li>
  <li>Bank exports can include account numbers in descriptions. Search for them in Categorize and
    remove them from the CSV if needed.</li>
</ul>

<h3 id="h-faq">Questions</h3>
<dl class="faq">
  <dt>Why is a box blue?</dt><dd>You changed it from its starting value.</dd>
  <dt>Can I switch between light and dark?</dt><dd>Yes: <i>Auto / Light / Dark</i> next to
    Settings. Auto follows your computer's setting. The choice is remembered in this browser.</dd>
  <dt>Where are my changes kept?</dt><dd>In <span class="mono">.financial_planner/state.json</span>
    inside the plan folder. Settings are in the YAML files.</dd>
  <dt>I changed the YAML by hand. Do I need to restart?</dt><dd>No, just reload the page.</dd>
  <dt>Why are some months huge?</dt><dd>Annual, 1-time and emergency costs are shown in gray and
    kept out of the regular averages.</dd>
</dl>`;
  function buildHelp() {
    const root = document.getElementById("help");
    root.innerHTML = `<div class="sec-head"><h2 id="help-title">Help</h2><a class="btn"
      href="#budget" style="text-decoration:none">Back to the budget</a></div>
    <nav class="help-toc panel" aria-label="Help topics"><span class="eyebrow">Topics</span>
      <div class="chips">${TOPICS.map(([id, l]) => `<button class="chip" type="button"
        data-go="${id}">${l}</button>`).join("")}</div></nav>
    <article class="panel help-body">${BODY}</article>`;
    root.querySelectorAll("[data-go]").forEach((b) => {
      b.addEventListener("click", () => document.getElementById(b.dataset.go)?.scrollIntoView());
    });
  }

  // src/ui/retire.ts
  var TABLE_AGES = [55, 58, 60, 62, 65, 67, 70];
  function buildRetire() {
    const d = app.d;
    const p = d.primary;
    lo = Math.max(55, Math.ceil(p.age));
    hi = Math.max(lo + 5, 70);
    const ra = $in("ra");
    ra.min = String(lo);
    ra.max = String(Math.max(hi, 75));
    $("ra-who").textContent = `${p.name} retires at`;
    $("retire-sub").textContent = `Monthly income at each retirement age, in today's dollars. ${d.partners.map((x) => `${x.name} is ${x.age}`).join(", ")}.${d.partners.length > 1 ? ` The chart and table follow ${p.name}'s age.` : ""}`;
    buildOthers();
    buildPanels();
    buildAssumptions();
    ra.addEventListener("input", () => {
      app.S.rs.age = +ra.value;
      changed();
    });
    $("r-reset").addEventListener("click", () => {
      app.S.rs = clone(app.defs.rs);
      fillRetire();
      changed();
    });
    onChange(drawRetire);
    fillRetire();
    drawRetire();
  }
  function fillRetire() {
    const rs = app.S.rs;
    $in("ra").value = String(rs.age);
    $in("r-ret").value = String(rs.ret);
    $in("r-inf").value = String(rs.inf);
    $in("r-wd").value = String(rs.wd);
    drawOthers();
    document.querySelectorAll("[data-r]").forEach((el) => {
      const v = getR(el.dataset.r);
      if (el.type === "checkbox") el.checked = !!v;
      else if (el.dataset.r.startsWith("draw|")) el.value = String(v ?? rs.wd);
      else el.value = v == null ? "" : String(v);
    });
    document.querySelectorAll("select[data-claim]").forEach((el) => {
      const v = rs.claim[el.dataset.claim];
      el.value = v == null ? "" : String(v);
    });
  }
  var lo = 55;
  var hi = 70;
  var markPreset = () => {
  };
  function buildOthers() {
    const d = app.d;
    const box = $("ra-others");
    const others = d.partners.slice(1);
    box.hidden = !others.length;
    box.innerHTML = others.map((p) => {
      const min = Math.max(50, Math.ceil(p.age));
      return `<div class="ctl"><div class="agehead"><span class="eyebrow">${esc(p.name)} retires at</span><span
      class="big num" id="rao-v-${esc(p.id)}"></span><span class="muted" id="rao-when-${esc(p.id)}"></span></div><label class="small"><input type="checkbox" data-same="${esc(p.id)}">
      same year as ${esc(d.primary.name)}</label><input type="range" data-rao="${esc(p.id)}" min="${min}" max="${Math.max(min + 5, 75)}" step="1" aria-label="${esc(p.name)} retirement age"></div>`;
    }).join("");
    box.querySelectorAll("[data-rao]").forEach((el) => {
      el.addEventListener("input", () => {
        app.S.rs.ages[el.dataset.rao] = +el.value;
        changed();
      });
    });
    box.querySelectorAll("[data-same]").forEach((el) => {
      el.addEventListener("change", () => {
        const id = el.dataset.same;
        const p = d.partners.find((x) => x.id === id);
        app.S.rs.ages[id] = el.checked ? null : Math.round(ageWhen(d, p, app.S.rs.age));
        changed();
      });
    });
  }
  function drawOthers() {
    const { d, S } = app;
    const R = retirementIncome(d, S, S.rs.age);
    d.partners.slice(1).forEach((p) => {
      const own = S.rs.ages[p.id];
      const age = R.ages[p.id];
      const yr = R.years[p.id] - 1;
      $(`rao-v-${p.id}`).textContent = String(Math.floor(age));
      $(`rao-when-${p.id}`).textContent = `${yr} \xB7 ${Math.max(0, yr - Math.floor(d.todayYear))} years from now`;
      const same2 = document.querySelector(`[data-same="${CSS.escape(p.id)}"]`);
      same2.checked = own == null;
      document.querySelector(`[data-rao="${CSS.escape(p.id)}"]`).value = String(Math.round(age));
    });
  }
  function partColor(x) {
    if (x.kind === "pension") return "--r1";
    if (x.kind === "investment") return "--r5";
    if (x.kind === "savings") return "--onetime";
    if (x.kind === "ss") return "--r4";
    return x.partner === app.d.primary.id ? "--r2" : "--r3";
  }
  function getR(path) {
    const parts = splitPath(path);
    let cur = app.S.rs;
    for (const k of parts) cur = cur?.[k];
    return cur;
  }
  function setR(path, v) {
    const parts = splitPath(path);
    let cur = app.S.rs;
    parts.slice(0, -1).forEach((k) => cur = cur[k]);
    cur[parts[parts.length - 1]] = v;
  }
  function splitPath(path) {
    return path.split("|");
  }
  function drawCtl(key) {
    return `<div class="ctl"><label>Yearly withdrawal <span class="small muted">for living
    expenses</span></label><span class="num" data-drawv="${esc(key)}"></span><input type="range"
    min="2" max="8" step="0.25" data-r="draw|${esc(key)}" aria-label="Yearly withdrawal"></div>`;
  }
  function numInput(path, label2, step = 50, wide = false) {
    return `<div class="row"><label>${esc(label2)}</label><input class="amt" type="number" step="${step}" inputmode="decimal" data-r="${esc(path)}"${wide ? ' style="width:120px"' : ""}></div>`;
  }
  function buildPanels() {
    const d = app.d;
    let h = "";
    d.partners.forEach((p) => {
      p.pensions.forEach((pn, i) => {
        const key = `${p.id}:${i}`;
        const ests = Object.keys(pn.estimates).sort((a, b) => +a - +b);
        h += `<div class="panel" data-pane="pen|${esc(key)}|on"><label class="toggle"><input
        type="checkbox" data-r="pen|${esc(key)}|on"><h3>${esc(pn.name)} <span class="small muted">${esc(p.name)}</span></h3></label>` + (pn.monthly != null ? numInput(`pen|${key}|monthly`, "Monthly benefit") : `<p class="small muted">Monthly estimates by retirement age. Ages in between are
            interpolated${pn.service_years_now != null ? "; after the last age it grows with years of service" : ""}.</p>
          <div class="est">${ests.map((a) => `<label>Age ${esc(a)}<input class="amt"
            type="number" step="50" inputmode="decimal" data-r="pen|${esc(key)}|est|${esc(a)}">
            </label>`).join("")}</div>`) + "</div>";
      });
      p.accounts.forEach((ac, i) => {
        const key = `${p.id}:${i}`;
        h += `<div class="panel" data-pane="acct|${esc(key)}|on"><label class="toggle"><input
        type="checkbox" data-r="acct|${esc(key)}|on"><h3>${esc(ac.name)} <span class="small muted">${esc(p.name)}</span></h3></label>${numInput(`acct|${key}|bal`, "Balance today", 1e3, true)}${numInput(`acct|${key}|monthly`, "Adding per month")}${drawCtl(`acct:${key}`)}<p
        class="small muted">Grows at the return rate; contributions continue until retirement.</p></div>`;
      });
    });
    d.p.investments.forEach((v) => {
      h += `<div class="panel" id="pn-inv-${esc(v.id)}"><h3>${esc(v.name)}</h3>${numInput(`inv|${v.id}|bal`, "Balance today", 1e3, true)}
      <div class="row"><span>Adding per month</span><span><span class="num" id="r-ic-${esc(v.id)}"></span> <a class="small" href="#budget">set in Budgeting</a></span></div>
      <div class="ctl"><label>Return on this account</label><span class="num" id="r-ir-${esc(v.id)}"></span><input type="range" min="0" max="10" step="0.5" data-r="inv|${esc(v.id)}|ret"></div>${drawCtl(`inv:${v.id}`)}
      <p class="small muted" id="r-inote-${esc(v.id)}"></p></div>`;
    });
    retireSavings(d).forEach((sv) => {
      h += `<div class="panel" id="pn-sav-${esc(sv.id)}"><h3>${esc(sv.name)}</h3>
      <div class="row"><span>Balance today</span><span class="num">${fmt(sv.balance)}</span></div>
      <div class="row"><span>Adding per month</span><span><span class="num" id="r-sc-${esc(sv.id)}"></span> <a class="small" href="#budget">set in Budgeting</a></span></div>
      <div class="row"><span>Interest</span><span class="num">${sv.return_pct}%</span></div>
      ${drawCtl(`sav:${sv.id}`)}
      <p class="small muted">${sv.stops_at_retirement ? "Contributions stop at retirement. " : ""}Its balance at retirement becomes monthly income at its withdrawal rate. Balance and
        interest are set in Settings \u203A Savings &amp; income.</p></div>`;
    });
    if (d.partners.length) {
      h += `<div class="panel" data-pane="ss"><label class="toggle"><input type="checkbox"
      data-r="ss"><h3>Social Security</h3></label><p class="small muted">Monthly benefit at full
      retirement age (67), in today's dollars. Get real estimates from your Social Security
      statement.</p>` + d.partners.map((p) => numInput(`ssAmt|${p.id}`, `${p.name} at 67`) + `<div class="row"><label for="claim-${esc(p.id)}">${esc(p.name)} claims at</label><select
          id="claim-${esc(p.id)}" data-claim="${esc(p.id)}" class="amt" style="width:auto"><option
          value="">when retiring (62+)</option>${[62, 63, 64, 65, 66, 67, 68, 69, 70].map((a) => `<option value="${a}">${a}</option>`).join("")}</select></div>`).join("") + `<p class="small muted">Claiming at 62 pays 70% of the age-67 amount, and waiting until 70
      pays 124%. A benefit starts at the chosen age, or at retirement if that's later.</p></div>`;
    }
    const box = $("r-panels");
    box.innerHTML = h;
    box.querySelectorAll("[data-r]").forEach((el) => {
      el.addEventListener(el.type === "checkbox" ? "change" : "input", () => {
        setR(el.dataset.r, el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : num(el));
        changed();
      });
    });
    box.querySelectorAll("select[data-claim]").forEach((el) => {
      el.addEventListener("change", () => {
        app.S.rs.claim[el.dataset.claim] = el.value === "" ? null : +el.value;
        changed();
      });
    });
  }
  function buildAssumptions() {
    const d = app.d;
    $("r-raises").innerHTML = d.partners.map((p) => `<div class="ctl"><label>${esc(p.name)} yearly
    raise <span class="small muted">above inflation</span></label><span class="num" id="raise-v-${esc(p.id)}"></span><input type="range" min="0" max="5" step="0.25" data-r="raise|${esc(p.id)}"></div>`).join("");
    $("r-raises").querySelectorAll("[data-r]").forEach((el) => {
      el.addEventListener("input", () => {
        setR(el.dataset.r, +el.value);
        changed();
      });
    });
    markPreset = presetPicker(
      $("r-scen"),
      "retire",
      () => [app.S.rs.ret, app.S.rs.inf],
      (ret, inf) => {
        app.S.rs.ret = ret;
        app.S.rs.inf = inf;
        fillRetire();
        changed();
      }
    );
    [["r-ret", "ret"], ["r-inf", "inf"], ["r-wd", "wd"]].forEach(([id, key]) => {
      $in(id).addEventListener("input", () => {
        app.S.rs[key] = +$in(id).value;
        changed();
      });
    });
  }
  function drawRetire() {
    const { d, S } = app;
    const rs = S.rs;
    $in("ra").value = String(rs.age);
    drawOthers();
    document.querySelectorAll("[data-pane]").forEach((el) => {
      el.classList.toggle("pane-off", !getR(el.dataset.pane));
    });
    $("r-ret-v").textContent = `${rs.ret}%`;
    $("r-inf-v").textContent = `${rs.inf}%`;
    $("r-wd-v").textContent = `${rs.wd}%`;
    d.partners.forEach((p) => {
      const el = document.getElementById(`raise-v-${p.id}`);
      if (el) el.textContent = `${rs.raise[p.id] ?? 0}%`;
      const r = document.querySelector(`[data-r="raise|${CSS.escape(p.id)}"]`);
      if (r) r.value = String(rs.raise[p.id] ?? 0);
    });
    markPreset();
    document.querySelectorAll("[data-drawv]").forEach((el) => {
      const key = el.dataset.drawv;
      el.textContent = `${drawPct(rs, key)}%`;
      const r = document.querySelector(`[data-r="draw|${CSS.escape(key)}"]`);
      if (r && document.activeElement !== r) r.value = String(drawPct(rs, key));
    });
    retireSavings(d).forEach((sv) => {
      $(`r-sc-${sv.id}`).textContent = fmt(budget(d, S.st).amt[`sav:${sv.id}`] ?? 0);
    });
    d.p.investments.forEach((v) => {
      const st = rs.inv[v.id];
      const monthly = budget(d, S.st).amt[`inv:${v.id}`] ?? 0;
      const fed = d.p.savings.filter((sv) => overflowTarget(d, sv) === v.id).map((sv) => sv.name);
      const on2 = st.bal > 0 || monthly > 0 || fed.length > 0;
      $(`pn-inv-${v.id}`).classList.toggle("pane-off", !on2);
      $(`r-ic-${v.id}`).textContent = fmt(monthly);
      $(`r-ir-${v.id}`).textContent = `${st.ret}%`;
      $(`r-inote-${v.id}`).textContent = !on2 ? "Off until you enter a balance here or a monthly amount in Budgeting." : `Its own return rate, separate from the presets.${fed.length ? ` Also gets what ${fed.join(" and ")} adds once full.` : ""}${st.ret < rs.inf ? ` At ${st.ret}% it grows slower than ${rs.inf}% inflation, so it loses buying power.` : ""} Turned into monthly income at its withdrawal rate.`;
    });
    const R = retirementIncome(d, S, rs.age);
    const ry = retireYear(d, rs);
    const sp = spendAt(d, S, ry).spend;
    const staggered = d.partners.some((p) => R.years[p.id] !== ry);
    const net = 1 - S.fs.tax / 100;
    const today = spendToday(d, S.st);
    $("ra-v").textContent = String(rs.age);
    $("ra-when").textContent = `${R.years[d.primary.id] - 1} \xB7 ${Math.round(rs.age - d.primary.age)} years from now`;
    const who = (id) => d.partners.find((p) => p.id === id)?.name ?? "";
    const row2 = (x) => {
      let sub = "";
      if (x.balance != null) {
        sub = `${fmt(x.balance)} balance \xB7 ${fmt(x.balance / Math.pow(1 + rs.inf / 100, x.yrs ?? R.yrs))} in today's $`;
      }
      if (x.kind === "pension") sub = who(x.partner);
      if (x.kind === "ss") {
        sub = x.started ? `claimed at ${Math.floor(x.claimAge)} \xB7 ${Math.round(ssFactor(x.claimAge) * 100)}% of age-67 amount` : `starts ${x.start} at ${Math.ceil(x.claimAge - 0.01)}: +${fmt(x.value)}/mo`;
      }
      return `<i class="sw" style="background:var(${partColor(x)})"></i><span>${esc(x.name)}${sub ? ` <span class="small muted">${esc(sub)}</span>` : ""}</span><span class="num">${fmt(x.started ? x.value : 0)}/mo</span>`;
    };
    const gapRow = (lbl, v) => {
      const c = sp ? v / sp : 0;
      const ok = c >= 1;
      return `<span></span><span><b>${ok ? lbl.replace("Gap", "Surplus") : lbl}</b> <span
      class="small muted">${Math.round(c * 100)}% covered</span></span><span class="num ${ok ? "pos" : "neg"}"><b>${ok ? "+" : ""}${fmt(v - sp)}</b></span>`;
    };
    $("r-parts").innerHTML = R.parts.map(row2).join("") + `<span></span><span class="tot">Income ${staggered ? `once everyone is retired (${ry - 1})` : "at retirement"}, before tax</span><span class="num tot">${fmt(R.total)}/mo</span><span></span><span class="muted">Income tax (${S.fs.tax}%)</span><span class="num muted">(${fmt(R.total * S.fs.tax / 100)})</span><span></span><span><b>After tax</b></span><span class="num"><b>${fmt(R.total * net)}/mo</b></span>` + (R.later > 0 ? `<span></span><span><b>After tax, once all Social Security starts</b> <span
        class="small muted">from ${R.fullYear}</span></span><span class="num"><b>${fmt(R.full * net)}/mo</b></span>` : "") + `<span></span><span>Projected spending in retirement <span class="small muted">children
        gone, retirement changes, health insurance \xB7 today it's ${fmt(today)}</span></span><span
        class="num">${fmt(sp)}/mo</span>` + gapRow(R.later > 0 ? "Gap at retirement" : "Gap each month", R.total * net) + (R.later > 0 ? gapRow(`Gap from ${R.fullYear} on`, R.full * net) : "");
    const kinds = [];
    R.parts.forEach((x) => {
      const lbl = x.kind === "pension" ? "Pensions" : x.kind === "investment" ? "Investments" : x.kind === "savings" ? "Savings" : x.kind === "ss" ? "Social Security" : x.partner === d.primary.id ? `${d.primary.name}'s accounts` : "Other accounts";
      if (!kinds.some(([l]) => l === lbl)) kinds.push([lbl, partColor(x)]);
    });
    $("r-legend").innerHTML = kinds.map(([l, c]) => `<span><i class="sw" style="background:var(${c})"></i>${esc(l)}</span>`).join("") + `<span><i class="sw" style="border:2px solid var(--r4);background:transparent"></i>Social Security starting later</span><span><i class="ln proj"></i>Projected retirement spending</span><span><i class="ln today"></i>Spending today</span>`;
    drawChart2(today);
    drawTable();
  }
  function drawChart2(today) {
    const { d, S } = app;
    const net = 1 - S.fs.tax / 100;
    const ages = [];
    for (let a = lo; a <= hi; a++) ages.push(retirementIncome(d, S, a));
    const svg = $("rchart");
    const W = 960;
    const H = 300;
    const L = 56;
    const Rr = 12;
    const T = 14;
    const B = 30;
    const pw = W - L - Rr;
    const ph = H - T - B;
    const bw = pw / ages.length;
    const base0 = Math.round(d.todayYear - d.primary.age);
    const spA = ages.map((x) => spendAt(d, S, x.year).spend);
    const max = Math.max(today, ...spA, ...ages.map((x) => x.full * net), 1);
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + ph - v / top * ph;
    let g = "";
    for (let v = 0; v <= top + 1e-6; v += step) {
      g += `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fk(v)}</text>`;
    }
    const order = ["pension", "account", "investment", "savings", "ss"];
    ages.forEach((x, i) => {
      const bx = L + i * bw + bw * 0.16;
      const w = bw * 0.68;
      let base = T + ph;
      let segs = "";
      const started = x.parts.filter((p) => p.started).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      started.forEach((p) => {
        const h = ph * p.value * net / top;
        if (h > 0.5) {
          base -= h;
          segs += `<rect x="${bx}" y="${base}" width="${w}" height="${Math.max(h - 2, 0.5)}" rx="2" style="fill:var(${partColor(p)})"/>`;
        }
      });
      if (x.later > 0) {
        const h = ph * x.later * net / top;
        base -= h;
        segs += `<rect x="${bx + 1}" y="${base + 1}" width="${w - 2}" height="${Math.max(h - 3, 0.5)}" rx="2" style="fill:none;stroke:var(--r4);stroke-width:2;stroke-dasharray:4 3"/>`;
      }
      const tip = `<b>Age ${x.age} \xB7 ${base0 + x.age}</b>` + started.map((p) => `<br>${esc(p.name)} ${fmt(p.value)}`).join("") + `<br><b>After tax ${fmt(x.total * net)}/mo</b>` + (x.later > 0 ? `<br>+ ${fmt(x.later * net)} Social Security from ${x.fullYear}<br><b>Then ${fmt(x.full * net)}/mo</b>` : "") + `<br>Projected spending ${fmt(spA[i])}/mo`;
      g += `<g class="m" data-a="${x.age}" data-tip="${tip.replace(/"/g, "&quot;")}">${segs}<rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ph}"/><text x="${L + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle" ${x.age === S.rs.age ? 'class="selage"' : ""}>${x.age}</text></g>`;
    });
    g += `<line class="halo" x1="${L}" x2="${W - Rr}" y1="${y(today)}" y2="${y(today)}"/><line class="todayline" x1="${L}" x2="${W - Rr}" y1="${y(today)}" y2="${y(today)}"/>`;
    ages.forEach((_, i) => {
      const x1 = L + i * bw + bw * 0.08;
      const x2 = L + (i + 1) * bw - bw * 0.08;
      g += `<line class="halo" x1="${x1}" x2="${x2}" y1="${y(spA[i])}" y2="${y(spA[i])}"/><line class="projline" x1="${x1}" x2="${x2}" y1="${y(spA[i])}" y2="${y(spA[i])}"/>`;
    });
    svg.innerHTML = g;
    svg.querySelectorAll("g.m").forEach((el) => {
      el.addEventListener("mousemove", (e) => showTip(e, el.dataset.tip));
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("click", () => {
        app.S.rs.age = +el.dataset.a;
        changed();
      });
    });
  }
  function drawTable() {
    const { d, S } = app;
    const net = 1 - S.fs.tax / 100;
    const base0 = Math.round(d.todayYear - d.primary.age);
    const ages = TABLE_AGES.filter((a) => a >= lo && a <= hi);
    if (!ages.includes(S.rs.age)) ages.push(S.rs.age);
    ages.sort((a, b) => a - b);
    const kinds = ["pension", "account", "investment", "savings", "ss"].filter((k) => retirementIncome(d, S, S.rs.age).parts.some((p) => p.kind === k));
    const names = {
      pension: "Pensions",
      account: "Accounts",
      investment: "Investments",
      savings: "Savings",
      ss: "Soc. Sec."
    };
    $("rtable").innerHTML = `<tr>${d.partners.map((p) => `<th>${esc(p.name)}</th>`).join("")}<th>Year</th>${kinds.map((k) => `<th>${names[k]}</th>`).join("")}<th>After tax</th><th>Once SS starts</th><th>Projected spending</th><th>vs spending, long run</th></tr>` + ages.map((a) => {
      const x = retirementIncome(d, S, a);
      const sa = spendAt(d, S, x.year).spend;
      const df = x.full * net - sa;
      return `<tr data-a="${a}" class="${a === S.rs.age ? "on" : ""}">${d.partners.map((p) => `<td>${Math.floor(x.ages[p.id])}</td>`).join("")}<td>${base0 + a}</td>${kinds.map((k) => `<td>${fmt(sum(x.parts.filter((p) => p.kind === k && p.started).map((p) => p.value)))}</td>`).join("")}<td>${fmt(x.total * net)}</td><td>${x.later > 0 ? `${fmt(x.full * net)} <span class="muted">(${x.fullYear})</span>` : "\u2013"}</td><td>${fmt(sa)}</td><td class="${df >= 0 ? "pos" : "neg"}">${df >= 0 ? "+" : ""}${fmt(df)}</td></tr>`;
    }).join("");
    document.querySelectorAll("#rtable tr[data-a]").forEach((tr) => {
      tr.addEventListener("click", () => {
        app.S.rs.age = +tr.dataset.a;
        changed();
      });
    });
  }

  // src/ui/settings.ts
  var TABS = [
    ["household", "Household"],
    ["money", "Savings & income"],
    ["assumptions", "Assumptions"],
    ["sources", "Data sources"],
    ["categories", "Categories"],
    ["categorize", "Categorize"],
    ["share", "Share plan"]
  ];
  var KINDS2 = [
    ["spending", "Regular"],
    ["annual", "Annual expense"],
    ["one_time", "1-time purchase"],
    ["emergency", "Emergency fund cost"],
    ["credit", "Credit (money in)"],
    ["ignore", "Ignore"]
  ];
  var MODES = [
    ["fixed", "Fixed $ per month"],
    ["pct", "% of what is left each month"],
    ["rest", 'The rest (split evenly with other "rest" lines)']
  ];
  var CLAIM_AGES = [62, 63, 64, 65, 66, 67, 68, 69, 70];
  function settingsDirty() {
    return dirty;
  }
  async function showSettings(tab = "household") {
    current = TABS.some(([k]) => k === tab) ? tab : "household";
    const root = document.getElementById("settings");
    root.innerHTML = '<p class="muted">Loading settings\u2026</p>';
    try {
      cfg = await get("/api/config");
    } catch (err) {
      root.innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
      return;
    }
    root.innerHTML = `<div class="sec-head"><h2 id="settings-title">Settings</h2>
      <a class="btn" href="#budget" style="text-decoration:none">Back to the budget</a></div>
    <p class="small muted">Plan folder <span class="mono">${esc(cfg.plan_dir)}</span>. Changes are
      saved to the YAML files in its <span class="mono">config</span> folder (you can also edit
      them by hand). Keep this folder private: it holds your financial data.</p>
    ${cfg.error ? `<div class="banner err"><b>The config has a problem.</b><span class="mono"
      style="white-space:pre-wrap">${esc(cfg.error)}</span><span class="small">Fix it here or in
      the YAML files. The rest of the app opens once it's valid.</span></div>` : ""}
    <nav class="stabs" role="tablist" aria-label="Settings sections">${TABS.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === current}">${l}</button>`).join("")}</nav>
    <div id="st-body" style="display:grid;gap:14px"></div>`;
    root.querySelectorAll("[data-tab]").forEach((b) => {
      b.addEventListener("click", () => {
        location.hash = `#settings/${b.dataset.tab}`;
      });
    });
    renderTab();
  }
  var cfg;
  var current = "household";
  var dirty = false;
  function renderTab() {
    const body = document.getElementById("st-body");
    const render2 = {
      household: renderHousehold,
      money: renderMoney,
      assumptions: renderAssumptions,
      sources: renderSources,
      categories: renderCategories,
      share: renderShare,
      categorize: (el) => renderCategorizeTab(el, () => {
        dirty = true;
      })
    };
    render2[current](body);
  }
  async function save2(section2, value) {
    await send("PUT", `/api/config/${section2}`, value);
    dirty = true;
    cfg = await get("/api/config");
  }
  function report(el, err, ok = "Saved.") {
    if (!el) return;
    el.className = `msg ${err ? "err" : "ok"}`;
    el.textContent = err ? err instanceof ApiError ? err.message : String(err) : ok;
  }
  function section(key, fallback) {
    const v = cfg.raw[key];
    return v === void 0 ? fallback : JSON.parse(JSON.stringify(v));
  }
  function fileOf(key) {
    return cfg.owners[key] ?? "a new file";
  }
  function input(k, label2, value, type = "text", hint = "", attrs = "") {
    const v = value === null || value === void 0 ? "" : String(value);
    return `<label class="field"><span>${esc(label2)}</span><input data-k="${esc(k)}" type="${type}"
    value="${esc(v)}" ${type === "number" ? 'step="any" inputmode="decimal"' : ""} ${attrs}>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</label>`;
  }
  function check(k, label2, value) {
    return `<label class="field check"><input data-k="${esc(k)}" type="checkbox"${value ? " checked" : ""}>${esc(label2)}</label>`;
  }
  function select(k, label2, options, value, hint = "") {
    return `<label class="field"><span>${esc(label2)}</span><select data-k="${esc(k)}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(value ?? "") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</label>`;
  }
  function readFields(root) {
    const out = {};
    root.querySelectorAll("[data-k]").forEach((el) => {
      const list = el.closest("[data-list]");
      if (list && root.contains(list)) return;
      const path = el.dataset.k.split(".");
      let v;
      if (el instanceof HTMLInputElement && el.type === "checkbox") v = el.checked;
      else if (el instanceof HTMLInputElement && el.type === "number") {
        if (el.value.trim() === "") return;
        v = +el.value;
      } else {
        v = el.value.trim();
        if (v === "" && el.dataset.optional !== void 0) return;
      }
      let cur = out;
      path.slice(0, -1).forEach((p) => cur = cur[p] ?? (cur[p] = {}));
      cur[path[path.length - 1]] = v;
    });
    return out;
  }
  function readRows(root, list) {
    return [...root.querySelectorAll(`[data-list="${list}"] > [data-row]`)].map((row2) => readFields(row2));
  }
  function listEditor(list, rows, rowHtml, addLabel) {
    return `<div class="listed" data-list="${list}">${rows.map((r) => `<div class="item"
    data-row>${rowHtml(r)}<button class="btn sm danger" type="button" data-rm>Remove</button></div>`).join("")}</div><button class="btn sm add" type="button" data-add="${list}">${esc(addLabel)}</button>`;
  }
  function wireLists(root, templates) {
    root.addEventListener("click", (e) => {
      const t = e.target;
      if (t.matches("[data-rm]")) t.closest("[data-row]").remove();
      const add = t.closest("[data-add]");
      if (add) {
        const list = root.querySelector(`[data-list="${add.dataset.add}"]`);
        const div = document.createElement("div");
        div.className = "item";
        div.dataset.row = "";
        div.innerHTML = `${templates[add.dataset.add]()}<button class="btn sm danger" type="button"
        data-rm>Remove</button>`;
        list.appendChild(div);
        div.querySelector("input,select")?.focus();
      }
    });
  }
  function formDialog(title, html, onSave, templates = {}) {
    const dlg = document.getElementById("dlg");
    dlg.innerHTML = `<div class="form"><div class="dlg-head"><h3>${esc(title)}</h3><button
      class="btn sm" type="button" data-x>Close</button></div><div class="dlg-body" id="fd-body">${html}<p class="msg" id="fd-msg"></p></div><div class="dlg-foot"><button class="btn"
      type="button" data-x>Cancel</button><button class="btn primary" type="button"
      id="fd-save">Save</button></div></div>`;
    const body = dlg.querySelector("#fd-body");
    wireLists(body, templates);
    wireModes(body);
    dlg.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => dlg.close()));
    dlg.querySelector("#fd-save").addEventListener("click", async () => {
      try {
        await onSave(body);
        dlg.close();
        renderTab();
      } catch (err) {
        report(dlg.querySelector("#fd-msg"), err);
      }
    });
    dlg.showModal();
  }
  function confirmClick(b, action) {
    let armed = false;
    b.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        b.textContent = "Click again to remove";
        return;
      }
      action();
    });
  }
  function renderHousehold(el) {
    const hh = section("household", {});
    const partners = hh.partners ?? [];
    const children = hh.children ?? [];
    const money = (v) => fmt(+v || 0);
    el.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Partners</h3><span class="small muted">Saved in ${esc(fileOf("household"))}. The first partner's age drives the retirement slider.</span></div>
      <div class="cards">${partners.map((p, i) => `<div class="card"><div class="card-head"><b>${esc(p.name)}</b><span class="small muted">age ${esc(p.age)}</span></div>
        <div class="row"><span>Take-home / mo</span><span class="num">${money(p.take_home_monthly)}</span></div>
        <div class="row"><span>Social Security at 67</span><span class="num">${money(p.social_security?.at_67)}</span></div>
        <div class="small muted">${(p.pensions ?? []).length} pension(s), ${(p.accounts ?? []).length} retirement account(s)</div>
        <div class="card-actions"><button class="btn sm" type="button" data-edit-p="${i}">Edit</button>${partners.length > 1 ? `<button class="btn sm danger" type="button" data-rm-p="${i}">Remove</button>` : ""}</div>
        </div>`).join("")}
        <button class="card btn add" type="button" id="add-partner" style="place-content:center;min-height:120px">+ Add partner</button></div>
    </div>
    <div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Children</h3><span class="small muted">Each child gets a 529 card.</span></div>
      <div class="cards">${children.map((c, i) => `<div class="card"><div class="card-head"><b>${esc(c.name ?? `Child ${i + 1}`)}</b><span class="small muted">age ${esc(c.age)}</span></div>
        <div class="row"><span>529 balance</span><span class="num">${money(c.college_529?.balance)}</span></div>
        <div class="row"><span>529 per month</span><span class="num">${contribText(c.college_529 ?? {})}</span></div>
        <div class="card-actions"><button class="btn sm" type="button" data-edit-c="${i}">Edit</button><button
          class="btn sm danger" type="button" data-rm-c="${i}">Remove</button></div></div>`).join("")}
        <button class="card btn add" type="button" id="add-child" style="place-content:center;min-height:120px">+ Add child</button></div>
    </div><p class="msg" id="hh-msg"></p>`;
    const msg = el.querySelector("#hh-msg");
    const saveHH = async () => save2("household", { ...hh, partners, children });
    el.querySelector("#add-partner").addEventListener("click", () => partnerForm(
      null,
      partners,
      saveHH
    ));
    el.querySelector("#add-child").addEventListener("click", () => childForm(null, children, saveHH));
    el.querySelectorAll("[data-edit-p]").forEach((b) => b.addEventListener(
      "click",
      () => partnerForm(+b.dataset.editP, partners, saveHH)
    ));
    el.querySelectorAll("[data-edit-c]").forEach((b) => b.addEventListener(
      "click",
      () => childForm(+b.dataset.editC, children, saveHH)
    ));
    el.querySelectorAll("[data-rm-p]").forEach((b) => confirmClick(b, () => {
      partners.splice(+b.dataset.rmP, 1);
      saveHH().then(() => renderTab(), (err) => report(msg, err));
    }));
    el.querySelectorAll("[data-rm-c]").forEach((b) => confirmClick(b, () => {
      children.splice(+b.dataset.rmC, 1);
      saveHH().then(() => renderTab(), (err) => report(msg, err));
    }));
  }
  function estimatesText(est) {
    return Object.entries(est ?? {}).map(([a, v]) => `${a}: ${v}`).join(", ");
  }
  function parseEstimates(text) {
    const out = {};
    text.split(/[,;\n]/).forEach((part) => {
      const m = part.match(/^\s*(\d{2})\s*[:=]\s*\$?([\d,.]+)\s*$/);
      if (m) out[m[1]] = +m[2].replace(/,/g, "");
      else if (part.trim()) throw new Error(`Couldn't read "${part.trim()}". Use age: amount, e.g. 60: 2800`);
    });
    return out;
  }
  function partnerForm(i, partners, saveHH) {
    const p = i === null ? {
      name: `Partner ${String.fromCharCode(65 + partners.length)}`,
      age: 40
    } : partners[i];
    const ss = p.social_security ?? {};
    const pensionRow = (r = {}) => input("name", "Pension name", r.name ?? "Pension") + input(
      "estimates",
      "Estimates by age",
      estimatesText(r.estimates),
      "text",
      "age: monthly, e.g. 55: 900, 60: 2800, 65: 5800"
    ) + input("monthly", "Or a flat monthly amount", r.monthly, "number") + input(
      "service_years_now",
      "Years of service today",
      r.service_years_now,
      "number",
      "optional: grows the benefit after the last age"
    );
    const accountRow = (r = {}) => input("name", "Account", r.name ?? "401(k)") + input("balance", "Balance today", r.balance ?? 0, "number") + input("monthly", "Added per month", r.monthly ?? 0, "number");
    const html = `<div class="fgrid">
      ${input("name", "Name", p.name, "text", "A generic name is safest, e.g. Partner A")}
      ${input("age", "Age", p.age, "number")}
      ${input("take_home_monthly", "Take-home pay per month", p.take_home_monthly ?? 0, "number")}
      ${input(
      "take_home_note",
      "Where that number came from",
      p.take_home_note ?? "",
      "text",
      "",
      "data-optional"
    )}
      ${input("raise_pct", "Yearly raise above inflation (%)", p.raise_pct ?? 0, "number")}
      ${input(
      "social_security.at_67",
      "Social Security at 67 (per month)",
      ss.at_67 ?? 0,
      "number",
      "From the Social Security statement"
    )}
      ${select("social_security.claim_age", "Claims Social Security at", [
      ["", "When retiring (62+)"],
      ...CLAIM_AGES.map((a) => [String(a), String(a)])
    ], ss.claim_age ?? "")}
      ${input(
      "retirement_age",
      "Retires at (age)",
      p.retirement_age ?? "",
      "number",
      i === 0 ? "Empty: the starting age under Assumptions" : "Empty: the same year as the first partner",
      "data-optional"
    )}
    </div>
    <div class="subhead">Pensions</div>
    ${listEditor("pensions", p.pensions ?? [], pensionRow, "+ Add pension")}
    <div class="subhead">Retirement accounts</div>
    ${listEditor("accounts", p.accounts ?? [], accountRow, "+ Add account")}`;
    formDialog(i === null ? "Add partner" : `Edit ${p.name}`, html, async (form) => {
      const top = readFields(form);
      const s = top.social_security ?? {};
      const next = {
        ...i === null ? {} : partners[i],
        ...top,
        social_security: { at_67: s.at_67 ?? 0, ...s.claim_age ? { claim_age: +s.claim_age } : {} },
        pensions: readRows(form, "pensions").map((r) => {
          const out = { name: r.name, estimates: parseEstimates(String(r.estimates ?? "")) };
          if (r.monthly !== void 0) out.monthly = r.monthly;
          if (r.service_years_now !== void 0) out.service_years_now = r.service_years_now;
          return out;
        }),
        accounts: readRows(form, "accounts")
      };
      if (!top.take_home_note) delete next.take_home_note;
      if (top.retirement_age === void 0 || top.retirement_age === "") delete next.retirement_age;
      const list = partners.slice();
      if (i === null) list.push(next);
      else list[i] = next;
      partners.splice(0, partners.length, ...list);
      await saveHH();
    }, { pensions: () => pensionRow(), accounts: () => accountRow() });
  }
  function childForm(i, children, saveHH) {
    const c = i === null ? { name: `Child ${children.length + 1}`, age: 5 } : children[i];
    const col = c.college_529 ?? {};
    const schools = schoolOptions();
    const html = `<div class="fgrid">
      ${input(
      "name",
      "Name",
      c.name,
      "text",
      'Empty: "Child 1", "Child 2"\u2026 by position',
      "data-optional"
    )}
      ${input("age", "Age", c.age, "number")}
      ${input(
      "hs_graduation",
      "High school graduation (YYYY-MM)",
      c.hs_graduation ?? "",
      "text",
      "Optional: estimated from age if empty",
      'data-optional placeholder="2034-06"'
    )}
      ${input("college_529.balance", "529 balance today", col.balance ?? 0, "number")}
      ${contribFields(col, "college_529.", "529 contribution")}
      ${select("school", "Planned school", schools, c.school ?? schools[0]?.[0])}
      ${input("note", "Note for the card", c.note ?? "", "text", "", "data-optional")}
    </div>`;
    formDialog(
      i === null ? "Add child" : `Edit ${c.name ?? `Child ${i + 1}`}`,
      html,
      async (form) => {
        const fields = readFields(form);
        fields.college_529 = contribOut(fields.college_529 ?? {});
        const next = { ...i === null ? {} : children[i], ...fields };
        if (!next.name) delete next.name;
        if (!next.hs_graduation) delete next.hs_graduation;
        if (!next.note) delete next.note;
        const list = children.slice();
        if (i === null) list.push(next);
        else list[i] = next;
        children.splice(0, children.length, ...list);
        await saveHH();
      }
    );
  }
  function schoolOptions() {
    const schools = cfg.raw.assumptions?.college?.schools;
    const list = schools ?? {
      public: { name: "Public in-state" },
      flagship: { name: "Flagship in-state" },
      private: { name: "Private" }
    };
    return Object.entries(list).map(([k, v]) => [k, String(v.name ?? k)]);
  }
  function renderMoney(el) {
    const savings = section("savings", []);
    const investments = section("investments", []);
    const overflow = [
      ["", "The first investment"],
      ...investments.map((v) => [
        String(v.id ?? slug(String(v.name ?? ""))),
        String(v.name ?? "Investments")
      ])
    ];
    const savRow2 = (r = {}) => input("name", "Name", r.name ?? "Savings account") + select(
      "type",
      "Type",
      [["savings", "Savings account"], ["emergency", "Emergency fund"]],
      r.type ?? "savings"
    ) + input("balance", "Balance today", r.balance ?? 0, "number") + input(
      "max_balance",
      "Max balance",
      r.max_balance ?? "",
      "number",
      "Optional: once reached, the rest goes to an investment"
    ) + select("overflow_to", "Then invest in", overflow, r.overflow_to ?? "") + input("return_pct", "Yearly interest (%)", r.return_pct ?? 0, "number") + contribFields(r) + check("stops_at_retirement", "Stops at retirement", r.stops_at_retirement ?? true);
    const invRow = (r = {}) => input("name", "Name", r.name ?? "Stocks") + select("type", "Type", [["stocks", "Stocks"], ["bonds", "Bonds"]], r.type ?? "stocks") + input("balance", "Balance today", r.balance ?? 0, "number") + input("return_pct", "Yearly return (%)", r.return_pct ?? 0, "number") + contribFields(r);
    el.innerHTML = `<div class="panel form">
      <h3>Other income</h3>
      <div class="fgrid">${input(
      "other",
      "Other take-home income per month",
      cfg.raw.other_income_monthly ?? 0,
      "number"
    )}</div>
      <h3>Savings</h3><p class="small muted">Savings accounts and emergency funds. Emergency fund
        costs (a category kind) are paid from the emergency funds. With a max balance, anything
        past it goes to an investment. Each one adds a fixed amount per month or a share of what
        is left over each month (after spending, taxes and the fixed amounts), optionally kept
        between a minimum and a maximum.</p>
      ${listEditor("savings", savings, savRow2, "+ Add savings account or emergency fund")}
      <h3>Investments</h3><p class="small muted">Stock and bond accounts. Each grows at its own
        return (0% = off) and becomes retirement income. Contributions stop at retirement.</p>
      ${listEditor("investments", investments, invRow, "+ Add investment account")}
      <div class="btns"><button class="btn primary" type="button" id="m-save">Save</button></div>
      <p class="msg" id="m-msg"></p></div>`;
    wireLists(el, { savings: () => savRow2(), investments: () => invRow() });
    wireModes(el);
    el.querySelector("#m-save").addEventListener("click", async () => {
      const msg = el.querySelector("#m-msg");
      try {
        const other = el.querySelector('[data-k="other"]').value;
        await save2("other_income_monthly", +other || 0);
        await save2("investments", mergeIds(investments, readRows(el, "investments").map(contribOut)));
        await save2("savings", mergeIds(savings, readRows(el, "savings").map((r) => {
          const out = contribOut(r);
          if (!out.overflow_to || out.max_balance === void 0) delete out.overflow_to;
          return out;
        })));
        report(msg);
      } catch (err) {
        report(msg, err);
      }
    });
  }
  function contribFields(r, prefix = "", label2 = "Contribution") {
    const mode2 = r.rest ? "rest" : r.left_pct != null ? "pct" : "fixed";
    return select(`${prefix}_mode`, label2, MODES, mode2) + `<span class="contents" data-when="fixed"${mode2 === "fixed" ? "" : " hidden"}>${input(`${prefix}monthly`, "Per month", r.monthly ?? 0, "number")}</span><span class="contents" data-when="pct"${mode2 === "pct" ? "" : " hidden"}>${input(`${prefix}left_pct`, "% of left-over", r.left_pct ?? "", "number")}${input(
      `${prefix}min_monthly`,
      "At least per month",
      r.min_monthly ?? "",
      "number",
      "Optional"
    )}${input(
      `${prefix}max_monthly`,
      "At most per month",
      r.max_monthly ?? "",
      "number",
      "Optional"
    )}</span>`;
  }
  function wireModes(root) {
    root.addEventListener("change", (e) => {
      const sel = e.target;
      if (!(sel instanceof HTMLSelectElement) || !sel.dataset.k?.endsWith("_mode")) return;
      sel.closest("label").parentElement.querySelectorAll(":scope > [data-when]").forEach((x) => x.hidden = x.dataset.when !== sel.value);
    });
  }
  function contribOut(f) {
    const { _mode: mode2, ...out } = f;
    delete out.rest;
    if (mode2 === "rest") out.rest = true;
    if (mode2 === "pct") {
      out.left_pct = out.left_pct ?? 0;
    } else {
      delete out.left_pct;
      delete out.min_monthly;
      delete out.max_monthly;
    }
    return out;
  }
  function contribText(c) {
    if (c.rest) return "the rest";
    return c.left_pct != null ? `${c.left_pct}% of left-over` : fmt(+c.monthly || 0);
  }
  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
  }
  function mergeIds(before, after) {
    return after.map((r, i) => before[i]?.id && before[i].name === r.name ? { id: before[i].id, ...r } : r);
  }
  function renderAssumptions(el) {
    const plan = section("plan", {});
    const asm = section("assumptions", {});
    const ret = asm.retirement ?? {};
    const col = asm.college ?? {};
    const toRows = (o) => Object.entries(o ?? {}).map(([key, v]) => ({ key, ...v }));
    const presetRow = (r = {}) => input("key", "Key", r.key ?? "") + input("name", "Name", r.name ?? "") + input(
      "return_pct",
      "Return %",
      r.return_pct ?? 5,
      "number"
    ) + input("inflation_pct", "Inflation %", r.inflation_pct ?? 3, "number");
    const schoolRow = (r = {}) => input("key", "Key", r.key ?? "") + input("name", "Name", r.name ?? "") + input(
      "cost",
      "Cost per year today",
      r.cost ?? 3e4,
      "number"
    );
    el.innerHTML = `<div class="panel form"><h3>Plan</h3><div class="fgrid">
      ${input("plan.title", "Title", plan.title ?? "Household Budget")}
      ${input(
      "plan.subtitle",
      "Subtitle",
      plan.subtitle ?? "",
      "text",
      "Empty: a line naming your data sources and months",
      "data-optional"
    )}
      ${input(
      "plan.months",
      "Months to average",
      plan.months ?? 12,
      "number",
      "The most recent N months of transactions"
    )}
      ${input(
      "plan.last_month",
      "Last month to average (YYYY-MM)",
      plan.last_month ?? "",
      "text",
      "Empty: the month of the newest transaction",
      "data-optional"
    )}
      ${input(
      "plan.today",
      "Today (YYYY-MM)",
      plan.today ?? "",
      "text",
      "Empty: the month after the averaging window",
      "data-optional"
    )}
      ${input("plan.currency_symbol", "Currency symbol", plan.currency_symbol ?? "$")}</div>
    <h3>Retirement</h3><div class="fgrid">
      ${input("r.default_age", "Starting retirement age", ret.default_age ?? 65, "number")}
      ${input("r.return_pct", "Investment return (%)", ret.return_pct ?? 5.5, "number")}
      ${input("r.inflation_pct", "Inflation (%)", ret.inflation_pct ?? 3, "number")}
      ${input("r.withdrawal_pct", "Yearly withdrawal (%)", ret.withdrawal_pct ?? 4, "number")}
      ${input("r.tax_pct", "Income tax in retirement (%)", ret.tax_pct ?? 12, "number")}
      ${input(
      "r.health_insurance_monthly",
      "Health insurance after retiring (/mo)",
      ret.health_insurance_monthly ?? 0,
      "number"
    )}</div>
    <div class="subhead">Return &amp; inflation presets</div>
    ${listEditor("rpresets", toRows(ret.presets), presetRow, "+ Add preset")}
    <h3>College</h3><div class="fgrid">
      ${input("c.graduation_age", "Age at high school graduation", col.graduation_age ?? 18, "number")}
      ${input("c.years", "Years of college", col.years ?? 4, "number")}
      ${input("c.default_preset", "Starting preset (key)", col.default_preset ?? "mid")}</div>
    <div class="subhead">Schools</div>
    ${listEditor("schools", toRows(col.schools), schoolRow, "+ Add school")}
    <div class="subhead">Return &amp; college cost presets</div>
    ${listEditor("cpresets", toRows(col.presets), presetRow, "+ Add preset")}
    <p class="small muted">Leave a preset or school list empty to use the built-in defaults.</p>
    <div class="btns"><button class="btn primary" type="button" id="a-save">Save</button></div>
    <p class="msg" id="a-msg"></p></div>`;
    wireLists(el, {
      rpresets: () => presetRow(),
      cpresets: () => presetRow(),
      schools: () => schoolRow()
    });
    const keyed = (rows) => {
      const out = {};
      rows.forEach(({ key, ...rest }) => {
        if (key) out[String(key)] = rest;
      });
      return Object.keys(out).length ? out : void 0;
    };
    el.querySelector("#a-save").addEventListener("click", async () => {
      const msg = el.querySelector("#a-msg");
      const top = el.querySelector(".form");
      const all = {};
      top.querySelectorAll(":scope > .fgrid [data-k]").forEach((inp) => {
        const v = inp.type === "number" ? inp.value === "" ? void 0 : +inp.value : inp.value.trim();
        if (v === "" || v === void 0) return;
        all[inp.dataset.k] = v;
      });
      const pick = (prefix) => Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
      const nextRet = { ...ret, ...pick("r.") };
      const rp = keyed(readRows(el, "rpresets"));
      if (rp) nextRet.presets = rp;
      else delete nextRet.presets;
      const nextCol = { ...col, ...pick("c.") };
      const sc = keyed(readRows(el, "schools"));
      const cp = keyed(readRows(el, "cpresets"));
      if (sc) nextCol.schools = sc;
      else delete nextCol.schools;
      if (cp) nextCol.presets = cp;
      else delete nextCol.presets;
      try {
        await save2("plan", pick("plan."));
        await save2("assumptions", { ...asm, retirement: nextRet, college: nextCol });
        report(msg);
      } catch (err) {
        report(msg, err);
      }
    });
  }
  function renderSources(el) {
    const sources = section("sources", []);
    const describe = (s) => {
      const amt = s.amount ?? {};
      return amt.column ? `amount in "${amt.column}" (money out is ${amt.outflow ?? "negative"})` : `money out in "${amt.debit ?? "\u2013"}", money in in "${amt.credit ?? "\u2013"}"`;
    };
    el.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Data sources</h3><span class="small muted">One per kind of CSV
        export (a card, a checking account\u2026). Saved in ${esc(fileOf("sources"))}.</span></div>
      <p class="small muted">CSV files live in the plan's <span class="mono">data</span> folder: ${cfg.files.length ? cfg.files.map((f) => `<span class="mono">${esc(f)}</span>`).join(", ") : "none yet"}.</p>
      <div class="cards">${sources.map((s, i) => `<div class="card"><b>${esc(s.name)}</b>
        <span class="small mono">${esc([s.files].flat().join(", "))}</span>
        <span class="small muted">date "${esc(s.date?.column)}", ${esc(describe(s))}</span>
        <div class="card-actions"><button class="btn sm" type="button" data-edit="${i}">Edit</button>
          <button class="btn sm danger" type="button" data-rm="${i}">Remove</button></div></div>`).join("")}
        <button class="card btn add" type="button" id="add-src" style="place-content:center;min-height:110px">+ Add data source</button></div>
      <p class="msg" id="src-msg"></p></div>`;
    const msg = el.querySelector("#src-msg");
    el.querySelector("#add-src").addEventListener("click", () => sourceForm(null, sources));
    el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener(
      "click",
      () => sourceForm(+b.dataset.edit, sources)
    ));
    el.querySelectorAll(".card [data-rm]").forEach((b) => confirmClick(b, () => {
      sources.splice(+b.dataset.rm, 1);
      save2("sources", sources).then(() => renderTab(), (err) => report(msg, err));
    }));
  }
  function sourceForm(i, sources) {
    const s = i === null ? { name: `Account ${sources.length + 1}` } : sources[i];
    const amt = s.amount ?? {};
    const date = s.date ?? {};
    const files = [s.files].flat().filter(Boolean);
    const html = `<div class="fgrid">
      ${input("name", "Name", s.name, "text", "e.g. Visa card, Joint checking")}
      <label class="field"><span>File(s)</span><input data-k="files" type="text" list="src-files"
        value="${esc(files.join(", "))}"><span class="hint">A file in data/ or a pattern like
        data/visa*.csv (comma separated)</span><datalist id="src-files">${cfg.files.map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
      <label class="field"><span>Add a CSV to data/</span><input type="file" id="src-up"
        accept=".csv,text/csv"></label>
      ${input("skip_rows", "Lines before the header row", s.skip_rows ?? 0, "number")}
      ${input("delimiter", "Separator", s.delimiter ?? ",")}
    </div>
    <div class="btns"><button class="btn sm" type="button" id="src-read">Read columns from the file</button></div>
    <p class="small muted" id="src-cols"></p>
    <div class="fgrid" id="src-map">
      ${colSelect("date.column", "Date column", [], date.column)}
      ${input(
      "date.format",
      "Date format",
      date.format ?? "",
      "text",
      "Empty = detect. e.g. %m/%d/%Y",
      "data-optional"
    )}
      ${input("description", "Description column(s)", [s.description].flat().filter(Boolean).join(", "), "text", "Comma separated; joined with a space", 'list="src-col-list"')}
      ${select("style", "Amounts are in", [
      ["one", "one signed column"],
      ["two", "separate money-out / money-in columns"]
    ], amt.column ? "one" : amt.debit || amt.credit ? "two" : "one")}
      ${colSelect("amount.column", "Amount column", [], amt.column)}
      ${select("amount.outflow", "Money going out is", [
      ["negative", "negative (most banks)"],
      ["positive", "positive (most cards)"]
    ], amt.outflow ?? "negative")}
      ${colSelect("amount.debit", "Money-out column", [], amt.debit)}
      ${colSelect("amount.credit", "Money-in column", [], amt.credit)}
      ${colSelect(
      "category_column",
      "Bank's category column (optional)",
      [],
      s.category_column,
      true
    )}
    </div><datalist id="src-col-list"></datalist>
    <div class="subhead">Bank category \u2192 plan category (optional)</div>
    ${listEditor("catmap", Object.entries(s.category_map ?? {}).map(([k, v]) => ({ bank: k, plan: v })), catMapRow, "+ Add mapping")}
    <div class="btns"><button class="btn sm" type="button" id="src-pv">Preview</button></div>
    <div class="pv" id="src-pv-out"></div>`;
    const build = (form2) => {
      const f = readFields(form2);
      const out = {
        name: f.name,
        files: String(f.files ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        date: {
          column: f.date?.column,
          ...f.date?.format ? { format: f.date.format } : {}
        },
        description: String(f.description ?? "").split(",").map((x) => x.trim()).filter(Boolean)
      };
      const a = f.amount ?? {};
      out.amount = f.style === "two" ? {
        ...a.debit ? { debit: a.debit } : {},
        ...a.credit ? { credit: a.credit } : {}
      } : { column: a.column, outflow: a.outflow };
      if (f.category_column) out.category_column = f.category_column;
      const map = {};
      readRows(form2, "catmap").forEach((r) => {
        if (r.bank && r.plan) map[String(r.bank)] = r.plan;
      });
      if (Object.keys(map).length) out.category_map = map;
      if (f.skip_rows) out.skip_rows = f.skip_rows;
      if (f.delimiter && f.delimiter !== ",") out.delimiter = f.delimiter;
      if (i !== null && sources[i].encoding) out.encoding = sources[i].encoding;
      return out;
    };
    formDialog(i === null ? "Add data source" : `Edit ${s.name}`, html, async (form2) => {
      const list = sources.slice();
      const next = build(form2);
      if (i === null) list.push(next);
      else list[i] = next;
      await save2("sources", list);
    }, { catmap: () => catMapRow() });
    const form = document.getElementById("fd-body");
    const filesInput = form.querySelector('[data-k="files"]');
    const styleSel = form.querySelector('[data-k="style"]');
    const syncStyle = () => {
      const two = styleSel.value === "two";
      ["amount.column", "amount.outflow"].forEach((k) => form.querySelector(`[data-k="${k}"]`).closest(".field").hidden = two);
      ["amount.debit", "amount.credit"].forEach((k) => form.querySelector(`[data-k="${k}"]`).closest(".field").hidden = !two);
    };
    styleSel.addEventListener("change", syncStyle);
    syncStyle();
    const setColumns = (cols2, guess = {}) => {
      form.querySelectorAll("select[data-col]").forEach((sel) => {
        const keep = sel.value || String(guessFor(sel.dataset.k, guess) ?? "");
        sel.innerHTML = (sel.dataset.optionalCol !== void 0 ? '<option value="">(none)</option>' : "") + cols2.map((c) => `<option${c === keep ? " selected" : ""}>${esc(c)}</option>`).join("");
      });
      form.querySelector("#src-col-list").innerHTML = cols2.map((c) => `<option value="${esc(c)}">`).join("");
      const desc = form.querySelector('[data-k="description"]');
      if (!desc.value && guess.description) desc.value = String(guess.description);
      if (guess.date_format) {
        const fmtIn = form.querySelector('[data-k="date.format"]');
        if (!fmtIn.value) fmtIn.placeholder = `detected: ${guess.date_format}`;
      }
      if (!amt.column && !amt.debit && !amt.credit) {
        styleSel.value = guess.debit || guess.credit ? "two" : "one";
        if (guess.outflow) {
          form.querySelector('[data-k="amount.outflow"]').value = String(guess.outflow);
        }
        syncStyle();
      }
    };
    const readColumns = async () => {
      const pattern = filesInput.value.split(",")[0]?.trim() ?? "";
      const file = /[*?]/.test(pattern) ? cfg.files.find((f) => globRe(pattern).test(f)) : pattern;
      const out = form.querySelector("#src-cols");
      if (!file) {
        out.textContent = "No file in data/ matches that yet. Add a CSV or type its name.";
        return;
      }
      try {
        const skip = form.querySelector('[data-k="skip_rows"]').value || "0";
        const delim = form.querySelector('[data-k="delimiter"]').value || ",";
        const info = await get(
          `/api/inspect?file=${encodeURIComponent(file)}&skip_rows=${skip}&delimiter=${encodeURIComponent(delim)}`
        );
        out.textContent = `${info.rows} rows \xB7 columns: ${info.columns.join(", ")}`;
        setColumns(info.columns, info.guess);
      } catch (err) {
        out.textContent = err.message;
      }
    };
    form.querySelector("#src-read").addEventListener("click", readColumns);
    form.querySelector("#src-up").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const res = await upload(`/api/files?name=${encodeURIComponent(f.name)}`, f);
        filesInput.value = res.file;
        cfg.files = [.../* @__PURE__ */ new Set([...cfg.files, res.file])];
        await readColumns();
      } catch (err) {
        form.querySelector("#src-cols").textContent = err.message;
      }
    });
    form.querySelector("#src-pv").addEventListener("click", async () => {
      const out = form.querySelector("#src-pv-out");
      try {
        const res = await send(
          "POST",
          "/api/sources/preview",
          build(form)
        );
        out.innerHTML = `<b>${res.count} transactions read</b>${res.skipped ? ` \xB7 ${res.skipped} rows skipped (unreadable date or amount)` : ""}${res.errors.map((x) => `<div class="msg err">${esc(x)}</div>`).join("")}<table>${res.sample.map((r) => `<tr><td
          class="mono">${esc(r.date)}</td><td>${esc(r.description)}</td><td class="mono"
          style="text-align:right">${fmt(r.amount, 2)}</td><td class="muted">${r.amount < 0 ? "money in" : "money out"}</td></tr>`).join("")}</table>`;
      } catch (err) {
        out.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      }
    });
    if (files.length) readColumns();
    else setColumns([]);
  }
  function globRe(glob) {
    return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  }
  function colSelect(k, label2, cols2, value, optional = false) {
    const v = value ? String(value) : "";
    const opts = [.../* @__PURE__ */ new Set([...v ? [v] : [], ...cols2])];
    return `<label class="field"><span>${esc(label2)}</span><select data-k="${esc(k)}" data-col${optional ? " data-optional-col data-optional" : ""}>${optional ? '<option value="">(none)</option>' : ""}${opts.map((c) => `<option${c === v ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>`;
  }
  function guessFor(k, guess) {
    return {
      "date.column": guess.date,
      "amount.column": guess.amount,
      "amount.debit": guess.debit,
      "amount.credit": guess.credit,
      category_column: guess.category
    }[k];
  }
  function catMapRow(r = {}) {
    return input("bank", "Bank's category", r.bank ?? "") + input(
      "plan",
      "Plan category",
      r.plan ?? "",
      "text",
      "",
      'list="cat-names"'
    ) + catNamesDatalist();
  }
  function catNamesDatalist() {
    const cats = cfg.raw.categories ?? [];
    return `<datalist id="cat-names">${cats.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist>`;
  }
  function renderShare(el) {
    el.innerHTML = `<div class="panel form">
      <h3>Send your whole plan</h3>
      <p class="small">Saves everything in this plan as one <span class="mono">.zip</span> file:
        settings, categories and rules, your CSV files, and (if ticked) your budget edits and
        saved budgets. Send it by AirDrop or Messages; the other person opens it in their
        Financial Planner and sees exactly what you see.</p>
      <label class="field check"><input type="checkbox" id="sh-state" checked>Include my budget
        edits and saved budgets</label>
      <div class="btns"><a class="btn primary" id="sh-dl" href="/api/plan/export" download>Save plan
        as a file</a></div>
      <div class="banner"><b>This file contains your real transactions and finances.</b>
        <span class="small">Share it only with people you trust, privately (AirDrop, Messages,
        email to them). Don't post it or put it in a public folder.</span></div>
    </div>
    <div class="panel form">
      <h3>Open a plan someone sent you</h3>
      <ul class="small" style="margin:0;padding-left:1.2em;display:grid;gap:4px">
        <li><b>Desktop app (Mac):</b> menu-bar icon \u203A <i>Open Plan File\u2026</i> and pick the
          <span class="mono">.zip</span>. You can keep both plans or replace yours (yours is kept
          as a backup folder). New users get the same choice on the first launch.</li>
        <li><b>Command line:</b> <span class="mono">financial_plan import "Household Budget
          2026-11-06.zip"</span></li>
        <li><b>By hand:</b> double-click the <span class="mono">.zip</span> in Finder. The folder
          it makes is a plan; open it with <i>Change Plan Folder\u2026</i>.</li>
      </ul>
      <p class="small muted">Only want to share a what-if? Use <i>Share</i> in the Scenarios bar
        instead: it sends just the numbers, not your data.</p>
    </div>`;
    const box = el.querySelector("#sh-state");
    const link = el.querySelector("#sh-dl");
    box.addEventListener("change", () => {
      link.href = box.checked ? "/api/plan/export" : "/api/plan/export?state=false";
    });
  }
  function renderCategories(el) {
    const cats = section("categories", []);
    const original = cats.map((c) => String(c.name));
    const row2 = (c, i) => `<tr data-row data-orig="${i}">
    <td><input data-k="name" value="${esc(c.name ?? "")}" style="width:150px"></td>
    <td><select data-k="kind">${KINDS2.map(([k, l]) => `<option value="${k}"${(c.kind ?? "spending") === k ? " selected" : ""}>${l}</option>`).join("")}</select></td>
    <td><input data-k="group" value="${esc(c.group ?? "Other")}" style="width:100px"></td>
    <td style="text-align:center"><input type="checkbox" data-k="flexible"${c.flexible ? " checked" : ""}></td>
    <td><input type="number" data-k="kids_gone_pct" value="${esc(c.kids_gone_pct ?? 0)}" style="width:64px"></td>
    <td><input type="number" data-k="retired_pct" value="${esc(c.retired_pct ?? 0)}" style="width:64px"></td>
    <td style="text-align:center"><input type="checkbox" data-k="default_on"${c.default_on ? " checked" : ""}></td>
    <td style="text-align:center"><input type="checkbox" data-k="in_retirement"${c.in_retirement ? " checked" : ""}></td>
    <td style="text-align:center"><input type="checkbox" data-k="tax"${c.tax ? " checked" : ""}></td>
    <td><input data-k="offsets" value="${esc(c.offsets ?? "")}" list="cat-names" style="width:130px"></td>
    <td><input data-k="label" value="${esc(c.label ?? "")}" style="width:160px"></td>
    <td><input data-k="note" value="${esc(c.note ?? "")}" style="width:140px"></td>
    <td style="white-space:nowrap"><button class="btn sm" type="button" data-up aria-label="Move up">\u2191</button>
      <button class="btn sm danger" type="button" data-del>Remove</button></td></tr>`;
    el.innerHTML = `<div class="panel" style="display:grid;gap:10px">
      <div class="sec-head"><h3>Categories</h3><span class="small muted">Saved in ${esc(fileOf("categories"))}. Renaming a category also updates the rules that use it.</span></div>
      <p class="small muted"><b>Kind:</b> regular spending is averaged in Spending and Budgeting. Annual
        expenses (taxes, insurance), 1-time purchases and emergency fund costs each get an on/off
        toggle in their own planner box; emergency fund costs are paid from the emergency fund.
        Credits (money in) can be subtracted; ignore is for transfers, card payments and
        paychecks. <b>Kids gone / retired</b> are % changes used by Spending over time. <b>On by
        default</b> and <b>in retirement</b> apply to those costs and to credits; <b>tax</b> puts
        an annual expense or purchase in the tax set-aside. <b>Offsets</b>: for a credit, the
        category it reduces.</p>
      <div class="ptable-scroll"><table class="dtable edit" id="cat-table"><thead><tr>
        <th>Name</th><th>Kind</th><th>Group</th><th>Flexible</th><th>Kids gone %</th><th>Retired %</th>
        <th>On by default</th><th>In retirement</th><th>Tax</th><th>Offsets</th><th>Toggle label</th>
        <th>Note</th><th></th></tr></thead><tbody>${cats.map(row2).join("")}</tbody></table></div>
      ${catNamesDatalist()}
      <div class="btns"><button class="btn sm add" type="button" id="cat-add">+ Add category</button>
        <button class="btn primary" type="button" id="cat-save">Save categories</button></div>
      <p class="msg" id="cat-msg"></p></div>`;
    const body = el.querySelector("#cat-table tbody");
    body.addEventListener("click", (e) => {
      const t = e.target;
      const tr = t.closest("tr");
      if (t.matches("[data-del]")) tr.remove();
      if (t.matches("[data-up]") && tr.previousElementSibling) {
        tr.parentElement.insertBefore(tr, tr.previousElementSibling);
      }
    });
    el.querySelector("#cat-add").addEventListener("click", () => {
      body.insertAdjacentHTML("beforeend", row2({ name: "", group: "Other" }, -1));
      body.lastElementChild.querySelector("input").focus();
    });
    el.querySelector("#cat-save").addEventListener("click", async () => {
      const msg = el.querySelector("#cat-msg");
      const renames = /* @__PURE__ */ new Map();
      const next = [...body.querySelectorAll("tr[data-row]")].map((tr) => {
        const f = readFields(tr);
        const orig = +tr.dataset.orig;
        if (orig >= 0 && original[orig] !== f.name) renames.set(original[orig], String(f.name));
        const out = { name: f.name };
        if (f.kind !== "spending") out.kind = f.kind;
        if (f.group && f.group !== "Other") out.group = f.group;
        ["flexible", "default_on", "in_retirement", "tax"].forEach((k) => {
          if (f[k]) out[k] = true;
        });
        ["kids_gone_pct", "retired_pct"].forEach((k) => {
          if (f[k]) out[k] = f[k];
        });
        ["offsets", "label", "note"].forEach((k) => {
          if (f[k]) out[k] = f[k];
        });
        return out;
      }).filter((c) => c.name);
      next.forEach((c) => {
        if (c.offsets && renames.has(String(c.offsets))) c.offsets = renames.get(String(c.offsets));
      });
      try {
        await save2("categories", next);
        if (renames.size) await applyRenames(renames);
        renderTab();
        report(document.getElementById("cat-msg"), void 0, renames.size ? `Saved. Updated rules for ${renames.size} renamed categor${renames.size === 1 ? "y" : "ies"}.` : "Saved.");
      } catch (err) {
        report(msg, err);
      }
    });
  }
  async function applyRenames(renames) {
    const rename = (v) => renames.get(String(v)) ?? v;
    const rules = section("rules", []);
    if (rules.some((r) => renames.has(String(r.category)))) {
      await save2("rules", rules.map((r) => ({ ...r, category: rename(r.category) })));
    }
    const sources = section("sources", []);
    if (sources.some((s) => Object.values(s.category_map ?? {}).some((v) => renames.has(String(v))))) {
      await save2("sources", sources.map((s) => s.category_map ? { ...s, category_map: Object.fromEntries(Object.entries(s.category_map).map(([k, v]) => [k, rename(v)])) } : s));
    }
    for (const key of ["default_category", "default_credit_category"]) {
      if (renames.has(String(cfg.raw[key]))) await save2(key, rename(cfg.raw[key]));
    }
  }

  // src/ui/theme.ts
  var KEY = "fp-theme";
  function buildTheme() {
    const group = document.getElementById("theme");
    if (!group) return;
    const buttons = [...group.querySelectorAll("button")];
    const mark = (t) => buttons.forEach((b) => b.setAttribute(
      "aria-pressed",
      String(b.dataset.v === t)
    ));
    mark(saved());
    buttons.forEach((b) => b.addEventListener("click", () => {
      const t = b.dataset.v;
      apply2(t);
      try {
        if (t === "auto") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, t);
      } catch {
      }
      mark(t);
    }));
  }
  function saved() {
    try {
      const t = localStorage.getItem(KEY);
      return t === "light" || t === "dark" ? t : "auto";
    } catch {
      return "auto";
    }
  }
  function apply2(t) {
    const root = document.documentElement;
    if (t === "auto") {
      delete root.dataset.theme;
      root.style.colorScheme = "";
    } else {
      root.dataset.theme = t;
      root.style.colorScheme = t;
    }
  }

  // src/main.ts
  var ready = false;
  function route() {
    const hash = location.hash;
    const settings = hash.startsWith("#settings");
    const help = hash === "#help";
    if (!settings && !help && settingsDirty()) {
      sessionStorage.setItem("fp-hash", hash);
      location.reload();
      return;
    }
    $("app-main").hidden = settings || help || !ready;
    $("help").hidden = !help;
    $("settings").hidden = !settings;
    $("gear").classList.toggle("on", settings);
    document.querySelectorAll("nav.tabs a").forEach((a) => {
      a.classList.toggle("on", help && a.getAttribute("href") === "#help");
    });
    if (settings) {
      showSettings(hash.split("/")[1]);
      window.scrollTo(0, 0);
    }
    if (help) window.scrollTo(0, 0);
  }
  function banner(html, err = false) {
    $("banners").insertAdjacentHTML(
      "beforeend",
      `<div class="banner${err ? " err" : ""}">${html}</div>`
    );
  }
  async function start() {
    buildHelp();
    buildTheme();
    window.addEventListener("hashchange", route);
    let p;
    try {
      p = await load();
    } catch (err) {
      banner(`<b>Couldn't reach the planner.</b> ${esc(err.message)}`, true);
      return;
    }
    if (p.error) {
      banner(`<b>The plan's config needs fixing.</b><span class="mono" style="white-space:pre-wrap">${esc(p.error)}</span><a href="#settings">Open Settings</a>`, true);
      if (!location.hash.startsWith("#settings")) location.hash = "#settings";
      route();
      return;
    }
    setCurrency(p.plan.currency_symbol);
    document.title = p.plan.title;
    $("title").textContent = p.plan.title;
    $("subtitle").textContent = p.plan.subtitle || describeData(p);
    const months = p.month_labels;
    $("eyebrow").textContent = months.length ? `${p.plan.title} \xB7 ${months[0]} \u2013 ${months[months.length - 1]} data` : p.plan.title;
    p.warnings.forEach((w) => banner(esc(w)));
    if (!p.counts.transactions) {
      banner(`<b>No transactions yet.</b> Add your bank and card CSV exports under
      <a href="#settings/sources">Settings \u203A Data sources</a>, and your household under
      <a href="#settings/household">Settings \u203A Household</a>.`);
    }
    if (!app.d.partners.length) {
      banner('<b>No partners yet.</b> Add at least one under <a href="#settings/household">Settings \u203A Household</a> to see income and retirement.');
    }
    await loadPresets();
    buildSpending();
    buildPlanner();
    buildCollege();
    buildRetire();
    buildFuture();
    await buildBudgets();
    buildStrip();
    ready = true;
    const back = sessionStorage.getItem("fp-hash");
    sessionStorage.removeItem("fp-hash");
    if (back !== null && location.hash !== back) location.hash = back;
    route();
    const y = sessionStorage.getItem("fp-scroll");
    sessionStorage.removeItem("fp-scroll");
    if (y) window.scrollTo(0, +y);
  }
  start();
})();
