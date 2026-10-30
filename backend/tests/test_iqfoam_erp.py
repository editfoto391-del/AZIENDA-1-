# Regression tests for SUPER IQ-FOAM ERP: auth, expenses/profit, fleet records, spare parts, orders, core invoice flow, attendance
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
EMAIL = "2j2skp87z8@privaterelay.appleid.com"
PASSWORD = "iqfoam2026"


@pytest.fixture(scope="session")
def client():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    if r.status_code != 200:
        pytest.skip("login failed")
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


def fleet_authorization(client, resource_type, action, resource_id=None, target_id=None):
    response = client.post(f"{BASE_URL}/api/fleet-expense-authorizations", json={
        "password": PASSWORD, "resource_type": resource_type, "action": action,
        "resource_id": resource_id, "target_id": target_id,
    })
    assert response.status_code == 200, response.text
    return response.json()["authorization_id"]


# --- Auth
def test_login_invalid():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": "wrong"})
    assert r.status_code == 401


def test_me_and_unauth(client):
    assert client.get(f"{BASE_URL}/api/auth/me").json()["email"] == EMAIL
    assert requests.get(f"{BASE_URL}/api/expenses").status_code == 401


# --- Dashboard
def test_dashboard_new_keys(client):
    d = client.get(f"{BASE_URL}/api/dashboard").json()
    for k in ("orders_to_send", "week_profit", "parts_to_buy_count"):
        assert k in d
    assert set(d["week_profit"].keys()) >= {"revenue", "expenses", "profit"}


# --- Expenses + profit
def test_expense_crud_and_profit(client):
    before = client.get(f"{BASE_URL}/api/reports/profit").json()
    expense_approval = client.post(f"{BASE_URL}/api/expenses/authorize-create", json={"password": PASSWORD})
    assert expense_approval.status_code == 200
    payload = {"description": "TEST_diesel", "amount": 123.45, "category": "Fuel",
               "supervisor_authorization": expense_approval.json()["authorization_id"]}
    r = client.post(f"{BASE_URL}/api/expenses", json=payload)
    assert r.status_code == 200
    e = r.json()
    assert e["amount"] == 123.45 and e["category"] == "Fuel" and "_id" not in e
    after = client.get(f"{BASE_URL}/api/reports/profit").json()
    assert round(after["week"]["expenses"] - before["week"]["expenses"], 2) == 123.45
    assert round(before["week"]["profit"] - after["week"]["profit"], 2) == 123.45
    assert round(after["total_expenses"] - before["total_expenses"], 2) == 123.45
    edit_payload = {"description": "TEST_diesel2", "amount": 200, "category": "Fuel", "date": e["date"],
                    "edit_reason": "Correct fuel expense", "supervisor_authorization": ""}
    assert client.put(f"{BASE_URL}/api/expenses/{e['id']}", json=edit_payload).status_code == 403
    edit_approval = client.post(f"{BASE_URL}/api/expenses/{e['id']}/authorize-action", json={
        "password": PASSWORD, "action": "edit",
    })
    assert edit_approval.status_code == 200
    edit_payload["supervisor_authorization"] = edit_approval.json()["authorization_id"]
    u = client.put(f"{BASE_URL}/api/expenses/{e['id']}", json=edit_payload)
    assert u.status_code == 200 and u.json()["amount"] == 200
    lst = client.get(f"{BASE_URL}/api/expenses").json()
    assert any(x["id"] == e["id"] and x["description"] == "TEST_diesel2" for x in lst)
    assert client.delete(f"{BASE_URL}/api/expenses/{e['id']}").status_code == 400
    void_approval = client.post(f"{BASE_URL}/api/expenses/{e['id']}/authorize-action", json={
        "password": PASSWORD, "action": "void",
    })
    assert void_approval.status_code == 200
    void = client.post(f"{BASE_URL}/api/expenses/{e['id']}/void", json={
        "reason": "TEST cleanup", "supervisor_authorization": void_approval.json()["authorization_id"],
    })
    assert void.status_code == 200
    assert not any(x["id"] == e["id"] for x in client.get(f"{BASE_URL}/api/expenses").json())
    final = client.get(f"{BASE_URL}/api/reports/profit").json()
    assert final["week"]["expenses"] == before["week"]["expenses"]


