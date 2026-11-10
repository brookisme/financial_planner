"""
Sources

Reads bank and credit-card CSV exports into normalized transactions. Nothing about a file's layout
is assumed: each source's config names its date, description and amount columns (and the date
format and sign convention, which are detected when not given).

Normalized sign convention: ``amount > 0`` is money out (spending), ``amount < 0`` is money in.

License: BSD 3-Clause
"""
#
# Imports
#
import csv
import glob
import hashlib
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from financial_planner import amazon
from financial_planner.schema import Source

#
# CONSTANTS
#
DATE_FORMATS: tuple[str, ...] = (
    '%Y-%m-%d', '%m/%d/%Y', '%m/%d/%y', '%d/%m/%Y', '%Y/%m/%d', '%m-%d-%Y', '%d.%m.%Y',
    '%b %d, %Y', '%d %b %Y', '%B %d, %Y', '%Y%m%d',
)
AMOUNT_JUNK_RE: re.Pattern[str] = re.compile(r'[^\d.\-]')
SAMPLE_ROWS: int = 5


#
# PUBLIC
#
class SourceError(Exception):
    """A CSV could not be read with its source's settings."""


@dataclass
class Transaction:
    """One normalized transaction.

    Attributes:
        id: Stable id (hash of source, date, description, amount and repeat count).
        source: Source name.
        date: ISO date (YYYY-MM-DD).
        description: Description text.
        amount: Money out is positive, money in is negative.
        bank_category: The bank's own category, if the source has one.
        raw: The original CSV row.
        file: The file it came from.
    """
    id: str
    source: str
    date: str
    description: str
    amount: float
    bank_category: str = ''
    raw: dict[str, str] = field(default_factory=dict)
    file: str = ''

    @property
    def direction(self) -> str:
        """``debit`` for money out, ``credit`` for money in."""
        return 'debit' if self.amount >= 0 else 'credit'

    @property
    def month(self) -> str:
        """The YYYY-MM month."""
        return self.date[:7]

    def field(self, name: str) -> str:
        """Return a field as text for rule matching.

        Args:
            name: ``description``, ``category``, ``source``, ``date``, ``amount``, ``direction``
                or a raw CSV column name.

        Returns:
            The value as text ('' if the field doesn't exist).
        """
        builtin = {'description': self.description, 'category': self.bank_category,
                   'source': self.source, 'date': self.date, 'amount': f'{self.amount:.2f}',
                   'direction': self.direction}
        if name in builtin:
            return builtin[name]
        return self.raw.get(name, '')

    def all_fields(self) -> list[str]:
        """Every text value of the row (description plus raw columns)."""
        return [self.description, self.bank_category, *self.raw.values()]


def load_transactions(plan_dir: Path, sources: Iterable[Source]) -> tuple[list[Transaction],
                                                                          list[str]]:
    """Read every source's files.

    Args:
        plan_dir: The plan folder (file globs are relative to it).
        sources: Source configs.

    Returns:
        All transactions (oldest first) and a list of warnings (missing files, skipped rows).
        Amazon rows are kept to the dates the other sources cover (an export goes back years).
    """
    out: list[Transaction] = []
    warnings: list[str] = []
    shop: list[Transaction] = []
    for source in sources:
        if source.kind == 'amazon':
            rows, notes = _read_amazon(plan_dir, source)
            shop += rows
            warnings += notes
            continue
        paths = resolve_files(plan_dir, source.files)
        if not paths:
            warnings.append(f'{source.name}: no files match {", ".join(source.files)}')
            continue
        seen: dict[str, int] = {}
        for path in paths:
            try:
                rows, skipped = read_source_file(path, source)
            except SourceError as err:
                warnings.append(str(err))
                continue
            if skipped:
                warnings.append(f'{source.name}: skipped {skipped} unreadable row(s) in '
                                f'{path.name}')
            for tx in rows:
                tx.id = _make_id(tx, seen)
                tx.file = str(path.relative_to(plan_dir)) if path.is_relative_to(plan_dir) \
                    else str(path)
                out.append(tx)
    if shop and out:
        first, last = min(t.date for t in out), max(t.date for t in out)
        out += [t for t in shop if first <= t.date <= last]
    else:
        out += shop
    out.sort(key=lambda t: (t.date, t.source, t.description))
    return out, warnings


