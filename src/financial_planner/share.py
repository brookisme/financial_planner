"""
Share

Packs a whole plan (config, CSV data and, optionally, the planner edits and scenarios) into one
``.zip`` file to send to someone, and unpacks such a file into a plan folder.

The archive holds one top folder named after the plan, so double-clicking it in Finder also gives
a working plan folder. Importing only ever writes ``config/``, ``data/`` and
``.financial_planner/state.json``, refuses unsafe paths, and never deletes a plan: replacing one
moves the old folder aside as a backup.

License: BSD 3-Clause
"""
#
# Imports
#
import io
import re
import shutil
import tempfile
import zipfile
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Optional, Union

from financial_planner.config import CONFIG_DIR, DATA_DIR
from financial_planner.state import STATE_DIR, STATE_FILE

#
# CONSTANTS
#
STATE_PATH: str = f'{STATE_DIR}/{STATE_FILE}'
ALLOWED_TOP: tuple[str, ...] = (CONFIG_DIR, DATA_DIR, STATE_DIR)
SKIP_NAMES: tuple[str, ...] = ('.DS_Store', 'Thumbs.db')
MAX_ARCHIVE_BYTES: int = 500 * 1024 * 1024


#
# PUBLIC
#
class ShareError(Exception):
    """A plan file could not be written or read."""


def archive_name(title: str, day: Optional[date] = None) -> str:
    """A friendly file name, e.g. ``Household Budget 2026-11-06.zip``.

    Args:
        title: The plan's title.
        day: Date for the name (default: today).

    Returns:
        The file name.
    """
    safe = re.sub(r'[^\w .()-]', '', title).strip() or 'Financial Plan'
    return f'{safe} {(day or date.today()).isoformat()}.zip'


def export_plan(plan_dir: Path, out: Union[Path, BinaryIO], include_state: bool = True,
                top: Optional[str] = None) -> list[str]:
    """Write a plan into a zip file.

    Args:
        plan_dir: The plan folder.
        out: A file path or a binary file object.
        include_state: Include planner edits and saved scenarios.
        top: Name of the top folder inside the archive (default: the plan folder's name).

    Returns:
        The paths written, relative to the plan folder.

    Raises:
        ShareError: If the folder isn't a plan.
    """
    plan_dir = Path(plan_dir)
    if not (plan_dir / CONFIG_DIR).is_dir():
        raise ShareError(f'{plan_dir} is not a plan (no config folder)')
    top = top or plan_dir.name or 'Financial Plan'
    files = _plan_files(plan_dir, include_state)
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in files:
            zf.write(plan_dir / rel, f'{top}/{rel}')
    return files


def export_bytes(plan_dir: Path, include_state: bool = True, top: Optional[str] = None) -> bytes:
    """Like :func:`export_plan`, returning the zip as bytes."""
    buf = io.BytesIO()
    export_plan(plan_dir, buf, include_state, top)
    return buf.getvalue()


def import_plan(archive: Path, dest: Path, replace: bool = False) -> Path:
    """Unpack a plan file into a folder.

    Args:
        archive: The ``.zip`` file.
        dest: Folder to create (or an empty folder, or an existing plan when ``replace``).
        replace: If ``dest`` is already a plan, move it aside as a backup and replace it.

    Returns:
        The plan folder.

    Raises:
        ShareError: If the file isn't a plan, has unsafe paths, or ``dest`` is in use.
    """
    archive, dest = Path(archive), Path(dest).expanduser()
    members = read_members(archive)
    if dest.exists() and any(p.name not in SKIP_NAMES for p in dest.iterdir()):
        if not (dest / CONFIG_DIR).is_dir():
            raise ShareError(f'{dest} already has files in it; choose an empty folder')
        if not replace:
            raise ShareError(f'{dest} is already a plan')
    dest.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.import-', dir=dest.parent))
    try:
        with zipfile.ZipFile(archive) as zf:
            for name, rel in members:
                target = staging / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(name) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
        if dest.exists():
            if (dest / CONFIG_DIR).is_dir():
                dest.rename(backup_path(dest))
            else:
                shutil.rmtree(dest)          # an empty folder (maybe holding .DS_Store)
        staging.rename(dest)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return dest


def read_members(archive: Path) -> list[tuple[str, PurePosixPath]]:
    """Check a plan file and list what to extract.

    Args:
        archive: The ``.zip`` file.

    Returns:
        (name in the archive, path inside the plan) for every file to extract.

    Raises:
        ShareError: If it isn't a zip, isn't a plan, or contains unsafe paths.
    """
    try:
        if Path(archive).stat().st_size > MAX_ARCHIVE_BYTES:
            raise ShareError('that file is too large to be a plan')
        with zipfile.ZipFile(archive) as zf:
            names = [n for n in zf.namelist() if not n.endswith('/')]
    except (OSError, zipfile.BadZipFile) as err:
        raise ShareError(f'could not read {Path(archive).name}: not a plan file') from err
    names = [n for n in names if not n.startswith('__MACOSX/')]
    prefix = _common_top(names)
    out: list[tuple[str, PurePosixPath]] = []
    for name in names:
        rel = PurePosixPath(name[len(prefix):])
        if rel.is_absolute() or '..' in rel.parts or '\\' in name:
            raise ShareError(f'unsafe path in plan file: {name}')
        if rel.name in SKIP_NAMES or not rel.parts or rel.parts[0] not in ALLOWED_TOP:
            continue
        if rel.parts[0] == STATE_DIR and str(rel) != STATE_PATH:
            continue
        out.append((name, rel))
    if not any(r.parts[0] == CONFIG_DIR and r.suffix in ('.yaml', '.yml') for _, r in out):
        raise ShareError(f'{Path(archive).name} is not a plan file (no config)')
    return out


def backup_path(folder: Path) -> Path:
    """A free sibling name for keeping an old plan, e.g. ``FinancialPlan (before import ...)``."""
    stamp = datetime.now().strftime('%Y-%m-%d %H%M%S')
    return unique_path(folder.with_name(f'{folder.name} (before import {stamp})'))


def unique_path(folder: Path) -> Path:
    """``folder``, or ``folder 2``, ``folder 3``... whichever doesn't exist yet."""
    candidate, n = folder, 2
    while candidate.exists():
        candidate, n = folder.with_name(f'{folder.name} {n}'), n + 1
    return candidate


#
# INTERNAL
#
def _plan_files(plan_dir: Path, include_state: bool) -> list[str]:
    """Files to share: config and data (no hidden files), plus the state file if wanted."""
    files = []
    for top in (CONFIG_DIR, DATA_DIR):
        root = plan_dir / top
        if root.is_dir():
            files += sorted(str(p.relative_to(plan_dir)) for p in root.rglob('*')
                            if p.is_file() and not any(part.startswith('.')
                                                       for part in p.relative_to(root).parts))
    if include_state and (plan_dir / STATE_PATH).is_file():
        files.append(STATE_PATH)
    return files


def _common_top(names: list[str]) -> str:
    """The single top folder all entries share (``"Plan/"``), or ``""`` if entries are at root."""
    tops = {n.split('/', 1)[0] for n in names}
    if len(tops) == 1 and all('/' in n for n in names):
        top = tops.pop()
        if top not in ALLOWED_TOP:
            return f'{top}/'
    return ''
