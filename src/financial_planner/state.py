"""
State

Saves what the web app needs to remember between visits (planner edits, scenarios) inside the plan
folder at ``<plan>/.financial_planner/state.json``. Keeping it with the plan (instead of in the
browser) means it survives browser changes and moves with the folder.

License: BSD 3-Clause
"""
#
# Imports
#
import json
import os
import tempfile
from pathlib import Path
from typing import Any

#
# CONSTANTS
#
STATE_DIR: str = '.financial_planner'
STATE_FILE: str = 'state.json'
ALLOWED_KEYS: tuple[str, ...] = ('ui', 'scenarios')


#
# PUBLIC
#
def state_path(plan_dir: Path) -> Path:
    """Where a plan's app state lives."""
    return Path(plan_dir) / STATE_DIR / STATE_FILE


def read_state(plan_dir: Path) -> dict[str, Any]:
    """Read the saved app state.

    Args:
        plan_dir: The plan folder.

    Returns:
        The state mapping (empty if nothing was saved or the file is unreadable).
    """
    path = state_path(plan_dir)
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_state_key(plan_dir: Path, key: str, value: Any) -> None:
    """Replace one key of the app state, writing atomically.

    Args:
        plan_dir: The plan folder.
        key: One of ``ALLOWED_KEYS``.
        value: JSON-serializable value; None removes the key.

    Raises:
        ValueError: For an unknown key.
    """
    if key not in ALLOWED_KEYS:
        raise ValueError(f'unknown state key {key!r}')
    data = read_state(plan_dir)
    if value is None:
        data.pop(key, None)
    else:
        data[key] = value
    path = state_path(plan_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.state-', suffix='.json')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=1)
        os.replace(tmp, path)
    except OSError:
        Path(tmp).unlink(missing_ok=True)
        raise