def test_expense_edit_nonexistent_404(client):
    r = client.put(f"{BASE_URL}/api/expenses/nope", json={"description": "x", "amount": 1})
    assert r.status_code == 404


def test_expense_negative_amount_rejected(client):
    r = client.post(f"{BASE_URL}/api/expenses", json={"description": "TEST_neg", "amount": -50})
    if r.status_code == 200:
        client.delete(f"{BASE_URL}/api/expenses/{r.json()['id']}")
    assert r.status_code in (400, 422), "backend accepts negative expense amounts"


# --- Fleet
def test_fleet_seeded(client):
    names = {v["name"] for v in client.get(f"{BASE_URL}/api/vehicles").json()}
    for n in ("Bakkie", "Disk", "Truck"):
        assert n in names
    assert len(names) >= 6


def test_global_owner_worker_scope_and_stock_only_costs(client):
    company_id = "superiqfoam"
    suffix = uuid.uuid4().hex[:8]
    username = f"TEST_stock_{suffix}"
    stock = client.post(f"{BASE_URL}/api/stock", json={
        "product": f"TEST_stock_{suffix}", "size": "1x1", "opening": 1,
        "threshold": 0, "unit_cost": 77.25,
    })
    assert stock.status_code == 200, stock.text
    stock_id = stock.json()["id"]
    worker = None
    try:
        created = client.post(f"{BASE_URL}/api/access/workers", json={
            "username": username, "name": "TEST Stock Controller", "worker_role": "Stock Controller",
            "password": "stocktest2026", "company_id": company_id,
            "allowed_sections": ["stock", "expenses"], "stock_only": True,
        })
        assert created.status_code == 200, created.text
        worker = created.json()
        assert worker["allowed_sections"] == ["stock"] and worker["stock_only"] is True

        login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "username": username, "password": "stocktest2026", "company_id": company_id,
        })
        assert login.status_code == 200, login.text
        sub_user = requests.Session()
        sub_user.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
        assert sub_user.get(f"{BASE_URL}/api/access/workers").status_code == 403
        stock_list = sub_user.get(f"{BASE_URL}/api/stock")
        assert stock_list.status_code == 200, stock_list.text
        stock_row = next(item for item in stock_list.json() if item["id"] == stock_id)
        assert "unit_cost" not in stock_row

        update = sub_user.put(f"{BASE_URL}/api/stock/{stock_id}", json={
            "product": stock_row["product"], "size": stock_row["size"], "opening": 1,
            "threshold": 0, "unit_cost": 0.01,
        })
        assert update.status_code == 200, update.text
        assert "unit_cost" not in update.json()
        owner_stock = client.get(f"{BASE_URL}/api/stock").json()
        assert next(item for item in owner_stock if item["id"] == stock_id)["unit_cost"] == 77.25
        assert sub_user.get(f"{BASE_URL}/api/reports/costs").status_code == 403
        assert sub_user.delete(f"{BASE_URL}/api/stock/{stock_id}").status_code == 403
    finally:
        if worker:
            client.delete(f"{BASE_URL}/api/access/workers/{worker['id']}?company_id={company_id}")
        client.delete(f"{BASE_URL}/api/stock/{stock_id}")


def test_vehicle_create_edit(client):
    r = client.post(f"{BASE_URL}/api/vehicles", json={"name": "TEST_Van", "vtype": "Other"})
    assert r.status_code == 200
    v = r.json()
    u = client.put(f"{BASE_URL}/api/vehicles/{v['id']}", json={"name": "TEST_Van2", "vtype": "Truck", "length": "6 m"})
    assert u.json()["name"] == "TEST_Van2" and u.json()["length"] == "6 m"
    deleted = client.delete(f"{BASE_URL}/api/vehicles/{v['id']}")
    assert deleted.status_code == 200 and deleted.json()["archived"] is True
    assert v["id"] not in {vehicle["id"] for vehicle in client.get(f"{BASE_URL}/api/vehicles").json()}


