"""
CLI

The ``financial_plan`` command:

- ``init [dir] [--demo]``: create a plan folder (blank or a copy of the demo).
- ``start [dir]``: run the app at http://127.0.0.1:8765 and open the browser.
- ``validate [dir]``: check the config and CSVs and print a summary.
- ``inspect-csv FILE``: show a CSV's columns and a suggested ``sources`` entry.
- ``categorize [dir]``: print per-category averages; ``--unmatched`` lists rows no rule caught.
- ``amazon [dir]``: check an Amazon data export against the bank's Amazon charges, or print the
  source, category and rules that add it.
- ``export [dir]`` / ``import FILE [dir]``: pack a whole plan into one .zip / unpack one.
- ``uninstall``: remove the desktop app and its downloaded files (never plans).
- ``launcher``: make a double-click launcher (macOS: ``Financial Planner.app`` in /Applications).

License: BSD 3-Clause
"""
#
# Imports
#
import argparse
import os
import shutil
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any, Optional

from financial_planner import amazon
from financial_planner.config import ConfigError, dump_yaml
from financial_planner.launcher import (choose_plan_dir, create_shortcut, is_plan_dir,
                                        remember_plan)
from financial_planner.share import ShareError, archive_name, export_plan, import_plan
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
PARENT_CHECK_S: float = 2.0


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
    except (ConfigError, SourceError, ShareError) as err:
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
    p.add_argument('--parent-pid', type=int, help=argparse.SUPPRESS)   # used by the desktop app
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

    p = sub.add_parser('amazon', help='check an Amazon data export against the bank\'s Amazon '
                                      'charges (or show how to add it)')
    p.add_argument('plan_dir', nargs='?', default='.', help='plan folder (default: here)')
    p.add_argument('--exports', nargs='+', help='Amazon export folder(s), or a folder holding '
                                                'several (default: the plan\'s Amazon source, '
                                                f'else {amazon.EXPORT_DIR})')
    p.add_argument('--cards', help='comma-separated card endings whose statements are in the '
                                   'plan, e.g. 1234,5678 (default: the Amazon source\'s cards)')
    p.add_argument('--csv', help='also write the items to this CSV, to look through')
    p.set_defaults(func=_cmd_amazon)

    p = sub.add_parser('export', help='pack the whole plan into one .zip to share')
    p.add_argument('plan_dir', nargs='?', default='.', help='plan folder (default: here)')
    p.add_argument('-o', '--output', help='zip file to write (default: "<title> <date>.zip")')
    p.add_argument('--no-state', action='store_true',
                   help='leave out planner edits and saved scenarios')
    p.set_defaults(func=_cmd_export)

    p = sub.add_parser('import', help='unpack a shared plan .zip into a folder')
    p.add_argument('file', help='the .zip file')
    p.add_argument('plan_dir', nargs='?', help='folder to create (default: ~/FinancialPlan, or '
                                               '"~/FinancialPlan 2" if that exists)')
    p.add_argument('--replace', action='store_true',
                   help='replace an existing plan there (it is kept as a backup folder)')
    p.set_defaults(func=_cmd_import)

    p = sub.add_parser('uninstall', help='remove the desktop app and its files (plans are kept)')
    p.add_argument('--yes', action='store_true', help="don't ask for confirmation")
    p.set_defaults(func=_cmd_uninstall)

    p = sub.add_parser('launcher', help='create a double-click launcher (macOS: an app in '
                                        '/Applications)')
    p.add_argument('--plan-dir', help='plan to open (default: the last one used, or ask)')
    p.add_argument('--desktop', help='folder for the launcher (default: /Applications on macOS, '
                                     '~/Desktop elsewhere)')
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
    if args.parent_pid:
        threading.Thread(target=_exit_with_parent, args=(args.parent_pid,), daemon=True).start()
    uvicorn.run(create_app(plan_dir), host='127.0.0.1', port=args.port, log_level='warning')
    return 0


def _exit_with_parent(pid: int, interval: float = PARENT_CHECK_S) -> None:
    """Stop this process once the desktop app that started it is gone."""
    while True:
        try:
            os.kill(pid, 0)
        except OSError:
            os._exit(0)
        time.sleep(interval)


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


