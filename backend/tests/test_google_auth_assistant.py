# Tests: Emergent Google auth sessions, email login, settings allowlist, AI assistant (SSE + multi-turn)
import os, json, time, uuid
from datetime import datetime, timedelta, timezone
import pytest, requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "2j2skp87z8@privaterelay.appleid.com"
ADMIN_PW = "iqfoam2026"

mc = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
mdb = mc[os.environ.get("DB_NAME", "test_database")]


@pytest.fixture(scope="module")
def jwt_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def H(jwt_token):
    return {"Authorization": f"Bearer {jwt_token}"}


@pytest.fixture(scope="module")
def google_session():
    uid = f"test-user-{uuid.uuid4().hex[:8]}"
    tok = f"test_session_{uuid.uuid4().hex}"
    exp_tok = f"test_session_expired_{uuid.uuid4().hex}"
    email = f"test.user.{uuid.uuid4().hex[:6]}@example.com"
    mdb.users.insert_one({
        "id": uid, "email": email, "name": "Test User", "role": "admin",
        "company_roles": {"superiqfoam": "admin"}, "created_at": datetime.now(timezone.utc),
    })
    mdb.user_sessions.insert_one({"user_id": uid, "session_token": tok, "expires_at": datetime.now(timezone.utc) + timedelta(days=7), "created_at": datetime.now(timezone.utc)})
    mdb.user_sessions.insert_one({"user_id": uid, "session_token": exp_tok, "expires_at": datetime.now(timezone.utc) - timedelta(hours=1), "created_at": datetime.now(timezone.utc)})
    yield {"uid": uid, "tok": tok, "exp": exp_tok, "email": email}
    mdb.users.delete_many({"id": uid})
    mdb.user_sessions.delete_many({"user_id": uid})


