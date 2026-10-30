# Phase A (P0 data-integrity) regression tests for SUPER IQ-FOAM ERP
import os
import time
import uuid
import subprocess
import concurrent.futures as cf
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
import requests


def _load_base():
    url = os.environ.get("REACT_APP_BACKEND_URL")
    if not url:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    url = line.split("=", 1)[1].strip()
    return url.rstrip("/")


BASE = _load_base()
API = f"{BASE}/api"
EMAIL = "2j2skp87z8@privaterelay.appleid.com"
PASSWORD = "iqfoam2026"
TZ = ZoneInfo("Africa/Johannesburg")


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    if r.status_code != 200:
        pytest.skip(f"login failed {r.status_code} {r.text}")
    return r.json()["token"]


@pytest.fixture(scope="session")
def s(token):
    ss = requests.Session()
    ss.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return ss


def authorize_invoice_action(s, invoice_id, action, target_id=None):
    response = s.post(f"{API}/invoices/{invoice_id}/authorize-action", json={
        "password": PASSWORD, "action": action, "target_id": target_id,
    })
    assert response.status_code == 200, response.text
    return response.json()["authorization_id"]


def authorize_expense_action(s, expense_id, action):
    if action == "create":
        path = f"{API}/expenses/authorize-create"
    else:
        path = f"{API}/expenses/{expense_id}/authorize-action"
    response = s.post(path, json={"password": PASSWORD, **({} if action == "create" else {"action": action})})
    assert response.status_code == 200, response.text
    return response.json()["authorization_id"]


def authorize_fleet_action(s, resource_type, action, resource_id=None, target_id=None):
    response = s.post(f"{API}/fleet-expense-authorizations", json={
        "password": PASSWORD, "resource_type": resource_type, "action": action,
        "resource_id": resource_id, "target_id": target_id,
    })
    assert response.status_code == 200, response.text
    return response.json()["authorization_id"]


@pytest.fixture(scope="session", autouse=True)
def cleanup_test_stock():
    """Owner's real stock must stay clean: delete every TEST_ stock item + its movements after the run."""
    yield
    from pymongo import MongoClient
    env = dict(l.strip().split("=", 1) for l in open("/app/backend/.env") if "=" in l)
    mdb = MongoClient(env["MONGO_URL"].strip('"'))[env["DB_NAME"].strip('"')]
    ids = [d["id"] for d in mdb.stock.find({"product": {"$regex": "^TEST_"}}, {"id": 1})]
    mdb.stock_movements.delete_many({"stock_id": {"$in": ids}})
    mdb.stock.delete_many({"id": {"$in": ids}})


@pytest.fixture(scope="session")
def customer(s):
    r = s.post(f"{API}/customers", json={"name": f"TEST_Cust_{uuid.uuid4().hex[:6]}", "city": "Mthatha", "default_zone": 1})
    assert r.status_code == 200, r.text
    return r.json()


def new_stock(s, opening=10):
    r = s.post(f"{API}/stock", json={"product": f"TEST_Prod_{uuid.uuid4().hex[:6]}", "size": "910x100", "opening": opening, "threshold": 1})
    assert r.status_code == 200, r.text
    return r.json()


def stock_current(s, sid):
    for it in s.get(f"{API}/stock").json():
        if it["id"] == sid:
            return it["current"]
    raise AssertionError("stock not found")


