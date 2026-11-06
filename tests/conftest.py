"""
Test Fixtures

Small throwaway plan folders for the tests.

License: BSD 3-Clause
"""
#
# Imports
#
import shutil
import textwrap
from pathlib import Path

import pytest

#
# CONSTANTS
#
REPO: Path = Path(__file__).resolve().parents[1]
DEMO: Path = REPO / 'examples' / 'demo'
CARD_CSV: str = textwrap.dedent('''\
    Transaction Date,Description,Category,Debit,Credit
    2025-01-03,SQ *TACO TRUCK 123,Dining,12.50,
    2025-01-10,FRESH FIELDS MARKET #401,Merchandise,100.00,
    2025-01-12,MEGAMART.COM*AB12CD,Merchandise,,20.00
    2025-02-02,FRESH FIELDS MARKET #988,Merchandise,50.00,
    2025-02-14,PAYMENT THANK YOU,Payment/Credit,,142.50
    2025-02-20,BEAN THERE COFFEE,Dining,4.25,
    ''')
BANK_CSV: str = textwrap.dedent('''\
    Date,Payee,Amount
    01/05/2025,ACME PAYROLL,"$3,000.00"
    01/07/2025,COUNTY TAX COLLECTOR,(1200.00)
    02/07/2025,BENEFITS REIMBURSEMENT,45.00
    02/09/2025,VENMO PAYMENT,-30.00
    ''')
CONFIG_YAML: str = textwrap.dedent('''\
    # main file comment
    plan:
      title: Test plan   # inline comment
      months: 2
    household:
      partners:
        - {name: Partner A, age: 50, take_home_monthly: 3000}
    ''')
SOURCES_YAML: str = textwrap.dedent('''\
    sources:
      - name: Card
        files: data/card.csv
        date: {column: Transaction Date}
        description: Description
        amount: {debit: Debit, credit: Credit}
        category_column: Category
        category_map: {Dining: Dining}
      - name: Bank
        files: data/bank*.csv
        date: {column: Date}
        description: Payee
        amount: {column: Amount, outflow: negative}
    ''')
CATEGORIES_YAML: str = textwrap.dedent('''\
    categories:
      - {name: Groceries, group: Essentials}
      - {name: Dining, group: Flexible, flexible: true}
      - {name: Coffee, group: Flexible, flexible: true}
      - {name: Shopping, group: Flexible}
      - {name: Property tax, kind: one_time, tax: true}
      - {name: Reimbursements, kind: credit, offsets: Shopping, default_on: true}
      - {name: Ignored, kind: ignore}
    ''')
RULES_YAML: str = textwrap.dedent('''\
    rules:
      - {category: Ignored, matches: 'PAYROLL|PAYMENT THANK YOU'}
      - {category: Groceries, contains: fresh fields}
      - {category: Coffee, contains: COFFEE}
      - {category: Shopping, field: '*', contains: MEGAMART}
      - {category: Property tax, contains: COUNTY TAX}
      - {category: Reimbursements, contains: REIMBURSEMENT, direction: credit}
    ''')


#
# PUBLIC
#
@pytest.fixture
def plan_dir(tmp_path: Path) -> Path:
    """A small plan with a card CSV, a bank CSV and config split over four files."""
    (tmp_path / 'data').mkdir()
    (tmp_path / 'config').mkdir()
    (tmp_path / 'data' / 'card.csv').write_text(CARD_CSV)
    (tmp_path / 'data' / 'bank_2025.csv').write_text(BANK_CSV)
    (tmp_path / 'config' / 'config.yaml').write_text(CONFIG_YAML)
    (tmp_path / 'config' / 'sources.yaml').write_text(SOURCES_YAML)
    (tmp_path / 'config' / 'categories.yaml').write_text(CATEGORIES_YAML)
    (tmp_path / 'config' / 'rules.yaml').write_text(RULES_YAML)
    return tmp_path


@pytest.fixture
def demo_dir(tmp_path: Path) -> Path:
    """A writable copy of the demo plan."""
    dest = tmp_path / 'demo'
    shutil.copytree(DEMO, dest, ignore=shutil.ignore_patterns('.financial_planner'))
    return dest
