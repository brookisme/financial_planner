"""
Schema

Pydantic models for every section of a plan's configuration. They validate the YAML, fill in
defaults and are the single description of what the config can contain (the README's config
reference mirrors these models).

License: BSD 3-Clause
"""
#
# Imports
#
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

#
# CONSTANTS
#
CATEGORY_KINDS: tuple[str, ...] = ('spending', 'annual', 'one_time', 'emergency', 'credit',
                                   'ignore')
COST_KINDS: tuple[str, ...] = ('annual', 'one_time', 'emergency')
RULE_OPERATIONS: tuple[str, ...] = ('row', 'equals', 'contains', 'matches', 'similar_to')
YEAR_MONTH_RE: re.Pattern[str] = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')
DEFAULT_SCHOOLS: dict[str, dict[str, Any]] = {
    'public': {'name': 'Public in-state', 'cost': 30000},
    'flagship': {'name': 'Flagship in-state', 'cost': 45000},
    'private': {'name': 'Private', 'cost': 65000},
}
DEFAULT_COLLEGE_PRESETS: dict[str, dict[str, Any]] = {
    'pessimistic': {'name': 'Pessimistic', 'return_pct': 4, 'inflation_pct': 5},
    'mid': {'name': 'Mid', 'return_pct': 6, 'inflation_pct': 4},
    'optimistic': {'name': 'Optimistic', 'return_pct': 8, 'inflation_pct': 3},
}
DEFAULT_RETIREMENT_PRESETS: dict[str, dict[str, Any]] = {
    'pessimistic': {'name': 'Pessimistic', 'return_pct': 4.5, 'inflation_pct': 3.5},
    'mid': {'name': 'Mid', 'return_pct': 5.5, 'inflation_pct': 3},
    'optimistic': {'name': 'Optimistic', 'return_pct': 7, 'inflation_pct': 2.5},
}


#
# PUBLIC
#
class _Model(BaseModel):
    """Base model: unknown keys are errors, so typos in YAML are caught."""
    model_config = ConfigDict(extra='forbid', populate_by_name=True)


class PlanInfo(_Model):
    """Titles and the time window.

    Attributes:
        title: Page title.
        subtitle: Line under the title. Empty: generated from the data sources, the months
            covered and the partners' take-home notes.
        today: The plan's "now" as YYYY-MM. Defaults to the month after the averaging window.
        months: How many months of transactions to average over.
        last_month: Last month of the averaging window (YYYY-MM). Defaults to the month of the
            newest transaction; set it to leave out a partial month.
        currency_symbol: Shown before amounts.
    """
    title: str = 'Household Budget'
    subtitle: str = ''
    today: Optional[str] = None
    months: int = Field(12, ge=1, le=120)
    last_month: Optional[str] = None
    currency_symbol: str = '$'

    @field_validator('today', 'last_month')
    @classmethod
    def _check_today(cls, value: Optional[str]) -> Optional[str]:
        """Require YYYY-MM."""
        if value is not None and not YEAR_MONTH_RE.match(str(value)):
            raise ValueError('must look like 2026-01')
        return value


class SocialSecurity(_Model):
    """Social Security estimate for one partner.

    Attributes:
        at_67: Monthly benefit at full retirement age (67), in today's dollars.
        claim_age: Age to claim (62-70). Empty means "when retiring, but not before 62".
    """
    at_67: float = 0
    claim_age: Optional[int] = Field(None, ge=62, le=70)


class Pension(_Model):
    """A defined-benefit pension.

    Attributes:
        name: Label.
        estimates: Monthly benefit by retirement age, e.g. {55: 900, 60: 2800, 65: 5800}. Ages in
            between are interpolated; before the first age the pension pays nothing.
        monthly: A flat monthly amount instead of estimates.
        service_years_now: Years of service today. If set, benefits after the last estimate age
            grow in proportion to years of service.
        grows_with_raises: Scale the benefit by the partner's real raises (final-pay formulas).
    """
    name: str = 'Pension'
    estimates: dict[int, float] = Field(default_factory=dict)
    monthly: Optional[float] = None
    service_years_now: Optional[float] = None
    grows_with_raises: bool = True


