# Setting up a plan with an AI assistant

These are instructions for an AI coding assistant (one that can read files and run commands) to set
up a Financial Planner plan with a person. To use them, open a terminal in your plan folder, start
your assistant, and say:

> Read `<path to financial_planner>/LLM_SETUP.md` and help me set up my financial plan in this
> folder.

**Before you start:** the assistant will read your bank exports and what you tell it. Only use an
assistant and account you trust with financial data, and review what it writes.

---

## Instructions for the assistant

You are helping a person build a plan for the Financial Planner app. Follow these steps in order.
Ask one small group of questions at a time, explain briefly why you're asking, accept "skip" or "I
don't know" (use the defaults), and confirm before writing files.

### 0. Privacy rules (always)

- Use generic names in the config: "Partner A", "Partner B", "Child 1". If the person gives real
  names, suggest generic ones and use those unless they insist.
- Never write birthdates (ages only), account numbers, addresses, employer names or Social Security
  numbers into the config. Generic labels like "Employer A pension" are fine.
- Keep the plan folder outside any public repository. If the folder is inside a git repository,
  warn the person and suggest adding `data/` and `.financial_planner/` to `.gitignore` (or not
  committing the plan at all).
- Don't upload, paste or send the person's data anywhere other than the files in the plan folder.
- If CSV descriptions contain card or account numbers, point that out.

### 1. Create the plan folder

If `config/` doesn't exist in the working folder, run:

```bash
financial_plan init .
```

(or `pixi run financial_plan init .` / `python -m financial_planner init .`, whichever works). This
writes `config/config.yaml`, `sources.yaml`, `categories.yaml` and `rules.yaml` with comments.
Every field is documented in the wiki's Config Reference
(https://github.com/brookisme/financial_planner/wiki/Config-Reference); the other wiki pages
(Data Sources, Categories, Categorizing and Rules) explain each part in detail.

### 2. Household (`config/config.yaml` › `household`)

Ask, for each adult (one or more):
- age; take-home (net) pay per month and where it came from (pay stub, average of recent months);
- expected yearly raise above inflation (default 0);
- Social Security estimate at 67 (from their statement; a rough guess is fine) and when they plan
  to claim (default: when retiring);
- pensions: name, monthly estimates by retirement age if they have them (e.g. from a pension
  estimate tool), years of service so far;
- retirement accounts (401k, 403b, IRA): name, balance, monthly contribution.

The first partner is the "primary": the main retirement-age slider is their age. Ask what age
each partner is thinking of retiring at: the first partner's goes in
`assumptions.retirement.default_age`, and another partner who retires in a different year gets
their own `retirement_age` (leave it out to retire in the same year as the first).

For each child: age, 529 balance and monthly contribution, the kind of college to plan for
(`public`, `flagship`, `private`, or custom schools under `assumptions.college.schools`), and the
graduation month if they know it.

### 3. Savings, investments, assumptions

- Other monthly income.
- `savings`: a savings account (`type: savings`) and an emergency fund (`type: emergency`), each
  with `balance`, an optional `max_balance` (past it, contributions go to the `overflow_to`
  investment, by default the first one) and `return_pct` (interest).
- `investments`: stocks (`type: stocks`) and bonds (`type: bonds`), each with `balance` and a
  return % (0 leaves it off).
- Retirement accounts (under each partner): `pre_tax: true` (the default; a 401k / 403b out of
  pay: a fixed `monthly` doesn't reduce the left-over) or `pre_tax: false` (a Roth IRA from
  take-home), plus `employer_monthly` for a match.
- Every 529, retirement account, savings account and investment contributes either a fixed `monthly` amount or
  `left_pct`, a percent of what is left over each month after spending, annual expenses and the
  fixed amounts, with optional `min_monthly` / `max_monthly`, or `rest: true` (an even share of
  whatever is left after the fixed and % contributions). Ask which the person prefers for each.
- `properties` (optional): a home, car or rental with `value`; a home's `change_pct` (yearly,
  e.g. 3); a `loan` with `balance`, `rate_pct`, `payment_monthly` and the spending `category` the
  payment lands in (e.g. Housing); a car's `life_years`, `age_years`, `end_value` and `replace_cost`;
  a rental's `rent_monthly` after its costs. Ask before adding any.
- Children's names are optional; empty names become "Child 1", "Child 2", ...
- Retirement assumptions: health insurance cost after retiring, tax rate in retirement (10-15% is a
  common rough figure). Keep the default return / inflation unless they have a view.

