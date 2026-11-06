"""
Summary

Turns a plan (config + CSVs) into the JSON payload the web app reads: the month window, the
category list, per-category monthly totals, the transactions in the window and derived facts such
as each child's graduation timeline.

License: BSD 3-Clause
"""
#
# Imports
#
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from financial_planner.config import ConfigError, LoadedConfig, load_config
from financial_planner.rules import Assignment, categorize
from financial_planner.schema import Category, Child, Config
from financial_planner.sources import Transaction, load_transactions, month_range, today_month

#
# CONSTANTS
#
MONTH_NAMES: tuple[str, ...] = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                                'Oct', 'Nov', 'Dec')


#
# PUBLIC
#
@dataclass
class PlanData:
    """Everything computed from a plan folder.

    Attributes:
        loaded: The loaded config.
        transactions: All transactions from all sources.
        assignments: One category assignment per transaction.
        categories: Categories in use (config order, then any referenced but undefined).
        months: The YYYY-MM months in the averaging window.
        today: The plan's "now" (YYYY-MM).
        warnings: Problems worth showing (missing files, skipped rows).
    """
    loaded: LoadedConfig
    transactions: list[Transaction]
    assignments: list[Assignment]
    categories: list[Category]
    months: list[str]
    today: str
    warnings: list[str] = field(default_factory=list)

    @property
    def config(self) -> Config:
        """The validated config."""
        return self.loaded.config


def load_plan(plan_dir: Path) -> PlanData:
    """Load config and CSVs and categorize everything.

    Args:
        plan_dir: The plan folder.

    Returns:
        The computed plan data.

    Raises:
        ConfigError: If the config is invalid.
    """
    loaded = load_config(plan_dir)
    cfg = loaded.config
    txs, warnings = load_transactions(Path(plan_dir), cfg.sources)
    assignments = categorize(txs, cfg)
    categories = categories_in_use(cfg, assignments)
    kinds = {c.name: c.kind for c in categories}
    counted = [t for t, a in zip(txs, assignments) if kinds[a.category] != 'ignore']
    months = month_window(counted, cfg.plan.months, cfg.plan.last_month)
    today = cfg.plan.today or (next_month(months[-1]) if counted else today_month())
    return PlanData(loaded=loaded, transactions=txs, assignments=assignments,
                    categories=categories, months=months, today=today, warnings=warnings)


def categories_in_use(cfg: Config, assignments: list[Assignment]) -> list[Category]:
    """The configured categories plus any that rules or defaults refer to but nobody defined.

    Args:
        cfg: The config.
        assignments: Current assignments.

    Returns:
        Categories in config order; undefined ones are appended as ``spending`` (or ``credit``
        for the default credit category).
    """
    out = list(cfg.categories)
    known = {c.name for c in out}
    wanted = [a.category for a in assignments] + [r.category for r in cfg.rules] + \
        [v for s in cfg.sources for v in s.category_map.values()] + \
        [cfg.default_category, cfg.default_credit_category]
    for name in wanted:
        if name not in known:
            kind = 'credit' if name == cfg.default_credit_category else 'spending'
            out.append(Category(name=name, kind=kind))
            known.add(name)
    return out


def month_window(transactions: list[Transaction], months: int,
                 last_month: Optional[str] = None) -> list[str]:
    """The ``months`` calendar months ending at ``last_month`` or the newest transaction.

    Args:
        transactions: Counted transactions.
        months: Window length.
        last_month: Optional fixed last month (YYYY-MM).

    Returns:
        YYYY-MM strings, oldest first. With no transactions, the months before today.
    """
    last = last_month or max((t.month for t in transactions), default=None)
    if last is None:
        last = previous_month(today_month())
    first = last
    for _ in range(months - 1):
        first = previous_month(first)
    return month_range(first, last)


def by_category(data: PlanData) -> list[list[float]]:
    """Per-category monthly totals over the window (money out positive).

    Args:
        data: Plan data.

    Returns:
        A matrix aligned with ``data.categories`` x ``data.months``.
    """
    index = {c.name: i for i, c in enumerate(data.categories)}
    col = {m: i for i, m in enumerate(data.months)}
    out = [[0.0] * len(data.months) for _ in data.categories]
    for tx, a in zip(data.transactions, data.assignments):
        if tx.month in col:
            out[index[a.category]][col[tx.month]] += tx.amount
    return [[round(v, 2) for v in row] for row in out]