class Account(_Model):
    """A retirement account (401k, 403b, IRA...).

    Attributes:
        name: Label.
        balance: Balance today.
        monthly: Amount added each month until retirement.
    """
    name: str = 'Retirement account'
    balance: float = 0
    monthly: float = 0


class Partner(_Model):
    """One adult in the household.

    Attributes:
        id: Short stable key (defaults to a slug of the name).
        name: Display name. Generic names are recommended.
        age: Age today.
        take_home_monthly: Net pay per month.
        take_home_note: Where the take-home number came from.
        raise_pct: Yearly raise above inflation.
        social_security: Social Security estimate.
        retirement_age: Starting retirement age. For the first partner, empty uses
            assumptions.retirement.default_age; for the others, empty means "the same year as the
            first partner".
        pensions: Pensions.
        accounts: Retirement accounts.
    """
    id: Optional[str] = None
    name: str
    age: float = Field(..., ge=0, le=120)
    take_home_monthly: float = 0
    take_home_note: str = ''
    raise_pct: float = 0
    social_security: SocialSecurity = Field(default_factory=SocialSecurity)
    retirement_age: Optional[int] = Field(None, ge=40, le=80)
    pensions: list[Pension] = Field(default_factory=list)
    accounts: list[Account] = Field(default_factory=list)


class Contribution(_Model):
    """How much goes into a 529, savings account or investment each month.

    Either a fixed amount (``monthly``) or a share of what is left over each month after spending,
    taxes and every fixed contribution (``left_pct``), optionally kept between a floor and a cap.

    Attributes:
        monthly: Fixed amount per month (used when ``left_pct`` is empty).
        left_pct: Percent of the monthly left-over to put in instead of a fixed amount.
        min_monthly: With ``left_pct``: put in at least this much (even when nothing is left).
        max_monthly: With ``left_pct``: put in at most this much.
    """
    monthly: float = 0
    left_pct: Optional[float] = Field(None, ge=0, le=100)
    min_monthly: Optional[float] = Field(None, ge=0)
    max_monthly: Optional[float] = Field(None, ge=0)

    @model_validator(mode='after')
    def _check_range(self) -> 'Contribution':
        """Require min_monthly <= max_monthly."""
        lo, hi = self.min_monthly, self.max_monthly
        if lo is not None and hi is not None and lo > hi:
            raise ValueError('min_monthly must not be more than max_monthly')
        return self


class College529(Contribution):
    """A child's 529 college savings plan. Contributions stop at high-school graduation.

    Attributes:
        balance: Balance today.
    """
    balance: float = 0


class Child(_Model):
    """One child.

    Attributes:
        id: Short stable key.
        name: Display name (defaults to "Child 1", "Child 2", ... by position).
        age: Age today.
        hs_graduation: High-school graduation as YYYY-MM. Estimated from age if empty.
        college_529: 529 plan, if any.
        school: Key into ``assumptions.college.schools``.
        note: Extra text for the child's card.
    """
    id: Optional[str] = None
    name: Optional[str] = None
    age: float = Field(..., ge=0, le=30)
    hs_graduation: Optional[str] = None
    college_529: College529 = Field(default_factory=College529)
    school: str = 'public'
    note: str = ''

    @field_validator('hs_graduation')
    @classmethod
    def _check_graduation(cls, value: Optional[str]) -> Optional[str]:
        """Require YYYY-MM."""
        if value is not None and not YEAR_MONTH_RE.match(str(value)):
            raise ValueError('hs_graduation must look like 2034-06')
        return value


class Household(_Model):
    """Everyone in the plan.

    Attributes:
        partners: One or more adults. The first is the "primary": the retirement chart follows
            their age. Others retire the same year unless they have their own retirement_age.
        children: Zero or more children.
    """
    partners: list[Partner] = Field(default_factory=list)
    children: list[Child] = Field(default_factory=list)


