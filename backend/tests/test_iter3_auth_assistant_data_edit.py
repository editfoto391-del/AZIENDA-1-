# Iteration 3: Google-session auth, AI assistant SSE multi-turn, real data integrity, issued-invoice edit w/ change history
# SAFE for real data: read-only on opening-balance invoices; creates ONE TEST_ invoice (ABBAS QUMBO) which is voided at the end.
import os, json, time, uuid
from datetime import datetime, timedelta, timezone
import pytest, requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "2j2skp87z8@privaterelay.appleid.com"
ADMIN_PW = "iqfoam2026"
mdb = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))[os.environ.get("DB_NAME", "test_database")]


@pytest.fixture(scope="module")
def H():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="module")
def gsess():
    uid, tok = f"test-user-{uuid.uuid4().hex[:8]}", f"test_session_{uuid.uuid4().hex}"
    mdb.users.insert_one({"id": uid, "email": f"test.user.{uid}@example.com", "name": "Test User", "role": "admin"})
    mdb.user_sessions.insert_one({"user_id": uid, "session_token": tok, "expires_at": datetime.now(timezone.utc) + timedelta(days=7)})
    yield {"uid": uid, "tok": tok}
    mdb.users.delete_many({"id": uid}); mdb.user_sessions.delete_many({"user_id": uid})


def sse(H, message, sid=None, timeout=120):
    body = {"message": message}
    if sid: body["session_id"] = sid
    r = requests.post(f"{API}/assistant/chat", json=body, headers=H, stream=True, timeout=timeout)
    assert r.status_code == 200, r.text
    evs = []
    for line in r.iter_lines(decode_unicode=True):
        if line and line.startswith("data: "):
            evs.append(json.loads(line[6:]))
    return evs


# ---- Auth ----
class TestAuth:
    def test_login_and_me(self, H):
        r = requests.get(f"{API}/auth/me", headers=H)
        assert r.status_code == 200 and r.json()["email"] == ADMIN_EMAIL and "password_hash" not in r.json()

    def test_bad_login(self):
        assert requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": "x"}).status_code == 401

    def test_protected_no_auth(self):
        for p in ("/auth/me", "/invoices", "/assistant/sessions", "/settings", "/dashboard"):
            assert requests.get(f"{API}{p}").status_code == 401, p

    def test_google_bogus_session(self):
        r = requests.post(f"{API}/auth/google/session", json={"session_id": "bogus-123"})
        assert r.status_code == 401, r.text

    def test_session_token_bearer_and_cookie(self, gsess):
        r = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {gsess['tok']}"})
        assert r.status_code == 200 and r.json()["id"] == gsess["uid"]
        r = requests.get(f"{API}/auth/me", cookies={"session_token": gsess["tok"]})
        assert r.status_code == 200 and r.json()["id"] == gsess["uid"]

    def test_logout_clears_cookie(self):
        uid, tok = f"test-user-{uuid.uuid4().hex[:8]}", f"test_session_{uuid.uuid4().hex}"
        mdb.users.insert_one({"id": uid, "email": f"test.user.{uid}@example.com", "name": "T", "role": "admin"})
        mdb.user_sessions.insert_one({"user_id": uid, "session_token": tok, "expires_at": datetime.now(timezone.utc) + timedelta(days=1)})
        r = requests.post(f"{API}/auth/logout", cookies={"session_token": tok})
        assert r.status_code == 200
        sc = r.headers.get("set-cookie", "")
        assert "session_token=" in sc and ("Max-Age=0" in sc or "expires=" in sc.lower()), sc
        assert mdb.user_sessions.count_documents({"session_token": tok}) == 0
        assert requests.get(f"{API}/auth/me", cookies={"session_token": tok}).status_code == 401
        mdb.users.delete_many({"id": uid})

    def test_settings_allowlist_persist(self, H):
        s = requests.get(f"{API}/settings", headers=H).json()
        orig = list(s.get("google_allowed_emails", []))
        e = "test_allow@example.com"
        r = requests.put(f"{API}/settings", json={"google_allowed_emails": orig + [e]}, headers=H)
        assert r.status_code == 200
        assert e in requests.get(f"{API}/settings", headers=H).json()["google_allowed_emails"]
        requests.put(f"{API}/settings", json={"google_allowed_emails": orig}, headers=H)
        assert e not in requests.get(f"{API}/settings", headers=H).json()["google_allowed_emails"]