def test_vehicle_records_and_profit(client):
    v = client.get(f"{BASE_URL}/api/vehicles").json()[0]
    before = client.get(f"{BASE_URL}/api/reports/profit").json()
    ids = []
    for t, amt in (("expense", 100), ("repair", 50), ("maintenance", 25)):
        payload = {"type": t, "description": f"TEST_{t}", "amount": amt}
        assert client.post(f"{BASE_URL}/api/vehicles/{v['id']}/records", json=payload).status_code == 403
        payload["supervisor_authorization"] = fleet_authorization(client, "vehicle_record", "create", target_id=v["id"])
        r = client.post(f"{BASE_URL}/api/vehicles/{v['id']}/records", json=payload)
        assert r.status_code == 200 and r.json()["vehicle_name"] == v["name"]
        ids.append(r.json()["id"])
    recs = client.get(f"{BASE_URL}/api/vehicles/{v['id']}/records").json()
    assert all(i in [x["id"] for x in recs] for i in ids)
    after = client.get(f"{BASE_URL}/api/reports/profit").json()
    assert round(after["week"]["expenses"] - before["week"]["expenses"], 2) == 175
    for i in ids:
        cancel = {"reason": "TEST cleanup"}
        assert client.post(f"{BASE_URL}/api/vehicles/records/{i}/cancel", json=cancel).status_code == 403
        cancel["supervisor_authorization"] = fleet_authorization(client, "vehicle_record", "cancel", resource_id=i)
        assert client.post(f"{BASE_URL}/api/vehicles/records/{i}/cancel", json=cancel).status_code == 200
    all_ids = [x["id"] for x in client.get(f"{BASE_URL}/api/vehicles/records/all").json()]
    assert not any(i in all_ids for i in ids)


# --- Spare parts
def test_spareparts_flow(client):
    d0 = client.get(f"{BASE_URL}/api/dashboard").json()["parts_to_buy_count"]
    r = client.post(f"{BASE_URL}/api/spareparts", json={"name": "TEST_filter", "quantity": 2, "expected_price": 150})
    p = r.json()
    assert r.status_code == 200 and p["status"] == "to_buy"
    assert client.get(f"{BASE_URL}/api/dashboard").json()["parts_to_buy_count"] == d0 + 1
    for st in ("bought", "installed"):
        payload = {**p, "status": st, "actual_cost": 300}
        payload["supervisor_authorization"] = fleet_authorization(client, "spare_part", "edit", resource_id=p["id"])
        u = client.put(f"{BASE_URL}/api/spareparts/{p['id']}", json=payload)
        assert u.json()["status"] == st
    assert client.delete(f"{BASE_URL}/api/spareparts/{p['id']}").status_code == 200
    assert not any(x["id"] == p["id"] for x in client.get(f"{BASE_URL}/api/spareparts").json())


# --- Orders
def test_orders_flow(client):
    cust = client.get(f"{BASE_URL}/api/customers").json()[0]
    r = client.post(f"{BASE_URL}/api/orders", json={"customer_id": cust["id"], "destination": "TEST_City", "products": "5 x foam", "priority": "High"})
    o = r.json()
    assert r.status_code == 200 and o["customer_name"] == cust["name"] and o["reference"].startswith("ORD-")
    dash = client.get(f"{BASE_URL}/api/dashboard").json()
    assert any(x["id"] == o["id"] for x in dash["orders_to_send"])
    u = client.put(f"{BASE_URL}/api/orders/{o['id']}", json={**o, "status": "Dispatched"})
    assert u.json()["status"] == "Dispatched" and u.json()["reference"] == o["reference"]
    dash = client.get(f"{BASE_URL}/api/dashboard").json()
    assert not any(x["id"] == o["id"] for x in dash["orders_to_send"])
    assert client.delete(f"{BASE_URL}/api/orders/{o['id']}").status_code == 200
    assert client.put(f"{BASE_URL}/api/orders/{o['id']}", json=o).status_code == 404