def resolve_files(plan_dir: Path, patterns: Iterable[str]) -> list[Path]:
    """Expand file globs relative to the plan folder.

    Args:
        plan_dir: The plan folder.
        patterns: File names or globs.

    Returns:
        Matching files, sorted, without duplicates.
    """
    found: dict[str, Path] = {}
    for pattern in patterns:
        full = pattern if Path(pattern).is_absolute() else str(Path(plan_dir) / pattern)
        for name in glob.glob(full):
            p = Path(name)
            if p.is_file():
                found[str(p.resolve())] = p
    return sorted(found.values())


def read_source_file(path: Path, source: Source) -> tuple[list[Transaction], int]:
    """Parse one CSV file with a source's settings.

    Args:
        path: The CSV file.
        source: The source's settings.

    Returns:
        Transactions (ids not yet assigned) and the number of rows that were skipped.

    Raises:
        SourceError: If the file can't be read or a configured column is missing.
    """
    assert source.date and source.amount, 'a csv source has date and amount (schema)'
    header, rows = read_csv(path, source.encoding, source.delimiter, source.skip_rows)
    needed = [source.date.column, *source.description]
    needed += [c for c in (source.amount.column, source.amount.debit, source.amount.credit) if c]
    if source.category_column:
        needed.append(source.category_column)
    missing = [c for c in needed if c not in header]
    if missing:
        raise SourceError(f'{source.name}: {path.name} has no column(s) {", ".join(missing)} '
                          f'(columns are: {", ".join(header)})')
    fmt = source.date.format or detect_date_format([r.get(source.date.column, '') for r in rows])
    if not fmt:
        raise SourceError(f'{source.name}: could not work out the date format of '
                          f'"{source.date.column}" in {path.name}; set date.format')
    out: list[Transaction] = []
    skipped = 0
    for row in rows:
        try:
            day = datetime.strptime(row[source.date.column].strip(), fmt).date()
            amount = _row_amount(row, source)
        except (ValueError, KeyError):
            skipped += 1
            continue
        if amount is None:
            skipped += 1
            continue
        desc = ' '.join(row[c].strip() for c in source.description if row.get(c, '').strip())
        out.append(Transaction(id='', source=source.name, date=day.isoformat(),
                               description=re.sub(r'\s+', ' ', desc).strip(), amount=amount,
                               bank_category=(row.get(source.category_column, '') or '').strip()
                               if source.category_column else '', raw=dict(row)))
    return out, skipped


def read_csv(path: Path, encoding: str = 'utf-8-sig', delimiter: str = ',',
             skip_rows: int = 0) -> tuple[list[str], list[dict[str, str]]]:
    """Read a CSV into a header and row dicts (blank lines dropped).

    Args:
        path: The file.
        encoding: Text encoding.
        delimiter: Field separator.
        skip_rows: Lines to skip before the header.

    Returns:
        The header and the rows.

    Raises:
        SourceError: If the file can't be read.
    """
    try:
        with Path(path).open(newline='', encoding=encoding) as fh:
            for _ in range(skip_rows):
                next(fh, None)
            reader = csv.reader(fh, delimiter=delimiter)
            header = [h.strip() for h in next(reader, [])]
            rows = []
            for values in reader:
                if not any(v.strip() for v in values):
                    continue
                rows.append({h: (values[i] if i < len(values) else '')
                             for i, h in enumerate(header)})
    except (OSError, UnicodeDecodeError, csv.Error) as err:
        raise SourceError(f'could not read {Path(path).name}: {err}') from err
    return header, rows


def detect_date_format(values: Iterable[str]) -> Optional[str]:
    """Find the first known date format that parses every non-empty value.

    Args:
        values: Date strings from one column.

    Returns:
        A strptime format, or None if none fits.
    """
    sample = [v.strip() for v in values if v and v.strip()][:200]
    if not sample:
        return None
    for fmt in DATE_FORMATS:
        try:
            for v in sample:
                datetime.strptime(v, fmt)
        except ValueError:
            continue
        return fmt
    return None


def parse_amount(text: str) -> Optional[float]:
    """Parse a money string such as ``$1,234.50``, ``(12.00)``, ``-5`` or ``12.00 CR``.

    Args:
        text: The cell.

    Returns:
        The number, or None for an empty cell.

    Raises:
        ValueError: If the cell isn't a number.
    """
    s = (text or '').strip()
    if not s:
        return None
    negative = s.startswith('(') and s.endswith(')') or s.endswith('-') or \
        s.upper().endswith('CR')
    s = AMOUNT_JUNK_RE.sub('', s.replace('CR', '').replace('cr', ''))
    if s.endswith('-'):
        s = s[:-1]
    if s in ('', '-', '.'):
        raise ValueError(f'not an amount: {text!r}')
    value = float(s)
    return -abs(value) if negative else value


