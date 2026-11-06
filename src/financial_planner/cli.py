"""
CLI

The ``financial_plan`` command:

- ``init [dir] [--demo]``: create a plan folder (blank or a copy of the demo).
- ``start [dir]``: run the app at http://127.0.0.1:8765 and open the browser.
- ``validate [dir]``: check the config and CSVs and print a summary.
- ``inspect-csv FILE``: show a CSV's columns and a suggested ``sources`` entry.
- ``categorize [dir]``: print per-category averages; ``--unmatched`` lists rows no rule caught.
- ``launcher``: put a double-click "Financial Planner" shortcut on the desktop.

License: BSD 3-Clause
"""
#
# Imports
#
import argparse
import shutil
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any, Optional

from financial_planner.config import ConfigError, dump_yaml
from financial_planner.launcher import (choose_plan_dir, create_shortcut, is_plan_dir,
                                        remember_plan)
from financial_planner.sources import SourceError, inspect_csv
from financial_planner.summary import category_report, load_plan, transaction_rows

#
# CONSTANTS
#
PACKAGE_DIR: Path = Path(__file__).parent
TEMPLATE_DIR: Path = PACKAGE_DIR / 'templates' / 'new_plan'
DEMO_DIRS: tuple[Path, ...] = (PACKAGE_DIR / 'templates' / 'demo',
                              PACKAGE_DIR.parents[1] / 'examples' / 'demo')
DEFAULT_PORT: int = 8765


#
# PUBLIC
#
def main(argv: Optional[list[str]] = None) -> int:
    """Run the command line.

    Args:
        argv: Arguments (defaults to ``sys.argv[1:]``).

    Returns:
        A process exit code.
    """
    parser = _parser()
    args = parser.parse_args(argv)
    if not getattr(args, 'func', None):
        parser.print_help()
        return 1
    try:
        return args.func(args)
    except (ConfigError, SourceError) as err:
        print(f'error: {err}', file=sys.stderr)
        return 1


def init_plan(plan_dir: Path, demo: bool = False) -> Path:
    """Create a plan folder from the starter template or the demo.

    Args:
        plan_dir: Folder to create (may exist but must not already be a plan).
        demo: Copy the fictional demo plan instead of the blank template.

    Returns:
        The plan folder.

    Raises:
        ConfigError: If the folder is already a plan.
    """
    plan_dir = Path(plan_dir).expanduser()
    if is_plan_dir(plan_dir):
        raise ConfigError(f'{plan_dir} already has a config folder')
    source = next((d for d in DEMO_DIRS if d.is_dir()), DEMO_DIRS[0]) if demo else TEMPLATE_DIR
    if not source.is_dir():
        raise ConfigError(f'missing {"demo" if demo else "template"} files at {source}')
    shutil.copytree(source, plan_dir, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('.financial_planner', '.gitkeep'))
    (plan_dir / 'data').mkdir(exist_ok=True)
    return plan_dir


def suggest_source(info: dict[str, Any], name: str, file: str) -> dict[str, Any]:
    """Build a ``sources`` entry from :func:`inspect_csv` guesses.

    Args:
        info: Output of ``inspect_csv``.
        name: Source name.
        file: File path relative to the plan folder.

    Returns:
        A source mapping ready to paste into ``sources.yaml``.
    """
    g = info['guess']
    source: dict[str, Any] = {'name': name, 'files': file,
                              'date': {'column': g.get('date', 'Date')},
                              'description': g.get('description', 'Description')}
    if g.get('date_format'):
        source['date']['format'] = g['date_format']
    if g.get('debit') or g.get('credit'):
        source['amount'] = {k: g[k] for k in ('debit', 'credit') if g.get(k)}
    else:
        source['amount'] = {'column': g.get('amount', 'Amount'),
                            'outflow': g.get('outflow', 'negative')}
    if g.get('category'):
        source['category_column'] = g['category']
    return source


