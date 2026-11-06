# Financial Planner

A private, local household budget and long-term planner. Point it at the CSV exports from your bank
and credit cards, describe your household in a few YAML files (or with the in-app settings), and it
shows:

- **Monthly planner**: every spending category at its average, editable, with income, savings,
  taxes and what's left over.
- **Explore spending**: month-by-month charts, top merchants and every transaction, with an opt-in
  *Recategorize* mode.
- **College 529s**: a projection for each child against the cost of college.
- **Retirement**: income at each retirement age from pensions, retirement accounts, investments and
  Social Security, compared with projected spending.
- **Spending over time**: how costs change as children leave home and after retiring.
- **Scenarios**: save, compare (summary cards with details) and share named what-ifs.

Everything runs on your computer. Nothing is uploaded.

---

## ⚠️ Privacy and safety

This tool works with real financial data. Please read this before using it.

- **Keep your plan folder private.** It holds your transactions, balances and income. Don't put it
  in a public (or shared) git repository, a public cloud folder, or anywhere on the internet. This
  repository's `.gitignore` refuses `*.csv` files outside the demo for that reason; your own plan
  should live **outside** this repository.
- **Use generic names.** Prefer "Partner A", "Child 1" over real names. Leave out birthdates, account
  numbers, employer names and addresses. Ages and amounts are all the planner needs.
- **Check your CSVs.** Bank exports sometimes include account or card numbers in descriptions.
  Search for them (Settings › Categorize) and remove them from the files if you plan to share
  anything.
- **The app is local-only.** The server listens on `127.0.0.1` only and rejects requests for other
  host names; requests that change anything must carry an app-specific header so other websites
  can't write to your plan. Don't change the host to expose it on a network.
- **Share codes reveal numbers.** A scenario share code contains your planner amounts and retirement
  inputs (not transactions). Anyone with the code can read them.
- **Using an AI assistant to set up?** It will read your files. Only do that with an assistant and
  account you trust with financial data, and see [LLM_SETUP.md](LLM_SETUP.md).
- **Not financial advice.** Projections are rough and depend entirely on the assumptions you enter.

---

## Quick start

