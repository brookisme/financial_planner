"""
Amazon Tests

Itemizing Amazon data exports and checking them against the bank's Amazon charges.

License: BSD 3-Clause
"""
#
# Imports
#
import io
import json
import re
import textwrap
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from financial_planner import amazon
from financial_planner.cli import main
from financial_planner.schema import Source
from financial_planner.server import create_app
from financial_planner.summary import load_plan

#
# CONSTANTS
#
ORDERS_CSV: str = ('\ufeffOrder Date,Order ID,Order Status,Payment Method Type,Product Name,'
                   'Department,Ship Date,Total Amount\n') + textwrap.dedent('''\
    2025-01-04T10:00:00Z,111-1,Closed,Visa - 1234,Dog Food 30 lb,Not Available,2025-01-05,40.00
    2025-01-04,111-1,Closed,Visa - 1234,Coffee Beans,Grocery,2025-01-05,15.50
    2025-01-20,111-2,Cancelled,Visa - 1234,Lamp,Home,Not Available,0
    2025-02-01,111-3,Closed,Gift Certificate/Card and Visa - 1234,Kids Shoes,Shoes,2025-02-02,30.00
    2025-02-03,111-4,Closed,MasterCard - 9999,Other Card Thing,Misc.,2025-02-03,99.00
    ''')
DIGITAL_CSV: str = textwrap.dedent('''\
    Order Date,Order ID,Product Name,Component Type,Transaction Amount
    2025-01-10T10:00:00Z,D01-1,Movie Rental,Price Amount,3.99
    2025-01-10T10:00:00Z,D01-1,Movie Rental,Tax,0.30
    2025-01-10T10:00:00Z,D01-2,Prime Membership Fee,Price Amount,14.99
    2025-01-11T10:00:00Z,D01-3,Free Thing,Price Amount,Not Applicable
    ''')
REFUNDS_CSV: str = textwrap.dedent('''\
    Creation Date,Order ID,Payment Status,Refund Amount,Refund Date
    2025-02-10T10:00:00Z,111-1,Completed,15.50,2025-02-12T10:00:00Z
    2025-02-10T10:00:00Z,111-1,Completed,15.50,2025-02-12T10:00:00Z
    2025-02-11T10:00:00Z,111-3,Pending,30.00,2025-02-13T10:00:00Z
    ''')
CARD_ROWS: str = textwrap.dedent('''\
    2025-01-06,AMAZON MKTPL*AB12CD,Merchandise,55.50,
    2025-01-10,AMAZON PRIME*XY12,Other,14.99,
    2025-02-02,Amazon.com*ZZ99,Merchandise,30.00,
    2025-02-12,AMAZON MKTPLACE PMTS,Merchandise,,15.50
    ''')


#
# PUBLIC
#
def test_load_items_orders_digital_and_refunds(tmp_path: Path) -> None:
    root = _export(tmp_path / 'amazon' / 'partner_a')
    items, warnings = amazon.load_items([tmp_path / 'amazon'])
    assert warnings == []
    by_name = {i.description: i for i in items}
    assert 'Lamp' not in by_name                                   # cancelled
    assert 'Prime Membership Fee' not in by_name                   # left on the bank side
    assert 'Free Thing' not in by_name                             # no amount
    assert by_name['Dog Food 30 lb'].date == '2025-01-05'          # ship date
    assert by_name['Dog Food 30 lb'].department == ''              # "Not Available" blanked
    assert by_name['Movie Rental'].amount == pytest.approx(4.29)   # price + tax
    assert by_name['Movie Rental'].card == amazon.UNKNOWN_CARD
    assert by_name['Kids Shoes'].gift_card
    refunds = [i for i in items if i.kind == 'refund']
    assert len(refunds) == 1                                       # repeat and pending dropped
    assert refunds[0].amount == -15.50
    assert refunds[0].description == 'Refund: Coffee Beans'        # closest-priced item
    assert refunds[0].department == 'Grocery' and refunds[0].card == '1234'
    assert {i.account for i in items} == {'partner_a'}
    assert amazon.load_items([root])[0][0].account == 'partner_a'  # the export folder itself


