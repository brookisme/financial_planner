"""
Amazon

Turns Amazon "Request Your Data" exports into itemized transactions. Banks show Amazon as one
opaque charge per shipment ("AMAZON MKTPL*AB12CD"); the export lists what was actually bought, so
the plan can categorize each item (groceries, kids, home...) instead of lumping it all as Amazon.

How it fits a plan:

1. A source with ``kind: amazon`` (:func:`source_entry`) points at the export folder(s); the plan
   reads it with :func:`load_items` (``Order History.csv``, ``Digital Content Orders.csv`` and
   ``Refund Details.csv``, found anywhere below each folder): purchases are positive, refunds
   negative, kept to the dates the bank files cover.
2. Rules (:func:`bank_rules`) move the bank's own Amazon rows into an ``ignore`` category so
   nothing is counted twice; Prime membership and AWS stay on the bank side.
3. :func:`compare` checks the itemized total against the bank's Amazon total, month by month.
4. :func:`write_items` can save the items as a CSV to look through.

License: BSD 3-Clause
"""
#
# Imports
#
import csv
import io
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

#
# CONSTANTS
#
ORDERS_FILE: str = 'Order History.csv'
DIGITAL_FILE: str = 'Digital Content Orders.csv'
REFUNDS_FILE: str = 'Refund Details.csv'
SOURCE_NAME: str = 'Amazon'
EXPORT_DIR: str = 'data/amazon'
BANK_CATEGORY: str = 'Amazon (itemized)'
COLUMNS: tuple[str, ...] = ('Date', 'Description', 'Amount', 'Department', 'Kind', 'Card',
                            'Order ID', 'Account')
# Kept on the bank side (and left out of the items): subscriptions the plan already categorizes.
SKIP_PRODUCTS: str = r'Prime Membership'
BANK_KEEP: str = r'PRIME|AWS|WEB SERVICES'
BANK_MATCH: str = rf'^(?!.*(?:{BANK_KEEP})).*(?:AMAZON|AMZN)'
NOT_AVAILABLE: frozenset[str] = frozenset({'', 'Not Available', 'Not Applicable'})
CARD_RE: re.Pattern[str] = re.compile(r'(\d{4})\s*$')
MAX_DESCRIPTION: int = 120
UNKNOWN_CARD: str = 'unknown'


#
# PUBLIC
#
@dataclass
class AmazonItem:
    """One itemized Amazon purchase or refund.

    Attributes:
        date: ISO date: when it shipped (closest to the card charge), else when it was ordered;
            for refunds, when the refund was issued.
        description: Product name (refunds: ``Refund: <product>``).
        amount: Money out is positive (purchases), money in is negative (refunds).
        department: Amazon's department ('' when Amazon doesn't say).
        kind: ``order``, ``digital`` or ``refund``.
        card: Last four digits of the card charged, or ``unknown``.
        order_id: Amazon order id.
        account: Which export it came from (the folder name under the export root).
        gift_card: Part of the order was paid with a gift card, so the card was charged less.
    """
    date: str
    description: str
    amount: float
    department: str = ''
    kind: str = 'order'
    card: str = UNKNOWN_CARD
    order_id: str = ''
    account: str = ''
    gift_card: bool = False


def load_items(roots: Iterable[Path], cards: Optional[Iterable[str]] = None,
               skip_products: str = SKIP_PRODUCTS) -> tuple[list[AmazonItem], list[str]]:
    """Read Amazon export folders into itemized purchases and refunds.

    Args:
        roots: Export folders (or a folder holding several, e.g. one per person).
        cards: Keep only these card endings (e.g. the cards whose statements are in the plan).
            Rows with no known card (digital orders) are always kept. None keeps everything.
        skip_products: Regular expression of product names to leave out (case-insensitive).

    Returns:
        Items sorted by date, and warnings (folders with no order history).
    """
    keep = {c.strip()[-4:] for c in cards} if cards is not None else None
    skip = re.compile(skip_products, re.IGNORECASE) if skip_products else None
    items: list[AmazonItem] = []
    warnings: list[str] = []
    for root in roots:
        root = Path(root).expanduser()
        found = sorted(root.rglob(ORDERS_FILE))
        if not found:
            warnings.append(f'{root}: no "{ORDERS_FILE}" found (is this an Amazon export?)')
            continue
        for orders_path in found:
            account = _account_name(root, orders_path)
            folder = _export_dir(root, orders_path)
            orders = _read_orders(orders_path, account)
            items += orders
            for path in folder.rglob(DIGITAL_FILE):
                items += _read_digital(path, account)
            for path in folder.rglob(REFUNDS_FILE):
                items += _read_refunds(path, account, orders)
    out = [i for i in items
           if not (skip and skip.search(i.description))
           and (keep is None or i.card == UNKNOWN_CARD or i.card in keep)]
    out.sort(key=lambda i: (i.date, i.account, i.order_id, i.kind))
    return out, warnings


