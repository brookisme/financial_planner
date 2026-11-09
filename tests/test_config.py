"""
Config Tests

Loading, merging, validating and saving plan configuration.

License: BSD 3-Clause
"""
#
# Imports
#
from pathlib import Path

import pytest

from financial_planner.config import ConfigError, load_config, save_section
from financial_planner.schema import Config, Rule, slugify


#
# PUBLIC
#
def test_merges_files_and_remembers_owners(plan_dir: Path) -> None:
    loaded = load_config(plan_dir)
    assert loaded.config.plan.title == 'Test plan'
    assert [s.name for s in loaded.config.sources] == ['Card', 'Bank']
    assert loaded.owners['rules'].name == 'rules.yaml'
    assert loaded.owners['plan'].name == 'config.yaml'


def test_defaults_and_ids() -> None:
    cfg = Config.model_validate({'household': {'partners': [{'name': 'Partner A', 'age': 40},
                                                            {'name': 'Partner A', 'age': 41}]}})
    assert [p.id for p in cfg.household.partners] == ['partner-a', 'partner-a-2']
    assert cfg.assumptions.retirement.presets['mid'].return_pct == 5.5
    assert cfg.assumptions.college.schools['private'].cost == 65000


def test_duplicate_section_across_files_is_an_error(plan_dir: Path) -> None:
    (plan_dir / 'config' / 'extra.yaml').write_text('rules: []\n')
    with pytest.raises(ConfigError, match='defined in both'):
        load_config(plan_dir)


def test_typos_are_reported_with_location(plan_dir: Path) -> None:
    (plan_dir / 'config' / 'config.yaml').write_text('plan:\n  titel: oops\n')
    with pytest.raises(ConfigError, match='plan.titel'):
        load_config(plan_dir)


def test_missing_config_folder(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match='no config folder'):
        load_config(tmp_path)


def test_rule_needs_exactly_one_operation() -> None:
    with pytest.raises(ValueError, match='exactly one'):
        Rule(category='X')
    with pytest.raises(ValueError, match='exactly one'):
        Rule(category='X', contains='a', matches='b')
    with pytest.raises(ValueError, match='regular expression'):
        Rule(category='X', matches='(')
    assert Rule(category='X', similar_to='ABC').operation == 'similar_to'


def test_offsets_must_point_at_spending_or_one_time() -> None:
    with pytest.raises(ValueError, match='offsets'):
        Config.model_validate({'categories': [
            {'name': 'A', 'kind': 'credit', 'offsets': 'B'}, {'name': 'B', 'kind': 'credit'}]})


def test_cost_kinds_can_be_offset() -> None:
    cfg = Config.model_validate({'categories': [
        {'name': 'Income tax', 'kind': 'annual', 'tax': True},
        {'name': 'Repairs', 'kind': 'emergency'},
        {'name': 'Refund', 'kind': 'credit', 'offsets': 'Income tax'},
        {'name': 'Insurance payout', 'kind': 'credit', 'offsets': 'Repairs'}]})
    assert [c.kind for c in cfg.categories] == ['annual', 'emergency', 'credit', 'credit']


def test_children_get_default_names() -> None:
    cfg = Config.model_validate({'household': {'children': [
        {'age': 9}, {'name': 'Riley', 'age': 7}, {'age': 4}]}})
    assert [c.name for c in cfg.household.children] == ['Child 1', 'Riley', 'Child 3']
    assert [c.id for c in cfg.household.children] == ['child-1', 'riley', 'child-3']


def test_savings_types_and_contributions() -> None:
    cfg = Config.model_validate({
        'savings': [{'name': 'Savings account', 'monthly': 300},
                    {'name': 'Emergency fund', 'type': 'emergency', 'balance': 4000,
                     'max_balance': 15000, 'overflow_to': 'bonds', 'left_pct': 50,
                     'min_monthly': 100, 'max_monthly': 800}],
        'investments': [{'name': 'Stocks'}, {'name': 'Bonds', 'type': 'bonds'}]})
    sav, emer = cfg.savings
    assert (sav.type, sav.monthly, sav.left_pct) == ('savings', 300, None)
    assert (emer.type, emer.max_balance, emer.overflow_to, emer.left_pct) == \
        ('emergency', 15000, 'bonds', 50)
    assert [v.type for v in cfg.investments] == ['stocks', 'bonds']


def test_overflow_must_name_an_investment() -> None:
    with pytest.raises(ValueError, match='overflow_to'):
        Config.model_validate({'savings': [{'name': 'S', 'max_balance': 10,
                                            'overflow_to': 'nowhere'}]})


def test_contribution_min_above_max_is_an_error() -> None:
    with pytest.raises(ValueError, match='min_monthly'):
        Config.model_validate({'investments': [{'name': 'Stocks', 'left_pct': 10,
                                                'min_monthly': 500, 'max_monthly': 100}]})


def test_unknown_school_is_an_error() -> None:
    with pytest.raises(ValueError, match='unknown school'):
        Config.model_validate({'household': {'children': [
            {'name': 'Kid', 'age': 5, 'school': 'hogwarts'}]}})


def test_save_section_keeps_comments_and_owner(plan_dir: Path) -> None:
    path = save_section(plan_dir, 'plan', {'title': 'Renamed', 'months': 2})
    text = path.read_text()
    assert path.name == 'config.yaml'
    assert '# main file comment' in text and 'Renamed' in text
    assert load_config(plan_dir).config.plan.title == 'Renamed'


def test_save_new_section_goes_to_default_file(plan_dir: Path) -> None:
    (plan_dir / 'config' / 'rules.yaml').unlink()
    path = save_section(plan_dir, 'rules', [{'category': 'Coffee', 'contains': 'BEAN'}])
    assert path.name == 'rules.yaml'
    assert load_config(plan_dir).config.rules[0].contains == 'BEAN'


def test_invalid_save_never_reaches_disk(plan_dir: Path) -> None:
    before = (plan_dir / 'config' / 'rules.yaml').read_text()
    with pytest.raises(ConfigError):
        save_section(plan_dir, 'rules', [{'category': 'X'}])
    assert (plan_dir / 'config' / 'rules.yaml').read_text() == before


def test_slugify() -> None:
    assert slugify('Partner A') == 'partner-a'
    assert slugify('  !!  ') == 'item'


def test_save_keeps_numeric_keys_flow_style_and_list_comments(plan_dir: Path) -> None:
    (plan_dir / 'config' / 'config.yaml').write_text(
        'household:\n  partners:\n    # the first partner\n'
        '    - {name: A, age: 50, pensions: [{name: P, estimates: {55: 900}}]}\n')
    loaded = load_config(plan_dir)
    partners = loaded.raw['household']['partners']
    partners[0]['pensions'][0]['estimates'] = {'55': 900, '60': 2000}
    partners.append({'name': 'B', 'age': 40})
    text = save_section(plan_dir, 'household', {'partners': partners}).read_text()
    assert '# the first partner' in text and "'55'" not in text and '60: 2000' in text
    assert load_config(plan_dir).config.household.partners[1].name == 'B'