class SavingsAccount(Contribution):
    """A savings account or emergency fund (shown in the planner's Savings box).

    Attributes:
        id: Short stable key.
        name: Label.
        type: ``savings`` (a savings account) or ``emergency`` (an emergency fund: costs in
            ``emergency`` categories are paid from it).
        balance: Balance today.
        max_balance: Optional target. Once the balance reaches it, contributions go to the
            ``overflow_to`` investment instead.
        overflow_to: Investment id that receives contributions above ``max_balance`` (default: the
            first investment; with no investments they stay in the budget's left-over).
        return_pct: Yearly interest.
        stops_at_retirement: Stop contributions at retirement.
    """
    id: Optional[str] = None
    name: str
    type: Literal['savings', 'emergency'] = 'savings'
    balance: float = 0
    max_balance: Optional[float] = Field(None, ge=0)
    overflow_to: Optional[str] = None
    return_pct: float = 0
    stops_at_retirement: bool = True


class Investment(Contribution):
    """A stock or bond account that grows at its own rate and becomes retirement income.
    Contributions stop at retirement.

    Attributes:
        id: Short stable key.
        name: Label.
        type: ``stocks`` or ``bonds``.
        balance: Balance today.
        return_pct: Yearly return (0 = off).
    """
    id: Optional[str] = None
    name: str = 'Investments'
    type: Literal['stocks', 'bonds'] = 'stocks'
    balance: float = 0
    return_pct: float = 0


class Preset(_Model):
    """A named pair of return and inflation rates."""
    name: str
    return_pct: float
    inflation_pct: float


class RetirementAssumptions(_Model):
    """Retirement model assumptions.

    Attributes:
        return_pct: Yearly investment return.
        inflation_pct: Yearly inflation.
        withdrawal_pct: Yearly withdrawal rate from savings in retirement.
        tax_pct: Overall income tax rate in retirement.
        health_insurance_monthly: Health insurance cost per month after retiring.
        default_age: Starting retirement age of the primary partner (unless they set
            retirement_age).
        presets: Named return/inflation presets.
    """
    return_pct: float = 5.5
    inflation_pct: float = 3
    withdrawal_pct: float = 4
    tax_pct: float = 12
    health_insurance_monthly: float = 0
    default_age: int = Field(65, ge=40, le=80)
    presets: dict[str, Preset] = Field(
        default_factory=lambda: {k: Preset(**v) for k, v in DEFAULT_RETIREMENT_PRESETS.items()})


class School(_Model):
    """A type of college and its yearly cost today."""
    name: str
    cost: float


class CollegeAssumptions(_Model):
    """529 projection assumptions.

    Attributes:
        schools: School types and yearly cost of attendance today.
        presets: Return / college-cost-growth presets.
        default_preset: Preset each child starts on.
        graduation_age: Age at high-school graduation, used when hs_graduation is empty.
        years: Years of college.
    """
    schools: dict[str, School] = Field(
        default_factory=lambda: {k: School(**v) for k, v in DEFAULT_SCHOOLS.items()})
    presets: dict[str, Preset] = Field(
        default_factory=lambda: {k: Preset(**v) for k, v in DEFAULT_COLLEGE_PRESETS.items()})
    default_preset: str = 'mid'
    graduation_age: int = 18
    years: int = Field(4, ge=1, le=8)


class Assumptions(_Model):
    """All model assumptions."""
    retirement: RetirementAssumptions = Field(default_factory=RetirementAssumptions)
    college: CollegeAssumptions = Field(default_factory=CollegeAssumptions)


class DateSpec(_Model):
    """Where a source's date lives.

    Attributes:
        column: Column name.
        format: strptime format such as ``%m/%d/%Y``. Detected automatically if empty.
    """
    column: str
    format: Optional[str] = None


class AmountSpec(_Model):
    """How to read a source's amounts.

    Use either one signed ``column`` or separate ``debit`` / ``credit`` columns.

    Attributes:
        column: A single signed amount column.
        outflow: For ``column``: whether money going out is ``negative`` (most banks) or
            ``positive`` (most card exports).
        debit: Column with money out (charges, withdrawals).
        credit: Column with money in (refunds, deposits).
    """
    column: Optional[str] = None
    outflow: Literal['negative', 'positive'] = 'negative'
    debit: Optional[str] = None
    credit: Optional[str] = None

    @model_validator(mode='after')
    def _one_style(self) -> 'AmountSpec':
        """Require a signed column or a debit/credit pair."""
        if not self.column and not (self.debit or self.credit):
            raise ValueError('amount needs "column", or "debit" and/or "credit"')
        if self.column and (self.debit or self.credit):
            raise ValueError('amount: use "column" or "debit"/"credit", not both')
        return self