#
# INTERNAL
#
def _parser() -> argparse.ArgumentParser:
    """Build the argument parser."""
    parser = argparse.ArgumentParser(
        prog='financial_plan',
        description='A local, private household budget and planner. Your data never leaves '
                    'this computer.')
    sub = parser.add_subparsers(title='commands')

    p = sub.add_parser('init', help='create a plan folder')
    p.add_argument('plan_dir', nargs='?', default='.', help='folder to create (default: here)')
    p.add_argument('--demo', action='store_true', help='copy the fictional demo plan')
    p.set_defaults(func=_cmd_init)

    p = sub.add_parser('start', help='open the app in your browser')
    p.add_argument('plan_dir', nargs='?', help='plan folder (default: here, the last one used, '
                                               'or ~/FinancialPlan)')
    p.add_argument('--port', type=int, default=DEFAULT_PORT, help='port (default: 8765)')
    p.add_argument('--no-browser', action='store_true', help="don't open a browser")
    p.set_defaults(func=_cmd_start)

    p = sub.add_parser('validate', help='check the config and CSVs')
    p.add_argument('plan_dir', nargs='?', default='.', help='plan folder (default: here)')
    p.set_defaults(func=_cmd_validate)

    p = sub.add_parser('inspect-csv', help="show a CSV's columns and a suggested source entry")
    p.add_argument('file', help='the CSV file')
    p.add_argument('--name', default='My account', help='name for the suggested source')
    p.add_argument('--skip-rows', type=int, default=0, help='lines before the header row')
    p.add_argument('--delimiter', default=',', help='field separator (default: ,)')
    p.set_defaults(func=_cmd_inspect)

    p = sub.add_parser('categorize', help='print per-category monthly averages')
    p.add_argument('plan_dir', nargs='?', default='.', help='plan folder (default: here)')
    p.add_argument('--unmatched', action='store_true',
                   help='list transactions no rule matched (they fell to a default)')
    p.set_defaults(func=_cmd_categorize)

    p = sub.add_parser('launcher', help='create a desktop shortcut that starts the app')
    p.add_argument('--plan-dir', help='always open this plan (default: the last one used)')
    p.add_argument('--desktop', help='folder for the shortcut (default: ~/Desktop)')
    p.set_defaults(func=_cmd_launcher)
    return parser


def _cmd_init(args: argparse.Namespace) -> int:
    """``init``: create a plan folder."""
    path = init_plan(Path(args.plan_dir), demo=args.demo)
    print(f'created a plan in {path.resolve()}\n'
          f'  next: put your CSV exports in {path / "data"} and run '
          f'"financial_plan start {args.plan_dir}"')
    return 0


def _cmd_start(args: argparse.Namespace) -> int:
    """``start``: serve the app."""
    import uvicorn

    from financial_planner.server import create_app
    plan_dir, needs_init = choose_plan_dir(args.plan_dir)
    if needs_init:
        init_plan(plan_dir)
        print(f'created a new plan in {plan_dir}')
    plan_dir = plan_dir.resolve()
    remember_plan(plan_dir)
    url = f'http://127.0.0.1:{args.port}/'
    print(f'Financial Planner: {plan_dir}\n  open {url}  (Ctrl+C to stop)')
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(create_app(plan_dir), host='127.0.0.1', port=args.port, log_level='warning')
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    """``validate``: load everything and report."""
    data = load_plan(Path(args.plan_dir))
    cfg = data.config
    print(f'config ok: {len(cfg.household.partners)} partner(s), '
          f'{len(cfg.household.children)} child(ren), {len(cfg.sources)} source(s), '
          f'{len(cfg.categories)} categories, {len(cfg.rules)} rules')
    print(f'transactions: {len(data.transactions)}; window {data.months[0]} to {data.months[-1]}; '
          f'today {data.today}')
    for warning in data.warnings:
        print(f'warning: {warning}')
    return 1 if data.warnings and not data.transactions else 0


def _cmd_inspect(args: argparse.Namespace) -> int:
    """``inspect-csv``: describe a CSV and suggest a source."""
    path = Path(args.file)
    info = inspect_csv(path, delimiter=args.delimiter, skip_rows=args.skip_rows)
    print(f'{path.name}: {info["rows"]} rows\ncolumns: {", ".join(info["columns"])}\n')
    for row in info['sample']:
        print('  ' + ' | '.join(row.values()))
    rel = f'data/{path.name}'
    print('\nsuggested entry for config/sources.yaml (check it):\n')
    print(dump_yaml({'sources': [suggest_source(info, args.name, rel)]}))
    return 0


def _cmd_categorize(args: argparse.Namespace) -> int:
    """``categorize``: per-category report."""
    data = load_plan(Path(args.plan_dir))
    print(f'{"category":28s} {"kind":9s} {"avg/mo":>10s} {"low":>10s} {"high":>10s}')
    for r in category_report(data):
        print(f'{r["name"]:28s} {r["kind"]:9s} {r["avg"]:10,.2f} {r["low"]:10,.2f} '
              f'{r["high"]:10,.2f}')
    if args.unmatched:
        rows = [r for r in transaction_rows(data) if r['how'] == 'default']
        print(f'\n{len(rows)} transaction(s) matched no rule:')
        for r in rows:
            print(f'  {r["date"]}  {r["amount"]:10,.2f}  {r["source"]:16s} {r["description"]}')
    return 0


def _cmd_launcher(args: argparse.Namespace) -> int:
    """``launcher``: write a desktop shortcut."""
    path = create_shortcut(Path(args.desktop) if args.desktop else None,
                           Path(args.plan_dir) if args.plan_dir else None)
    print(f'created {path}\n  double-click it to start the Financial Planner')
    return 0


if __name__ == '__main__':
    sys.exit(main())