def test_load_items_card_filter_and_missing_export(tmp_path: Path) -> None:
    _export(tmp_path / 'amazon')
    items, _ = amazon.load_items([tmp_path / 'amazon'], cards=['1234'])
    assert 'Other Card Thing' not in {i.description for i in items}
    assert 'Movie Rental' in {i.description for i in items}        # unknown card is kept
    _, warnings = amazon.load_items([tmp_path / 'nothing-here'])
    assert 'no "Order History.csv"' in warnings[0]


def test_write_items_and_card_summary(tmp_path: Path) -> None:
    _export(tmp_path / 'amazon')
    items, _ = amazon.load_items([tmp_path / 'amazon'])
    out = amazon.write_items(items, tmp_path / 'data' / 'amazon.items.csv')
    lines = out.read_text().splitlines()
    assert lines[0] == ','.join(amazon.COLUMNS)
    assert any('1234 + gift card' in line for line in lines)
    summary = {r['card']: r for r in amazon.card_summary(items)}
    assert summary['1234']['purchases'] == pytest.approx(85.50)
    assert summary['1234']['refunds'] == pytest.approx(-15.50)
    assert set(amazon.card_summary(items, first='2025-02')[0]) >= {'card', 'rows'}


def test_amazon_command_setup_then_compare(plan_dir: Path,
                                           capsys: pytest.CaptureFixture[str]) -> None:
    with (plan_dir / 'data' / 'card.csv').open('a') as fh:
        fh.write(CARD_ROWS)
    _export(plan_dir / 'data' / 'amazon')
    assert main(['amazon', str(plan_dir), '--cards', '1234', '--csv',
                 str(plan_dir / 'items.csv')]) == 0
    out = capsys.readouterr().out
    assert 'Other Card Thing' not in (plan_dir / 'items.csv').read_text()
    assert 'kind: amazon' in out and 'kind: ignore' in out and 'source: Card' in out
    assert re.search(r"cards:\s+- '?1234'?", out)

    _configure(plan_dir)
    assert main(['amazon', str(plan_dir)]) == 0
    out = capsys.readouterr().out
    assert 'bank Amazon charges vs itemized' in out
    data = load_plan(plan_dir)
    cats = {t.description: a.category for t, a in zip(data.transactions, data.assignments)}
    assert cats['AMAZON MKTPL*AB12CD'] == amazon.BANK_CATEGORY
    assert cats['AMAZON PRIME*XY12'] != amazon.BANK_CATEGORY      # Prime stays on the bank
    assert cats['Dog Food 30 lb'] == 'Shopping'
    assert 'Other Card Thing' not in cats                          # card not in the plan
    rows = amazon.compare(data.transactions, data.assignments, ['2025-01', '2025-02'])
    assert rows[-1]['bank'] == pytest.approx(55.50 + 30.00 - 15.50)
    assert rows[-1]['items'] == pytest.approx(40.00 + 15.50 + 4.29 + 30.00 - 15.50)


def test_amazon_source_is_kept_to_the_bank_dates(plan_dir: Path) -> None:
    root = _export(plan_dir / 'data' / 'amazon')
    with (root / 'Your Amazon Orders' / amazon.ORDERS_FILE).open('a', encoding='utf-8') as fh:
        fh.write('2019-06-01,000-1,Closed,Visa - 1234,Old Thing,Misc.,2019-06-02,25.00\n')
    _configure(plan_dir)
    data = load_plan(plan_dir)
    shop = [t for t in data.transactions if t.source == 'Amazon']
    assert shop and 'Old Thing' not in {t.description for t in shop}
    assert {t.field('Kind') for t in shop} >= {'order', 'refund'}
    assert next(t for t in shop if t.description == 'Coffee Beans').bank_category == 'Grocery'


def test_source_kinds_need_their_own_fields() -> None:
    src = Source.model_validate({'name': 'Amazon', 'kind': 'amazon', 'files': 'data/amazon',
                                 'cards': [1234, '0099']})
    assert src.cards == ['1234', '0099'] and src.date is None
    with pytest.raises(ValueError, match='missing date, description, amount'):
        Source.model_validate({'name': 'Visa', 'files': 'data/visa.csv'})