def export_dirs(folder: Path) -> list[Path]:
    """The Amazon exports in a folder (each folder holding an ``Order History.csv``).

    Args:
        folder: A folder to search, e.g. the plan's data folder.

    Returns:
        Each export's top folder below ``folder`` (or ``folder`` itself), without duplicates.
    """
    folder = Path(folder)
    if not folder.is_dir():
        return []
    return sorted({_export_dir(folder, p) for p in folder.rglob(ORDERS_FILE)})


def unpack_export(data: bytes, dest: Path) -> int:
    """Unzip an Amazon export into a folder, keeping only its CSV files.

    The zip also holds delivery photos and other files the plan doesn't need.

    Args:
        data: The zip file's bytes.
        dest: Folder to unpack into (created).

    Returns:
        How many CSV files were written.

    Raises:
        ValueError: If it isn't a zip, has no order history, or a path points outside ``dest``.
    """
    dest = Path(dest)
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as err:
        raise ValueError('that file is not a zip (Amazon sends the export as a .zip)') from err
    names = [n for n in archive.namelist() if n.lower().endswith('.csv') and not n.endswith('/')]
    if not any(Path(n).name == ORDERS_FILE for n in names):
        raise ValueError(f'no "{ORDERS_FILE}" in the zip: is it Amazon\'s "Your Orders" export?')
    root = dest.resolve()
    for name in names:
        target = (dest / name).resolve()
        if not target.is_relative_to(root):
            raise ValueError(f'unsafe path in the zip: {name}')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read(name))
    return len(names)


