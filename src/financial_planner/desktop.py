"""
Desktop

The desktop app: a menu-bar (macOS) / system-tray icon that owns the planner's local server.

- First launch asks where to keep the plan (the default ~/FinancialPlan, a folder you choose,
  or the fictional demo) and remembers it.
- Starts the server for that plan and opens the browser.
- Menu: Open Financial Planner, Change Plan Folder…, New Plan…, Show Plan Folder, Check for
  Updates… (installed app only) and Quit (which stops the server).
- Single instance: launching again just opens the browser on the running app.

Native dialogs use AppleScript on macOS; elsewhere the app falls back to the defaults.

Run with ``python -m financial_planner.desktop`` (the macOS app bundle does this). The installed
app sets ``FP_PIXI`` and ``FP_MANIFEST`` so "Check for Updates…" can update its environment.

License: BSD 3-Clause
"""
#
# Imports
#
import atexit
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Optional

from financial_planner.cli import init_plan
from financial_planner.launcher import (DEFAULT_PLAN_DIR, is_plan_dir, remember_plan,
                                        remembered_plan)

#
# CONSTANTS
#
APP_TITLE: str = 'Financial Planner'
APP_SUPPORT: Path = Path(os.environ.get('FP_APP_SUPPORT') or
                         Path.home() / 'Library' / 'Application Support' / 'FinancialPlanner')
SERVER_FILE: Path = APP_SUPPORT / 'server.json'
LOG_FILE: Path = APP_SUPPORT / 'desktop.log'
SERVER_LOG: Path = APP_SUPPORT / 'server.log'
ASSETS: Path = Path(__file__).parent / 'assets'
DEFAULT_PORT: int = 8765
START_TIMEOUT_S: float = 30.0
DEMO_DIR: Path = Path.home() / 'FinancialPlan-Demo'


