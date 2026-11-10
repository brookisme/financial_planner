/**
 * @fileoverview The in-app Help page.
 *
 * License: BSD 3-Clause
 */

//
// CONSTANTS
//
const TOPICS: Array<[string, string]> = [['h-start', 'Quick start'], ['h-setup', 'Setting up'],
  ['h-strip', 'Summary rows'], ['h-explore', 'Spending'], ['h-planner', 'Budgeting'],
  ['h-cat', 'Categorizing'], ['h-college', 'College 529s'], ['h-retire', 'Retirement'],
  ['h-future', 'Spending over time'], ['h-scen', 'Sharing'], ['h-privacy', 'Privacy'],
  ['h-faq', 'Questions']];
const BODY = `
<h3 id="h-start">Quick start</h3>
<ol>
  <li><b>Look at your spending.</b> <i>Spending</i> shows what your transactions say: each
    category's monthly average, lowest and highest month, and every transaction behind it.</li>
  <li><b>Make a budget.</b> In <i>Budgeting</i> every category starts at its average. Type a new
    number to try a change. Changed boxes turn blue.</li>
  <li><b>Save it.</b> Name it in the Budgets bar and click <i>Save as new</i>. Pick any saved
    budget (or the 12-mo avg) in the Compare column to see the difference line by line.</li>
  <li><b>Check yourself against it.</b> At the top, compare the Actuals (the period on the
    Spending chart) with a budget, or attach a budget to the Spending chart.</li>
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

<h3 id="h-strip">Summary rows</h3>
<ul>
  <li>The first row is always the <b>Actuals</b> for the period selected on the Spending chart
    (change the period or drag across months and it follows): income, spending, savings,
    annual expenses and what's left over. Its spending counts every credit (money that really came
    in), ticked or not. On its right, <i>Compare with</i> a budget (or the
    12-mo avg) to see whether you were over (red) or under (green) it.</li>
  <li><b>+ Show a budget</b> adds a row for any saved budget, or your current edits. Budget rows are
    dashed and say <i>planned</i>; × hides one.</li>
</ul>

<h3 id="h-explore">Spending</h3>
<ul>
  <li><b>Periods</b>: <i>All data</i> (drag across months to select some), <i>Typical year</i>
    (each calendar month's average, with its lowest and highest year), <i>Year</i> (drag sideways
    or use ‹ › to move it back) and <i>Selected</i>. The table, transactions and top merchants
    follow the period shown.</li>
  <li><b>Click a month</b> to see it day by day; <i>← Back to months</i> returns.</li>
  <li><b>Attach a budget</b> (top right of the chart) to draw its line, see how far over or under
    it the period was, and add a <i>vs budget</i> column to the table. It compares regular spending
    plus annual costs: budgets have no 1-time or emergency lines.</li>
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
  <tr><td>Budgets bar</td><td><i>12-mo avg</i> is always first. Save the current budget under a
    name, click one to load it (blue is the one showing; a <b>•</b> means unsaved changes), update
    or delete it. A budget holds only Budgeting: categories, income, savings, annual expenses and
    emergency costs. The same buttons are at the top of College 529s and Retirement: switching
    anywhere switches everywhere.</td></tr>
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
  <li><b>Annual expenses</b>: add as many as you like (+ Add, a name and a yearly amount; × to
    remove). Their total ÷ 12 counts each month.</li>
  <li><b>Emergency fund costs</b>: what you expect to take out of the emergency fund each month.
    Empty means the same as what goes in, so the fund holds steady; more makes it shrink, less
    makes it grow. With no emergency fund it counts as spending.</li>
  <li><i>Fill from Spending</i> sets Planned / mo to the averages of the period shown in Spending.
    <i>Try 10% less on flexible spending</i> trims the categories marked flexible.</li>
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
  fine-tune. The monthly contribution comes from Budgeting › Savings. Each card shows how much of
  college is covered, the surplus or shortfall (also in today's dollars) and the monthly amount
  that would fully fund it.</p>
<p><b>Presets</b>: click one to set both sliders. <i>Edit presets</i> lets you change any label,
  return or inflation, add or remove presets (the starting ones too) or keep none. The list is
  shared by every card and saved with the plan.</p>

<h3 id="h-retire">Retirement</h3>
<ul>
  <li><b>The sliders</b>: the big one is the first partner's retirement age (the chart and table
    follow it). While <i>lock: retire the same year</i> is ticked, moving either slider moves both;
    untick it to set each partner's own age.</li>
  <li><b>Put in by retirement</b> and <b>estimated total at retirement</b>: what goes into the
    retirement accounts, stocks, bonds and savings account, and what it grows to.</li>
  <li><b>Income</b>: pensions, retirement accounts, investments, the savings account and Social
    Security, before and after the retirement tax rate. Each account has its own <i>yearly
    withdrawal</i> %. Social Security that starts later is drawn as a dashed outline.</li>
  <li><b>The cards on the right</b> fold with ▾ / ▸; <i>Collapse Settings</i> in the Budget bar folds
    them all, so a change in a lower card shows in the chart without scrolling. Assumptions has
    editable return / inflation presets, like the 529 cards.</li>
  <li><b>Comparison</b> is against <i>projected</i> retirement spending (children gone,
    retirement changes, health insurance), not today's spending.</li>
  <li>All figures are in today's dollars.</li>
</ul>

<h3 id="h-future">Spending over time</h3>
<p>Money in and out for each year, with markers when each child finishes high school and when you
  retire. Each category has an editable % for "kids gone" and "retired".</p>

<h3 id="h-scen">Sharing</h3>
<p>To give someone <b>everything</b> (settings, data, budgets), use Settings › <i>Share plan</i>
  › <i>Save plan as a file</i>. They open it from the Mac app's menu-bar icon › <i>Open Plan
  File…</i>. That file contains your real transactions: share it privately.</p>

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

//
// PUBLIC
//

/** Renders the help page into #help. */
export function buildHelp(): void {
  const root = document.getElementById('help')!;
  root.innerHTML = `<div class="sec-head"><h2 id="help-title">Help</h2><a class="btn"
      href="#budget" style="text-decoration:none">Back to the budget</a></div>
    <nav class="help-toc panel" aria-label="Help topics"><span class="eyebrow">Topics</span>
      <div class="chips">${TOPICS.map(([id, l]) => `<button class="chip" type="button"
        data-go="${id}">${l}</button>`).join('')}</div></nav>
    <article class="panel help-body">${BODY}</article>`;
  root.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => {
    b.addEventListener('click', () => document.getElementById(b.dataset.go!)?.scrollIntoView());
  });
}