class Source(_Model):
    """One CSV export (a card, a bank account...).

    Attributes:
        name: Label, e.g. "Visa card".
        files: File name(s) or glob(s) relative to the plan folder, e.g. ``data/visa*.csv``.
        date: Date column and format.
        description: Column(s) joined to make the description.
        amount: Amount column(s).
        category_column: Optional column with the bank's own category (rules can use it).
        category_map: Bank category -> plan category, used when no rule matches.
        skip_rows: Lines to skip before the header row.
        encoding: File encoding.
        delimiter: Field separator.
    """
    name: str
    files: list[str]
    date: DateSpec
    description: list[str]
    amount: AmountSpec
    category_column: Optional[str] = None
    category_map: dict[str, str] = Field(default_factory=dict)
    skip_rows: int = 0
    encoding: str = 'utf-8-sig'
    delimiter: str = ','

    @field_validator('files', 'description', mode='before')
    @classmethod
    def _listify(cls, value: Any) -> Any:
        """Allow a single string where a list is expected."""
        return [value] if isinstance(value, str) else value


class Category(_Model):
    """A spending / credit category.

    Attributes:
        name: Name (unique).
        kind: ``spending`` (regular monthly), ``annual`` (yearly expenses such as taxes or
            insurance), ``one_time`` (1-time purchases), ``emergency`` (paid from the emergency
            fund), ``credit`` (money in that can offset spending) or ``ignore`` (transfers,
            payments, paychecks, savings: never counted). Annual, one_time and emergency costs are
            kept out of the regular averages and each has a toggle.
        group: Planner group heading, e.g. Essentials / Flexible.
        flexible: Included in "try 10% less on flexible spending".
        kids_gone_pct: Change once all children have left home.
        retired_pct: Change after retiring (applied on top of kids_gone_pct).
        default_on: For costs / credits: counted by default.
        in_retirement: For costs / credits: continues after retiring.
        tax: For annual / one_time: belongs in the "Tax set-aside" total.
        offsets: For credit: a spending category it's shown under (a reimbursement) or a cost
            category it reduces (e.g. a federal refund under income tax).
        label: Text for the planner toggle.
        note: Small print next to the toggle / in the help.
    """
    name: str
    kind: Literal['spending', 'annual', 'one_time', 'emergency', 'credit', 'ignore'] = 'spending'
    group: str = 'Other'
    flexible: bool = False
    kids_gone_pct: float = 0
    retired_pct: float = 0
    default_on: bool = False
    in_retirement: bool = False
    tax: bool = False
    offsets: Optional[str] = None
    label: Optional[str] = None
    note: Optional[str] = None


class Rule(_Model):
    """A categorization rule: one condition plus optional filters.

    Exactly one of ``row``, ``equals``, ``contains``, ``matches`` or ``similar_to`` must be set.

    Attributes:
        category: Category to assign.
        row: A transaction id: "this row is X".
        field: Field to test: ``description``, ``category`` (the bank's), ``source``, any raw CSV
            column name, or ``*`` for any field.
        equals: Field equals this text.
        contains: Field contains this text.
        matches: Field matches this regular expression.
        similar_to: Field is similar to this text (merchant names with store numbers etc).
        threshold: Similarity needed for ``similar_to`` (0-1).
        case_sensitive: Text comparisons respect case.
        source: Only rows from this source.
        direction: Only ``debit`` (money out) or ``credit`` (money in) rows.
        min_amount: Only rows with |amount| >= this.
        max_amount: Only rows with |amount| <= this.
        note: Free text.
    """
    category: str
    row: Optional[str] = None
    field: str = 'description'
    equals: Optional[str] = None
    contains: Optional[str] = None
    matches: Optional[str] = None
    similar_to: Optional[str] = None
    threshold: float = Field(0.85, ge=0, le=1)
    case_sensitive: bool = False
    source: Optional[str] = None
    direction: Optional[Literal['debit', 'credit']] = None
    min_amount: Optional[float] = None
    max_amount: Optional[float] = None
    note: Optional[str] = None

    @model_validator(mode='after')
    def _one_operation(self) -> 'Rule':
        """Require exactly one operation and a valid regex."""
        ops = [op for op in RULE_OPERATIONS if getattr(self, op) not in (None, '')]
        if len(ops) != 1:
            raise ValueError(f'a rule needs exactly one of {", ".join(RULE_OPERATIONS)}')
        if self.matches is not None:
            try:
                re.compile(self.matches)
            except re.error as err:
                raise ValueError(f'bad regular expression {self.matches!r}: {err}') from err
        return self

    @property
    def operation(self) -> str:
        """The name of the operation this rule uses."""
        return next(op for op in RULE_OPERATIONS if getattr(self, op) not in (None, ''))