def inspect_csv(path: Path, encoding: str = 'utf-8-sig', delimiter: str = ',',
                skip_rows: int = 0) -> dict[str, Any]:
    """Describe a CSV to help set up a source.

    Args:
        path: The file.
        encoding: Text encoding.
        delimiter: Field separator.
        skip_rows: Lines to skip before the header.

    Returns:
        ``columns``, ``rows`` (row count), ``sample`` (first rows) and ``guess`` (likely date,
        description, amount / debit / credit and category columns, and the date format).
    """
    header, rows = read_csv(path, encoding, delimiter, skip_rows)
    guess: dict[str, Any] = {}
    for col in header:
        values = [r.get(col, '') for r in rows]
        if 'date' not in guess and detect_date_format(values):
            guess['date'] = col
            guess['date_format'] = detect_date_format(values)
    lower = {h.lower(): h for h in header}
    for key, names in (('description', ('description', 'payee', 'merchant', 'name', 'memo')),
                       ('debit', ('debit', 'withdrawal', 'withdrawals', 'money out')),
                       ('credit', ('credit', 'deposit', 'deposits', 'money in')),
                       ('amount', ('amount', 'transaction amount', 'value')),
                       ('category', ('category', 'type'))):
        for name in names:
            hit = next((h for low, h in lower.items() if low == name or low.startswith(name)),
                       None)
            if hit and hit not in guess.values():
                guess[key] = hit
                break
    if 'amount' in guess:
        nums = []
        for r in rows:
            try:
                v = parse_amount(r.get(guess['amount'], ''))
            except ValueError:
                continue
            if v is not None:
                nums.append(v)
        neg = sum(1 for v in nums if v < 0)
        guess['outflow'] = 'negative' if neg >= len(nums) / 2 else 'positive'
    return {'columns': header, 'rows': len(rows), 'sample': rows[:SAMPLE_ROWS], 'guess': guess}


def month_range(first: str, last: str) -> list[str]:
    """All YYYY-MM months from ``first`` to ``last`` inclusive."""
    y, m = int(first[:4]), int(first[5:7])
    out = []
    while f'{y:04d}-{m:02d}' <= last:
        out.append(f'{y:04d}-{m:02d}')
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def today_month() -> str:
    """The current calendar month as YYYY-MM."""
    return date.today().strftime('%Y-%m')


#
# INTERNAL
#
def _row_amount(row: dict[str, str], source: Source) -> Optional[float]:
    """Read a row's amount in the normalized sign convention (money out positive)."""
    spec = source.amount
    if spec.column:
        value = parse_amount(row.get(spec.column, ''))
        if value is None:
            return None
        return -value if spec.outflow == 'negative' else value
    debit = parse_amount(row.get(spec.debit, '')) if spec.debit else None
    credit = parse_amount(row.get(spec.credit, '')) if spec.credit else None
    if debit is None and credit is None:
        return None
    return abs(debit or 0.0) - abs(credit or 0.0)


def _read_amazon(plan_dir: Path, source: Source) -> tuple[list[Transaction], list[str]]:
    """An Amazon source: every item and refund in its export folder(s) as a transaction.

    Amazon's department is the bank category; the kind (order, digital, refund), card, order id
    and export name are raw fields rules can use.
    """
    roots: list[Path] = []
    for pattern in source.files:
        full = pattern if Path(pattern).is_absolute() else str(Path(plan_dir) / pattern)
        roots += [Path(p) for p in sorted(glob.glob(full)) if Path(p).is_dir()]
    if not roots:
        return [], [f'{source.name}: no folders match {", ".join(source.files)}']
    items, warnings = amazon.load_items(roots, cards=source.cards or None)
    seen: dict[str, int] = {}
    out = []
    for i in items:
        tx = Transaction(id='', source=source.name, date=i.date, description=i.description,
                         amount=i.amount, bank_category=i.department,
                         raw={'Department': i.department, 'Kind': i.kind, 'Card': i.card,
                              'Order ID': i.order_id, 'Account': i.account})
        tx.id = _make_id(tx, seen)
        tx.file = source.files[0]
        out.append(tx)
    return out, [f'{source.name}: {w}' for w in warnings]


def _make_id(tx: Transaction, seen: dict[str, int]) -> str:
    """Stable id; identical rows in one source get a repeat counter."""
    key = f'{tx.source}|{tx.date}|{tx.description}|{tx.amount:.2f}'
    n = seen.get(key, 0)
    seen[key] = n + 1
    return hashlib.sha1(f'{key}|{n}'.encode()).hexdigest()[:12]