def issued_invoice(s, customer, items=None, **kw):
    body = {"customer_id": customer["id"], "zone": 1, "status": "issued",
            "items": items or [{"qty": 2, "description": "TEST_line", "unit_price": 100}], **kw}
    r = s.post(f"{API}/invoices", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# --- Auth (test 1)
class TestAuth:
    @pytest.mark.parametrize("path", ["/invoices", "/stock", "/expenses", "/payments", "/dashboard", "/audit"])
    def test_no_token_401(self, path):
        assert requests.get(f"{API}{path}", timeout=30).status_code == 401

    def test_bad_token_401(self):
        assert requests.get(f"{API}/invoices", headers={"Authorization": "Bearer xxx"}, timeout=30).status_code == 401

    def test_wrong_password_401(self):
        r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": "wrong"}, timeout=30)
        assert r.status_code in (400, 401)


# --- Invoice calc & numbering (tests 2,3)
class TestInvoiceCalc:
    def test_multiline_totals_and_number(self, s, customer):
        inv = issued_invoice(s, customer, items=[
            {"qty": 2, "category": "Standard", "size": "910x100", "unit_price": 171},
            {"qty": 3, "description": "TEST_custom", "unit_price": 116.50},
        ], discount=10, extra_charges=20)
        assert inv["items"][0]["line_total"] == 342.0
        assert inv["items"][1]["line_total"] == 349.50
        assert inv["subtotal"] == 691.50
        assert inv["total"] == 701.50
        assert inv["outstanding"] == 701.50
        assert inv["number"].isdigit() and len(inv["number"]) == 2
        inv2 = issued_invoice(s, customer)
        assert inv2["number"] != inv["number"]
        g = s.get(f"{API}/invoices/{inv['id']}").json()
        assert g["total"] == 701.50 and g["status"] == "issued"


class TestInvoiceStock:
    def test_submit_can_deduct_matching_stock(self, s, customer):
        stock = new_stock(s, opening=10)
        line = {"qty": 4, "category": stock["product"], "size": stock["size"],
                "unit_price": 100, "price_override": True}
        deducted = issued_invoice(s, customer, items=[line], deduct_stock=True)
        assert stock_current(s, stock["id"]) == 6
        movement = s.get(f"{API}/stock/movements").json()
        assert any(m.get("invoice_id") == deducted["id"] and m["type"] == "invoice" for m in movement)

        unchanged = issued_invoice(s, customer, items=[line], deduct_stock=False)
        assert stock_current(s, stock["id"]) == 6
        draft = s.post(f"{API}/invoices", json={"customer_id": customer["id"], "zone": 1,
                      "status": "draft", "items": [{**line, "qty": 2}]})
        assert draft.status_code == 200, draft.text
        issued_draft = s.post(f"{API}/invoices/{draft.json()['id']}/issue", json={"deduct_stock": True})
        assert issued_draft.status_code == 200, issued_draft.text
        assert stock_current(s, stock["id"]) == 4
        s.delete(f"{API}/invoices/{deducted['id']}")
        s.delete(f"{API}/invoices/{unchanged['id']}")
        s.delete(f"{API}/invoices/{draft.json()['id']}")

    def test_edit_reconciles_stock_and_archive_can_return_it(self, s, customer):
        stock = new_stock(s, opening=10)
        line = {"qty": 4, "category": stock["product"], "size": stock["size"],
                "unit_price": 100, "price_override": True}
        invoice = issued_invoice(s, customer, items=[line], deduct_stock=True)
        assert stock_current(s, stock["id"]) == 6

        edited_line = {**line, "qty": 3}
        edited = s.put(f"{API}/invoices/{invoice['id']}", json={
            "customer_id": customer["id"], "zone": 1, "status": "issued",
            "items": [edited_line], "deduct_stock": True,
        })
        assert edited.status_code == 200, edited.text
        assert stock_current(s, stock["id"]) == 7

        archived = s.delete(f"{API}/invoices/{invoice['id']}", params={"restore_stock": "true"})
        assert archived.status_code == 200, archived.text
        assert archived.json()["stock_restored"] is True
        assert stock_current(s, stock["id"]) == 10

    def test_submit_rejects_insufficient_stock_deduction(self, s, customer):
        stock = new_stock(s, opening=2)
        line = {"qty": 3, "category": stock["product"], "size": stock["size"],
                "unit_price": 100, "price_override": True}
        r = s.post(f"{API}/invoices", json={"customer_id": customer["id"], "zone": 1,
                      "status": "issued", "deduct_stock": True, "items": [line]})
        assert r.status_code == 400 and "Insufficient stock" in r.text
        assert stock_current(s, stock["id"]) == 2


# --- Price lookup (tests 4,5)
class TestPriceLookup:
    @pytest.mark.parametrize("zone,cat,size,price", [
        (1, "Standard", "910x100", 171), (2, "Standard", "910x100", 181),
        (1, "Candy", "760x100", 198), (2, "Candy", "910x100", 225)])
    def test_lookup(self, s, zone, cat, size, price):
        r = s.get(f"{API}/prices/lookup", params={"zone": zone, "category": cat, "size": size}).json()
        assert r["price"] == price, r

    @pytest.mark.parametrize("zone,cat", [(1, "Ribbon"), (2, "Ribbon Black & Pink"), (1, "Candy"), (2, "Candy")])
    def test_ribbon_1370_manual(self, s, zone, cat):
        r = s.get(f"{API}/prices/lookup", params={"zone": zone, "category": cat, "size": "1370x150"}).json()
        assert r["price"] is None and r["needs_config"] is True


# --- Missing price issue rules (test 6)
class TestMissingPrice:
    def test_ribbon_1370_issue_rejected(self, s, customer):
        r = s.post(f"{API}/invoices", json={"customer_id": customer["id"], "zone": 1, "status": "issued",
                   "items": [{"qty": 1, "category": "Ribbon", "size": "1370x150", "unit_price": 300}]})
        assert r.status_code == 400

    def test_zero_price_rejected(self, s, customer):
        r = s.post(f"{API}/invoices", json={"customer_id": customer["id"], "status": "issued",
                   "items": [{"qty": 1, "category": "Standard", "size": "910x100", "unit_price": 0}]})
        assert r.status_code == 400

    def test_override_accepted(self, s, customer):
        inv = issued_invoice(s, customer, items=[{"qty": 2, "category": "Ribbon", "size": "1370x150", "unit_price": 300, "price_override": True}])
        assert inv["total"] == 600.0 and inv["number"]

    def test_draft_with_missing_price(self, s, customer):
        r = s.post(f"{API}/invoices", json={"customer_id": customer["id"], "status": "draft",
                   "items": [{"qty": 1, "category": "Ribbon", "size": "1370x150", "unit_price": 0}]})
        assert r.status_code == 200 and r.json()["number"] is None
        # issuing that draft is rejected
        assert s.post(f"{API}/invoices/{r.json()['id']}/issue").status_code == 400
        assert s.delete(f"{API}/invoices/{r.json()['id']}").status_code == 200


# --- Price change does not alter issued invoice (test 7)
class TestPriceSnapshot:
    def test_price_edit_keeps_invoice(self, s, customer):
        inv = issued_invoice(s, customer, items=[{"qty": 1, "category": "Standard", "size": "910x100", "unit_price": 171}])
        p = next(x for x in s.get(f"{API}/prices").json() if x["zone"] == 1 and x["category"] == "Standard" and x["size"] == "910x100")
        body = {k: p[k] for k in ("zone", "category", "size", "price", "active", "confirmed")}
        try:
            assert s.put(f"{API}/prices/{p['id']}", json={**body, "price": 999}).status_code == 200
            g = s.get(f"{API}/invoices/{inv['id']}").json()
            assert g["items"][0]["unit_price"] == 171 and g["total"] == 171
        finally:
            assert s.put(f"{API}/prices/{p['id']}", json=body).status_code == 200
        assert s.get(f"{API}/prices/lookup", params={"zone": 1, "category": "Standard", "size": "910x100"}).json()["price"] == 171


# --- Payments (tests 8-11)
class TestPayments:
    def test_partial_full_over_reverse(self, s, customer):
        inv = issued_invoice(s, customer)  # total 200
        r = s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 50})
        assert r.status_code == 200
        g = s.get(f"{API}/invoices/{inv['id']}").json()
        assert g["outstanding"] == 150 and g["status"] == "partially_paid"
        assert s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 150.01}).status_code == 400
        p2 = s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 150})
        assert p2.status_code == 200
        g = s.get(f"{API}/invoices/{inv['id']}").json()
        assert g["status"] == "paid" and g["outstanding"] == 0
        # reverse
        pid = p2.json()["id"]
        assert s.post(f"{API}/payments/{pid}/reverse", json={"reason": ""}).status_code == 400
        reverse_body = {"reason": "TEST bounced"}
        assert s.post(f"{API}/payments/{pid}/reverse", json=reverse_body).status_code == 403
        reverse_body["supervisor_authorization"] = authorize_invoice_action(s, inv["id"], "reverse_payment", pid)
        assert s.post(f"{API}/payments/{pid}/reverse", json=reverse_body).status_code == 200
        g = s.get(f"{API}/invoices/{inv['id']}").json()
        assert g["amount_paid"] == 50 and g["outstanding"] == 150 and g["status"] == "partially_paid"
        assert s.post(f"{API}/payments/{pid}/reverse", json={"reason": "again"}).status_code == 400

    def test_pay_draft_400(self, s, customer):
        d = s.post(f"{API}/invoices", json={"customer_id": customer["id"], "status": "draft",
                   "items": [{"qty": 1, "description": "x", "unit_price": 10}]}).json()
        assert s.post(f"{API}/invoices/{d['id']}/payments", json={"amount": 5}).status_code == 400
        s.delete(f"{API}/invoices/{d['id']}")

    def test_idempotency(self, s, customer):
        inv = issued_invoice(s, customer)
        key = f"TEST_{uuid.uuid4().hex}"
        a = s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 40, "idempotency_key": key}).json()
        b = s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 40, "idempotency_key": key}).json()
        assert a["id"] == b["id"]
        assert s.get(f"{API}/invoices/{inv['id']}").json()["amount_paid"] == 40

    def test_idempotency_concurrent(self, s, customer):
        inv = issued_invoice(s, customer)
        key = f"TEST_{uuid.uuid4().hex}"
        with cf.ThreadPoolExecutor(3) as ex:
            res = list(ex.map(lambda _: s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 30, "idempotency_key": key}), range(3)))
        assert all(r.status_code in (200, 409) for r in res), [r.status_code for r in res]
        assert s.get(f"{API}/invoices/{inv['id']}").json()["amount_paid"] == 30


