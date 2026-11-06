"""
Server

The local web server: serves the built web app and a small JSON API for the plan's data, settings
and categorization. It only listens on 127.0.0.1. Requests that change anything must carry the
``X-Financial-Planner`` header, which browsers won't send cross-site without a CORS preflight that
this server never approves, so other websites can't write to a plan.

License: BSD 3-Clause
"""
#
# Imports
#
import re
from pathlib import Path
from urllib.parse import quote
from typing import Any, Awaitable, Callable

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from financial_planner.config import (DATA_DIR, ConfigError, format_validation_error,
                                      load_config, load_config_raw, save_section)
from financial_planner.rules import preview
from financial_planner.schema import Rule, Source
from financial_planner.share import archive_name, export_bytes
from financial_planner.sources import SourceError, inspect_csv, read_source_file, resolve_files
from financial_planner.state import read_state, write_state_key
from financial_planner.summary import build_payload, load_plan, transaction_rows

#
# CONSTANTS
#
WEB_DIR: Path = Path(__file__).parent / 'web'
WRITE_HEADER: str = 'x-financial-planner'
LOCAL_HOSTS: tuple[str, ...] = ('127.0.0.1', 'localhost', 'testserver')
SAFE_NAME_RE: re.Pattern[str] = re.compile(r'[^A-Za-z0-9._ -]')
PREVIEW_ROWS: int = 12


