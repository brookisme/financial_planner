"""
Summary Tests

The month window, category totals, child timelines and the web payload.

License: BSD 3-Clause
"""
#
# Imports
#
from pathlib import Path

from financial_planner.schema import Child
from financial_planner.summary import (build_payload, by_category, category_report,
                                       child_timeline, load_plan, month_label, next_month,
                                       previous_month)


#
# PUBLIC
#
def test_window_and_totals(plan_dir: Path) -> None:
    data = load_plan(plan_dir)
    assert data.months == ['2025-01', '2025-02']
    assert data.today == '2025-03'
    totals = dict(zip([c.name for c in data.categories], by_category(data)))
    assert totals['Groceries'] == [100.0, 50.0]
    assert totals['Dining'] == [12.5, 0.0]            # from the card's category_map
    assert totals['Coffee'] == [0.0, 4.25]
    assert totals['Shopping'] == [-20.0, 0.0]         # a refund nets against spending
    assert totals['Property tax'] == [1200.0, 0.0]
    assert totals['Reimbursements'] == [0.0, -45.0]
    assert totals['Other'] == [0.0, 30.0]             # unmatched money out -> default


def test_last_month_fixes_the_window(plan_dir: Path) -> None:
    cfg = plan_dir / 'config' / 'config.yaml'
    cfg.write_text(cfg.read_text().replace('  months: 2\n', '  months: 1\n  last_month: 2025-01\n'))
    data = load_plan(plan_dir)
    assert data.months == ['2025-01'] and data.today == '2025-02'
    payload = build_payload(plan_dir)
    assert all(row[0].startswith('2025-01') for row in payload['tx'])


def test_ignored_categories_stay_out_of_window_and_payload(plan_dir: Path) -> None:
    (plan_dir / 'data' / 'bank_2025.csv').write_text(
        (plan_dir / 'data' / 'bank_2025.csv').read_text() + '06/01/2025,ACME PAYROLL,10\n')
    data = load_plan(plan_dir)
    assert data.months[-1] == '2025-02'               # a later paycheck doesn't move the window
    payload = build_payload(plan_dir)
    assert all('PAYROLL' not in row[1] for row in payload['tx'])


def test_undefined_categories_are_added(plan_dir: Path) -> None:
    names = {c.name: c.kind for c in load_plan(plan_dir).categories}
    assert names['Other'] == 'spending'
    assert names['Other credits'] == 'credit'


def test_category_report(plan_dir: Path) -> None:
    rows = {r['name']: r for r in category_report(load_plan(plan_dir))}
    assert rows['Groceries']['avg'] == 75.0
    assert rows['Groceries']['low'] == 50.0 and rows['Groceries']['high'] == 100.0
    assert 'Ignored' not in rows


def test_child_timeline_estimated_and_given() -> None:
    kid = Child(name='Kid', age=11)
    assert child_timeline(kid, '2026-03', 18, 4) == {
        'graduation': '2033-06', 'months_to_graduation': 87, 'years_to_college': 7,
        'college_years': '2033–2037'}
    assert child_timeline(Child(name='K', age=5), '2026-09', 18, 4)['months_to_graduation'] == 165
    given = Child(name='Kid', age=10, hs_graduation='2030-05')
    assert child_timeline(given, '2026-01', 18, 4)['months_to_graduation'] == 52
    grown = Child(name='Kid', age=19, hs_graduation='2020-06')
    assert child_timeline(grown, '2026-01', 18, 4)['months_to_graduation'] == 0


def test_payload_shape(plan_dir: Path) -> None:
    p = build_payload(plan_dir)
    assert p['error'] is None
    assert p['month_labels'] == ['Jan 25', 'Feb 25']
    assert len(p['by_cat']) == len(p['categories'])
    date, desc, amount, cat, source, tx_id = p['tx'][0]
    assert p['categories'][cat]['name'] and p['sources'][source] in ('Card', 'Bank')
    assert p['household']['partners'][0]['id'] == 'partner-a'


def test_payload_reports_config_errors(plan_dir: Path) -> None:
    (plan_dir / 'config' / 'config.yaml').write_text('plan: [not, a, mapping]\n')
    p = build_payload(plan_dir)
    assert p['error'] and 'plan' in p['error']


def test_demo_plan_loads(demo_dir: Path) -> None:
    data = load_plan(demo_dir)
    assert not data.warnings and len(data.months) == 12
    kinds = {c.name: c.kind for c in data.categories}
    assert kinds['Paychecks'] == 'ignore'


def test_month_helpers() -> None:
    assert month_label('2025-03') == 'Mar 25'
    assert next_month('2025-12') == '2026-01'
    assert previous_month('2026-01') == '2025-12'
