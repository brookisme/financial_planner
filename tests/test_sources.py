"""
Source Tests

Reading CSVs with configurable layouts.

License: BSD 3-Clause
"""
#
# Imports
#
from pathlib import Path

import pytest

from financial_planner.config import load_config
from financial_planner.schema import Source
from financial_planner.sources import (detect_date_format, inspect_csv, load_transactions,
                                       month_range, parse_amount, read_source_file)


#
# PUBLIC
#
@pytest.mark.parametrize('text, expected', [
    ('12.50', 12.5), ('$1,234.50', 1234.5), ('(12.00)', -12.0), ('-5', -5.0), ('7.25-', -7.25),
    ('12.00 CR', -12.0), ('', None), ('  ', None),
])
def test_parse_amount(text: str, expected: float | None) -> None:
    assert parse_amount(text) == expected


def test_parse_amount_rejects_text() -> None:
    with pytest.raises(ValueError):
        parse_amount('n/a')


def test_detect_date_format() -> None:
    assert detect_date_format(['2025-01-31', '2025-02-01']) == '%Y-%m-%d'
    assert detect_date_format(['01/31/2025', '12/01/2025']) == '%m/%d/%Y'
    assert detect_date_format(['31/01/2025', '13/02/2025']) == '%d/%m/%Y'
    assert detect_date_format(['nope']) is None


def test_debit_credit_and_signed_columns(plan_dir: Path) -> None:
    cfg = load_config(plan_dir).config
    txs, warnings = load_transactions(plan_dir, cfg.sources)
    assert warnings == []
    by_desc = {t.description: t for t in txs}
    assert by_desc['SQ *TACO TRUCK 123'].amount == 12.5          # debit column -> money out
    assert by_desc['MEGAMART.COM*AB12CD'].amount == -20.0        # credit column -> money in
    assert by_desc['ACME PAYROLL'].amount == -3000.0             # positive deposit -> money in
    assert by_desc['COUNTY TAX COLLECTOR'].amount == 1200.0      # (1200.00) withdrawal -> out
    assert by_desc['COUNTY TAX COLLECTOR'].date == '2025-01-07'  # MM/DD/YYYY detected
    assert by_desc['SQ *TACO TRUCK 123'].bank_category == 'Dining'
    assert [t.date for t in txs] == sorted(t.date for t in txs)


def test_ids_are_stable_and_unique_for_repeats(tmp_path: Path) -> None:
    (tmp_path / 'a.csv').write_text('D,Desc,Amt\n2025-01-01,X,1\n2025-01-01,X,1\n')
    src = Source(name='S', files=['a.csv'], date={'column': 'D'}, description='Desc',
                 amount={'column': 'Amt', 'outflow': 'positive'})
    first, _ = load_transactions(tmp_path, [src])
    second, _ = load_transactions(tmp_path, [src])
    assert [t.id for t in first] == [t.id for t in second]
    assert len({t.id for t in first}) == 2


def test_missing_column_and_missing_files(tmp_path: Path) -> None:
    (tmp_path / 'a.csv').write_text('Day,Desc,Amt\n2025-01-01,X,1\n')
    src = Source(name='S', files=['a.csv'], date={'column': 'Date'}, description='Desc',
                 amount={'column': 'Amt'})
    txs, warnings = load_transactions(tmp_path, [src])
    assert txs == [] and 'no column(s) Date' in warnings[0]
    gone = Source(name='G', files=['nothing*.csv'], date={'column': 'D'}, description='D',
                  amount={'column': 'D'})
    assert 'no files match' in load_transactions(tmp_path, [gone])[1][0]


def test_skip_rows_and_bad_rows(tmp_path: Path) -> None:
    (tmp_path / 'a.csv').write_text('Bank export\n\nD,Desc,Amt\n2025-01-01,X,1\nbad,Y,2\n'
                                    '2025-01-02,Z,\n')
    src = Source(name='S', files=['a.csv'], date={'column': 'D', 'format': '%Y-%m-%d'},
                 description='Desc', amount={'column': 'Amt'}, skip_rows=2)
    txs, skipped = read_source_file(tmp_path / 'a.csv', src)
    assert [t.description for t in txs] == ['X'] and skipped == 2


def test_inspect_csv_guesses_columns(plan_dir: Path) -> None:
    info = inspect_csv(plan_dir / 'data' / 'bank_2025.csv')
    assert info['columns'] == ['Date', 'Payee', 'Amount']
    assert info['guess']['date'] == 'Date'
    assert info['guess']['date_format'] == '%m/%d/%Y'
    assert info['guess']['description'] == 'Payee'
    assert info['guess']['amount'] == 'Amount'
    card = inspect_csv(plan_dir / 'data' / 'card.csv')
    assert card['guess']['debit'] == 'Debit' and card['guess']['credit'] == 'Credit'


def test_month_range() -> None:
    assert month_range('2025-11', '2026-02') == ['2025-11', '2025-12', '2026-01', '2026-02']