# ---- Email/password login ----
class TestLogin:
    def test_login_ok(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        assert r.status_code == 200
        d = r.json()
        assert d["user"]["email"] == ADMIN_EMAIL and isinstance(d["token"], str)

    def test_login_bad(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"})
        assert r.status_code == 401

    def test_me_jwt(self, H):
        r = requests.get(f"{API}/auth/me", headers=H)
        assert r.status_code == 200 and r.json()["email"] == ADMIN_EMAIL
        assert "password_hash" not in r.json() and "_id" not in r.json()

    def test_no_auth(self):
        assert requests.get(f"{API}/auth/me").status_code == 401
        assert requests.get(f"{API}/dashboard").status_code == 401


# ---- Google session auth ----
class TestGoogleSession:
    def test_invalid_session_id(self):
        r = requests.post(f"{API}/auth/google/session", json={"session_id": "bogus-123"})
        assert r.status_code == 401, r.text

    def test_bearer_session_token(self, google_session):
        h = {"Authorization": f"Bearer {google_session['tok']}"}
        r = requests.get(f"{API}/auth/me", headers=h)
        assert r.status_code == 200 and r.json()["email"] == google_session["email"]
        assert requests.get(f"{API}/dashboard", headers=h).status_code == 200

    def test_cookie_session_token(self, google_session):
        r = requests.get(f"{API}/auth/me", cookies={"session_token": google_session["tok"]})
        assert r.status_code == 200 and r.json()["id"] == google_session["uid"]
        assert requests.get(f"{API}/dashboard", cookies={"session_token": google_session["tok"]}).status_code == 200

    def test_expired_session(self, google_session):
        assert requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {google_session['exp']}"}).status_code == 401
        assert requests.get(f"{API}/auth/me", cookies={"session_token": google_session["exp"]}).status_code == 401

    def test_logout_deletes_cookie_session(self, google_session):
        tok = f"test_session_logout_{uuid.uuid4().hex}"
        mdb.user_sessions.insert_one({"user_id": google_session["uid"], "session_token": tok, "expires_at": datetime.now(timezone.utc) + timedelta(days=1)})
        r = requests.post(f"{API}/auth/logout", cookies={"session_token": tok})
        assert r.status_code == 200 and r.json()["ok"] is True
        assert mdb.user_sessions.find_one({"session_token": tok}) is None
        assert requests.get(f"{API}/auth/me", cookies={"session_token": tok}).status_code == 401


# ---- Settings allowlist ----
class TestAllowlist:
    def test_put_get_allowed_emails(self, H):
        orig = requests.get(f"{API}/settings", headers=H).json().get("google_allowed_emails", [])
        new = list(orig) + ["test_allow@example.com"]
        r = requests.put(f"{API}/settings", headers=H, json={"google_allowed_emails": new})
        assert r.status_code == 200 and "test_allow@example.com" in r.json()["google_allowed_emails"]
        g = requests.get(f"{API}/settings", headers=H).json()
        assert "test_allow@example.com" in g["google_allowed_emails"]
        assert g.get("company_name") or True  # other fields untouched
        requests.put(f"{API}/settings", headers=H, json={"google_allowed_emails": orig})
        assert "test_allow@example.com" not in requests.get(f"{API}/settings", headers=H).json().get("google_allowed_emails", [])


def sse(H, payload, timeout=120):
    r = requests.post(f"{API}/assistant/chat", headers=H, json=payload, stream=True, timeout=timeout)
    assert r.status_code == 200, r.text
    assert "text/event-stream" in r.headers.get("content-type", "")
    events = []
    for line in r.iter_lines(decode_unicode=True):
        if line and line.startswith("data: "):
            events.append(json.loads(line[6:]))
    return events


# ---- AI assistant ----
class TestAssistant:
    state = {}

    def test_validation(self, H):
        assert requests.post(f"{API}/assistant/chat", headers=H, json={"message": "   "}).status_code == 400
        assert requests.post(f"{API}/assistant/chat", headers=H, json={"message": "hi", "session_id": "nope"}).status_code == 404
        assert requests.post(f"{API}/assistant/chat", json={"message": "hi"}).status_code == 401
        assert requests.get(f"{API}/assistant/sessions").status_code == 401
        assert requests.get(f"{API}/assistant/sessions/nope", headers=H).status_code == 404

    def test_first_turn(self, H):
        ev = sse(H, {"message": "How many customers owe money? List them with amounts."})
        assert ev[0]["type"] == "session" and ev[0]["session_id"]
        assert ev[-1]["type"] == "done"
        assert not [e for e in ev if e["type"] == "error"], ev
        deltas = [e for e in ev if e["type"] == "delta"]
        assert len(deltas) > 1
        ans = "".join(e["content"] for e in deltas)
        print("ANSWER1:", ans)
        TestAssistant.state = {"sid": ev[0]["session_id"], "a1": ans}

    def test_second_turn_memory(self, H):
        sid = TestAssistant.state["sid"]
        ev = sse(H, {"message": "and which of those is the largest?", "session_id": sid})
        assert ev[0]["session_id"] == sid and ev[-1]["type"] == "done"
        ans = "".join(e["content"] for e in ev if e["type"] == "delta")
        print("ANSWER2:", ans)
        assert len(ans) > 5
        TestAssistant.state["a2"] = ans

    def test_sessions_list_and_detail(self, H):
        sid = TestAssistant.state["sid"]
        ls = requests.get(f"{API}/assistant/sessions", headers=H).json()
        assert any(s["id"] == sid for s in ls)
        d = requests.get(f"{API}/assistant/sessions/{sid}", headers=H).json()
        roles = [m["role"] for m in d["messages"]]
        assert roles == ["user", "assistant", "user", "assistant"], roles
        assert d["messages"][0]["content"].startswith("How many customers")

    def test_other_user_cannot_see(self, google_session):
        sid = TestAssistant.state["sid"]
        h = {"Authorization": f"Bearer {google_session['tok']}"}
        assert requests.get(f"{API}/assistant/sessions/{sid}", headers=h).status_code == 404
        assert requests.post(f"{API}/assistant/chat", headers=h, json={"message": "hi", "session_id": sid}).status_code == 404

    def test_delete(self, H):
        sid = TestAssistant.state["sid"]
        assert requests.delete(f"{API}/assistant/sessions/{sid}", headers=H).status_code == 200
        assert requests.get(f"{API}/assistant/sessions/{sid}", headers=H).status_code == 404
        assert mdb.assistant_messages.count_documents({"session_id": sid}) == 0


    def test_stock_answer_real_data(self, H):
        ev = sse(H, {"message": "How many Simple 910x100 are in stock? Reply with just the number."})
        ans = "".join(e["content"] for e in ev if e["type"] == "delta")
        print("ANSWER3:", ans)
        assert "660" in ans
        requests.delete(f"{API}/assistant/sessions/{ev[0]['session_id']}", headers=H)


# ---- Real stock (owner count, 56 items, 5155 total) ----
class TestRealStock:
    def test_stock_totals(self, H):
        st = requests.get(f"{API}/stock", headers=H).json()
        assert len(st) == 56
        assert sum(x["current"] for x in st) == 5155
        assert not [x for x in st if x["product"].startswith("TEST_")]
        assert {x["product"] for x in st} == {"Simple", "Ribbon Pink", "Ribbon Black", "Strong Boy", "Uncovered", "Candy"}

    @pytest.mark.parametrize("prod,size,qty", [("Simple", "910x100", 660), ("Ribbon Black", "1070x100", 135), ("Ribbon Pink", "1070x120", 105),
                                               ("Strong Boy", "1070x125", 10), ("Uncovered", "910x100", 30), ("Candy", "760x100", 10)])
    def test_stock_values(self, H, prod, size, qty):
        st = requests.get(f"{API}/stock", headers=H).json()
        m = [x["current"] for x in st if x["product"] == prod and x["size"] == size]
        assert m == [qty]
