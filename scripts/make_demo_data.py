"""
Make Demo Data

Writes deterministic, entirely fictional credit-card and checking-account CSVs for the demo plan.
The two files deliberately use different layouts (column names, date formats and sign conventions)
so the demo exercises the configurable source mapping.

License: BSD 3-Clause
"""
#
# Imports
#
import argparse
import csv
import random
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Callable

#
# CONSTANTS
#
SEED: int = 7
YEAR: int = 2025
CARD_FILE: str = 'northwind_card_2025.csv'
CHECKING_FILE: str = 'harbor_checking_2025.csv'
CARD_HEADER: list[str] = [
    'Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit']
CHECKING_HEADER: list[str] = ['Posting Date', 'Description', 'Memo', 'Amount', 'Balance']
# (description, card category, low, high, times per month)
CARD_RECURRING: list[tuple[str, str, float, float, float]] = [
    ('FRESH FIELDS MARKET #{n}', 'Merchandise', 90, 240, 4.0),
    ('CORNER GROCER {n}', 'Merchandise', 20, 70, 3.0),
    ('BEAN THERE COFFEE', 'Dining', 4, 14, 5.0),
    ('DAILY GRIND CAFE', 'Dining', 5, 12, 2.0),
    ('SQ *TACO TRUCK {n}', 'Dining', 12, 38, 2.0),
    ("LUIGI'S TRATTORIA", 'Dining', 60, 140, 1.0),
    ('TST* NOODLE HOUSE', 'Dining', 25, 60, 1.5),
    ('SHELLY GAS {n}', 'Gas/Automotive', 35, 70, 2.5),
    ('METRO TRANSIT FARE', 'Other Travel', 20, 40, 1.0),
    ('MEGAMART.COM*{code}', 'Merchandise', 12, 160, 6.0),
    ('PAWS & CLAWS PET SUPPLY', 'Merchandise', 30, 90, 1.0),
    ('CITY PHARMACY #{n}', 'Health Care', 8, 45, 1.5),
    ('CINEPLEX THEATERS', 'Entertainment', 25, 60, 0.7),
    ('HOME BUILD SUPPLY', 'Merchandise', 20, 180, 0.8),
    ('BOOKNOOK BOOKS', 'Merchandise', 12, 45, 0.6),
]
CARD_MONTHLY: list[tuple[str, str, float]] = [
    ('STREAMFLIX.COM', 'Entertainment', 17.99),
    ('TUNEBOX MUSIC', 'Entertainment', 11.99),
    ('PIXEL MOBILE WIRELESS', 'Phone/Cable', 85.00),
    ('LITTLE DANCERS STUDIO', 'Other Services', 140.00),
    ('FITLIFE GYM', 'Health Care', 49.00),
]