# --- Void / delete (tests 12)
class TestVoidDelete:
    def test_void_rules(self, s, customer):
        inv = issued_invoice(s, customer)
        assert s.post(f"{API}/invoices/{inv['id']}/void", json={}).status_code in (400, 422)
        assert s.post(f"{API}/invoices/{inv['id']}/void", json={"reason": "  "}).status_code == 400
        assert s.delete(f"{API}/invoices/{inv['id']}").status_code == 200
        assert all(item["id"] != inv["id"] for item in s.get(f"{API}/invoices").json())
        archived = s.get(f"{API}/invoices", params={"include_archived": "true"}).json()
        assert next(item for item in archived if item["id"] == inv["id"])["archived"] is True
        assert s.post(f"{API}/invoices/{inv['id']}/restore").status_code == 200
        p = s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 10}).json()
        assert s.post(f"{API}/invoices/{inv['id']}/void", json={"reason": "TEST"}).status_code == 400
        reverse_body = {"reason": "TEST"}
        assert s.post(f"{API}/payments/{p['id']}/reverse", json=reverse_body).status_code == 403
        reverse_body["supervisor_authorization"] = authorize_invoice_action(s, inv["id"], "reverse_payment", p["id"])
        assert s.post(f"{API}/payments/{p['id']}/reverse", json=reverse_body).status_code == 200
        void_body = {"reason": "TEST void"}
        assert s.post(f"{API}/invoices/{inv['id']}/void", json=void_body).status_code == 403
        void_body["supervisor_authorization"] = authorize_invoice_action(s, inv["id"], "void")
        r = s.post(f"{API}/invoices/{inv['id']}/void", json=void_body)
        assert r.status_code == 200
        assert s.get(f"{API}/invoices/{inv['id']}").json()["status"] == "void"
        assert s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 1}).status_code == 400

    def test_archive_restore_draft(self, s, customer):
        d = s.post(f"{API}/invoices", json={"customer_id": customer["id"], "status": "draft", "items": []}).json()
        archived = s.delete(f"{API}/invoices/{d['id']}")
        assert archived.status_code == 200 and archived.json()["archived"] is True
        assert all(i["id"] != d["id"] for i in s.get(f"{API}/invoices").json())
        retained = s.get(f"{API}/invoices", params={"include_archived": "true"}).json()
        assert next(i for i in retained if i["id"] == d["id"])["archived"] is True
        assert s.get(f"{API}/invoices/{d['id']}").json()["id"] == d["id"]
        assert s.post(f"{API}/invoices/{d['id']}/restore").status_code == 200
        assert s.get(f"{API}/invoices/{d['id']}").status_code == 404


