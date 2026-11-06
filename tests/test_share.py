"""
Share Tests

Exporting a whole plan to one .zip and importing it safely.

License: BSD 3-Clause
"""
#
# Imports
#
import zipfile
from datetime import date
from pathlib import Path

import pytest

from financial_planner.config import load_config
from financial_planner.share import (ShareError, archive_name, export_plan, import_plan,
                                     read_members, unique_path)
from financial_planner.state import read_state, write_state_key
from financial_planner.summary import load_plan


#
# PUBLIC
#
def test_round_trip_reproduces_the_plan(demo_dir: Path, tmp_path: Path) -> None:
    write_state_key(demo_dir, 'scenarios', {'list': [{'id': 's1', 'name': 'Retire at 62'}]})
    (demo_dir / 'data' / '.DS_Store').write_text('x')
    archive = tmp_path / 'plan.zip'
    files = export_plan(demo_dir, archive, top='Our plan')
    assert '.financial_planner/state.json' in files and not any('.DS_Store' in f for f in files)
    assert all(n.startswith('Our plan/') for n in zipfile.ZipFile(archive).namelist())
    copy = import_plan(archive, tmp_path / 'copy')
    before, after = load_plan(demo_dir), load_plan(copy)
    assert len(after.transactions) == len(before.transactions)
    assert [a.category for a in after.assignments] == [a.category for a in before.assignments]
    assert read_state(copy)['scenarios']['list'][0]['name'] == 'Retire at 62'


def test_export_without_state(demo_dir: Path, tmp_path: Path) -> None:
    write_state_key(demo_dir, 'ui', {'x': 1})
    files = export_plan(demo_dir, tmp_path / 'p.zip', include_state=False)
    assert not any(f.startswith('.financial_planner') for f in files)
    assert read_state(import_plan(tmp_path / 'p.zip', tmp_path / 'c')) == {}


def test_import_accepts_entries_at_the_root(demo_dir: Path, tmp_path: Path) -> None:
    archive = tmp_path / 'flat.zip'
    with zipfile.ZipFile(archive, 'w') as zf:
        for p in (demo_dir / 'config').glob('*.yaml'):
            zf.write(p, f'config/{p.name}')
        zf.writestr('__MACOSX/config/._x', 'junk')
        zf.writestr('notes.txt', 'ignored')
    copy = import_plan(archive, tmp_path / 'copy')
    assert load_config(copy).config.household.partners
    assert not (copy / 'notes.txt').exists() and not (copy / '__MACOSX').exists()


@pytest.mark.parametrize('bad', ['../evil.yaml', 'Plan/../../evil.yaml', '/etc/x.yaml'])
def test_unsafe_paths_are_refused(tmp_path: Path, bad: str) -> None:
    archive = tmp_path / 'bad.zip'
    with zipfile.ZipFile(archive, 'w') as zf:
        zf.writestr('Plan/config/config.yaml', 'plan: {}\n')
        zf.writestr(bad, 'x')
    with pytest.raises(ShareError, match='unsafe'):
        read_members(archive)


def test_not_a_plan(tmp_path: Path) -> None:
    (tmp_path / 'x.zip').write_text('not a zip')
    with pytest.raises(ShareError, match='not a plan'):
        import_plan(tmp_path / 'x.zip', tmp_path / 'dest')
    with zipfile.ZipFile(tmp_path / 'y.zip', 'w') as zf:
        zf.writestr('Plan/data/a.csv', 'a')
    with pytest.raises(ShareError, match='no config'):
        import_plan(tmp_path / 'y.zip', tmp_path / 'dest')


def test_existing_folders_are_protected(demo_dir: Path, tmp_path: Path) -> None:
    archive = tmp_path / 'p.zip'
    export_plan(demo_dir, archive)
    busy = tmp_path / 'busy'
    busy.mkdir()
    (busy / 'photo.jpg').write_text('x')
    with pytest.raises(ShareError, match='empty folder'):
        import_plan(archive, busy)
    plan = import_plan(archive, tmp_path / 'plan')
    with pytest.raises(ShareError, match='already a plan'):
        import_plan(archive, plan)
    (plan / 'config' / 'mine.yaml').write_text('# my edits\n')
    import_plan(archive, plan, replace=True)
    backups = [p for p in tmp_path.iterdir() if p.name.startswith('plan (before import')]
    assert len(backups) == 1 and (backups[0] / 'config' / 'mine.yaml').exists()
    assert not (plan / 'config' / 'mine.yaml').exists()
    empty = tmp_path / 'empty'
    empty.mkdir()
    (empty / '.DS_Store').write_text('x')
    assert (import_plan(archive, empty) / 'config').is_dir()


def test_names() -> None:
    assert archive_name('Household Budget', date(2026, 11, 6)) == 'Household Budget 2026-11-06.zip'
    assert archive_name('a/b:c', date(2026, 1, 2)) == 'abc 2026-01-02.zip'


def test_unique_path(tmp_path: Path) -> None:
    (tmp_path / 'Plan').mkdir()
    (tmp_path / 'Plan 2').mkdir()
    assert unique_path(tmp_path / 'Plan') == tmp_path / 'Plan 3'
