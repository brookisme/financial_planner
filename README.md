<sub>🤖 <b>Built with Claude.</b> This project was developed heavily with <a href="https://www.anthropic.com/claude">Claude</a> (Anthropic's AI assistant) using Claude Code.</sub>

# Financial Planner

A private, local household budget and long-term planner. Point it at the CSV exports from your bank
and credit cards, describe your household (in the app or in YAML), and explore your monthly budget,
college savings, retirement and how spending changes over time.

**Full documentation: [the wiki](https://github.com/brookisme/financial_planner/wiki).**

<p align="center"><img src="assets/app-overview.png" height="350" alt="The Financial Planner app, showing the monthly planner and the retirement section with fictional demo data"></p>

## Contents

- [Features](#features)
- [Privacy first](#privacy-first)
- [Quick start](#quick-start)
- [Your own plan](#your-own-plan)
- [Commands](#commands)
- [Development](#development)
- [License](#license)

## Features

- **Monthly planner**: every category at its average; change any number and see what's left over.
- **Explore spending**: monthly charts, top merchants and every transaction.
- **College 529s**: a projection for each child against the cost of college.
- **Retirement**: income at each retirement age from pensions, accounts, investments and Social Security.
- **Spending over time**: how costs change as children leave home and after retiring.
- **Scenarios**: save, compare and share what-ifs.
- **Settings and categorizing in the app**: no YAML editing required (but it's there if you want it).

## Privacy first

Everything runs on your computer and nothing is uploaded. Your plan folder holds real financial
data: **keep it out of public repositories and off the internet**, and use generic names (Partner A,
Child 1). See [Privacy and Safety](https://github.com/brookisme/financial_planner/wiki/Privacy-and-Safety).

## Quick start

Install [pixi](https://pixi.sh), then:

```bash
git clone https://github.com/brookisme/financial_planner.git
cd financial_planner
pixi run demo
```

Your browser opens at http://127.0.0.1:8765 with a fictional demo household.

## Your own plan

```bash
pixi run financial_plan init ~/MyFinancialPlan    # create a plan folder
pixi run financial_plan start ~/MyFinancialPlan   # open it
```

Put your bank and card CSV exports in `~/MyFinancialPlan/data/`, then click the **gear (Settings)**
at the top right to add your household, connect the CSVs and categorize. Prefer a double-click icon?
Run `pixi run financial_plan launcher`.

Step-by-step guide: [Quick Start](https://github.com/brookisme/financial_planner/wiki/Quick-Start).
Want an AI assistant to set it up with you? See [LLM_SETUP.md](LLM_SETUP.md).

## Commands

| Command | What it does |
|---|---|
| `financial_plan init [dir] [--demo]` | Create a plan folder (blank, or a copy of the demo). |
| `financial_plan start [dir]` | Open the app. |
| `financial_plan validate [dir]` | Check the config and CSVs. |
| `financial_plan inspect-csv FILE` | Show a CSV's columns and a suggested source entry. |
| `financial_plan categorize [dir] [--unmatched]` | Category averages; rows no rule caught. |
| `financial_plan launcher` | Put a "Financial Planner" shortcut on the desktop. |

Details: [Command Line](https://github.com/brookisme/financial_planner/wiki/Command-Line).

## Development

```bash
pixi run -e dev test-all     # Python + forecast-math tests
pixi run -e dev web-build    # rebuild the web app
```

See [Development](https://github.com/brookisme/financial_planner/wiki/Development).

## License

BSD 3-Clause. Not financial advice: projections are rough and depend on the assumptions you enter.