# --- Stock ledger (tests 15,16)
class TestStockLedger:
    def test_movements(self, s):
        st = new_stock(s, 10)
        sid = st["id"]
        m = s.post(f"{API}/stock/{sid}/movements", json={"type": "adjustment_in", "quantity": 5})
        assert m.status_code == 200
        assert stock_current(s, sid) == 15
        for t in ("production", "dispatch", "foo"):
            assert s.post(f"{API}/stock/{sid}/movements", json={"type": t, "quantity": 1, "reason": "x"}).status_code == 400
        m = s.post(f"{API}/stock/{sid}/movements", json={"type": "adjustment_in", "quantity": 5, "reason": "TEST count"})
        assert m.status_code == 200
        assert stock_current(s, sid) == 20
        assert s.post(f"{API}/stock/{sid}/movements", json={"type": "damage", "quantity": 16, "reason": "x"}).status_code == 400
        assert stock_current(s, sid) == 20
        assert s.post(f"{API}/stock/{sid}/movements", json={"type": "damage", "quantity": 2, "reason": "TEST"}).status_code == 200
        assert s.post(f"{API}/stock/{sid}/movements", json={"type": "return", "quantity": 1, "reason": "TEST"}).status_code == 200
        assert s.post(f"{API}/stock/{sid}/movements", json={"type": "adjustment_out", "quantity": 1, "reason": "TEST"}).status_code == 200
        assert stock_current(s, sid) == 18
        mid = m.json()["id"]
        rv = s.post(f"{API}/stock/movements/{mid}/reverse", json={"reason": "TEST wrong"})
        assert rv.status_code == 200
        assert stock_current(s, sid) == 13
        assert s.post(f"{API}/stock/movements/{mid}/reverse", json={"reason": "again"}).status_code == 400
        assert stock_current(s, sid) == 8
        # opening locked
        r = s.put(f"{API}/stock/{sid}", json={"product": st["product"], "size": st["size"], "opening": 99, "threshold": 1})
        assert r.status_code == 400


