"""
Launcher

The no-code path: remembers which plan folder to open and creates a desktop shortcut that starts
the app with a double click (``.command`` on macOS, ``.desktop`` on Linux, ``.bat`` on Windows).

License: BSD 3-Clause
"""
#
# Imports
#
import json
import os
import shlex
import stat
import sys
from pathlib import Path
from typing import Optional

#
# CONSTANTS
#
SETTINGS_FILE: Path = Path.home() / '.financial_planner.json'
DEFAULT_PLAN_DIR: Path = Path.home() / 'FinancialPlan'
SHORTCUT_NAME: str = 'Financial Planner'


#
# PUBLIC
#
def remembered_plan(settings_file: Path = SETTINGS_FILE) -> Optional[Path]:
    """The plan folder opened last, if it still exists.

    Args:
        settings_file: Where the setting is kept.

    Returns:
        The folder, or None.
    """
    try:
        value = json.loads(settings_file.read_text(encoding='utf-8')).get('plan_dir')
    except (OSError, ValueError, AttributeError):
        return None
    path = Path(value) if value else None
    return path if path and path.is_dir() else None


def remember_plan(plan_dir: Path, settings_file: Path = SETTINGS_FILE) -> None:
    """Remember a plan folder for the next start without arguments.

    Args:
        plan_dir: The folder.
        settings_file: Where the setting is kept.
    """
    try:
        data = json.loads(settings_file.read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data['plan_dir'] = str(Path(plan_dir).resolve())
    try:
        settings_file.write_text(json.dumps(data, indent=1), encoding='utf-8')
    except OSError:
        pass


def create_shortcut(desktop: Optional[Path] = None, plan_dir: Optional[Path] = None,
                    platform: str = sys.platform) -> Path:
    """Write a double-clickable launcher.

    Args:
        desktop: Folder to put it in (defaults to ~/Desktop).
        plan_dir: Plan to open. Empty means "the remembered plan, or ~/FinancialPlan".
        platform: ``sys.platform`` style name (for tests).

    Returns:
        The launcher file.
    """
    desktop = desktop or Path.home() / 'Desktop'
    desktop.mkdir(parents=True, exist_ok=True)
    python = sys.executable
    target = [str(Path(plan_dir).resolve())] if plan_dir else []
    if platform.startswith('win'):
        path = desktop / f'{SHORTCUT_NAME}.bat'
        args = ' '.join(f'"{a}"' for a in target)
        path.write_text(f'@echo off\r\n"{python}" -m financial_planner start {args}\r\n'
                        'pause\r\n', encoding='utf-8')
        return path
    cmd = ' '.join(shlex.quote(a) for a in [python, '-m', 'financial_planner', 'start', *target])
    if platform == 'darwin':
        path = desktop / f'{SHORTCUT_NAME}.command'
        path.write_text(f'#!/bin/bash\n# Starts the Financial Planner. Close this window to stop '
                        f'it.\n{cmd}\n', encoding='utf-8')
    else:
        path = desktop / 'financial-planner.desktop'
        path.write_text(f'[Desktop Entry]\nType=Application\nName={SHORTCUT_NAME}\n'
                        f'Exec={cmd}\nTerminal=true\n', encoding='utf-8')
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def is_plan_dir(path: Path) -> bool:
    """Whether a folder looks like a plan (has a config folder)."""
    return (Path(path) / 'config').is_dir()


def choose_plan_dir(arg: Optional[str], cwd: Optional[Path] = None,
                    settings_file: Path = SETTINGS_FILE) -> tuple[Path, bool]:
    """Decide which plan folder ``start`` should open.

    Order: the argument, the current folder if it is a plan, the remembered plan, then the
    default folder (~/FinancialPlan).

    Args:
        arg: Folder given on the command line.
        cwd: Current folder.
        settings_file: Where the remembered plan is kept.

    Returns:
        The folder and whether it still needs ``init``.
    """
    if arg:
        path = Path(arg).expanduser()
        return path, not is_plan_dir(path)
    cwd = Path(cwd or os.getcwd())
    if is_plan_dir(cwd):
        return cwd, False
    last = remembered_plan(settings_file)
    if last and is_plan_dir(last):
        return last, False
    return DEFAULT_PLAN_DIR, not is_plan_dir(DEFAULT_PLAN_DIR)