# ---- Real data ----
class TestData:
    def test_stock(self, H):
        st = requests.get(f"{API}/stock", headers=H).json()
        assert len(st) == 56
        def cur(p, s):
            it = next(x for x in st if x["product"] == p and x["size"] == s)
            return it.get("current", it.get("current_stock", it.get("on_hand")))
        assert cur("Simple", "910x100") == 660
        assert cur("Black", "1070x100") == 135
        assert cur("Ribbon", "1070x120") == 105

    def test_customers(self, H):
        cs = requests.get(f"{API}/customers", headers=H).json()
        assert len(cs) == 266
        assert not [c for c in cs if c["name"].upper().startswith("TEST")]
        assert sum(1 for c in cs if c["name"] == "FATIMA ADAM BIZANA") == 2

    def test_dashboard(self, H):
        d = requests.get(f"{API}/dashboard", headers=H).json()
        assert d["total_invoiced"] == 0, d.get("total_invoiced")
        assert d["outstanding"] == 905471.0, d.get("outstanding")

    def test_invoices(self, H):
        inv = [i for i in requests.get(f"{API}/invoices", headers=H).json() if not (i.get("reference") or "").startswith("TEST_")]
        assert len(inv) == 26 and all(i.get("opening_balance") for i in inv)
        nums = sorted(i["number"] for i in inv)
        assert nums == [f"IQF-2026-{n:04d}" for n in range(1, 27)]
        assert next(i for i in inv if i["number"] == "IQF-2026-0001")["customer_name"] == "AB WAKA WAKA"

    def test_ling_summary(self, H):
        c = next(c for c in requests.get(f"{API}/customers", headers=H).json() if c["name"] == "LING UMTHATHA")
        s = requests.get(f"{API}/customers/{c['id']}/summary", headers=H).json()
        assert s["outstanding"] == 400965 and s["total_invoiced"] == 0


# ---- Assistant ----
class TestAssistant:
    sid = None

    def test_empty(self, H):
        assert requests.post(f"{API}/assistant/chat", json={"message": "  "}, headers=H).status_code == 400

    def test_first_turn(self, H):
        evs = sse(H, "Who owes me the most? Answer briefly.")
        assert evs[0]["type"] == "session" and evs[-1]["type"] == "done"
        assert not [e for e in evs if e["type"] == "error"], evs
        text = "".join(e.get("content", "") for e in evs if e["type"] == "delta")
        assert "LING" in text.upper() and ("400 965" in text or "400,965" in text or "400965" in text), text
        TestAssistant.sid = evs[0]["session_id"]

    def test_follow_up(self, H):
        evs = sse(H, "How many opening balance invoices does that customer have? Just the customer's name and the number.", TestAssistant.sid)
        assert evs[0]["session_id"] == TestAssistant.sid
        text = "".join(e.get("content", "") for e in evs if e["type"] == "delta")
        print("FOLLOWUP:", text)
        assert "LING" in text.upper(), text

    def test_sessions_and_detail(self, H):
        ls = requests.get(f"{API}/assistant/sessions", headers=H).json()
        assert any(s["id"] == TestAssistant.sid for s in ls)
        d = requests.get(f"{API}/assistant/sessions/{TestAssistant.sid}", headers=H).json()
        assert [m["role"] for m in d["messages"]] == ["user", "assistant", "user", "assistant"]

    def test_delete(self, H):
        assert requests.delete(f"{API}/assistant/sessions/{TestAssistant.sid}", headers=H).status_code == 200
        assert requests.get(f"{API}/assistant/sessions/{TestAssistant.sid}", headers=H).status_code == 404