def test_order_reference_unique_after_delete(client):
    a = client.post(f"{BASE_URL}/api/orders", json={"customer_name": "TEST_A", "destination": "X"}).json()
    b = client.post(f"{BASE_URL}/api/orders", json={"customer_name": "TEST_B", "destination": "X"}).json()
    client.delete(f"{BASE_URL}/api/orders/{a['id']}")
    c = client.post(f"{BASE_URL}/api/orders", json={"customer_name": "TEST_C", "destination": "X"}).json()
    client.delete(f"{BASE_URL}/api/orders/{b['id']}")
    client.delete(f"{BASE_URL}/api/orders/{c['id']}")
    assert c["reference"] != b["reference"], f"duplicate order reference {c['reference']}"


# --- Core flow regression
def test_core_invoice_payment_dispatch(client):
    c = client.post(f"{BASE_URL}/api/customers", json={"name": "TEST_Customer"}).json()
    inv = client.post(f"{BASE_URL}/api/invoices", json={"customer_id": c["id"], "items": [{"qty": 2, "description": "foam", "unit_price": 100}]}).json()
    assert inv["status"] == "draft" and inv["total"] == 200
    iss = client.post(f"{BASE_URL}/api/invoices/{inv['id']}/issue").json()
    assert iss["number"] and iss["status"] == "issued"
    over = client.post(f"{BASE_URL}/api/invoices/{inv['id']}/payments", json={"amount": 500})
    assert over.status_code == 400
    p = client.post(f"{BASE_URL}/api/invoices/{inv['id']}/payments", json={"amount": 50})
    assert p.status_code == 200
    g = client.get(f"{BASE_URL}/api/invoices/{inv['id']}").json()
    assert g["status"] == "partially_paid" and g["outstanding"] == 150
    stock = client.get(f"{BASE_URL}/api/stock").json()[0]
    d = client.post(f"{BASE_URL}/api/deliveries", json={"customer_id": c["id"], "destination": "TEST", "items": [{"stock_id": stock["id"], "qty": 1}]}).json()
    assert client.post(f"{BASE_URL}/api/deliveries/{d['id']}/dispatch").status_code == 200
    s2 = [s for s in client.get(f"{BASE_URL}/api/stock").json() if s["id"] == stock["id"]][0]
    assert round(stock["current"] - s2["current"], 2) == 1
    assert client.post(f"{BASE_URL}/api/deliveries/{d['id']}/dispatch").status_code == 400
    # Reverse the payment and void only with supervisor approval.
    pid = p.json()["id"]
    reverse_approval = client.post(f"{BASE_URL}/api/invoices/{inv['id']}/authorize-action", json={
        "password": PASSWORD, "action": "reverse_payment", "target_id": pid,
    }).json()["authorization_id"]
    reverse = client.post(f"{BASE_URL}/api/payments/{pid}/reverse", json={
        "reason": "TEST cleanup", "supervisor_authorization": reverse_approval,
    })
    assert reverse.status_code == 200
    void_approval = client.post(f"{BASE_URL}/api/invoices/{inv['id']}/authorize-action", json={
        "password": PASSWORD, "action": "void",
    }).json()["authorization_id"]
    void = client.post(f"{BASE_URL}/api/invoices/{inv['id']}/void", json={
        "reason": "TEST cleanup", "supervisor_authorization": void_approval,
    })
    assert void.status_code == 200 and void.json()["status"] == "void"


# --- Attendance summary
def test_attendance_summary(client):
    emp = client.post(f"{BASE_URL}/api/employees", json={"name": "TEST_Emp"}).json()
    from datetime import date
    client.post(f"{BASE_URL}/api/attendance", json={"employee_id": emp["id"], "date": date.today().isoformat(), "status": "Present"})
    s = client.get(f"{BASE_URL}/api/attendance/summary").json()
    e = [x for x in s["per_employee"] if x["employee_id"] == emp["id"]][0]
    assert e["week"] == 1 and e["month"] == 1
    assert s["daily"].get("Present", 0) >= 1
    client.put(f"{BASE_URL}/api/employees/{emp['id']}", json={"name": "TEST_Emp", "active": False})