#
# PUBLIC
#
def make_demo_data(out_dir: Path) -> tuple[Path, Path]:
    """Write the two demo CSVs into ``out_dir/data``.

    Args:
        out_dir: The demo plan folder. CSVs go into its ``data`` subfolder.

    Returns:
        The paths of the card CSV and the checking CSV.
    """
    rng = random.Random(SEED)
    data_dir = out_dir / 'data'
    data_dir.mkdir(parents=True, exist_ok=True)
    card_rows = _card_rows(rng)
    checking_rows = _checking_rows(rng, card_rows)
    card_path = data_dir / CARD_FILE
    checking_path = data_dir / CHECKING_FILE
    _write(card_path, CARD_HEADER, card_rows)
    _write(checking_path, CHECKING_HEADER, checking_rows)
    return card_path, checking_path


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point.

    Args:
        argv: Arguments (defaults to ``sys.argv[1:]``).

    Returns:
        A process exit code.
    """
    parser = argparse.ArgumentParser(description='Write fictional demo CSVs for a plan folder.')
    parser.add_argument('plan_dir', type=Path, help='plan folder, e.g. examples/demo')
    args = parser.parse_args(argv)
    try:
        card, checking = make_demo_data(args.plan_dir)
    except OSError as err:
        print(f'error: could not write demo data: {err}', file=sys.stderr)
        return 1
    print(f'wrote {card}\nwrote {checking}')
    return 0


#
# INTERNAL
#
def _card_rows(rng: random.Random) -> list[dict[str, str]]:
    """Build credit card rows for the whole demo year (newest first, like most bank exports)."""
    rows: list[dict[str, str]] = []
    add = _adder(rows, rng)
    for month in range(1, 13):
        for desc, cat, low, high, per_month in CARD_RECURRING:
            for _ in range(_poisson(rng, per_month)):
                add(month, desc, cat, rng.uniform(low, high))
        for desc, cat, amount in CARD_MONTHLY:
            add(month, desc, cat, amount, day=rng.randint(1, 5))
        if rng.random() < 0.35:
            add(month, 'MEGAMART.COM*{code}', 'Merchandise', -rng.uniform(15, 80))
    # seasonal and one-off charges
    add(3, 'SKYWAY AIRLINES', 'Airfare', 642.40)
    add(7, 'SKYWAY AIRLINES', 'Airfare', 1288.10)
    add(7, 'SEASIDE INN', 'Lodging', 1190.00)
    add(7, 'SUNNY DAYS CAMP', 'Other Services', 1450.00)
    add(6, 'SUNNY DAYS CAMP', 'Other Services', 1450.00)
    add(8, 'SUNNY DAYS CAMP', 'Other Services', 725.00)
    add(10, 'SMILE DENTAL GROUP', 'Health Care', 310.00)
    add(2, 'SMILE DENTAL GROUP', 'Health Care', 185.00)
    add(11, 'COMFY FURNITURE CO', 'Merchandise', 2899.00)
    add(12, 'TOY CASTLE', 'Merchandise', 412.75)
    add(12, 'HOLIDAY LIGHTS FAIR', 'Entertainment', 96.00)
    for month in range(1, 13):
        total = sum(_money(r['Debit']) - _money(r['Credit'])
                    for r in rows if r['Transaction Date'][5:7] == f'{month:02d}')
        rows.append(_card_row(date(YEAR, month, 27) if month < 12 else date(YEAR, 12, 30),
                              'PAYMENT THANK YOU', 'Payment/Credit', -round(total * 0.98, 2), rng))
    rows.sort(key=lambda r: r['Transaction Date'], reverse=True)
    return rows


def _checking_rows(rng: random.Random, card_rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Build checking rows (signed amounts, MM/DD/YYYY dates, running balance)."""
    events: list[tuple[date, str, str, float]] = []
    for month in range(1, 13):
        for day in (1, 15):
            events.append((date(YEAR, month, day), 'ACME ROBOTICS PAYROLL', 'DIRECT DEP', 3610.42))
        events.append((date(YEAR, month, 28), 'RIVERSIDE CLINIC PAYROLL', 'DIRECT DEP', 4120.00))
        events.append((date(YEAR, month, 3), 'ONLINE TRANSFER TO SAVINGS 4471', 'TRANSFER', -500.0))
        events.append((date(YEAR, month, 5), 'COLLEGEPLAN 529 CONTRIB RILEY', 'ACH', -500.0))
        events.append((date(YEAR, month, 5), 'COLLEGEPLAN 529 CONTRIB CASEY', 'ACH', -500.0))
        events.append((date(YEAR, month, 6), 'BRIGHT PATH SCHOOL TUITION', 'ACH', -1150.0))
        events.append((date(YEAR, month, 9), 'SAFEHOME INSURANCE', 'ACH', -212.50))
        events.append((date(YEAR, month, 1), 'WILLOW LANE MORTGAGE', 'ACH', -2650.0))
        events.append((date(YEAR, month, 18), 'CITY POWER & WATER', 'BILL PAY',
                       -round(rng.uniform(160, 340), 2)))
        events.append((date(YEAR, month, 10), 'ACME BENEFITS REIMBURSEMENT', 'ACH CREDIT',
                       round(rng.uniform(120, 420), 2)))
        for _ in range(_poisson(rng, 3)):
            events.append((date(YEAR, month, rng.randint(1, 28)), 'VENMO PAYMENT', 'ACH',
                           -round(rng.uniform(15, 120), 2)))
        if rng.random() < 0.5:
            events.append((date(YEAR, month, rng.randint(1, 28)), 'ATM WITHDRAWAL 0042',
                           'CASH', -float(rng.choice([60, 100, 200]))))
        if rng.random() < 0.3:
            events.append((date(YEAR, month, rng.randint(1, 28)), 'MOBILE DEPOSIT', 'DEPOSIT',
                           round(rng.uniform(50, 400), 2)))
        card_total = sum(-_money(r['Credit']) for r in card_rows
                         if r['Description'] == 'PAYMENT THANK YOU'
                         and r['Transaction Date'][5:7] == f'{month:02d}')
        events.append((date(YEAR, month, 27) if month < 12 else date(YEAR, 12, 30),
                       'NORTHWIND CARD PAYMENT', 'ACH', -round(abs(card_total), 2)))
    events.append((date(YEAR, 4, 10), 'COUNTY TAX COLLECTOR', 'BILL PAY', -4380.0))
    events.append((date(YEAR, 12, 8), 'COUNTY TAX COLLECTOR', 'BILL PAY', -4380.0))
    events.append((date(YEAR, 4, 14), 'STATE TAX BOARD PYMT', 'BILL PAY', -1860.0))
    events.append((date(YEAR, 3, 3), 'IRS TREAS 310 TAX REF', 'ACH CREDIT', 3214.0))
    events.append((date(YEAR, 2, 20), 'CHECK 1043', 'CHECK', -350.0))
    events.append((date(YEAR, 9, 12), 'CHECK 1044', 'CHECK', -120.0))
    events.sort()
    balance = 12500.0
    rows: list[dict[str, str]] = []
    for day, desc, memo, amount in events:
        balance += amount
        rows.append({'Posting Date': day.strftime('%m/%d/%Y'), 'Description': desc, 'Memo': memo,
                     'Amount': f'{amount:.2f}', 'Balance': f'{balance:.2f}'})
    return rows