#
# PUBLIC
#
class App:
    """The running desktop app: one plan, one server process, one tray icon.

    Attributes:
        plan_dir: The plan being served.
        port: The server's port (once started).
    """

    def __init__(self, plan_dir: Path) -> None:
        self.plan_dir = Path(plan_dir).resolve()
        self.port = 0
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._icon: Any = None

    def run(self) -> None:
        """Start the server, open the browser and run the tray icon until Quit."""
        self.start()
        atexit.register(self.stop)
        open_browser(self.port)
        try:
            import pystray
        except ImportError:
            log('pystray not installed: running without a menu-bar icon (Ctrl+C to stop)')
            self._wait()
            return
        self._icon = pystray.Icon('financial-planner', _tray_image(), APP_TITLE,
                                  menu=self._menu(pystray))
        self._icon.run()

    def start(self) -> None:
        """Start the server for the current plan and wait until it answers."""
        self.port = free_port(DEFAULT_PORT)
        APP_SUPPORT.mkdir(parents=True, exist_ok=True)
        out = SERVER_LOG.open('ab')
        # --parent-pid: the server exits by itself if this app goes away (crash, force quit)
        cmd = [sys.executable, '-m', 'financial_planner', 'start', str(self.plan_dir),
               '--no-browser', '--port', str(self.port), '--parent-pid', str(os.getpid())]
        log(f'starting server: {" ".join(cmd)}')
        self._proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT)
        if not wait_for_server(self.port, START_TIMEOUT_S):
            alert(f"The planner didn't start. Details are in {SERVER_LOG}.")
            self.stop()
            raise SystemExit(1)
        write_server_file(os.getpid(), self.port, self.plan_dir)
        remember_plan(self.plan_dir)

    def stop(self) -> None:
        """Stop the server (safe to call more than once)."""
        proc, self._proc = self._proc, None
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        SERVER_FILE.unlink(missing_ok=True)

    def switch(self, plan_dir: Path) -> None:
        """Serve a different plan folder.

        Args:
            plan_dir: The new plan folder.
        """
        self.stop()
        self.plan_dir = Path(plan_dir).resolve()
        self.start()
        open_browser(self.port)
        if self._icon is not None:
            self._icon.update_menu()

    #
    # menu actions
    #
    def _open(self, *_: Any) -> None:
        """Open the app in the browser (restarting the server if it stopped)."""
        if self._proc is None or self._proc.poll() is not None:
            self.start()
        open_browser(self.port)

    def _change_folder(self, *_: Any) -> None:
        """Pick another plan folder (offering to create a plan there if it isn't one)."""
        folder = choose_folder('Choose your plan folder (the one with a "config" folder in it):')
        if not folder:
            return
        if not is_plan_dir(folder):
            if not confirm(f'"{folder.name}" is not a plan yet. Create a new plan there?',
                           'Create Plan'):
                return
            init_plan(folder)
        self.switch(folder)

    def _new_plan(self, *_: Any) -> None:
        """Create a new blank plan in a chosen folder and switch to it."""
        folder = choose_folder('Choose a folder for the new plan (an empty one is best):')
        if not folder:
            return
        if not is_plan_dir(folder):
            init_plan(folder)
        self.switch(folder)

    def _show_folder(self, *_: Any) -> None:
        """Reveal the plan folder in Finder / the file manager."""
        opener = 'open' if sys.platform == 'darwin' else 'xdg-open'
        subprocess.Popen([opener, str(self.plan_dir)])

    def _update(self, *_: Any) -> None:
        """Update the installed app's environment, then restart the server."""
        pixi, manifest = os.environ.get('FP_PIXI'), os.environ.get('FP_MANIFEST')
        if not (pixi and manifest):
            alert('Updates are only available in the installed app. With pixi, run '
                  '"git pull" in the financial_planner folder instead.')
            return
        if not confirm('Download and install the latest Financial Planner? The planner '
                       'restarts when it is done.', 'Update'):
            return
        notify('Updating Financial Planner…')
        self.stop()
        result = subprocess.run([pixi, 'update', '--manifest-path', manifest],
                                capture_output=True, text=True)
        log(f'pixi update: {result.returncode}\n{result.stdout}\n{result.stderr}')
        self.start()
        alert('Updated. Quit and reopen Financial Planner to finish.' if result.returncode == 0
              else f'The update failed. Details are in {LOG_FILE}.')

    def _quit(self, *_: Any) -> None:
        """Stop the server and the tray icon."""
        self.stop()
        if self._icon is not None:
            self._icon.stop()

    def _menu(self, tray: Any) -> Any:
        """Build the tray menu."""
        item, sep = tray.MenuItem, tray.Menu.SEPARATOR
        return tray.Menu(
            item('Open Financial Planner', self._open, default=True),
            sep,
            item(lambda _: f'Plan: {_short(self.plan_dir)}', None, enabled=False),
            item('Change Plan Folder…', self._change_folder),
            item('New Plan…', self._new_plan),
            item('Show Plan Folder', self._show_folder),
            sep,
            item('Check for Updates…', self._update),
            item('Quit Financial Planner', self._quit),
        )

    def _wait(self) -> None:
        """Without a tray icon: block until Ctrl+C or the server exits."""
        try:
            while self._proc and self._proc.poll() is None:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        self.stop()


def main() -> int:
    """Run the desktop app.

    Returns:
        A process exit code.
    """
    APP_SUPPORT.mkdir(parents=True, exist_ok=True)
    running = running_server()
    if running:
        log(f'already running on port {running}: opening the browser')
        open_browser(running)
        return 0
    plan = remembered_plan()
    if plan is None or not is_plan_dir(plan):
        plan = first_run()
        if plan is None:
            return 0
    try:
        App(plan).run()
    except SystemExit as err:
        return int(err.code or 0)
    return 0


def first_run() -> Optional[Path]:
    """Ask where to keep the plan and create it if needed.

    Returns:
        The plan folder, or None if the person cancelled.
    """
    choice = ask_buttons(
        'Welcome to Financial Planner.\n\nWhere should your plan live? It holds your settings '
        'and the bank / card CSV files you add, and stays on this computer.\n\nYou can change '
        'this later from the menu-bar icon.',
        ['Try the Demo', 'Choose Folder…', f'Use {_short(DEFAULT_PLAN_DIR)}'],
        default=f'Use {_short(DEFAULT_PLAN_DIR)}')
    if choice is None:
        return None
    if choice.startswith('Try'):
        folder = DEMO_DIR
        if not is_plan_dir(folder):
            init_plan(folder, demo=True)
        return folder
    if choice.startswith('Choose'):
        folder = choose_folder('Choose a folder for your plan (an empty one, or an existing '
                               'plan):')
        if folder is None:
            return None
    else:
        folder = DEFAULT_PLAN_DIR
    if not is_plan_dir(folder):
        init_plan(folder)
    return folder