def write_items(items: Iterable[AmazonItem], path: Path) -> Path:
    """Write items as a CSV a ``sources`` entry can read (see :func:`source_entry`).

    Args:
        items: Items from :func:`load_items`.
        path: Output file (parent folders are created).

    Returns:
        The path written.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8') as fh:
        writer = csv.writer(fh)
        writer.writerow(COLUMNS)
        for i in items:
            card = f'{i.card} + gift card' if i.gift_card else i.card
            writer.writerow([i.date, i.description, f'{i.amount:.2f}', i.department, i.kind, card,
                             i.order_id, i.account])
    return path


def card_summary(items: Iterable[AmazonItem], first: str = '',
                 last: str = '') -> list[dict[str, Any]]:
    """Totals per card, to see which cards belong to the plan's statements.

    Args:
        items: Items.
        first: Optional first YYYY-MM month to count.
        last: Optional last YYYY-MM month to count.

    Returns:
        ``card``, ``purchases``, ``refunds``, ``rows``, ``first`` and ``last`` date per card,
        most spent first.
    """
    out: dict[str, dict[str, Any]] = {}
    for i in items:
        if (first and i.date[:7] < first) or (last and i.date[:7] > last):
            continue
        row = out.setdefault(i.card, {'card': i.card, 'purchases': 0.0, 'refunds': 0.0, 'rows': 0,
                                      'first': i.date, 'last': i.date})
        row['purchases' if i.amount >= 0 else 'refunds'] += i.amount
        row['rows'] += 1
        row['first'], row['last'] = min(row['first'], i.date), max(row['last'], i.date)
    return sorted(out.values(), key=lambda r: -r['purchases'])


def source_entry(folder: str = EXPORT_DIR, name: str = SOURCE_NAME,
                 cards: Optional[Iterable[str]] = None) -> dict[str, Any]:
    """The ``sources`` entry for an Amazon export.

    Args:
        folder: The export folder (or a folder holding several), relative to the plan folder.
        name: Source name.
        cards: Card endings whose statements are in the plan (None: every card).

    Returns:
        A mapping ready for ``sources.yaml``. Amazon's department is the source's bank category,
        so ``category_map`` (or rules on ``field: category``) can sort items by department.
    """
    entry: dict[str, Any] = {'name': name, 'kind': 'amazon', 'files': folder}
    if cards:
        entry['cards'] = list(cards)
    return entry


def bank_rules(source_names: Iterable[str], category: str = BANK_CATEGORY,
               pattern: str = BANK_MATCH) -> list[dict[str, Any]]:
    """Rules that set the bank's own Amazon rows aside (one per bank or card source).

    They are per source so they never catch the itemized rows (product names often say
    "Amazon"). Put them above any other rule that mentions Amazon, and give ``category`` the
    ``ignore`` kind.

    Args:
        source_names: The plan's bank and card sources (not the Amazon source).
        category: Category for the set-aside rows.
        pattern: Regular expression for the bank's Amazon descriptions; the default leaves Prime
            membership and AWS out.

    Returns:
        Rule mappings ready for ``rules.yaml``.
    """
    return [{'category': category, 'source': s, 'matches': pattern,
             'note': 'itemized in the Amazon source'} for s in source_names]


def compare(transactions: Iterable[Any], assignments: Iterable[Any], months: list[str],
            source: str = SOURCE_NAME, category: str = BANK_CATEGORY) -> list[dict[str, Any]]:
    """Bank Amazon totals next to itemized totals, month by month.

    Args:
        transactions: The plan's transactions (``Transaction``).
        assignments: Their category assignments, in the same order.
        months: YYYY-MM months to report.
        source: The itemized Amazon source's name.
        category: The category the bank's Amazon rows are set aside in.

    Returns:
        One row per month (``month``, ``bank``, ``items``, ``diff``), then a ``total`` row.
        Amounts are net of refunds; ``diff`` is items minus bank.
    """
    bank = dict.fromkeys(months, 0.0)
    itemized = dict.fromkeys(months, 0.0)
    for tx, a in zip(transactions, assignments):
        if tx.month not in bank:
            continue
        if tx.source == source:
            itemized[tx.month] += tx.amount
        elif a.category == category:
            bank[tx.month] += tx.amount
    rows = [{'month': m, 'bank': bank[m], 'items': itemized[m], 'diff': itemized[m] - bank[m]}
            for m in months]
    total_bank, total_items = sum(bank.values()), sum(itemized.values())
    rows.append({'month': 'total', 'bank': total_bank, 'items': total_items,
                 'diff': total_items - total_bank})
    return rows


#
# INTERNAL
#
def _read_orders(path: Path, account: str) -> list[AmazonItem]:
    """Retail orders: one row per item, cancelled ones dropped."""
    out = []
    for row in _rows(path):
        if row.get('Order Status', '').strip().lower() == 'cancelled':
            continue
        amount = _number(row.get('Total Amount'))
        if not amount:
            continue
        payment = row.get('Payment Method Type', '')
        out.append(AmazonItem(
            date=_date(row.get('Ship Date')) or _date(row.get('Order Date')),
            description=_clip(row.get('Product Name', '')), amount=amount,
            department=_text(row.get('Department')), kind='order', card=_card(payment),
            order_id=row.get('Order ID', '').strip(), account=account,
            gift_card='gift' in payment.lower()))
    return [i for i in out if i.date]


def _read_digital(path: Path, account: str) -> list[AmazonItem]:
    """Digital orders: price and tax come as separate rows, so they are summed per order."""
    orders: dict[tuple[str, str], AmazonItem] = {}
    for row in _rows(path):
        amount = _number(row.get('Transaction Amount'))
        date = _date(row.get('Order Date'))
        if not amount or not date:
            continue
        key = (row.get('Order ID', '').strip(), row.get('Product Name', '').strip())
        item = orders.setdefault(key, AmazonItem(
            date=date, description=_clip(key[1]), amount=0.0, department='Digital',
            kind='digital', order_id=key[0], account=account))
        item.amount = round(item.amount + amount, 2)
    return [i for i in orders.values() if i.amount]


def _read_refunds(path: Path, account: str, orders: list[AmazonItem]) -> list[AmazonItem]:
    """Completed refunds, matched to their order for the card, department and product name.

    The export often repeats a refund (same order, refund date and amount, a different creation
    date); card statements show such a group as one credit, so repeats are dropped.
    """
    by_order: dict[str, list[AmazonItem]] = {}
    for item in orders:
        by_order.setdefault(item.order_id, []).append(item)
    seen: set[tuple[str, str, str]] = set()
    out = []
    for row in _rows(path):
        status = row.get('Refund Status', row.get('Payment Status', '')).strip().lower()
        if status and status != 'completed':
            continue
        amount = _number(row.get('Refund Amount'))
        order_id = row.get('Order ID', '').strip()
        date = _date(row.get('Refund Date')) or _date(row.get('Creation Date'))
        key = (order_id, row.get('Refund Date', '').strip(), f'{amount:.2f}')
        if not amount or not date or key in seen:
            continue
        seen.add(key)
        match = _refunded_item(by_order.get(order_id, []), amount)
        out.append(AmazonItem(
            date=date, description=_clip(f'Refund: {match.description if match else order_id}'),
            amount=-abs(amount), department=match.department if match else '', kind='refund',
            card=match.card if match else UNKNOWN_CARD, order_id=order_id, account=account,
            gift_card=match.gift_card if match else False))
    return out


def _refunded_item(items: list[AmazonItem], amount: float) -> Optional[AmazonItem]:
    """The order's item whose price is closest to the refund (the first item if none)."""
    if not items:
        return None
    return min(items, key=lambda i: abs(i.amount - amount))