You need [pixi](https://pixi.sh) (it installs Python and everything else).

```bash
git clone <this repository> financial_planner
cd financial_planner
pixi run demo            # opens the fictional demo plan at http://127.0.0.1:8765
```

### Your own plan

Keep your plan in its own folder, outside this repository:

```bash
pixi run financial_plan init ~/MyFinancialPlan     # blank starter plan
pixi run financial_plan start ~/MyFinancialPlan    # open it
```

Then put your CSV exports in `~/MyFinancialPlan/data/` and use the gear icon (**Settings**, top
right) to describe your household, connect the CSVs and categorize.

To run it from inside the plan folder with its own pixi environment, create
`~/MyFinancialPlan/pixi.toml`:

```toml
[workspace]
name = "my-financial-plan"
channels = ["conda-forge"]
platforms = ["osx-arm64", "osx-64", "linux-64", "win-64"]

[dependencies]
python = ">=3.11,<3.14"

[pypi-dependencies]
financial-planner = { path = "/path/to/financial_planner", editable = true }
# or: financial-planner = { git = "<this repository's git url>" }
```

and then:

```bash
cd ~/MyFinancialPlan
pixi run financial_plan start
```

### Desktop shortcut (no command line after setup)

```bash
pixi run financial_plan launcher
```

puts a **Financial Planner** shortcut on the desktop (`.command` on macOS, `.desktop` on Linux,
`.bat` on Windows). Double-click it to start the app; it opens the plan you used last, or creates
`~/FinancialPlan` the first time. Close the terminal window it opens to stop the app.

---

## Commands

| Command | What it does |
|---|---|
| `financial_plan init [dir] [--demo]` | Create a plan folder (blank, or a copy of the demo). |
| `financial_plan start [dir] [--port 8765] [--no-browser]` | Run the app. Without `dir`: the current folder if it's a plan, else the last plan used, else `~/FinancialPlan`. |
| `financial_plan validate [dir]` | Check the config and CSVs and print a summary. |
| `financial_plan inspect-csv FILE [--name NAME]` | Show a CSV's columns and a suggested `sources` entry. |
| `financial_plan categorize [dir] [--unmatched]` | Per-category monthly averages; `--unmatched` lists rows no rule caught. |
| `financial_plan launcher [--plan-dir DIR]` | Create the desktop shortcut. |

---

## The plan folder

```
MyFinancialPlan/
  config/                 # YAML, merged by top-level key
    config.yaml           # plan, household, savings, investments, assumptions
    sources.yaml          # CSV sources and their column mappings
    categories.yaml       # categories
    rules.yaml            # categorization rules
  data/                   # your CSV exports
  .financial_planner/     # app state: planner edits and scenarios (state.json)
```

Every `*.yaml` file in `config/` is read and merged by top-level key, so you can keep everything in
one `config.yaml` or split it however you like (a section may only appear in one file). The settings
editor writes each section back to the file it came from and keeps your comments.

Edit the YAML by hand or in the app; after a hand edit just reload the page.

---

## Config reference

All amounts are monthly unless noted. Fields with defaults can be left out.

### `plan`

| Field | Default | Meaning |
|---|---|---|
| `title` | `Household Budget` | Page title. |
| `subtitle` | | Line under the title. |
| `months` | `12` | Average over the most recent N months of transactions. |
| `today` | month after the last transaction | The plan's "now" (`YYYY-MM`). |
| `currency_symbol` | `$` | |

### `household`

```yaml
household:
  partners:                    # one or more; the first is the "primary"
    - name: Partner A
      age: 46
      take_home_monthly: 7200
      take_home_note: pay stub   # optional label
      raise_pct: 0             # yearly raise above inflation
      social_security:
        at_67: 3100            # monthly benefit at 67, today's dollars
        claim_age: 67          # 62-70; leave out to claim when retiring (62 at the earliest)
      pensions:
        - name: Pension
          estimates: {55: 800, 60: 1900, 65: 3400}   # monthly by retirement age
          service_years_now: 9                       # optional: grow after the last age
          grows_with_raises: true
        # or a flat amount: - {name: Other pension, monthly: 600}
      accounts:
        - {name: 401(k), balance: 148000, monthly: 500}
  children:
    - name: Child 1
      age: 12
      hs_graduation: 2032-06   # optional; estimated from age otherwise
      college_529: {balance: 38500, monthly: 500}
      school: public           # key in assumptions.college.schools
```

The retirement slider is the first partner's age; everyone retires in the same calendar year.

### `other_income_monthly`, `savings`, `investments`

```yaml
other_income_monthly: 0
savings:
  - {name: Emergency savings, monthly: 500, stops_at_retirement: true}
investments:
  - {name: Brokerage, balance: 22000, return_pct: 0, monthly: 0}   # 0% = off until you set a rate
```

### `assumptions`

```yaml
assumptions:
  retirement:
    return_pct: 5.5
    inflation_pct: 3
    withdrawal_pct: 4
    tax_pct: 12                    # overall tax rate in retirement
    health_insurance_monthly: 1100 # after retiring
    default_age: 65
    presets:                       # optional; these are the defaults
      pessimistic: {name: Pessimistic, return_pct: 4.5, inflation_pct: 3.5}
      mid: {name: Mid, return_pct: 5.5, inflation_pct: 3}
      optimistic: {name: Optimistic, return_pct: 7, inflation_pct: 2.5}
  college:
    schools:                       # optional; yearly cost of attendance today
      public: {name: Public in-state, cost: 30000}
      flagship: {name: Flagship in-state, cost: 45000}
      private: {name: Private, cost: 65000}
    presets:                       # return / college-cost growth
      pessimistic: {name: Pessimistic, return_pct: 4, inflation_pct: 5}
      mid: {name: Mid, return_pct: 6, inflation_pct: 4}
      optimistic: {name: Optimistic, return_pct: 8, inflation_pct: 3}
    default_preset: mid
    graduation_age: 18
    years: 4
```

### `sources`

One entry per kind of CSV export. Nothing about a file's layout is assumed.

```yaml
sources:
  - name: Visa card
    files: data/visa*.csv                     # file names or globs, relative to the plan
    date: {column: Transaction Date}          # format detected; or format: '%m/%d/%Y'
    description: Description                  # or a list of columns, joined with a space
    amount: {debit: Debit, credit: Credit}    # separate money-out / money-in columns
    category_column: Category                 # optional: the bank's own category
    category_map: {Dining: Dining}            # optional: bank category -> plan category
  - name: Checking
    files: data/checking*.csv
    date: {column: Posting Date, format: '%m/%d/%Y'}
    description: [Description, Memo]
    amount: {column: Amount, outflow: negative}   # one signed column; withdrawals negative
    skip_rows: 0                              # lines before the header row
    delimiter: ','
    encoding: utf-8-sig
```

`financial_plan inspect-csv data/file.csv` (or Settings › Data sources › *Read columns*) suggests
an entry. Internally money out is positive and money in is negative.

### `categories`

```yaml
categories:
  - {name: Groceries, group: Essentials, kids_gone_pct: -35}
  - {name: Dining, group: Flexible, flexible: true, kids_gone_pct: -25}
  - {name: Travel, group: Flexible, flexible: true, retired_pct: 25}
  - {name: Shopping & Household, group: Flexible, flexible: true}
  - {name: Income tax, kind: one_time, tax: true, default_on: true, label: Set aside for income tax}
  - {name: Property tax, kind: one_time, tax: true, in_retirement: true}
  - {name: Reimbursements, kind: credit, default_on: true, offsets: Shopping & Household}
  - {name: Federal tax refund, kind: credit, default_on: true, offsets: Income tax}
  - {name: Other credits, kind: credit}
  - {name: Transfers & payments, kind: ignore}
```

| Field | Meaning |
|---|---|
| `kind` | `spending` (regular, averaged; default), `one_time` (kept out of averages, toggle in the planner), `credit` (money in that can be subtracted), `ignore` (transfers, card payments, paychecks, savings). |
| `group` | Planner heading (e.g. Essentials, Flexible). |
| `flexible` | Trimmed by "Try 10% less on flexible spending". |
| `kids_gone_pct` / `retired_pct` | % change once all children have left / after retiring (applied on top). |
| `default_on` | One-time / credit: counted by default. |
| `in_retirement` | One-time / credit: continues after retiring. |
| `tax` | One-time: belongs in the "Tax set-aside" figure. |
| `offsets` | Credit: the name of a listed category. Shown under a spending category (a reimbursement line), or nested under a one-time category it reduces (a refund under income tax). Without it, a credit sits below the planner total. |
| `label`, `note` | Text for the planner toggle. |

Categories used by rules but not listed are added automatically as regular spending.

### `rules`

```yaml
rules:
  - {category: Groceries, row: 3f2a91c0b7de}                 # this transaction is X
  - {category: Coffee, contains: BEAN THERE}                 # description contains (any case)
  - {category: Dining, field: category, equals: Dining}      # the bank's category equals
  - {category: Coffee, matches: 'COFFEE|CAFE|ESPRESSO'}      # regular expression
  - {category: Gifts, field: '*', contains: birthday}        # any field contains
  - {category: Pets, similar_to: "PAWS & CLAWS PET SUPPLY #12", threshold: 0.85}
  - {category: Furniture, contains: FURNITURE, min_amount: 500, direction: debit, source: Visa card}
```

- One condition per rule: `row`, `equals`, `contains`, `matches` or `similar_to`.
- `field`: `description` (default), `category` (the bank's), `source`, `date`, `amount`, any raw
  CSV column name, or `*` for any field.
- `similar_to` compares merchant names after dropping store numbers, codes and processor prefixes
  (`SQ *`, `TST*`…).
- Optional filters: `source`, `direction` (`debit` = money out, `credit` = money in),
  `min_amount`, `max_amount` (absolute amounts), `case_sensitive`.

**Precedence:** `row` rules always win; then the first matching rule from the top; then the
source's `category_map`; then `default_category` (money out, default `Other`) or
`default_credit_category` (money in, default `Other credits`).

The easiest way to build rules is Settings › Categorize: click a transaction and choose "just this
transaction", "contains", "any field contains", "matches" or "similar to"; the dialog previews how
many transactions the rule matches and changes before saving.

---

## How the numbers work

- **Averages** are the total over the window ÷ number of months. One-time categories are excluded
  from averages and appear as toggles.
- **Left over** = take-home − (regular spending − toggled credits + toggled one-time costs) −
  savings and investing − tax set-aside.
- **529s**: monthly compounding of the yearly return from today's balance plus contributions until
  high-school graduation; college cost = yearly cost × (1 + cost growth)^years, summed over the
  years of college; "today's dollars" deflates at the cost-growth rate; "monthly needed" solves the
  annuity for zero shortfall.
- **Retirement** (today's dollars): balances grow at the return rate (accounts with contributions
  until retirement), are deflated at inflation and multiplied by the withdrawal rate ÷ 12. Pensions
  interpolate the age estimates linearly (0 before the first age; flat, or grown by years of
  service, after the last) and scale with real raises. Social Security = amount at 67 × the
  claiming factor (62: 70% … 67: 100% … 70: 124%); it starts at the claim age or retirement,
  whichever is later.
- **Spending over time**: each category × (1 + share of children gone × kids-gone %) and, once
  retired, × (1 + retired %); 529 contributions stop at each graduation; savings, investing and
  credits/one-time costs not marked `in_retirement` stop at retirement; retiree health insurance
  is added. Income before retirement grows with each partner's real raise.

The math lives in `web/src/model.ts` and is covered by `web/test/model.test.ts`.

---

## Setting up with an AI assistant

[LLM_SETUP.md](LLM_SETUP.md) is a set of instructions an AI coding assistant can follow to interview
you, inspect your CSVs and write the YAML. Read the privacy notes first.

---

## Development

```bash
pixi run -e dev test         # Python tests
pixi run -e dev web-test     # forecast math tests (vitest)
pixi run -e dev web-build    # type-check and rebuild the web app into src/financial_planner/web
pixi run -e dev demo-data    # regenerate the fictional demo CSVs
pixi run -e dev test-all
```

Layout:

```
src/financial_planner/   python package: schema, config, sources, rules, summary, server, cli
src/financial_planner/web/   built web app (committed so users don't need Node)
web/src/                 TypeScript source (model.ts = all forecast math, ui/ = sections)
examples/demo/           fictional demo plan
tests/                   pytest
```

License: BSD 3-Clause.