#
# PUBLIC
#
def create_app(plan_dir: Path) -> FastAPI:
    """Build the app for one plan folder.

    Args:
        plan_dir: The plan folder.

    Returns:
        The FastAPI application.
    """
    plan_dir = Path(plan_dir).resolve()
    app = FastAPI(title='Financial Planner', docs_url=None, redoc_url=None)
    app.state.plan_dir = plan_dir

    @app.middleware('http')
    async def guard(request: Request,
                    call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        """Only answer local hosts; require the app header on writes."""
        host = (request.headers.get('host') or '').rsplit(':', 1)[0].strip('[]')
        if host not in LOCAL_HOSTS:
            return JSONResponse({'error': 'not allowed'}, status_code=403)
        if request.method not in ('GET', 'HEAD') and not request.headers.get(WRITE_HEADER):
            return JSONResponse({'error': 'missing app header'}, status_code=403)
        return await call_next(request)

    @app.get('/api/payload')
    def payload() -> dict[str, Any]:
        """Everything the main page needs."""
        return build_payload(plan_dir)

    @app.get('/api/config')
    def get_config() -> dict[str, Any]:
        """The raw merged config, which file each section is in, and any validation error."""
        loaded = load_config_raw(plan_dir)
        try:
            load_config(plan_dir)
            error = None
        except ConfigError as err:
            error = str(err)
        return {'raw': loaded.raw, 'owners': {k: v.name for k, v in loaded.owners.items()},
                'error': error, 'plan_dir': str(plan_dir), 'files': _data_files(plan_dir)}

    @app.put('/api/config/{section}')
    def put_config(section: str, value: Any = Body(...)) -> dict[str, Any]:
        """Save one top-level config section."""
        if not re.fullmatch(r'[a-z_]+', section):
            raise HTTPException(400, 'bad section name')
        try:
            path = save_section(plan_dir, section, value)
        except ConfigError as err:
            raise HTTPException(400, str(err)) from err
        return {'ok': True, 'file': path.name}

    @app.get('/api/transactions')
    def transactions() -> dict[str, Any]:
        """Every transaction with its category and the rule that set it."""
        try:
            data = load_plan(plan_dir)
        except ConfigError as err:
            raise HTTPException(400, str(err)) from err
        return {'rows': transaction_rows(data), 'rules': data.loaded.raw.get('rules') or [],
                'categories': [c.model_dump() for c in data.categories],
                'sources': [s.name for s in data.config.sources], 'months': data.months}

    @app.post('/api/rules/preview')
    def rule_preview(rule: dict[str, Any] = Body(...)) -> dict[str, Any]:
        """What a candidate rule would match and change."""
        try:
            candidate = Rule.model_validate(_clean_rule(rule))
            data = load_plan(plan_dir)
        except ValidationError as err:
            raise HTTPException(400, format_validation_error(err)) from err
        except ConfigError as err:
            raise HTTPException(400, str(err)) from err
        result = preview(candidate, data.transactions, data.config)
        by_id = {t.id: t for t in data.transactions}
        current = {t.id: a.category for t, a in zip(data.transactions, data.assignments)}
        sample = [{'id': i, 'date': by_id[i].date, 'description': by_id[i].description,
                   'amount': by_id[i].amount, 'category': current[i]}
                  for i in result['matched'][:PREVIEW_ROWS]]
        return {'matched': len(result['matched']), 'changed': len(result['changed']),
                'blocked': len(result['blocked']), 'sample': sample}

    @app.post('/api/rules')
    def add_rule(rule: dict[str, Any] = Body(...)) -> dict[str, Any]:
        """Add a rule. Row rules replace an older row rule for the same row; others go first."""
        try:
            new = Rule.model_validate(_clean_rule(rule)).model_dump(exclude_none=True,
                                                                    exclude_defaults=True)
        except ValidationError as err:
            raise HTTPException(400, format_validation_error(err)) from err
        new['category'] = rule['category']
        rules = list(load_config_raw(plan_dir).raw.get('rules') or [])
        if new.get('row'):
            rules = [r for r in rules if r.get('row') != new['row']] + [new]
        else:
            rules.insert(0, new)
        try:
            path = save_section(plan_dir, 'rules', rules)
        except ConfigError as err:
            raise HTTPException(400, str(err)) from err
        return {'ok': True, 'file': path.name, 'count': len(rules)}

    @app.get('/api/files')
    def files() -> dict[str, Any]:
        """CSV files in the plan's data folder."""
        return {'files': _data_files(plan_dir)}

    @app.post('/api/files')
    async def upload(request: Request, name: str = Query(...)) -> dict[str, Any]:
        """Save an uploaded CSV into the data folder (raw request body)."""
        safe = SAFE_NAME_RE.sub('_', Path(name).name).strip() or 'upload.csv'
        if not safe.lower().endswith('.csv'):
            safe += '.csv'
        dest = plan_dir / DATA_DIR / safe
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(await request.body())
        return {'ok': True, 'file': f'{DATA_DIR}/{safe}'}

    @app.get('/api/inspect')
    def inspect(file: str, skip_rows: int = 0, delimiter: str = ',',
                encoding: str = 'utf-8-sig') -> dict[str, Any]:
        """Columns, sample rows and guesses for a CSV in the plan folder."""
        path = _inside(plan_dir, file)
        try:
            return inspect_csv(path, encoding, delimiter, skip_rows)
        except SourceError as err:
            raise HTTPException(400, str(err)) from err

    @app.post('/api/sources/preview')
    def source_preview(source: dict[str, Any] = Body(...)) -> dict[str, Any]:
        """Parse a source's files with unsaved settings and show the first rows."""
        try:
            src = Source.model_validate(source)
        except ValidationError as err:
            raise HTTPException(400, format_validation_error(err)) from err
        paths = resolve_files(plan_dir, src.files)
        if not paths:
            raise HTTPException(400, f'no files match {", ".join(src.files)}')
        rows, skipped, errors = [], 0, []
        for path in paths:
            try:
                got, n = read_source_file(path, src)
            except SourceError as err:
                errors.append(str(err))
                continue
            rows.extend(got)
            skipped += n
        rows.sort(key=lambda t: t.date, reverse=True)
        return {'files': [str(p.relative_to(plan_dir)) for p in paths], 'count': len(rows),
                'skipped': skipped, 'errors': errors,
                'sample': [{'date': t.date, 'description': t.description, 'amount': t.amount,
                            'bank_category': t.bank_category} for t in rows[:PREVIEW_ROWS]]}

    @app.get('/api/plan/export')
    def export(state: bool = True) -> Response:
        """The whole plan as one .zip file (to send to someone)."""
        title = (load_config_raw(plan_dir).raw.get('plan') or {}).get('title') or 'Financial Plan'
        name = archive_name(str(title))
        data = export_bytes(plan_dir, include_state=state, top=name[:-4])
        return Response(data, media_type='application/zip', headers={
            'Content-Disposition': f"attachment; filename*=UTF-8''{quote(name)}",
            'Cache-Control': 'no-store'})

    @app.get('/api/state')
    def get_state() -> dict[str, Any]:
        """Saved planner edits and scenarios."""
        return read_state(plan_dir)

    @app.put('/api/state/{key}')
    def put_state(key: str, value: Any = Body(None)) -> dict[str, Any]:
        """Save one part of the app state."""
        try:
            write_state_key(plan_dir, key, value)
        except ValueError as err:
            raise HTTPException(400, str(err)) from err
        return {'ok': True}

    @app.get('/')
    def index() -> FileResponse:
        """The app page."""
        page = WEB_DIR / 'index.html'
        if not page.exists():
            raise HTTPException(500, 'the web app is not built; run "pixi run web-build"')
        return FileResponse(page, headers={'Cache-Control': 'no-store'})

    if WEB_DIR.is_dir():
        app.mount('/static', StaticFiles(directory=WEB_DIR), name='static')
    return app


#
# INTERNAL
#
def _data_files(plan_dir: Path) -> list[str]:
    """CSV files under data/, relative to the plan folder."""
    data = plan_dir / DATA_DIR
    if not data.is_dir():
        return []
    return sorted(str(p.relative_to(plan_dir)) for p in data.rglob('*')
                  if p.is_file() and p.suffix.lower() in ('.csv', '.txt'))


def _inside(plan_dir: Path, rel: str) -> Path:
    """Resolve a path and refuse anything outside the plan folder."""
    path = (plan_dir / rel).resolve()
    if not path.is_relative_to(plan_dir) or not path.is_file():
        raise HTTPException(400, f'no such file in the plan folder: {rel}')
    return path


def _clean_rule(rule: dict[str, Any]) -> dict[str, Any]:
    """Drop empty values the editor sends for unused fields."""
    return {k: v for k, v in rule.items() if v not in (None, '')}