def _adder(rows: list[dict[str, str]],
           rng: random.Random) -> Callable[..., None]:
    """Return a helper that appends a card row for a month with a random day."""
    def add(month: int, desc: str, cat: str, amount: float, day: int | None = None) -> None:
        day = day or rng.randint(1, 28)
        rows.append(_card_row(date(YEAR, month, day), desc, cat, amount, rng))
    return add


def _card_row(day: date, desc: str, cat: str, amount: float,
              rng: random.Random) -> dict[str, str]:
    """Format one card row; positive amounts are charges, negative are credits."""
    desc = desc.format(n=rng.randint(100, 999), code=_code(rng))
    amount = round(amount, 2)
    posted = day + timedelta(days=rng.randint(0, 2))
    return {'Transaction Date': day.isoformat(), 'Posted Date': posted.isoformat(),
            'Card No.': '0000', 'Description': desc, 'Category': cat,
            'Debit': f'{amount:.2f}' if amount > 0 else '',
            'Credit': f'{-amount:.2f}' if amount < 0 else ''}


def _code(rng: random.Random) -> str:
    """A random merchant reference code like ``AB12CD``."""
    return ''.join(rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ0123456789') for _ in range(6))


def _poisson(rng: random.Random, mean: float) -> int:
    """A small Poisson draw (Knuth), good enough for 'times per month'."""
    limit, k, p = pow(2.718281828459045, -mean), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


def _money(text: str) -> float:
    """Parse an amount cell ('' counts as zero)."""
    return float(text) if text else 0.0


def _write(path: Path, header: list[str], rows: list[dict[str, str]]) -> None:
    """Write rows as CSV with the given header order."""
    with path.open('w', newline='', encoding='utf-8') as fh:
        writer = csv.DictWriter(fh, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == '__main__':
    sys.exit(main())