def child_timeline(child: Child, today: str, graduation_age: int,
                   college_years: int) -> dict[str, Any]:
    """When a child finishes high school, relative to the plan's today.

    Args:
        child: The child.
        today: YYYY-MM.
        graduation_age: Age at graduation when ``hs_graduation`` is not given.
        college_years: Years of college.

    Returns:
        ``graduation`` (YYYY-MM), ``months_to_graduation``, ``years_to_college`` and
        ``college_years`` label such as ``2034–2038``.
    """
    ty, tm = int(today[:4]), int(today[5:7])
    if child.hs_graduation:
        gy, gm = int(child.hs_graduation[:4]), int(child.hs_graduation[5:7])
    else:
        gy, gm = ty + int(round(graduation_age - child.age)) + (1 if tm > 6 else 0), 6
    months = max(0, (gy - ty) * 12 + gm - tm)
    return {'graduation': f'{gy:04d}-{gm:02d}', 'months_to_graduation': months,
            'years_to_college': max(0, gy - ty), 'college_years': f'{gy}–{gy + college_years}'}


def build_payload(plan_dir: Path) -> dict[str, Any]:
    """Everything the web app needs, as JSON-ready data.

    Args:
        plan_dir: The plan folder.

    Returns:
        The payload. If the config is invalid, ``error`` holds the message and the rest is
        minimal so the app can still open the settings.
    """
    try:
        data = load_plan(plan_dir)
    except ConfigError as err:
        return {'error': str(err), 'plan_dir': str(plan_dir)}
    cfg = data.config
    col = {m: i for i, m in enumerate(data.months)}
    cat_index = {c.name: i for i, c in enumerate(data.categories)}
    source_names = [s.name for s in cfg.sources]
    tx = []
    for t, a in zip(data.transactions, data.assignments):
        if t.month in col and data.categories[cat_index[a.category]].kind != 'ignore':
            tx.append([t.date, t.description, round(t.amount, 2), cat_index[a.category],
                       source_names.index(t.source) if t.source in source_names else -1, t.id])
    college = cfg.assumptions.college
    return {
        'error': None,
        'plan_dir': str(plan_dir),
        'plan': cfg.plan.model_dump() | {'today': data.today},
        'months': data.months,
        'month_labels': [month_label(m) for m in data.months],
        'categories': [c.model_dump() for c in data.categories],
        'by_cat': by_category(data),
        'tx': tx,
        'sources': source_names,
        'household': cfg.household.model_dump(),
        'children': [child_timeline(c, data.today, college.graduation_age, college.years)
                     for c in cfg.household.children],
        'other_income_monthly': cfg.other_income_monthly,
        'savings': [s.model_dump() for s in cfg.savings],
        'investments': [i.model_dump() for i in cfg.investments],
        'assumptions': cfg.assumptions.model_dump(),
        'counts': {'transactions': len(data.transactions), 'in_window': len(tx)},
        'warnings': data.warnings,
    }


def category_report(data: PlanData) -> list[dict[str, Any]]:
    """Average / low / high per month for each category (for the CLI).

    Args:
        data: Plan data.

    Returns:
        Rows with ``name``, ``kind``, ``total``, ``avg``, ``low`` and ``high``.
    """
    n = len(data.months) or 1
    rows = []
    for cat, monthly in zip(data.categories, by_category(data)):
        total = sum(monthly)
        if cat.kind == 'ignore' or not any(monthly):
            continue
        rows.append({'name': cat.name, 'kind': cat.kind, 'total': round(total, 2),
                     'avg': round(total / n, 2), 'low': min(monthly), 'high': max(monthly)})
    return rows


def month_label(month: str) -> str:
    """``2025-03`` -> ``Mar 25``."""
    return f'{MONTH_NAMES[int(month[5:7]) - 1]} {month[2:4]}'


def next_month(month: str) -> str:
    """The month after a YYYY-MM month."""
    y, m = int(month[:4]), int(month[5:7])
    return f'{y + 1:04d}-01' if m == 12 else f'{y:04d}-{m + 1:02d}'


def previous_month(month: str) -> str:
    """The month before a YYYY-MM month."""
    y, m = int(month[:4]), int(month[5:7])
    return f'{y - 1:04d}-12' if m == 1 else f'{y:04d}-{m - 1:02d}'


def transaction_rows(data: PlanData, limit: Optional[int] = None) -> list[dict[str, Any]]:
    """All transactions with their category and how it was chosen (for the categorize view).

    Args:
        data: Plan data.
        limit: Optional maximum number of rows (newest kept).

    Returns:
        One dict per transaction, newest first.
    """
    window = set(data.months)
    rows = []
    for t, a in zip(data.transactions, data.assignments):
        rows.append({'id': t.id, 'date': t.date, 'description': t.description,
                     'amount': round(t.amount, 2), 'source': t.source,
                     'bank_category': t.bank_category, 'category': a.category, 'how': a.source,
                     'rule': a.rule_index, 'in_window': t.month in window, 'raw': t.raw})
    rows.reverse()
    return rows[:limit] if limit else rows
