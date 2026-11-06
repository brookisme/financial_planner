"""
Server Tests

The JSON API, its write guard and state storage.

License: BSD 3-Clause
"""
#
# Imports
#
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from financial_planner.config import load_config
from financial_planner.server import create_app

#
# CONSTANTS
#
HEADERS: dict[str, str] = {'X-Financial-Planner': '1'}


#
# PUBLIC
#
@pytest.fixture
def client(plan_dir: Path) -> TestClient:
    """A test client for the small plan."""
    return TestClient(create_app(plan_dir))


def test_payload(client: TestClient) -> None:
    body = client.get('/api/payload').json()
    assert body['error'] is None and body['months'] == ['2025-01', '2025-02']


def test_writes_need_the_app_header(client: TestClient) -> None:
    assert client.put('/api/state/ui', json={'a': 1}).status_code == 403
    assert client.put('/api/state/ui', json={'a': 1}, headers=HEADERS).status_code == 200
    assert client.get('/api/state').json() == {'ui': {'a': 1}}


def test_other_hosts_are_refused(client: TestClient) -> None:
    assert client.get('/api/payload', headers={'host': 'evil.example'}).status_code == 403


def test_unknown_state_key(client: TestClient) -> None:
    assert client.put('/api/state/nope', json=1, headers=HEADERS).status_code == 400


def test_config_get_and_put(client: TestClient, plan_dir: Path) -> None:
    body = client.get('/api/config').json()
    assert body['owners']['rules'] == 'rules.yaml' and body['error'] is None
    assert body['files'] == ['data/bank_2025.csv', 'data/card.csv']
    plan = dict(body['raw']['plan'], title='From the GUI')
    assert client.put('/api/config/plan', json=plan, headers=HEADERS).json()['file'] == \
        'config.yaml'
    assert load_config(plan_dir).config.plan.title == 'From the GUI'
    bad = client.put('/api/config/plan', json={'months': 0}, headers=HEADERS)
    assert bad.status_code == 400 and 'plan.months' in bad.json()['detail']


def test_transactions_and_rule_preview(client: TestClient) -> None:
    rows = client.get('/api/transactions').json()['rows']
    taco = next(r for r in rows if 'TACO' in r['description'])
    assert taco['category'] == 'Dining' and taco['how'] == 'bank'
    prev = client.post('/api/rules/preview', headers=HEADERS,
                       json={'category': 'Dining', 'similar_to': 'FRESH FIELDS MARKET',
                             'contains': ''}).json()
    assert prev['matched'] == 2 and prev['changed'] == 2
    bad = client.post('/api/rules/preview', headers=HEADERS, json={'category': 'X'})
    assert bad.status_code == 400


def test_add_rules(client: TestClient, plan_dir: Path) -> None:
    rows = client.get('/api/transactions').json()['rows']
    taco = next(r for r in rows if 'TACO' in r['description'])
    for cat in ('Coffee', 'Groceries'):
        assert client.post('/api/rules', headers=HEADERS,
                           json={'category': cat, 'row': taco['id']}).status_code == 200
    rules = load_config(plan_dir).config.rules
    assert [r.category for r in rules if r.row] == ['Groceries']      # replaced, not duplicated
    client.post('/api/rules', headers=HEADERS, json={'category': 'Dining', 'contains': 'BEAN'})
    assert load_config(plan_dir).config.rules[0].contains == 'BEAN'    # new rules go first
    rows = client.get('/api/transactions').json()['rows']
    assert next(r for r in rows if r['id'] == taco['id'])['category'] == 'Groceries'


def test_upload_inspect_and_source_preview(client: TestClient) -> None:
    up = client.post('/api/files?name=../../evil name.csv', headers=HEADERS,
                     content=b'When,What,How much\n2025-03-01,Thing,-5.00\n')
    assert up.json()['file'] == 'data/evil name.csv'
    info = client.get('/api/inspect', params={'file': 'data/evil name.csv'}).json()
    assert info['guess']['date'] == 'When'
    assert client.get('/api/inspect', params={'file': '../outside.csv'}).status_code == 400
    prev = client.post('/api/sources/preview', headers=HEADERS, json={
        'name': 'New', 'files': 'data/evil name.csv', 'date': {'column': 'When'},
        'description': 'What', 'amount': {'column': 'How much'}}).json()
    assert prev['count'] == 1 and prev['sample'][0]['amount'] == 5.0
