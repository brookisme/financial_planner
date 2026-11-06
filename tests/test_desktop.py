"""
Desktop Tests

The desktop app's non-GUI logic: ports, single instance, first-run choices and the server
lifecycle (a real server process against a copy of the demo plan).

License: BSD 3-Clause
"""
#
# Imports
#
import socket
from pathlib import Path

import pytest

from financial_planner import desktop


#
# PUBLIC
#
@pytest.fixture(autouse=True)
def app_support(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep the app's files and the remembered plan inside the test folder.

    HOME is redirected too: the server processes these tests start remember their plan in
    ~/.financial_planner.json, which must never be the real one.
    """
    monkeypatch.setenv('HOME', str(tmp_path / 'home'))
    support = tmp_path / 'support'
    monkeypatch.setattr(desktop, 'APP_SUPPORT', support)
    monkeypatch.setattr(desktop, 'SERVER_FILE', support / 'server.json')
    monkeypatch.setattr(desktop, 'LOG_FILE', support / 'desktop.log')
    monkeypatch.setattr(desktop, 'SERVER_LOG', support / 'server.log')
    monkeypatch.setattr(desktop, 'remember_plan', lambda path: None)
    monkeypatch.setattr(desktop, 'open_browser', lambda port: None)
    return support


def test_free_port_skips_a_busy_port() -> None:
    with socket.socket() as busy:
        busy.bind(('127.0.0.1', 0))
        busy.listen()
        taken = busy.getsockname()[1]
        assert desktop.free_port(taken) != taken
    assert desktop.free_port(taken) == taken


def test_no_running_server_without_a_live_record(app_support: Path) -> None:
    assert desktop.running_server() is None
    app_support.mkdir()
    desktop.write_server_file(999999, 1, Path('/x'))           # no such process
    assert desktop.running_server() is None


@pytest.mark.parametrize('button, expect, demo', [
    ('Use ~/FinancialPlan', 'default', False), ('Try the Demo', 'demo', True),
    ('Choose Folder…', 'chosen', False), (None, None, False)])
def test_first_run_choices(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                           button: str | None, expect: str | None, demo: bool) -> None:
    folders = {'default': tmp_path / 'FinancialPlan', 'demo': tmp_path / 'Demo',
               'chosen': tmp_path / 'Chosen'}
    monkeypatch.setattr(desktop, 'DEFAULT_PLAN_DIR', folders['default'])
    monkeypatch.setattr(desktop, 'DEMO_DIR', folders['demo'])
    monkeypatch.setattr(desktop, 'ask_buttons', lambda *a, **k: button)
    monkeypatch.setattr(desktop, 'choose_folder', lambda prompt: folders['chosen'])
    made: list[tuple[Path, bool]] = []
    monkeypatch.setattr(desktop, 'init_plan', lambda p, demo=False: made.append((p, demo)))
    result = desktop.first_run()
    assert result == (folders[expect] if expect else None)
    assert made == ([(folders[expect], demo)] if expect else [])


def test_server_lifecycle_and_single_instance(demo_dir: Path, app_support: Path) -> None:
    app = desktop.App(demo_dir)
    app.start()
    try:
        assert desktop.server_answers(app.port)
        assert desktop.running_server() == app.port      # a second launch would reuse it
    finally:
        app.stop()
    assert not desktop.server_answers(app.port)
    assert desktop.running_server() is None
    app.stop()                                           # stopping twice is harmless


def test_server_exits_when_the_app_dies(demo_dir: Path) -> None:
    import os
    import subprocess
    import sys
    import time
    parent = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    port = desktop.free_port(8790)
    server = subprocess.Popen([sys.executable, '-m', 'financial_planner', 'start', str(demo_dir),
                               '--no-browser', '--port', str(port), '--parent-pid',
                               str(parent.pid)], env={**os.environ})
    try:
        assert desktop.wait_for_server(port, 30)
        parent.kill()
        parent.wait()
        server.wait(timeout=10)                  # watchdog notices within ~2 s
        assert not desktop.server_answers(port)
    finally:
        for proc in (parent, server):
            if proc.poll() is None:
                proc.kill()
