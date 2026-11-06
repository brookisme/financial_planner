"""
Rule Tests

Every rule operation, the filters and the precedence order.

License: BSD 3-Clause
"""
#
# Imports
#
from financial_planner.rules import (assign, categorize, normalize_merchant, preview,
                                     rule_matches, similarity)
from financial_planner.schema import Config, Rule
from financial_planner.sources import Transaction

#
# CONSTANTS
#
TACO: Transaction = Transaction(id='t1', source='Card', date='2025-01-03',
                                description='SQ *TACO TRUCK 123', amount=12.5,
                                bank_category='Dining', raw={'Memo': 'lunch with team'})
REFUND: Transaction = Transaction(id='t2', source='Bank', date='2025-01-04',
                                  description='MEGAMART REFUND', amount=-20.0)


#
# PUBLIC
#
def test_contains_is_case_insensitive_by_default() -> None:
    assert rule_matches(Rule(category='X', contains='taco'), TACO)
    assert not rule_matches(Rule(category='X', contains='taco', case_sensitive=True), TACO)


def test_equals_and_matches() -> None:
    assert rule_matches(Rule(category='X', equals='sq *taco truck 123'), TACO)
    assert not rule_matches(Rule(category='X', equals='TACO'), TACO)
    assert rule_matches(Rule(category='X', matches=r'^SQ \*TACO'), TACO)
    assert not rule_matches(Rule(category='X', matches=r'^TACO'), TACO)


def test_other_fields_and_any_field() -> None:
    assert rule_matches(Rule(category='X', field='category', equals='Dining'), TACO)
    assert rule_matches(Rule(category='X', field='Memo', contains='team'), TACO)
    assert not rule_matches(Rule(category='X', contains='team'), TACO)
    assert rule_matches(Rule(category='X', field='*', contains='team'), TACO)
    assert rule_matches(Rule(category='X', field='source', equals='card'), TACO)


def test_row_rule() -> None:
    assert rule_matches(Rule(category='X', row='t1'), TACO)
    assert not rule_matches(Rule(category='X', row='t1'), REFUND)


def test_filters() -> None:
    base = {'category': 'X', 'contains': 'A'}
    assert rule_matches(Rule(**base, direction='debit'), TACO)
    assert not rule_matches(Rule(**base, direction='credit'), TACO)
    assert rule_matches(Rule(**base, direction='credit'), REFUND)
    assert not rule_matches(Rule(**base, min_amount=13), TACO)
    assert rule_matches(Rule(**base, min_amount=20, max_amount=20), REFUND)
    assert not rule_matches(Rule(**base, source='Bank'), TACO)


def test_normalize_and_similarity() -> None:
    assert normalize_merchant('SQ *TACO TRUCK 123') == 'TACO TRUCK'
    assert normalize_merchant('FRESH FIELDS MARKET #401') == 'FRESH FIELDS MARKET'
    assert normalize_merchant('MEGAMART.COM*AB12CD') == 'MEGAMART COM'
    assert similarity('FRESH FIELDS MARKET #401', 'FRESH FIELDS MARKET #988') == 1.0
    assert similarity('TACO TRUCK', 'BEAN THERE COFFEE') < 0.5
    assert rule_matches(Rule(category='X', similar_to='TST* TACO TRUCK 9'), TACO)


def test_precedence_row_then_order_then_bank_then_default() -> None:
    cfg = Config.model_validate({
        'sources': [{'name': 'Card', 'files': 'x.csv', 'date': {'column': 'D'},
                     'description': 'D', 'amount': {'column': 'A'},
                     'category_map': {'Dining': 'Eating out'}}],
        'rules': [{'category': 'First', 'contains': 'TACO'},
                  {'category': 'Second', 'contains': 'TRUCK'},
                  {'category': 'Pinned', 'row': 't1'}]})
    assert assign(TACO, cfg).category == 'Pinned'
    assert assign(TACO, cfg).source == 'row'
    cfg.rules.pop()
    assert assign(TACO, cfg).category == 'First'
    cfg.rules.clear()
    assert assign(TACO, cfg).category == 'Eating out'
    assert assign(TACO, cfg).source == 'bank'
    assert assign(REFUND, cfg).category == 'Other credits'
    other = Transaction(id='t3', source='Bank', date='2025-01-05', description='?', amount=3)
    assert assign(other, cfg).category == 'Other'


def test_categorize_and_preview() -> None:
    cfg = Config.model_validate({'rules': [{'category': 'Food', 'contains': 'TACO'},
                                           {'category': 'Pinned', 'row': 't2'}]})
    assert [a.category for a in categorize([TACO, REFUND], cfg)] == ['Food', 'Pinned']
    result = preview(Rule(category='Snacks', field='*', matches='TACO|MEGAMART'),
                     [TACO, REFUND], cfg)
    assert result == {'matched': ['t1', 't2'], 'changed': ['t1'], 'blocked': ['t2']}