def _cmd_amazon(args: argparse.Namespace) -> int:
    """``amazon``: card totals in an export, then bank vs itemized totals (or the setup to add)."""
    plan_dir = Path(args.plan_dir)
    data = load_plan(plan_dir)
    source = next((s for s in data.config.sources if s.kind == 'amazon'), None)
    name = source.name if source else amazon.SOURCE_NAME
    folders = args.exports or (source.files if source else [amazon.EXPORT_DIR])
    roots = [Path(f) if Path(f).is_absolute() else plan_dir / f for f in folders]
    cards = ([c.strip() for c in args.cards.split(',') if c.strip()] if args.cards else
             (source.cards if source else []))
    bank = [t for t in data.transactions if t.source != name]
    first = min((t.date for t in bank), default='')
    last = max((t.date for t in bank), default='')
    items, warnings = amazon.load_items(roots, cards=cards or None)
    items = [i for i in items if (not first or i.date >= first) and (not last or i.date <= last)]
    for warning in warnings:
        print(f'warning: {warning}')
    if not items:
        print('no Amazon items found')
        return 1
    print(f'{len(items)} Amazon item(s) and refunds, {first or "start"} to {last or "end"} '
          '(the dates the bank files cover)\n')
    print(f'{"card":16s} {"purchases":>11s} {"refunds":>10s} {"rows":>6s}  dates')
    for r in amazon.card_summary(items):
        print(f'{r["card"]:16s} {r["purchases"]:11,.2f} {r["refunds"]:10,.2f} {r["rows"]:6d}  '
              f'{r["first"]} to {r["last"]}')
    if not cards:
        print('\nkeep only the cards whose statements are in the plan with --cards 1234,5678 '
              '("unknown" rows, mostly digital orders, are always kept)')
    if args.csv:
        print(f'\nwrote {amazon.write_items(items, Path(args.csv))}')
    if not source or amazon.BANK_CATEGORY not in {r.category for r in data.config.rules}:
        others = [s.name for s in data.config.sources if s.kind == 'csv']
        folder = str(Path(folders[0])) if args.exports else amazon.EXPORT_DIR
        print('\nto use it, add to config/ (or use Settings › Data sources › + Add Amazon '
              'export):\n')
        print(dump_yaml({'sources': [amazon.source_entry(folder, name, cards or None)]}))
        print(dump_yaml({'categories': [{'name': amazon.BANK_CATEGORY, 'kind': 'ignore'}]}))
        print('# above any other rule that mentions Amazon:')
        print(dump_yaml({'rules': amazon.bank_rules(others)}))
        return 0
    rows = amazon.compare(data.transactions, data.assignments, data.months, source=name)
    print(f'\nbank Amazon charges vs itemized, net of refunds ({data.months[0]} to '
          f'{data.months[-1]}):\n')
    print(f'{"month":8s} {"bank":>11s} {"itemized":>11s} {"diff":>10s}')
    for r in rows:
        print(f'{r["month"]:8s} {r["bank"]:11,.2f} {r["items"]:11,.2f} {r["diff"]:10,.2f}')
    total = rows[-1]
    if total['bank']:
        print(f'\nitemized is {100 * total["diff"] / total["bank"]:+.1f}% of the bank total '
              '(months differ a little: Amazon dates are ship dates, banks post later)')
    return 0


def _cmd_export(args: argparse.Namespace) -> int:
    """``export``: write the plan as one zip."""
    plan_dir = Path(args.plan_dir)
    title = load_plan_title(plan_dir)
    out = Path(args.output) if args.output else Path(archive_name(title))
    files = export_plan(plan_dir, out, include_state=not args.no_state, top=out.stem)
    print(f'wrote {out} ({len(files)} files)\n  it contains your real financial data: share it '
          'privately (AirDrop, Messages), not publicly')
    return 0


def _cmd_import(args: argparse.Namespace) -> int:
    """``import``: unpack a shared plan."""
    from financial_planner.launcher import DEFAULT_PLAN_DIR
    from financial_planner.share import unique_path
    dest = Path(args.plan_dir).expanduser() if args.plan_dir else (
        DEFAULT_PLAN_DIR if args.replace else unique_path(DEFAULT_PLAN_DIR))
    path = import_plan(Path(args.file), dest, replace=args.replace)
    print(f'imported the plan into {path}\n  open it with "financial_plan start {path}"')
    return 0


def load_plan_title(plan_dir: Path) -> str:
    """The plan's title from its config (or a generic one)."""
    from financial_planner.config import load_config_raw
    plan = load_config_raw(plan_dir).raw.get('plan') or {}
    return str(plan.get('title') or 'Financial Plan')


def _cmd_uninstall(args: argparse.Namespace) -> int:
    """``uninstall``: remove the desktop app, its support folder and the remembered plan."""
    from financial_planner import desktop
    from financial_planner.launcher import SHORTCUT_NAME, remembered_plan
    if desktop.running_server():
        print('error: Financial Planner is running; quit it first (menu-bar icon › Quit)',
              file=sys.stderr)
        return 1
    bundles = [p for p in (Path('/Applications') / f'{SHORTCUT_NAME}.app',
                           Path.home() / 'Applications' / f'{SHORTCUT_NAME}.app') if p.exists()]
    targets = bundles + [t for t in desktop.uninstall_targets(None) if t.exists()]
    plan = remembered_plan()
    if not targets:
        print('nothing to remove: the desktop app is not installed')
    else:
        print('this removes:\n' + '\n'.join(f'  {t}' for t in targets))
        if plan:
            print(f'your plans are kept (the last one used is {plan})')
        if not args.yes and input('remove them? [y/N] ').strip().lower() not in ('y', 'yes'):
            print('nothing removed')
            return 0
        for target in targets:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink(missing_ok=True)
        print('removed')
    print('to remove the Python package too: pip uninstall financial-planner '
          '(or remove it from your pixi project)')
    return 0


def _cmd_launcher(args: argparse.Namespace) -> int:
    """``launcher``: write a desktop shortcut."""
    path = create_shortcut(Path(args.desktop) if args.desktop else None,
                           Path(args.plan_dir) if args.plan_dir else None)
    hint = ('open it from Applications or Spotlight; it adds a menu-bar icon'
            if path.suffix == '.app' else 'double-click it to start the Financial Planner')
    print(f'created {path}\n  {hint}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