def _rows(path: Path) -> list[dict[str, str]]:
    """Read a CSV into row dicts (Amazon exports start with a byte-order mark)."""
    with Path(path).open(newline='', encoding='utf-8-sig') as fh:
        return [{(k or '').strip(): (v or '') for k, v in row.items()}
                for row in csv.DictReader(fh)]


def _account_name(root: Path, orders_path: Path) -> str:
    """The export's name: the folder below the root that holds it, or the root's own name."""
    return _export_dir(root, orders_path).name


def _export_dir(root: Path, orders_path: Path) -> Path:
    """The folder holding one whole export.

    That is the first folder below the root (``root/partner_a/Your Amazon Orders/...``), or the
    root itself when it is an export (its first folder is one of Amazon's ``Your ...`` folders).
    """
    first = orders_path.relative_to(root).parts[0]
    return root if first.startswith('Your ') or first == orders_path.name else root / first


def _date(text: Optional[str]) -> str:
    """ISO date from an Amazon timestamp such as ``2026-08-15T22:48:04.546Z`` ('' if none)."""
    s = (text or '').strip()
    if s in NOT_AVAILABLE:
        return ''
    try:
        return datetime.fromisoformat(s[:10]).date().isoformat()
    except ValueError:
        return ''


def _number(text: Optional[str]) -> float:
    """A money cell as a number (0 for blanks and "Not Available")."""
    s = (text or '').strip().replace(',', '').replace('$', '')
    try:
        return float(s)
    except ValueError:
        return 0.0


def _card(payment: str) -> str:
    """Last four digits from ``Visa - 1234`` / ``Gift Certificate/Card and Visa - 1234``."""
    m = CARD_RE.search(payment or '')
    return m.group(1) if m else UNKNOWN_CARD


def _text(value: Optional[str]) -> str:
    """A text cell with Amazon's placeholders blanked."""
    s = (value or '').strip()
    return '' if s in NOT_AVAILABLE else s


def _clip(text: str) -> str:
    """A product name on one line, at most ``MAX_DESCRIPTION`` characters."""
    s = re.sub(r'\s+', ' ', text or '').strip()
    return s if len(s) <= MAX_DESCRIPTION else s[:MAX_DESCRIPTION - 1].rstrip() + '…'
