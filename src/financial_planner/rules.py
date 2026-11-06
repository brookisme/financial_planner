"""
Rules

Categorization. Each rule has one condition (``row``, ``equals``, ``contains``, ``matches`` or
``similar_to``) on one field (or ``*`` for any field) plus optional filters (source, direction,
amount range). Precedence:

1. ``row`` rules ("this row is X") always win.
2. Other rules in order; the first match wins.
3. The source's ``category_map`` (bank category -> plan category).
4. ``default_category`` for money out, ``default_credit_category`` for money in.

License: BSD 3-Clause
"""
#
# Imports
#
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from typing import Iterable, Optional

from financial_planner.schema import Config, Rule
from financial_planner.sources import Transaction

#
# CONSTANTS
#
# Payment-processor prefixes that hide the merchant name ("SQ *TACO TRUCK", "TST* NOODLES").
PROCESSOR_PREFIX_RE: re.Pattern[str] = re.compile(
    r'^(SQ|TST|SP|DD|PB|EB|ACT|RF|FH|IN|COT|TCB|CKE|SPO|PAYPAL|PP)\s*\*\s*', re.IGNORECASE)
NOISE_RE: re.Pattern[str] = re.compile(r'[#*]\S*|\d+|[^A-Z& ]')


#
# PUBLIC
#
@dataclass
class Assignment:
    """The category a transaction got and why.

    Attributes:
        category: Category name.
        source: ``row``, ``rule``, ``bank`` (category_map) or ``default``.
        rule_index: Index into ``config.rules`` when source is ``row`` or ``rule``.
    """
    category: str
    source: str
    rule_index: Optional[int] = None


def normalize_merchant(text: str) -> str:
    """Reduce a description to a comparable merchant name.

    Drops processor prefixes, store numbers, reference codes and punctuation, e.g.
    ``"SQ *TACO TRUCK 456"`` -> ``"TACO TRUCK"`` and ``"MEGAMART.COM*AB12CD"`` -> ``"MEGAMART COM"``.

    Args:
        text: A description.

    Returns:
        Uppercase words separated by single spaces.
    """
    s = PROCESSOR_PREFIX_RE.sub('', text.strip()).upper()
    s = NOISE_RE.sub(' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def similarity(a: str, b: str) -> float:
    """Similarity (0-1) of two descriptions after :func:`normalize_merchant`."""
    return _similarity(normalize_merchant(a), normalize_merchant(b))


def rule_matches(rule: Rule, tx: Transaction) -> bool:
    """Whether a rule applies to a transaction.

    Args:
        rule: The rule.
        tx: The transaction.

    Returns:
        True if the condition and every filter hold.
    """
    if rule.row:
        return tx.id == rule.row
    if rule.source and tx.source != rule.source:
        return False
    if rule.direction and tx.direction != rule.direction:
        return False
    size = abs(tx.amount)
    if rule.min_amount is not None and size < rule.min_amount:
        return False
    if rule.max_amount is not None and size > rule.max_amount:
        return False
    values = tx.all_fields() if rule.field == '*' else [tx.field(rule.field)]
    return any(_test(rule, v) for v in values)


def assign(tx: Transaction, config: Config,
           row_rules: Optional[dict[str, int]] = None) -> Assignment:
    """Pick a transaction's category.

    Args:
        tx: The transaction.
        config: The plan config (rules, sources, defaults).
        row_rules: Optional precomputed {transaction id: rule index} for speed.

    Returns:
        The assignment.
    """
    if row_rules is None:
        row_rules = row_rule_index(config.rules)
    if tx.id in row_rules:
        i = row_rules[tx.id]
        return Assignment(config.rules[i].category, 'row', i)
    for i, rule in enumerate(config.rules):
        if not rule.row and rule_matches(rule, tx):
            return Assignment(rule.category, 'rule', i)
    source = next((s for s in config.sources if s.name == tx.source), None)
    if source and tx.bank_category and tx.bank_category in source.category_map:
        return Assignment(source.category_map[tx.bank_category], 'bank')
    default = config.default_category if tx.amount >= 0 else config.default_credit_category
    return Assignment(default, 'default')


def categorize(transactions: Iterable[Transaction], config: Config) -> list[Assignment]:
    """Assign every transaction a category.

    Args:
        transactions: Transactions.
        config: The plan config.

    Returns:
        One assignment per transaction, in the same order.
    """
    row_rules = row_rule_index(config.rules)
    return [assign(tx, config, row_rules) for tx in transactions]


def row_rule_index(rules: list[Rule]) -> dict[str, int]:
    """Map transaction id -> index of the (last) row rule for it."""
    return {r.row: i for i, r in enumerate(rules) if r.row}


def preview(rule: Rule, transactions: list[Transaction], config: Config) -> dict[str, object]:
    """What a new rule would do if added.

    The rule is tested as if placed first among the ordinary rules (row rules still win), which
    is where the settings editor adds new rules.

    Args:
        rule: The candidate rule.
        transactions: All transactions.
        config: The current config.

    Returns:
        ``matched`` (ids the rule matches), ``changed`` (ids whose category would change) and
        ``blocked`` (ids it matches that a row rule overrides).
    """
    current = categorize(transactions, config)
    row_rules = row_rule_index(config.rules)
    matched, changed, blocked = [], [], []
    for tx, now in zip(transactions, current):
        if not rule_matches(rule, tx):
            continue
        matched.append(tx.id)
        if tx.id in row_rules and not rule.row:
            blocked.append(tx.id)
        elif now.category != rule.category:
            changed.append(tx.id)
    return {'matched': matched, 'changed': changed, 'blocked': blocked}


#
# INTERNAL
#
def _test(rule: Rule, value: str) -> bool:
    """Apply a rule's operation to one field value."""
    if rule.similar_to is not None:
        return _similarity(normalize_merchant(value), normalize_merchant(rule.similar_to)) \
            >= rule.threshold
    if rule.matches is not None:
        flags = 0 if rule.case_sensitive else re.IGNORECASE
        return _regex(rule.matches, flags).search(value) is not None
    needle = rule.equals if rule.equals is not None else rule.contains or ''
    hay = value if rule.case_sensitive else value.lower()
    needle = needle if rule.case_sensitive else needle.lower()
    if rule.equals is not None:
        return hay.strip() == needle.strip()
    return needle in hay


@lru_cache(maxsize=512)
def _regex(pattern: str, flags: int) -> re.Pattern[str]:
    """Compile and cache a rule's regular expression."""
    return re.compile(pattern, flags)


@lru_cache(maxsize=65536)
def _similarity(a: str, b: str) -> float:
    """Cached SequenceMatcher ratio of two normalized strings."""
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()