class Config(_Model):
    """A whole plan.

    Attributes:
        plan: Titles and time window.
        household: Partners and children.
        other_income_monthly: Other take-home income per month.
        savings: Savings accounts and emergency funds.
        investments: Stock and bond accounts.
        assumptions: Model assumptions.
        sources: CSV sources.
        categories: Categories.
        rules: Categorization rules (first match wins; row rules always win).
        default_category: Category for unmatched money-out rows.
        default_credit_category: Category for unmatched money-in rows.
    """
    plan: PlanInfo = Field(default_factory=PlanInfo)
    household: Household = Field(default_factory=Household)
    other_income_monthly: float = 0
    savings: list[SavingsAccount] = Field(default_factory=list)
    investments: list[Investment] = Field(default_factory=list)
    assumptions: Assumptions = Field(default_factory=Assumptions)
    sources: list[Source] = Field(default_factory=list)
    categories: list[Category] = Field(default_factory=list)
    rules: list[Rule] = Field(default_factory=list)
    default_category: str = 'Other'
    default_credit_category: str = 'Other credits'

    @model_validator(mode='after')
    def _fill_ids_and_check(self) -> 'Config':
        """Give people and accounts stable ids and check cross references."""
        for i, child in enumerate(self.household.children):
            if not child.name:
                child.name = f'Child {i + 1}'
        _assign_ids(self.household.partners, 'partner')
        _assign_ids(self.household.children, 'child')
        _assign_ids(self.savings, 'savings')
        _assign_ids(self.investments, 'investment')
        names = [c.name for c in self.categories]
        dupes = sorted({n for n in names if names.count(n) > 1})
        if dupes:
            raise ValueError(f'duplicate category names: {", ".join(dupes)}')
        kinds = {c.name: c.kind for c in self.categories}
        for cat in self.categories:
            if cat.offsets and cat.kind != 'credit':
                raise ValueError(f'category {cat.name!r}: only credit categories can offset')
            if cat.offsets and kinds.get(cat.offsets) not in ('spending', *COST_KINDS):
                raise ValueError(f'category {cat.name!r} offsets {cat.offsets!r}, which is not '
                                 'a spending, annual, one_time or emergency category')
        investments = [v.id for v in self.investments]
        for acct in self.savings:
            if acct.overflow_to and acct.overflow_to not in investments:
                raise ValueError(f'savings {acct.name!r}: overflow_to {acct.overflow_to!r} is not '
                                 f'an investment id (known: {", ".join(investments) or "none"})')
        schools = self.assumptions.college.schools
        for child in self.household.children:
            if child.school not in schools:
                raise ValueError(f'child {child.name!r}: unknown school {child.school!r} '
                                 f'(known: {", ".join(schools)})')
        return self


def slugify(text: str) -> str:
    """Make a short lowercase key from a name.

    Args:
        text: Any label.

    Returns:
        Lowercase letters, digits and dashes, e.g. ``"Partner A" -> "partner-a"``.
    """
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-') or 'item'


#
# INTERNAL
#
def _assign_ids(items: list[Any], prefix: str) -> None:
    """Fill missing ``id`` fields from names and make all ids unique."""
    seen: set[str] = set()
    for i, item in enumerate(items):
        base = item.id or slugify(getattr(item, 'name', '') or f'{prefix}-{i + 1}')
        key, n = base, 2
        while key in seen:
            key, n = f'{base}-{n}', n + 1
        item.id = key
        seen.add(key)
