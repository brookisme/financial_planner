/**
 * @fileoverview The in-app Help page.
 *
 * License: BSD 3-Clause
 */

//
// CONSTANTS
//
const TOPICS: Array<[string, string]> = [['h-start', 'Quick start'], ['h-setup', 'Setting up'],
  ['h-scen', 'Scenarios & sharing'], ['h-planner', 'Monthly planner'],
  ['h-explore', 'Explore spending'], ['h-cat', 'Categorizing'], ['h-college', 'College 529s'],
  ['h-retire', 'Retirement'], ['h-future', 'Spending over time'], ['h-privacy', 'Privacy'],
  ['h-faq', 'Questions']];
const BODY = `
<h3 id="h-start">Quick start</h3>
<ol>
  <li><b>Read the strip at the top.</b> It's one month on paper: take-home income, minus spending,
    savings and taxes, equals what's left over.</li>
  <li><b>Try a change in the Monthly planner.</b> Every category starts at its average. Type a new
    number and the strip updates. Changed boxes turn blue.</li>
  <li><b>Save it as a scenario.</b> Name it in the Scenarios bar and click <i>Save as new</i>. Make
    another and use <i>Compare</i>.</li>
  <li><b>Look at the long view.</b> <i>Retirement</i> shows income at each retirement age.
    <i>Spending over time</i> shows how costs change as children leave home.</li>
  <li><b>Dig in.</b> <i>Explore spending</i> shows every transaction behind a category.</li>
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

<h3 id="h-scen">Scenarios &amp; sharing</h3>
<p>A scenario is a named snapshot of all settings: the planner, the 529 cards, Retirement and
  Spending over time.</p>
<table class="help-table">
  <tr><td>Save as new</td><td>Saves the current settings under the name you typed.</td></tr>
  <tr><td>Tabs</td><td>Click one to load it. A <b>•</b> means it has unsaved changes.</td></tr>
  <tr><td>Update / Delete</td><td>Save changes into, or remove, the scenario that's showing.</td></tr>
  <tr><td>Compare</td><td>One card each for the monthly budget, the 529s and retirement: what
    changed and its effect, green if better, red if worse. <i>Details</i> shows everything.</td></tr>
  <tr><td>Reset everything</td><td>Back to the starting values from the config. Saved scenarios
    are kept.</td></tr>
  <tr><td>Share</td><td>Copy a share code (or save a file) and send it; the other person pastes it
    under <i>Receive</i>. A scenario sent back after edits updates the original.</td></tr>
</table>
<p class="note">Share codes contain your planner amounts and retirement inputs (not
  transactions). Anyone with a code can read those numbers.</p>
<p>To give someone <b>everything</b> (settings, data, scenarios), use Settings › <i>Share plan</i>
  › <i>Save plan as a file</i>. They open it from the Mac app's menu-bar icon › <i>Open Plan
  File…</i>. That file contains your real transactions: share it privately.</p>

<h3 id="h-planner">Monthly planner</h3>
<ul>
  <li><b>Categories</b> start at their average, with the lowest and highest months beside them.</li>
  <li><b>Credits</b> (reimbursements, refunds) can sit under the category they offset, or below
    the total. Tick them to subtract them.</li>
  <li><b>Savings</b>: each 529, savings account, emergency fund and investment adds either a
    fixed <b>$/mo</b> or <b>% left</b>: a share of what is left each month after spending, taxes
    and the fixed amounts, kept between an optional min and max. A savings account with a max
    balance sends the rest to an investment once it's full; the note under it says when.</li>
  <li><b>Annual expenses</b> (taxes, insurance), <b>1-time purchases</b> and <b>emergency fund
    costs</b> are kept out of the averages. Tick one to count it. Emergency fund costs are paid
    from the emergency fund instead of the monthly budget; only what the fund can't cover comes
    out of the month.</li>
  <li><i>Try 10% less on flexible spending</i> trims the categories marked flexible.</li>
</ul>

<h3 id="h-explore">Explore spending</h3>
<ul>
  <li><b>Spending / Credits / Both</b> chooses what you're looking at.</li>
  <li>Click a category chip to focus on it, or a month to filter the transactions.</li>
  <li><b>Recategorize</b> (above the transactions) turns on editing: click a transaction to change
    its category or make a rule from it. It's off by default so nothing changes by accident.</li>
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

//
// PUBLIC
//

/** Renders the help page into #help. */
export function buildHelp(): void {
  const root = document.getElementById('help')!;
  root.innerHTML = `<div class="sec-head"><h2 id="help-title">Help</h2><a class="btn"
      href="#planner" style="text-decoration:none">Back to the budget</a></div>
    <nav class="help-toc panel" aria-label="Help topics"><span class="eyebrow">Topics</span>
      <div class="chips">${TOPICS.map(([id, l]) => `<button class="chip" type="button"
        data-go="${id}">${l}</button>`).join('')}</div></nav>
    <article class="panel help-body">${BODY}</article>`;
  root.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => {
    b.addEventListener('click', () => document.getElementById(b.dataset.go!)?.scrollIntoView());
  });
}
