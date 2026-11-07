"""
CLI Tests

Commands, plan-folder selection, the launcher and state storage.

License: BSD 3-Clause
"""
#
# Imports
#
import plistlib
from pathlib import Path

import pytest

from financial_planner.cli import init_plan, main, suggest_source
from financial_planner.config import ConfigError, load_config
from financial_planner.launcher import (choose_plan_dir, create_mac_app, create_shortcut,
                                        remember_plan, remembered_plan)
from financial_planner.sources import inspect_csv
from financial_planner.state import read_state, write_state_key


#
# PUBLIC
#
def test_init_blank_and_demo(tmp_path: Path) -> None:
    blank = init_plan(tmp_path / 'blank')
    assert load_config(blank).config.household.partners[0].name == 'Partner A'
    assert (blank / 'data').is_dir()
    demo = init_plan(tmp_path / 'demo', demo=True)
    assert len(list((demo / 'data').glob('*.csv'))) == 2
    with pytest.raises(ConfigError, match='already'):
        init_plan(blank)


def test_validate_and_categorize_commands(demo_dir: Path,
                                          capsys: pytest.CaptureFixture[str]) -> None:
    assert main(['validate', str(demo_dir)]) == 0
    assert 'config ok' in capsys.readouterr().out
    assert main(['categorize', str(demo_dir), '--unmatched']) == 0
    out = capsys.readouterr().out
    assert 'Groceries' in out and 'matched no rule' in out


def test_bad_config_exits_nonzero(plan_dir: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (plan_dir / 'config' / 'config.yaml').write_text('plan: {months: -1}\n')
    assert main(['validate', str(plan_dir)]) == 1
    assert 'plan.months' in capsys.readouterr().err


def test_inspect_csv_command(plan_dir: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(['inspect-csv', str(plan_dir / 'data' / 'card.csv'), '--name', 'Visa']) == 0
    out = capsys.readouterr().out
    assert 'name: Visa' in out and 'debit: Debit' in out


def test_suggest_source_signed_column(plan_dir: Path) -> None:
    info = inspect_csv(plan_dir / 'data' / 'bank_2025.csv')
    src = suggest_source(info, 'Bank', 'data/bank_2025.csv')
    assert src['amount'] == {'column': 'Amount', 'outflow': 'negative'}
    assert src['date'] == {'column': 'Date', 'format': '%m/%d/%Y'}


def test_export_and_import_commands(demo_dir: Path, tmp_path: Path,
                                    capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / 'shared.zip'
    assert main(['export', str(demo_dir), '-o', str(out)]) == 0
    assert 'real financial data' in capsys.readouterr().out
    assert main(['import', str(out), str(tmp_path / 'theirs')]) == 0
    assert load_config(tmp_path / 'theirs').config.plan.title == 'Household Budget'
    assert main(['import', str(out), str(tmp_path / 'theirs')]) == 1
    assert 'already a plan' in capsys.readouterr().err


def test_choose_plan_dir_order(tmp_path: Path, plan_dir: Path) -> None:
    settings = tmp_path / 'settings.json'
    assert choose_plan_dir(str(plan_dir), settings_file=settings) == (plan_dir, False)
    assert choose_plan_dir(None, cwd=plan_dir, settings_file=settings) == (plan_dir, False)
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    remember_plan(plan_dir, settings)
    assert remembered_plan(settings) == plan_dir.resolve()
    assert choose_plan_dir(None, cwd=elsewhere, settings_file=settings)[0] == plan_dir.resolve()
    assert choose_plan_dir(str(tmp_path / 'new'), settings_file=settings)[1] is True


@pytest.mark.parametrize('platform, name', [('linux', 'financial-planner.desktop'),
                                            ('win32', 'Financial Planner.bat')])
def test_create_shortcut(tmp_path: Path, platform: str, name: str) -> None:
    path = create_shortcut(tmp_path, tmp_path / 'plan', platform=platform)
    assert path.name == name
    text = path.read_text()
    assert 'financial_planner start' in text and str(tmp_path / 'plan') in text


def test_create_mac_app(tmp_path: Path) -> None:
    app = create_mac_app(tmp_path, python='/opt/py/bin/python')
    assert app.name == 'Financial Planner.app'
    info = plistlib.loads((app / 'Contents' / 'Info.plist').read_bytes())
    assert info['CFBundleExecutable'] == 'launch' and info['CFBundleIconFile'] == 'AppIcon'
    launch = app / 'Contents' / 'MacOS' / 'launch'
    assert 'financial_planner.desktop' in launch.read_text() and launch.stat().st_mode & 0o111
    assert (app / 'Contents' / 'Resources' / 'AppIcon.icns').exists()
    assert create_mac_app(tmp_path).exists()      # rebuilding replaces the old bundle


def test_state_round_trip(tmp_path: Path) -> None:
    assert read_state(tmp_path) == {}
    write_state_key(tmp_path, 'scenarios', {'list': [1]})
    write_state_key(tmp_path, 'ui', {'x': 2})
    write_state_key(tmp_path, 'ui', None)
    assert read_state(tmp_path) == {'scenarios': {'list': [1]}}
    with pytest.raises(ValueError):
        write_state_key(tmp_path, 'other', 1)


def test_uninstall_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                           capsys: pytest.CaptureFixture[str]) -> None:
    from financial_planner import desktop
    home = tmp_path / 'home'
    support = home / 'Library' / 'Application Support' / 'FinancialPlanner'
    (support / 'env').mkdir(parents=True)
    (home / 'FinancialPlan' / 'config').mkdir(parents=True)
    settings = home / '.financial_planner.json'
    settings.write_text('{}')
    app = create_mac_app(home / 'Applications')
    monkeypatch.setattr(desktop.Path, 'home', staticmethod(lambda: home))
    monkeypatch.setattr(desktop, 'APP_SUPPORT', support)
    monkeypatch.setattr(desktop, 'SERVER_FILE', support / 'server.json')
    monkeypatch.setattr(desktop, 'SETTINGS_FILE', settings)
    monkeypatch.setattr('builtins.input', lambda prompt: 'n')
    assert main(['uninstall']) == 0 and app.exists()            # declined: nothing removed
    assert main(['uninstall', '--yes']) == 0
    assert not app.exists() and not support.exists() and not settings.exists()
    assert (home / 'FinancialPlan' / 'config').is_dir()
    assert 'nothing to remove' in (main(['uninstall', '--yes']) == 0 and
                                   capsys.readouterr().out)