# ---- Invoice edit ----
def supervisor_authorization(H, iid, action="edit", target_id=None):
    if action == "edit":
        path = f"/invoices/{iid}/authorize-edit"
        body = {"password": ADMIN_PW}
    else:
        path = f"/invoices/{iid}/authorize-action"
        body = {"password": ADMIN_PW, "action": action, "target_id": target_id}
    response = requests.post(f"{API}{path}", json=body, headers=H)
    assert response.status_code == 200, response.text
    return response.json()["authorization_id"]


class TestInvoiceEdit:
    def test_edit_flow(self, H):
        c = next(c for c in requests.get(f"{API}/customers", headers=H).json() if c["name"] == "ABBAS QUMBO")
        base = {"customer_id": c["id"], "zone": 1, "reference": "TEST_backend_edit",
                "items": [{"qty": 2, "category": "Standard", "size": "910x100", "unit_price": 171}], "status": "issued"}
        r = requests.post(f"{API}/invoices", json=base, headers=H)
        assert r.status_code == 200, r.text
        inv = r.json(); iid, num = inv["id"], inv["number"]
        assert inv["total"] == 342
        # flag as opening balance temporarily to verify it is preserved
        mdb.invoices.update_one({"id": iid}, {"$set": {"opening_balance": True}})
        edit_body = {**base, "items": [{**base["items"][0], "qty": 3}], "edit_reason": "test qty"}
        assert requests.put(f"{API}/invoices/{iid}", json=edit_body, headers=H).status_code == 403
        edit_body["supervisor_authorization"] = supervisor_authorization(H, iid)
        r = requests.put(f"{API}/invoices/{iid}", json=edit_body, headers=H)
        assert r.status_code == 200, r.text
        e = r.json()
        assert e["number"] == num and e["total"] == 513 and e.get("opening_balance") is True
        last = e["audit"][-1]
        assert last["action"] == "edited" and last["reason"] == "test qty"
        fields = {ch["field"]: ch for ch in last["changes"]}
        assert "items" in fields and "total" in fields and fields["total"]["old"] == 342 and fields["total"]["new"] == 513
        g = requests.get(f"{API}/invoices/{iid}", headers=H).json()
        assert g["total"] == 513 and g["number"] == num
        edit_body = {**base, "opening_balance": False, "edit_reason": "convert balance",
                 "supervisor_authorization": supervisor_authorization(H, iid)}
        r = requests.put(f"{API}/invoices/{iid}", json=edit_body, headers=H)
        assert r.status_code == 200, r.text
        assert not r.json().get("opening_balance")
        mdb.invoices.update_one({"id": iid}, {"$unset": {"opening_balance": ""}})
        # pay 400, then edit below paid
        p = requests.post(f"{API}/invoices/{iid}/payments", json={"amount": 400}, headers=H)
        assert p.status_code == 200, p.text
        edit_body = {**base, "edit_reason": "below",
                 "supervisor_authorization": supervisor_authorization(H, iid)}
        r = requests.put(f"{API}/invoices/{iid}", json=edit_body, headers=H)
        assert r.status_code == 400 and "lower than payments" in r.text, r.text
        # reverse payment, void, edit voided
        pid = p.json()["id"]
        reverse_body = {"reason": "TEST cleanup"}
        assert requests.post(f"{API}/payments/{pid}/reverse", json=reverse_body, headers=H).status_code == 403
        reverse_body["supervisor_authorization"] = supervisor_authorization(H, iid, "reverse_payment", pid)
        assert requests.post(f"{API}/payments/{pid}/reverse", json=reverse_body, headers=H).status_code == 200
        void_body = {"reason": "TEST cleanup"}
        assert requests.post(f"{API}/invoices/{iid}/void", json=void_body, headers=H).status_code == 403
        void_body["supervisor_authorization"] = supervisor_authorization(H, iid, "void")
        assert requests.post(f"{API}/invoices/{iid}/void", json=void_body, headers=H).status_code == 200
        r = requests.put(f"{API}/invoices/{iid}", json={**base, "edit_reason": "x"}, headers=H)
        assert r.status_code == 400 and "void" in r.text.lower()