def test_bank_rules_skip_prime_and_aws() -> None:
    rule = amazon.bank_rules(['Visa'])[0]
    pattern = re.compile(rule['matches'], re.IGNORECASE)
    assert pattern.search('AMAZON MKTPL*AB12') and pattern.search('Amazon.com*XY')
    assert not pattern.search('AMAZON PRIME*AB12') and not pattern.search('AWS EMEA')
    assert rule['source'] == 'Visa'


def test_server_upload_scan_and_check(plan_dir: Path) -> None:
    headers = {'X-Financial-Planner': '1'}
    client = TestClient(create_app(plan_dir))
    with (plan_dir / 'data' / 'card.csv').open('a') as fh:
        fh.write(CARD_ROWS)
    up = client.post('/api/amazon/upload?name=partner a', headers=headers,
                     content=_zip({'Your Orders/Your Amazon Orders/Order History.csv': ORDERS_CSV,
                                   'Your Orders/Your Amazon Orders/Media/photo.jpg': 'x',
                                   'Your Orders/Your Returns & Refunds/Refund Details.csv':
                                       REFUNDS_CSV}))
    assert up.json() == {'ok': True, 'folder': amazon.EXPORT_DIR, 'export': 'partner a',
                         'files': 2}
    assert not (plan_dir / amazon.EXPORT_DIR / 'partner a' / 'Your Orders' / 'Your Amazon Orders'
                / 'Media').exists()                                # photos left out
    assert client.post('/api/amazon/upload?name=x', headers=headers,
                       content=b'not a zip').status_code == 400
    assert client.post('/api/amazon/upload?name=x', headers=headers,
                       content=_zip({'../../evil/Order History.csv': 'a'})).status_code == 400
    assert client.get('/api/amazon/scan', params={'folder': '../..'}).status_code == 400
    files = client.get('/api/files').json()['files']
    assert files == ['data/bank_2025.csv', 'data/card.csv']        # export CSVs not listed
    scan = client.get('/api/amazon/scan').json()
    assert scan['exports'] == ['partner a']
    assert {c['card'] for c in scan['cards']} == {'1234', '9999'}
    assert scan['category'] == amazon.BANK_CATEGORY
    assert [r['source'] for r in scan['rules']] == ['Card', 'Bank']
    assert client.get('/api/amazon/check').json() == {'rows': []}   # not set up yet
    _configure(plan_dir)
    check = client.get('/api/amazon/check').json()
    assert check['source'] == 'Amazon' and check['rows'][-1]['month'] == 'total'


#
# INTERNAL
#
def _export(root: Path) -> Path:
    """Write a small Amazon export laid out like the real one."""
    orders = root / 'Your Amazon Orders'
    refunds = root / 'Your Returns & Refunds'
    orders.mkdir(parents=True)
    refunds.mkdir()
    (orders / amazon.ORDERS_FILE).write_text(ORDERS_CSV, encoding='utf-8')
    (orders / amazon.DIGITAL_FILE).write_text(DIGITAL_CSV)
    (refunds / amazon.REFUNDS_FILE).write_text(REFUNDS_CSV)
    return root


def _configure(plan_dir: Path) -> None:
    """Add the Amazon source, the ignore category and the bank rule to the test plan."""
    config = plan_dir / 'config'
    with (config / 'sources.yaml').open('a') as fh:
        fh.write(f'  - {json.dumps(amazon.source_entry(cards=["1234"]))}\n')
    with (config / 'categories.yaml').open('a') as fh:
        fh.write(f'  - {{name: {amazon.BANK_CATEGORY}, kind: ignore}}\n')
    rules = [*amazon.bank_rules(['Card']),
             {'category': 'Shopping', 'source': 'Amazon', 'field': 'source', 'equals': 'Amazon'}]
    text = (config / 'rules.yaml').read_text().replace(
        'rules:\n', 'rules:\n' + ''.join(f'  - {json.dumps(r)}\n' for r in rules), 1)
    (config / 'rules.yaml').write_text(text)


def _zip(files: dict[str, str]) -> bytes:
    """A zip holding the given files."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        for name, text in files.items():
            zf.writestr(name, text)
    return buf.getvalue()