### 4. Data sources (`config/sources.yaml`)

1. List the CSVs in `data/`. If there are none, ask the person to export 12 months of transactions
   from each bank and card website as CSV and save them in `data/`.
2. For each distinct export layout run `financial_plan inspect-csv data/<file>.csv --name "<label>"`.
   It prints the columns, sample rows and a suggested source entry.
3. Check the suggestion against the sample: the date column, the description column(s), and the
   amount sign. Internally money out must be positive. For one signed column, set
   `outflow: negative` if purchases are negative in the file, `positive` if purchases are positive.
   For separate columns use `amount: {debit: <out column>, credit: <in column>}`.
4. Use a glob in `files` (e.g. `data/visa*.csv`) so future exports are picked up.
5. Run `financial_plan validate .` and fix any problems it reports.

### 5. Categories and rules (`categories.yaml`, `rules.yaml`)

1. Start from the starter categories. Ask whether to add or rename any (e.g. Coffee, Pets,
   Childcare). Mark transfers, card payments, paychecks and savings/529 transfers as
   `kind: ignore`; yearly bills (income or property tax, a yearly insurance premium) as
   `kind: annual`; big one-off purchases (furniture) as `kind: one_time`; unplanned costs that
   should come out of the emergency fund (car or home repairs, vet emergencies) as
   `kind: emergency`;
   money coming in that offsets spending (reimbursements, refunds) as `kind: credit`.
2. Run `financial_plan categorize . --unmatched` to see what no rule catches.
3. Propose rules in small batches, grouped by merchant: prefer `contains` on a distinctive word,
   `matches` for several merchants (`'COFFEE|CAFE'`), `similar_to` for merchants with changing
   store numbers, `field: category` + `equals` to reuse the bank's own category, and filters
   (`direction`, `min_amount`) when a word is ambiguous. Show the person the batch, then write it.
   Put specific rules above general ones (first match wins).
4. Ask about anything you can't tell (Venmo, checks, cash, ambiguous merchants). Don't guess
   silently.
5. Repeat until the unmatched list is short and the averages from `financial_plan categorize .`
   look right to the person.

### 5b. Amazon (optional, but worth offering)

Banks show Amazon as one opaque charge per shipment, so it usually lands in one big
"Shopping" lump. Amazon's own data export lists every item, so the plan can split it out.

1. Ask whether they shop on Amazon much. If so, ask each person with an Amazon login to request
   their data at amazon.com › Account › "Request your data" (choose "Your Orders"; it arrives by
   email as a .zip within a few days) and unzip each export into its own folder under
   `data/amazon/` (e.g. `data/amazon/partner_a/`). In the app, Settings › Data sources ›
   "+ Add Amazon export" does this from the .zip and keeps only the CSV files.
2. Run `financial_plan amazon .`. It prints totals per card over the dates the bank files cover,
   and the `sources`, `categories` and `rules` entries to add.
3. Use the per-card totals to pick the cards whose statements are in the plan (cards get
   reissued with new numbers, so several endings can belong to one account; match the dates).
4. Add the printed entries, with `cards: [...]` on the Amazon source (`kind: amazon`, `files:
   data/amazon`). The rules set the bank's own Amazon rows aside in an `ignore` category so
   nothing is counted twice; Prime membership and AWS stay on the bank side. Put them above any
   other rule that mentions Amazon.
5. Add rules for the items with `source: Amazon`: product-name rules first (`matches:
   'vitamin|supplement'`), then Amazon's department (`field: category`, e.g. `equals: Grocery`),
   then one catch-all (`field: source, equals: Amazon`) last.
6. Run `financial_plan amazon .` again. With the setup in place it prints bank vs itemized totals
   per month. Monthly differences of a few percent are normal (Amazon dates are ship dates,
   gift-card balances); the yearly total should be within a few percent. A big gap usually means a
   missing or extra card in `cards`.
7. A new export just replaces the old one in its folder; nothing else needs rerunning.

### 6. Finish

1. Run `financial_plan validate .` once more.
2. Start the app with `financial_plan start .` and suggest they look at the planner strip, then
   Settings › Categorize to fix any remaining rows by clicking them.
3. Offer `financial_plan launcher` to put a double-click shortcut on their desktop.
4. Remind them: the plan folder holds private data; keep it off the internet and out of public
   repositories.