# --- Delivery dispatch (tests 17,18)
class TestDispatch:
    def _delivery(self, s, sid, qty, status="Planned"):
        r = s.post(f"{API}/deliveries", json={"destination": "TEST_Dest", "status": status, "items": [{"stock_id": sid, "qty": qty}]})
        assert r.status_code == 200, r.text
        return r.json()

    def test_dispatch_once(self, s):
        sid = new_stock(s, 10)["id"]
        d = self._delivery(s, sid, 4)
        assert s.post(f"{API}/deliveries/{d['id']}/dispatch").status_code == 200
        assert stock_current(s, sid) == 6
        assert s.post(f"{API}/deliveries/{d['id']}/dispatch").status_code == 400
        assert stock_current(s, sid) == 6

    def test_dispatch_concurrent(self, s):
        sid = new_stock(s, 10)["id"]
        d = self._delivery(s, sid, 3)
        with cf.ThreadPoolExecutor(3) as ex:
            res = list(ex.map(lambda _: s.post(f"{API}/deliveries/{d['id']}/dispatch"), range(3)))
        assert sum(r.status_code == 200 for r in res) == 1, [r.status_code for r in res]
        assert stock_current(s, sid) == 7

    def test_dispatch_insufficient(self, s):
        sid = new_stock(s, 2)["id"]
        d = self._delivery(s, sid, 5)
        assert s.post(f"{API}/deliveries/{d['id']}/dispatch").status_code == 400
        assert stock_current(s, sid) == 2
        g = next(x for x in s.get(f"{API}/deliveries").json() if x["id"] == d["id"])
        assert g["dispatched"] is False and g["status"] != "Dispatched"

    def test_dispatch_cancelled(self, s):
        sid = new_stock(s, 10)["id"]
        d = self._delivery(s, sid, 1, status="Cancelled")
        assert s.post(f"{API}/deliveries/{d['id']}/dispatch").status_code == 400
        assert stock_current(s, sid) == 10