def free_port(preferred: int) -> int:
    """The preferred port if it's free, otherwise any free port."""
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            return int(sock.getsockname()[1])
    raise OSError('no free port')


def wait_for_server(port: int, timeout: float) -> bool:
    """Poll the server until it answers or the timeout passes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_answers(port):
            return True
        time.sleep(0.25)
    return False


def server_answers(port: int) -> bool:
    """Whether a planner server answers on a port."""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=1) as res:
            return res.status == 200
    except OSError:
        return False


def running_server() -> Optional[int]:
    """The port of an already-running desktop app's server, if any."""
    try:
        info = json.loads(SERVER_FILE.read_text())
        pid, port = int(info['pid']), int(info['port'])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return port if server_answers(port) else None


def write_server_file(pid: int, port: int, plan_dir: Path) -> None:
    """Record the running app so a second launch can reuse it."""
    SERVER_FILE.write_text(json.dumps({'pid': pid, 'port': port, 'plan_dir': str(plan_dir)}))


def open_browser(port: int) -> None:
    """Open the app in the default browser."""
    webbrowser.open(f'http://127.0.0.1:{port}/')


def log(message: str) -> None:
    """Append to the desktop log."""
    try:
        APP_SUPPORT.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open('a', encoding='utf-8') as fh:
            fh.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {message}\n')
    except OSError:
        pass


#
# dialogs (AppleScript on macOS; defaults elsewhere)
#
def ask_buttons(text: str, buttons: list[str], default: str) -> Optional[str]:
    """A dialog with up to three buttons.

    Returns:
        The button clicked, ``default`` when no dialog is available, or None if cancelled.
    """
    if sys.platform != 'darwin':
        return default
    names = ', '.join(_q(b) for b in buttons)
    script = (f'button returned of (display dialog {_q(text)} buttons {{{names}}} '
              f'default button {_q(default)} with title {_q(APP_TITLE)} with icon {_icon_ref()})')
    return _osascript(script)


def choose_folder(prompt: str) -> Optional[Path]:
    """A native folder picker (it can also create a new folder).

    Returns:
        The folder, or None if cancelled or unavailable.
    """
    if sys.platform != 'darwin':
        return None
    out = _osascript(f'POSIX path of (choose folder with prompt {_q(prompt)})')
    return Path(out.rstrip('/')) if out else None


def confirm(text: str, ok: str) -> bool:
    """An OK / Cancel question."""
    return ask_buttons(text, ['Cancel', ok], default=ok) == ok


def alert(text: str) -> None:
    """A message with an OK button (logged everywhere)."""
    log(text)
    ask_buttons(text, ['OK'], default='OK')


def notify(text: str) -> None:
    """A passing notification."""
    log(text)
    if sys.platform == 'darwin':
        _osascript(f'display notification {_q(text)} with title {_q(APP_TITLE)}')


#
# INTERNAL
#
def _osascript(script: str) -> Optional[str]:
    """Run AppleScript; None when cancelled or failed."""
    result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def _q(text: str) -> str:
    """Quote a string for AppleScript."""
    return '"' + text.replace('\\', '\\\\').replace('"', '\\"') + '"'


def _icon_ref() -> str:
    """The app icon for dialogs (falls back to the standard note icon)."""
    icns = ASSETS / 'AppIcon.icns'
    return f'(POSIX file {_q(str(icns))})' if icns.exists() else 'note'


def _short(path: Path) -> str:
    """A path with the home folder shown as ~."""
    try:
        return '~/' + str(Path(path).resolve().relative_to(Path.home().resolve()))
    except ValueError:
        return str(path)


def _tray_image() -> Any:
    """The menu-bar icon image."""
    from PIL import Image
    return Image.open(ASSETS / 'tray.png')


if __name__ == '__main__':
    sys.exit(main())
