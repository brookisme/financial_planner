"""
Config

Loads a plan's configuration from ``<plan>/config/*.yaml``. Every file is a mapping; files are
merged by top-level key, so a plan can keep everything in one ``config.yaml`` or split sections
across files (``sources.yaml``, ``rules.yaml``...). Saving a section writes it back to the file it
came from, keeping comments and key order (ruamel.yaml round-trip).

License: BSD 3-Clause
"""
#
# Imports
#
from dataclasses import dataclass, field
from io import StringIO
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from financial_planner.schema import Config

#
# CONSTANTS
#
CONFIG_DIR: str = 'config'
DATA_DIR: str = 'data'
MAIN_FILE: str = 'config.yaml'
SECTION_FILES: dict[str, str] = {
    'sources': 'sources.yaml',
    'categories': 'categories.yaml',
    'rules': 'rules.yaml',
}


#
# PUBLIC
#
class ConfigError(Exception):
    """A plan's configuration could not be read or is invalid."""


@dataclass
class LoadedConfig:
    """A validated config plus where each section lives on disk.

    Attributes:
        plan_dir: The plan folder.
        config: The validated configuration.
        raw: The merged raw mapping (plain Python types).
        owners: Top-level key -> file it was read from.
    """
    plan_dir: Path
    config: Config
    raw: dict[str, Any] = field(default_factory=dict)
    owners: dict[str, Path] = field(default_factory=dict)


def config_dir(plan_dir: Path) -> Path:
    """Return the config folder of a plan."""
    return Path(plan_dir) / CONFIG_DIR


def load_config(plan_dir: Path) -> LoadedConfig:
    """Read, merge and validate all YAML files in ``<plan_dir>/config``.

    Args:
        plan_dir: The plan folder.

    Returns:
        The validated config and the file each section came from.

    Raises:
        ConfigError: If the folder is missing, a file is not valid YAML, two files define the
            same section, or the merged config fails validation.
    """
    plan_dir = Path(plan_dir)
    cdir = config_dir(plan_dir)
    if not cdir.is_dir():
        raise ConfigError(f'no config folder at {cdir} (run "financial_plan init {plan_dir}")')
    raw: dict[str, Any] = {}
    owners: dict[str, Path] = {}
    for path in _yaml_files(cdir):
        data = _read_yaml(path)
        if data is None:
            continue
        if not isinstance(data, dict):
            raise ConfigError(f'{path.name}: the top level must be a mapping of sections')
        for key, value in data.items():
            if key in raw:
                raise ConfigError(f'section "{key}" is defined in both {owners[key].name} and '
                                  f'{path.name}; keep it in one file')
            raw[key] = _plain(value)
            owners[key] = path
    return LoadedConfig(plan_dir=plan_dir, config=validate(raw), raw=raw, owners=owners)


def validate(raw: dict[str, Any]) -> Config:
    """Validate a raw config mapping.

    Args:
        raw: Merged config sections.

    Returns:
        The validated config.

    Raises:
        ConfigError: With a readable list of problems.
    """
    try:
        return Config.model_validate(raw)
    except ValidationError as err:
        raise ConfigError(format_validation_error(err)) from err


def format_validation_error(err: ValidationError) -> str:
    """Turn a pydantic error into short "where: what" lines."""
    lines = []
    for item in err.errors():
        where = '.'.join(str(p) for p in item['loc']) or 'config'
        lines.append(f'{where}: {item["msg"]}')
    return 'invalid config:\n  ' + '\n  '.join(lines)


def save_section(plan_dir: Path, key: str, value: Any) -> Path:
    """Write one top-level section back to its file, keeping the file's other content.

    The whole merged config is validated first, so an invalid edit never reaches disk.

    Args:
        plan_dir: The plan folder.
        key: Top-level section name, e.g. ``rules``.
        value: The new value (plain Python types).

    Returns:
        The file that was written.

    Raises:
        ConfigError: If the result would be invalid.
    """
    loaded = load_config_raw(plan_dir)
    merged = dict(loaded.raw)
    merged[key] = value
    validate(merged)
    path = loaded.owners.get(key) or (config_dir(plan_dir) / SECTION_FILES.get(key, MAIN_FILE))
    yaml = _yaml()
    doc = _read_yaml(path) if path.exists() else None
    if doc is None:
        doc = {}
    doc[key] = _merge_into(doc.get(key), value)
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = StringIO()
    yaml.dump(doc, buf)
    path.write_text(buf.getvalue(), encoding='utf-8')
    return path


def load_config_raw(plan_dir: Path) -> LoadedConfig:
    """Like :func:`load_config` but tolerates an invalid config (for the settings editor).

    Args:
        plan_dir: The plan folder.

    Returns:
        A LoadedConfig whose ``config`` is a default Config if validation failed.
    """
    try:
        return load_config(plan_dir)
    except ConfigError:
        cdir = config_dir(plan_dir)
        raw: dict[str, Any] = {}
        owners: dict[str, Path] = {}
        for path in _yaml_files(cdir) if cdir.is_dir() else []:
            try:
                data = _read_yaml(path)
            except ConfigError:
                continue
            for key, value in (data or {}).items() if isinstance(data, dict) else []:
                raw.setdefault(key, _plain(value))
                owners.setdefault(key, path)
        return LoadedConfig(plan_dir=Path(plan_dir), config=Config(), raw=raw, owners=owners)


def dump_yaml(data: Any) -> str:
    """Render plain data as YAML text (used by ``init`` and tests)."""
    buf = StringIO()
    _yaml().dump(data, buf)
    return buf.getvalue()


#
# INTERNAL
#
def _yaml() -> YAML:
    """A round-trip YAML instance with friendly output settings."""
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.indent(mapping=2, sequence=4, offset=2)
    yaml.width = 100
    return yaml


def _yaml_files(cdir: Path) -> list[Path]:
    """All YAML files in a config folder, main file first, then alphabetical."""
    files = sorted(p for p in cdir.iterdir() if p.suffix in ('.yaml', '.yml') and p.is_file())
    return sorted(files, key=lambda p: (p.name != MAIN_FILE, p.name))


def _read_yaml(path: Path) -> Any:
    """Read one YAML file (round-trip types)."""
    try:
        return _yaml().load(path.read_text(encoding='utf-8'))
    except YAMLError as err:
        raise ConfigError(f'{path.name} is not valid YAML: {err}') from err
    except OSError as err:
        raise ConfigError(f'could not read {path}: {err}') from err


def _plain(value: Any) -> Any:
    """Convert ruamel round-trip containers to plain dict / list / scalars."""
    if isinstance(value, dict):
        return {str(k) if not isinstance(k, int) else k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if hasattr(value, 'real') and not isinstance(value, bool) and type(value).__name__ in (
            'ScalarFloat', 'ScalarInt'):
        return float(value) if 'Float' in type(value).__name__ else int(value)
    if type(value).__name__ in ('ScalarString', 'DoubleQuotedScalarString',
                                'SingleQuotedScalarString', 'LiteralScalarString',
                                'FoldedScalarString', 'PlainScalarString'):
        return str(value)
    return value


def _merge_into(old: Any, new: Any) -> Any:
    """Update a round-trip container in place where shapes match, so comments survive."""
    if isinstance(old, dict) and isinstance(new, dict):
        for key in [k for k in old if k not in new]:
            del old[key]
        for key, value in new.items():
            old[key] = _merge_into(old.get(key), value)
        return old
    if isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        for i, value in enumerate(new):
            old[i] = _merge_into(old[i], value)
        return old
    return new