# --- Production rules (tests 22)
class TestProduction:
    def _t(self, hours_ago):
        return (datetime.now(TZ) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M")

    def test_weather_rules(self, s):
        base = {"block_ref": f"TEST_B_{uuid.uuid4().hex[:5]}", "production_time": self._t(1)}
        assert s.post(f"{API}/production", json={**base, "status": "Planned"}).status_code == 200
        assert s.post(f"{API}/production", json={**base, "status": "In Production"}).status_code == 400
        assert s.post(f"{API}/production", json={**base, "status": "In Production", "weather": "Unsuitable"}).status_code == 400
        assert s.post(f"{API}/production", json={**base, "status": "In Production", "weather": "Suitable", "rain_risk": True}).status_code == 400
        assert s.post(f"{API}/production", json={**base, "status": "In Production", "weather": "Unsuitable", "override_reason": "TEST tarp"}).status_code == 200
        assert s.post(f"{API}/production", json={**base, "status": "Bogus"}).status_code == 400

    def test_resting_and_receive(self, s):
        sid = new_stock(s, 0)["id"]
        early = s.post(f"{API}/production", json={"block_ref": "TEST_early", "status": "Ready for Cutting", "weather": "Suitable", "production_time": self._t(0)})
        assert early.status_code == 400 and "resting" in early.text.lower()
        rest = s.post(f"{API}/production", json={"block_ref": "TEST_rest", "status": "Resting", "weather": "Suitable", "production_time": self._t(0)})
        assert rest.status_code == 200 and rest.json()["rest_elapsed"] is False and rest.json()["ready_at"]
        assert s.post(f"{API}/production/{rest.json()['id']}/receive", json={"stock_id": sid, "quantity": 5}).status_code == 400
        ok = s.post(f"{API}/production", json={"block_ref": "TEST_ok", "status": "Ready for Cutting", "weather": "Caution", "production_time": self._t(13)})
        assert ok.status_code == 200 and ok.json()["rest_elapsed"] is True
        pid = ok.json()["id"]
        assert s.post(f"{API}/production/{pid}/receive", json={"stock_id": sid, "quantity": 5}).status_code == 200
        assert s.post(f"{API}/production/{pid}/receive", json={"stock_id": sid, "quantity": 5}).status_code == 400
        assert stock_current(s, sid) == 5


# --- Fleet & expenses counted once (tests 24)
class TestCosts:
    def _week_exp(self, s):
        return s.get(f"{API}/reports/profit").json()["week"]["expenses"]

    def test_vehicle_record_once(self, s):
        v = next(x for x in s.get(f"{API}/vehicles").json() if x["name"] == "Hino 300")
        before = self._week_exp(s)
        record_body = {"type": "repair", "description": "TEST_repair", "amount": 500, "status": "Done"}
        assert s.post(f"{API}/vehicles/{v['id']}/records", json=record_body).status_code == 403
        record_body["supervisor_authorization"] = authorize_fleet_action(s, "vehicle_record", "create", target_id=v["id"])
        r = s.post(f"{API}/vehicles/{v['id']}/records", json=record_body)
        assert r.status_code == 200
        assert round(self._week_exp(s) - before, 2) == 500
        n = s.post(f"{API}/vehicles/{v['id']}/records", json={"type": "maintenance", "description": "TEST_needed", "amount": 300, "status": "Needed"})
        assert n.status_code == 200
        assert round(self._week_exp(s) - before, 2) == 500
        # clean: cancel the done record
        cancel_body = {"reason": "TEST cleanup"}
        rid = r.json()["id"]
        assert s.post(f"{API}/vehicles/records/{rid}/cancel", json=cancel_body).status_code == 403
        cancel_body["supervisor_authorization"] = authorize_fleet_action(s, "vehicle_record", "cancel", resource_id=rid)
        s.post(f"{API}/vehicles/records/{rid}/cancel", json=cancel_body)
        assert round(self._week_exp(s) - before, 2) == 0

    def test_spare_part_once(self, s):
        v = next(x for x in s.get(f"{API}/vehicles").json() if x["name"] == "Hino 500")
        before = self._week_exp(s)
        p = s.post(f"{API}/spareparts", json={"name": f"TEST_part_{uuid.uuid4().hex[:5]}", "vehicle_id": v["id"], "expected_price": 100}).json()
        body = {"name": p["name"], "vehicle_id": v["id"], "quantity": 1, "expected_price": 100}
        missing_cost = {**body, "status": "bought"}
        missing_cost["supervisor_authorization"] = authorize_fleet_action(s, "spare_part", "edit", resource_id=p["id"])
        assert s.put(f"{API}/spareparts/{p['id']}", json=missing_cost).status_code == 400
        bought = {**body, "status": "bought", "actual_cost": 120}
        bought["supervisor_authorization"] = authorize_fleet_action(s, "spare_part", "edit", resource_id=p["id"])
        assert s.put(f"{API}/spareparts/{p['id']}", json=bought).status_code == 200
        installed = {**body, "status": "installed", "actual_cost": 120}
        installed["supervisor_authorization"] = authorize_fleet_action(s, "spare_part", "edit", resource_id=p["id"])
        assert s.put(f"{API}/spareparts/{p['id']}", json=installed).status_code == 200
        assert s.put(f"{API}/spareparts/{p['id']}", json={**body, "status": "to_buy", "actual_cost": 120}).status_code == 400
        exps = [e for e in s.get(f"{API}/expenses").json() if e.get("source_key") == f"sparepart:{p['id']}"]
        assert len(exps) == 1 and exps[0]["amount"] == 120 and exps[0]["category"] == "Vehicle"
        assert round(self._week_exp(s) - before, 2) == 120
        # linked expense cannot be voided twice / edited directly
        void_body = {"reason": "TEST cleanup"}
        assert s.post(f"{API}/expenses/{exps[0]['id']}/void", json=void_body).status_code == 403
        void_body["supervisor_authorization"] = authorize_expense_action(s, exps[0]["id"], "void")
        assert s.post(f"{API}/expenses/{exps[0]['id']}/void", json=void_body).status_code == 200

    def test_expense_rules(self, s):
        assert s.post(f"{API}/expenses", json={"description": "TEST_bad", "amount": 0}).status_code == 400
        assert s.post(f"{API}/expenses", json={"description": "TEST_neg", "amount": -5}).status_code == 400
        before = self._week_exp(s)
        expense_body = {"description": "TEST_exp", "amount": 77.7}
        assert s.post(f"{API}/expenses", json=expense_body).status_code == 403
        expense_body["supervisor_authorization"] = authorize_expense_action(s, None, "create")
        e = s.post(f"{API}/expenses", json=expense_body).json()
        assert round(self._week_exp(s) - before, 2) == 77.7
        assert s.delete(f"{API}/expenses/{e['id']}").status_code == 400
        assert s.post(f"{API}/expenses/{e['id']}/void", json={"reason": ""}).status_code == 400
        void_body = {"reason": "TEST"}
        assert s.post(f"{API}/expenses/{e['id']}/void", json=void_body).status_code == 403
        void_body["supervisor_authorization"] = authorize_expense_action(s, e["id"], "void")
        assert s.post(f"{API}/expenses/{e['id']}/void", json=void_body).status_code == 200
        assert round(self._week_exp(s) - before, 2) == 0
        assert all(x["id"] != e["id"] for x in s.get(f"{API}/expenses").json())

    def test_profit_shape(self, s):
        r = s.get(f"{API}/reports/profit").json()
        for k in ("today", "week", "month"):
            assert r[k]["label"] == "Estimated cash result — incomplete cost data"
        ws = datetime.fromisoformat(r["week_start"])
        assert ws.weekday() == 0
        assert r["week_start"] <= datetime.now(TZ).date().isoformat()

    def test_revenue_payment_dates_and_reversal(self, s, customer):
        before = s.get(f"{API}/reports/profit").json()["today"]["revenue"]
        inv = issued_invoice(s, customer)
        p = s.post(f"{API}/invoices/{inv['id']}/payments", json={"amount": 33}).json()
        assert round(s.get(f"{API}/reports/profit").json()["today"]["revenue"] - before, 2) == 33
        reverse_body = {"reason": "TEST"}
        reverse_body["supervisor_authorization"] = authorize_invoice_action(s, inv["id"], "reverse_payment", p["id"])
        s.post(f"{API}/payments/{p['id']}/reverse", json=reverse_body)
        assert round(s.get(f"{API}/reports/profit").json()["today"]["revenue"] - before, 2) == 0


# --- Dashboard / customer summary / audit
class TestDashboardSummaryAudit:
    def test_dashboard_keys(self, s):
        d = s.get(f"{API}/dashboard").json()
        for k in ("overdue", "week_profit", "month_profit", "orders_open_count", "urgent_orders", "vehicles_available", "maintenance_due", "completed_today"):
            assert k in d, k

    def test_customer_summary(self, s, customer):
        r = s.get(f"{API}/customers/{customer['id']}/summary").json()
        for k in ("total_invoiced", "payments_received", "outstanding", "overdue", "open_orders", "upcoming_deliveries"):
            assert k in r, k
        assert r["total_invoiced"] > 0

    def test_audit_entities(self, s):
        # create a price-audit entry independently of test order
        p = next(x for x in s.get(f"{API}/prices").json() if x["zone"] == 1 and x["category"] == "Standard" and x["size"] == "910x100")
        s.put(f"{API}/prices/{p['id']}", json={k: p[k] for k in ("zone", "category", "size", "price", "active", "confirmed")})
        for e in ("price", "payment", "invoice", "stock_movement"):
            assert len(s.get(f"{API}/audit", params={"entity": e}).json()) > 0, e


# --- Seeding idempotent (run last)
class TestZSeed:
    def test_restart_idempotent(self, s):
        def snap():
            cust = s.get(f"{API}/customers").json()
            return (len(cust), len(s.get(f"{API}/stock").json()), len(s.get(f"{API}/prices").json()), len(s.get(f"{API}/vehicles").json()))
        b = snap()
        subprocess.run(["sudo", "supervisorctl", "restart", "backend"], check=True, capture_output=True)
        for _ in range(30):
            time.sleep(2)
            try:
                if requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=10).status_code == 200:
                    break
            except Exception:
                pass
        assert snap() == b
        names = [c["name"] for c in s.get(f"{API}/customers").json()]
        for n in ("AB WAKA WAKA", "AL HASSAN"):
            assert names.count(n) == 1
        vn = [v["name"] for v in s.get(f"{API}/vehicles").json()]
        for n in ("Mighty Hyundai Truck", "Hino 500", "Hino 300", "Trailer (1)", "Trailer (2)", "Trailer (3)"):
            assert vn.count(n) == 1, n
        for n in ("Disk", "Truck", "Bakkie"):
            assert n not in vn
