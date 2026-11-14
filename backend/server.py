from dotenv import load_dotenv
from pathlib import Path
import os
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')
load_dotenv(ROOT_DIR / '.env.multicompany')

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
import json, re
import shutil
import calendar
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel as _PydanticBaseModel, ConfigDict, Field, field_validator, model_validator
from typing import Dict, List, Optional, Any, Literal
from datetime import datetime, timezone, date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo
import uuid, logging, jwt, bcrypt, math, asyncio
import base64, hashlib, secrets
from cryptography.fernet import Fernet, InvalidToken
from pymongo import IndexModel, ReturnDocument
from pymongo.errors import DuplicateKeyError, OperationFailure

import seed_data
from production_recipes import PREDEFINED_BLOCK_RECIPES
from costs_math import calculate_production_cost
from piecework_math import calculate_piecework
from salary_math import (
    OVERTIME_HOURLY_RATE,
    OVERTIME_AFTER_17_HOURLY_RATE,
    STANDARD_PAID_DAYS_PER_WEEK,
    STANDARD_WEEKLY_HOURS,
    calculate_salary_hours,
)
from grv_math import (
    aggregate_accepted_stock_lines,
    grv_confirmation_status,
    validate_grv_line_quantities,
)
from smart_production_planner import build_smart_production_plan
from tenancy import DEFAULT_COMPANY_ID, GLOBAL_COLLECTIONS, ScopedDatabase, active_company_id, active_mongo_session, tenant_database, uses_unified_price_list
from attendance_math import summarize_attendance_records
from workflow_engine import (
    ACTION_DEFINITIONS,
    OPERATORS_BY_TYPE,
    TRIGGER_DEFINITIONS,
    WorkflowValidationError,
    evaluate_conditions,
    event_payload,
    render_action_template,
    validate_workflow_definition,
    validate_event_payload,
)
from backup_service import (
    BackupBusyError,
    backup_configuration,
    backup_job_lock,
    create_snapshot,
    delete_expired_snapshots,
    list_snapshots,
    mongo_tools_status,
    restore_snapshot_to_copy,
    scheduled_backup_loop,
    verify_snapshot_object,
)

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
base_db = client[os.environ['DB_NAME']]
db = ScopedDatabase(client, base_db)

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGO = "HS256"

class BaseModel(_PydanticBaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

app = FastAPI()

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    errors = [{"type": e.get("type"), "loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": errors})
api = APIRouter(prefix="/api")
backup_scheduler_task = None
fleet_notification_scheduler_task = None


def now_iso():
    return datetime.now(timezone.utc).isoformat()

TZ = ZoneInfo("Africa/Johannesburg")

def local_now():
    return datetime.now(TZ)

def local_today():
    return local_now().date()

def today_str():
    return local_today().isoformat()

COMPANY_PROFILES = [
    {"id": "superiqfoam", "name": "SUPERIQFOAM", "username": "SUPERIQFOAM"},
    {"id": "iqfoam-manufactoring", "name": "IQFOAM MANUFACTURING", "username": "IQFOAM MANUFACTORING"},
    {"id": "iqfoam-whole-sallers", "name": "IQFOAM WHOLESALERS", "username": "IQFOAM WHOLESALERS"},
]

WHOLESALERS_COMPANY_ID = "iqfoam-whole-sallers"
MANUFACTURING_COMPANY_ID = "iqfoam-manufactoring"
WAREHOUSE_IDS = {"A", "B", "C"}
WORKER_SUPERVISOR_ACTION_SECTIONS = {
    "invoice_edit": {"invoices"},
    "price_edit": {"settings"},
    "price_delete": {"settings"},
    "customer_delete": {"customers"},
    "stock_delete": {"stock"},
    "balance_payment_delete": {"customers", "client-payments", "express-client-payments"},
    "production_block_record": {"production"},
}
WORKER_SUPERVISOR_ACTIONS = set(WORKER_SUPERVISOR_ACTION_SECTIONS)
WORKER_SECTION_PREFIXES = {
    "customers": "customers",
    "suppliers": "suppliers",
    "buyings": "buyings",
    "invoices": "invoices",
    "express-invoices": "express-invoices",
    "express-client-payments": "express-client-payments",
    "express-payments": "express-client-payments",
    "orders": "orders",
    "intercompany": "intercompany",
    "stock": "stock",
    "company-inventory": "company-inventory",
    "production": "production",
    "simple-production": "production",
    "attendance": "attendance",
    "employees": "attendance",
    "salaries": "attendance",
    "piece-production": "production",
    "deliveries": "deliveries",
    "drivers": "settings",
    "vehicles": "fleet",
    "spareparts": "fleet",
    "fleet": "fleet",
    "expenses": "expenses",
    "cost-records": "costs",
    "reports/costs": "costs",
    "costs": "costs",
    "grvs": "grv",
    "grv": "grv",
    "daily-report": "daily-report",
    "prices": "settings",
    "settings": "settings",
    "payments": "client-payments",
    "dashboard": "dashboard",
    "warehouses": "warehouses",
}
WORKER_WRITE_PERMISSION_VALUES = {"deny", "allow", "supervisor"}

COMPANY_INVOICE_DETAILS = {
    "iqfoam-manufactoring": {
        "company_name": "iQ Foam Manufacturer",
        "address": "14 Pentrich Rd, Camps Drift, Pietermaritzburg, 3201",
        "telephone": "+27 78 673 2087",
    },
    "iqfoam-whole-sallers": {
        "company_name": "iQ Foam Wholesale",
        "address": "13 Manchester Rd, Northdale, Pietermaritzburg, 3201",
        "telephone": "+27 60 400 8600",
    },
}

def company_role(user, company_id):
    if user.get("role") == "owner":
        return "owner"
    if not user.get("is_worker") and any(
        role == "owner" for role in (user.get("company_roles") or {}).values()
    ):
        return "owner"
    if (
        not user.get("is_worker")
        and (user.get("company_roles") or {}).get(WHOLESALERS_COMPANY_ID) == "admin"
    ):
        return "admin"
    return (user.get("company_roles") or {}).get(company_id)


def worker_restrictions_apply(user):
    return user.get("is_worker") and user.get("_active_role") not in ("admin", "owner")


def can_view_stock_costs(user):
    return user.get("role") == "owner" or user.get("_active_role") == "owner"


def can_view_invoice_audit(user):
    return user.get("role") == "owner" or user.get("_active_role") == "owner"


def invoice_for_user(invoice, user):
    if invoice and not can_view_invoice_audit(user):
        invoice.pop("audit", None)
    return invoice


def allowed_company_ids(user):
    if user.get("role") == "owner" or (
        not user.get("is_worker")
        and any(role == "owner" for role in (user.get("company_roles") or {}).values())
    ) or (
        not user.get("is_worker")
        and (user.get("company_roles") or {}).get(WHOLESALERS_COMPANY_ID) == "admin"
    ):
        return [profile["id"] for profile in COMPANY_PROFILES]
    return [company_id for company_id, role in (user.get("company_roles") or {}).items()
            if role in ("user", "admin", "owner")]

def diesel_price_is_current(effective_date):
    try:
        age_days = (local_today() - date.fromisoformat(str(effective_date))).days
        return 0 <= age_days <= 45
    except (TypeError, ValueError):
        return False

def new_id():
    return str(uuid.uuid4())

def D(x):
    return Decimal(str(x or 0))

def r2(x):
    return float(D(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

def dsum(vals):
    return r2(sum((D(v) for v in vals), Decimal("0")))

def clean(doc):
    if doc and "_id" in doc:
        doc.pop("_id", None)
    return doc

def parse_dt(s):
    if not s:
        return None
    dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return dt.replace(tzinfo=TZ) if dt.tzinfo is None else dt

def fmt_local(s):
    return parse_dt(s).astimezone(TZ).strftime("%d %b %Y, %H:%M")

class StockLock:
    LEASE_DURATION = timedelta(minutes=2)
    HEARTBEAT_INTERVAL = 30

    def __init__(self, ids, *, wait_seconds=5, skip_missing=False):
        self.ids = sorted(set(ids))
        self.held = []
        self.token = new_id()
        self.heartbeat_task = None
        self.max_attempts = max(1, math.ceil(wait_seconds / 0.1))
        self.skip_missing = skip_missing

    async def __aenter__(self):
        for sid in self.ids:
            for _ in range(self.max_attempts):
                now = datetime.now(timezone.utc)
                stale_before = now - self.LEASE_DURATION
                lock_query = {
                    "id": sid,
                    "$or": [
                        {"lock": {"$ne": True}},
                        {"lock": True, "lock_at": {"$lt": stale_before}},
                        {"lock": True, "lock_at": {"$exists": False}},
                    ],
                }
                if await db.stock.find_one_and_update(
                    lock_query,
                    {"$set": {"lock": True, "lock_at": now, "lock_token": self.token}},
                ):
                    self.held.append(sid)
                    break
                if self.skip_missing and not await db.stock.find_one({"id": sid}, {"_id": 0}):
                    break
                await asyncio.sleep(0.1)
            else:
                await self.__aexit__()
                raise HTTPException(409, "Stock is being updated by another operation. Please retry")
        if self.held:
            self.heartbeat_task = asyncio.create_task(self._heartbeat())
        return self

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)
            try:
                await db.stock.update_many(
                    {"id": {"$in": self.held}, "lock_token": self.token},
                    {"$set": {"lock_at": datetime.now(timezone.utc)}},
                )
            except Exception:
                logging.exception("Failed to renew stock lock lease")

    async def __aexit__(self, *a):
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            try:
                await self.heartbeat_task
            except asyncio.CancelledError:
                pass
            self.heartbeat_task = None
        if self.held:
            await db.stock.update_many(
                {"id": {"$in": self.held}, "lock_token": self.token},
                {"$unset": {"lock": "", "lock_at": "", "lock_token": ""}},
            )
        self.held = []


class ChemicalInventoryLock:
    def __init__(self, ids):
        self.ids = sorted(set(ids))
        self.held = []

    async def __aenter__(self):
        for inventory_id in self.ids:
            for _ in range(50):
                if await db.chemical_inventory.find_one_and_update(
                    {"id": inventory_id, "production_lock": {"$ne": True}},
                    {"$set": {"production_lock": True}},
                ):
                    self.held.append(inventory_id)
                    break
                await asyncio.sleep(0.1)
            else:
                await self.__aexit__()
                raise HTTPException(409, "Chemical stock is being updated. Please retry")
        return self

    async def __aexit__(self, *args):
        if self.held:
            await db.chemical_inventory.update_many(
                {"id": {"$in": self.held}},
                {"$unset": {"production_lock": ""}},
            )
        self.held = []


class BlockStockIdentityLock:
    def __init__(self, block_type):
        company_id = active_company_id.get() or DEFAULT_COMPANY_ID
        self.lock_id = f"{company_id}:{block_type.casefold()}"
        self.held = False

    async def __aenter__(self):
        for _ in range(50):
            try:
                locked = await db.production_block_stock_locks.find_one_and_update(
                    {"_id": self.lock_id, "locked": {"$ne": True}},
                    {"$set": {"locked": True}, "$setOnInsert": {"_id": self.lock_id}},
                    upsert=True,
                    return_document=ReturnDocument.AFTER,
                )
                if locked:
                    self.held = True
                    return self
            except DuplicateKeyError:
                pass
            await asyncio.sleep(0.1)
        raise HTTPException(409, "Finished block stock is being updated. Please retry")

    async def __aexit__(self, *args):
        if self.held:
            await db.production_block_stock_locks.update_one(
                {"_id": self.lock_id}, {"$set": {"locked": False}},
            )
        self.held = False


class PurchaseOrderReceiptLock:
    def __init__(self, order_id, grv_id):
        self.order_id = order_id
        self.grv_id = grv_id

    async def __aenter__(self):
        if not self.order_id:
            return None
        order = await db.purchase_orders.find_one_and_update(
            {
                "id": self.order_id,
                "$or": [
                    {"receiving_grv_id": {"$exists": False}},
                    {"receiving_grv_id": self.grv_id},
                ],
            },
            {"$set": {"receiving_grv_id": self.grv_id}},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER,
        )
        if not order:
            raise HTTPException(409, "Another GRV is currently receiving this purchase order")
        return order

    async def __aexit__(self, *args):
        if self.order_id:
            await db.purchase_orders.update_one(
                {"id": self.order_id, "receiving_grv_id": self.grv_id},
                {"$unset": {"receiving_grv_id": ""}},
            )

async def log_audit(entity, eid, action, user, before=None, after=None, reason=""):
    strip = lambda d: {k: v for k, v in (d or {}).items() if k not in ("_id", "password_hash", "audit")} if isinstance(d, dict) else d
    actor = user if isinstance(user, dict) else {}
    actor_email = actor.get("email") or ""
    actor_username = actor.get("username") or ""
    actor_id = actor.get("id") or ""
    actor_name = actor.get("name") or actor_username or actor_email or actor_id or "System"
    actor_identity = actor_email or actor_username or actor_id or "system"
    await db.audit_log.insert_one({"id": new_id(), "entity": entity, "entity_id": eid, "action": action,
                                   "before": strip(before), "after": strip(after), "reason": reason or "",
                                   "user": actor_identity,
                                   "user_id": actor_id,
                                   "user_name": actor_name,
                                   "at": now_iso()})

# ---------------- Auth ----------------
def hash_pw(p): return bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode()
def verify_pw(p, h):
    try: return bcrypt.checkpw(p.encode(), h.encode())
    except Exception: return False

def make_token(uid, email, company_id=DEFAULT_COMPANY_ID, session_id=None):
    payload = {"sub": uid, "email": email, "company_id": company_id,
               "sid": session_id or new_id(), "exp": datetime.now(timezone.utc) + timedelta(days=7)}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)

def worker_access_token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()

def encrypt_worker_access_token(token):
    key = base64.urlsafe_b64encode(hashlib.sha256(JWT_SECRET.encode()).digest())
    return Fernet(key).encrypt(token.encode()).decode()

def decrypt_worker_access_token(token):
    key = base64.urlsafe_b64encode(hashlib.sha256(JWT_SECRET.encode()).digest())
    return Fernet(key).decrypt(token.encode()).decode()

async def find_worker_by_access_token(token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", token or ""):
        return None
    token_hash = worker_access_token_hash(token)
    worker = await base_db.users.find_one({
        "is_worker": True,
        "personal_access_token_hash": token_hash,
        "personal_access_revoked": {"$ne": True},
        "active": {"$ne": False},
    }, {"_id": 0})
    if worker and not secrets.compare_digest(worker.get("personal_access_token_hash", ""), token_hash):
        return None
    return worker

USER_PROJ = {"_id": 0, "password_hash": 0}
OWNER_EMAIL_ALIASES = {"2j2skp87z8@privaterelay.appleid.com"}
WORKER_SECTIONS = {
    "customers", "suppliers", "buyings", "invoices", "orders", "stock",
    "production", "attendance", "deliveries", "fleet", "expenses",
    "costs", "grv", "daily-report", "client-payments", "settings", "warehouses",
    "express-invoices", "express-client-payments", "intercompany", "company-inventory",
    "chemicals-quantity", "chemical-usage-log", "warehouse-a", "warehouse-b",
    "warehouse-c", "warehouse-chemical", "warehouse-chemical-inventory",
}

def canonical_email(email):
    normalized = (email or "").strip().lower()
    if normalized in OWNER_EMAIL_ALIASES:
        return os.environ["ADMIN_EMAIL"].strip().lower()
    return normalized


def is_global_owner_account(user):
    return (
        user.get("role") == "owner"
        and not user.get("is_worker")
        and canonical_email(user.get("email")) == canonical_email(os.environ["ADMIN_EMAIL"])
    )


def require_global_owner(user):
    if not is_global_owner_account(user):
        raise HTTPException(403, "Global Owner access required")


def enforce_superiqfoam_read_only(request, user):
    if (
        user.get("_active_company_id") == DEFAULT_COMPANY_ID
        and not is_global_owner_account(user)
        and request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
        and request.url.path not in {
            "/api/auth/switch-company",
            "/api/auth/logout",
            "/api/auth/device",
        }
        and not request.url.path.startswith(("/api/notifications/", "/api/assistant/sessions"))
    ):
        raise HTTPException(403, "Only the Global Owner can change SuperIQFoam company data")


async def user_from_session(token):
    s = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not s:
        return None
    exp = s["expires_at"]
    if isinstance(exp, str):
        exp = datetime.fromisoformat(exp)
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp < datetime.now(timezone.utc):
        return None
    user = await db.users.find_one({"id": s["user_id"]}, USER_PROJ)
    if user:
        user["_active_company_id"] = s.get("company_id") or DEFAULT_COMPANY_ID
        user["_session_id"] = s.get("id")
    return user

async def authorize_company(user, company_id, session_id=None):
    if not user or user.get("active") is False or user.get("disabled") is True:
        raise HTTPException(401, "Account is disabled")
    if user.get("is_worker"):
        if user.get("personal_access_revoked"):
            raise HTTPException(401, "Worker access has been revoked")
        worker_companies = [
            assigned_company for assigned_company, assigned_role in (user.get("company_roles") or {}).items()
            if assigned_role in ("owner", "admin", "user")
        ]
        if company_id not in worker_companies:
            raise HTTPException(403, "Workers cannot access another company")
    company = await base_db.companies.find_one({"id": company_id, "active": True}, {"_id": 0})
    if not company:
        raise HTTPException(403, "Company is unavailable")
    role = company_role(user, company_id)
    if role not in ("owner", "admin", "user"):
        raise HTTPException(403, "You are not assigned to this company")
    active_company_id.set(company_id)
    user["_active_company_id"] = company_id
    user["_active_role"] = role
    user["_session_id"] = session_id
    if session_id:
        await base_db.user_sessions.update_one({"id": session_id, "user_id": user["id"]},
            {"$set": {"company_id": company_id, "last_seen": now_iso()}})
    return user

WORKER_SUPERVISOR_ROUTES = (
    ("PUT", r"invoices/[^/]+", "invoice_edit"),
    ("POST", r"prices", "price_edit"),
    ("PUT", r"prices/[^/]+", "price_edit"),
    ("DELETE", r"prices/[^/]+", "price_delete"),
    ("DELETE", r"customers/[^/]+", "customer_delete"),
    ("DELETE", r"customers/[^/]+/other-balance-history/\d+", "balance_payment_delete"),
    ("DELETE", r"stock/[^/]+", "stock_delete"),
    ("DELETE", r"payments/[^/]+/other-balance", "balance_payment_delete"),
    ("POST", r"production/block-productions", "production_block_record"),
)

def worker_supervisor_action(path, method):
    normalized_path = path.removeprefix("/api/").strip("/")
    normalized_method = method.upper()
    for route_method, pattern, action in WORKER_SUPERVISOR_ROUTES:
        if normalized_method == route_method and re.fullmatch(pattern, normalized_path):
            return action
    return None

def worker_section_for_request(path, user):
    if path == "company-inventory" or path.startswith("company-inventory/"):
        return "company-inventory"
    if path == "intercompany" or path.startswith("intercompany/"):
        return "intercompany"
    allowed = set(user.get("worker_allowed_sections") or [])
    if path == "invoices" or path.startswith("invoices/"):
        if "invoices" in allowed:
            return "invoices"
        if "express-invoices" in allowed:
            return "express-invoices"
        if "express-client-payments" in allowed:
            return "express-client-payments"
        return "invoices"
    if path == "payments" or path.startswith("payments/"):
        if "client-payments" in allowed:
            return "client-payments"
        if "express-client-payments" in allowed:
            return "express-client-payments"
        return "client-payments"
    if path == "warehouses" or path.startswith("warehouses/"):
        parts = path.split("/")
        if len(parts) < 2:
            return "warehouses"
        warehouse = parts[1].lower()
        if warehouse in {"a", "b", "c"}:
            return f"warehouse-{warehouse}"
        if warehouse == "chemical":
            if len(parts) > 2 and parts[2] == "inventory":
                return "chemicals-quantity" if user.get("_active_company_id") == "superiqfoam" else "warehouse-chemical-inventory"
            return "chemical-usage-log" if user.get("_active_company_id") == "superiqfoam" else "warehouse-chemical"
        return "warehouses"
    return next(
        (value for prefix, value in sorted(
            WORKER_SECTION_PREFIXES.items(), key=lambda item: len(item[0]), reverse=True,
        ) if path == prefix or path.startswith(f"{prefix}/")),
        None,
    )

def enforce_worker_api_access(request, user):
    if not worker_restrictions_apply(user):
        return
    path = request.url.path.removeprefix("/api/").strip("/")
    method = request.method.upper()
    allowed = set(user.get("worker_allowed_sections") or [])
    write_permission = worker_write_permission(user, request.url.path, method)
    if write_permission and write_permission[2] == "deny":
        raise HTTPException(403, "This worker cannot perform this action in the selected section")
    sensitive_action = worker_supervisor_action(request.url.path, method)
    if sensitive_action and write_permission is None and "worker_is_supervisor" in user:
        if not user.get("worker_is_supervisor"):
            raise HTTPException(403, "Only a designated worker supervisor can make this change")
        required_sections = WORKER_SUPERVISOR_ACTION_SECTIONS[sensitive_action]
        if not required_sections & allowed:
            raise HTTPException(403, f"This worker account cannot access the {sorted(required_sections)[0]} section")

    if path in {
        "auth/me", "auth/logout", "auth/device", "companies/profiles",
        "settings/supervisor-password/authorize",
    }:
        return
    if (
        (path == "notifications" and method == "GET")
        or (path == "notifications/dismiss-all" and method == "POST")
        or (
            re.fullmatch(r"notifications/[^/]+/(dismiss|read)", path)
            and method == "POST"
        )
    ):
        return

    stock_access = "stock" in allowed or user.get("worker_stock_only")
    if path == "company-inventory" and method == "GET" and "company-inventory" in allowed:
        return
    if path == "products" and method == "GET" and stock_access:
        return
    if path == "products/scan" and method == "POST" and (
        stock_access or allowed.intersection({"invoices", "express-invoices", "production", "orders", "deliveries", "grv"})
    ):
        return
    if re.fullmatch(r"stock/[^/]+/identification", path):
        if stock_access and method in {"GET", "PUT"}:
            return
        raise HTTPException(403, "This worker account cannot manage product identification")
    if re.fullmatch(r"stock/[^/]+/product-details", path):
        if stock_access and method == "PUT":
            return
        raise HTTPException(403, "This worker account cannot edit product details")
    if path == "product-identification-stats" and method == "GET" and stock_access:
        return
    if "stock" in allowed and path == "prices" and method == "GET":
        return

    if user.get("worker_stock_only"):
        if write_permission and write_permission[0] == "stock":
            return
        if path == "products" and method == "GET":
            return
        if path == "stock" and method in {"GET", "POST"}:
            return
        if re.fullmatch(r"stock/[^/]+", path) and method == "PUT":
            return
        if path == "stock/movements" and method == "GET":
            return
        if re.fullmatch(r"stock/[^/]+/movements", path) and method == "POST":
            return
        if path == "prices" and method == "GET":
            return
        raise HTTPException(403, "This stock-only account cannot access other sections or destructive stock actions")

    if "invoices" in allowed:
        if path in {"customers", "prices", "settings"} and method == "GET":
            return
        if re.fullmatch(r"customers/[^/]+/summary", path) and method == "GET":
            return
        if path in {"customers", "prices"} and method == "POST":
            return
        if path == "invoices" and method in {"GET", "POST"}:
            return
        if path == "invoices/next-number" and method == "GET":
            return
        if re.fullmatch(r"invoices/[^/]+", path) and method in {"GET", "PUT"}:
            return
        if re.fullmatch(r"invoices/[^/]+/authorize-edit", path) and method == "POST":
            return
        if re.fullmatch(r"invoices/[^/]+/authorize-action", path) and method == "POST":
            return
        if re.fullmatch(r"invoices/[^/]+/daily-report", path) and method == "POST":
            return
        if re.fullmatch(r"invoices/[^/]+/issue", path) and method == "POST":
            return
        if "client-payments" in allowed and re.fullmatch(r"invoices/[^/]+/payments", path) and method == "POST":
            return
        if "client-payments" in allowed and re.fullmatch(r"payments/[^/]+/reverse", path) and method == "POST":
            return
        if path == "invoices" or path.startswith("invoices/"):
            raise HTTPException(403, "This worker account cannot perform this invoice action")

    if "expenses" in allowed:
        if path == "expenses/authorize-create" and method == "POST":
            return
        if re.fullmatch(r"expenses/[^/]+/authorize-action", path) and method == "POST":
            return

    if "fleet" in allowed and path == "fleet-expense-authorizations" and method == "POST":
        return

    support_rules = {
        "invoices": [("drivers", "GET")],
        "express-invoices": [
            ("customers", "GET"), ("prices", "GET"), ("settings", "GET"), ("drivers", "GET"),
        ],
        "buyings": [("suppliers", "GET"), ("stock", "GET")],
        "grv": [
            ("suppliers", "GET"), ("stock", "GET"),
            ("purchase-orders", "GET"), ("settings", "GET"),
        ],
        "suppliers": [("buyings", "GET")],
        "production": [
            ("stock", "GET"), ("piece-production", "GET"), ("piece-production", "POST"),
            ("production/block-recipes", "GET"), ("production/block-productions", "GET"),
            ("production/block-productions", "POST"),
            ("warehouses/chemical/inventory", "GET"),
        ],
        "attendance": [("piece-production", "GET"), ("piece-production", "POST")],
        "orders": [
            ("customers", "GET"), ("prices", "GET"), ("settings", "GET"),
            ("stock", "GET"), ("vehicles", "GET"),
        ],
        "deliveries": [
            ("customers", "GET"), ("drivers", "GET"), ("vehicles", "GET"), ("stock", "GET"),
        ],
        "expenses": [("vehicles", "GET"), ("reports/profit", "GET"), ("reports/costs", "GET")],
        "client-payments": [
            ("customers", "GET"), ("invoices", "GET"), ("settings", "GET"),
        ],
        "express-client-payments": [
            ("customers", "GET"), ("invoices", "GET"), ("settings", "GET"),
            ("express-payments", "GET"), ("express-payments", "POST"),
        ],
        "chemical-usage-log": [("warehouses/chemical/inventory", "GET")],
        "warehouse-chemical": [("warehouses/chemical/inventory", "GET")],
    }
    for section, rules in support_rules.items():
        if section not in allowed:
            continue
        for prefix, supported_method in rules:
            if method == supported_method and (path == prefix or path.startswith(f"{prefix}/")):
                if section == "client-payments" and path.startswith("invoices/"):
                    if re.fullmatch(r"invoices/[^/]+/payments", path) and method != "POST":
                        continue
                    if not re.fullmatch(r"invoices/[^/]+", path) and not re.fullmatch(r"invoices/[^/]+/payments", path):
                        continue
                return

    section = worker_section_for_request(path, user)
    if section and section in allowed:
        return
    raise HTTPException(403, "This worker account cannot access this section")

def is_delegated_company_owner(user):
    return (
        user.get("role") != "owner"
        and not user.get("is_worker")
        and any(role == "owner" for role in (user.get("company_roles") or {}).values())
    )

def is_delegated_company_admin(user):
    return (
        user.get("role") != "owner"
        and any(role in ("owner", "admin") for role in (user.get("company_roles") or {}).values())
    )

def can_skip_supervisor_approval(user):
    if user.get("role") == "owner" and not worker_restrictions_apply(user):
        return True
    return (
        user.get("role") != "owner"
        and not worker_restrictions_apply(user)
        and (user.get("company_roles") or {}).get(WHOLESALERS_COMPANY_ID) == "admin"
        and user.get("_active_company_id") == "iqfoam-manufactoring"
    )

def can_edit_invoice_without_supervisor(user):
    if user.get("_active_role") in ("owner", "admin") or (
        user.get("role") == "owner" and not worker_restrictions_apply(user)
    ):
        return True
    if worker_restrictions_apply(user):
        permission = worker_write_permission(user, "/api/invoices/invoice-id", "PUT")
        return bool(permission and permission[2] == "allow")
    return False

def is_supervisor_password_endpoint(path):
    return (
        path == "/api/settings/supervisor-password/authorize"
        or path == "/api/auth/switch-company"
        or path == "/api/auth/device"
        or path == "/api/fleet-expense-authorizations"
        or bool(re.search(r"/authorize(?:-|$)", path))
    )

async def require_supervisor_for_company_write(request, user):
    if request.method in ("GET", "HEAD", "OPTIONS") or user.get("role") == "owner" \
            or is_supervisor_password_endpoint(request.url.path):
        return
    if user.get("_active_role") == "admin" and (
        request.method in {"POST", "PUT", "PATCH", "DELETE"}
        and (
            request.url.path == "/api/prices"
            or re.fullmatch(r"/api/prices/[^/]+", request.url.path)
        )
    ):
        raise HTTPException(403, "Only company owners can change the price list")
    if user.get("_active_role") == "owner" and (
        (
            request.method in {"PUT", "DELETE"}
            and re.fullmatch(r"/api/invoices/[^/]+", request.url.path)
        )
        or (
            request.method == "POST"
            and request.url.path == "/api/invoices/bulk-delete"
        )
    ):
        return

    action = None
    if worker_restrictions_apply(user):
        write_permission = worker_write_permission(user, request.url.path, request.method)
        is_invoice_delete = (
            request.url.path == "/api/invoices/bulk-delete"
            or (
                request.method == "DELETE"
                and re.fullmatch(r"/api/invoices/[^/]+", request.url.path)
            )
        )
        if is_invoice_delete:
            if write_permission and write_permission[2] == "deny":
                return
            section = write_permission[0] if write_permission else (
                "express-invoices"
                if "express-invoices" in (user.get("worker_allowed_sections") or [])
                and "invoices" not in (user.get("worker_allowed_sections") or [])
                else "invoices"
            )
            action = f"{section}:delete"
        elif write_permission:
            is_invoice_delete = (
                write_permission[0] in {"invoices", "express-invoices"}
                and write_permission[1] == "delete"
            )
            if write_permission[2] != "supervisor":
                return
            section, operation, _ = write_permission
            action = f"{section}:{operation}"
        else:
            action = worker_supervisor_action(request.url.path, request.method)
            if (
                user.get("_active_company_id") != MANUFACTURING_COMPANY_ID
                or not user.get("worker_is_supervisor")
                or action not in set(user.get("worker_supervisor_password_actions") or [])
            ):
                return
        grant_scope = "supervisor_worker_action"
        grant_company_id = user.get("_active_company_id")
    else:
        if (
            request.method == "PUT"
            and re.fullmatch(r"/api/invoices/[^/]+", request.url.path)
            and user.get("_active_role") == "admin"
        ):
            return
        is_invoice_delete = (
            (
                request.method == "DELETE"
                and re.fullmatch(r"/api/invoices/[^/]+", request.url.path)
            )
            or (
                request.method == "POST"
                and request.url.path == "/api/invoices/bulk-delete"
            )
        )
        if (
            not (
                is_delegated_company_admin(user)
                or (is_invoice_delete and user.get("_active_role") == "admin")
            )
            or (
                user.get("_active_company_id") != DEFAULT_COMPANY_ID
                and not is_invoice_delete
            )
            or (
                request.method == "DELETE"
                and re.fullmatch(r"/api/grvs/[^/]+", request.url.path)
            )
        ):
            return
        grant_scope = "supervisor_company_write"
        grant_company_id = user.get("_active_company_id")

    encoded_grant = request.headers.get("X-Supervisor-Authorization", "")
    try:
        grant = jwt.decode(encoded_grant, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.InvalidTokenError:
        raise HTTPException(428, "Supervisor password is required for this change")
    if (
        grant.get("scope") != grant_scope
        or grant.get("sub") != user.get("id")
        or grant.get("company_id") != grant_company_id
        or grant.get("sid") != user.get("_session_id")
        or (action is not None and grant.get("action") != action)
    ):
        raise HTTPException(428, "Supervisor password is required for this change")

    grant_query = {
        "id": grant.get("jti"),
        "user_id": user["id"],
        "company_id": grant_company_id,
        "session_id": user.get("_session_id"),
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    }
    if action is not None:
        grant_query.update({"scope": grant_scope, "action": action})
    consumed = await base_db.supervisor_action_grants.delete_one(grant_query)
    if not consumed.deleted_count:
        raise HTTPException(428, "Supervisor approval has expired or was already used")

async def get_current_user(request: Request):
    cookie = request.cookies.get("session_token")
    if cookie:
        user = await user_from_session(cookie)
        if user:
            user = await authorize_company(user, user.get("_active_company_id") or DEFAULT_COMPANY_ID,
                                           user.get("_session_id"))
            enforce_superiqfoam_read_only(request, user)
            if request.url.path.startswith("/api/workflow-builder"):
                require_global_owner(user)
            enforce_worker_api_access(request, user)
            await require_supervisor_for_company_write(request, user)
            return user
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    token = auth[7:]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        user = await user_from_session(token)
        if user:
            user = await authorize_company(
                user,
                user.get("_active_company_id") or DEFAULT_COMPANY_ID,
                user.get("_session_id"),
            )
            enforce_superiqfoam_read_only(request, user)
            if request.url.path.startswith("/api/workflow-builder"):
                require_global_owner(user)
            enforce_worker_api_access(request, user)
            await require_supervisor_for_company_write(request, user)
            return user
        raise HTTPException(401, "Invalid token")
    user = await db.users.find_one({"id": payload["sub"]}, USER_PROJ)
    if not user:
        raise HTTPException(401, "User not found")
    if user.get("is_worker"):
        session = await base_db.user_sessions.find_one({
            "id": payload.get("sid"), "user_id": user["id"],
        }, {"_id": 0})
        if not session:
            raise HTTPException(401, "Worker session has been revoked")
        expires_at = session.get("expires_at")
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expires_at and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at and expires_at < datetime.now(timezone.utc):
            raise HTTPException(401, "Worker session has expired")
    user = await authorize_company(user, payload.get("company_id") or DEFAULT_COMPANY_ID, payload.get("sid"))
    enforce_superiqfoam_read_only(request, user)
    if request.url.path.startswith("/api/workflow-builder"):
        require_global_owner(user)
    enforce_worker_api_access(request, user)
    await require_supervisor_for_company_write(request, user)
    return user

class LoginIn(BaseModel):
    email: Optional[str] = None
    username: Optional[str] = None
    password: str
    company_id: str = DEFAULT_COMPANY_ID
    personal_access_token: Optional[str] = Field(default=None, min_length=40, max_length=64)

class RegisterIn(BaseModel):
    name: str
    email: str
    password: str

class DeviceIn(BaseModel):
    device_id: str
    device_name: str = "Unknown device"
    timezone: str = ""
    share_location: bool = False
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class UserRoleIn(BaseModel):
    role: str
    company_id: str

class UserCompaniesIn(BaseModel):
    company_ids: List[str]

class CreateAccessUserIn(BaseModel):
    username: str
    name: str
    password: str
    company_ids: List[str]
    email: Optional[str] = ""

class CreateWorkerIn(BaseModel):
    username: str
    name: str
    worker_role: str
    password: str
    company_id: str
    allowed_sections: List[str]
    stock_only: bool = False
    email: Optional[str] = ""
    is_supervisor: bool = False
    warehouse_id: Optional[str] = None
    warehouse_ids: List[str] = Field(default_factory=list)
    supervisor_password_actions: List[str] = Field(default_factory=list)
    write_permissions: Dict[str, Dict[str, str]] = Field(default_factory=dict)
    can_edit_invoice_prices: bool = False
    is_admin: bool = False

class WorkerAccessUpdateIn(BaseModel):
    worker_role: str
    allowed_sections: List[str]
    stock_only: bool = False
    is_supervisor: bool = False
    warehouse_id: Optional[str] = None
    warehouse_ids: List[str] = Field(default_factory=list)
    supervisor_password_actions: List[str] = Field(default_factory=list)
    write_permissions: Dict[str, Dict[str, str]] = Field(default_factory=dict)
    can_edit_invoice_prices: Optional[bool] = None
    is_admin: Optional[bool] = None

class UserStatusIn(BaseModel):
    active: bool

class ProfileCredentialsIn(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None

class ProfilePasswordIn(BaseModel):
    password: str

class OwnerPromotionIn(BaseModel):
    owner_password: str
    company_id: str

class SupervisorPasswordIn(BaseModel):
    password: str

class SupervisorWriteAuthorizationIn(BaseModel):
    password: str
    action: Optional[str] = None

class BackupRestoreIn(BaseModel):
    key: str = Field(min_length=12, max_length=50)

    @field_validator("key")
    @classmethod
    def valid_backup_key(cls, value):
        if not re.fullmatch(
            r"(?:daily/\d{4}-\d{2}-\d{2}|monthly/\d{4}-\d{2}|manual/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{6}Z)\.zip",
            value,
        ):
            raise ValueError("Invalid backup selection")
        return value

class SwitchCompanyIn(BaseModel):
    company_id: str

class WorkflowDefinitionIn(BaseModel):
    model_config = {"extra": "forbid"}

    company_id: str
    name: str
    trigger: str
    logic: str = "all"
    conditions: List[dict] = Field(default_factory=list)
    actions: List[dict]
    enabled: bool = False

class WorkflowToggleIn(BaseModel):
    enabled: bool

class WorkflowDryRunIn(BaseModel):
    event_data: dict = Field(default_factory=dict)

class WorkflowApprovalDecisionIn(BaseModel):
    decision: str
    note: Optional[str] = Field(default="", max_length=500)

def public_user(u):
    company_id = u.get("_active_company_id") or DEFAULT_COMPANY_ID
    role = u.get("_active_role") or company_role(u, company_id) or u.get("role", "user")
    is_worker_account = bool(u.get("is_worker"))
    is_worker = is_worker_account and role not in ("admin", "owner")
    admin_company_ids = [
        managed_company_id
        for managed_company_id in allowed_company_ids(u)
        if company_role(u, managed_company_id) in ("owner", "admin")
    ]
    owner_company_ids = (
        [profile["id"] for profile in COMPANY_PROFILES]
        if u.get("role") == "owner"
        else [
            managed_company_id
            for managed_company_id, assigned_role in (u.get("company_roles") or {}).items()
            if assigned_role == "owner"
        ]
    )
    is_company_owner = (
        u.get("role") != "owner"
        and not u.get("is_worker")
        and any(assigned_role == "owner" for assigned_role in (u.get("company_roles") or {}).values())
    )
    return {"id": u["id"], "email": u.get("email", ""), "username": u.get("username", ""),
            "name": u.get("name") or u.get("username") or "User", "role": role,
            "is_owner": u.get("role") == "owner", "is_admin": role in ("owner", "admin"),
            "is_company_owner": role == "owner",
            "can_switch_company": (
                u.get("role") == "owner"
                or is_company_owner
                or (
                    not u.get("is_worker")
                    and len(allowed_company_ids(u)) > 1
                    and any(
                        assigned_role == "admin"
                        for assigned_role in (u.get("company_roles") or {}).values()
                    )
                )
            ),
            "can_skip_supervisor_approval": can_skip_supervisor_approval(u),
            "can_edit_invoices_without_supervisor": can_edit_invoice_without_supervisor(u),
            "is_primary_owner": canonical_email(u.get("email")) == canonical_email(os.environ["ADMIN_EMAIL"]),
            "is_worker": is_worker,
            "is_worker_account": is_worker_account,
            "is_stock_only_worker": is_worker and u.get("worker_stock_only", False),
            "worker_role": u.get("worker_role", "") if is_worker else "",
            "is_supervisor": is_worker and u.get("worker_is_supervisor", False),
            "warehouse_ids": worker_warehouse_ids(u) if is_worker else [],
            "allowed_sections": u.get("worker_allowed_sections", []) if is_worker else [],
            "write_permissions": u.get("worker_write_permissions", {}) if is_worker else {},
            "can_edit_invoice_prices": u.get("worker_can_edit_invoice_prices", False) if is_worker else False,
            "admin_company_ids": admin_company_ids,
            "owner_company_ids": owner_company_ids,
            "company_id": company_id, "company_ids": allowed_company_ids(u), "picture": u.get("picture", "")}

def require_owner(user):
    if user.get("role") != "owner":
        raise HTTPException(403, "Owner access required")

def worker_sections(sections, stock_only=False):
    if stock_only:
        return ["stock"]
    normalized = list(dict.fromkeys(sections))
    if not normalized or any(section not in WORKER_SECTIONS for section in normalized):
        raise HTTPException(400, "Choose at least one valid section")
    return normalized

def validate_worker_company_sections(company_id, sections):
    manufacturing_sections = {
        "warehouses", "warehouse-a", "warehouse-b", "warehouse-c",
        "warehouse-chemical", "warehouse-chemical-inventory",
    }
    if set(sections) & manufacturing_sections and company_id != MANUFACTURING_COMPANY_ID:
        raise HTTPException(400, "Warehouse access is only available in IQFOAM Manufacturing")
    if set(sections) & {"chemicals-quantity", "chemical-usage-log"} and company_id != "superiqfoam":
        raise HTTPException(400, "These chemical sections are only available in SUPERIQFOAM")

def worker_warehouse_ids(doc):
    ids = doc.get("worker_warehouse_ids")
    if ids is None:
        ids = [doc["worker_warehouse_id"]] if doc.get("worker_warehouse_id") else []
    return [item for item in ids if item in WAREHOUSE_IDS]

def worker_supervisor_settings(company_id, is_supervisor, warehouse_ids, protected_actions, sections=()):
    warehouse_ids = [item for item in dict.fromkeys(warehouse_ids or []) if item]
    if any(item not in WAREHOUSE_IDS for item in warehouse_ids):
        raise HTTPException(400, "Choose valid warehouses")
    if warehouse_ids and company_id != MANUFACTURING_COMPANY_ID:
        raise HTTPException(400, "Warehouse assignment is only available for Manufacturing workers")
    if warehouse_ids and any(
        "warehouses" not in sections and f"warehouse-{warehouse.lower()}" not in sections
        for warehouse in warehouse_ids
    ):
        raise HTTPException(400, "Enable each assigned warehouse section")

    actions = list(dict.fromkeys(protected_actions))
    if any(action not in WORKER_SUPERVISOR_ACTIONS for action in actions):
        raise HTTPException(400, "Choose valid supervisor-password actions")
    if actions and (company_id != MANUFACTURING_COMPANY_ID or not is_supervisor):
        raise HTTPException(
            400,
            "Only Manufacturing worker supervisors can have supervisor-password actions",
        )
    return sorted(warehouse_ids), actions

def validate_worker_supervisor_sections(sections, protected_actions):
    missing = {
        action
        for action in protected_actions
        if not WORKER_SUPERVISOR_ACTION_SECTIONS[action] & set(sections)
    }
    if missing:
        raise HTTPException(
            400,
            "Grant the matching section before configuring its supervisor-protected action",
        )

def validate_worker_write_permissions(permissions, sections):
    if not permissions:
        return {
            section: {operation: "deny" for operation in ("create", "update", "delete")}
            for section in sections
        }
    normalized = {}
    allowed_sections = set(sections)
    if set(permissions) - allowed_sections:
        raise HTTPException(400, "Write permissions must match the worker's allowed sections")
    for section in allowed_sections:
        section_permissions = permissions.get(section)
        if not isinstance(section_permissions, dict):
            raise HTTPException(400, f"Choose create, edit, and delete permissions for {section}")
        if set(section_permissions) != {"create", "update", "delete"}:
            raise HTTPException(400, f"Choose create, edit, and delete permissions for {section}")
        if any(value not in WORKER_WRITE_PERMISSION_VALUES for value in section_permissions.values()):
            raise HTTPException(400, "Choose a valid worker write permission")
        if section in {"invoices", "express-invoices"} and section_permissions.get("delete") == "allow":
            raise HTTPException(400, "Invoice deletion always requires the Supervisor Password")
        normalized[section] = dict(section_permissions)
    return normalized

def validate_worker_invoice_price_permission(can_edit, sections):
    if can_edit and not {"invoices", "express-invoices"}.intersection(sections):
        raise HTTPException(400, "Invoice price editing requires invoice section access")
    return bool(can_edit)

def worker_write_scope(path, method, user=None):
    normalized_path = path.removeprefix("/api/").strip("/")
    normalized_method = method.upper()
    if normalized_method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None
    if re.search(r"/authorize(?:-|$)", normalized_path):
        return None
    if normalized_path == "invoices/bulk-delete":
        return "invoices", "delete"
    if re.fullmatch(r"invoices/[^/]+/payments", normalized_path):
        allowed = set((user or {}).get("worker_allowed_sections") or [])
        section = (
            "express-client-payments"
            if "express-client-payments" in allowed and "client-payments" not in allowed
            else "client-payments"
        )
    else:
        section = worker_section_for_request(normalized_path, user or {})
    if not section:
        return None
    operation = {
        "POST": "create",
        "PUT": "update",
        "PATCH": "update",
        "DELETE": "delete",
    }[normalized_method]
    if (
        re.fullmatch(r"invoices/[^/]+/(issue|void|daily-report)", normalized_path)
        or re.fullmatch(r"payments/[^/]+/(reverse|daily-report)", normalized_path)
        or normalized_path == "daily-report"
    ):
        operation = "update"
    return section, operation

def worker_write_permission(user, path, method):
    scope = worker_write_scope(path, method, user)
    permissions = user.get("worker_write_permissions")
    if not scope or not isinstance(permissions, dict) or not permissions:
        return None
    section, operation = scope
    section_permissions = permissions.get(section)
    if not isinstance(section_permissions, dict):
        return section, operation, "deny"
    return section, operation, section_permissions.get(operation, "deny")

def require_profile_owner(user):
    if user.get("role") != "owner" and user.get("_active_role") != "owner":
        raise HTTPException(403, "Company owner access required")

def require_settings_owner(user):
    if user.get("is_worker") or user.get("_active_role") != "owner":
        raise HTTPException(403, "Settings access requires company owner access")

def is_company_admin(user):
    return user.get("role") in ("owner", "admin") or user.get("_active_role") in ("owner", "admin")


def _validate_workflow_company(company_id):
    profile = next((item for item in COMPANY_PROFILES if item["id"] == company_id), None)
    if not profile:
        raise HTTPException(400, "Select a valid company")
    return profile


def _workflow_database(company_id):
    _validate_workflow_company(company_id)
    return tenant_database(client, base_db, company_id)


async def _workflow_company(company_id):
    profile = _validate_workflow_company(company_id)
    company = await base_db.companies.find_one(
        {"id": company_id, "active": True}, {"_id": 0, "id": 1},
    )
    if not company:
        raise HTTPException(403, "Company is unavailable")
    return profile


async def _get_workflow_or_404(workflow_id, company_id):
    workflow = await _workflow_database(company_id).workflows.find_one(
        {"id": workflow_id, "company_id": company_id}, {"_id": 0},
    )
    if not workflow:
        raise HTTPException(404, "Workflow not found in this company")
    return workflow


@api.get("/workflow-builder/catalog")
async def workflow_catalog(user=Depends(get_current_user)):
    require_global_owner(user)
    return {
        "companies": [{"id": item["id"], "name": item["name"]} for item in COMPANY_PROFILES],
        "triggers": [
            {"id": key, "label": item["label"], "fields": item["fields"]}
            for key, item in TRIGGER_DEFINITIONS.items()
        ],
        "operators": OPERATORS_BY_TYPE,
        "actions": [{"id": key, "label": value} for key, value in ACTION_DEFINITIONS.items()],
    }


@api.get("/workflow-builder")
async def get_workflows(company_id: str, user=Depends(get_current_user)):
    require_global_owner(user)
    await _workflow_company(company_id)
    workflow_db = _workflow_database(company_id)
    workflows = await workflow_db.workflows.find(
        {"company_id": company_id}, {"_id": 0},
    ).sort("updated_at", -1).to_list(None)
    for workflow in workflows:
        workflow["last_execution"] = await workflow_db.workflow_runs.find_one(
            {"company_id": company_id, "workflow_id": workflow["id"]},
            {
                "_id": 0,
                "started_at": 1,
                "completed_at": 1,
                "result": 1,
                "duration_ms": 1,
            },
            sort=[("started_at", -1)],
        )
    return workflows


@api.post("/workflow-builder")
async def create_workflow(body: WorkflowDefinitionIn, user=Depends(get_current_user)):
    require_global_owner(user)
    await _workflow_company(body.company_id)
    try:
        definition = validate_workflow_definition(body.model_dump(exclude={"company_id"}))
    except WorkflowValidationError as error:
        raise HTTPException(400, str(error)) from error
    timestamp = now_iso()
    workflow = {
        **definition,
        "id": new_id(),
        "company_id": body.company_id,
        "created_at": timestamp,
        "updated_at": timestamp,
        "created_by": user["id"],
        "updated_by": user["id"],
    }
    await _workflow_database(body.company_id).workflows.insert_one(dict(workflow))
    return workflow


@api.put("/workflow-builder/{workflow_id}")
async def edit_workflow(workflow_id: str, body: WorkflowDefinitionIn, user=Depends(get_current_user)):
    require_global_owner(user)
    await _workflow_company(body.company_id)
    await _get_workflow_or_404(workflow_id, body.company_id)
    try:
        definition = validate_workflow_definition(body.model_dump(exclude={"company_id"}))
    except WorkflowValidationError as error:
        raise HTTPException(400, str(error)) from error
    await _workflow_database(body.company_id).workflows.update_one(
        {"id": workflow_id, "company_id": body.company_id},
        {"$set": {**definition, "updated_at": now_iso(), "updated_by": user["id"]}},
    )
    return await _get_workflow_or_404(workflow_id, body.company_id)


@api.post("/workflow-builder/{workflow_id}/duplicate")
async def duplicate_workflow(workflow_id: str, company_id: str, user=Depends(get_current_user)):
    require_global_owner(user)
    await _workflow_company(company_id)
    source = await _get_workflow_or_404(workflow_id, company_id)
    timestamp = now_iso()
    duplicate = {
        **{key: value for key, value in source.items()
           if key not in {"id", "created_at", "updated_at", "created_by", "updated_by"}},
        "id": new_id(),
        "name": f"{source['name']} (copy)"[:120],
        "enabled": False,
        "created_at": timestamp,
        "updated_at": timestamp,
        "created_by": user["id"],
        "updated_by": user["id"],
    }
    await _workflow_database(company_id).workflows.insert_one(dict(duplicate))
    return duplicate


@api.post("/workflow-builder/{workflow_id}/status")
async def set_workflow_status(
    workflow_id: str, body: WorkflowToggleIn, company_id: str, user=Depends(get_current_user),
):
    require_global_owner(user)
    await _workflow_company(company_id)
    await _get_workflow_or_404(workflow_id, company_id)
    await _workflow_database(company_id).workflows.update_one(
        {"id": workflow_id, "company_id": company_id},
        {"$set": {"enabled": body.enabled, "updated_at": now_iso(), "updated_by": user["id"]}},
    )
    return await _get_workflow_or_404(workflow_id, company_id)


@api.post("/workflow-builder/{workflow_id}/test")
async def dry_run_workflow(
    workflow_id: str, body: WorkflowDryRunIn, company_id: str, user=Depends(get_current_user),
):
    require_global_owner(user)
    await _workflow_company(company_id)
    workflow = await _get_workflow_or_404(workflow_id, company_id)
    try:
        payload = validate_event_payload(workflow["trigger"], body.event_data)
        matched, evaluated = evaluate_conditions(
            workflow["trigger"], workflow["conditions"], workflow["logic"], payload,
        )
    except (WorkflowValidationError, KeyError) as error:
        raise HTTPException(400, str(error)) from error
    started = datetime.now(timezone.utc)
    completed = datetime.now(timezone.utc)
    run = {
        "id": new_id(),
        "workflow_id": workflow["id"],
        "workflow_name": workflow["name"],
        "company_id": company_id,
        "trigger": workflow["trigger"],
        "event_id": f"dry-run:{new_id()}",
        "started_at": started.isoformat(),
        "completed_at": completed.isoformat(),
        "duration_ms": 0,
        "dry_run": True,
        "conditions_evaluated": evaluated,
        "actions_attempted": [
            {"type": action["type"], "status": "dry_run"}
            for action in (workflow["actions"] if matched else [])
        ],
        "actions_completed": [],
        "actions_requiring_approval": [],
        "result": "dry_run_matched" if matched else "dry_run_no_match",
        "error_details": [],
    }
    await _workflow_database(company_id).workflow_runs.insert_one(dict(run))
    return {
        "matched": matched,
        "conditions_evaluated": evaluated,
        "actions": run["actions_attempted"],
        "run_id": run["id"],
        "dry_run": True,
    }


@api.delete("/workflow-builder/{workflow_id}")
async def delete_workflow(workflow_id: str, company_id: str, user=Depends(get_current_user)):
    require_global_owner(user)
    await _workflow_company(company_id)
    workflow = await _get_workflow_or_404(workflow_id, company_id)
    await _workflow_database(company_id).workflows.delete_one({"id": workflow_id, "company_id": company_id})
    await _workflow_database(company_id).workflow_runs.update_many(
        {"workflow_id": workflow_id, "company_id": company_id},
        {"$set": {"workflow_deleted": True, "workflow_name": workflow["name"]}},
    )
    return {"ok": True, "deleted": True}


@api.get("/workflow-builder/runs")
async def get_workflow_runs(
    company_id: str,
    workflow_id: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    user=Depends(get_current_user),
):
    require_global_owner(user)
    await _workflow_company(company_id)
    query = {"company_id": company_id}
    if workflow_id:
        query["workflow_id"] = workflow_id
    workflow_db = _workflow_database(company_id)
    total = await workflow_db.workflow_runs.count_documents(query)
    records = await workflow_db.workflow_runs.find(query, {"_id": 0}).sort(
        "started_at", -1,
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {"items": records, "page": page, "page_size": page_size, "total": total}


@api.get("/workflow-builder/outputs")
async def get_workflow_outputs(
    company_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    user=Depends(get_current_user),
):
    require_global_owner(user)
    await _workflow_company(company_id)
    query = {"company_id": company_id}
    workflow_db = _workflow_database(company_id)
    total = await workflow_db.workflow_artifacts.count_documents(query)
    records = await workflow_db.workflow_artifacts.find(query, {"_id": 0}).sort(
        "created_at", -1,
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {"items": records, "page": page, "page_size": page_size, "total": total}


@api.post("/workflow-builder/outputs/{output_id}/decision")
async def decide_workflow_approval(
    output_id: str,
    body: WorkflowApprovalDecisionIn,
    company_id: str,
    user=Depends(get_current_user),
):
    require_global_owner(user)
    await _workflow_company(company_id)
    if body.decision not in ("approved", "rejected"):
        raise HTTPException(400, "Decision must be approved or rejected")
    updated = await _workflow_database(company_id).workflow_artifacts.find_one_and_update(
        {
            "id": output_id,
            "company_id": company_id,
            "type": "request_global_owner_approval",
            "status": "pending",
        },
        {"$set": {
            "status": body.decision,
            "decision_note": (body.note or "").strip(),
            "decided_by": user["id"],
            "decided_at": now_iso(),
        }},
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(404, "Pending approval request not found")
    return updated


async def emit_workflow_event(trigger, record):
    company_id = active_company_id.get()
    if trigger not in TRIGGER_DEFINITIONS or company_id not in {
        profile["id"] for profile in COMPANY_PROFILES
    }:
        return
    workflow_db = _workflow_database(company_id)
    try:
        payload = validate_event_payload(trigger, event_payload(trigger, record or {}))
        workflows = await workflow_db.workflows.find(
            {"company_id": company_id, "trigger": trigger, "enabled": True},
            {"_id": 0},
        ).to_list(None)
    except Exception:
        logging.exception("Could not load workflows for %s in %s", trigger, company_id)
        return

    for workflow in workflows:
        if workflow.get("company_id") != company_id or workflow.get("enabled") is not True:
            continue
        try:
            safe_definition = validate_workflow_definition(workflow)
        except WorkflowValidationError:
            logging.error(
                "Skipping invalid stored workflow %s in company %s",
                workflow.get("id"),
                company_id,
            )
            continue
        workflow = {**workflow, **safe_definition}
        started = datetime.now(timezone.utc)
        event_reference = str(record.get("id") or "")
        event_version = record.get("updated_at") or record.get("created_at") or ""
        event_id = f"{trigger}:{event_reference}:{event_version}"
        run = {
            "id": new_id(),
            "workflow_id": workflow["id"],
            "workflow_name": workflow["name"],
            "company_id": company_id,
            "trigger": trigger,
            "event_id": event_id,
            "event_reference": event_reference,
            "started_at": started.isoformat(),
            "completed_at": None,
            "duration_ms": 0,
            "dry_run": False,
            "conditions_evaluated": [],
            "actions_attempted": [],
            "actions_completed": [],
            "actions_requiring_approval": [],
            "result": "running",
            "error_details": [],
        }
        try:
            await workflow_db.workflow_runs.insert_one(dict(run))
        except DuplicateKeyError:
            continue
        except Exception:
            logging.exception("Could not claim workflow execution %s", workflow.get("id"))
            continue

        try:
            matched, evaluated = evaluate_conditions(
                trigger, workflow.get("conditions", []), workflow.get("logic", "all"), payload,
            )
            run["conditions_evaluated"] = evaluated
            if not matched:
                run["result"] = "conditions_not_met"
            else:
                completed_actions = []
                failed_actions = []
                approvals = []
                for action in workflow.get("actions", []):
                    attempted = {"type": action["type"], "status": "attempted"}
                    run["actions_attempted"].append(attempted)
                    artifact_id = new_id()
                    title = render_action_template(
                        action.get("title") or ACTION_DEFINITIONS[action["type"]], payload,
                    )
                    artifact = {
                        "id": artifact_id,
                        "company_id": company_id,
                        "workflow_id": workflow["id"],
                        "workflow_name": workflow["name"],
                        "type": action["type"],
                        "title": title,
                        "message": render_action_template(action["message"], payload),
                        "source_trigger": trigger,
                        "source_event_id": event_id,
                        "status": "pending" if action["type"] == "request_global_owner_approval" else "prepared",
                        "created_at": now_iso(),
                    }
                    try:
                        await workflow_db.workflow_artifacts.insert_one(artifact)
                        attempted["status"] = "completed"
                        completed_actions.append(action["type"])
                        if action["type"] == "request_global_owner_approval":
                            approvals.append(artifact_id)
                    except Exception as error:
                        attempted["status"] = "failed"
                        failed_actions.append(action["type"])
                        run["error_details"].append(
                            f"{action['type']}: {type(error).__name__}: {str(error)[:400]}"
                        )
                run["actions_completed"] = completed_actions
                run["actions_requiring_approval"] = approvals
                if failed_actions and completed_actions:
                    run["result"] = "partial"
                elif failed_actions:
                    run["result"] = "failed"
                else:
                    run["result"] = "success"
            completed = datetime.now(timezone.utc)
            run["completed_at"] = completed.isoformat()
            run["duration_ms"] = max(0, int((completed - started).total_seconds() * 1000))
            await workflow_db.workflow_runs.update_one(
                {"id": run["id"], "company_id": company_id},
                {"$set": {
                    key: value for key, value in run.items()
                    if key not in {"id", "workflow_id", "company_id", "trigger", "event_id"}
                }},
            )
        except Exception as error:
            logging.exception("Workflow execution failed for %s", workflow.get("id"))
            completed = datetime.now(timezone.utc)
            run.update({
                "completed_at": completed.isoformat(),
                "duration_ms": max(0, int((completed - started).total_seconds() * 1000)),
                "result": "failed",
                "error_details": [f"{type(error).__name__}: {str(error)[:400]}"],
            })
            try:
                await workflow_db.workflow_runs.update_one(
                    {"id": run["id"], "company_id": company_id},
                    {"$set": {
                        key: value for key, value in run.items()
                        if key not in {"id", "workflow_id", "company_id", "trigger", "event_id"}
                    }},
                )
            except Exception:
                logging.exception("Could not record workflow execution failure %s", run["id"])


@api.post("/auth/register")
async def register(body: RegisterIn, user=Depends(get_current_user)):
    require_owner(user)
    email = canonical_email(body.email)
    name = body.name.strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(400, "Enter a valid email address")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must contain at least 8 characters")
    if not name:
        raise HTTPException(400, "Name is required")
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "An account with this email already exists")
    user = {"id": new_id(), "email": email, "name": name, "password_hash": hash_pw(body.password),
            "role": "user", "username": email,
            "company_roles": {user["_active_company_id"]: "user"},
            "company_ids": [user["_active_company_id"]], "active": True,
            "created_at": now_iso(), "auth_provider": "password"}
    await db.users.insert_one(dict(user))
    await log_audit("auth", user["id"], "account_registered", user)
    session_id = new_id()
    await base_db.user_sessions.insert_one({"id": session_id, "user_id": user["id"], "company_id": user["_active_company_id"],
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7), "created_at": now_iso(), "last_seen": now_iso()})
    return {"token": make_token(user["id"], email, user["_active_company_id"], session_id),
            "user": public_user({**user, "id": user["id"], "email": email, "name": name,
                                 "role": "user", "company_roles": {user["_active_company_id"]: "user"},
                                 "_active_role": "user"})}

@api.post("/auth/login")
async def login(body: LoginIn, response: Response):
    if body.personal_access_token:
        user = await find_worker_by_access_token(body.personal_access_token)
        if not user or not verify_pw(body.password, user.get("password_hash", "")):
            raise HTTPException(401, "Invalid worker access link or password")
        assigned_companies = [
            company_id for company_id, assigned_role in (user.get("company_roles") or {}).items()
            if assigned_role in ("owner", "admin", "user")
        ]
        if len(assigned_companies) != 1:
            raise HTTPException(403, "Worker must be assigned to exactly one company")
        identifier = user.get("username") or user.get("email") or ""
        company_id = assigned_companies[0]
    else:
        identifier = canonical_email(body.email or body.username)
        if not identifier:
            raise HTTPException(400, "Username or email is required")
        username_pattern = {"$regex": f"^{re.escape(identifier)}$", "$options": "i"}
        candidates = await base_db.users.find(
            {"$or": [{"email": identifier}, {"username": username_pattern}]}, {"_id": 0},
        ).to_list(20)
        user = next((candidate for candidate in candidates
                     if verify_pw(body.password, candidate.get("password_hash", ""))), None)
        company_id = body.company_id or DEFAULT_COMPANY_ID
    if not user:
        raise HTTPException(401, "Invalid email or password")
    if user.get("active") is False or user.get("disabled") is True:
        raise HTTPException(403, "Account is disabled")
    if user.get("is_worker") and user.get("personal_access_revoked"):
        raise HTTPException(403, "Worker access has been revoked")
    role = company_role(user, company_id)
    if role not in ("owner", "admin", "user"):
        raise HTTPException(403, "You do not have access to this company")
    session_id = new_id()
    now = now_iso()
    await base_db.user_sessions.insert_one({"id": session_id, "user_id": user["id"], "company_id": company_id,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7), "created_at": now, "last_seen": now})
    user["_active_company_id"] = company_id
    user["_active_role"] = role
    response.delete_cookie("session_token", path="/", secure=True, samesite="none")
    return {"token": make_token(user["id"], user.get("email") or identifier, company_id, session_id),
            "user": public_user(user)}

@api.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return public_user(user)

@api.get("/companies/profiles")
async def company_profiles(request: Request):
    authenticated = request.headers.get("Authorization", "").startswith("Bearer ") \
        or request.cookies.get("session_token")
    if authenticated:
        try:
            user = await get_current_user(request)
        except HTTPException as error:
            if error.status_code != 401:
                raise
            user = None
        if user and user.get("is_worker"):
            company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
            return [{
                "id": company["id"], "name": company["name"], "username": company["username"],
            } for company in COMPANY_PROFILES if company["id"] == company_id]
    return [{"id": company["id"], "name": company["name"], "username": company["username"]}
            for company in COMPANY_PROFILES]

@api.get("/access/profiles")
async def access_profiles(user=Depends(get_current_user)):
    require_owner(user)
    result = []
    for profile in COMPANY_PROFILES:
        profile_id = profile["id"]
        owner_account = await base_db.users.find_one({
            "profile_id": profile_id, "profile_login": "owner",
        }, {"_id": 0, "id": 1})
        admin_account = await base_db.users.find_one({
            "profile_id": profile_id, "profile_login": "admin",
        }, {"_id": 0, "id": 1})
        if not admin_account:
            admin_account = await base_db.users.find_one({
                "profile_id": profile_id, "profile_login": "user",
                f"company_roles.{profile_id}": {"$ne": "owner"},
            }, {"_id": 0, "id": 1})
        if not admin_account:
            admin_account = await base_db.users.find_one({
                "profile_id": profile_id,
                "is_worker": {"$ne": True},
                "role": {"$ne": "owner"},
                f"company_roles.{profile_id}": {"$ne": "owner"},
            }, {"_id": 0, "id": 1})
        result.append({
            "id": profile_id,
            "name": profile["name"],
            "username": profile["username"],
            "configured": owner_account is not None or admin_account is not None,
            "owner_configured": owner_account is not None,
            "admin_configured": admin_account is not None,
        })
    return result

@api.put("/access/profiles/{profile_id}/password/{account_type}")
async def update_profile_password(
    profile_id: str, account_type: str, body: ProfilePasswordIn,
    user=Depends(get_current_user),
):
    require_owner(user)
    profile = next((item for item in COMPANY_PROFILES if item["id"] == profile_id), None)
    if not profile:
        raise HTTPException(404, "Profile not found")
    if account_type not in ("admin", "user", "owner"):
        raise HTTPException(404, "Profile account type not found")
    account_type = "admin" if account_type == "user" else account_type
    if len(body.password) < 8:
        raise HTTPException(400, "Password must contain at least 8 characters")

    account = await base_db.users.find_one({
        "profile_id": profile_id, "profile_login": account_type,
    }, {"_id": 0})
    if not account and account_type == "admin":
        account = await base_db.users.find_one({
            "profile_id": profile_id, "profile_login": "user",
            f"company_roles.{profile_id}": {"$ne": "owner"},
        }, {"_id": 0})
    if not account and account_type == "admin":
        account = await base_db.users.find_one({
            "profile_id": profile_id,
            "is_worker": {"$ne": True},
            "role": {"$ne": "owner"},
            f"company_roles.{profile_id}": {"$ne": "owner"},
        }, {"_id": 0})
    account_id = account["id"] if account else new_id()
    company_role_value = "owner" if account_type == "owner" else "admin"
    previous_role = (account.get("company_roles") or {}).get(profile_id) if account else None
    adding_admin = (
        account_type == "admin"
        and previous_role != "admin"
        and (account or {}).get("active", True) is not False
    )
    if adding_admin:
        await reserve_company_admin(profile_id)
    updates = {
        "username": profile["username"],
        "name": (account or {}).get("name") or profile["name"],
        "email": (account or {}).get("email") or "",
        "password_hash": hash_pw(body.password),
        "role": "user",
        "company_roles": {profile_id: company_role_value},
        "company_ids": [profile_id],
        "active": (account or {}).get("active", True),
        "auth_provider": "password",
        "profile_id": profile_id,
        "profile_login": account_type,
    }
    if account:
        result = await base_db.users.update_one({"id": account_id}, {"$set": updates})
        if result.matched_count != 1:
            if adding_admin:
                await release_company_admin(profile_id)
            raise HTTPException(409, "Profile account changed; reload and try again")
    else:
        await base_db.users.insert_one({"id": account_id, "created_at": now_iso(), **updates})
    if adding_admin and account_type == "admin":
        await log_audit("user", account_id, "profile_admin_assigned", user,
                        after={"profile_id": profile_id, "role": "admin"})
    await log_audit("user", account_id, "profile_password_updated", user,
                    after={"profile_id": profile_id, "account_type": account_type})
    return {"profile_id": profile_id, "account_type": account_type, "configured": True}

@api.put("/access/profiles/{profile_id}")
async def update_access_profile(profile_id: str, body: ProfileCredentialsIn, user=Depends(get_current_user)):
    require_owner(user)
    profile = next((item for item in COMPANY_PROFILES if item["id"] == profile_id), None)
    if not profile:
        raise HTTPException(404, "Profile not found")

    username = body.username.strip() if body.username is not None else None
    password = body.password
    if username is not None and not username:
        raise HTTPException(400, "Username is required")
    if password is not None and password and len(password) < 8:
        raise HTTPException(400, "Password must contain at least 8 characters")
    if not username and not password:
        raise HTTPException(400, "Enter a username or a new password")

    account = await base_db.users.find_one({
        "profile_id": profile_id, "profile_login": "admin",
    }, {"_id": 0})
    if not account:
        account = await base_db.users.find_one({
            "profile_id": profile_id, "profile_login": "user",
            f"company_roles.{profile_id}": {"$ne": "owner"},
        }, {"_id": 0})
    if not account:
        account = await base_db.users.find_one({
            "profile_id": profile_id, "is_worker": {"$ne": True}, "role": {"$ne": "owner"},
            f"company_roles.{profile_id}": {"$ne": "owner"},
        }, {"_id": 0})
    if account and account.get("role") == "owner":
        raise HTTPException(409, "Global owner credentials must be changed through the owner account")

    if not account and (not username or not password):
        raise HTTPException(404, "Profile account is not configured; provide a username and password to create it")

    updates = {}
    if username is not None:
        duplicate_query = {
            "username": {"$regex": f"^{re.escape(username)}$", "$options": "i"},
        }
        if account:
            duplicate_query["id"] = {"$ne": account["id"]}
        duplicate = await base_db.users.find_one(duplicate_query, {"_id": 0})
        if duplicate:
            allowed_profile_pair = (
                duplicate.get("profile_id") == profile_id and
                duplicate.get("profile_login") in ("owner", "admin", "user") and
                duplicate.get("profile_login") != (account or {}).get("profile_login")
            )
            if not allowed_profile_pair:
                raise HTTPException(409, "Username already exists")
        updates["username"] = username
    if password:
        updates["password_hash"] = hash_pw(password)
    updates["profile_id"] = profile_id
    previous_role = (account.get("company_roles") or {}).get(profile_id) if account else None
    active_account = (account or {}).get("active", True) is not False
    adding_admin = account is None or (previous_role != "admin" and active_account)
    if adding_admin and active_account:
        await reserve_company_admin(profile_id)
    updates["profile_login"] = "admin"
    updates["company_roles"] = {profile_id: "admin"}
    updates["company_ids"] = [profile_id]
    if account:
        result = await base_db.users.update_one({"id": account["id"]}, {"$set": updates})
        if result.matched_count != 1:
            if adding_admin and active_account:
                await release_company_admin(profile_id)
            raise HTTPException(409, "Profile account changed; reload and try again")
        account_id = account["id"]
        before_username = account.get("username", "")
    else:
        account_id = new_id()
        before_username = ""
        await base_db.users.insert_one({
            "id": account_id, "name": username, "email": "", "created_at": now_iso(),
            "role": "user", "company_roles": {profile_id: "admin"}, "company_ids": [profile_id],
            "active": True, "auth_provider": "password", **updates,
        })

    await log_audit("user", account_id, "profile_credentials_updated", user,
                    before={"username": before_username},
                    after={"username": updates.get("username", before_username)})
    return {"id": profile_id, "name": profile["name"],
            "username": updates.get("username", before_username), "configured": True}

@api.post("/auth/switch-company")
async def switch_company(body: SwitchCompanyIn, user=Depends(get_current_user)):
    has_company_owner_access = (
        user.get("role") == "owner"
        or (
            not user.get("is_worker")
            and any(
                assigned_role == "owner"
                for assigned_role in (user.get("company_roles") or {}).values()
            )
        )
    )
    if user.get("is_worker") or (
        not has_company_owner_access and not is_delegated_company_admin(user)
    ):
        raise HTTPException(403, "Company admin access required")
    selected = await authorize_company(user, body.company_id, user.get("_session_id"))
    session_id = user.get("_session_id") or new_id()
    await base_db.user_sessions.update_one({"id": session_id}, {"$set": {
        "id": session_id, "user_id": user["id"], "company_id": body.company_id,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7), "last_seen": now_iso(),
    }}, upsert=True)
    return {"token": make_token(user["id"], user.get("email", ""), body.company_id, session_id),
            "user": public_user(selected)}

@api.post("/auth/device")
async def register_device(body: DeviceIn, request: Request, user=Depends(get_current_user)):
    if not body.device_id.strip():
        raise HTTPException(400, "Device ID is required")
    updates = {"device_name": body.device_name[:180], "timezone": body.timezone[:100],
               "ip_address": request.client.host if request.client else "", "last_seen": now_iso()}
    if body.share_location and body.latitude is not None and body.longitude is not None:
        if not (-90 <= body.latitude <= 90 and -180 <= body.longitude <= 180):
            raise HTTPException(400, "Invalid location coordinates")
        updates["location"] = {"latitude": body.latitude, "longitude": body.longitude, "shared_at": now_iso()}
    elif not body.share_location:
        updates["location"] = None
    await db.user_devices.update_one({"user_id": user["id"], "device_id": body.device_id.strip()},
        {"$set": updates, "$setOnInsert": {"user_id": user["id"], "device_id": body.device_id.strip(), "first_seen": now_iso()}}, upsert=True)
    return {"ok": True}

def require_admin(user):
    if user.get("_active_role") not in ("owner", "admin"):
        raise HTTPException(403, "Administrator access required for this company")

def require_price_list_owner(user):
    if user.get("_active_role") == "admin":
        raise HTTPException(403, "Only company owners can change the price list")

def require_invoice_delete_access(user):
    if user.get("_active_role") in ("owner", "admin"):
        return
    if worker_restrictions_apply(user):
        permission = worker_write_permission(user, "/api/invoices/invoice-id", "DELETE")
        if (
            "invoices" in set(user.get("worker_allowed_sections") or [])
            and (not permission or permission[2] != "deny")
        ):
            return
    raise HTTPException(403, "Invoice deletion requires administrator access or an enabled worker permission")


def require_worker_management_owner(company_id, user):
    if user.get("is_worker"):
        raise HTTPException(403, "Only company owners can manage worker accounts")
    if user.get("role") == "owner":
        return
    if (user.get("company_roles") or {}).get(company_id) != "owner":
        raise HTTPException(403, "Only company owners can manage worker accounts")


@api.get("/access/workers")
async def get_workers(company_id: str = "", user=Depends(get_current_user)):
    company_id = company_id or user["_active_company_id"]
    require_worker_management_owner(company_id, user)
    workers = await base_db.users.find(
        {"is_worker": True, f"company_roles.{company_id}": {"$in": ["user", "admin", "owner"]}},
        {"_id": 0, "password_hash": 0},
    ).to_list(1000)
    return [{
        "id": worker["id"],
        "name": worker.get("name", ""),
        "username": worker.get("username", ""),
        "worker_role": worker.get("worker_role", ""),
        "allowed_sections": worker.get("worker_allowed_sections", []),
        "stock_only": worker.get("worker_stock_only", False),
        "is_supervisor": worker.get("worker_is_supervisor", False),
        "warehouse_ids": worker_warehouse_ids(worker),
        "supervisor_password_actions": worker.get("worker_supervisor_password_actions", []),
        "write_permissions": worker.get("worker_write_permissions", {}),
        "can_edit_invoice_prices": worker.get("worker_can_edit_invoice_prices", False),
        "is_admin": (worker.get("company_roles") or {}).get(company_id) == "admin",
        "company_id": company_id,
        "active": worker.get("active", True),
    } for worker in workers]

async def worker_access_details(worker_id, company_id, user):
    require_worker_management_owner(company_id, user)
    worker = await base_db.users.find_one({
        "id": worker_id, "is_worker": True,
        f"company_roles.{company_id}": {"$in": ["user", "admin", "owner"]},
    }, {"_id": 0, "password_hash": 0})
    if not worker:
        raise HTTPException(404, "Worker not found in this company")
    profile = next((item for item in COMPANY_PROFILES if item["id"] == company_id), None)
    if not profile:
        raise HTTPException(404, "Company profile not found")
    encrypted_token = worker.get("personal_access_token_encrypted")
    token = decrypt_worker_access_token(encrypted_token) if encrypted_token else None
    link_active = bool(token and not worker.get("personal_access_revoked", False)
                       and worker.get("active", True))
    return {
        "id": worker["id"],
        "name": worker.get("name", ""),
        "username": worker.get("username", ""),
        "worker_role": worker.get("worker_role", ""),
        "company_id": company_id,
        "company_name": profile["name"],
        "allowed_sections": worker.get("worker_allowed_sections", []),
        "stock_only": worker.get("worker_stock_only", False),
        "is_supervisor": worker.get("worker_is_supervisor", False),
        "warehouse_ids": worker_warehouse_ids(worker),
        "supervisor_password_actions": worker.get("worker_supervisor_password_actions", []),
        "write_permissions": worker.get("worker_write_permissions", {}),
        "can_edit_invoice_prices": worker.get("worker_can_edit_invoice_prices", False),
        "is_admin": (worker.get("company_roles") or {}).get(company_id) == "admin",
        "active": worker.get("active", True),
        "can_regenerate": worker.get("active", True) is not False
                          or worker.get("personal_access_revoked", False),
        "link_active": link_active,
        "access_token": token if link_active else None,
    }

@api.get("/access/workers/{worker_id}/personal-link")
async def get_worker_personal_link(
    worker_id: str, company_id: str, response: Response, user=Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    return await worker_access_details(worker_id, company_id, user)

async def issue_worker_personal_link(worker_id, company_id, user, regenerate=False):
    details = await worker_access_details(worker_id, company_id, user)
    worker = await base_db.users.find_one({"id": worker_id, "is_worker": True}, {"_id": 0})
    if not worker:
        raise HTTPException(404, "Worker not found")
    if details["link_active"] and not regenerate:
        return details
    if worker.get("active") is False and not worker.get("personal_access_revoked", False):
        raise HTTPException(403, "Worker account is disabled")
    reactivating_admin = (
        worker.get("active") is False
        and worker.get("personal_access_revoked", False)
        and (worker.get("company_roles") or {}).get(company_id) == "admin"
    )
    if reactivating_admin:
        await reserve_company_admin(company_id)
    token = secrets.token_urlsafe(32)
    updates = {
        "personal_access_token_hash": worker_access_token_hash(token),
        "personal_access_token_encrypted": encrypt_worker_access_token(token),
        "personal_access_revoked": False,
    }
    if worker.get("personal_access_revoked"):
        updates["active"] = True
    try:
        result = await base_db.users.update_one({"id": worker_id, "is_worker": True}, {"$set": updates})
    except Exception:
        if reactivating_admin:
            await release_company_admin(company_id)
        raise
    if result.matched_count != 1:
        if reactivating_admin:
            await release_company_admin(company_id)
        raise HTTPException(409, "Worker account changed; reload and try again")
    await log_audit("user", worker_id, "worker_access_link_regenerated" if regenerate else "worker_access_link_created",
                    user, after={"company_id": company_id})
    return {**details, "active": True, "can_regenerate": True, "link_active": True, "access_token": token}

@api.post("/access/workers/{worker_id}/personal-link")
async def create_worker_personal_link(
    worker_id: str, company_id: str, response: Response, user=Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    return await issue_worker_personal_link(worker_id, company_id, user)

@api.post("/access/workers/{worker_id}/personal-link/regenerate")
async def regenerate_worker_personal_link(
    worker_id: str, company_id: str, response: Response, user=Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    return await issue_worker_personal_link(worker_id, company_id, user, regenerate=True)

@api.delete("/access/workers/{worker_id}/personal-link")
async def revoke_worker_personal_link(
    worker_id: str, company_id: str, user=Depends(get_current_user),
):
    details = await worker_access_details(worker_id, company_id, user)
    result = await base_db.users.update_one({"id": worker_id, "is_worker": True}, {"$set": {
        "active": False,
        "personal_access_revoked": True,
        "personal_access_token_hash": None,
        "personal_access_token_encrypted": None,
    }})
    if result.matched_count != 1:
        raise HTTPException(404, "Worker not found")
    if (
        details["active"] is not False
        and details["is_admin"]
    ):
        await release_company_admin(company_id)
    await base_db.user_sessions.delete_many({"user_id": worker_id})
    await log_audit("user", worker_id, "worker_access_link_revoked", user,
                    before={"company_id": company_id}, after={"active": False})
    return {**details, "active": False, "can_regenerate": True, "link_active": False, "access_token": None}

@api.put("/access/workers/{worker_id}/password")
async def update_worker_password(
    worker_id: str, company_id: str, body: ProfilePasswordIn,
    user=Depends(get_current_user),
):
    require_worker_management_owner(company_id, user)
    if len(body.password) < 8:
        raise HTTPException(400, "Password must contain at least 8 characters")
    worker = await base_db.users.find_one({
        "id": worker_id, "is_worker": True,
        f"company_roles.{company_id}": {"$in": ["user", "admin", "owner"]},
    }, {"_id": 0, "id": 1})
    if not worker:
        raise HTTPException(404, "Worker not found in this company")
    await base_db.users.update_one({"id": worker_id, "is_worker": True}, {"$set": {
        "password_hash": hash_pw(body.password),
        "auth_provider": "password",
    }})
    await base_db.user_sessions.delete_many({"user_id": worker_id})
    await log_audit("user", worker_id, "worker_password_updated", user,
                    after={"company_id": company_id})
    return {"ok": True}

@api.get("/worker-access/{token}")
async def worker_access_link_info(token: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    worker = await find_worker_by_access_token(token)
    if not worker:
        raise HTTPException(404, "This worker access link is invalid or revoked")
    company_ids = [
        company_id for company_id, role in (worker.get("company_roles") or {}).items()
        if role in ("owner", "admin", "user")
    ]
    if len(company_ids) != 1:
        raise HTTPException(403, "Worker must be assigned to exactly one company")
    company_id = company_ids[0]
    profile = next((item for item in COMPANY_PROFILES if item["id"] == company_id), None)
    if not profile:
        raise HTTPException(403, "Worker company is unavailable")
    return {
        "username": worker.get("username", ""),
        "company_id": company_id,
        "company_name": profile["name"],
    }

@api.post("/access/workers")
async def create_worker(body: CreateWorkerIn, user=Depends(get_current_user)):
    company_id = body.company_id
    require_worker_management_owner(company_id, user)
    if not await base_db.companies.find_one({"id": company_id, "active": True}, {"_id": 0}):
        raise HTTPException(400, "Selected company is unavailable")
    username = body.username.strip()
    name = body.name.strip()
    worker_role = body.worker_role.strip()
    if not username or not name or not worker_role:
        raise HTTPException(400, "Name, username and role are required")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must contain at least 8 characters")
    sections = worker_sections(body.allowed_sections, body.stock_only)
    validate_worker_company_sections(company_id, sections)
    requested_warehouses = body.warehouse_ids or ([body.warehouse_id] if body.warehouse_id else [])
    warehouse_ids, protected_actions = worker_supervisor_settings(
        company_id, body.is_supervisor, requested_warehouses, body.supervisor_password_actions, sections,
    )
    write_permissions = validate_worker_write_permissions(body.write_permissions, sections)
    can_edit_invoice_prices = validate_worker_invoice_price_permission(
        body.can_edit_invoice_prices, sections,
    )
    if body.stock_only and body.is_supervisor:
        raise HTTPException(400, "Stock-only workers cannot be supervisors")
    validate_worker_supervisor_sections(sections, protected_actions)
    email = (body.email or "").strip().lower()
    if email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(400, "Enter a valid email address")
    username_query = {"username": {"$regex": f"^{re.escape(username)}$", "$options": "i"}}
    if await base_db.users.find_one(username_query, {"_id": 0}):
        raise HTTPException(409, "Username already exists")
    if email and await base_db.users.find_one({"email": email}, {"_id": 0}):
        raise HTTPException(409, "An account with this email already exists")
    if body.is_admin:
        await reserve_company_admin(company_id)
    account = {
        "id": new_id(),
        "username": username,
        "email": email,
        "name": name,
        "password_hash": hash_pw(body.password),
        "role": "user",
        "company_roles": {company_id: "admin" if body.is_admin else "user"},
        "company_ids": [company_id],
        "is_worker": True,
        "worker_role": worker_role,
        "worker_allowed_sections": sections,
        "worker_stock_only": body.stock_only,
        "worker_is_supervisor": body.is_supervisor,
        "worker_warehouse_ids": warehouse_ids,
        "worker_warehouse_id": warehouse_ids[0] if warehouse_ids else None,
        "worker_supervisor_password_actions": protected_actions,
        "worker_write_permissions": write_permissions,
        "worker_can_edit_invoice_prices": can_edit_invoice_prices,
        "active": True,
        "auth_provider": "password",
        "created_at": now_iso(),
    }
    try:
        await base_db.users.insert_one(dict(account))
    except Exception:
        if body.is_admin:
            await release_company_admin(company_id)
        raise
    company_context = active_company_id.set(company_id)
    try:
        await log_audit("user", account["id"], "worker_created", user, after={
            "username": username,
            "worker_role": worker_role,
            "company_id": company_id,
            "allowed_sections": sections,
            "stock_only": body.stock_only,
            "is_supervisor": body.is_supervisor,
            "warehouse_ids": warehouse_ids,
            "supervisor_password_actions": protected_actions,
            "write_permissions": write_permissions,
            "can_edit_invoice_prices": can_edit_invoice_prices,
            "is_admin": body.is_admin,
        })
    finally:
        active_company_id.reset(company_context)
    return {
        "id": account["id"],
        "username": username,
        "name": name,
        "worker_role": worker_role,
        "company_id": company_id,
        "allowed_sections": sections,
        "stock_only": body.stock_only,
        "is_supervisor": body.is_supervisor,
        "warehouse_ids": warehouse_ids,
        "supervisor_password_actions": protected_actions,
        "write_permissions": write_permissions,
        "can_edit_invoice_prices": can_edit_invoice_prices,
        "is_admin": body.is_admin,
        "active": True,
    }

@api.put("/access/workers/{worker_id}")
async def update_worker_access(
    worker_id: str, body: WorkerAccessUpdateIn, company_id: str,
    user=Depends(get_current_user),
):
    require_worker_management_owner(company_id, user)
    worker = await base_db.users.find_one({
        "id": worker_id, "is_worker": True, f"company_roles.{company_id}": {"$in": ["user", "admin"]},
    }, {"_id": 0})
    if not worker:
        raise HTTPException(404, "Worker not found in this company")
    worker_role = body.worker_role.strip()
    sections = worker_sections(body.allowed_sections, body.stock_only)
    validate_worker_company_sections(company_id, sections)
    requested_warehouses = body.warehouse_ids or ([body.warehouse_id] if body.warehouse_id else [])
    warehouse_ids, protected_actions = worker_supervisor_settings(
        company_id, body.is_supervisor, requested_warehouses, body.supervisor_password_actions, sections,
    )
    write_permissions = validate_worker_write_permissions(body.write_permissions, sections)
    inherited_price_permission = worker.get("worker_can_edit_invoice_prices", False) and bool(
        {"invoices", "express-invoices"}.intersection(sections)
    )
    can_edit_invoice_prices = validate_worker_invoice_price_permission(
        body.can_edit_invoice_prices
        if body.can_edit_invoice_prices is not None
        else inherited_price_permission,
        sections,
    )
    if body.stock_only and body.is_supervisor:
        raise HTTPException(400, "Stock-only workers cannot be supervisors")
    validate_worker_supervisor_sections(sections, protected_actions)
    if not worker_role:
        raise HTTPException(400, "Worker role is required")
    before = {"worker_role": worker.get("worker_role", ""),
              "allowed_sections": worker.get("worker_allowed_sections", []),
              "stock_only": worker.get("worker_stock_only", False),
              "is_supervisor": worker.get("worker_is_supervisor", False),
              "warehouse_ids": worker_warehouse_ids(worker),
              "supervisor_password_actions": worker.get("worker_supervisor_password_actions", []),
              "write_permissions": worker.get("worker_write_permissions", {}),
              "can_edit_invoice_prices": worker.get("worker_can_edit_invoice_prices", False),
              "is_admin": (worker.get("company_roles") or {}).get(company_id) == "admin"}
    company_roles = dict(worker.get("company_roles") or {})
    was_admin = company_roles.get(company_id) == "admin"
    is_admin = was_admin if body.is_admin is None else body.is_admin
    worker_active = worker.get("active", True) is not False
    adding_admin = is_admin and not was_admin and worker_active
    removing_admin = was_admin and not is_admin and worker_active
    if adding_admin:
        await reserve_company_admin(company_id)
    company_roles[company_id] = "admin" if is_admin else "user"
    try:
        result = await base_db.users.update_one({"id": worker_id, "is_worker": True}, {"$set": {
            "worker_role": worker_role, "worker_allowed_sections": sections,
            "worker_stock_only": body.stock_only,
            "worker_is_supervisor": body.is_supervisor,
            "worker_warehouse_ids": warehouse_ids,
            "worker_warehouse_id": warehouse_ids[0] if warehouse_ids else None,
            "worker_supervisor_password_actions": protected_actions,
            "worker_write_permissions": write_permissions,
            "worker_can_edit_invoice_prices": can_edit_invoice_prices,
            "company_roles": company_roles,
        }})
    except Exception:
        if adding_admin:
            await release_company_admin(company_id)
        raise
    if result.matched_count != 1:
        if adding_admin:
            await release_company_admin(company_id)
        raise HTTPException(409, "Worker access changed; reload and try again")
    if removing_admin:
        await release_company_admin(company_id)
    await base_db.user_sessions.delete_many({"user_id": worker_id})
    await log_audit("user", worker_id, "worker_access_updated", user, before=before,
                    after={"worker_role": worker_role, "allowed_sections": sections,
                           "stock_only": body.stock_only,
                           "is_supervisor": body.is_supervisor,
                           "warehouse_ids": warehouse_ids,
                           "supervisor_password_actions": protected_actions,
                           "write_permissions": write_permissions,
                           "can_edit_invoice_prices": can_edit_invoice_prices,
                           "is_admin": is_admin})
    return {
        "id": worker_id,
        "name": worker.get("name", ""),
        "username": worker.get("username", ""),
        "worker_role": worker_role,
        "company_id": company_id,
        "allowed_sections": sections,
        "stock_only": body.stock_only,
        "is_supervisor": body.is_supervisor,
        "warehouse_ids": warehouse_ids,
        "supervisor_password_actions": protected_actions,
        "write_permissions": write_permissions,
        "can_edit_invoice_prices": can_edit_invoice_prices,
        "is_admin": is_admin,
        "active": worker.get("active", True),
    }

@api.delete("/access/workers/{worker_id}")
async def remove_worker(worker_id: str, company_id: str, user=Depends(get_current_user)):
    require_worker_management_owner(company_id, user)
    worker = await base_db.users.find_one({
        "id": worker_id, "is_worker": True, f"company_roles.{company_id}": {"$in": ["user", "admin"]},
    }, {"_id": 0})
    if not worker:
        raise HTTPException(404, "Worker not found in this company")
    await log_audit("user", worker_id, "worker_permanently_deleted", user,
                    before={"username": worker.get("username"), "name": worker.get("name"),
                            "company_id": company_id})
    if (
        worker.get("active", True) is not False
        and (worker.get("company_roles") or {}).get(company_id) == "admin"
    ):
        await release_company_admin(company_id)
    await base_db.user_sessions.delete_many({"user_id": worker_id})
    await base_db.user_devices.delete_many({"user_id": worker_id})
    await base_db.assistant_sessions.delete_many({"user_id": worker_id})
    await base_db.users.delete_one({"id": worker_id, "is_worker": True})
    return {"ok": True, "deleted": True}

@api.get("/access/users")
async def access_users(user=Depends(get_current_user)):
    require_owner(user)
    primary_owner_email = canonical_email(os.environ["ADMIN_EMAIL"])
    users = await listall("users", sort=("created_at", 1))
    devices = await listall("user_devices", sort=("last_seen", -1))
    sessions = await base_db.user_sessions.find({}, {"_id": 0, "user_id": 1, "company_id": 1, "created_at": 1, "last_seen": 1, "expires_at": 1}).to_list(10000)
    device_map = {}
    for device in devices:
        device_map.setdefault(device["user_id"], []).append(device)
    session_map = {}
    for session in sessions:
        session_map.setdefault(session.get("user_id"), []).append(session)
    now = datetime.now(timezone.utc)
    result = []
    profiles_by_id = {profile["id"]: profile for profile in COMPANY_PROFILES}
    company_ids = set(profiles_by_id)
    profile_account_summaries = {}

    def as_utc_datetime(value):
        if not value:
            return None
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed

    for account in users:
        account_sessions = session_map.get(account["id"], [])
        active_sessions = []
        last_login_at = None
        last_access_by_company = {}
        for session in account_sessions:
            seen_at = as_utc_datetime(session.get("last_seen") or session.get("created_at"))
            if seen_at and (last_login_at is None or seen_at > last_login_at):
                last_login_at = seen_at
            company_id = session.get("company_id")
            if company_id in company_ids and seen_at and (
                company_id not in last_access_by_company
                or seen_at > last_access_by_company[company_id]
            ):
                last_access_by_company[company_id] = seen_at
            expires_at = as_utc_datetime(session.get("expires_at"))
            if expires_at and expires_at > now and seen_at and (now - seen_at).total_seconds() <= 300:
                active_sessions.append((seen_at, session))
        memberships = account.get("company_roles") or {}
        if account.get("role") == "owner":
            memberships = {company_id: "owner" for company_id in allowed_company_ids(account)}
        current_session = max(active_sessions, key=lambda item: item[0], default=(None, {}))[1]
        profile_id = account.get("profile_id")
        profile = profiles_by_id.get(profile_id)
        profile_aliases = {
            profile["name"].casefold(),
            profile["username"].casefold(),
            profile_id.replace("-", " ").casefold(),
        } if profile else set()
        is_profile_login = bool(
            profile
            and not account.get("is_worker")
            and (
                account.get("profile_login") in ("admin", "user", "owner")
                or (account.get("email") or "").casefold().endswith("@profiles.invalid")
                or (account.get("username") or "").strip().casefold() in profile_aliases
                or (account.get("name") or "").strip().casefold() in profile_aliases
            )
        )
        last_access_by_company = {
            company_id: seen_at.isoformat()
            for company_id, seen_at in last_access_by_company.items()
        }
        if is_profile_login:
            profile_role = memberships.get(profile_id)
            if profile_role not in ("admin", "owner"):
                profile_role = "owner" if account.get("profile_login") == "owner" else "admin"
            summary = profile_account_summaries.get(profile_id)
            if summary is None:
                summary = {
                    "id": f"profile-account:{profile_id}",
                    "name": profile["name"],
                    "username": profile["username"],
                    "email": "",
                    "role": "user",
                    "is_owner": False,
                    "is_profile_account": True,
                    "profile_id": profile_id,
                    "active": False,
                    "is_worker": False,
                    "is_primary_owner": False,
                    "company_roles": {},
                    "company_ids": [],
                    "online": False,
                    "current_company_id": "",
                    "last_login": "",
                    "last_access_by_company": {},
                    "created_at": account.get("created_at", ""),
                    "devices": [],
                    "_latest_activity": None,
                }
                profile_account_summaries[profile_id] = summary
            if summary["company_roles"].get(profile_id) != "owner":
                summary["company_roles"][profile_id] = profile_role
            summary["company_ids"] = list(summary["company_roles"])
            summary["active"] = summary["active"] or account.get("active", True) is not False
            summary["online"] = summary["online"] or bool(active_sessions)
            for company_id, seen_at in last_access_by_company.items():
                previous = summary["last_access_by_company"].get(company_id, "")
                if seen_at > previous:
                    summary["last_access_by_company"][company_id] = seen_at
            last_login = last_login_at.isoformat() if last_login_at else ""
            if last_login > summary["last_login"]:
                summary["last_login"] = last_login
            active_seen_at = max(active_sessions, key=lambda item: item[0], default=(None, {}))[0]
            if active_seen_at and (
                summary["_latest_activity"] is None or active_seen_at > summary["_latest_activity"]
            ):
                summary["_latest_activity"] = active_seen_at
                summary["current_company_id"] = current_session.get("company_id", "")
            summary["devices"].extend(device_map.get(account["id"], []))
            continue

        result.append({"id": account["id"], "name": account.get("name", ""), "email": account.get("email", ""),
            "username": account.get("username", ""), "role": account.get("role", "user"),
            "is_owner": account.get("role") == "owner", "active": account.get("active", True),
            "is_worker": account.get("is_worker", False),
            "is_primary_owner": canonical_email(account.get("email")) == primary_owner_email,
            "company_roles": memberships, "company_ids": list(memberships), "online": bool(active_sessions),
            "current_company_id": current_session.get("company_id", ""),
            "last_login": last_login_at.isoformat() if last_login_at else "",
            "last_access_by_company": last_access_by_company,
            "created_at": account.get("created_at", ""), "devices": device_map.get(account["id"], [])})
    for summary in profile_account_summaries.values():
        summary.pop("_latest_activity", None)
        result.append(summary)
    if user.get("is_primary_owner") is False:
        for account in result:
            for field in ("online", "current_company_id", "last_login", "last_access_by_company", "devices"):
                account.pop(field, None)
    return result

@api.post("/access/users")
async def create_access_user(body: CreateAccessUserIn, user=Depends(get_current_user)):
    require_owner(user)
    username = body.username.strip()
    name = body.name.strip()
    if not username or not name:
        raise HTTPException(400, "Username and name are required")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must contain at least 8 characters")
    if not body.company_ids or any(cid not in {profile["id"] for profile in COMPANY_PROFILES} for cid in body.company_ids):
        raise HTTPException(400, "Assign the user to at least one valid company")
    existing_username = await base_db.users.find_one({
        "username": {"$regex": f"^{re.escape(username)}$", "$options": "i"},
    }, {"_id": 0})
    profile_login = False
    if existing_username:
        is_owner_profile_username = (
            username.casefold() == COMPANY_PROFILES[0]["username"].casefold() and
            existing_username.get("role") == "owner" and
            len(body.company_ids) == 1 and body.company_ids[0] == COMPANY_PROFILES[0]["id"]
        )
        if not is_owner_profile_username:
            raise HTTPException(409, "Username already exists")
        existing_profile_admin = await base_db.users.find_one({
            "profile_id": COMPANY_PROFILES[0]["id"],
            "profile_login": {"$in": ["admin", "user"]},
        }, {"_id": 0})
        if existing_profile_admin:
            raise HTTPException(409, "An admin login for this profile already exists")
        profile_login = True
    email = (body.email or "").strip().lower()
    if email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(400, "Enter a valid email address")
    company_roles = {cid: "user" for cid in dict.fromkeys(body.company_ids)}
    if profile_login:
        company_roles[COMPANY_PROFILES[0]["id"]] = "admin"
        await reserve_company_admin(COMPANY_PROFILES[0]["id"])
    account = {"id": new_id(), "username": username, "email": email, "name": name,
        "password_hash": hash_pw(body.password), "role": "user",
        "company_roles": company_roles,
        "company_ids": list(dict.fromkeys(body.company_ids)), "active": True,
        "auth_provider": "password", "created_at": now_iso()}
    if profile_login:
        account["profile_id"] = COMPANY_PROFILES[0]["id"]
        account["profile_login"] = "admin"
    await base_db.users.insert_one(dict(account))
    await log_audit("user", account["id"], "account_created", user,
        after={"username": username, "company_roles": account["company_roles"]})
    return {"id": account["id"], "username": username, "email": email, "name": name,
        "role": "admin" if profile_login else "user", "company_roles": account["company_roles"],
        "company_ids": account["company_ids"], "active": True}

async def reserve_company_admin(company_id):
    result = await base_db.company_admin_counts.update_one(
        {"_id": company_id, "count": {"$lt": 3}}, {"$inc": {"count": 1}})
    if result.matched_count != 1:
        raise HTTPException(400, f"{company_id} already has 3 active admins")

async def release_company_admin(company_id):
    await base_db.company_admin_counts.update_one(
        {"_id": company_id, "count": {"$gt": 0}}, {"$inc": {"count": -1}})

@api.put("/access/users/{uid}/role")
async def update_user_role(uid: str, body: UserRoleIn, user=Depends(get_current_user)):
    require_owner(user)
    if body.role not in ("admin", "user"):
        raise HTTPException(400, "Role must be admin or user")
    target = await db.users.find_one({"id": uid}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("is_worker"):
        raise HTTPException(400, "Manage worker roles and sections from the Dashboard Workers table")
    if target.get("role") == "owner":
        raise HTTPException(400, "The global owner role cannot be changed")
    if body.company_id not in allowed_company_ids(user):
        raise HTTPException(400, "Unknown company")
    roles = dict(target.get("company_roles") or {})
    previous = roles.get(body.company_id)
    target_active = target.get("active", True) is not False
    adding_admin = body.role == "admin" and previous != "admin" and target_active
    removing_admin = body.role == "user" and previous == "admin" and target_active
    if adding_admin:
        await reserve_company_admin(body.company_id)
    roles[body.company_id] = body.role
    company_ids = list(dict.fromkeys([*target.get("company_ids", []), body.company_id]))
    result = await db.users.update_one({"id": uid, "role": {"$ne": "owner"}}, {"$set": {
        "company_roles": roles, "company_ids": company_ids,
    }})
    if result.matched_count != 1:
        if adding_admin:
            await release_company_admin(body.company_id)
        raise HTTPException(409, "Account role changed; reload and try again")
    if removing_admin:
        await release_company_admin(body.company_id)
    await log_audit("user", uid, "company_role_updated", user,
                    before={"company_id": body.company_id, "role": previous},
                    after={"company_id": body.company_id, "role": body.role})
    return {"id": uid, "company_id": body.company_id, "role": body.role}

@api.put("/access/users/{uid}/owner")
async def promote_access_user_to_owner(
    uid: str, body: OwnerPromotionIn, user=Depends(get_current_user),
):
    require_owner(user)
    primary_owner = await base_db.users.find_one({
        "email": canonical_email(os.environ["ADMIN_EMAIL"]), "role": "owner",
    }, {"_id": 0, "id": 1, "password_hash": 1})
    if not primary_owner or user["id"] != primary_owner["id"]:
        raise HTTPException(403, "Only the primary owner can assign owner access")
    if not verify_pw(body.owner_password, primary_owner.get("password_hash", "")):
        raise HTTPException(403, "Owner password is incorrect")
    if body.company_id not in {profile["id"] for profile in COMPANY_PROFILES}:
        raise HTTPException(400, "Unknown company")

    target = await base_db.users.find_one({"id": uid}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("is_worker"):
        raise HTTPException(400, "Workers cannot be promoted through company access settings")
    if target.get("role") == "owner" or (target.get("company_roles") or {}).get(body.company_id) == "owner":
        raise HTTPException(409, "This account is already an owner for this company")
    if target.get("active") is False or target.get("disabled") is True:
        raise HTTPException(400, "Enable the account before assigning owner access")

    company_roles = dict(target.get("company_roles") or {})
    previous_role = company_roles.get(body.company_id)
    company_roles[body.company_id] = "owner"
    company_ids = list(dict.fromkeys([*target.get("company_ids", []), body.company_id]))
    changed = await base_db.users.update_one(
        {"id": uid, "role": {"$ne": "owner"}},
        {"$set": {
            "company_roles": company_roles,
            "company_ids": company_ids,
            "is_worker": False,
            "worker_role": "",
            "worker_allowed_sections": [],
        }},
    )
    if changed.matched_count != 1:
        raise HTTPException(409, "Account role changed; reload and try again")
    if previous_role == "admin":
        await release_company_admin(body.company_id)
    await log_audit("user", uid, "company_owner_assigned", user,
                    before={"company_id": body.company_id, "role": previous_role},
                    after={"company_id": body.company_id, "role": "owner"})
    return {"id": uid, "role": "owner", "is_owner": False, "is_company_owner": True,
            "company_id": body.company_id, "company_ids": company_ids, "company_roles": company_roles}

@api.put("/access/users/{uid}/companies")
async def update_user_companies(uid: str, body: UserCompaniesIn, user=Depends(get_current_user)):
    require_owner(user)
    target = await base_db.users.find_one({"id": uid}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("is_worker"):
        raise HTTPException(400, "Manage worker company access from the Dashboard Workers table")
    if target.get("role") == "owner":
        raise HTTPException(400, "The global owner always has access to all companies")
    known = {profile["id"] for profile in COMPANY_PROFILES}
    company_ids = list(dict.fromkeys(body.company_ids))
    if not company_ids or any(company_id not in known for company_id in company_ids):
        raise HTTPException(400, "Assign at least one valid company")
    old_roles = dict(target.get("company_roles") or {})
    new_roles = {company_id: old_roles.get(company_id, "user") for company_id in company_ids}
    removed_admins = [company_id for company_id, role in old_roles.items()
                      if role == "admin" and company_id not in new_roles]
    await base_db.users.update_one({"id": uid, "role": {"$ne": "owner"}}, {"$set": {
        "company_roles": new_roles, "company_ids": company_ids,
    }})
    if target.get("active", True) is not False:
        for company_id in removed_admins:
            await release_company_admin(company_id)
    await log_audit("user", uid, "company_access_updated", user,
                    before={"company_roles": old_roles}, after={"company_roles": new_roles})
    return {"id": uid, "company_ids": company_ids, "company_roles": new_roles}

@api.put("/access/users/{uid}/status")
async def set_access_user_status(uid: str, body: UserStatusIn, user=Depends(get_current_user)):
    require_owner(user)
    target = await base_db.users.find_one({"id": uid}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("role") == "owner":
        raise HTTPException(400, "The owner account cannot be disabled")
    was_active = target.get("active", True) is not False
    if was_active == body.active:
        return {"id": uid, "active": body.active}
    admin_companies = [cid for cid, role in (target.get("company_roles") or {}).items() if role == "admin"]
    reserved = []
    if body.active:
        try:
            for company_id in admin_companies:
                await reserve_company_admin(company_id)
                reserved.append(company_id)
        except HTTPException:
            for company_id in reserved:
                await release_company_admin(company_id)
            raise
    changed = await base_db.users.update_one({"id": uid, "active": {"$ne": body.active}}, {"$set": {"active": body.active}})
    if changed.matched_count != 1:
        for company_id in reserved:
            await release_company_admin(company_id)
        raise HTTPException(409, "Account status changed; reload and try again")
    if not body.active:
        for company_id in admin_companies:
            await release_company_admin(company_id)
        await base_db.user_sessions.delete_many({"user_id": uid})
    await log_audit("user", uid, "account_status_updated", user,
        before={"active": target.get("active", True)}, after={"active": body.active})
    return {"id": uid, "active": body.active}

@api.delete("/access/users/{uid}")
async def remove_access_user(uid: str, user=Depends(get_current_user)):
    require_owner(user)
    if uid == user["id"]:
        raise HTTPException(400, "You cannot remove your own account")
    target = await db.users.find_one({"id": uid}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("email", "").lower() == os.environ["ADMIN_EMAIL"].lower():
        raise HTTPException(400, "The owner account cannot be removed")
    await log_audit("user", uid, "account_removed", user,
                    before={"email": target.get("email"), "name": target.get("name"), "role": target.get("role")})
    await base_db.user_sessions.delete_many({"user_id": uid})
    await base_db.user_devices.delete_many({"user_id": uid})
    await base_db.assistant_sessions.delete_many({"user_id": uid})
    await base_db.users.delete_one({"id": uid})
    if target.get("active", True) is not False:
        for company_id, role in (target.get("company_roles") or {}).items():
            if role == "admin":
                await release_company_admin(company_id)
    return {"ok": True}

class GoogleSessionIn(BaseModel):
    session_id: str
    company_id: str = DEFAULT_COMPANY_ID

@api.post("/auth/google/session")
async def google_session(body: GoogleSessionIn, response: Response):
    import httpx
    async with httpx.AsyncClient(timeout=15) as hc:
        r = await hc.get("https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data", headers={"X-Session-ID": body.session_id})
    if r.status_code != 200:
        raise HTTPException(401, "Google sign-in failed or expired. Please try again")
    data = r.json()
    email = canonical_email(data.get("email"))
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user or user.get("active") is False:
        raise HTTPException(403, "Ask the owner to create and assign your account before using Google sign-in")
    if user.get("is_worker") and user.get("personal_access_revoked"):
        raise HTTPException(403, "Worker access has been revoked")
    company_id = body.company_id
    role = company_role(user, company_id)
    if role not in ("owner", "admin", "user"):
        raise HTTPException(403, "Your account is not assigned to this company")
    active_company_id.set(company_id)
    await db.users.update_one({"id": user["id"]}, {"$set": {"picture": data.get("picture", ""), "google_name": data.get("name", "")}})
    token = data["session_token"]
    session_id = new_id()
    await db.user_sessions.insert_one({"id": session_id, "session_token": token, "user_id": user["id"], "company_id": company_id,
                                       "expires_at": datetime.now(timezone.utc) + timedelta(days=7), "created_at": now_iso(), "last_seen": now_iso()})
    response.set_cookie("session_token", token, httponly=True, secure=True, samesite="none", path="/", max_age=7 * 24 * 3600)
    await log_audit("auth", user["id"], "google_login", user)
    user["_active_company_id"] = company_id
    user["_active_role"] = role
    return {"token": make_token(user["id"], email, company_id, session_id), "user": public_user(user)}

@api.post("/auth/logout")
async def logout(request: Request, response: Response):
    tok = request.cookies.get("session_token")
    if tok:
        await db.user_sessions.delete_one({"session_token": tok})
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        try:
            payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
            if payload.get("sid"):
                await base_db.user_sessions.delete_one({"id": payload["sid"]})
        except jwt.InvalidTokenError:
            pass
    response.delete_cookie("session_token", path="/", secure=True, samesite="none")
    return {"ok": True}

# ---------------- Generic helpers ----------------
async def insert(coll, data, session=None):
    session = session or active_mongo_session.get()
    session_options = {"session": session} if session is not None else {}
    data = dict(data)
    data.setdefault("id", new_id())
    data["created_at"] = now_iso()
    await db[coll].insert_one(data, **session_options)
    return clean(await db[coll].find_one({"id": data["id"]}, {"_id": 0}, **session_options))

async def update_doc(coll, _id, data, session=None):
    session = session or active_mongo_session.get()
    session_options = {"session": session} if session is not None else {}
    data = {k: v for k, v in data.items() if k not in ("id", "_id", "created_at")}
    data["updated_at"] = now_iso()
    res = await db[coll].update_one({"id": _id}, {"$set": data}, **session_options)
    if res.matched_count == 0:
        raise HTTPException(404, "Not found")
    return clean(await db[coll].find_one({"id": _id}, {"_id": 0}, **session_options))

async def next_ref(key, prefix):
    year = local_today().year
    c = await db.counters.find_one_and_update({"id": f"{key}-{year}"}, {"$inc": {"seq": 1}}, upsert=True, return_document=ReturnDocument.AFTER)
    return f"{prefix}-{year}-{c['seq']:04d}"

async def listall(coll, flt=None, sort=None, limit=5000, session=None):
    session = session or active_mongo_session.get()
    session_options = {"session": session} if session is not None else {}
    cur = db[coll].find(flt or {}, {"_id": 0}, **session_options)
    if sort:
        cur = cur.sort(sort[0], sort[1])
    return await cur.to_list(limit)


async def find_page(collection, query, sort, page, page_size, projection):
    cursor = (
        collection.find(query, projection)
        .sort([(sort[0], sort[1]), ("id", 1)])
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    total, items = await asyncio.gather(
        collection.count_documents(query),
        cursor.to_list(length=page_size),
    )
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ---------------- Warehouse A reports ----------------
class WarehouseReportLineIn(BaseModel):
    model_config = {"extra": "forbid"}

    quantity: float = Field(gt=0, le=1_000_000_000, allow_inf_nan=False)


class WarehouseChemicalUsageIn(WarehouseReportLineIn):
    chemical: str = Field(min_length=1, max_length=120)
    unit: str = Field(min_length=1, max_length=20)

    @field_validator("chemical", "unit")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


class WarehouseBlockQuantityIn(WarehouseReportLineIn):
    quantity: int = Field(gt=0, le=1_000_000_000)
    block_type: str = Field(min_length=1, max_length=120)
    size: str = Field(min_length=1, max_length=120)

    @field_validator("block_type", "size")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


class WarehouseFoamCutIn(WarehouseReportLineIn):
    pieces_recovered: int = Field(gt=0, le=1_000_000_000)
    size: str = Field(min_length=1, max_length=120)
    unit: str = Field(min_length=1, max_length=20)

    @field_validator("size", "unit")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


class WarehouseSheetCutIn(WarehouseReportLineIn):
    quantity: int = Field(gt=0, le=1_000_000_000)
    pieces_recovered: int = Field(gt=0, le=1_000_000_000)
    size: str = Field(min_length=1, max_length=120)

    @field_validator("size")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


class WarehouseReportIn(BaseModel):
    model_config = {"extra": "forbid"}

    date: str = Field(default_factory=today_str, pattern=r"^\d{4}-\d{2}-\d{2}$")
    chemicals: List[WarehouseChemicalUsageIn] = Field(default_factory=list, max_length=100)
    manufactured_blocks: List[WarehouseBlockQuantityIn] = Field(default_factory=list, max_length=100)
    foam_cut: List[WarehouseFoamCutIn] = Field(default_factory=list, max_length=100)
    damaged_blocks: List[WarehouseBlockQuantityIn] = Field(default_factory=list, max_length=100)
    sheets_cut: List[WarehouseSheetCutIn] = Field(default_factory=list, max_length=100)
    notes: str = Field(default="", max_length=2000)

    @field_validator("date")
    @classmethod
    def validate_report_date(cls, value):
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("Enter a valid report date") from error
        return value

    @model_validator(mode="after")
    def require_report_data(self):
        if not any((
            self.chemicals, self.manufactured_blocks, self.foam_cut,
            self.damaged_blocks, self.sheets_cut,
        )):
            raise ValueError("Add at least one warehouse activity before saving")
        return self


class WarehouseFoamReceivedIn(WarehouseReportLineIn):
    unit: str = Field(min_length=1, max_length=20)

    @field_validator("unit")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


class WarehouseMattressQuantityIn(WarehouseReportLineIn):
    quantity: int = Field(gt=0, le=1_000_000_000)
    size: str = Field(min_length=1, max_length=120)

    @field_validator("size")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


class WarehouseBReportIn(BaseModel):
    model_config = {"extra": "forbid"}

    date: str = Field(default_factory=today_str, pattern=r"^\d{4}-\d{2}-\d{2}$")
    foam_received: List[WarehouseFoamReceivedIn] = Field(default_factory=list, max_length=100)
    mattresses_received: List[WarehouseMattressQuantityIn] = Field(default_factory=list, max_length=100)
    mattresses_completed: List[WarehouseMattressQuantityIn] = Field(default_factory=list, max_length=100)
    notes: str = Field(default="", max_length=2000)

    @field_validator("date")
    @classmethod
    def validate_report_date(cls, value):
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("Enter a valid report date") from error
        return value

    @model_validator(mode="after")
    def require_report_data(self):
        if not any((self.foam_received, self.mattresses_received, self.mattresses_completed)):
            raise ValueError("Add at least one warehouse activity before saving")
        return self


class WarehouseCCompletedStockIn(WarehouseReportLineIn):
    quantity: int = Field(gt=0, le=1_000_000_000)
    size: str = Field(min_length=1, max_length=120)

    @field_validator("size")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


class WarehouseCDispatchLineIn(BaseModel):
    model_config = {"extra": "forbid"}

    customer_name: str = Field(min_length=1, max_length=200)
    invoice_number: str = Field(min_length=1, max_length=80)
    size: str = Field(min_length=1, max_length=120)
    ordered_quantity: int = Field(gt=0, le=1_000_000_000)
    loaded_quantity: int = Field(ge=0, le=1_000_000_000)

    @field_validator("customer_name", "invoice_number", "size")
    @classmethod
    def validate_nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()

    @model_validator(mode="after")
    def loaded_quantity_cannot_exceed_order(self):
        if self.loaded_quantity > self.ordered_quantity:
            raise ValueError("Loaded quantity cannot exceed the ordered quantity")
        return self


class WarehouseCReportIn(BaseModel):
    model_config = {"extra": "forbid"}

    date: str = Field(default_factory=today_str, pattern=r"^\d{4}-\d{2}-\d{2}$")
    completed_stock: List[WarehouseCCompletedStockIn] = Field(default_factory=list, max_length=100)
    dispatches: List[WarehouseCDispatchLineIn] = Field(default_factory=list, max_length=200)
    notes: str = Field(default="", max_length=2000)

    @field_validator("date")
    @classmethod
    def validate_report_date(cls, value):
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("Enter a valid report date") from error
        return value

    @model_validator(mode="after")
    def require_report_data(self):
        if not self.completed_stock and not self.dispatches:
            raise ValueError("Add completed stock or a customer dispatch before saving")
        return self


def require_warehouse_report_access(user, warehouse_id):
    if user.get("_active_company_id") != MANUFACTURING_COMPANY_ID:
        raise HTTPException(403, "Warehouse reports are only available in IQFOAM Manufacturing")
    if worker_restrictions_apply(user) and (
        not {
            "warehouses",
            f"warehouse-{warehouse_id.lower()}",
        }.intersection(user.get("worker_allowed_sections", []))
        or warehouse_id not in worker_warehouse_ids(user)
    ):
        raise HTTPException(403, f"This worker account cannot access Warehouse {warehouse_id} reports")


class ChemicalLineIn(BaseModel):
    model_config = {"extra": "forbid"}

    chemical: str = Field(min_length=1, max_length=120)
    unit: str = Field(default="kg", max_length=20)
    used_quantity: float = Field(default=0, ge=0, le=1_000_000_000)
    initial_quantity: Optional[float] = Field(default=None, ge=0, le=1_000_000_000)
    remaining_estimate: Optional[float] = Field(default=None, ge=0, le=1_000_000_000)
    production_id: Optional[str] = Field(default=None, max_length=100)
    production_reference: Optional[str] = Field(default=None, max_length=100)
    block_type: Optional[str] = Field(default=None, max_length=100)
    block_quantity: Optional[int] = Field(default=None, ge=1)
    component_cost: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def remaining_defaults_to_initial(self):
        if self.remaining_estimate is None:
            if self.initial_quantity is None:
                raise ValueError("Enter the estimated remaining or the initial quantity")
            self.remaining_estimate = round(self.initial_quantity - self.used_quantity, 4)
            if self.remaining_estimate < 0:
                raise ValueError("Used quantity cannot exceed the initial quantity")
        return self

    @field_validator("chemical", "unit")
    @classmethod
    def strip_text(cls, value):
        return value.strip()

    @field_validator("chemical")
    @classmethod
    def chemical_not_blank(cls, value):
        if not value:
            raise ValueError("Chemical name is required")
        return value

    @field_validator("used_quantity", "remaining_estimate", "initial_quantity")
    @classmethod
    def finite_quantity(cls, value):
        if value is not None and not math.isfinite(value):
            raise ValueError("Enter a valid quantity")
        return value


class ChemicalLogIn(BaseModel):
    model_config = {"extra": "forbid"}

    date: str = Field(default_factory=today_str, pattern=r"^\d{4}-\d{2}-\d{2}$")
    lines: List[ChemicalLineIn] = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=2000)

    @field_validator("date")
    @classmethod
    def validate_log_date(cls, value):
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("Enter a valid date") from error
        return value


CHEMICAL_COMPANY_IDS = {MANUFACTURING_COMPANY_ID, DEFAULT_COMPANY_ID}


def require_chemical_access(user):
    company_id = user.get("_active_company_id")
    if company_id not in CHEMICAL_COMPANY_IDS:
        raise HTTPException(403, "Chemical stock is not available for this company")
    company_sections = (
        {"warehouse-chemical", "warehouse-chemical-inventory"}
        if company_id == MANUFACTURING_COMPANY_ID
        else {"chemical-usage-log", "chemicals-quantity"}
    )
    if worker_restrictions_apply(user) and not company_sections.union({"warehouses"}).intersection(
        user.get("worker_allowed_sections", [])
    ):
        raise HTTPException(403, "This worker account cannot access the Chemical section")


class ProductionRecipeComponentIn(BaseModel):
    chemical: str = Field(min_length=1, max_length=120)
    quantity: float = Field(gt=0, allow_inf_nan=False)
    unit: str = Field(default="", max_length=20)
    unit_confirmation_required: bool = False
    cost: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    label: Optional[str] = Field(default="", max_length=120)

    @field_validator("chemical", "unit")
    @classmethod
    def strip_recipe_component_text(cls, value):
        return value.strip()


class ProductionRecipeIn(BaseModel):
    block_type: str = Field(min_length=1, max_length=100)
    components: List[ProductionRecipeComponentIn] = Field(min_length=1, max_length=30)
    indicated_total_cost: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)

    @field_validator("block_type")
    @classmethod
    def strip_recipe_name(cls, value):
        return value.strip()


class BlockProductionIn(BaseModel):
    request_id: str = Field(min_length=8, max_length=100)
    date: str = Field(default_factory=today_str, pattern=r"^\d{4}-\d{2}-\d{2}$")
    recipe_id: Optional[str] = Field(default=None, max_length=100)
    block_type: str = Field(min_length=1, max_length=100)
    quantity: int = Field(gt=0, le=10000)
    automatic: bool = False
    components: List[ProductionRecipeComponentIn] = Field(min_length=1, max_length=30)
    invoice_reference: str = Field(default="", max_length=120)
    supplier: str = Field(default="", max_length=120)
    document_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("date", "document_date")
    @classmethod
    def production_dates_are_valid(cls, value):
        if value is not None:
            try:
                date.fromisoformat(value)
            except ValueError as error:
                raise ValueError("Enter a valid date") from error
        return value

    @field_validator("block_type", "invoice_reference", "supplier")
    @classmethod
    def strip_production_text(cls, value):
        return value.strip()


def _production_stock_unit_factor(unit):
    normalized = unit.strip().casefold()
    if normalized in ("g", "gram", "grams"):
        return "mass", 1.0
    if normalized in ("kg", "kilogram", "kilograms"):
        return "mass", 1000.0
    if normalized in ("ml", "milliliter", "milliliters"):
        return "volume", 1.0
    if normalized in ("l", "liter", "liters"):
        return "volume", 1000.0
    return normalized, 1.0


def _convert_production_quantity(quantity, source_unit, target_unit):
    source_kind, source_factor = _production_stock_unit_factor(source_unit)
    target_kind, target_factor = _production_stock_unit_factor(target_unit)
    if source_kind != target_kind:
        raise HTTPException(
            409,
            f"Cannot convert {source_unit} to the inventory unit {target_unit}; verify the unit first",
        )
    return float(quantity) * source_factor / target_factor


def _require_block_production_access(user):
    if user.get("_active_company_id") != MANUFACTURING_COMPANY_ID:
        raise HTTPException(403, "Block production recipes are only available in IQFOAM Manufacturing")
    if worker_restrictions_apply(user) and (
        not user.get("worker_is_supervisor")
        or not {"production", "warehouses"}.issubset(set(user.get("worker_allowed_sections") or []))
    ):
        raise HTTPException(403, "Production and warehouse supervisor access is required")


async def ensure_predefined_block_recipes():
    for recipe in PREDEFINED_BLOCK_RECIPES:
        await db.production_block_recipes.update_one(
            {"id": recipe["id"]},
            {"$setOnInsert": {**recipe, "active": True, "version": 1}},
            upsert=True,
        )
    await db.production_block_recipes.update_one(
        {
            "id": "med-2350",
            "version": 1,
            "components": {"$elemMatch": {
                "chemical": "MCL",
                "quantity": 6.2,
                "unit": "kg",
            }},
        },
        {"$set": {"components.$.unit": "", "components.$.unit_confirmation_required": True}},
    )


@api.get("/production/block-recipes")
async def get_production_block_recipes(user=Depends(get_current_user)):
    _require_block_production_access(user)
    await ensure_predefined_block_recipes()
    return await listall("production_block_recipes", {"active": {"$ne": False}}, sort=("block_type", 1))


def _require_recipe_manager(user):
    if worker_restrictions_apply(user) or not is_company_admin(user):
        raise HTTPException(403, "Only a company administrator can manage saved recipes")


def _recipe_component_snapshot(components):
    return [
        {
            **component.model_dump(),
            "unit_confirmation_required": (
                component.unit_confirmation_required or not component.unit
            ),
        }
        for component in components
    ]


@api.post("/production/block-recipes")
async def create_production_block_recipe(
    body: ProductionRecipeIn, user=Depends(get_current_user),
):
    _require_block_production_access(user)
    _require_recipe_manager(user)
    recipe = {
        "id": new_id(),
        "block_type": body.block_type,
        "components": _recipe_component_snapshot(body.components),
        "indicated_total_cost": body.indicated_total_cost,
        "active": True,
        "version": 1,
        "created_at": now_iso(),
        "created_by": user["id"],
    }
    await db.production_block_recipes.insert_one(recipe)
    await log_audit("production_block_recipe", recipe["id"], "created", user, after=recipe)
    return clean(recipe)


@api.put("/production/block-recipes/{recipe_id}")
async def update_production_block_recipe(
    recipe_id: str, body: ProductionRecipeIn, user=Depends(get_current_user),
):
    _require_block_production_access(user)
    _require_recipe_manager(user)
    await ensure_predefined_block_recipes()
    before = await db.production_block_recipes.find_one({"id": recipe_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Production recipe not found")
    version = int(before.get("version") or 1) + 1
    await insert("production_block_recipe_versions", {
        "recipe_id": recipe_id,
        "version": version - 1,
        "recipe": before,
        "changed_at": now_iso(),
        "changed_by": user["id"],
    })
    recipe = await update_doc("production_block_recipes", recipe_id, {
        "block_type": body.block_type,
        "components": _recipe_component_snapshot(body.components),
        "indicated_total_cost": body.indicated_total_cost,
        "version": version,
    })
    await log_audit("production_block_recipe", recipe_id, "updated", user, before=before, after=recipe)
    return recipe


@api.get("/production/block-recipes/{recipe_id}/history")
async def get_production_block_recipe_history(recipe_id: str, user=Depends(get_current_user)):
    _require_block_production_access(user)
    return await listall(
        "production_block_recipe_versions",
        {"recipe_id": recipe_id},
        sort=("version", -1),
        limit=100,
    )


async def _production_material_allocations(components, block_quantity):
    rows = await listall("chemical_inventory", limit=5000)
    remaining_by_id = {}
    allocations = []
    initial_by_component = []
    for component_index, component in enumerate(components):
        requested = float(component["quantity"]) * block_quantity
        matching = [
            row for row in rows
            if row.get("chemical", "").strip().casefold() == component["chemical"].strip().casefold()
            and _production_stock_unit_factor(row.get("unit", ""))[0]
            == _production_stock_unit_factor(component["unit"])[0]
        ]
        if not matching:
            raise HTTPException(409, f"No compatible Chemical Inventory stock found for {component['chemical']} ({component['unit']})")
        available = 0.0
        for row in matching:
            row_total = float(row.get("capacity") or 0) * float(row.get("count") or 0)
            row_used = float(row.get("quantity_used") or 0)
            remaining_by_id.setdefault(row["id"], max(0.0, row_total - row_used))
            available += _convert_production_quantity(
                remaining_by_id[row["id"]], row["unit"], component["unit"],
            )
        initial_by_component.append(available)
        if requested - available > 1e-8:
            raise HTTPException(
                409,
                f"Insufficient chemical stock for {component['chemical']}: "
                f"available {available:g} {component['unit']}, required {requested:g} "
                f"{component['unit']}, missing {requested - available:g} {component['unit']}",
            )
        left = requested
        for row in matching:
            row_available = remaining_by_id[row["id"]]
            if row_available <= 0:
                continue
            in_component_unit = _convert_production_quantity(
                row_available, row["unit"], component["unit"],
            )
            used_in_component_unit = min(left, in_component_unit)
            used_in_row_unit = _convert_production_quantity(
                used_in_component_unit, component["unit"], row["unit"],
            )
            allocations.append({
                "component_index": component_index,
                "inventory_id": row["id"],
                "chemical": component["chemical"],
                "quantity": used_in_row_unit,
                "unit": row["unit"],
            })
            remaining_by_id[row["id"]] -= used_in_row_unit
            left -= used_in_component_unit
            if left <= 1e-8:
                break
    return rows, allocations, initial_by_component


def _transaction_unavailable(error):
    message = str(error).casefold()
    return isinstance(error, OperationFailure) and (
        error.code in (20, 72, 251, 263)
        or "transaction numbers are only allowed" in message
        or "does not support transactions" in message
    )


@api.post("/production/block-productions")
async def record_block_production(body: BlockProductionIn, user=Depends(get_current_user)):
    _require_block_production_access(user)
    existing = await db.production_block_records.find_one({"request_id": body.request_id}, {"_id": 0})
    if existing:
        if existing.get("status") == "completed":
            return existing
        raise HTTPException(409, "This production request is already being processed")
    await ensure_predefined_block_recipes()

    recipe = None
    if body.automatic:
        if not body.recipe_id:
            raise HTTPException(400, "Select a saved company recipe")
        recipe = await db.production_block_recipes.find_one(
            {"id": body.recipe_id, "active": {"$ne": False}}, {"_id": 0},
        )
        if not recipe:
            raise HTTPException(404, "Saved company recipe not found")
        if recipe["block_type"] != body.block_type:
            raise HTTPException(409, "Selected block type does not match the saved recipe")
        if len(body.components) != len(recipe["components"]):
            raise HTTPException(409, "Recipe changed; reload it and review the formula")
        components = []
        for saved, submitted in zip(recipe["components"], body.components):
            if saved["chemical"].casefold() != submitted.chemical.casefold():
                raise HTTPException(409, "Recipe changed; reload it and review the formula")
            unit = submitted.unit if saved.get("unit_confirmation_required") else saved["unit"]
            if not unit:
                raise HTTPException(422, f"Confirm the unit for {saved['chemical']} before recording production")
            components.append({
                **saved,
                "unit": unit,
                "quantity": (
                    float(submitted.quantity)
                    if saved.get("unit_confirmation_required")
                    else float(saved["quantity"])
                ),
            })
    else:
        components = [component.model_dump() for component in body.components]

    for component in components:
        if not component.get("unit", "").strip():
            raise HTTPException(422, f"Unit is required for {component['chemical']}")
        if not math.isfinite(float(component["quantity"])) or float(component["quantity"]) <= 0:
            raise HTTPException(422, f"Enter a valid quantity for {component['chemical']}")
        cost = component.get("cost")
        if cost is not None and (not math.isfinite(float(cost)) or float(cost) < 0):
            raise HTTPException(422, f"Enter a valid cost for {component['chemical']}")

    inventory_rows, allocations, initial_by_component = await _production_material_allocations(
        components, body.quantity,
    )
    record_id = new_id()
    reference = f"BP-{body.date.replace('-', '')}-{record_id[:8].upper()}"
    costs_complete = all(component.get("cost") is not None for component in components)
    known_cost_per_block = round(sum(float(component["cost"] or 0) for component in components), 2)
    missing_cost_components = list(dict.fromkeys(
        component.get("label") or component["chemical"]
        for component in components if component.get("cost") is None
    ))
    recipe_snapshot = {
        "id": recipe.get("id") if recipe else None,
        "version": recipe.get("version") if recipe else None,
        "block_type": body.block_type,
        "components": components,
        "indicated_total_cost": recipe.get("indicated_total_cost") if recipe else None,
    }
    record = {
        "id": record_id,
        "request_id": body.request_id,
        "reference": reference,
        "date": body.date,
        "block_type": body.block_type,
        "quantity": body.quantity,
        "recipe_id": recipe_snapshot["id"],
        "recipe_version": recipe_snapshot["version"],
        "recipe_snapshot": recipe_snapshot,
        "automatic": body.automatic,
        "components": components,
        "invoice_reference": body.invoice_reference,
        "supplier": body.supplier,
        "document_date": body.document_date,
        "supervisor_id": user["id"],
        "supervisor_name": user.get("name") or user.get("username") or "",
        "stock_id": "",
        "known_cost_per_block": known_cost_per_block,
        "known_total_cost": round(known_cost_per_block * body.quantity, 2),
        "cost_complete": costs_complete,
        "missing_cost_components": missing_cost_components,
        "status": "processing",
        "created_at": now_iso(),
    }

    inventory_ids = [row["id"] for row in inventory_rows if any(
        allocation["inventory_id"] == row["id"] for allocation in allocations
    )]
    chemical_log_id = None
    stock = None
    created_stock = False
    movement = None
    try:
        async with BlockStockIdentityLock(body.block_type):
            stock = await db.stock.find_one(
                {"product": body.block_type, "size": "Block"}, {"_id": 0},
            )
            if not stock:
                stock = await insert("stock", {
                    "product": body.block_type, "size": "Block", "opening": 0,
                    "threshold": 0, "unit_cost": None,
                })
                created_stock = True
            record["stock_id"] = stock["id"]
            async with StockLock([stock["id"]]), ChemicalInventoryLock(inventory_ids):
                session = await client.start_session()
                async with session:
                    async with session.start_transaction():
                        session_token = active_mongo_session.set(session)
                        try:
                            await db.production_block_records.insert_one(record)
                            current_rows = await listall(
                                "chemical_inventory",
                                {"id": {"$in": inventory_ids}},
                                limit=len(inventory_ids) or 1,
                            )
                            current_by_id = {row["id"]: row for row in current_rows}
                            for allocation in allocations:
                                row = current_by_id.get(allocation["inventory_id"])
                                if not row:
                                    raise HTTPException(409, "Chemical stock changed; reload and try again")
                                result = await db.chemical_inventory.update_one(
                                    {
                                        "id": row["id"],
                                        "$expr": {
                                            "$gte": [
                                                {
                                                    "$subtract": [
                                                        {
                                                            "$multiply": [
                                                                {"$ifNull": ["$capacity", 0]},
                                                                {"$ifNull": ["$count", 0]},
                                                            ],
                                                        },
                                                        {"$ifNull": ["$quantity_used", 0]},
                                                    ],
                                                },
                                                allocation["quantity"],
                                            ],
                                        },
                                    },
                                    {"$inc": {"quantity_used": allocation["quantity"]}},
                                )
                                if not result.matched_count:
                                    raise HTTPException(409, "Chemical stock changed; reload and try again")
                                movement_record = await insert("chemical_inventory_movements", {
                                    "production_id": record_id,
                                    "production_reference": reference,
                                    "inventory_id": row["id"],
                                    "chemical": allocation["chemical"],
                                    "quantity": allocation["quantity"],
                                    "unit": row["unit"],
                                    "direction": -1,
                                    "date": body.date,
                                    "movement_type": "production_usage",
                                    "block_type": body.block_type,
                                    "block_quantity": body.quantity,
                                    "supervisor_id": user["id"],
                                    "supervisor_name": record["supervisor_name"],
                                    "recipe_id": recipe_snapshot["id"],
                                    "recipe_version": recipe_snapshot["version"],
                                    "created_at": now_iso(),
                                })
                                allocation["movement_id"] = movement_record["id"]
                            await post_movement(
                                stock, "production", body.quantity, user,
                                reason=f"Block production {reference}", reference=reference,
                                dedupe_key=f"block-production:{record_id}",
                                extra={
                                    "block_production_id": record_id,
                                    "unit_cost": known_cost_per_block if costs_complete else None,
                                    "total_cost": record["known_total_cost"] if costs_complete else None,
                                },
                            )
                            movement = await db.stock_movements.find_one(
                                {"dedupe_key": f"block-production:{record_id}"}, {"_id": 0},
                            )
                            after_rows = await listall("chemical_inventory", limit=5000)
                            usage_lines = []
                            for index, component in enumerate(components):
                                total_remaining = 0.0
                                kind = _production_stock_unit_factor(component["unit"])[0]
                                for row in after_rows:
                                    if row.get("chemical", "").casefold() != component["chemical"].casefold():
                                        continue
                                    if _production_stock_unit_factor(row.get("unit", ""))[0] != kind:
                                        continue
                                    available = max(
                                        0,
                                        float(row.get("capacity") or 0) * float(row.get("count") or 0)
                                        - float(row.get("quantity_used") or 0),
                                    )
                                    total_remaining += _convert_production_quantity(
                                        available, row["unit"], component["unit"],
                                    )
                                usage_lines.append({
                                    "chemical": component["chemical"],
                                    "unit": component["unit"],
                                    "used_quantity": float(component["quantity"]) * body.quantity,
                                    "initial_quantity": initial_by_component[index],
                                    "remaining_estimate": total_remaining,
                                    "production_id": record_id,
                                    "production_reference": reference,
                                    "movement_ids": [
                                        allocation["movement_id"]
                                        for allocation in allocations
                                        if allocation["component_index"] == index
                                    ],
                                    "block_type": body.block_type,
                                    "block_quantity": body.quantity,
                                    "supervisor_name": record["supervisor_name"],
                                    "component_cost": (
                                        round(float(component["cost"]) * body.quantity, 2)
                                        if component.get("cost") is not None else None
                                    ),
                                    "unit_cost": None,
                                    "valuation_status": "not_configured",
                                })
                            chemical_log = await insert("chemical_logs", {
                                "date": body.date,
                                "notes": f"Production {reference}: {body.quantity} x {body.block_type}",
                                "lines": usage_lines,
                                "production_id": record_id,
                                "production_reference": reference,
                                "created_by": user["id"],
                                "created_by_name": record["supervisor_name"],
                            })
                            chemical_log_id = chemical_log["id"]
                            record["chemical_log_id"] = chemical_log_id
                            record["status"] = "completed"
                            record["completed_at"] = now_iso()
                            await db.production_block_records.update_one(
                                {"id": record_id},
                                {"$set": {
                                    "chemical_log_id": chemical_log_id,
                                    "status": "completed",
                                    "completed_at": record["completed_at"],
                                }},
                            )
                        finally:
                            active_mongo_session.reset(session_token)
    except Exception as error:
        if created_stock and stock:
            try:
                await db.stock.delete_one({"id": stock["id"]})
            except Exception:
                logging.exception(
                    "Could not remove empty stock item after failed block production %s",
                    record_id,
                )
                raise HTTPException(
                    500,
                    "Block production failed and its new empty stock item could not be removed",
                ) from error
        if isinstance(error, HTTPException):
            raise
        if _transaction_unavailable(error):
            raise HTTPException(
                503,
                "The database does not support transactions; no production or inventory changes were saved",
            ) from error
        if isinstance(error, DuplicateKeyError):
            existing = await db.production_block_records.find_one({"request_id": body.request_id}, {"_id": 0})
            if existing and existing.get("status") == "completed":
                return existing
            raise HTTPException(409, "This production request was already submitted") from error
        logging.exception("Block production %s failed; database transaction was aborted", record_id)
        raise HTTPException(500, "Block production failed; no inventory changes were saved") from error

    await log_audit("production_block", record_id, "completed", user, after=record)
    await log_audit("chemical_log", chemical_log_id, "production_usage_recorded", user, after=chemical_log)
    await emit_workflow_event("stock.movement_recorded", movement)
    await emit_workflow_event("production.completed", {
        **record,
        "quantity": record["quantity"],
        "block_ref": record["block_type"],
        "production_date": record["date"],
    })
    return record


@api.get("/production/block-productions")
async def get_block_productions(
    limit: int = Query(500, ge=1, le=500),
    user=Depends(get_current_user),
):
    _require_block_production_access(user)
    return await listall("production_block_records", sort=("date", -1), limit=limit)

LOW_STOCK_ALERT_RATIO = 0.2
CHEMICAL_LOW_STOCK_COVERAGE_DAYS = 3
CHEMICAL_USAGE_LOOKBACK_DAYS = 7


def chemical_low_stock_threshold(logs, chemical, unit, today=None):
    today = today or local_today()
    chemical_key = chemical.strip().casefold()
    unit_key = unit.strip().casefold()
    rows = []
    for log in logs:
        try:
            log_date = date.fromisoformat(log["date"])
        except (KeyError, TypeError, ValueError):
            continue
        for line in log.get("lines", []):
            if (
                line.get("chemical", "").strip().casefold() == chemical_key
                and line.get("unit", "").strip().casefold() == unit_key
            ):
                rows.append((log_date, line))
    if not rows:
        return 0

    reference_quantity = max(
        (float(line.get("initial_quantity") or 0) for _, line in rows),
        default=0,
    )
    reference_quantity = max(
        reference_quantity,
        max((float(line.get("remaining_estimate") or 0) for _, line in rows), default=0),
    )
    lookback_start = today - timedelta(days=CHEMICAL_USAGE_LOOKBACK_DAYS - 1)
    recent_usage = sum(
        float(line.get("used_quantity") or 0)
        for log_date, line in rows
        if lookback_start <= log_date <= today
    )
    usage_based_threshold = (
        recent_usage * CHEMICAL_LOW_STOCK_COVERAGE_DAYS / CHEMICAL_USAGE_LOOKBACK_DAYS
    )
    return max(reference_quantity * LOW_STOCK_ALERT_RATIO, usage_based_threshold)


async def update_low_stock_notification(
    user, alert_key, is_low, title, message, action_path, reference_quantity=None,
):
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    state_id = f"{company_id}:{alert_key}"
    state = await db.inventory_alert_states.find_one({"id": state_id}, {"_id": 0})
    reference = max(
        float((state or {}).get("reference_quantity") or 0),
        float(reference_quantity or 0),
    )
    if reference_quantity is not None and (
        not state or reference > float(state.get("reference_quantity") or 0)
    ):
        await db.inventory_alert_states.update_one(
            {"id": state_id},
            {"$set": {
                "active": bool((state or {}).get("active")),
                "reference_quantity": reference,
                "updated_at": now_iso(),
            }},
            upsert=True,
        )
        state = await db.inventory_alert_states.find_one({"id": state_id}, {"_id": 0})

    if not is_low:
        if not state or not state.get("active"):
            return
        await db.inventory_alert_states.update_one(
            {"id": state_id, "active": True},
            {"$set": {"active": False, "updated_at": now_iso()}},
        )
        await base_db.notifications.update_many(
            {"company_id": company_id, "event_key": state["event_key"], "archived": {"$ne": True}},
            {"$set": {"archived": True, "archived_at": now_iso()}},
        )
        return

    if state and state.get("active"):
        return

    event_key = f"inventory-low:{state_id}:{new_id()}"
    update = await db.inventory_alert_states.update_one(
        {"id": state_id, "active": {"$ne": True}},
        {"$set": {"active": True, "event_key": event_key, "updated_at": now_iso()}},
        upsert=not bool(state),
    )
    if not update.modified_count and not update.upserted_id:
        return

    accounts = await base_db.users.find(
        {"active": {"$ne": False}},
        {"_id": 0, "id": 1, "email": 1, "role": 1, "company_roles": 1, "is_worker": 1},
    ).to_list(None)
    for recipient in fleet_notification_recipients(accounts, company_id):
        notification = {
            "id": new_id(),
            "company_id": company_id,
            "recipient_user_id": recipient["id"],
            "type": "inventory_low_stock",
            "event_key": event_key,
            "title": title,
            "message": message,
            "action_path": action_path,
            "created_at": now_iso(),
            "read": False,
            "dismiss_count": 0,
            "permanently_dismissed": False,
            "archived": False,
        }
        await base_db.notifications.update_one(
            {
                "company_id": company_id,
                "event_key": event_key,
                "recipient_user_id": recipient["id"],
            },
            {"$setOnInsert": notification},
            upsert=True,
        )


@api.get("/warehouses/chemical/logs")
async def get_chemical_logs(user=Depends(get_current_user)):
    require_chemical_access(user)
    logs = await listall("chemical_logs", sort=("date", -1), limit=500)
    latest_keys = set()
    for log in logs:
        for line in log.get("lines", []):
            key = (line.get("chemical", "").strip().casefold(), line.get("unit", "").strip().casefold())
            if key in latest_keys:
                continue
            latest_keys.add(key)
            threshold = chemical_low_stock_threshold(
                logs, line.get("chemical", ""), line.get("unit", ""), local_today(),
            )
            line["low_stock_threshold"] = threshold
            line["low_stock"] = float(line.get("remaining_estimate") or 0) <= threshold
    return logs


@api.post("/warehouses/chemical/logs")
async def save_chemical_log(body: ChemicalLogIn, user=Depends(get_current_user)):
    require_chemical_access(user)
    log = await insert("chemical_logs", {
        **body.model_dump(),
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
    })
    await log_audit("chemical_log", log["id"], "created", user, after=log)
    history = await listall("chemical_logs", sort=("date", -1), limit=500)
    processed = set()
    for line in body.lines:
        chemical_key = line.chemical.strip().casefold()
        unit_key = line.unit.strip().casefold()
        key = (chemical_key, unit_key)
        if key in processed:
            continue
        processed.add(key)
        threshold = chemical_low_stock_threshold(
            history, line.chemical, line.unit, date.fromisoformat(body.date),
        )
        remaining = line.remaining_estimate
        await update_low_stock_notification(
            user,
            f"chemical:{chemical_key}:{unit_key}",
            remaining <= threshold,
            f"Low chemical stock: {line.chemical}",
            f"Estimated remaining: {remaining:g} {line.unit}. Reorder level: {threshold:g} {line.unit} "
            f"(about {CHEMICAL_LOW_STOCK_COVERAGE_DAYS} days of recent use or 20% of the recorded stock level).",
            "/warehouses/chemical",
        )
    return log


@api.delete("/warehouses/chemical/logs/{log_id}")
async def delete_chemical_log(log_id: str, user=Depends(get_current_user)):
    require_chemical_access(user)
    require_profile_owner(user)
    log = await db.chemical_logs.find_one({"id": log_id}, {"_id": 0})
    if not log:
        raise HTTPException(404, "Chemical entry not found")
    await db.chemical_logs.delete_one({"id": log_id})
    await log_audit("chemical_log", log_id, "permanently_deleted", user,
                    before=log, after={"deleted": True})
    return {"ok": True, "deleted": True}


class ChemicalInventoryIn(BaseModel):
    model_config = {"extra": "forbid"}

    chemical: str = Field(min_length=1, max_length=120)
    container_type: str = Field(min_length=1, max_length=60)
    capacity: float = Field(gt=0, allow_inf_nan=False)
    unit: str = Field(min_length=1, max_length=20)
    count: float = Field(default=1, ge=0, allow_inf_nan=False)

    @field_validator("chemical", "container_type", "unit")
    @classmethod
    def strip_inventory_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("This field is required")
        return value


class ChemicalMinimumStockIn(BaseModel):
    chemical: str = Field(min_length=1, max_length=120)
    unit: str = Field(min_length=1, max_length=20)
    minimum_quantity: float = Field(ge=0, allow_inf_nan=False)

    @field_validator("chemical", "unit")
    @classmethod
    def strip_minimum_stock_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("This field is required")
        return value


def chemical_inventory_setting_id(company_id, chemical, unit):
    return f"{company_id}:{chemical.strip().casefold()}:{unit.strip().casefold()}"


@api.get("/warehouses/chemical/inventory")
async def get_chemical_inventory(user=Depends(get_current_user)):
    require_chemical_access(user)
    items = await listall("chemical_inventory", sort=("chemical", 1), limit=1000)
    totals = {}
    for item in items:
        key = (item["chemical"].strip().casefold(), item["unit"].strip().casefold())
        available = max(
            0,
            float(item.get("capacity") or 0) * float(item.get("count") or 0)
            - float(item.get("quantity_used") or 0),
        )
        item["available_quantity"] = available
        totals[key] = totals.get(key, 0) + available
    states = await listall("inventory_alert_states", limit=2000)
    states_by_id = {state["id"]: state for state in states if state.get("id")}
    settings = await listall("chemical_inventory_settings", limit=2000)
    settings_by_id = {setting["id"]: setting for setting in settings if setting.get("id")}
    for item in items:
        key = (item["chemical"].strip().casefold(), item["unit"].strip().casefold())
        alert_key = f"chemical-inventory:{key[0]}:{key[1]}"
        state = states_by_id.get(
            f"{user.get('_active_company_id') or DEFAULT_COMPANY_ID}:{alert_key}",
        )
        reference = max(
            float((state or {}).get("reference_quantity") or 0),
            totals[key],
        )
        setting = settings_by_id.get(chemical_inventory_setting_id(
            user.get("_active_company_id") or DEFAULT_COMPANY_ID,
            item["chemical"],
            item["unit"],
        ))
        item["minimum_stock"] = setting.get("minimum_quantity") if setting else None
        item["low_stock_threshold"] = (
            float(setting["minimum_quantity"])
            if setting
            else reference * LOW_STOCK_ALERT_RATIO
        )
        item["low_stock"] = (
            totals[key] <= item["low_stock_threshold"]
            if item["low_stock_threshold"] > 0 else False
        )
        item["stock_value"] = None
        item["valuation_configured"] = False
    return items


@api.put("/warehouses/chemical/inventory/minimum")
async def set_chemical_minimum_stock(body: ChemicalMinimumStockIn, user=Depends(get_current_user)):
    require_chemical_access(user)
    if worker_restrictions_apply(user):
        if not user.get("worker_is_supervisor"):
            raise HTTPException(403, "Only a designated worker supervisor can change minimum stock levels")
    elif not is_company_admin(user):
        raise HTTPException(403, "Only a company administrator can change minimum stock levels")
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    setting_id = chemical_inventory_setting_id(company_id, body.chemical, body.unit)
    setting = {
        "id": setting_id,
        "chemical": body.chemical,
        "unit": body.unit,
        "minimum_quantity": body.minimum_quantity,
        "updated_at": now_iso(),
        "updated_by": user["id"],
    }
    await db.chemical_inventory_settings.update_one(
        {"id": setting_id},
        {"$set": setting},
        upsert=True,
    )
    total = await chemical_container_inventory_total(body.chemical, body.unit)
    await update_low_stock_notification(
        user,
        f"chemical-inventory:{body.chemical.casefold()}:{body.unit.casefold()}",
        body.minimum_quantity > 0 and total <= body.minimum_quantity,
        f"Low chemical inventory: {body.chemical}",
        f"Available: {total:g} {body.unit}. Minimum: {body.minimum_quantity:g} {body.unit}.",
        "/warehouses/chemical-inventory",
    )
    await log_audit("chemical_inventory_setting", setting_id, "minimum_stock_updated", user, after=setting)
    return setting


@api.post("/warehouses/chemical/inventory")
async def save_chemical_inventory(body: ChemicalInventoryIn, user=Depends(get_current_user)):
    require_chemical_access(user)
    item = await insert("chemical_inventory", {
        **body.model_dump(),
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
    })
    await insert("chemical_inventory_movements", {
        "inventory_id": item["id"],
        "chemical": item["chemical"],
        "quantity": body.capacity * body.count,
        "unit": item["unit"],
        "direction": 1,
        "movement_type": "stock_opening",
        "date": local_today().isoformat(),
        "created_at": now_iso(),
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
    })
    await log_audit("chemical_inventory", item["id"], "created", user, after=item)
    total = await chemical_container_inventory_total(item["chemical"], item["unit"])
    alert_key = f"chemical-inventory:{item['chemical'].strip().casefold()}:{item['unit'].strip().casefold()}"
    state = await db.inventory_alert_states.find_one(
        {"id": f"{user.get('_active_company_id') or DEFAULT_COMPANY_ID}:{alert_key}"}, {"_id": 0},
    )
    reference = max(total, float((state or {}).get("reference_quantity") or 0))
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    setting = await db.chemical_inventory_settings.find_one(
        {"id": chemical_inventory_setting_id(company_id, item["chemical"], item["unit"])},
        {"_id": 0},
    )
    threshold = (
        float(setting["minimum_quantity"])
        if setting
        else reference * LOW_STOCK_ALERT_RATIO
    )
    await update_low_stock_notification(
        user,
        alert_key,
        threshold > 0 and total <= threshold,
        f"Low chemical inventory: {item['chemical']}",
        f"Available: {total:g} {item['unit']}. Reorder level: {threshold:g} {item['unit']} "
        "(20% of the highest recorded quantity).",
        "/warehouses/chemical-inventory",
        reference_quantity=reference,
    )
    return item


async def chemical_container_inventory_total(chemical, unit):
    rows = await listall("chemical_inventory", limit=1000)
    return sum(
        max(
            0,
            float(row.get("capacity") or 0) * float(row.get("count") or 0)
            - float(row.get("quantity_used") or 0),
        )
        for row in rows
        if row.get("chemical", "").strip().casefold() == chemical.strip().casefold()
        and row.get("unit", "").strip().casefold() == unit.strip().casefold()
    )


@api.delete("/warehouses/chemical/inventory/{item_id}")
async def delete_chemical_inventory(item_id: str, user=Depends(get_current_user)):
    require_chemical_access(user)
    require_profile_owner(user)
    item = await db.chemical_inventory.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(404, "Inventory entry not found")
    if float(item.get("quantity_used") or 0) > 0:
        raise HTTPException(409, "This chemical entry has production usage history and cannot be deleted")
    await db.chemical_inventory.delete_one({"id": item_id})
    total = await chemical_container_inventory_total(item["chemical"], item["unit"])
    alert_key = f"chemical-inventory:{item['chemical'].strip().casefold()}:{item['unit'].strip().casefold()}"
    state = await db.inventory_alert_states.find_one(
        {"id": f"{user.get('_active_company_id') or DEFAULT_COMPANY_ID}:{alert_key}"}, {"_id": 0},
    )
    reference = max(total, float((state or {}).get("reference_quantity") or 0))
    threshold = reference * LOW_STOCK_ALERT_RATIO
    await update_low_stock_notification(
        user,
        alert_key,
        total <= threshold,
        f"Low chemical inventory: {item['chemical']}",
        f"Available: {total:g} {item['unit']}. Reorder level: {threshold:g} {item['unit']} "
        "(20% of the highest recorded quantity).",
        "/warehouses/chemical-inventory",
        reference_quantity=reference,
    )
    await log_audit("chemical_inventory", item_id, "permanently_deleted", user,
                    before=item, after={"deleted": True})
    return {"ok": True, "deleted": True}


class CompanyInventoryIn(BaseModel):
    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=60)
    size: str = Field(default="", max_length=40)
    packaging: str = Field(default="", max_length=40)
    packages: float = Field(default=0, ge=0, allow_inf_nan=False)
    units_per_package: float = Field(default=0, ge=0, allow_inf_nan=False)
    loose_units: float = Field(default=0, ge=0, allow_inf_nan=False)
    unit: str = Field(min_length=1, max_length=20)
    notes: str = Field(default="", max_length=500)

    @field_validator("name", "category", "size", "packaging", "unit", "notes")
    @classmethod
    def strip_company_inventory_text(cls, value):
        return value.strip()

    @model_validator(mode="after")
    def validate_company_inventory(self):
        if not self.name or not self.category or not self.unit:
            raise ValueError("Name, category and unit are required")
        return self


class CompanyInventoryDailyUpdateIn(BaseModel):
    quantity: float = Field(ge=0, allow_inf_nan=False)
    date: str = Field(default_factory=today_str, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("date")
    @classmethod
    def validate_daily_update_date(cls, value):
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("Enter a valid date") from error
        return value


def company_inventory_total(item):
    if item.get("daily_remaining_quantity") is not None:
        return round(float(item["daily_remaining_quantity"]), 4)
    return round(item.get("packages", 0) * item.get("units_per_package", 0) + item.get("loose_units", 0), 4)


def company_inventory_low_stock_threshold(item, reference_quantity=None):
    reference = reference_quantity
    if reference is None:
        reference = item.get("stock_reference_quantity", company_inventory_total(item))
    return max(0, float(reference or 0)) * LOW_STOCK_ALERT_RATIO


def require_company_inventory_access(user, read_only=False):
    if worker_restrictions_apply(user) and (
        not read_only or "stock" not in (user.get("worker_allowed_sections") or [])
    ):
        raise HTTPException(403, "This worker account cannot access Company Inventory")


@api.get("/company-inventory")
async def get_company_inventory(user=Depends(get_current_user)):
    require_company_inventory_access(user, read_only=True)
    items = await listall("company_inventory", sort=("category", 1), limit=2000)
    for item in items:
        item["total"] = company_inventory_total(item)
        item["low_stock_threshold"] = company_inventory_low_stock_threshold(item)
        item["low_stock"] = item["total"] <= item["low_stock_threshold"]
    return items


@api.post("/company-inventory")
async def add_company_inventory(body: CompanyInventoryIn, user=Depends(get_current_user)):
    require_company_inventory_access(user)
    inventory_data = body.model_dump()
    total = company_inventory_total(inventory_data)
    item = await insert("company_inventory", {
        **inventory_data,
        "stock_reference_quantity": total,
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
    })
    await log_audit("company_inventory", item["id"], "created", user, after=item)
    item["total"] = company_inventory_total(item)
    threshold = company_inventory_low_stock_threshold(item)
    await update_low_stock_notification(
        user,
        f"company-inventory:{item['id']}",
        item["total"] <= threshold,
        f"Low company inventory: {item['name']}",
        f"Remaining: {item['total']:g} {item['unit']}. Reorder level: {threshold:g} {item['unit']} "
        "(20% of the highest recorded quantity).",
        "/company-inventory",
    )
    return item


@api.post("/company-inventory/{item_id}/daily-update")
async def update_company_inventory_daily_quantity(
    item_id: str,
    body: CompanyInventoryDailyUpdateIn,
    user=Depends(get_current_user),
):
    require_company_inventory_access(user)
    before = await db.company_inventory.find_one({"id": item_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Inventory item not found")

    previous_reference = before.get(
        "stock_reference_quantity",
        company_inventory_total(before),
    )
    reference_quantity = max(float(previous_reference or 0), body.quantity)
    updated = await db.company_inventory.update_one(
        {"id": item_id},
        {"$set": {
            "daily_remaining_quantity": body.quantity,
            "daily_remaining_date": body.date,
            "stock_reference_quantity": reference_quantity,
            "updated_at": now_iso(),
        }},
    )
    if not updated.matched_count:
        raise HTTPException(404, "Inventory item not found")

    daily_update = {
        "company_inventory_id": item_id,
        "date": body.date,
        "quantity": body.quantity,
        "unit": before.get("unit", ""),
        "updated_by": user["id"],
        "updated_by_name": user.get("name") or user.get("username") or "",
        "updated_at": now_iso(),
    }
    await db.company_inventory_daily_updates.update_one(
        {"company_inventory_id": item_id, "date": body.date},
        {"$set": daily_update, "$setOnInsert": {"id": new_id()}},
        upsert=True,
    )
    item = await db.company_inventory.find_one({"id": item_id}, {"_id": 0})
    item["total"] = company_inventory_total(item)
    threshold = company_inventory_low_stock_threshold(item, reference_quantity)
    await update_low_stock_notification(
        user,
        f"company-inventory:{item_id}",
        item["total"] <= threshold,
        f"Low company inventory: {item['name']}",
        f"Remaining: {item['total']:g} {item['unit']}. Reorder level: {threshold:g} {item['unit']} "
        "(20% of the highest recorded quantity).",
        "/company-inventory",
    )
    await log_audit(
        "company_inventory", item_id, "daily_quantity_updated", user,
        before=before, after=item,
    )
    return item


@api.put("/company-inventory/{item_id}")
async def update_company_inventory(item_id: str, body: CompanyInventoryIn, user=Depends(get_current_user)):
    require_company_inventory_access(user)
    before = await db.company_inventory.find_one({"id": item_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Inventory item not found")
    inventory_data = body.model_dump()
    total = company_inventory_total(inventory_data)
    previous_reference = before.get(
        "stock_reference_quantity", company_inventory_total(before),
    )
    reference_quantity = max(float(previous_reference or 0), total)
    inventory_data["daily_remaining_quantity"] = None
    inventory_data["daily_remaining_date"] = None
    inventory_data["stock_reference_quantity"] = reference_quantity
    item = await update_doc("company_inventory", item_id, inventory_data)
    await log_audit("company_inventory", item_id, "edited", user, before=before, after=item)
    item["total"] = company_inventory_total(item)
    threshold = company_inventory_low_stock_threshold(item, reference_quantity)
    await update_low_stock_notification(
        user,
        f"company-inventory:{item['id']}",
        item["total"] <= threshold,
        f"Low company inventory: {item['name']}",
        f"Remaining: {item['total']:g} {item['unit']}. Reorder level: {threshold:g} {item['unit']} "
        "(20% of the highest recorded quantity).",
        "/company-inventory",
    )
    return item


@api.delete("/company-inventory/{item_id}")
async def delete_company_inventory(item_id: str, user=Depends(get_current_user)):
    require_company_inventory_access(user)
    require_profile_owner(user)
    item = await db.company_inventory.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(404, "Inventory item not found")
    await db.company_inventory.delete_one({"id": item_id})
    await update_low_stock_notification(
        user, f"company-inventory:{item_id}", False, "", "", "/company-inventory",
    )
    await log_audit("company_inventory", item_id, "permanently_deleted", user,
                    before=item, after={"deleted": True})
    return {"ok": True, "deleted": True}


@api.get("/warehouses/A/reports")
async def get_warehouse_a_reports(user=Depends(get_current_user)):
    require_warehouse_report_access(user, "A")
    return await listall(
        "warehouse_reports",
        {"warehouse_id": "A"},
        sort=("date", -1),
        limit=500,
    )


@api.post("/warehouses/A/reports")
async def save_warehouse_a_report(body: WarehouseReportIn, user=Depends(get_current_user)):
    require_warehouse_report_access(user, "A")
    report = await insert("warehouse_reports", {
        **body.model_dump(),
        "warehouse_id": "A",
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
    })
    await log_audit("warehouse_report", report["id"], "created", user, after=report)
    return report


@api.delete("/warehouses/A/reports/{report_id}")
async def delete_warehouse_a_report(report_id: str, user=Depends(get_current_user)):
    require_warehouse_report_access(user, "A")
    require_profile_owner(user)
    report = await db.warehouse_reports.find_one(
        {"id": report_id, "warehouse_id": "A"},
        {"_id": 0},
    )
    if not report:
        raise HTTPException(404, "Warehouse A report not found")
    result = await db.warehouse_reports.delete_one(
        {"id": report_id, "warehouse_id": "A"},
    )
    if not result.deleted_count:
        raise HTTPException(404, "Warehouse A report not found")
    await db.warehouse_report_share_links.delete_one({
        "warehouse_report_id": report_id, "warehouse_id": "A",
    })
    await log_audit(
        "warehouse_report", report_id, "permanently_deleted", user,
        before=report, after={"deleted": True},
    )
    return {"ok": True, "deleted": True}


@api.get("/warehouses/B/reports")
async def get_warehouse_b_reports(user=Depends(get_current_user)):
    require_warehouse_report_access(user, "B")
    return await listall(
        "warehouse_reports",
        {"warehouse_id": "B"},
        sort=("date", -1),
        limit=500,
    )


@api.post("/warehouses/B/reports")
async def save_warehouse_b_report(body: WarehouseBReportIn, user=Depends(get_current_user)):
    require_warehouse_report_access(user, "B")
    report = await insert("warehouse_reports", {
        **body.model_dump(),
        "warehouse_id": "B",
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
    })
    await log_audit("warehouse_report", report["id"], "created", user, after=report)
    return report


@api.delete("/warehouses/B/reports/{report_id}")
async def delete_warehouse_b_report(report_id: str, user=Depends(get_current_user)):
    require_warehouse_report_access(user, "B")
    require_profile_owner(user)
    report = await db.warehouse_reports.find_one(
        {"id": report_id, "warehouse_id": "B"},
        {"_id": 0},
    )
    if not report:
        raise HTTPException(404, "Warehouse B report not found")
    result = await db.warehouse_reports.delete_one(
        {"id": report_id, "warehouse_id": "B"},
    )
    if not result.deleted_count:
        raise HTTPException(404, "Warehouse B report not found")
    await db.warehouse_report_share_links.delete_one({
        "warehouse_report_id": report_id, "warehouse_id": "B",
    })
    await log_audit(
        "warehouse_report", report_id, "permanently_deleted", user,
        before=report, after={"deleted": True},
    )
    return {"ok": True, "deleted": True}


@api.get("/warehouses/C/reports")
async def get_warehouse_c_reports(user=Depends(get_current_user)):
    require_warehouse_report_access(user, "C")
    return await listall(
        "warehouse_reports",
        {"warehouse_id": "C"},
        sort=("date", -1),
        limit=500,
    )


@api.post("/warehouses/C/reports")
async def save_warehouse_c_report(body: WarehouseCReportIn, user=Depends(get_current_user)):
    require_warehouse_report_access(user, "C")
    data = body.model_dump()
    data["total_quantity_loaded"] = sum(
        dispatch["loaded_quantity"] for dispatch in data["dispatches"]
    )
    report = await insert("warehouse_reports", {
        **data,
        "warehouse_id": "C",
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
    })
    await log_audit("warehouse_report", report["id"], "created", user, after=report)
    return report


@api.delete("/warehouses/C/reports/{report_id}")
async def delete_warehouse_c_report(report_id: str, user=Depends(get_current_user)):
    require_warehouse_report_access(user, "C")
    require_profile_owner(user)
    report = await db.warehouse_reports.find_one(
        {"id": report_id, "warehouse_id": "C"},
        {"_id": 0},
    )
    if not report:
        raise HTTPException(404, "Warehouse C report not found")
    result = await db.warehouse_reports.delete_one(
        {"id": report_id, "warehouse_id": "C"},
    )
    if not result.deleted_count:
        raise HTTPException(404, "Warehouse C report not found")
    await db.warehouse_report_share_links.delete_one({
        "warehouse_report_id": report_id, "warehouse_id": "C",
    })
    await log_audit(
        "warehouse_report", report_id, "permanently_deleted", user,
        before=report, after={"deleted": True},
    )
    return {"ok": True, "deleted": True}


async def issue_warehouse_report_share_link(warehouse_id, report_id, user):
    report = await db.warehouse_reports.find_one(
        {"id": report_id, "warehouse_id": warehouse_id},
        {"_id": 0, "id": 1},
    )
    if not report:
        raise HTTPException(404, f"Warehouse {warehouse_id} report not found")
    link = await db.warehouse_report_share_links.find_one(
        {"warehouse_report_id": report_id, "warehouse_id": warehouse_id},
        {"_id": 0},
    )
    if not link:
        token = secrets.token_urlsafe(32)
        try:
            await insert("warehouse_report_share_links", {
                "warehouse_report_id": report_id,
                "warehouse_id": warehouse_id,
                "token_hash": worker_access_token_hash(token),
                "token_encrypted": encrypt_worker_access_token(token),
            })
            await log_audit(
                "warehouse_report", report_id, "share_link_created", user,
                after={"warehouse_id": warehouse_id},
            )
            return token
        except DuplicateKeyError:
            link = await db.warehouse_report_share_links.find_one(
                {"warehouse_report_id": report_id, "warehouse_id": warehouse_id},
                {"_id": 0},
            )
            if not link:
                raise

    try:
        token = decrypt_worker_access_token(link.get("token_encrypted", ""))
    except InvalidToken as error:
        raise HTTPException(500, "The warehouse report share link could not be recovered") from error
    if not secrets.compare_digest(link.get("token_hash", ""), worker_access_token_hash(token)):
        raise HTTPException(500, "The warehouse report share link is invalid; delete and recreate the report link")
    return token


@api.post("/warehouses/{warehouse_id}/reports/{report_id}/share-link")
async def create_warehouse_report_share_link(
    warehouse_id: str,
    report_id: str,
    response: Response,
    user=Depends(get_current_user),
):
    if warehouse_id not in WAREHOUSE_IDS:
        raise HTTPException(404, "Warehouse not found")
    require_warehouse_report_access(user, warehouse_id)
    response.headers["Cache-Control"] = "no-store"
    return {"token": await issue_warehouse_report_share_link(warehouse_id, report_id, user)}


@api.get("/public/warehouse-reports/{token}")
async def get_public_warehouse_report_share(token: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", token or ""):
        raise HTTPException(404, "Warehouse report link not found")

    token_hash = worker_access_token_hash(token)
    company_db = tenant_database(client, base_db, MANUFACTURING_COMPANY_ID)
    link = await company_db.warehouse_report_share_links.find_one(
        {"token_hash": token_hash},
        {"_id": 0},
    )
    if not link or link.get("warehouse_id") not in WAREHOUSE_IDS:
        raise HTTPException(404, "Warehouse report link not found")
    report = await company_db.warehouse_reports.find_one(
        {"id": link["warehouse_report_id"], "warehouse_id": link["warehouse_id"]},
        {"_id": 0},
    )
    if not report:
        raise HTTPException(404, "Warehouse report link not found")
    fields_by_warehouse = {
        "A": ("chemicals", "manufactured_blocks", "foam_cut", "damaged_blocks", "sheets_cut"),
        "B": ("foam_received", "mattresses_received", "mattresses_completed"),
        "C": ("completed_stock", "dispatches", "total_quantity_loaded"),
    }
    public_report = {
        key: report.get(key)
        for key in ("date", "warehouse_id", "notes", *fields_by_warehouse[link["warehouse_id"]])
        if key in report
    }
    return {"report": public_report}

# ---------------- Customers ----------------
class CustomerIn(BaseModel):
    name: str
    client_number: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    default_zone: int = 1
    other_balance: Optional[float] = Field(default=0, ge=0, le=1_000_000_000)
    other_balance_express: bool = False
    payment_terms: Optional[str] = "Due on Delivery"
    active: bool = True
    notes: Optional[str] = ""

    @field_validator("name")
    @classmethod
    def customer_name_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Customer name is required")
        return value

@api.get("/customers")
async def get_customers(
    page: Optional[int] = Query(None, ge=1),
    page_size: int = Query(50, ge=1, le=50),
    q: str = Query("", max_length=100),
    active_filter: Literal["all", "active", "inactive"] = "all",
    user=Depends(get_current_user),
):
    if page is not None:
        query = {}
        if active_filter == "active":
            query["active"] = True
        elif active_filter == "inactive":
            query["$or"] = [
                {"active": False},
                {"active": {"$exists": False}},
            ]
        term = q.strip()
        if term:
            pattern = {"$regex": re.escape(term), "$options": "i"}
            search_query = {"$or": [
                {field: pattern}
                for field in (
                    "name", "first_name", "last_name", "phone", "email",
                    "client_number", "city", "address",
                )
            ]}
            if "$or" in query:
                query = {"$and": [query, search_query]}
            else:
                query.update(search_query)
        return await find_page(
            db.customers,
            query,
            ("name", 1),
            page,
            page_size,
            {
                "_id": 0, "id": 1, "name": 1, "first_name": 1, "last_name": 1,
                "client_number": 1, "phone": 1, "email": 1, "address": 1, "city": 1,
                "default_zone": 1, "other_balance": 1, "other_balance_express": 1,
                "payment_terms": 1, "active": 1, "notes": 1, "created_at": 1,
            },
        )
    return await listall("customers", sort=("name", 1))


@api.get("/customers/{cid}")
async def get_customer(cid: str, user=Depends(get_current_user)):
    customer = await db.customers.find_one(
        {"id": cid},
        {"_id": 0, "id": 1, "name": 1, "client_number": 1, "phone": 1, "email": 1,
         "address": 1, "city": 1, "default_zone": 1, "payment_terms": 1},
    )
    if not customer:
        raise HTTPException(404, "Customer not found")
    return customer


@api.get("/customers/{cid}/last-invoice-zone")
async def get_customer_last_invoice_zone(
    cid: str,
    express: bool = False,
    user=Depends(get_current_user),
):
    if not await db.customers.find_one({"id": cid}, {"_id": 1}):
        raise HTTPException(404, "Customer not found")
    query = {
        "customer_id": cid,
        "invoice_type": "express" if express else {"$ne": "express"},
        "archived": {"$ne": True},
        "status": {"$ne": "void"},
        "opening_balance": {"$ne": True},
    }
    invoices = await db.invoices.find(
        query,
        {"_id": 0, "zone": 1},
    ).sort([("created_at", -1), ("date", -1)]).limit(1).to_list(1)
    zone = invoices[0].get("zone") if invoices else None
    return {"zone": zone if zone in (1, 2) else None}


@api.post("/customers")
async def add_customer(body: CustomerIn, user=Depends(get_current_user)):
    data = body.model_dump()
    if uses_unified_price_list(active_company_id.get()):
        data["default_zone"] = 1
    record = await insert("customers", data)
    await emit_workflow_event("customer.created", record)
    return record

@api.put("/customers/{cid}")
async def edit_customer(cid: str, body: CustomerIn, user=Depends(get_current_user)):
    data = body.model_dump()
    for field in ("other_balance", "other_balance_express"):
        if field not in body.model_fields_set:
            data.pop(field, None)
    if uses_unified_price_list(active_company_id.get()):
        data["default_zone"] = 1
    record = await update_doc("customers", cid, data)
    await emit_workflow_event("customer.updated", record)
    return record

class OtherBalancePayIn(BaseModel):
    amount: float = Field(gt=0, le=1_000_000_000)
    note: Optional[str] = ""
    method: str = "Cash"
    receiving_on: Optional[str] = ""
    date: str = Field(default_factory=today_str)
    reference: Optional[str] = ""
    express: bool = False

@api.post("/customers/{cid}/other-balance/pay")
async def pay_other_balance(cid: str, body: OtherBalancePayIn, user=Depends(get_current_user)):
    customer = await db.customers.find_one({"id": cid}, {"_id": 0})
    if not customer:
        raise HTTPException(404, "Customer not found")
    current = Decimal(str(customer.get("other_balance") or 0))
    amount = Decimal(str(body.amount))
    if amount > current:
        raise HTTPException(400, "Payment is greater than the other balance")
    remaining = float(current - amount)
    history = list(customer.get("other_balance_payments") or [])
    history.append({
        "amount": float(amount), "note": body.note or "", "date": now_iso(),
        "by": user.get("id"), "balance_after": remaining,
    })
    pay_rec = await insert("payments", {
        "amount": float(amount), "method": body.method, "receiving_on": body.receiving_on or "",
        "date": body.date, "reference": body.reference or "", "notes": body.note or "",
        "invoice_id": None, "invoice_number": "Other balance", "other_balance_payment": True,
        "express": body.express, "customer_id": cid, "customer_name": customer.get("name"),
        "reversed": False, "user": user["email"],
    })
    history[-1]["payment_id"] = pay_rec["id"]
    record = await update_doc("customers", cid, {
        "other_balance": remaining, "other_balance_payments": history,
    })
    await log_audit("customer", cid, "other_balance_paid", user, before=customer, after=record)
    return record

@api.delete("/customers/{cid}")
async def delete_customer(cid: str, user=Depends(get_current_user)):
    customer = await db.customers.find_one({"id": cid}, {"_id": 0})
    if not customer:
        raise HTTPException(404, "Customer not found")
    if is_company_admin(user):
        await db.invoices.update_many(
            {"customer_id": cid},
            {"$set": {"customer_deleted": True, "deleted_customer_name": customer.get("name", "")}},
        )
        await db.payments.update_many(
            {"customer_id": cid},
            {"$set": {"customer_deleted": True, "deleted_customer_name": customer.get("name", "")}},
        )
        await db.deleted_customers.delete_many({"id": cid})
        await db.customers.delete_one({"id": cid})
        await db.audit_log.update_many(
            {"entity": "customer", "entity_id": cid},
            {"$set": {"before": None, "after": None}},
        )
        await log_audit("customer", cid, "permanently_deleted", user,
                        before={"id": cid}, after={"permanently_deleted": True})
        return {"ok": True, "deleted": True}
    updated = await update_doc("customers", cid, {
        "active": False, "archived_at": now_iso(), "archived_by": user.get("id"),
    })
    await log_audit("customer", cid, "archived", user, before=customer, after=updated)
    return {"ok": True, "archived": True}

@api.get("/customers/{cid}/summary")
async def customer_summary(
    cid: str,
    express_only: bool = False,
    invoice_type: Optional[Literal["standard", "express"]] = None,
    user=Depends(get_current_user),
):
    invoice_query = {"customer_id": cid, "archived": {"$ne": True}}
    if express_only:
        invoice_query["invoice_type"] = "express"
    elif invoice_type == "express":
        invoice_query["invoice_type"] = "express"
    elif invoice_type == "standard":
        invoice_query["invoice_type"] = {"$ne": "express"}
    invs, payment_records, orders, dels = await asyncio.gather(
        listall("invoices", invoice_query, ("created_at", -1)),
        listall("payments", {"customer_id": cid}, ("created_at", -1)),
        listall("orders", {"customer_id": cid, "archived": {"$ne": True}}, ("created_at", -1)),
        listall("deliveries", {"customer_id": cid, "archived": {"$ne": True}}, ("created_at", -1)),
    )
    if express_only or invoice_type:
        history_invoice_query = {"customer_id": cid}
        if express_only or invoice_type == "express":
            history_invoice_query["invoice_type"] = "express"
        elif invoice_type == "standard":
            history_invoice_query["invoice_type"] = {"$ne": "express"}
        history_invoices = await listall("invoices", history_invoice_query, limit=10000)
        invoice_ids = [invoice["id"] for invoice in history_invoices]
        payment_records = await listall(
            "payments",
            {"customer_id": cid, "invoice_id": {"$in": invoice_ids}},
            ("created_at", -1),
        ) if invoice_ids else []
    for i in invs:
        i["status"] = derive_status(i)
        invoice_for_user(i, user)
    valid = [i for i in invs if i["status"] not in ("void", "draft")]
    other_balance_history = [
        p for p in await listall(
            "payments", {"customer_id": cid, "other_balance_payment": True},
            ("created_at", -1),
        )
        if bool(p.get("express")) == express_only
    ]
    customer_payments = [p for p in payment_records if not p.get("other_balance_payment")]
    pays = [p for p in customer_payments if not p.get("reversed") and not p.get("archived")]
    other_balance_record = await db.customers.find_one({"id": cid}, {"_id": 0, "other_balance": 1})
    other_balance = (other_balance_record or {}).get("other_balance") or 0
    invoices_outstanding = dsum(i.get("outstanding", 0) for i in valid)
    return {"invoices": invs, "payments": customer_payments,
            "other_balance_payments": other_balance_history,
            "invoices_outstanding": invoices_outstanding,
            "other_balance": other_balance or 0,
            "outstanding": invoices_outstanding,
            "overdue": dsum(i.get("outstanding", 0) for i in valid if i["status"] == "overdue"),
            "total_invoiced": dsum(i.get("total", 0) for i in valid if not i.get("opening_balance")),
            "opening_balance": dsum(i.get("outstanding", 0) for i in valid if i.get("opening_balance")),
            "payments_received": dsum(p.get("amount", 0) for p in pays),
            "open_orders": [o for o in orders if o.get("status") in OPEN_ORDER_STATUSES],
            "upcoming_deliveries": [d for d in dels if d.get("status") in ("Planned", "Assigned", "Ready")]}

# ---------------- Prices ----------------
class PriceIn(BaseModel):
    zone: int
    category: str
    size: str
    price: Optional[float] = None
    active: bool = True
    confirmed: bool = True

    @field_validator("price")
    @classmethod
    def price_not_negative(cls, value):
        if value is not None and value < 0:
            raise ValueError("Price cannot be negative")
        return value

    @field_validator("category", "size")
    @classmethod
    def price_label_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Category and size are required")
        return value

@api.get("/prices")
async def get_prices(user=Depends(get_current_user)):
    return await listall("prices", sort=("zone", 1))

@api.post("/prices")
async def add_price(body: PriceIn, user=Depends(get_current_user)):
    require_price_list_owner(user)
    d = {**body.model_dump(), "archived": False, "archived_at": None, "archived_by": None}
    if d["category"] == "Simple/Mix color":
        d["category"] = "Simple" if uses_unified_price_list(active_company_id.get()) else "Standard"
    if uses_unified_price_list(active_company_id.get()):
        d["zone"] = 1
    if await db.prices.find_one({"zone": d["zone"], "category": d["category"], "size": d["size"]}):
        raise HTTPException(400, "A price for this zone, category and size already exists")
    d["confirmed"] = d.get("price") is not None and d.get("confirmed", True)
    d["updated_at"] = now_iso()
    rec = await insert("prices", d)
    await log_audit("price", rec["id"], "created", user, after=rec)
    return rec

@api.put("/prices/{pid}")
async def edit_price(pid: str, body: PriceIn, user=Depends(get_current_user)):
    require_price_list_owner(user)
    before = await db.prices.find_one({"id": pid}, {"_id": 0})
    d = body.model_dump()
    if d["category"] == "Simple/Mix color":
        d["category"] = "Simple" if uses_unified_price_list(active_company_id.get()) else "Standard"
    if uses_unified_price_list(active_company_id.get()):
        d["zone"] = 1
    clash = await db.prices.find_one({"zone": d["zone"], "category": d["category"], "size": d["size"], "id": {"$ne": pid}})
    if clash:
        raise HTTPException(400, "A price for this zone, category and size already exists")
    d["confirmed"] = d.get("price") is not None and d.get("confirmed", True)
    rec = await update_doc("prices", pid, d)
    await log_audit("price", pid, "updated", user, before=before, after=rec)
    return rec

@api.delete("/prices/{pid}")
async def delete_price(pid: str, user=Depends(get_current_user)):
    require_price_list_owner(user)
    before = await db.prices.find_one({"id": pid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Product price not found")
    await db.audit_log.delete_many({"entity": "price", "entity_id": pid})
    result = await db.prices.delete_one({"id": pid})
    if not result.deleted_count:
        raise HTTPException(404, "Product price not found")
    await log_audit("price", pid, "permanently_deleted", user,
                    before=before, after={"permanently_deleted": True})
    return {"ok": True, "deleted": True}

RIBBON_FAMILY = {"Ribbon", "Ribbon Black & Pink", "Ribbon Black", "Ribbon Pink", "Candy"}
MANUAL_ONLY_SIZES = {"1370x150"}

def price_category(zone, category):
    normalized_category = str(category or "").strip()
    category_key = normalized_category.casefold()
    if category_key in {
        "black",
        "black fabric",
        "fabric black",
        "ribbon balck",
        "ribbon black",
        "ribbon black fabric",
    }:
        return "Ribbon Black"
    if category_key in {"simple", "standard", "simple/mix color"}:
        return "Simple" if uses_unified_price_list(active_company_id.get()) else "Standard"
    if category_key == "candy":
        return "Ribbon Black"
    known_categories = {
        "ribbon": "Ribbon Pink",
        "ribbon black & pink": "Ribbon Black & Pink",
        "ribbon pink": "Ribbon Pink",
        "strong boy": "Strong Boy",
        "uncovered": "Uncovered",
        "uncovered blue 16 density": "Uncovered Blue 16 Density",
    }
    if category_key in known_categories:
        return known_categories[category_key]
    return normalized_category

def canonical_price_size(size):
    normalized_size = str(size or "").strip()
    if re.fullmatch(
        r"\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?){1,2}",
        normalized_size,
        re.IGNORECASE,
    ):
        return re.sub(r"\s+", "", normalized_size.replace("×", "x").lower())
    return normalized_size

def is_manual_only(category, size):
    normalized_category = price_category(1, category)
    return (
        not uses_unified_price_list(active_company_id.get())
        and normalized_category in RIBBON_FAMILY
        and canonical_price_size(size) in MANUAL_ONLY_SIZES
    )

def price_category_aliases(category):
    canonical_category = price_category(1, category)
    if canonical_category == "Ribbon Black":
        return ("Ribbon Black", "Black", "Black fabric", "Fabric Black", "Ribbon Balck", "Ribbon Black Fabric")
    if canonical_category == "Ribbon Pink":
        return ("Ribbon Pink", "Ribbon")
    return (canonical_category,)

def price_size_queries(size):
    normalized_size = str(size or "").strip()
    if not re.fullmatch(
        r"\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?){1,2}",
        normalized_size,
        re.IGNORECASE,
    ):
        return ({"size": normalized_size},)

    canonical_size = canonical_price_size(normalized_size)
    dimensions = re.split(r"\s*[x×]\s*", normalized_size, flags=re.IGNORECASE)
    pattern = r"^\s*" + r"\s*[x×]\s*".join(re.escape(part) for part in dimensions) + r"\s*$"
    queries = [{"size": canonical_size}]
    queries.append({"size": {"$regex": pattern, "$options": "i"}})
    return tuple(queries)

def price_category_queries(category):
    return (
        {"category": category},
        {"category": {"$regex": f"^{re.escape(category)}$", "$options": "i"}},
    )

async def resolve_price(zone, category, size):
    if uses_unified_price_list(active_company_id.get()):
        zone = 1
    if is_manual_only(category, size):
        return {"found": True, "price": None, "needs_config": True, "reason": "Ribbon 1370x150 always requires manual price entry and administrator confirmation"}
    p = None
    for candidate in price_category_aliases(category):
        for category_query in price_category_queries(candidate):
            for size_query in price_size_queries(size):
                p = await db.prices.find_one(
                    {"zone": int(zone), **category_query, **size_query},
                    {"_id": 0},
                )
                if p:
                    break
            if p:
                break
        if p:
            break
    if not p or not p.get("active"):
        return {"found": False, "price": None, "needs_config": True, "reason": "No matching price configured"}
    if p.get("price") is None or not p.get("confirmed"):
        return {"found": True, "price": None, "needs_config": True, "reason": "Requires administrator confirmation"}
    return {"found": True, "price": p["price"]}

@api.get("/prices/lookup")
async def price_lookup(zone: int, category: str, size: str, user=Depends(get_current_user)):
    return await resolve_price(zone, category, size)

# ---------------- Invoice calc ----------------
def compute_invoice(inv):
    q = lambda x: x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    subtotal = Decimal("0")
    for it in inv.get("items", []):
        lt = q(D(it.get("qty")) * D(it.get("unit_price")))
        it["line_total"] = float(lt)
        subtotal += lt
    taxed = max(
        subtotal - D(inv.get("discount"))
        + D(inv.get("extra_charges"))
        + D(inv.get("delivery_fee")),
        Decimal("0"),
    )
    tax_amount = q(taxed * D(inv.get("tax_rate")) / 100) if inv.get("tax_enabled") else Decimal("0")
    total = q(taxed + tax_amount)
    paid = q(D(inv.get("amount_paid")))
    inv["subtotal"] = float(q(subtotal))
    inv["tax_amount"] = float(tax_amount)
    inv["total"] = float(total)
    inv["amount_paid"] = float(paid)
    inv["outstanding"] = float(total - paid)
    return inv

async def validate_for_issue(inv):
    items = inv.get("items", [])
    if not items:
        raise HTTPException(400, "Cannot issue an invoice without items")
    for n, it in enumerate(items, 1):
        label = f"Line {n} ({it.get('category', '')} {it.get('size') or it.get('description', '')})".strip()
        if (it.get("qty") or 0) <= 0:
            raise HTTPException(400, f"{label}: quantity must be greater than 0")
        if it.get("size") and not it.get("price_override"):
            r = await resolve_price(inv.get("zone", 1), it.get("category", ""), it["size"])
            if r.get("price") is None:
                raise HTTPException(400, f"{label}: {r['reason']}. Enter a manual price to continue")
            if (it.get("unit_price") or 0) <= 0:
                it["unit_price"] = r["price"]
            elif r2(r["price"]) != r2(it.get("unit_price")):
                it["price_override"] = True
        if (it.get("unit_price") or 0) <= 0:
            raise HTTPException(400, f"{label}: price missing. Requires administrator confirmation or manual price")

def derive_status(inv):
    if inv.get("status") == "void":
        return "void"
    if inv.get("status") == "draft":
        return "draft"
    total = inv.get("total", 0)
    paid = inv.get("amount_paid", 0)
    if total > 0 and paid >= total:
        return "paid"
    due = inv.get("due_date")
    if inv.get("outstanding", 0) > 0 and due and due < today_str():
        return "overdue"
    if paid > 0:
        return "partially_paid"
    return "issued"

class InvoiceItem(BaseModel):
    qty: float = 1
    category: str = ""
    size: str = ""
    description: str = ""
    unit_price: Optional[float] = 0
    price_override: bool = False
    tax: bool = False
    order_id: Optional[str] = ""

    @field_validator("qty", "unit_price")
    @classmethod
    def finite_item_number(cls, value):
        if value is not None and not math.isfinite(value):
            raise ValueError("Enter a valid number")
        return value

class PreviousInvoiceBalanceIn(BaseModel):
    id: str
    date: str = ""
    number: Optional[str] = ""
    outstanding: float

class InvoiceIn(BaseModel):
    customer_id: Optional[str] = ""
    customer_name: str = ""
    date: str = Field(default_factory=today_str)
    due_date: Optional[str] = None
    zone: int = 1
    payment_terms: str = "Due on Delivery"
    reference: Optional[str] = ""
    destination: Optional[str] = ""
    order_ids: List[str] = []
    notes: Optional[str] = ""
    items: List[InvoiceItem] = []
    discount: float = 0
    extra_charges: float = 0
    delivery_fee: float = 0
    made_by: str = ""
    client_number: Optional[str] = ""
    assigned_driver_id: Optional[str] = ""
    assigned_driver_name: Optional[str] = ""
    idempotency_key: str = Field(default="", max_length=100)
    intercompany_request_id: Optional[str] = ""
    tax_enabled: bool = False
    tax_rate: float = 0
    # New invoices are issued by default; only an explicit user draft action may create a draft.
    status: str = "issued"
    invoice_type: Literal["standard", "express"] = "standard"
    previous_invoices_pending: List[PreviousInvoiceBalanceIn] = Field(default_factory=list)
    include_previous_balance: bool = True
    edit_reason: Optional[str] = ""
    opening_balance: Optional[bool] = None
    deduct_stock: bool = False
    allow_negative_stock: bool = False
    supervisor_authorization: Optional[str] = None
    cod_amount_due: Optional[float] = Field(default=None, ge=0, le=1_000_000_000)
    cod_amount_collected: Optional[float] = Field(default=None, ge=0, le=1_000_000_000)

    @field_validator("cod_amount_due", "cod_amount_collected")
    @classmethod
    def finite_cod_amount(cls, value):
        if value is not None and not math.isfinite(value):
            raise ValueError("Enter a valid cash amount")
        return value

    @field_validator("discount", "extra_charges", "delivery_fee", "tax_rate")
    @classmethod
    def finite_invoice_number(cls, value):
        if not math.isfinite(value):
            raise ValueError("Enter a valid number")
        return value

def invoice_status_for_update(body: InvoiceIn, current_status: Optional[str]) -> str:
    """Keep an existing invoice's status unless the caller explicitly changes it."""
    if "status" not in body.model_fields_set:
        return current_status or "issued"
    return body.status or current_status or "issued"


class InvoiceEditAuthorizationIn(BaseModel):
    password: str

class InvoiceActionAuthorizationIn(BaseModel):
    password: str
    action: str
    target_id: Optional[str] = None

class BuyingEditAuthorizationIn(BaseModel):
    password: str

class InvoiceIssueIn(BaseModel):
    deduct_stock: bool = False
    allow_negative_stock: bool = False

INV_DIFF_FIELDS = (
    "customer_name", "date", "due_date", "zone", "payment_terms", "reference",
    "destination", "notes", "discount", "extra_charges", "delivery_fee",
    "made_by", "client_number", "assigned_driver_name", "tax_enabled", "total",
    "include_previous_balance",
)

def invoice_submission_hash(body):
    payload = body.model_dump(exclude={
        "idempotency_key", "supervisor_authorization", "edit_reason",
    })
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()

def _line_str(it):
    label = " ".join(x for x in (it.get("category"), it.get("size")) if x) or it.get("description") or "item"
    return f"{r2(it.get('qty'))}x {label} @ {r2(it.get('unit_price')):.2f}"

def invoice_changes(old, new):
    ch = [{"field": f, "old": old.get(f), "new": new.get(f)} for f in INV_DIFF_FIELDS if (old.get(f) or "") != (new.get(f) or "")]
    ol, nl = [_line_str(i) for i in old.get("items", [])], [_line_str(i) for i in new.get("items", [])]
    if ol != nl:
        ch.append({"field": "items", "old": "; ".join(ol), "new": "; ".join(nl)})
    return ch


INVOICE_AUDIT_FIELDS = (
    "customer_id", "customer_name", "date", "due_date", "zone", "payment_terms",
    "reference", "destination", "order_ids", "notes", "items", "discount",
    "extra_charges", "delivery_fee", "made_by", "client_number",
    "assigned_driver_id", "assigned_driver_name", "tax_enabled", "tax_rate",
    "status", "total", "cod_amount_due", "cod_amount_collected", "opening_balance",
    "include_previous_balance",
)


def invoice_numbering_year(invoice_date=None):
    year_match = re.match(r"^(\d{4})", str(invoice_date or ""))
    return int(year_match.group(1)) if year_match else local_now().year

async def invoice_sequence_start(year, invoice_type="standard"):
    invoice_type_filter = "express" if invoice_type == "express" else {"$ne": "express"}
    invoices = await db.invoices.find(
        {"numbering_year": year, "invoice_type": invoice_type_filter},
        {"_id": 0, "number": 1},
    ).to_list(None)
    legacy_numbers = [
        int(match.group(1))
        for invoice in invoices
        if (match := re.search(r"(\d+)$", str(invoice.get("number") or "")))
    ]
    return max(legacy_numbers, default=0)

async def current_invoice_sequence(year=None, invoice_type="standard"):
    year = year or local_now().year
    counter_id = f"express-invoice-sequence-{year}" if invoice_type == "express" else f"invoice-sequence-{year}"
    counter = await db.counters.find_one({"_id": counter_id})
    if counter:
        return int(counter["seq"])
    return await invoice_sequence_start(year, invoice_type)

async def next_invoice_number(invoice_date=None, invoice_type="standard"):
    year = invoice_numbering_year(invoice_date)
    counter_id = f"express-invoice-sequence-{year}" if invoice_type == "express" else f"invoice-sequence-{year}"
    counter = await db.counters.find_one({"_id": counter_id})
    if not counter:
        initial_seq = await invoice_sequence_start(year, invoice_type)
        try:
            await db.counters.insert_one({"_id": counter_id, "seq": initial_seq + 1})
            number = f"{initial_seq + 1:02d}"
            return f"EW-{number}" if invoice_type == "express" else number
        except DuplicateKeyError:
            pass
    counter = await db.counters.find_one_and_update(
        {"_id": counter_id}, {"$inc": {"seq": 1}},
        return_document=ReturnDocument.AFTER)
    number = f"{counter['seq']:02d}"
    return f"EW-{number}" if invoice_type == "express" else number

@api.get("/invoices/next-number")
async def get_next_number(year: Optional[int] = None, express: bool = False, user=Depends(get_current_user)):
    sequence = await current_invoice_sequence(year, "express" if express else "standard")
    number = f"{sequence + 1:02d}"
    return {"number": f"EW-{number}" if express else number}

def invoice_list_query(express=False, include_archived=False):
    query = {} if include_archived else {"archived": {"$ne": True}}
    query["invoice_type"] = "express" if express else {"$ne": "express"}
    return query


def invoice_status_list_query(status):
    if status in ("draft", "void"):
        return {"status": status}
    if status not in ("issued", "partially_paid", "paid", "overdue"):
        return {}

    active_invoice = {"status": {"$nin": ["draft", "void"]}}
    amount_paid = {"$ifNull": ["$amount_paid", 0]}
    total = {"$ifNull": ["$total", 0]}
    paid = {"$expr": {"$and": [{"$gt": [total, 0]}, {"$gte": [amount_paid, total]}]}}
    overdue = {
        "$and": [
            {"outstanding": {"$gt": 0}},
            {"due_date": {"$lt": today_str()}},
        ],
    }

    if status == "paid":
        condition = paid
    elif status == "overdue":
        condition = {"$and": [overdue, {"$nor": [paid]}]}
    elif status == "partially_paid":
        condition = {
            "$and": [
                {"$expr": {"$gt": [amount_paid, 0]}},
                {"$nor": [paid, overdue]},
            ],
        }
    else:
        condition = {
            "$and": [
                {"$expr": {"$lte": [amount_paid, 0]}},
                {"$nor": [paid, overdue]},
            ],
        }
    return {"$and": [active_invoice, condition]}


def previous_invoice_query(customer_id, invoice_date, exclude_id=None):
    query = {
        "customer_id": customer_id,
        "date": {"$lt": invoice_date},
        "archived": {"$ne": True},
        "status": {"$nin": ["draft", "void"]},
    }
    if exclude_id:
        query["id"] = {"$ne": exclude_id}
    return query

async def previous_invoice_balances(customer_id, invoice_date, exclude_id=None):
    if not customer_id or not invoice_date:
        return []
    records = await db.invoices.find(
        previous_invoice_query(customer_id, invoice_date, exclude_id),
        {"_id": 0},
    ).to_list(None)
    pending = []
    for invoice in records:
        compute_invoice(invoice)
        if derive_status(invoice) in ("draft", "void") or r2(invoice.get("outstanding", 0)) <= 0:
            continue
        pending.append({
            "id": invoice["id"],
            "date": invoice.get("date", ""),
            "number": invoice.get("number", ""),
            "outstanding": r2(invoice.get("outstanding", 0)),
        })
    return sorted(pending, key=lambda invoice: (invoice["date"], invoice.get("number") or ""))

async def customer_balance_before_invoice(customer_id, exclude_id=None):
    if not customer_id:
        return 0
    query = {
        "customer_id": customer_id,
        "archived": {"$ne": True},
        "status": {"$nin": ["draft", "void"]},
    }
    if exclude_id:
        query["id"] = {"$ne": exclude_id}
    invoices = await db.invoices.find(query, {"_id": 0}).to_list(None)
    outstanding = Decimal("0")
    for invoice in invoices:
        compute_invoice(invoice)
        if derive_status(invoice) not in ("draft", "void"):
            outstanding += max(D(invoice.get("outstanding", 0)), Decimal("0"))
    customer = await db.customers.find_one({"id": customer_id}, {"_id": 0, "other_balance": 1})
    outstanding += D((customer or {}).get("other_balance", 0))
    return r2(outstanding)

@api.get("/invoices")
async def get_invoices(
    include_archived: bool = False,
    express: bool = False,
    page: Optional[int] = Query(None, ge=1),
    page_size: int = Query(50, ge=1, le=50),
    q: str = Query("", max_length=100),
    status: Literal["all", "draft", "issued", "partially_paid", "paid", "overdue", "void"] = "all",
    zone: Optional[int] = None,
    invoice_date: Optional[str] = None,
    user=Depends(get_current_user),
):
    if include_archived:
        require_profile_owner(user)
    query = invoice_list_query(express, include_archived)
    if page is not None:
        clauses = [{"archived": True} if include_archived else query]
        if status != "all":
            clauses.append(invoice_status_list_query(status))
        if zone is not None:
            clauses.append({"zone": zone})
        if invoice_date:
            clauses.append({"date": invoice_date})
        term = q.strip()
        if term:
            pattern = {"$regex": re.escape(term), "$options": "i"}
            clauses.append({"$or": [
                {"number": pattern},
                {"customer_name": pattern},
                {"deleted_customer_name": pattern},
            ]})
        query = {"$and": clauses}
        page_result = await find_page(
            db.invoices,
            query,
            ("created_at", -1),
            page,
            page_size,
            {
                "_id": 0, "id": 1, "number": 1, "customer_id": 1,
                "customer_name": 1, "customer_deleted": 1, "deleted_customer_name": 1,
                "date": 1, "due_date": 1, "zone": 1, "total": 1,
                "amount_paid": 1, "outstanding": 1, "status": 1, "archived": 1,
                "opening_balance": 1, "include_on_daily_report": 1, "created_at": 1,
            },
        )
        invs = page_result["items"]
    else:
        invs = await listall("invoices", query, ("created_at", -1))
    invoice_ids = [invoice["id"] for invoice in invs]
    shared_links = await db.invoice_share_links.find(
        {"invoice_id": {"$in": invoice_ids}}, {"_id": 0, "invoice_id": 1},
    ).to_list(len(invoice_ids)) if invoice_ids else []
    shared_invoice_ids = {link["invoice_id"] for link in shared_links}
    payment_invoice_ids = set()
    if include_archived and invoice_ids:
        payment_records = await db.payments.find(
            {"invoice_id": {"$in": invoice_ids}}, {"_id": 0, "invoice_id": 1},
        ).to_list(None)
        payment_invoice_ids = {payment.get("invoice_id") for payment in payment_records}
    for i in invs:
        i["status"] = derive_status(i)
        i["has_share_link"] = i["id"] in shared_invoice_ids
        if include_archived:
            i["has_payment_history"] = i["id"] in payment_invoice_ids
        invoice_for_user(i, user)
    if page is not None:
        page_result["items"] = invs
        return page_result
    return invs

@api.get("/invoices/{iid}")
async def get_invoice(iid: str, user=Depends(get_current_user)):
    inv = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.get("archived") and (
        user.get("role") != "owner" and user.get("_active_role") != "owner"
    ):
        raise HTTPException(404, "Invoice not found")
    inv["status"] = derive_status(inv)
    inv["payment_records"] = await listall("payments", {"invoice_id": iid}, ("created_at", -1))
    inv["has_share_link"] = bool(await db.invoice_share_links.find_one({"invoice_id": iid}, {"_id": 1}))
    return invoice_for_user(inv, user)

async def issue_invoice_share_link(iid, user):
    invoice = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not invoice:
        raise HTTPException(404, "Invoice not found")
    if invoice.get("archived") or derive_status(invoice) in ("draft", "void"):
        raise HTTPException(400, "Only active, issued invoices can be shared")

    link = await db.invoice_share_links.find_one({"invoice_id": iid}, {"_id": 0})
    if not link:
        token = secrets.token_urlsafe(32)
        try:
            link = await insert("invoice_share_links", {
                "invoice_id": iid,
                "token_hash": worker_access_token_hash(token),
                "token_encrypted": encrypt_worker_access_token(token),
            })
            await log_audit("invoice", iid, "share_link_created", user)
            return token
        except DuplicateKeyError:
            link = await db.invoice_share_links.find_one({"invoice_id": iid}, {"_id": 0})
            if not link:
                raise

    try:
        token = decrypt_worker_access_token(link.get("token_encrypted", ""))
    except InvalidToken as error:
        raise HTTPException(500, "The invoice share link could not be recovered") from error
    if not secrets.compare_digest(link.get("token_hash", ""), worker_access_token_hash(token)):
        raise HTTPException(500, "The invoice share link is invalid; revoke it before sharing again")
    return token

@api.post("/invoices/{iid}/share-link")
async def create_invoice_share_link(iid: str, response: Response, user=Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return {"token": await issue_invoice_share_link(iid, user)}

@api.delete("/invoices/{iid}/share-link")
async def revoke_invoice_share_link(iid: str, user=Depends(get_current_user)):
    if not await db.invoices.find_one({"id": iid}, {"_id": 1}):
        raise HTTPException(404, "Invoice not found")
    result = await db.invoice_share_links.delete_one({"invoice_id": iid})
    if result.deleted_count:
        await log_audit("invoice", iid, "share_link_revoked", user)
    return {"revoked": bool(result.deleted_count)}

@api.get("/public/invoices/{token}")
async def get_public_invoice_share(token: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", token or ""):
        raise HTTPException(404, "Invoice link not found")

    token_hash = worker_access_token_hash(token)
    for profile in COMPANY_PROFILES:
        company_db = tenant_database(client, base_db, profile["id"])
        link = await company_db.invoice_share_links.find_one({"token_hash": token_hash}, {"_id": 0})
        if not link:
            continue
        invoice = await company_db.invoices.find_one({"id": link["invoice_id"]}, {"_id": 0})
        if not invoice or invoice.get("archived") or derive_status(invoice) in ("draft", "void"):
            raise HTTPException(404, "Invoice link not found")
        compute_invoice(invoice)
        customer = await company_db.customers.find_one(
            {"id": invoice.get("customer_id")}, {"_id": 0},
        ) if invoice.get("customer_id") else {}
        settings = await company_db.settings.find_one({"id": "singleton"}, {"_id": 0}) or {}
        invoice_fields = (
            "number", "customer_name", "client_number", "assigned_driver_name", "date", "due_date",
            "zone", "payment_terms", "reference", "destination", "items", "discount", "extra_charges",
            "delivery_fee", "tax_enabled", "tax_rate", "amount_paid", "subtotal", "tax_amount", "total",
            "outstanding", "notes", "opening_balance",
        )
        customer_fields = ("address", "city", "phone", "email")
        settings_fields = (
            "company_name", "address", "telephone", "email", "tax_number", "banking_details",
        )
        shared_invoice = {key: invoice.get(key) for key in invoice_fields}
        shared_invoice["items"] = [
            {key: item.get(key) for key in ("category", "size", "qty", "unit_price", "description")}
            for item in invoice.get("items", [])
        ]
        return {
            "invoice": shared_invoice,
            "customer": {key: customer.get(key) for key in customer_fields},
            "settings": {
                **{key: settings.get(key) for key in settings_fields},
                "unified_price_list": uses_unified_price_list(profile["id"]),
            },
        }
    raise HTTPException(404, "Invoice link not found")

class DailyReportInclusionIn(BaseModel):
    included: bool

@api.post("/invoices/{iid}/daily-report")
async def set_invoice_daily_report_inclusion(iid: str, body: DailyReportInclusionIn, user=Depends(get_current_user)):
    invoice = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not invoice:
        raise HTTPException(404, "Invoice not found")
    if invoice.get("invoice_type") != "express":
        raise HTTPException(400, "Only Express Website invoices can be included separately in the daily report")
    updated = await update_doc("invoices", iid, {"include_on_daily_report": body.included})
    await log_audit(
        "invoice", iid, "daily_report_inclusion_updated", user,
        before={"include_on_daily_report": invoice.get("include_on_daily_report", False)},
        after={"include_on_daily_report": body.included},
    )
    return updated

async def authenticate_supervisor(password, user, allow_skip=True):
    if allow_skip and can_skip_supervisor_approval(user):
        return user["id"], "IQFOAM Wholesalers admin in IQFOAM Manufacturing"
    company_id = user["_active_company_id"]
    company_settings = await db.settings.find_one({"id": "singleton"}, {"_id": 0})
    supervisor_hash = (company_settings or {}).get("supervisor_password_hash")
    if supervisor_hash:
        if not verify_pw(password, supervisor_hash):
            raise HTTPException(403, "Supervisor password is incorrect")
        return (
            (company_settings or {}).get("supervisor_password_updated_by", "supervisor"),
            "configured supervisor",
        )

    company_admin_field = f"company_roles.{company_id}"
    supervisors = await base_db.users.find({
        "active": {"$ne": False},
        "disabled": {"$ne": True},
        "$or": [{"role": "owner"}, {company_admin_field: {"$in": ["admin", "owner"]}}],
    }, {"_id": 0, "id": 1, "email": 1, "password_hash": 1}).to_list(1000)
    supervisor = next(
        (account for account in supervisors
         if verify_pw(password, account.get("password_hash", ""))),
        None,
    )
    if not supervisor:
        raise HTTPException(403, "Supervisor password is incorrect")
    return supervisor["id"], supervisor.get("email") or supervisor["id"]

async def create_invoice_action_authorization(iid, action, password, user, target_id=None):
    inv = await db.invoices.find_one({"id": iid}, {"_id": 0, "id": 1, "status": 1, "archived": 1})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.get("archived") or inv.get("status") == "void":
        raise HTTPException(400, "This invoice cannot be changed")
    if action in {"reverse_payment", "delete_payment"}:
        if action == "delete_payment":
            raise HTTPException(409, "Payment history is permanent and cannot be deleted")
        payment = await db.payments.find_one({
            "id": target_id, "invoice_id": iid, "archived": {"$ne": True},
            **({"reversed": {"$ne": True}} if action == "reverse_payment" else {}),
        }, {"_id": 0, "id": 1})
        if not payment:
            raise HTTPException(404, "Payment not found or no longer available")

    supervisor_id, supervisor_name = await authenticate_supervisor(password, user)
    await db.invoice_edit_authorizations.delete_many({
        "user_id": user["id"],
        "expires_at": {"$lte": datetime.now(timezone.utc)},
    })
    authorization_id = new_id()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    await db.invoice_edit_authorizations.insert_one({
        "id": authorization_id,
        "invoice_id": iid,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "supervisor_id": supervisor_id,
        "action": action,
        "target_id": target_id,
        "expires_at": expires_at,
    })
    await log_audit("invoice", iid, f"{action}_authorized", user,
                    reason=f"Supervisor approval by {supervisor_name}")
    return {"authorization_id": authorization_id, "expires_at": expires_at.isoformat()}

async def consume_invoice_action_authorization(authorization_id, iid, action, user, target_id=None):
    if can_skip_supervisor_approval(user) or (
        action == "edit" and can_edit_invoice_without_supervisor(user)
    ):
        return {
            "id": authorization_id,
            "invoice_id": iid,
            "user_id": user["id"],
            "company_id": user["_active_company_id"],
            "action": action,
            "supervisor_id": user["id"],
            "supervisor_exempt": True,
        }
    query = {
        "id": authorization_id,
        "invoice_id": iid,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "action": action,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    }
    if target_id is not None:
        query["target_id"] = target_id
    authorization = await db.invoice_edit_authorizations.find_one_and_delete(query, projection={"_id": 0})
    if not authorization:
        raise HTTPException(403, "Supervisor approval is required for this action")
    return authorization

@api.post("/invoices/{iid}/authorize-edit")
async def authorize_invoice_edit(iid: str, body: InvoiceEditAuthorizationIn, user=Depends(get_current_user)):
    return await create_invoice_action_authorization(iid, "edit", body.password, user)

@api.post("/invoices/{iid}/authorize-action")
async def authorize_invoice_action(iid: str, body: InvoiceActionAuthorizationIn, user=Depends(get_current_user)):
    if body.action not in {"void", "reverse_payment"}:
        raise HTTPException(400, "Unsupported supervisor action")
    if body.action == "reverse_payment" and not body.target_id:
        raise HTTPException(400, "A payment is required for this action")
    if body.action == "void" and body.target_id:
        raise HTTPException(400, "This action does not accept a target")
    return await create_invoice_action_authorization(iid, body.action, body.password, user, body.target_id)

async def restore_invoice_stock(inv, user):
    movements = await listall("stock_movements", {"invoice_id": inv["id"], "type": "invoice"})
    quantities = {}
    for movement in movements:
        stock_id = movement["stock_id"]
        quantities[stock_id] = quantities.get(stock_id, Decimal("0")) - D(movement["quantity"]) * mov_sign(movement)
    quantities = {stock_id: quantity for stock_id, quantity in quantities.items() if quantity > 0}
    if not quantities:
        return False
    async with StockLock(quantities):
        for stock_id, quantity in quantities.items():
            stock = await db.stock.find_one({"id": stock_id}, {"_id": 0})
            if not stock:
                raise HTTPException(409, f"Cannot restore invoice stock: stock item {stock_id} no longer exists")
            movement = await post_movement(
                stock, "invoice", quantity, user,
                reason=f"Stock returned from archived invoice {inv.get('number') or inv['id']}",
                reference=inv.get("number") or inv["id"],
                direction=1,
                dedupe_key=f"invoice-archive:{inv['id']}:{inv.get('updated_at') or inv.get('created_at')}:{stock_id}",
                extra={"invoice_id": inv["id"], "invoice_number": inv.get("number", ""),
                       "invoice_stock_return": True,
                       "batch_allocations": await invoice_return_batch_allocations(
                           inv["id"], stock_id, quantity,
                       )},
            )
            await log_audit("stock_movement", movement["id"], "posted", user, after=movement)
    await update_doc("invoices", inv["id"], {"stock_deducted": False, "stock_restored": True})
    return True

async def _archive_invoice(iid, user, reason="", restore_stock=False):
    inv = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not inv:
        return False
    if inv.get("archived"):
        return True
    if restore_stock and inv.get("stock_deducted"):
        await restore_invoice_stock(inv, user)
    await update_doc("invoices", iid, {
        "archived": True,
        "archived_at": now_iso(),
        "archived_by": user.get("id"),
    })
    await log_audit("invoice", iid, "archived", user, reason=reason, before=inv)
    return True

@api.delete("/invoices/{iid}")
async def delete_invoice(iid: str, restore_stock: bool = False, user=Depends(get_current_user)):
    require_invoice_delete_access(user)
    if not await _archive_invoice(iid, user, restore_stock=restore_stock):
        raise HTTPException(404, "Invoice not found")
    return {"ok": True, "archived": True, "stock_restored": restore_stock}

@api.delete("/invoices/{iid}/permanent")
async def permanently_delete_invoice(
    iid: str,
    reverse_payments: bool = False,
    user=Depends(get_current_user),
):
    require_profile_owner(user)
    inv = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if not inv.get("archived"):
        raise HTTPException(409, "Archive the invoice before permanently deleting it")
    payments_reversed = await reverse_invoice_payments_for_permanent_delete(iid, user) if reverse_payments else 0
    await log_audit("invoice", iid, "permanently_deleted", user,
                    before={"number": inv.get("number"), "customer_name": inv.get("customer_name"),
                            "total": inv.get("total"), "status": derive_status(inv),
                            "payments_reversed": payments_reversed})
    await db.invoice_share_links.delete_one({"invoice_id": iid})
    await db.invoices.delete_one({"id": iid, "archived": True})
    return {"ok": True, "deleted": True, "payments_reversed": payments_reversed}

class BulkPermanentDeleteIn(BaseModel):
    ids: List[str] = Field(min_length=1, max_length=100)
    reverse_payments: bool = False


async def reverse_invoice_payments_for_permanent_delete(iid, user):
    payments = await db.payments.find(
        {"invoice_id": iid, "reversed": {"$ne": True}}, {"_id": 0},
    ).to_list(None)
    reason = "Invoice permanently deleted; owner chose to reverse the client payment."
    reversed_count = 0
    for payment in payments:
        reversed_payment = await db.payments.find_one_and_update(
            {"id": payment["id"], "reversed": {"$ne": True}},
            {"$set": {
                "reversed": True,
                "reversed_reason": reason,
                "reversed_at": now_iso(),
                "reversed_by": user.get("email") or user.get("id", "owner"),
            }},
            projection={"_id": 0},
            return_document=ReturnDocument.AFTER,
        )
        if not reversed_payment:
            continue
        reversed_count += 1
        await log_audit(
            "payment", payment["id"], "reversed", user,
            before={"reversed": False}, after={"reversed": True}, reason=reason,
        )
        await emit_workflow_event("payment.reversed", reversed_payment)
    return reversed_count

@api.post("/invoices/bulk-permanent-delete")
async def bulk_permanently_delete_invoices(body: BulkPermanentDeleteIn, user=Depends(get_current_user)):
    require_profile_owner(user)
    invoice_ids = list(dict.fromkeys(body.ids))
    invoices = []
    for iid in invoice_ids:
        invoice = await db.invoices.find_one({"id": iid}, {"_id": 0})
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        if not invoice.get("archived"):
            raise HTTPException(409, "Archive every selected invoice before permanently deleting them")
        invoices.append(invoice)

    payments_reversed = 0
    for invoice in invoices:
        iid = invoice["id"]
        invoice_payments_reversed = (
            await reverse_invoice_payments_for_permanent_delete(iid, user)
            if body.reverse_payments else 0
        )
        payments_reversed += invoice_payments_reversed
        await log_audit(
            "invoice", iid, "permanently_deleted", user,
            before={
                "number": invoice.get("number"),
                "customer_name": invoice.get("customer_name"),
                "total": invoice.get("total"),
                "status": derive_status(invoice),
                "payments_reversed": invoice_payments_reversed,
            },
        )
        await db.invoice_share_links.delete_one({"invoice_id": iid})
        await db.invoices.delete_one({"id": iid, "archived": True})
    return {"deleted": len(invoices), "payments_reversed": payments_reversed}

@api.post("/invoices/{iid}/restore")
async def restore_invoice(iid: str, user=Depends(get_current_user)):
    require_profile_owner(user)
    inv = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if not inv.get("archived"):
        return {"ok": True, "archived": False}
    restored = await update_doc("invoices", iid, {
        "archived": False,
        "archived_at": None,
        "archived_by": None,
    })
    await db.payments.update_many(
        {"invoice_id": iid, "archived": True},
        {"$set": {"archived": False, "archived_at": None, "archived_by": None}},
    )
    await log_audit("invoice", iid, "restored", user, before=inv, after=restored)
    return {"ok": True, "archived": False}

class BulkDeleteIn(BaseModel):
    ids: List[str]
    reason: Optional[str] = ""
    restore_stock: bool = False

@api.post("/invoices/bulk-delete")
async def bulk_delete_invoices(body: BulkDeleteIn, user=Depends(get_current_user)):
    require_invoice_delete_access(user)
    n = 0
    for iid in body.ids:
        n += await _archive_invoice(iid, user, body.reason or "", body.restore_stock)
    return {"archived": n, "stock_restored": body.restore_stock}

async def validate_invoice_order_ids(order_ids, customer_id, customer_name):
    normalized_ids = [str(order_id).strip() for order_id in (order_ids or [])]
    if any(not order_id for order_id in normalized_ids) or len(set(normalized_ids)) != len(normalized_ids):
        raise HTTPException(400, "Selected orders must be valid and unique")

    for order_id in normalized_ids:
        order = await db.orders.find_one({"id": order_id}, {"_id": 0})
        if not order:
            raise HTTPException(404, "Selected order not found")
        if order.get("archived") or order.get("status") == "Cancelled":
            raise HTTPException(409, "Cancelled or archived orders cannot be invoiced")
        if order.get("invoice_id"):
            raise HTTPException(409, "Selected order is already linked to an invoice")
        if order.get("customer_id") and order["customer_id"] != customer_id:
            raise HTTPException(400, "Selected order must belong to the invoice customer")
        if not order.get("customer_id") and (order.get("customer_name") or "").strip().casefold() != customer_name.strip().casefold():
            raise HTTPException(400, "Selected order must belong to the invoice customer")
    return normalized_ids


async def link_invoice_orders(invoice):
    for order_id in invoice.get("order_ids") or []:
        result = await db.orders.update_one(
            {
                "id": order_id,
                "$or": [
                    {"invoice_id": {"$in": [None, ""]}},
                    {"invoice_id": invoice["id"]},
                ],
            },
            {"$set": {
                "invoice_id": invoice["id"],
                "invoice_number": invoice.get("number") or invoice.get("reference") or "",
                "updated_at": now_iso(),
            }},
        )
        if result.matched_count == 0:
            raise HTTPException(409, "Selected order is already linked to another invoice")


async def _prepare_invoice(body: InvoiceIn, user=None, existing=None):
    customer_id = (body.customer_id or "").strip()
    cust = await db.customers.find_one({"id": customer_id}) if customer_id else None
    if customer_id and not cust:
        raise HTTPException(400, "Customer not found")
    if not cust and not body.customer_name.strip():
        raise HTTPException(400, "Customer name is required")
    inv = body.model_dump()
    inv.pop("deduct_stock", None)
    inv.pop("allow_negative_stock", None)
    inv.pop("supervisor_authorization", None)
    if (inv.get("payment_terms") or "").strip().casefold() != "cash on delivery":
        inv["cod_amount_due"] = None
        inv["cod_amount_collected"] = None
    inv["customer_id"] = customer_id
    inv["order_ids"] = (
        list(existing.get("order_ids") or [])
        if existing is not None
        else await validate_invoice_order_ids(body.order_ids, customer_id, inv.get("customer_name", ""))
    )
    if not inv.get("idempotency_key"):
        inv.pop("idempotency_key", None)
    if inv.get("opening_balance") is None or inv.get("opening_balance") is False:
        inv.pop("opening_balance", None)
    if uses_unified_price_list(active_company_id.get()):
        inv["zone"] = 1
    if any(inv.get(field, 0) < 0 for field in ("discount", "extra_charges", "delivery_fee", "tax_rate")):
        raise HTTPException(400, "Discount, additional charges, delivery fee and tax rate cannot be negative")
    if any((it.get("unit_price") or 0) < 0 for it in inv.get("items", [])):
        raise HTTPException(400, "Unit prices cannot be negative")
    if inv.get("tax_rate", 0) > 100:
        raise HTTPException(400, "Tax rate cannot be above 100%")
    items_subtotal = sum(D(it.get("qty")) * D(it.get("unit_price")) for it in inv.get("items", []))
    if inv.get("items") and D(inv.get("discount")) > items_subtotal:
        raise HTTPException(400, "Discount cannot be greater than the invoice subtotal")
    inv["customer_name"] = cust["name"] if cust else body.customer_name.strip()
    submitted_client_number = (body.client_number or "").strip()
    can_edit_client_number = bool(
        user and (
            not worker_restrictions_apply(user)
            or "customers" in (user.get("worker_allowed_sections") or [])
        )
    )
    if cust:
        stored_client_number = (cust.get("client_number") or "").strip()
        if submitted_client_number and submitted_client_number != stored_client_number and not can_edit_client_number:
            raise HTTPException(403, "You cannot override this customer's client number")
        inv["client_number"] = (
            submitted_client_number if can_edit_client_number and submitted_client_number
            else stored_client_number
        )
    elif submitted_client_number and not can_edit_client_number:
        raise HTTPException(403, "You cannot set a client number for this customer")
    else:
        inv["client_number"] = submitted_client_number
    driver_id = (body.assigned_driver_id or "").strip()
    if driver_id:
        driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0})
        if not driver:
            raise HTTPException(400, "Assigned driver not found in this company")
        inv["assigned_driver_id"] = driver_id
        inv["assigned_driver_name"] = driver.get("name", "")
    else:
        inv["assigned_driver_id"] = ""
        inv["assigned_driver_name"] = ""
    if existing is not None:
        if existing.get("made_by") is None:
            inv.pop("made_by", None)
            inv.pop("made_by_user_id", None)
        else:
            inv["made_by"] = existing.get("made_by", "")
            if existing.get("made_by_user_id"):
                inv["made_by_user_id"] = existing["made_by_user_id"]
    else:
        made_by = (body.made_by or "").strip()
        if not made_by:
            raise HTTPException(400, "Made By is required")
        inv["made_by"] = made_by
        if user and user.get("id"):
            inv["made_by_user_id"] = user["id"]
    if not inv.get("due_date"):
        inv["due_date"] = inv["date"]
    inv["amount_paid"] = 0
    compute_invoice(inv)
    return inv

def invoice_item_price_key(item, zone):
    return (
        price_category(zone, item.get("category", "")).casefold(),
        canonical_price_size(item.get("size", "")).casefold(),
        " ".join(str(item.get("description") or "").split()).casefold(),
    )

async def validate_invoice_item_price_edits(body, existing, user):
    if user.get("role") == "owner" or user.get("_active_role") in ("owner", "admin"):
        return
    if worker_restrictions_apply(user):
        if user.get("worker_can_edit_invoice_prices"):
            return
    else:
        return
    restricted_role = "Workers"
    zone = 1 if uses_unified_price_list(active_company_id.get()) else body.zone
    previous_items = {}
    for item in (existing or {}).get("items", []):
        previous_items.setdefault(invoice_item_price_key(item, zone), []).append(item)

    for item in body.items:
        submitted = item.model_dump()
        matches = previous_items.get(invoice_item_price_key(submitted, zone), [])
        if matches:
            previous = matches.pop(0)
            if (
                r2(submitted.get("unit_price")) != r2(previous.get("unit_price"))
                or bool(submitted.get("price_override")) != bool(previous.get("price_override"))
            ):
                raise HTTPException(403, f"{restricted_role} cannot change invoice item prices")
            continue

        if (
            body.status == "draft"
            and not submitted.get("size")
            and not submitted.get("description")
            and not D(submitted.get("unit_price"))
        ):
            continue
        if not submitted.get("size") or submitted.get("price_override"):
            raise HTTPException(403, f"{restricted_role} can only add invoice items at a configured price")
        resolved = await resolve_price(zone, submitted.get("category", ""), submitted["size"])
        if resolved.get("price") is None:
            raise HTTPException(403, f"{restricted_role} can only add invoice items at a configured price")
        if r2(submitted.get("unit_price")) != r2(resolved["price"]):
            raise HTTPException(403, f"{restricted_role} cannot change invoice item prices")

@api.post("/invoices")
async def create_invoice(body: InvoiceIn, user=Depends(get_current_user)):
    await validate_invoice_item_price_edits(body, None, user)
    if body.idempotency_key:
        existing_submission = await db.invoices.find_one(
            {"idempotency_key": body.idempotency_key}, {"_id": 0},
        )
        if existing_submission:
            if existing_submission.get("submission_payload_hash") != invoice_submission_hash(body):
                raise HTTPException(409, "This invoice submission key was already used for different invoice data")
            await link_invoice_orders(existing_submission)
            return invoice_for_user(existing_submission, user)

    deduct_stock = body.deduct_stock
    inv = await _prepare_invoice(body, user=user)
    if body.idempotency_key:
        inv["idempotency_key"] = body.idempotency_key
        inv["submission_payload_hash"] = invoice_submission_hash(body)
    inv["previous_invoices_pending"] = await previous_invoice_balances(
        inv.get("customer_id"),
        inv.get("date"),
    )
    inv["customer_balance_before_invoice"] = await customer_balance_before_invoice(
        inv.get("customer_id"),
    )
    if inv["status"] != "draft":
        inv["status"] = "issued"
        await validate_for_issue(inv)
        inv["number"] = await next_invoice_number(inv.get("date"), inv.get("invoice_type", "standard"))
        inv["numbering_year"] = invoice_numbering_year(inv.get("date"))
        inv["issued_at"] = now_iso()
        inv["audit"] = [{"action": "issued", "at": now_iso(), "by": user["email"]}]
    else:
        if deduct_stock:
            raise HTTPException(400, "Stock can only be deducted when an invoice is issued")
        inv["number"] = None
        inv["audit"] = [{"action": "draft_created", "at": now_iso(), "by": user["email"]}]
    if not deduct_stock:
        try:
            record = await insert("invoices", inv)
        except DuplicateKeyError as error:
            if not body.idempotency_key:
                raise
            existing_submission = await db.invoices.find_one(
                {"idempotency_key": body.idempotency_key}, {"_id": 0},
            )
            if not existing_submission:
                raise
            if existing_submission.get("submission_payload_hash") != invoice_submission_hash(body):
                raise HTTPException(409, "This invoice submission key was already used for different invoice data") from error
            await link_invoice_orders(existing_submission)
            return invoice_for_user(existing_submission, user)
        await link_invoice_orders(record)
        await emit_workflow_event("invoice.created", record)
        if record.get("status") != "draft":
            await emit_workflow_event("invoice.issued", record)
        await log_audit(
            "invoice", record["id"], "invoice_created", user,
            after={field: record.get(field) for field in INVOICE_AUDIT_FIELDS if field in record},
        )
        return invoice_for_user(record, user)
    deductions = await invoice_stock_deductions(inv)
    async with StockLock([item["stock_id"] for item in deductions]):
        await validate_invoice_stock(deductions, body.allow_negative_stock)
        try:
            rec = await insert("invoices", inv)
        except DuplicateKeyError as error:
            if not body.idempotency_key:
                raise
            existing_submission = await db.invoices.find_one(
                {"idempotency_key": body.idempotency_key}, {"_id": 0},
            )
            if not existing_submission:
                raise
            if existing_submission.get("submission_payload_hash") != invoice_submission_hash(body):
                raise HTTPException(409, "This invoice submission key was already used for different invoice data") from error
            await link_invoice_orders(existing_submission)
            return invoice_for_user(existing_submission, user)
        await post_invoice_stock_deductions(rec, deductions, user)
        rec = await update_doc("invoices", rec["id"], {"stock_deducted": True})
    await link_invoice_orders(rec)
    await emit_workflow_event("invoice.created", rec)
    if rec.get("status") != "draft":
        await emit_workflow_event("invoice.issued", rec)
    await log_audit(
        "invoice", rec["id"], "invoice_created", user,
        after={field: rec.get(field) for field in INVOICE_AUDIT_FIELDS if field in rec},
    )
    return invoice_for_user(rec, user)

@api.put("/invoices/{iid}")
async def update_invoice(iid: str, body: InvoiceIn, user=Depends(get_current_user)):
    existing = await db.invoices.find_one({"id": iid})
    if not existing:
        raise HTTPException(404, "Invoice not found")
    if existing.get("status") == "void":
        raise HTTPException(400, "Cannot edit a voided invoice")
    reason = (body.edit_reason or "").strip()
    if not reason:
        raise HTTPException(400, "A reason is required to edit an invoice")
    await consume_invoice_action_authorization(body.supervisor_authorization, iid, "edit", user)
    await validate_invoice_item_price_edits(body, existing, user)
    inv = await _prepare_invoice(body, user=user, existing=existing)
    inv["status"] = invoice_status_for_update(body, existing.get("status"))
    if existing.get("idempotency_key"):
        inv["idempotency_key"] = existing["idempotency_key"]
    else:
        inv.pop("idempotency_key", None)
    if existing.get("submission_payload_hash"):
        inv["submission_payload_hash"] = existing["submission_payload_hash"]
    inv["invoice_type"] = existing.get("invoice_type", "standard")
    inv["previous_invoices_pending"] = existing.get("previous_invoices_pending", [])
    if existing.get("customer_id") != inv.get("customer_id"):
        inv["customer_balance_before_invoice"] = await customer_balance_before_invoice(
            inv.get("customer_id"),
            iid,
        )
    elif "customer_balance_before_invoice" in existing:
        inv["customer_balance_before_invoice"] = existing["customer_balance_before_invoice"]
    else:
        inv["customer_balance_before_invoice"] = await customer_balance_before_invoice(
            inv.get("customer_id"),
            iid,
        )
    inv.pop("edit_reason", None)
    inv["amount_paid"] = existing.get("amount_paid", 0)
    compute_invoice(inv)
    inv["number"] = existing.get("number")
    inv["audit"] = existing.get("audit", [])
    for keep in ("issued_at", "void_reason", "numbering_year"):
        if keep in existing:
            inv[keep] = existing[keep]
    if "opening_balance" in existing and body.opening_balance is not False:
        inv["opening_balance"] = existing["opening_balance"]
    if existing.get("number"):
        inv["status"] = existing.get("status")
    if inv["status"] != "draft":
        await validate_for_issue(inv)
        compute_invoice(inv)
        if inv["total"] < inv["amount_paid"]:
            raise HTTPException(400, f"Invoice total cannot be lower than payments already received (R {inv['amount_paid']:.2f})")
    if existing.get("status") == "draft" and inv["status"] != "draft" and not inv["number"]:
        inv["status"] = "issued"
        inv["previous_invoices_pending"] = await previous_invoice_balances(
            inv.get("customer_id"),
            inv.get("date"),
            iid,
        )
        inv["customer_balance_before_invoice"] = await customer_balance_before_invoice(
            inv.get("customer_id"),
            iid,
        )
        inv["number"] = await next_invoice_number(inv.get("date"), inv.get("invoice_type", "standard"))
        inv["numbering_year"] = invoice_numbering_year(inv.get("date"))
        inv["issued_at"] = now_iso()
        inv["audit"].append({"action": "issued", "at": now_iso(), "by": user["email"]})
    else:
        changes = invoice_changes(existing, inv)
        inv["audit"].append({"action": "edited", "at": now_iso(), "by": user["email"], "reason": reason, "changes": changes})
    if existing.get("stock_deducted"):
        inv["stock_deducted"] = True
    if not body.deduct_stock:
        rec = await update_doc("invoices", iid, inv)
    else:
        stock_changes = await invoice_stock_changes({**inv, "id": iid})
        async with StockLock(stock_changes):
            stocks = await validate_invoice_stock_changes(stock_changes, body.allow_negative_stock)
            rec = await update_doc("invoices", iid, inv)
            await post_invoice_stock_changes(rec, stock_changes, stocks, user)
            rec = await update_doc("invoices", iid, {"stock_deducted": True, "stock_restored": False})
    if "opening_balance" in existing and body.opening_balance is False:
        await db.invoices.update_one({"id": iid}, {"$unset": {"opening_balance": ""}})
        rec.pop("opening_balance", None)
    await log_audit(
        "invoice", iid, "invoice_edited", user,
        before={field: existing.get(field) for field in INVOICE_AUDIT_FIELDS if field in existing},
        after={field: rec.get(field) for field in INVOICE_AUDIT_FIELDS if field in rec},
        reason=reason,
    )
    await emit_workflow_event("invoice.updated", rec)
    if existing.get("status") == "draft" and rec.get("status") != "draft":
        await emit_workflow_event("invoice.issued", rec)
    rec["status"] = derive_status(rec)
    rec["payment_records"] = await listall("payments", {"invoice_id": iid}, ("created_at", -1))
    return invoice_for_user(rec, user)


@api.get("/invoices/{iid}/audit")
async def get_invoice_audit(iid: str, user=Depends(get_current_user)):
    require_profile_owner(user)
    if not await db.invoices.find_one({"id": iid}, {"_id": 0, "id": 1}):
        raise HTTPException(404, "Invoice not found")
    history = await db.audit_log.find(
        {
            "entity": "invoice",
            "entity_id": iid,
            "action": {"$in": ["invoice_created", "invoice_edited", "invoice_issued", "invoice_voided"]},
        },
        {"_id": 0},
    ).sort("at", -1).to_list(500)
    needs_actor_lookup = [
        entry for entry in history
        if entry.get("user") != "system"
        and (
            not entry.get("user_name")
            or "@" in str(entry.get("user_name") or "")
            or "@" in str(entry.get("user") or "")
        )
    ]
    if needs_actor_lookup:
        user_ids = list({entry.get("user_id") for entry in needs_actor_lookup if entry.get("user_id")})
        emails = list({
            identity
            for entry in needs_actor_lookup
            for identity in (entry.get("user"), entry.get("user_name"))
            if identity and "@" in str(identity)
        })
        usernames = list({
            identity
            for entry in needs_actor_lookup
            for identity in (entry.get("user"), entry.get("user_name"))
            if identity and "@" not in str(identity) and identity != "system"
        })
        selectors = []
        if user_ids:
            selectors.append({"id": {"$in": user_ids}})
        if emails:
            selectors.append({"email": {"$in": emails}})
        if usernames:
            selectors.append({"username": {"$in": usernames}})
        if selectors:
            actors = await base_db.users.find(
                {"$or": selectors}, {"_id": 0, "id": 1, "email": 1, "name": 1, "username": 1},
            ).to_list(None)
            actors_by_id = {actor["id"]: actor for actor in actors if actor.get("id")}
            actors_by_email = {
                actor["email"].casefold(): actor
                for actor in actors if actor.get("email")
            }
            actors_by_username = {
                actor["username"].casefold(): actor
                for actor in actors if actor.get("username")
            }
            for entry in needs_actor_lookup:
                identities = (entry.get("user"), entry.get("user_name"))
                actor = actors_by_id.get(entry.get("user_id"))
                if not actor:
                    actor = next(
                        (
                            actors_by_email.get(str(identity).casefold())
                            or actors_by_username.get(str(identity).casefold())
                            for identity in identities if identity
                        ),
                        None,
                    )
                if actor:
                    entry["user_name"] = actor.get("name") or actor.get("username") or actor.get("email")
    for entry in history:
        if not entry.get("user_name"):
            entry["user_name"] = (
                "System" if entry.get("user") == "system"
                else entry.get("user") or "Historical actor not recorded"
            )
    return history

@api.post("/invoices/{iid}/issue")
async def issue_invoice(iid: str, body: InvoiceIssueIn = InvoiceIssueIn(), user=Depends(get_current_user)):
    inv = await db.invoices.find_one({"id": iid})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.get("archived"):
        raise HTTPException(409, "Restore this invoice before issuing it")
    if inv.get("status") == "void":
        raise HTTPException(400, "Cannot issue a voided invoice")
    await validate_for_issue(inv)
    if body.deduct_stock and inv.get("stock_deducted"):
        raise HTTPException(409, "Stock has already been deducted for this invoice")
    upd = {"items": inv["items"]}
    if not inv.get("number"):
        upd["number"] = await next_invoice_number(inv.get("date"), inv.get("invoice_type", "standard"))
        upd["numbering_year"] = invoice_numbering_year(inv.get("date"))
        upd["issued_at"] = now_iso()
    upd["status"] = "issued"
    upd["previous_invoices_pending"] = await previous_invoice_balances(
        inv.get("customer_id"),
        inv.get("date"),
        iid,
    )
    upd["customer_balance_before_invoice"] = await customer_balance_before_invoice(
        inv.get("customer_id"),
        iid,
    )
    audit = inv.get("audit", [])
    audit.append({"action": "issued", "at": now_iso(), "by": user["email"]})
    upd["audit"] = audit
    if not body.deduct_stock:
        rec = await update_doc("invoices", iid, upd)
    else:
        deductions = await invoice_stock_deductions(inv)
        async with StockLock([item["stock_id"] for item in deductions]):
            await validate_invoice_stock(deductions, body.allow_negative_stock)
            rec = await update_doc("invoices", iid, upd)
            await post_invoice_stock_deductions(rec, deductions, user)
            rec = await update_doc("invoices", iid, {"stock_deducted": True})
    await emit_workflow_event("invoice.issued", rec)
    await log_audit(
        "invoice", iid, "invoice_issued", user,
        before={field: inv.get(field) for field in INVOICE_AUDIT_FIELDS if field in inv},
        after={field: rec.get(field) for field in INVOICE_AUDIT_FIELDS if field in rec},
    )
    return invoice_for_user(rec, user)

class ReasonIn(BaseModel):
    reason: str
    supervisor_authorization: Optional[str] = None

@api.post("/invoices/{iid}/void")
async def void_invoice(iid: str, body: ReasonIn, user=Depends(get_current_user)):
    inv = await db.invoices.find_one({"id": iid}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required to void an invoice")
    if inv.get("status") == "void":
        raise HTTPException(400, "Invoice is already void")
    if await db.payments.count_documents({"invoice_id": iid, "reversed": {"$ne": True}}):
        raise HTTPException(400, "This invoice has payments. Reverse the payments first, then void it")
    await consume_invoice_action_authorization(body.supervisor_authorization, iid, "void", user)
    audit = inv.get("audit", [])
    audit.append({"action": "voided", "reason": body.reason, "at": now_iso(), "by": user["email"]})
    rec = await update_doc("invoices", iid, {"status": "void", "void_reason": body.reason, "audit": audit})
    await log_audit(
        "invoice", iid, "invoice_voided", user,
        before={"status": inv.get("status"), "void_reason": inv.get("void_reason")},
        after={"status": "void", "void_reason": body.reason},
        reason=body.reason,
    )
    await emit_workflow_event("invoice.voided", rec)
    return invoice_for_user(rec, user)

# ---------------- Payments ----------------
class PaymentIn(BaseModel):
    amount: float
    method: str = "Cash"
    receiving_on: Optional[str] = ""
    date: str = Field(default_factory=today_str)
    reference: Optional[str] = ""
    notes: Optional[str] = ""
    idempotency_key: Optional[str] = None

async def recalc_invoice_payments(iid):
    inv = await db.invoices.find_one({"id": iid}, {"_id": 0})
    pays = await listall("payments", {"invoice_id": iid, "reversed": {"$ne": True}, "archived": {"$ne": True}})
    inv["amount_paid"] = dsum(p.get("amount", 0) for p in pays)
    compute_invoice(inv)
    await db.invoices.update_one({"id": iid}, {"$set": {"amount_paid": inv["amount_paid"], "outstanding": inv["outstanding"], "updated_at": now_iso()}})
    return inv

@api.post("/invoices/{iid}/payments")
async def record_payment(iid: str, body: PaymentIn, user=Depends(get_current_user)):
    if body.idempotency_key:
        dup = await db.payments.find_one({"idempotency_key": body.idempotency_key}, {"_id": 0})
        if dup:
            if dup.get("invoice_id") != iid:
                raise HTTPException(409, "This payment key was already used for a different invoice")
            return dup
    inv = await db.invoices.find_one({"id": iid})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.get("archived"):
        raise HTTPException(409, "Restore this invoice before recording a payment")
    if inv.get("status") == "void":
        raise HTTPException(400, "Cannot pay a voided invoice")
    if inv.get("status") == "draft" or not inv.get("number"):
        raise HTTPException(400, "Issue the invoice before recording payments")
    amt = r2(body.amount)
    if amt <= 0:
        raise HTTPException(400, "Amount must be positive")
    lock = await db.invoices.find_one_and_update({"id": iid, "payment_lock": {"$ne": True}}, {"$set": {"payment_lock": True}})
    if not lock:
        raise HTTPException(409, "Another payment for this invoice is being processed. Please retry")
    try:
        current = await recalc_invoice_payments(iid)
        outstanding = r2(current["outstanding"])
        if amt > outstanding:
            raise HTTPException(400, f"Amount exceeds outstanding balance of R {outstanding:.2f}")
        pay = body.model_dump()
        if not pay.get("idempotency_key"):
            pay.pop("idempotency_key")
        pay.update({"amount": amt, "invoice_id": iid, "invoice_number": inv.get("number"),
                    "customer_id": inv.get("customer_id"), "customer_name": inv.get("customer_name"),
                    "reversed": False, "user": user["email"]})
        try:
            pay_rec = await insert("payments", pay)
        except DuplicateKeyError:
            return await db.payments.find_one({"idempotency_key": body.idempotency_key}, {"_id": 0})
        await recalc_invoice_payments(iid)
        audit = inv.get("audit", [])
        audit.append({"action": "payment", "amount": amt, "at": now_iso(), "by": user["email"]})
        await db.invoices.update_one({"id": iid}, {"$set": {"audit": audit}})
        await log_audit("payment", pay_rec["id"], "recorded", user, after=pay_rec)
        await emit_workflow_event("payment.recorded", pay_rec)
        return pay_rec
    finally:
        await db.invoices.update_one({"id": iid}, {"$unset": {"payment_lock": ""}})

@api.post("/payments/{pid}/reverse")
async def reverse_payment(pid: str, body: ReasonIn, user=Depends(get_current_user)):
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required to reverse a payment")
    payment = await db.payments.find_one({"id": pid, "reversed": {"$ne": True}}, {"_id": 0})
    if not payment:
        raise HTTPException(400, "Payment not found or already reversed")
    if not payment.get("other_balance_payment"):
        await consume_invoice_action_authorization(
            body.supervisor_authorization, payment["invoice_id"], "reverse_payment", user, pid,
        )
    p = await db.payments.find_one_and_update(
        {"id": pid, "reversed": {"$ne": True}},
        {"$set": {"reversed": True, "reversed_reason": body.reason, "reversed_at": now_iso(), "reversed_by": user["email"]}},
        projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if not p:
        raise HTTPException(400, "Payment not found or already reversed")
    if p.get("other_balance_payment"):
        await db.customers.update_one(
            {"id": p["customer_id"]}, {"$inc": {"other_balance": r2(p.get("amount", 0))}},
        )
        await db.customers.update_one(
            {"id": p["customer_id"], "other_balance_payments.payment_id": pid},
            {"$set": {"other_balance_payments.$.reversed": True}},
        )
    else:
        await recalc_invoice_payments(p["invoice_id"])
    await log_audit("payment", pid, "reversed", user, before={"reversed": False}, after={"reversed": True}, reason=body.reason)
    await emit_workflow_event("payment.reversed", p)
    return p

@api.delete("/payments/{pid}")
async def delete_invoice_payment(pid: str, body: ReasonIn, user=Depends(get_current_user)):
    raise HTTPException(409, "Payment history is permanent and cannot be deleted")

@api.delete("/payments/{pid}/other-balance")
async def delete_other_balance_payment(pid: str, user=Depends(get_current_user)):
    raise HTTPException(409, "Payment history is permanent and cannot be deleted")

@api.delete("/customers/{cid}/other-balance-history/{index}")
async def delete_legacy_other_balance_history(cid: str, index: int, user=Depends(get_current_user)):
    raise HTTPException(409, "Payment history is permanent and cannot be deleted")

@api.get("/payments")
async def get_payments(include_archived: bool = False, user=Depends(get_current_user)):
    return await listall("payments", sort=("created_at", -1))


@api.get("/payments/summary")
async def get_payments_summary(payment_date: str, user=Depends(get_current_user)):
    try:
        selected_date = date.fromisoformat(payment_date).isoformat()
    except (TypeError, ValueError):
        raise HTTPException(422, "Payment date must be a valid YYYY-MM-DD date")
    if selected_date != payment_date:
        raise HTTPException(422, "Payment date must use YYYY-MM-DD format")

    payments = await daily_report_records(
        "payments",
        selected_date,
        {"archived": {"$ne": True}, "reversed": {"$ne": True}},
        "created_at",
    )
    other_balance_rows = [
        {
            "id": payment.get("id"), "invoice_id": None, "date": payment.get("date"),
            "amount": r2(payment.get("amount", 0)), "method": payment.get("method") or "",
            "receiving_on": payment.get("receiving_on") or "", "reference": payment.get("reference") or "",
            "notes": payment.get("notes") or "", "invoice_number": "Other balance",
            "customer_name": payment.get("customer_name") or "",
        }
        for payment in payments
        if payment.get("other_balance_payment") and not payment.get("express")
    ]
    invoice_ids = list({
        payment.get("invoice_id")
        for payment in payments
        if payment.get("invoice_id") and not payment.get("other_balance_payment")
    })
    if not invoice_ids:
        return other_balance_rows
    invoices = await db.invoices.find(
        {
            "id": {"$in": invoice_ids},
            "invoice_type": {"$ne": "express"},
            "archived": {"$ne": True},
        },
        {"_id": 0, "id": 1, "number": 1, "customer_name": 1},
    ).to_list(None)
    invoice_by_id = {invoice["id"]: invoice for invoice in invoices}
    return other_balance_rows + [
        {
            "id": payment.get("id"),
            "invoice_id": payment.get("invoice_id"),
            "date": payment.get("date"),
            "amount": r2(payment.get("amount", 0)),
            "method": payment.get("method") or "",
            "receiving_on": payment.get("receiving_on") or "",
            "reference": payment.get("reference") or "",
            "notes": payment.get("notes") or "",
            "invoice_number": payment.get("invoice_number") or invoice_by_id[payment["invoice_id"]].get("number") or "",
            "customer_name": payment.get("customer_name") or invoice_by_id[payment["invoice_id"]].get("customer_name") or "",
        }
        for payment in payments
        if payment.get("invoice_id") in invoice_by_id
    ]


@api.get("/express-payments")
async def get_express_payments(payment_date: str, user=Depends(get_current_user)):
    try:
        selected_date = date.fromisoformat(payment_date).isoformat()
    except (TypeError, ValueError):
        raise HTTPException(422, "Payment date must be a valid YYYY-MM-DD date")
    if selected_date != payment_date:
        raise HTTPException(422, "Payment date must use YYYY-MM-DD format")

    payments = await daily_report_records(
        "payments",
        selected_date,
        {"archived": {"$ne": True}, "reversed": {"$ne": True}},
        "created_at",
    )
    other_balance_rows = [
        {
            "id": payment.get("id"), "invoice_id": None, "date": payment.get("date"),
            "amount": r2(payment.get("amount", 0)), "method": payment.get("method") or "",
            "receiving_on": payment.get("receiving_on") or "", "reference": payment.get("reference") or "",
            "notes": payment.get("notes") or "", "invoice_number": "Other balance",
            "customer_name": payment.get("customer_name") or "",
            "include_on_daily_report": bool(payment.get("include_on_daily_report")),
        }
        for payment in payments
        if payment.get("other_balance_payment") and payment.get("express")
    ]
    payment_invoice_ids = list({payment.get("invoice_id") for payment in payments if payment.get("invoice_id")})
    if not payment_invoice_ids:
        return other_balance_rows
    invoices = await db.invoices.find(
        {
            "id": {"$in": payment_invoice_ids},
            "invoice_type": "express",
            "archived": {"$ne": True},
        },
        {"_id": 0, "id": 1, "number": 1, "customer_name": 1, "include_on_daily_report": 1},
    ).to_list(None)
    invoice_by_id = {invoice["id"]: invoice for invoice in invoices}
    if not invoice_by_id:
        return other_balance_rows

    return other_balance_rows + [
        {
            "id": payment.get("id"),
            "invoice_id": payment.get("invoice_id"),
            "date": payment.get("date"),
            "amount": r2(payment.get("amount", 0)),
            "method": payment.get("method") or "",
            "receiving_on": payment.get("receiving_on") or "",
            "reference": payment.get("reference") or "",
            "notes": payment.get("notes") or "",
            "invoice_number": payment.get("invoice_number") or invoice_by_id[payment["invoice_id"]].get("number") or "",
            "customer_name": payment.get("customer_name") or invoice_by_id[payment["invoice_id"]].get("customer_name") or "",
            "include_on_daily_report": bool(
                payment.get("include_on_daily_report")
                if payment.get("daily_report_inclusion_set")
                else payment.get("include_on_daily_report") or invoice_by_id[payment["invoice_id"]].get("include_on_daily_report")
            ),
        }
        for payment in payments
        if payment.get("invoice_id") in invoice_by_id
    ]

class PaymentDailyReportInclusionIn(BaseModel):
    included: bool

@api.post("/payments/{pid}/daily-report")
async def set_payment_daily_report_inclusion(
    pid: str, body: PaymentDailyReportInclusionIn, user=Depends(get_current_user),
):
    payment = await db.payments.find_one({"id": pid}, {"_id": 0})
    if not payment:
        raise HTTPException(404, "Payment not found")
    if payment.get("reversed") or payment.get("archived"):
        raise HTTPException(409, "Reversed or archived payments cannot be included in the daily report")
    if not payment.get("other_balance_payment"):
        invoice = await db.invoices.find_one({"id": payment.get("invoice_id")}, {"_id": 0})
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        if invoice.get("invoice_type") != "express":
            raise HTTPException(400, "Only Express Website payments can be selected separately for the daily report")
        if invoice.get("archived"):
            raise HTTPException(409, "Restore this invoice before changing its daily report selection")

    updated = await update_doc("payments", pid, {
        "include_on_daily_report": body.included,
        "daily_report_inclusion_set": True,
    })
    await log_audit(
        "payment", pid, "daily_report_inclusion_updated", user,
        before={
            "include_on_daily_report": payment.get("include_on_daily_report", False),
            "daily_report_inclusion_set": payment.get("daily_report_inclusion_set", False),
        },
        after={"include_on_daily_report": body.included, "daily_report_inclusion_set": True},
    )
    return updated

# ---------------- Stock ----------------
class StockIn(BaseModel):
    product: str
    size: str
    category: Optional[str] = Field(default=None, max_length=120)
    opening: float = 0
    threshold: float = 5
    unit_cost: Optional[float] = None
    selling_price: Optional[float] = None
    zone: int = 1

    @field_validator("opening", "threshold")
    @classmethod
    def stock_quantity_not_negative(cls, value):
        if value < 0:
            raise ValueError("Quantity cannot be negative")
        return value

    @field_validator("unit_cost", "selling_price")
    @classmethod
    def validate_unit_cost(cls, value):
        if value is not None and (not math.isfinite(value) or value < 0):
            raise ValueError("Amount must be a finite non-negative number")
        return value


def valid_ean13(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{13}", value):
        return False
    checksum = sum(int(digit) * (1 if index % 2 == 0 else 3) for index, digit in enumerate(value[:12]))
    return (10 - checksum % 10) % 10 == int(value[-1])


class ProductIdentificationIn(BaseModel):
    description: str = Field(default="", max_length=2000)
    sku: Optional[str] = Field(default=None, max_length=80)
    category: Optional[str] = Field(default=None, max_length=120)
    density: Optional[str] = Field(default=None, max_length=100)
    product_type: str = Field(default="", max_length=100)
    length: Optional[float] = None
    width: Optional[float] = None
    thickness: Optional[float] = None
    unit: Optional[str] = Field(default=None, max_length=20)
    ean13: Optional[str] = Field(default=None, min_length=13, max_length=13)
    data_matrix_payload: Optional[str] = Field(default=None, max_length=128)
    gs1_allocated: bool = False
    active: bool = True

    @field_validator("sku", mode="before")
    @classmethod
    def normalize_sku(cls, value):
        if value is None or value == "":
            return None
        if not isinstance(value, str):
            raise ValueError("SKU must be text")
        value = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9._/-]{0,79}", value):
            raise ValueError("SKU may contain letters, numbers, dots, underscores, slashes, and hyphens")
        return value

    @field_validator("category", "density", "unit", mode="before")
    @classmethod
    def normalize_optional_text(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("data_matrix_payload", mode="before")
    @classmethod
    def normalize_data_matrix(cls, value):
        if value is None or value == "":
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Data Matrix payload must be non-empty text")
        return value.strip()

    @field_validator("length", "width", "thickness", mode="before")
    @classmethod
    def validate_dimension(cls, value):
        if value is None or value == "":
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError("Dimensions must be positive numbers")
        if not math.isfinite(number) or number <= 0:
            raise ValueError("Dimensions must be positive finite numbers")
        return number

    @field_validator("ean13")
    @classmethod
    def validate_ean13_value(cls, value):
        if value is not None:
            value = value.strip()
            if not valid_ean13(value):
                raise ValueError("EAN-13 must contain 13 digits and a valid check digit")
        return value


class ProductStockDetailsIn(BaseModel):
    product: str = Field(min_length=1, max_length=120)
    dimensions: str = Field(min_length=3, max_length=100)

    @field_validator("product", "dimensions")
    @classmethod
    def validate_product_details(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Product name and dimensions cannot be blank")
        return value

    @field_validator("dimensions")
    @classmethod
    def validate_formatted_dimensions(cls, value):
        if not re.fullmatch(
            r"\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?",
            value,
            re.IGNORECASE,
        ):
            raise ValueError("Dimensions must be numeric, for example 910x100 or 910x100x50")
        return value


class ProductScanIn(BaseModel):
    code: str = Field(min_length=1, max_length=128)
    scan_id: Optional[str] = Field(default=None, max_length=80)


def product_code_payload(product_id):
    return f"IQF1:{str(product_id).upper()}"


def product_sku(company_id, product_id):
    prefixes = {
        "superiqfoam": "SFO",
        "iqfoam-manufactoring": "MFG",
        "iqfoam-whole-sallers": "WHL",
    }
    prefix = prefixes.get(company_id)
    if not prefix or not product_id:
        raise HTTPException(409, "Cannot create a SKU for an invalid product or company")
    suffix = re.sub(r"[^A-Z0-9]", "", str(product_id).upper().removeprefix("IQF"))
    if not suffix:
        raise HTTPException(409, "Cannot create a SKU for an invalid product identifier")
    return f"{prefix}-{suffix}"


def public_product_identification(stock, identity):
    company_id = identity["company_id"]
    product_id = identity["product_id"]
    return {
        "id": identity["id"],
        "company": next(
            (company["name"] for company in COMPANY_PROFILES if company["id"] == company_id),
            company_id,
        ),
        "product_id": product_id,
        "sku": identity.get("sku") or product_sku(company_id, product_id),
        "stock_id": stock["id"],
        "product": stock.get("product", ""),
        "category": identity.get("category") or stock.get("product", ""),
        "description": identity.get("description", ""),
        "dimensions": stock.get("size", ""),
        "size": stock.get("size", ""),
        "length": identity.get("length"),
        "width": identity.get("width"),
        "thickness": identity.get("thickness"),
        "unit": identity.get("unit"),
        "density": identity.get("density"),
        "product_type": identity.get("product_type", ""),
        "tracking_mode": identity.get("tracking_mode", "none"),
        "company_id": company_id,
        "company_name": next(
            (company["name"] for company in COMPANY_PROFILES if company["id"] == company_id),
            company_id,
        ),
        "ean13": identity.get("ean13"),
        "qr_payload": identity["qr_payload"],
        "data_matrix_payload": identity.get("data_matrix_payload"),
        "gs1_allocated": identity.get("gs1_allocated", False),
        "active": identity.get("active", True),
        "created_at": identity.get("created_at"),
        "updated_at": identity.get("updated_at"),
    }


def duplicate_product_identification_codes(identities):
    code_products = {}
    for identity in identities:
        product_id = identity.get("product_id")
        if not product_id:
            continue
        for field in ("sku", "ean13", "qr_payload", "data_matrix_payload"):
            code = identity.get(field)
            if isinstance(code, str) and code.strip():
                code_products.setdefault(code.strip().upper(), set()).add(product_id)
    return sum(1 for product_ids in code_products.values() if len(product_ids) > 1)


async def ensure_product_identification(stock, company_id, stock_collection=None):
    identities = base_db.product_identifications
    if stock_collection is None:
        stock_collection = db.stock
    identity = await identities.find_one(
        {"company_id": company_id, "stock_id": stock["id"]}, {"_id": 0}
    )
    if identity:
        product_id = identity["product_id"]
        stock_product_id = stock.get("product_id")
        if stock_product_id and stock_product_id != product_id:
            raise HTTPException(409, "Stock and product catalog identifiers disagree; manual review is required")
        if not stock_product_id:
            await stock_collection.update_one({"id": stock["id"]}, {"$set": {"product_id": product_id}})
            stock["product_id"] = product_id
        return identity

    product_id = stock.get("product_id") or f"IQF-{new_id().upper()}"
    payload = product_code_payload(product_id)
    identity = {
        "id": new_id(), "company_id": company_id, "stock_id": stock["id"],
        "product_id": product_id, "sku": product_sku(company_id, product_id),
        "qr_payload": payload, "data_matrix_payload": payload,
        "description": "", "density": None, "product_type": "", "tracking_mode": "none",
        "active": True, "created_at": now_iso(), "updated_at": now_iso(),
    }
    try:
        await identities.insert_one(identity)
    except DuplicateKeyError:
        identity = await identities.find_one(
            {"company_id": company_id, "stock_id": stock["id"]}, {"_id": 0}
        )
        if not identity:
            raise HTTPException(409, "Product identifier collision; retry the operation")
        product_id = identity["product_id"]
    await stock_collection.update_one({"id": stock["id"]}, {"$set": {"product_id": product_id}})
    stock["product_id"] = product_id
    return identity


async def product_stock_for_identity(identity):
    stock = await db.stock.find_one({"id": identity["stock_id"]}, {"_id": 0})
    if not stock:
        raise HTTPException(404, "The linked stock product no longer exists")
    return stock


async def resolve_product_scan(code, user):
    original_code = code.strip()
    normalized_code = original_code.upper()
    if not normalized_code:
        raise HTTPException(400, "Scan a product code")
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    identity = await base_db.product_identifications.find_one({
        "company_id": company_id,
        "$or": [
            {"ean13": normalized_code},
            {"qr_payload": normalized_code},
            {"data_matrix_payload": original_code},
            {"data_matrix_payload": normalized_code},
            {"product_id": normalized_code},
            {"sku": normalized_code},
        ],
    }, {"_id": 0})
    if not identity:
        raise HTTPException(404, "Unknown product code for this company")
    if identity.get("active") is False:
        raise HTTPException(410, "This product is inactive")
    stock = await product_stock_for_identity(identity)
    await stock_current(stock)
    return stock, identity


@api.get("/products")
async def list_products(
    q: str = Query(default="", max_length=128),
    category: Optional[str] = Query(default=None, max_length=120),
    density: Optional[str] = Query(default=None, max_length=100),
    active: Optional[bool] = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    user=Depends(get_current_user),
):
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    identity_filter = {"company_id": company_id}
    if density:
        identity_filter["density"] = {"$regex": re.escape(density.strip()), "$options": "i"}
    if active is not None:
        identity_filter["active"] = active

    identities = await base_db.product_identifications.find(
        identity_filter, {"_id": 0}
    ).to_list(50000)
    if q.strip():
        term = re.compile(re.escape(q.strip()), re.IGNORECASE)
        code_matches = await base_db.product_identifications.find(
            {
                **identity_filter,
                "$or": [
                    {"product_id": term}, {"sku": term}, {"ean13": term},
                    {"qr_payload": term}, {"data_matrix_payload": term},
                ],
            },
            {"_id": 0},
        ).to_list(50000)
        stock_matches = await db.stock.find(
            {"$or": [{"product": term}, {"size": term}, {"product_id": term}]},
            {"_id": 0},
        ).to_list(50000)
        matched_stock_ids = {item["stock_id"] for item in code_matches}
        matched_stock_ids.update(item["id"] for item in stock_matches)
        identities = [item for item in identities if item["stock_id"] in matched_stock_ids]

    if not identities:
        return {"items": [], "total": 0, "page": page, "page_size": page_size, "pages": 0}

    identity_by_stock = {item["stock_id"]: item for item in identities}
    stocks = await db.stock.find(
        {"id": {"$in": list(identity_by_stock)}}, {"_id": 0}
    ).to_list(50000)
    products = [
        public_product_identification(stock, identity_by_stock[stock["id"]])
        for stock in stocks if stock["id"] in identity_by_stock
    ]
    if category:
        category_term = category.strip().casefold()
        products = [item for item in products if category_term in item["category"].casefold()]
    products.sort(key=lambda item: (
        item["product"].casefold(), item["dimensions"].casefold(), item["product_id"]
    ))
    total = len(products)
    start = (page - 1) * page_size
    return {
        "items": products[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": math.ceil(total / page_size),
    }


@api.get("/stock/{sid}/identification")
async def get_stock_product_identification(sid: str, user=Depends(get_current_user)):
    stock = await db.stock.find_one({"id": sid}, {"_id": 0})
    if not stock:
        raise HTTPException(404, "Stock item not found")
    identity = await ensure_product_identification(stock, user.get("_active_company_id") or DEFAULT_COMPANY_ID)
    return public_product_identification(stock, identity)


@api.put("/stock/{sid}/product-details")
async def update_stock_product_details(sid: str, body: ProductStockDetailsIn, user=Depends(get_current_user)):
    require_admin(user)
    stock = await db.stock.find_one({"id": sid}, {"_id": 0})
    if not stock:
        raise HTTPException(404, "Stock item not found")
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    identity = await base_db.product_identifications.find_one(
        {"company_id": company_id, "stock_id": sid}, {"_id": 0}
    )
    if not identity:
        raise HTTPException(409, "Product identification is unavailable for this stock item")
    before = {"product": stock.get("product", ""), "size": stock.get("size", "")}
    after = {"product": body.product, "size": body.dimensions}
    if before != after:
        result = await db.stock.update_one(
            {"id": sid},
            {"$set": {"product": body.product, "size": body.dimensions, "updated_at": now_iso()}},
        )
        if result.matched_count != 1:
            raise HTTPException(409, "Stock item changed during the update; reload and retry")
        await log_audit("stock", sid, "product_details_updated", user, before=before, after=after)
    updated_stock = await db.stock.find_one({"id": sid}, {"_id": 0})
    if not updated_stock:
        raise HTTPException(404, "Stock item not found")
    return public_product_identification(updated_stock, identity)


@api.put("/stock/{sid}/identification")
async def update_stock_product_identification(sid: str, body: ProductIdentificationIn, user=Depends(get_current_user)):
    stock = await db.stock.find_one({"id": sid}, {"_id": 0})
    if not stock:
        raise HTTPException(404, "Stock item not found")
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    identity = await ensure_product_identification(stock, company_id)
    updates = body.model_dump(exclude_unset=True)
    unset_updates = {}
    if "ean13" in updates:
        ean13 = updates.pop("ean13")
        if ean13 is None:
            updates.pop("gs1_allocated", None)
            unset_updates.update({"ean13": "", "gs1_allocated": ""})
        else:
            if not body.gs1_allocated:
                raise HTTPException(400, "Confirm that this EAN-13 was allocated to your company by GS1")
            duplicate = await base_db.product_identifications.find_one(
                {"ean13": ean13, "id": {"$ne": identity["id"]}}, {"_id": 0, "company_id": 1}
            )
            if duplicate:
                raise HTTPException(409, "This EAN-13 is already assigned to another product")
            updates["ean13"] = ean13
            updates["gs1_allocated"] = True
    elif identity.get("ean13") and updates.get("gs1_allocated", True) is not True:
        raise HTTPException(400, "Remove the EAN-13 before clearing its GS1 allocation confirmation")
    elif "gs1_allocated" in updates and "ean13" not in identity:
        updates.pop("gs1_allocated")
    for field in ("sku", "data_matrix_payload"):
        if field in updates and updates[field] is None:
            updates.pop(field)
            unset_updates[field] = ""
    if updates.get("sku"):
        duplicate = await base_db.product_identifications.find_one(
            {"sku": updates["sku"], "id": {"$ne": identity["id"]}},
            {"_id": 0, "company_id": 1},
        )
        if duplicate:
            raise HTTPException(409, "This SKU is already assigned to another product")
    if updates.get("data_matrix_payload"):
        duplicate = await base_db.product_identifications.find_one(
            {"data_matrix_payload": updates["data_matrix_payload"], "id": {"$ne": identity["id"]}},
            {"_id": 0, "company_id": 1},
        )
        if duplicate:
            raise HTTPException(409, "This Data Matrix payload is already assigned to another product")
    updates["updated_at"] = now_iso()
    try:
        change = {"$set": updates}
        if unset_updates:
            change["$unset"] = unset_updates
        result = await base_db.product_identifications.update_one(
            {"id": identity["id"], "company_id": company_id}, change
        )
    except DuplicateKeyError:
        raise HTTPException(409, "This identification code is already assigned to another product")
    if result.matched_count != 1:
        raise HTTPException(409, "Product identification changed during the update; reload and retry")
    updated = await base_db.product_identifications.find_one({"id": identity["id"]}, {"_id": 0})
    if not updated:
        raise HTTPException(409, "Product identification no longer exists")
    await log_audit("product_identification", identity["id"], "updated", user,
                    before=identity, after=updated)
    return public_product_identification(stock, updated)


@api.post("/products/scan")
async def scan_product(body: ProductScanIn, user=Depends(get_current_user)):
    stock, identity = await resolve_product_scan(body.code, user)
    scan_id = body.scan_id or new_id()
    try:
        normalized_code = body.code.strip()
        if identity.get("ean13") == normalized_code:
            code_type = "ean13"
        elif identity.get("qr_payload") == normalized_code:
            code_type = "qr"
        elif identity.get("data_matrix_payload") == normalized_code:
            code_type = "data_matrix"
        elif identity.get("sku") == normalized_code.upper():
            code_type = "sku"
        else:
            code_type = "internal"
        await base_db.product_scans.insert_one({
            "scan_id": scan_id, "company_id": identity["company_id"],
            "product_id": identity["product_id"], "stock_id": stock["id"],
            "code_type": code_type,
            "user_id": user["id"], "scanned_at": now_iso(),
        })
    except DuplicateKeyError:
        pass
    return {
        **public_product_identification(stock, identity),
        "current_stock": stock.get("current", 0),
        "threshold": stock.get("threshold", 0),
        "unit": "units",
    }


@api.get("/product-identification-stats")
async def get_product_identification_stats(user=Depends(get_current_user)):
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    stocks = await listall("stock", sort=("product", 1))
    identities = await base_db.product_identifications.find(
        {"company_id": company_id}, {"_id": 0}
    ).to_list(5000)
    identity_by_stock = {item["stock_id"]: item for item in identities}
    recent_scans = await base_db.product_scans.find(
        {"company_id": company_id}, {"_id": 0}
    ).sort("scanned_at", -1).to_list(20)
    scan_totals = await base_db.product_scans.aggregate([
        {"$match": {"company_id": company_id}},
        {"$group": {"_id": "$product_id", "scan_count": {"$sum": 1}}},
        {"$sort": {"scan_count": -1, "_id": 1}},
        {"$limit": 10},
    ]).to_list(10)
    invalid_ean = sum(
        1 for item in identities if item.get("ean13") and not valid_ean13(item["ean13"])
    )
    product_by_id = {
        identity["product_id"]: next(
            (stock["product"] for stock in stocks if stock["id"] == identity["stock_id"]), ""
        )
        for identity in identities
    }
    return {
        "identified_products": sum(
            1 for stock in stocks if stock["id"] in identity_by_stock
            and identity_by_stock[stock["id"]].get("active") is not False
        ),
        "products_missing_ean13": sum(
            1 for stock in stocks if stock["id"] not in identity_by_stock
            or not identity_by_stock[stock["id"]].get("ean13")
        ),
        "invalid_ean13": invalid_ean,
        "duplicate_codes": duplicate_product_identification_codes(identities),
        "scans_total": await base_db.product_scans.count_documents({"company_id": company_id}),
        "most_scanned": [
            {"product_id": item["_id"], "scan_count": item["scan_count"],
             "product": product_by_id.get(item["_id"], "")}
            for item in scan_totals
        ],
        "recent_scans": recent_scans,
        "inactive_products": sum(1 for item in identities if item.get("active") is False),
    }

INC_TYPES = ("production", "purchase", "adjustment_in", "return")
DEC_TYPES = ("dispatch", "invoice", "production_consumption", "adjustment_out", "damage")
OPEN_ORDER_STATUSES = ("To Send", "Preparing", "Assigned", "Partially Delivered")
INCOMPLETE_ORDER_STATUSES = (*OPEN_ORDER_STATUSES, "Dispatched")
ACTIVE_DELIVERY_STATUSES = ("Planned", "Assigned", "Ready", "Dispatched", "Partially Delivered")
MAINTENANCE_STATUSES = ("Needed", "Scheduled", "In Progress", "needed", "scheduled", "in progress")
MAINTENANCE_TYPES = ("repair", "maintenance")

def vehicle_operational_filters():
    return {
        "orders": {
            "status": {"$in": INCOMPLETE_ORDER_STATUSES},
            "vehicle_id": {"$exists": True, "$nin": ["", None]},
            "archived": {"$ne": True},
        },
        "deliveries": {
            "status": {"$in": ACTIVE_DELIVERY_STATUSES},
            "vehicle_id": {"$exists": True, "$nin": ["", None]},
            "archived": {"$ne": True},
        },
        "maintenance": {
            "status": {"$in": MAINTENANCE_STATUSES},
            "type": {"$in": MAINTENANCE_TYPES},
            "vehicle_id": {"$exists": True, "$nin": ["", None]},
            "archived": {"$ne": True},
        },
    }

def vehicle_is_free(vehicle, unavailable_vehicle_ids=()):
    return (
        vehicle.get("vtype") != "Trailer"
        and bool(vehicle.get("available"))
        and not vehicle.get("assigned_driver_id")
        and vehicle.get("id") not in unavailable_vehicle_ids
    )

def mov_sign(m):
    if m.get("direction") in (1, -1):
        return m["direction"]
    return 1 if m["type"] in INC_TYPES else -1

async def stock_current(s, session=None):
    movs = await listall("stock_movements", {"stock_id": s["id"]}, session=session)
    return apply_stock_movements(s, movs)


async def stock_movement_totals_by_stock_id(stock_ids):
    if not stock_ids:
        return {}
    totals = {stock_id: Decimal("0") for stock_id in stock_ids}
    cursor = db.stock_movements.find(
        {"stock_id": {"$in": list(totals)}},
        {"_id": 0, "stock_id": 1, "type": 1, "quantity": 1, "direction": 1},
    )
    async for movement in cursor:
        stock_id = movement.get("stock_id")
        if stock_id in totals:
            totals[stock_id] += D(movement.get("quantity", 0)) * mov_sign(movement)
    return totals


async def stock_movements_for_stock_ids(stock_ids):
    if not stock_ids:
        return {}
    cursor = db.stock_movements.find(
        {"stock_id": {"$in": stock_ids}},
        {"_id": 0, "stock_id": 1, "type": 1, "quantity": 1, "direction": 1, "created_at": 1},
    )
    grouped = {stock_id: [] for stock_id in stock_ids}
    async for movement in cursor:
        stock_id = movement.get("stock_id")
        if stock_id in grouped and len(grouped[stock_id]) < 5000:
            grouped[stock_id].append(movement)
    return grouped


def apply_stock_movements(stock, movements):
    s = stock
    movs = movements
    s["current"] = r2(D(s.get("opening", 0)) + sum((D(m["quantity"]) * mov_sign(m) for m in movs), Decimal("0")))
    s["production_received"] = dsum(m["quantity"] for m in movs if m["type"] == "production")
    s["purchased"] = dsum(m["quantity"] for m in movs if m["type"] == "purchase")
    s["production_used"] = dsum(m["quantity"] for m in movs if m["type"] == "production_consumption")
    s["dispatched"] = dsum(m["quantity"] for m in movs if m["type"] == "dispatch")
    s["invoiced"] = dsum(D(m["quantity"]) * -mov_sign(m) for m in movs if m["type"] == "invoice")
    s["adjustments"] = r2(sum((D(m["quantity"]) * mov_sign(m) for m in movs if m["type"] not in ("production", "purchase", "production_consumption", "dispatch", "invoice")), Decimal("0")))
    s["last_movement"] = max([m["created_at"] for m in movs], default=None)
    return s

STOCK_COST_FIELDS = {
    "unit_cost", "purchase_cost", "cost_status", "total_cost", "cost_per_unit",
    "material_cost", "stock_value",
}


def redact_stock_costs(value):
    if isinstance(value, dict):
        return {
            key: redact_stock_costs(item)
            for key, item in value.items()
            if key not in STOCK_COST_FIELDS
        }
    if isinstance(value, list):
        return [redact_stock_costs(item) for item in value]
    return value


def stock_for_user(stock, user):
    if not can_view_stock_costs(user):
        return redact_stock_costs(stock)
    return stock

async def post_movement(stock, mtype, qty, user, reason="", reference="", notes="", dedupe_key=None, direction=None, allow_negative=False, extra=None, session=None):
    sign = direction or (1 if mtype in INC_TYPES else -1)
    if sign < 0 and not allow_negative:
        if session is None:
            await stock_current(stock)
        else:
            await stock_current(stock, session=session)
        if D(qty) > D(stock["current"]):
            raise HTTPException(400, f"Insufficient stock for {stock['product']} {stock['size']}: available {stock['current']}, requested {qty}")
    m = {"stock_id": stock["id"], "product_id": stock.get("product_id"),
         "product": stock["product"], "size": stock["size"], "type": mtype,
         "direction": sign, "quantity": r2(qty), "reason": reason, "reference": reference, "notes": notes,
         "date": today_str(), "user": user["email"] if user else "system", **(extra or {})}
    if dedupe_key:
        m["dedupe_key"] = dedupe_key
    session_options = {"session": session} if session is not None else {}
    record = await insert("stock_movements", m, **session_options)
    if session is None and active_mongo_session.get() is None:
        await emit_workflow_event("stock.movement_recorded", record)
    return record

def allocate_fifo_batches(stock_id, opening_quantity, movements, requested_quantity):
    batches = []
    deficit = Decimal("0")
    opening = D(opening_quantity)
    if opening > 0:
        batches.append({
            "batch_id": f"opening:{stock_id}", "remaining": opening,
            "unit_cost": None, "cost_status": "unavailable",
            "source_type": "opening_stock",
        })

    ordered = sorted(
        movements,
        key=lambda movement: (str(movement.get("created_at") or movement.get("date") or ""), str(movement.get("id") or "")),
    )

    def consume(quantity, batch_id=None, source_allocations=None):
        nonlocal deficit
        remaining = D(quantity)
        if source_allocations is not None:
            for allocation in source_allocations:
                allocation_quantity = D(allocation.get("quantity", 0))
                if allocation_quantity <= 0:
                    continue
                wanted = min(remaining, allocation_quantity)
                if wanted <= 0:
                    break
                for batch in batches:
                    if batch["batch_id"] == allocation.get("batch_id"):
                        take = min(wanted, batch["remaining"])
                        batch["remaining"] -= take
                        wanted -= take
                        remaining -= take
                        if wanted <= 0:
                            break
        for batch in batches:
            if remaining <= 0:
                break
            if batch_id and batch["batch_id"] != batch_id:
                continue
            take = min(remaining, batch["remaining"])
            batch["remaining"] -= take
            remaining -= take
        if remaining > 0:
            deficit += remaining
        batches[:] = [batch for batch in batches if batch["remaining"] > 0]

    for movement in ordered:
        quantity = D(movement.get("quantity", 0))
        if quantity <= 0:
            continue
        sign = mov_sign(movement)
        allocations = movement.get("batch_allocations")
        if sign < 0:
            consume(quantity, source_allocations=allocations if isinstance(allocations, list) else None)
            continue

        if isinstance(allocations, list) and allocations:
            incoming = [
                {
                    "batch_id": allocation.get("batch_id") or f"return:{movement.get('id')}",
                    "remaining": D(allocation.get("quantity", 0)),
                    "unit_cost": allocation.get("unit_cost"),
                    "cost_status": allocation.get("cost_status", "unavailable"),
                    "source_type": allocation.get("source_type") or movement.get("type", ""),
                    "source_date": allocation.get("source_date") or movement.get("date"),
                    "grv_id": allocation.get("grv_id"),
                    "production_id": allocation.get("production_id"),
                }
                for allocation in allocations
                if D(allocation.get("quantity", 0)) > 0
            ]
        else:
            historical_cost = movement.get("unit_cost")
            verified = (
                historical_cost is not None
                and movement.get("historical_cost_status") != "unavailable"
                and (movement.get("historical_cost_status") == "verified"
                     or (movement.get("type") == "purchase" and D(historical_cost) > 0))
            )
            incoming = [{
                "batch_id": movement.get("batch_id") or movement.get("id") or f"movement:{len(batches)}",
                "remaining": quantity,
                "unit_cost": r2(historical_cost) if verified else None,
                "cost_status": "verified" if verified else "unavailable",
                "source_type": movement.get("type", ""),
                "source_date": movement.get("batch_date") or movement.get("date"),
                "grv_id": movement.get("grv_id"),
                "production_id": movement.get("production_id"),
            }]
        for batch in incoming:
            if deficit > 0:
                offset = min(deficit, batch["remaining"])
                deficit -= offset
                batch["remaining"] -= offset
            if batch["remaining"] > 0:
                batches.append(batch)

    remaining = D(requested_quantity)
    allocations = []
    for batch in batches:
        if remaining <= 0:
            break
        quantity = min(remaining, batch["remaining"])
        if quantity <= 0:
            continue
        allocations.append({
            "batch_id": batch["batch_id"],
            "quantity": float(quantity),
            "unit_cost": batch["unit_cost"],
            "cost_status": batch["cost_status"],
            "source_type": batch["source_type"],
            "source_date": batch.get("source_date"),
            "grv_id": batch.get("grv_id"),
            "production_id": batch.get("production_id"),
        })
        remaining -= quantity
    if remaining > 0:
        allocations.append({
            "batch_id": f"unallocated:{stock_id}",
            "quantity": float(remaining),
            "unit_cost": None,
            "cost_status": "unavailable",
            "source_type": "stock_shortage",
        })
    return allocations

async def invoice_return_batch_allocations(invoice_id, stock_id, quantity):
    movements = await listall("stock_movements", {
        "invoice_id": invoice_id, "stock_id": stock_id, "type": "invoice",
    })
    consumed = {}
    metadata = {}
    for movement in sorted(movements, key=lambda item: (str(item.get("created_at") or ""), str(item.get("id") or ""))):
        allocations = movement.get("batch_allocations")
        if not isinstance(allocations, list):
            continue
        sign = -mov_sign(movement)
        for allocation in allocations:
            batch_id = allocation.get("batch_id") or f"unavailable:{stock_id}"
            consumed[batch_id] = max(
                Decimal("0"),
                D(consumed.get(batch_id, 0)) + D(allocation.get("quantity", 0)) * sign,
            )
            metadata[batch_id] = allocation

    remaining = D(quantity)
    result = []
    for batch_id, used in reversed(list(consumed.items())):
        take = min(remaining, used)
        if take <= 0:
            continue
        original = metadata[batch_id]
        result.append({
            "batch_id": batch_id, "quantity": float(take),
            "unit_cost": original.get("unit_cost"),
            "cost_status": original.get("cost_status", "unavailable"),
            "source_type": original.get("source_type", ""),
            "source_date": original.get("source_date"),
            "grv_id": original.get("grv_id"),
            "production_id": original.get("production_id"),
        })
        remaining -= take
    if remaining > 0:
        result.append({
            "batch_id": f"unallocated:{stock_id}", "quantity": float(remaining),
            "unit_cost": None, "cost_status": "unavailable",
            "source_type": "unallocated_invoice_return",
        })
    return result

def invoice_stock_product(item):
    category = (item.get("category") or "").strip()
    if category.casefold() in ("standard", "simple/mix color"):
        return "Simple"
    if category.casefold() == "candy":
        return "Candy"
    return price_category(1, category)

def invoice_stock_product_aliases(item):
    category = (item.get("category") or "").strip()
    canonical = invoice_stock_product(item)
    if canonical == "Ribbon Black":
        return ("Ribbon Black", "Ribbon Balck", "Black", "Black fabric", "Fabric Black", "Ribbon Black Fabric")
    if canonical == "Ribbon Pink":
        return ("Ribbon Pink", "Ribbon")
    return tuple(dict.fromkeys((canonical, category)))


def invoice_stock_text_key(value):
    return " ".join(str(value or "").split()).casefold()


def invoice_stock_size_key(value):
    return invoice_stock_text_key(canonical_price_size(value))


async def invoice_stock_deductions(invoice, allow_empty=False):
    stock_items = await listall("stock")
    stock_by_product_size = {
        (
            invoice_stock_text_key(item.get("product")),
            invoice_stock_size_key(item.get("size")),
        ): item
        for item in stock_items
    }
    quantities = {}
    for index, item in enumerate(invoice.get("items", []), 1):
        products = invoice_stock_product_aliases(item)
        size = (item.get("size") or "").strip()
        if not products[0] or not size:
            continue
        normalized_size = invoice_stock_size_key(size)
        stock = next(
            (
                stock_by_product_size.get((invoice_stock_text_key(product), normalized_size))
                for product in products
                if stock_by_product_size.get((invoice_stock_text_key(product), normalized_size))
            ),
            None,
        )
        if not stock:
            raise HTTPException(400, f"Stock item not found for invoice line {index}: {products[0]} {size}")
        quantity = D(item.get("qty", 0))
        if quantity <= 0:
            raise HTTPException(400, f"Invoice line {index} quantity must be greater than 0")
        entry = quantities.setdefault(stock["id"], {"stock_id": stock["id"], "product": stock["product"],
                                                     "size": stock["size"], "quantity": Decimal("0")})
        entry["quantity"] += quantity
    if not quantities and not allow_empty:
        raise HTTPException(400, "No invoice products match stock items to deduct")
    return list(quantities.values())

async def validate_invoice_stock(deductions, allow_negative_stock=False):
    shortages = []
    for item in deductions:
        stock = await db.stock.find_one({"id": item["stock_id"]}, {"_id": 0})
        if not stock:
            raise HTTPException(409, f"Stock item no longer exists: {item['product']} {item['size']}")
        await stock_current(stock)
        if item["quantity"] > D(stock["current"]):
            shortages.append({
                "product": item["product"],
                "size": item["size"],
                "available": float(stock["current"]),
                "requested": float(item["quantity"]),
                "stock_after": float(D(stock["current"]) - item["quantity"]),
            })
        item["stock"] = stock
    if shortages and not allow_negative_stock:
        raise HTTPException(409, {
            "code": "INSUFFICIENT_STOCK",
            "items": shortages,
        })

async def post_invoice_stock_deductions(invoice, deductions, user):
    for item in deductions:
        key = f"invoice:{invoice['id']}:{item['stock_id']}"
        movement = await db.stock_movements.find_one({"dedupe_key": key}, {"_id": 0})
        if movement:
            continue
        movement = await post_movement(
            item["stock"], "invoice", item["quantity"], user,
            reason=f"Invoice {invoice['number']}", reference=invoice["number"],
            dedupe_key=key,
            allow_negative=True,
            extra={
                "invoice_id": invoice["id"], "invoice_number": invoice["number"],
                "batch_allocations": allocate_fifo_batches(
                    item["stock_id"], item["stock"].get("opening", 0),
                    await listall("stock_movements", {"stock_id": item["stock_id"]}),
                    item["quantity"],
                ),
            },
        )
        await log_audit("stock_movement", movement["id"], "posted", user, after=movement)

async def invoice_stock_changes(invoice):
    movements = await listall("stock_movements", {"invoice_id": invoice["id"], "type": "invoice"})
    desired = {
        item["stock_id"]: item["quantity"]
        for item in await invoice_stock_deductions(invoice, allow_empty=bool(movements))
    }
    previous = {}
    for movement in movements:
        stock_id = movement["stock_id"]
        previous[stock_id] = previous.get(stock_id, Decimal("0")) - D(movement["quantity"]) * mov_sign(movement)
    changes = {}
    for stock_id in previous.keys() | desired.keys():
        delta = desired.get(stock_id, Decimal("0")) - max(previous.get(stock_id, Decimal("0")), Decimal("0"))
        if delta:
            changes[stock_id] = delta
    return changes

async def validate_invoice_stock_changes(changes, allow_negative_stock=False):
    stocks = {}
    shortages = []
    for stock_id, delta in changes.items():
        stock = await db.stock.find_one({"id": stock_id}, {"_id": 0})
        if not stock:
            raise HTTPException(409, f"Stock item {stock_id} no longer exists")
        if delta > 0:
            await stock_current(stock)
            if delta > D(stock["current"]):
                shortages.append({
                    "product": stock["product"],
                    "size": stock["size"],
                    "available": float(stock["current"]),
                    "requested": float(delta),
                    "stock_after": float(D(stock["current"]) - delta),
                })
        stocks[stock_id] = stock
    if shortages and not allow_negative_stock:
        raise HTTPException(409, {
            "code": "INSUFFICIENT_STOCK",
            "items": shortages,
        })
    return stocks

async def post_invoice_stock_changes(invoice, changes, stocks, user):
    for stock_id, delta in changes.items():
        if delta == 0:
            continue
        stock = stocks[stock_id]
        movement = await post_movement(
            stock, "invoice", abs(delta), user,
            reason=f"Stock reconciled for edited invoice {invoice.get('number') or invoice['id']}",
            reference=invoice.get("number") or invoice["id"],
            direction=-1 if delta > 0 else 1,
            allow_negative=True,
            dedupe_key=f"invoice-edit:{invoice['id']}:{new_id()}:{stock_id}",
            extra={
                "invoice_id": invoice["id"], "invoice_number": invoice.get("number", ""),
                "invoice_edit": True,
                "batch_allocations": (
                    allocate_fifo_batches(
                        stock_id, stock.get("opening", 0),
                        await listall("stock_movements", {"stock_id": stock_id}),
                        delta,
                    ) if delta > 0 else
                    await invoice_return_batch_allocations(invoice["id"], stock_id, abs(delta))
                ),
            },
        )
        await log_audit("stock_movement", movement["id"], "posted", user, after=movement)

@api.get("/stock")
async def get_stock(user=Depends(get_current_user)):
    items = await listall("stock", sort=("product", 1))
    movements_by_stock = await stock_movements_for_stock_ids([item["id"] for item in items])
    for s in items:
        apply_stock_movements(s, movements_by_stock.get(s["id"], []))
    return [stock_for_user(item, user) for item in items]


@api.post("/stock")
async def add_stock(body: StockIn, user=Depends(get_current_user)):
    data = body.model_dump()
    selling_price = data.pop("selling_price", None)
    zone = data.pop("zone", 1)
    category = (data.pop("category", None) or "").strip()
    if category:
        data["product"] = category
    data["product"] = data["product"].strip()
    data["size"] = data["size"].strip()
    if not data["product"] or not data["size"]:
        raise HTTPException(400, "Product and size are required")
    if not can_view_stock_costs(user):
        data.pop("unit_cost", None)
    for item in await listall("stock"):
        if (str(item.get("product", "")).strip().casefold() == data["product"].casefold()
                and str(item.get("size", "")).strip().casefold() == data["size"].casefold()):
            raise HTTPException(400, "This product and size already exist in stock")
    unified = uses_unified_price_list(active_company_id.get())
    category, price_zone, existing_price = None, None, None
    if selling_price is not None:
        category = data["product"]
        if category == "Simple" and not unified:
            category = "Standard"
        elif category == "Candy":
            category = "Ribbon Black"
        price_zone = 1 if unified else zone
        existing_price = await db.prices.find_one(
            {"zone": price_zone, "category": category, "size": data["size"]}, {"_id": 0})
    stock = await insert("stock", data)
    if selling_price is not None:
        try:
            if existing_price:
                rec = await update_doc("prices", existing_price["id"], {
                    "price": selling_price, "confirmed": True, "active": True,
                    "archived": False, "archived_at": None, "archived_by": None})
                await log_audit("price", existing_price["id"], "updated", user, before=existing_price, after=rec)
            else:
                rec = await insert("prices", {
                    "zone": price_zone, "category": category, "size": data["size"],
                    "price": selling_price, "active": True, "confirmed": True,
                    "archived": False, "archived_at": None, "archived_by": None,
                    "updated_at": now_iso()})
                await log_audit("price", rec["id"], "created", user, after=rec)
        except Exception:
            await db.stock.delete_one({"id": stock["id"]})
            raise
    await ensure_product_identification(stock, user.get("_active_company_id") or DEFAULT_COMPANY_ID)
    return stock_for_user(stock, user)

@api.delete("/stock/{sid}")
async def delete_stock(sid: str, user=Depends(get_current_user)):
    stock = await db.stock.find_one({"id": sid}, {"_id": 0})
    if not stock:
        raise HTTPException(404, "Stock item not found")
    movements = await listall("stock_movements", {"stock_id": sid})
    movement_ids = [movement["id"] for movement in movements if movement.get("id")]
    await db.stock_movements.delete_many({"stock_id": sid})
    if movement_ids:
        await db.audit_log.delete_many({
            "entity": "stock_movement",
            "entity_id": {"$in": movement_ids},
        })
    await db.audit_log.delete_many({"entity": "stock", "entity_id": sid})
    result = await db.stock.delete_one({"id": sid})
    if not result.deleted_count:
        raise HTTPException(404, "Stock item not found")
    await base_db.product_identifications.update_one(
        {"company_id": user.get("_active_company_id") or DEFAULT_COMPANY_ID, "stock_id": sid},
        {"$set": {"active": False, "updated_at": now_iso()}},
    )
    await log_audit("stock", sid, "permanently_deleted", user,
                    before={"product": stock["product"], "size": stock["size"],
                            "movement_count": len(movements)},
                    after={"permanently_deleted": True})
    return {"ok": True, "deleted": True, "movements_deleted": len(movements)}

@api.put("/stock/{sid}")
async def edit_stock(sid: str, body: StockIn, user=Depends(get_current_user)):
    before = await db.stock.find_one({"id": sid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Stock item not found")
    d = body.model_dump()
    d.pop("category", None)
    d["product"] = d["product"].strip()
    d["size"] = d["size"].strip()
    if not d["product"] or not d["size"]:
        raise HTTPException(400, "Product and size are required")
    clash = await db.stock.find_one({
        "id": {"$ne": sid},
        "product": {"$regex": f"^\\s*{re.escape(d['product'])}\\s*$", "$options": "i"},
        "size": {"$regex": f"^\\s*{re.escape(d['size'])}\\s*$", "$options": "i"},
    }, {"_id": 0})
    if clash and clash.get("id") != sid:
        raise HTTPException(400, "This product and size already exist in stock")
    if not can_view_stock_costs(user):
        d.pop("unit_cost", None)
    if r2(d["opening"]) != r2(before.get("opening", 0)) and await db.stock_movements.count_documents({"stock_id": sid}):
        raise HTTPException(400, "Opening balance cannot change after movements exist. Use a manual adjustment instead")
    rec = await update_doc("stock", sid, d)
    await log_audit("stock", sid, "edited", user, before=before, after=rec)
    return stock_for_user(rec, user)

class MovementIn(BaseModel):
    type: str  # adjustment_in, adjustment_out, return, damage
    quantity: float
    reason: Optional[str] = ""
    reference: Optional[str] = ""
    notes: Optional[str] = ""

@api.post("/stock/{sid}/movements")
async def add_movement(sid: str, body: MovementIn, user=Depends(get_current_user)):
    s = await db.stock.find_one({"id": sid}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Stock item not found")
    if body.type not in ("adjustment_in", "adjustment_out", "return", "damage"):
        raise HTTPException(400, "Production receipts come from Production and dispatches from Deliveries")
    if body.quantity < 0:
        raise HTTPException(400, "Quantity cannot be negative")
    async with StockLock([sid]):
        m = await post_movement(s, body.type, body.quantity, user, body.reason or "", body.reference, body.notes)
    await log_audit("stock_movement", m["id"], "posted", user, after=m, reason=body.reason or "")
    return m

@api.post("/stock/movements/{mid}/reverse")
async def reverse_movement(mid: str, body: ReasonIn, user=Depends(get_current_user)):
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required to reverse a movement")
    orig = await db.stock_movements.find_one({"id": mid}, {"_id": 0})
    if not orig:
        raise HTTPException(404, "Movement not found")
    if orig.get("type") not in ("adjustment_in", "adjustment_out", "return", "damage"):
        raise HTTPException(400, "Only manual movements can be reversed here. Dispatches and production receipts are corrected with a Return or Adjustment")
    claimed = await db.stock_movements.find_one_and_update({"id": mid, "reversed": {"$ne": True}}, {"$set": {"reversed": True}})
    if not claimed:
        raise HTTPException(400, "Movement already reversed")
    s = await db.stock.find_one({"id": orig["stock_id"]}, {"_id": 0})
    try:
        async with StockLock([s["id"]]):
            rev = await post_movement(s, "reversal", orig["quantity"], user, body.reason, orig.get("reference", ""),
                                      direction=-mov_sign(orig), dedupe_key=f"reversal:{mid}", extra={"reverses": mid})
    except HTTPException:
        await db.stock_movements.update_one({"id": mid}, {"$unset": {"reversed": ""}})
        raise
    await log_audit("stock_movement", mid, "reversed", user, reason=body.reason, after=rev)
    return rev

@api.get("/stock/movements")
async def get_movements(user=Depends(get_current_user)):
    movements = await listall("stock_movements", sort=("created_at", -1))
    return movements if can_view_stock_costs(user) else redact_stock_costs(movements)

# ---------------- Production ----------------
PROD_STATUSES = ["Planned", "In Production", "Resting", "Ready for Cutting", "Completed", "Cancelled"]

class ProductionIn(BaseModel):
    block_ref: str
    product: Optional[str] = ""
    size: Optional[str] = ""
    quantity: float = 1
    production_date: str = Field(default_factory=today_str)
    production_time: Optional[str] = None  # ISO datetime local
    team: Optional[str] = ""
    weather: Optional[str] = ""  # Suitable, Caution, Unsuitable
    rain_risk: bool = False
    cold_risk: bool = False
    override_reason: Optional[str] = ""
    status: str = "Planned"
    planned_cutting: Optional[str] = None
    notes: Optional[str] = ""

    @field_validator("block_ref")
    @classmethod
    def block_ref_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Block reference is required")
        return value

    @field_validator("quantity")
    @classmethod
    def production_quantity_positive(cls, value):
        if value <= 0:
            raise ValueError("Quantity must be greater than 0")
        return value

async def resting_hours():
    s = await db.settings.find_one({"id": "singleton"}) or {}
    return float(s.get("resting_hours", 12) or 12)

def enrich_production(p, hours):
    start = parse_dt(p.get("production_time"))
    p["ready_at"] = (start + timedelta(hours=hours)).isoformat() if start else None
    p["rest_elapsed"] = bool(start and datetime.now(TZ) >= start + timedelta(hours=hours))
    return p

async def check_production_rules(d, existing, hours):
    if d["status"] not in PROD_STATUSES:
        raise HTTPException(400, f"Invalid status. Use one of: {', '.join(PROD_STATUSES)}")
    if d["status"] in ("In Production", "Resting", "Ready for Cutting", "Completed"):
        if not d.get("weather"):
            raise HTTPException(400, "Record a manual weather assessment (Suitable / Caution / Unsuitable) before production starts")
        risky = d["weather"] == "Unsuitable" or d.get("rain_risk")
        if risky and not (d.get("override_reason") or "").strip():
            raise HTTPException(400, "Weather is unsuitable (rain is a critical risk). Enter an override reason to proceed")
    if d["status"] in ("Resting", "Ready for Cutting", "Completed") and not d.get("production_time"):
        raise HTTPException(400, "Production date and time is required to calculate the resting period")
    if d["status"] in ("Ready for Cutting", "Completed"):
        enrich_production(d, hours)
        if not d["rest_elapsed"]:
            raise HTTPException(400, f"Block is still resting. It can be cut after {fmt_local(d['ready_at'])} ({hours:g}h resting period)")

@api.get("/production")
async def get_production(include_archived: bool = False, user=Depends(get_current_user)):
    hours = await resting_hours()
    flt = {} if include_archived else {"archived": {"$ne": True}}
    return [enrich_production(p, hours) for p in await listall("production", flt, sort=("created_at", -1))]

class BlockCuttingIn(BaseModel):
    block: str
    size: Optional[str] = None
    pieces_recovered: int = Field(gt=0, le=1_000_000_000)
    has_sheet: bool = False
    sheet_mm: Optional[int] = Field(default=None, gt=0, le=1_000_000_000)
    sheet_pieces_recovered: Optional[int] = Field(default=None, gt=0, le=1_000_000_000)

def normalize_block_name(block):
    value = str(block or "").strip()
    standard_names = {"black": "Black", "white": "White", "blue": "Blue", "bianco": "White"}
    return standard_names.get(value.casefold(), value)

@api.get("/production/block-cutting")
async def get_block_cuttings(include_archived: bool = False, user=Depends(get_current_user)):
    flt = {} if include_archived else {"archived": {"$ne": True}}
    records = await listall("block_cuttings", flt, sort=("created_at", -1))
    for record in records:
        record["block"] = normalize_block_name(record.get("block"))
    return records

@api.post("/production/block-cutting")
async def add_block_cutting(body: BlockCuttingIn, user=Depends(get_current_user)):
    block = normalize_block_name(body.block)
    if not block:
        raise HTTPException(400, "A block name is required")
    size = (body.size or "").strip()
    if body.has_sheet:
        size = ""
    elif not size:
        raise HTTPException(400, "A size is required")
    elif not await db.stock.find_one({"size": size}):
        raise HTTPException(400, "Select a size currently available in Stock")
    record = await insert("block_cuttings", {
        "block": block,
        "size": size or None,
        "pieces_recovered": body.pieces_recovered,
        "has_sheet": body.has_sheet,
        "sheet_mm": body.sheet_mm if body.has_sheet else None,
        "sheet_pieces_recovered": body.sheet_pieces_recovered if body.has_sheet else None,
    })
    await log_audit("block_cutting", record["id"], "created", user, after=record)
    return record

@api.put("/production/block-cutting/{record_id}")
async def edit_block_cutting(record_id: str, body: BlockCuttingIn, user=Depends(get_current_user)):
    before = await db.block_cuttings.find_one({"id": record_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Block cutting record not found")
    block = normalize_block_name(body.block)
    if not block:
        raise HTTPException(400, "A block name is required")
    size = (body.size or "").strip()
    if body.has_sheet:
        size = ""
    elif not size:
        raise HTTPException(400, "A size is required")
    elif not await db.stock.find_one({"size": size}):
        raise HTTPException(400, "Select a size currently available in Stock")
    record = await update_doc("block_cuttings", record_id, {
        "block": block,
        "size": size or None,
        "pieces_recovered": body.pieces_recovered,
        "has_sheet": body.has_sheet,
        "sheet_mm": body.sheet_mm if body.has_sheet else None,
        "sheet_pieces_recovered": body.sheet_pieces_recovered if body.has_sheet else None,
    })
    await log_audit("block_cutting", record_id, "updated", user, before=before, after=record)
    return record

@api.delete("/production/block-cutting/{record_id}")
async def delete_block_cutting(record_id: str, user=Depends(get_current_user)):
    before = await db.block_cuttings.find_one({"id": record_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Block cutting record not found")
    updated = await update_doc("block_cuttings", record_id, {
        "archived": True, "archived_at": now_iso(), "archived_by": user.get("id"),
    })
    await log_audit("block_cutting", record_id, "archived", user, before=before, after=updated)
    return {"ok": True, "archived": True}

@api.delete("/production/block-cutting/{record_id}/permanent")
async def permanently_delete_block_cutting(record_id: str, user=Depends(get_current_user)):
    require_admin(user)
    record = await db.block_cuttings.find_one({"id": record_id}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Block cutting record not found")
    if not record.get("archived"):
        raise HTTPException(409, "Archive the block cutting record before permanently deleting it")
    await log_audit("block_cutting", record_id, "permanently_deleted", user, before=record)
    await db.block_cuttings.delete_one({"id": record_id, "archived": True})
    return {"ok": True, "deleted": True}

@api.post("/production/block-cutting/{record_id}/restore")
async def restore_block_cutting(record_id: str, user=Depends(get_current_user)):
    before = await db.block_cuttings.find_one({"id": record_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Block cutting record not found")
    updated = await update_doc("block_cuttings", record_id, {
        "archived": False, "archived_at": None, "archived_by": None,
    })
    await log_audit("block_cutting", record_id, "restored", user, before=before, after=updated)
    return {"ok": True}

@api.post("/production")
async def add_production(body: ProductionIn, user=Depends(get_current_user)):
    d = body.model_dump()
    hours = await resting_hours()
    await check_production_rules(d, None, hours)
    d["stock_added"] = False
    rec = await insert("production", {k: v for k, v in d.items() if k not in ("ready_at", "rest_elapsed")})
    await log_audit("production", rec["id"], "created", user, after=rec)
    await emit_workflow_event("production.created", rec)
    if rec.get("status") == "Completed":
        await emit_workflow_event("production.completed", rec)
    return enrich_production(rec, hours)

@api.put("/production/{pid}")
async def edit_production(pid: str, body: ProductionIn, user=Depends(get_current_user)):
    existing = await db.production.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Not found")
    d = body.model_dump()
    if existing.get("stock_added") and d["status"] != "Completed":
        raise HTTPException(400, "This production was already received into stock and must stay Completed")
    hours = await resting_hours()
    await check_production_rules(d, existing, hours)
    d = {k: v for k, v in d.items() if k not in ("ready_at", "rest_elapsed")}
    rec = await update_doc("production", pid, d)
    await log_audit("production", pid, "updated", user, before=existing, after=rec)
    if existing.get("status") != "Completed" and rec.get("status") == "Completed":
        await emit_workflow_event("production.completed", rec)
    return enrich_production(rec, hours)

class ReceiveIn(BaseModel):
    stock_id: Optional[str] = None
    product_code: Optional[str] = None
    quantity: float

@api.post("/production/{pid}/receive")
async def receive_production(pid: str, body: ReceiveIn, user=Depends(get_current_user)):
    p = await db.production.find_one({"id": pid}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Production record not found")
    if body.quantity <= 0:
        raise HTTPException(400, "Quantity must be positive")
    if p.get("status") == "Cancelled":
        raise HTTPException(400, "Cancelled production cannot be received into stock")
    if p.get("status") not in ("Resting", "Ready for Cutting"):
        raise HTTPException(400, "Only Resting or Ready for Cutting blocks can be received into stock")
    if not p.get("weather"):
        raise HTTPException(400, "Record a weather assessment for this block first")
    if (p.get("weather") == "Unsuitable" or p.get("rain_risk")) and not (p.get("override_reason") or "").strip():
        raise HTTPException(400, "Unsuitable weather requires a recorded override reason")
    hours = await resting_hours()
    enrich_production(p, hours)
    if not p["rest_elapsed"]:
        raise HTTPException(400, f"Block is still resting until {fmt_local(p['ready_at'])}")
    if body.product_code:
        s, _identity = await resolve_product_scan(body.product_code, user)
        if body.stock_id and body.stock_id != s["id"]:
            raise HTTPException(400, "Scanned product does not match the selected stock item")
    elif body.stock_id:
        s = await db.stock.find_one({"id": body.stock_id}, {"_id": 0})
    else:
        raise HTTPException(400, "Select a stock product or scan its identification code")
    if not s:
        raise HTTPException(404, "Stock item not found")
    claimed = await db.production.find_one_and_update({"id": pid, "stock_added": {"$ne": True}}, {"$set": {"stock_added": True}})
    if not claimed:
        raise HTTPException(400, "This production has already been received into stock")
    try:
        m = await post_movement(s, "production", body.quantity, user, f"Production {p['block_ref']}", p["block_ref"],
                                dedupe_key=f"production:{pid}", extra={
                                    "production_id": pid,
                                    "batch_id": f"production:{pid}",
                                    "batch_date": p.get("production_date"),
                                    "batch_quantity": r2(body.quantity),
                                    "historical_cost_status": "unavailable",
                                    "historical_cost_reason": "Actual production cost is not recorded on this production receipt.",
                                })
    except DuplicateKeyError:
        raise HTTPException(400, "This production has already been received into stock")
    except Exception:
        await db.production.update_one({"id": pid}, {"$set": {"stock_added": False}})
        raise
    await db.production.update_one({"id": pid}, {"$set": {"status": "Completed", "received_qty": r2(body.quantity), "stock_id": s["id"]}})
    await log_audit("production", pid, "received_into_stock", user, after=m)
    return m

# ---------------- Employees & Attendance ----------------
class EmployeeIn(BaseModel):
    name: str
    department: str = "Production"
    is_general_worker: bool = False
    skills: Optional[str] = ""
    notes: Optional[str] = ""
    active: bool = True

    @field_validator("name")
    @classmethod
    def employee_name_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Employee name is required")
        return value

class DepartmentIn(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def department_name_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Department name is required")
        if len(value) > 100:
            raise ValueError("Department name must be 100 characters or fewer")
        return value

@api.get("/departments")
async def get_departments(user=Depends(get_current_user)):
    saved = await listall("departments", sort=("name", 1))
    employees = await listall("employees")
    names = {
        str(item.get("name") or "").strip()
        for item in saved
        if str(item.get("name") or "").strip()
    }
    names.update(
        str(employee.get("department") or "").strip()
        for employee in employees
        if str(employee.get("department") or "").strip()
    )
    return sorted(names, key=str.casefold)

@api.post("/departments")
async def add_department(body: DepartmentIn, user=Depends(get_current_user)):
    require_admin(user)
    name = body.name
    existing = await listall("departments")
    match = next(
        (item for item in existing if str(item.get("name") or "").casefold() == name.casefold()),
        None,
    )
    if match:
        return match
    return await insert("departments", {"name": name})

@api.get("/employees")
async def get_employees(user=Depends(get_current_user)):
    employees = await listall("employees", sort=("name", 1))
    return [
        {**employee, "pay_type": "piece" if is_piece_paid_employee(employee) else employee.get("pay_type", "hourly")}
        for employee in employees
    ]

def validate_payroll_roster_company(user):
    company_id = user.get("_active_company_id") or user.get("company_id")
    if company_id != "superiqfoam":
        raise HTTPException(403, "The payroll roster is only available for Super IQ-Foam")

def validate_employee_worker_type(body, user):
    company_id = user.get("_active_company_id") or user.get("company_id")
    if body.is_general_worker and company_id != "iqfoam-whole-sallers":
        raise HTTPException(400, "General workers are only available for IQ Foam Wholesalers")

@api.post("/employees/import-roster")
async def import_employee_roster(user=Depends(get_current_user)):
    require_admin(user)
    validate_payroll_roster_company(user)
    reconciliation = await reconcile_employee_roster(user)
    reconciliation.pop("employees_by_name")
    return reconciliation

def payroll_employee_name_key(name):
    normalized_name = " ".join((name or "").split()).upper()
    canonical_name = seed_data.EMPLOYEE_PAYROLL_NAME_ALIASES.get(normalized_name, normalized_name)
    return canonical_name.casefold()


def is_piece_paid_employee(employee):
    normalized_name = " ".join((employee.get("name") or "").split()).upper()
    return (
        employee.get("pay_type") == "piece"
        or normalized_name in seed_data.PIECEWORK_EMPLOYEE_NAMES
    )


def is_monthly_fixed_salary_employee(employee):
    normalized_name = " ".join(
        "".join(character if character.isalnum() else " " for character in (employee.get("name") or "")).split()
    ).upper()
    tokens = set(normalized_name.split())
    return normalized_name in {"AMEENA", "AMINA", "MR YASEEN", "MR YASSINE"} or (
        "UNCLE" in tokens and bool(tokens & {"YASEEN", "YASSEN", "YASSINE", "YASIN"})
    )

def piecework_includes_sunday(employee_name):
    normalized_name = " ".join((employee_name or "").split()).upper()
    return normalized_name not in seed_data.PIECEWORK_EMPLOYEE_NAMES


def uses_daily_piecework_rates(employee):
    normalized_name = " ".join((employee.get("name") or "").split()).upper()
    return normalized_name in seed_data.PIECEWORK_EMPLOYEE_NAMES


async def merge_duplicate_attendance(duplicate, employee, user):
    duplicate_records = await listall("attendance", {"employee_id": duplicate["id"]})
    for record in duplicate_records:
        existing = await db.attendance.find_one({
            "employee_id": employee["id"],
            "date": record["date"],
        }, {"_id": 0})
        if existing:
            await log_audit(
                "attendance", record["id"], "duplicate_attendance_conflict_archived", user,
                before=record,
                after={"preserved_attendance_id": existing["id"], "employee_id": employee["id"]},
                reason="The retained employee profile already has an attendance record for this date.",
            )
            await db.attendance.delete_one({"id": record["id"]})
        else:
            await update_doc("attendance", record["id"], {
                "employee_id": employee["id"],
                "employee_name": employee.get("name", ""),
                "department": employee.get("department", ""),
            })


async def reconcile_employee_roster(user):
    roster_by_name = {
        payroll_employee_name_key(employee["name"]): employee
        for employee in seed_data.EMPLOYEE_PAYROLL_ROSTER
    }
    existing_employees = await listall("employees")
    employees_by_name = {}
    for employee in existing_employees:
        key = payroll_employee_name_key(employee.get("name", ""))
        employees_by_name.setdefault(key, []).append(employee)

    added = updated = unchanged = duplicates_archived = unlisted_archived = 0
    roster_employees_by_name = {}
    for key, roster_employee in roster_by_name.items():
        matches = employees_by_name.pop(key, [])
        matches.sort(key=lambda employee: (
            employee.get("active") is False,
            employee.get("created_at") or "",
            employee.get("id") or "",
        ))
        weekly_salary = roster_employee["weekly_salary"]
        hours_per_week = STANDARD_WEEKLY_HOURS
        employee_data = {
            "name": roster_employee["name"],
            "department": roster_employee["department"],
            "pay_type": roster_employee["pay_type"],
            "hourly_rate": weekly_salary / STANDARD_PAID_DAYS_PER_WEEK / 8,
            "weekly_salary": weekly_salary,
            "hours_per_week": hours_per_week,
            "work_days_per_week": 6,
            "active": True,
        }

        if matches:
            employee = matches[0]
            changes = {
                field: value for field, value in employee_data.items()
                if employee.get(field) != value
            }
            if changes:
                employee = await update_doc("employees", employee["id"], changes)
                await log_audit("employee", employee["id"], "payroll_roster_reconciled",
                                user, before=matches[0], after=employee)
                updated += 1
            else:
                unchanged += 1
            roster_employees_by_name[key] = employee

            for duplicate in matches[1:]:
                await merge_duplicate_attendance(duplicate, employee, user)
                for collection in ("salary_advances", "salary_cuts", "piece_production"):
                    await db[collection].update_many(
                        {"employee_id": duplicate["id"]},
                        {"$set": {"employee_id": employee["id"], "employee_name": employee_data["name"]}},
                    )
                deleted_at = now_iso()
                await db.deleted_employees.insert_one({
                    **duplicate, "deleted_at": deleted_at, "deleted_by": user.get("id"),
                    "archive_reason": "Duplicate payroll roster entry",
                    "merged_into_employee_id": employee["id"],
                })
                await db.employees.delete_one({"id": duplicate["id"]})
                await log_audit(
                    "employee", duplicate["id"], "duplicate_payroll_profile_archived", user,
                    before=duplicate, after={"deleted_at": deleted_at, "merged_into_employee_id": employee["id"]},
                )
                duplicates_archived += 1
        else:
            employee = await insert("employees", employee_data)
            await log_audit("employee", employee["id"], "payroll_roster_imported", user, after=employee)
            roster_employees_by_name[key] = employee
            added += 1

    for unmatched in employees_by_name.values():
        for employee in unmatched:
            deleted_at = now_iso()
            await db.deleted_employees.insert_one({
                **employee, "deleted_at": deleted_at, "deleted_by": user.get("id"),
                "archive_reason": "Not included in the supplied payroll roster",
            })
            await db.employees.delete_one({"id": employee["id"]})
            await log_audit(
                "employee", employee["id"], "unlisted_payroll_profile_archived", user,
                before=employee, after={"deleted_at": deleted_at},
            )
            unlisted_archived += 1

    return {
        "added": added,
        "updated": updated,
        "unchanged": unchanged,
        "duplicates_archived": duplicates_archived,
        "unlisted_archived": unlisted_archived,
        "employees_by_name": roster_employees_by_name,
    }

@api.post("/employees/reconcile-payroll-roster")
async def reconcile_payroll_roster(user=Depends(get_current_user)):
    require_admin(user)
    validate_payroll_roster_company(user)
    reconciliation = await reconcile_employee_roster(user)
    roster_employees_by_name = reconciliation.pop("employees_by_name")

    today = local_today()
    week_start = today - timedelta(days=today.weekday())
    attendance_records = []
    for roster_employee in seed_data.EMPLOYEE_PAYROLL_ROSTER:
        employee = roster_employees_by_name[payroll_employee_name_key(roster_employee["name"])]
        if not employee:
            raise HTTPException(500, f"Could not find reconciled employee {roster_employee['name']}")
        for day_offset in range(6):
            attendance_records.append({
                "id": new_id(),
                "employee_id": employee["id"],
                "employee_name": employee["name"],
                "department": employee.get("department", ""),
                "date": (week_start + timedelta(days=day_offset)).isoformat(),
                "status": "Present",
                "overtime_hours": 0,
                "start_time": None,
                "end_time": None,
                "notes": "",
                "created_at": now_iso(),
            })

    deleted_attendance = await db.attendance.delete_many({})
    if attendance_records:
        await db.attendance.insert_many(attendance_records)
    await log_audit(
        "attendance", f"payroll-roster-reset-{week_start.isoformat()}",
        "history_cleared_and_current_week_repopulated", user,
        before={"deleted_records": deleted_attendance.deleted_count},
        after={"created_records": len(attendance_records), "week_start": week_start.isoformat()},
    )
    return {
        **reconciliation,
        "attendance_deleted": deleted_attendance.deleted_count,
        "attendance_created": len(attendance_records),
        "week_start": week_start.isoformat(),
        "week_end": (week_start + timedelta(days=6)).isoformat(),
    }

@api.get("/employees/deleted")
async def get_deleted_employees(user=Depends(get_current_user)):
    require_owner(user)
    return await listall("deleted_employees", sort=("deleted_at", -1))

@api.post("/employees")
async def add_employee(body: EmployeeIn, user=Depends(get_current_user)):
    validate_employee_worker_type(body, user)
    rec = await insert("employees", body.model_dump())
    await emit_workflow_event("employee.created", rec)
    return rec

@api.put("/employees/{eid}")
async def edit_employee(eid: str, body: EmployeeIn, user=Depends(get_current_user)):
    validate_employee_worker_type(body, user)
    rec = await update_doc("employees", eid, body.model_dump())
    await emit_workflow_event("employee.updated", rec)
    return rec

@api.delete("/employees/{eid}")
async def delete_employee(eid: str, user=Depends(get_current_user)):
    require_owner(user)
    employee = await db.employees.find_one({"id": eid}, {"_id": 0})
    if not employee:
        raise HTTPException(404, "Employee not found")
    deleted_at = now_iso()
    await db.deleted_employees.insert_one({
        **employee, "deleted_at": deleted_at, "deleted_by": user.get("id"),
    })
    await db.employees.delete_one({"id": eid})
    await log_audit("employee", eid, "permanently_deleted", user,
                    before=employee, after={"deleted_at": deleted_at})
    return {"ok": True, "deleted": True}

def validate_iso_date(value):
    try:
        datetime.strptime(value or "", "%Y-%m-%d")
    except ValueError:
        raise ValueError("Date must use YYYY-MM-DD format")
    return value

class AttendanceIn(BaseModel):
    employee_id: str
    date: str
    status: str = "Present"
    overtime_hours: Optional[float] = Field(default=None, ge=0, le=24)

    @field_validator("date")
    @classmethod
    def attendance_date_valid(cls, value):
        return validate_iso_date(value)
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    notes: Optional[str] = ""


async def _save_employee_day_record(collection_name, employee_id, work_date, data):
    collection = db[collection_name]
    key = {"employee_id": employee_id, "date": work_date}
    timestamp = now_iso()
    fields = {
        key: value
        for key, value in data.items()
        if key not in ("id", "_id", "created_at", "updated_at")
    }
    fields["updated_at"] = timestamp
    update = {
        "$set": fields,
        "$setOnInsert": {"id": new_id(), "created_at": timestamp},
    }
    try:
        previous = await collection.find_one_and_update(
            key, update, upsert=True, return_document=ReturnDocument.BEFORE,
            projection={"_id": 0},
        )
    except DuplicateKeyError as error:
        previous = await collection.find_one_and_update(
            key, {"$set": fields}, upsert=False,
            return_document=ReturnDocument.BEFORE, projection={"_id": 0},
        )
        if previous is None:
            raise error

    saved = await collection.find_one(key, {"_id": 0})
    if saved is None:
        raise RuntimeError(f"Could not read saved {collection_name} record")
    return previous, clean(saved)


@api.get("/attendance")
async def get_attendance(date_filter: Optional[str] = Query(None, alias="date"), user=Depends(get_current_user)):
    if date_filter:
        try:
            validate_iso_date(date_filter)
        except ValueError as error:
            raise HTTPException(422, "Attendance date must use YYYY-MM-DD format") from error
        return await listall("attendance", {"date": date_filter}, sort=("date", -1))
    return await listall("attendance", sort=("date", -1))

@api.post("/attendance")
async def add_attendance(body: AttendanceIn, user=Depends(get_current_user)):
    emp = await db.employees.find_one({"id": body.employee_id})
    if not emp:
        raise HTTPException(400, "Employee not found")
    if body.status not in ("Present", "Half Day", "Absent", "Leave", "Sick", "Other", "Sick Leave", "Annual Leave", "Other Approved Leave"):
        raise HTTPException(400, "Invalid attendance status")
    existing = await db.attendance.find_one({"employee_id": body.employee_id, "date": body.date})
    data = body.model_dump()
    if data["overtime_hours"] is None:
        data["overtime_hours"] = (existing or {}).get("overtime_hours", 0) if body.status in ("Present", "Half Day") else 0
    time_fields_set = body.model_fields_set.intersection({"start_time", "end_time"})
    if time_fields_set and time_fields_set != {"start_time", "end_time"}:
        raise HTTPException(400, "Provide both start and end times")
    if body.status not in ("Present", "Half Day"):
        if body.start_time is not None or body.end_time is not None:
            raise HTTPException(400, "Work times can only be set for present employees")
        data["start_time"] = None
        data["end_time"] = None
    elif not time_fields_set:
        data["start_time"] = (existing or {}).get("start_time")
        data["end_time"] = (existing or {}).get("end_time")
    elif body.start_time is None and body.end_time is None:
        data["start_time"] = None
        data["end_time"] = None
    elif body.start_time is None or body.end_time is None:
        raise HTTPException(400, "Provide both start and end times")
    else:
        for value in (body.start_time, body.end_time):
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
                raise HTTPException(400, "Work times must use HH:MM format")
        if body.start_time == body.end_time:
            raise HTTPException(400, "Start and end times must be different")
    data["employee_name"] = emp["name"]
    data["department"] = emp.get("department", "")
    _, record = await _save_employee_day_record(
        "attendance", body.employee_id, body.date, data,
    )
    await emit_workflow_event("attendance.recorded", record)
    return record

class SalaryAdvanceIn(BaseModel):
    employee_id: str
    amount: float = Field(gt=0)
    date: str = Field(default_factory=today_str)
    notes: Optional[str] = ""

class SalaryCutIn(BaseModel):
    employee_id: str
    start_date: str
    end_date: str
    amount: float = Field(ge=0)
    notes: Optional[str] = ""

class SalaryRateIn(BaseModel):
    hourly_rate: Optional[float] = Field(default=None, ge=0.01)
    weekly_salary: Optional[float] = Field(default=None, gt=0)
    monthly_salary: Optional[float] = Field(default=None, gt=0)
    work_days_per_week: Optional[int] = Field(default=None, ge=6, le=6)

class SalaryPaymentIn(BaseModel):
    employee_id: str
    period_type: Literal["weekly", "monthly"]
    period_start: str
    period_end: str
    payment_date: str = Field(default_factory=today_str)
    notes: Optional[str] = ""

    @field_validator("period_start", "period_end", "payment_date")
    @classmethod
    def salary_payment_dates_valid(cls, value):
        return validate_iso_date(value)

class PieceProductionIn(BaseModel):
    employee_id: str
    date: str
    pieces: int = Field(ge=0)

    @field_validator("date")
    @classmethod
    def piece_date_valid(cls, value):
        return validate_iso_date(value)

@api.get("/piece-production")
async def get_piece_production(start_date: str, end_date: str, user=Depends(get_current_user)):
    salary_period_dates(start_date, end_date)
    return await listall("piece_production", {"date": {"$gte": start_date, "$lte": end_date}}, ("date", 1))


async def piecework_week_snapshot(employee_id, work_date, employee_name):
    week_start = work_date - timedelta(days=work_date.weekday())
    week_end = week_start + timedelta(days=6)
    records = await listall("piece_production", {
        "employee_id": employee_id,
        "date": {"$gte": week_start.isoformat(), "$lte": week_end.isoformat()},
    }, ("date", 1))
    result = calculate_piecework(
        records,
        include_sunday=piecework_includes_sunday(employee_name),
        start_date=week_start.isoformat(),
        end_date=week_end.isoformat(),
    )
    return result["weeks"][0]


@api.post("/piece-production")
async def save_piece_production(body: PieceProductionIn, user=Depends(get_current_user)):
    try:
        date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(400, "Use a valid YYYY-MM-DD work date")
    employee = await db.employees.find_one({"id": body.employee_id}, {"_id": 0})
    if not employee:
        raise HTTPException(404, "Employee not found")
    if not is_piece_paid_employee(employee):
        raise HTTPException(400, "Piece production is only available for piece-paid employees")
    data = {**body.model_dump(), "employee_name": employee.get("name", "")}
    work_date = date.fromisoformat(body.date)
    previous_calculation = await piecework_week_snapshot(body.employee_id, work_date, employee.get("name", ""))
    audit_reason = (
        "Historical production change preserves the prior weekly calculation in this audit entry."
        if work_date < local_today()
        else "Production change records the weekly calculation before and after the change."
    )
    existing, saved = await _save_employee_day_record(
        "piece_production", body.employee_id, body.date, data,
    )
    next_calculation = await piecework_week_snapshot(body.employee_id, work_date, employee.get("name", ""))
    if existing:
        await log_audit(
            "piece_production", existing["id"], "updated_weekly_payroll_recalculated", user,
            before={"record": existing, "weekly_calculation": previous_calculation},
            after={"record": saved, "weekly_calculation": next_calculation},
            reason=audit_reason,
        )
    else:
        await log_audit(
            "piece_production", saved["id"], "created_weekly_payroll_calculated", user,
            before={"weekly_calculation": previous_calculation},
            after={"record": saved, "weekly_calculation": next_calculation},
        )
    await emit_workflow_event("piece_production.saved", saved)
    return saved


@api.delete("/piece-production/{record_id}")
async def delete_piece_production(record_id: str, user=Depends(get_current_user)):
    record = await db.piece_production.find_one({"id": record_id}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Piece production record not found")
    employee = await db.employees.find_one({"id": record.get("employee_id")}, {"_id": 0})
    employee_name = (employee or {}).get("name") or record.get("employee_name", "")
    work_date = date.fromisoformat(record["date"])
    previous_calculation = await piecework_week_snapshot(record["employee_id"], work_date, employee_name)
    audit_reason = (
        "Historical production deletion preserves the prior weekly calculation in this audit entry."
        if work_date < local_today()
        else "Production deletion records the weekly calculation before and after the change."
    )
    await db.piece_production.delete_one({"id": record_id})
    next_calculation = await piecework_week_snapshot(record["employee_id"], work_date, employee_name)
    await log_audit(
        "piece_production", record_id, "deleted_weekly_payroll_recalculated", user,
        before={"record": record, "weekly_calculation": previous_calculation},
        after={"weekly_calculation": next_calculation},
        reason=audit_reason,
    )
    return {"ok": True}

def salary_period_dates(start_date, end_date):
    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except (TypeError, ValueError):
        raise HTTPException(400, "Use valid YYYY-MM-DD salary period dates")
    if end < start:
        raise HTTPException(400, "Salary period end date must not be before start date")
    return start_date, end_date


def is_full_calendar_month(start_date, end_date):
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    return (
        start.day == 1
        and end == date(start.year, start.month, calendar.monthrange(start.year, start.month)[1])
    )


async def salary_report(start_date, end_date, *, include_monthly_salaries=False):
    salary_period_dates(start_date, end_date)
    full_month_period = is_full_calendar_month(start_date, end_date)
    employees, attendance, piece_records, advances, cuts = await asyncio.gather(
        listall("employees", sort=("name", 1)),
        listall("attendance", {"date": {"$gte": start_date, "$lte": end_date}}, ("date", 1)),
        listall("piece_production", {"date": {"$gte": start_date, "$lte": end_date}}, ("date", 1)),
        listall("salary_advances", {"voided": {"$ne": True}}),
        listall("salary_cuts", {"voided": {"$ne": True}}),
    )
    result = []
    employee_ids = {employee.get("id") for employee in employees}
    unmatched_attendance_records = [
        {
            "employee_id": record.get("employee_id"),
            "employee_name": record.get("employee_name", ""),
            "date": record.get("date", ""),
            "status": record.get("status", ""),
        }
        for record in attendance
        if record.get("employee_id") not in employee_ids
    ]
    for employee in employees:
        is_piece_paid = is_piece_paid_employee(employee)
        is_monthly_fixed = is_monthly_fixed_salary_employee(employee) and not is_piece_paid
        report_start = date.fromisoformat(start_date)
        payroll_month_start = report_start.replace(day=1)
        payroll_month_end = payroll_month_start.replace(
            day=calendar.monthrange(payroll_month_start.year, payroll_month_start.month)[1]
        )
        monthly_salary = employee.get("monthly_salary") if is_monthly_fixed else None
        configured_hourly_rate = employee.get("hourly_rate")
        hourly_rate = float(configured_hourly_rate) if configured_hourly_rate else 0
        weekly_salary = employee.get("weekly_salary") if not is_piece_paid and not is_monthly_fixed else None
        hours_per_week = STANDARD_WEEKLY_HOURS
        work_days_per_week = 6
        if (
            (weekly_salary is None or D(weekly_salary) <= 0)
            and not is_piece_paid
            and not is_monthly_fixed
            and configured_hourly_rate
            and D(configured_hourly_rate) > 0
        ):
            weekly_salary = r2(D(hourly_rate) * D(8) * D(STANDARD_PAID_DAYS_PER_WEEK))
        if weekly_salary is not None and D(weekly_salary) <= 0:
            weekly_salary = None
        if not is_piece_paid and not is_monthly_fixed:
            if weekly_salary is not None:
                hourly_rate = float(
                    (D(weekly_salary) / D(STANDARD_PAID_DAYS_PER_WEEK) / D(8))
                    .quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
                )
            else:
                hourly_rate = 0
        salary_rate_missing = (
            is_monthly_fixed and (monthly_salary is None or D(monthly_salary) <= 0)
        ) or (
            not is_piece_paid and not is_monthly_fixed and weekly_salary is None
        )
        rows = sorted(
            [record for record in attendance if record.get("employee_id") == employee["id"]],
            key=lambda record: record.get("date", ""),
        )
        employee_piecework = calculate_piecework([
            record for record in piece_records if record.get("employee_id") == employee["id"]
        ], include_sunday=piecework_includes_sunday(employee.get("name", "")),
            daily_rate_tiers=uses_daily_piecework_rates(employee),
            start_date=start_date, end_date=end_date) if is_piece_paid else {
                "days": [], "total_pieces": 0, "piece_rate": 0, "piece_pay": 0, "weeks": [],
            }
        days = [] if is_piece_paid else calculate_salary_hours(rows)
        worked_hours = sum(day["worked_hours"] for day in days)
        regular_hours = sum(day["regular_hours"] for day in days)
        overtime_hours = sum(day["overtime_hours"] for day in days)
        present_days = sum(day["status"] == "Present" for day in days)
        half_days = sum(day["status"] == "Half Day" for day in days)
        for day in days:
            day["regular_pay"] = r2(
                D(weekly_salary or 0) * D(day["attendance_fraction"]) / D(STANDARD_PAID_DAYS_PER_WEEK)
            ) if not is_monthly_fixed else 0
            day["overtime_pay"] = r2((
                D(day["overtime_hours"] - day["overtime_after_17_hours"]) * D(OVERTIME_HOURLY_RATE)
                + D(day["overtime_after_17_hours"]) * D(OVERTIME_AFTER_17_HOURLY_RATE)
            )) if not is_monthly_fixed else 0
            day["pay"] = r2(D(day["regular_pay"]) + D(day["overtime_pay"]))
        employee_advances = [item for item in advances if item.get("employee_id") == employee["id"]]
        employee_cuts = [item for item in cuts if item.get("employee_id") == employee["id"]]
        all_advance_total = sum((D(item.get("amount", 0)) for item in employee_advances), Decimal("0"))
        all_cut_total = sum((D(item.get("amount", 0)) for item in employee_cuts), Decimal("0"))
        period_cut = r2(sum(
            (
                D(item.get("amount", 0))
                for item in employee_cuts
                if (
                    item.get("start_date") == start_date and item.get("end_date") == end_date
                    or (full_month_period or is_monthly_fixed and include_monthly_salaries)
                    and payroll_month_start.isoformat() <= item.get("end_date", "") <= payroll_month_end.isoformat()
                )
            ),
            Decimal("0"),
        ))
        regular_pay = r2(sum(
            (
                D(weekly_salary) * D(day["attendance_fraction"]) / D(STANDARD_PAID_DAYS_PER_WEEK)
                for day in days
            ),
            Decimal("0"),
        )) if not is_monthly_fixed else 0
        overtime_pay = r2(sum(
            (D(day["overtime_pay"]) for day in days),
            Decimal("0"),
        )) if not is_monthly_fixed else 0
        monthly_pay = r2(monthly_salary) if (
            is_monthly_fixed and monthly_salary is not None
            and (full_month_period or include_monthly_salaries)
        ) else 0
        gross = employee_piecework["piece_pay"] if is_piece_paid else (
            monthly_pay if is_monthly_fixed else r2(regular_pay + overtime_pay)
        )
        cut = period_cut
        balance = all_advance_total - all_cut_total
        balance_period_start = (
            payroll_month_start.isoformat()
            if is_monthly_fixed and include_monthly_salaries else start_date
        )
        balance_period_end = (
            payroll_month_end.isoformat()
            if is_monthly_fixed and include_monthly_salaries else end_date
        )
        balance_before_period = sum(
            (D(item.get("amount", 0)) for item in employee_advances if item.get("date", "") < balance_period_start),
            Decimal("0"),
        ) - sum(
            (D(item.get("amount", 0)) for item in employee_cuts if item.get("end_date", "") < balance_period_start),
            Decimal("0"),
        )
        balance_through_period = sum(
            (D(item.get("amount", 0)) for item in employee_advances if item.get("date", "") <= balance_period_end),
            Decimal("0"),
        ) - sum(
            (D(item.get("amount", 0)) for item in employee_cuts if item.get("end_date", "") <= balance_period_end),
            Decimal("0"),
        )
        balance_history = [
            {
                "id": item.get("id"), "type": "advance", "date": item.get("date", ""),
                "recorded_at": item.get("created_at", ""), "amount": r2(item.get("amount", 0)),
                "notes": item.get("notes", ""), "_sort_at": item.get("created_at", ""),
            }
            for item in employee_advances
        ] + [
            {
                "id": item.get("id"), "type": "cut", "date": item.get("end_date", ""),
                "start_date": item.get("start_date", ""), "end_date": item.get("end_date", ""),
                "recorded_at": item.get("updated_at") or item.get("created_at", ""),
                "amount": r2(item.get("amount", 0)), "notes": item.get("notes", ""),
                "_sort_at": item.get("updated_at") or item.get("created_at", ""),
            }
            for item in employee_cuts
        ]
        balance_history.sort(key=lambda item: (item["date"], item["_sort_at"], item["type"]))
        running_balance = Decimal("0")
        for transaction in balance_history:
            transaction["balance_before"] = r2(running_balance)
            amount = D(transaction["amount"])
            running_balance += amount if transaction["type"] == "advance" else -amount
            transaction["balance_after"] = r2(running_balance)
            transaction.pop("_sort_at")
        result.append({
            "employee_id": employee["id"], "name": employee.get("name", ""),
            "department": employee.get("department", ""), "active": employee.get("active", True),
            "is_general_worker": employee.get("is_general_worker", False),
            "hourly_rate": hourly_rate, "weekly_salary": weekly_salary,
            "monthly_salary": monthly_salary,
            "pay_frequency": "piece" if is_piece_paid else ("monthly_fixed" if is_monthly_fixed else "weekly_fixed"),
            "salary_rate_missing": salary_rate_missing,
            "is_full_month_period": full_month_period,
            "hours_per_week": hours_per_week, "work_days_per_week": work_days_per_week,
            "pay_type": "piece" if is_piece_paid else "hourly",
            "total_pieces": employee_piecework["total_pieces"],
            "piece_rate": employee_piecework["piece_rate"],
            "piece_pay": employee_piecework["piece_pay"],
            "piece_days": employee_piecework["days"],
            "piece_weeks": employee_piecework["weeks"],
            "days": days, "present_days": present_days, "half_days": half_days,
            "worked_hours": worked_hours,
            "regular_hours": regular_hours, "overtime_hours": overtime_hours,
            "regular_pay": regular_pay, "overtime_pay": overtime_pay, "gross_salary": gross,
            "balance_before_period": r2(balance_before_period),
            "balance_after_period": r2(balance_through_period),
            "balance": r2(balance),
            "available_balance": r2(balance_through_period + D(cut)),
            "balance_history": balance_history,
            "cut": cut, "net_salary": r2(gross - cut),
        })
    return {
        "start_date": start_date,
        "end_date": end_date,
        "employees": result,
        "unmatched_attendance_records": unmatched_attendance_records,
    }


async def salary_cost_for_period(start_date, end_date):
    period_start = date.fromisoformat(str(start_date)[:10])
    period_end = date.fromisoformat(str(end_date)[:10])
    report = await salary_report(period_start.isoformat(), period_end.isoformat())
    return r2(sum(
        (
            D(salary_amount_for_period(employee, period_start, period_end))
            for employee in report["employees"]
        ),
        Decimal("0"),
    ))


def salary_amount_for_period(employee, period_start, period_end):
    if employee.get("pay_frequency") != "monthly_fixed" or employee.get("monthly_salary") is None:
        return r2(employee.get("gross_salary", 0))
    total = Decimal("0")
    month_start = period_start.replace(day=1)
    while month_start <= period_end:
        month_end = month_start.replace(
            day=calendar.monthrange(month_start.year, month_start.month)[1],
        )
        overlap_start = max(period_start, month_start)
        overlap_end = min(period_end, month_end)
        if overlap_start <= overlap_end:
            total += (
                D(employee["monthly_salary"])
                * D((overlap_end - overlap_start).days + 1)
                / D((month_end - month_start).days + 1)
            )
        month_start = (month_end + timedelta(days=1)).replace(day=1)
    return r2(total)


@api.get("/salaries")
async def get_salaries(
    start_date: str,
    end_date: str,
    include_monthly_salaries: bool = Query(False),
    user=Depends(get_current_user),
):
    require_admin(user)
    salary_period_dates(start_date, end_date)
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    if not is_full_calendar_month(start_date, end_date) and (
        start.weekday() != 0 or end != start + timedelta(days=5)
    ):
        raise HTTPException(400, "Choose a complete calendar month or a Monday–Saturday week")
    return await salary_report(
        start_date, end_date,
        include_monthly_salaries=include_monthly_salaries,
    )


def salary_payroll_key(period_type, period_start, period_end):
    salary_period_dates(period_start, period_end)
    start = date.fromisoformat(period_start)
    end = date.fromisoformat(period_end)
    if period_type == "monthly":
        if not is_full_calendar_month(period_start, period_end):
            raise HTTPException(400, "Monthly payroll must cover one complete calendar month")
        return "monthly:" + period_start[:7]
    if period_type == "weekly":
        if start.weekday() != 0 or end != start + timedelta(days=5):
            raise HTTPException(400, "Weekly payroll must cover Monday through Saturday")
        return "weekly:" + period_start
    raise HTTPException(400, "Unsupported payroll period type")


@api.get("/salaries/payments")
async def get_salary_payments(
    period_type: Literal["weekly", "monthly"],
    period_start: str,
    period_end: str,
    user=Depends(get_current_user),
):
    require_admin(user)
    payroll_key = salary_payroll_key(period_type, period_start, period_end)
    return await listall(
        "salary_payments", {"payroll_key": payroll_key}, ("payment_date", -1)
    )


@api.get("/salaries/payments/history")
async def get_salary_payment_history(user=Depends(get_current_user)):
    require_admin(user)
    return await listall("salary_payments", sort=("payment_date", -1))


@api.post("/salaries/payments")
async def record_salary_payment(body: SalaryPaymentIn, user=Depends(get_current_user)):
    require_admin(user)
    payroll_key = salary_payroll_key(
        body.period_type, body.period_start, body.period_end
    )
    report = await salary_report(
        body.period_start,
        body.period_end,
        include_monthly_salaries=body.period_type == "monthly",
    )
    employee = next(
        (item for item in report["employees"] if item["employee_id"] == body.employee_id),
        None,
    )
    if not employee:
        raise HTTPException(404, "Employee not found in this payroll period")
    is_monthly = employee.get("pay_frequency") == "monthly_fixed"
    if body.period_type == "monthly" and not is_monthly:
        raise HTTPException(400, "Monthly payment records are only for monthly-paid employees")
    if body.period_type == "weekly" and is_monthly:
        raise HTTPException(400, "Monthly-paid employees must be paid from a monthly payroll")
    gross_amount = r2(D(employee.get("gross_salary", 0)))
    deduction_amount = r2(D(employee.get("cut", 0)))
    net_amount = r2(gross_amount - deduction_amount)
    if gross_amount <= 0 or net_amount <= 0:
        raise HTTPException(400, "This employee has no positive net amount payable in the selected payroll")
    existing = await db.salary_payments.find_one(
        {"employee_id": body.employee_id, "payroll_key": payroll_key},
        {"_id": 0},
    )
    if existing:
        raise HTTPException(409, "This employee's payroll has already been marked as paid")
    data = {
        "employee_id": body.employee_id,
        "employee_name": employee.get("name", ""),
        "department": employee.get("department", ""),
        "period_type": body.period_type,
        "payroll_key": payroll_key,
        "period_start": body.period_start,
        "period_end": body.period_end,
        "gross_amount": gross_amount,
        "deduction_amount": deduction_amount,
        "net_amount": net_amount,
        "payment_date": body.payment_date,
        "notes": body.notes or "",
        "status": "paid",
        "paid_at": now_iso(),
        "paid_by": user.get("id"),
    }
    try:
        record = await insert("salary_payments", data)
    except DuplicateKeyError:
        raise HTTPException(409, "This employee's payroll has already been marked as paid")
    await log_audit(
        "salary_payment", record["id"], "paid", user,
        before=None, after=record,
    )
    return record


@api.put("/salaries/rates/{eid}")
async def save_salary_rate(eid: str, body: SalaryRateIn, user=Depends(get_current_user)):
    require_admin(user)
    employee = await db.employees.find_one({"id": eid}, {"_id": 0})
    if not employee:
        raise HTTPException(404, "Employee not found")
    if body.monthly_salary is not None:
        if not is_monthly_fixed_salary_employee(employee):
            raise HTTPException(422, "Monthly fixed pay is only available for the monthly payroll employees")
        updated = await update_doc("employees", eid, {"monthly_salary": r2(D(body.monthly_salary))})
        await log_audit("employee", eid, "monthly_salary_updated", user,
                        before={"monthly_salary": employee.get("monthly_salary")},
                        after={"monthly_salary": updated["monthly_salary"]})
        return updated
    if body.weekly_salary is None and body.hourly_rate is None:
        raise HTTPException(422, "Provide a weekly salary or an hourly rate")
    work_days_per_week = 6
    hours_per_week = STANDARD_WEEKLY_HOURS
    weekly_salary = r2(D(body.weekly_salary)) if body.weekly_salary is not None else None
    hourly_rate = (
        float(
            (D(weekly_salary) / D(STANDARD_PAID_DAYS_PER_WEEK) / D(8))
            .quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        )
        if weekly_salary is not None
        else float(D(body.hourly_rate).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))
    )
    if weekly_salary is None:
        weekly_salary = r2(D(hourly_rate) * D(8) * D(STANDARD_PAID_DAYS_PER_WEEK))
    updated = await update_doc("employees", eid, {
        "hourly_rate": hourly_rate,
        "weekly_salary": weekly_salary,
        "hours_per_week": hours_per_week,
        "work_days_per_week": work_days_per_week,
    })
    await log_audit("employee", eid, "salary_rate_updated", user,
                    before={
                        "hourly_rate": employee.get("hourly_rate", 20),
                        "weekly_salary": employee.get("weekly_salary"),
                        "work_days_per_week": employee.get("work_days_per_week", 6),
                    },
                    after={
                        "hourly_rate": updated["hourly_rate"],
                        "weekly_salary": updated["weekly_salary"],
                        "work_days_per_week": updated["work_days_per_week"],
                    })
    return updated

@api.post("/salaries/advances")
async def add_salary_advance(body: SalaryAdvanceIn, user=Depends(get_current_user)):
    require_admin(user)
    if not await db.employees.find_one({"id": body.employee_id}):
        raise HTTPException(404, "Employee not found")
    amount = r2(D(body.amount))
    if amount <= 0:
        raise HTTPException(422, "Borrowed amount must be at least one cent")
    record = await insert("salary_advances", {**body.model_dump(), "amount": amount})
    await log_audit("salary_advance", record["id"], "created", user, after=record)
    return record

@api.delete("/salaries/history/{eid}")
async def clear_salary_history(eid: str, user=Depends(get_current_user)):
    require_admin(user)
    employee = await db.employees.find_one({"id": eid}, {"_id": 0})
    if not employee:
        raise HTTPException(404, "Employee not found")
    advances = await listall("salary_advances", {"employee_id": eid})
    cuts = await listall("salary_cuts", {"employee_id": eid})
    await db.salary_advances.update_many(
        {"employee_id": eid, "voided": {"$ne": True}},
        {"$set": {"voided": True, "voided_at": now_iso(), "voided_by": user.get("id")}},
    )
    await db.salary_cuts.update_many(
        {"employee_id": eid, "voided": {"$ne": True}},
        {"$set": {"voided": True, "voided_at": now_iso(), "voided_by": user.get("id")}},
    )
    await log_audit(
        "salary_balance_history", eid, "cleared", user,
        before={"employee_name": employee.get("name", ""), "advances": advances, "cuts": cuts},
        after={"employee_name": employee.get("name", ""), "outstanding_balance": 0, "voided": True},
    )
    return {"ok": True, "archived_advances": len(advances), "archived_cuts": len(cuts)}

@api.post("/salaries/cuts")
async def save_salary_cut(body: SalaryCutIn, user=Depends(get_current_user)):
    require_admin(user)
    salary_period_dates(body.start_date, body.end_date)
    amount = r2(D(body.amount))
    report = await salary_report(body.start_date, body.end_date)
    employee = next((item for item in report["employees"] if item["employee_id"] == body.employee_id), None)
    if not employee:
        raise HTTPException(404, "Employee not found")
    if employee["pay_frequency"] == "monthly_fixed" and not employee["is_full_month_period"]:
        raise HTTPException(400, "Select a complete calendar month before saving a salary cut")
    employee_cuts = await listall("salary_cuts", {
        "employee_id": body.employee_id,
        "voided": {"$ne": True},
    })
    if employee["pay_frequency"] == "monthly_fixed":
        payroll_start = date.fromisoformat(body.start_date)
        payroll_end = date.fromisoformat(body.end_date)
        period_start = payroll_start.replace(day=1).isoformat()
        period_end = payroll_end.replace(
            day=calendar.monthrange(
                payroll_end.year,
                payroll_end.month,
            )[1],
        ).isoformat()
        period_cuts = [
            item for item in employee_cuts
            if not item.get("voided") and period_start <= item.get("end_date", "") <= period_end
        ]
    else:
        period_cuts = [
            item for item in employee_cuts
            if (
                not item.get("voided")
                and item.get("start_date") == body.start_date
                and item.get("end_date") == body.end_date
            )
        ]
    before = period_cuts[-1] if period_cuts else None
    previous_cut_total = sum((D(item.get("amount", 0)) for item in period_cuts), Decimal("0"))
    if amount > employee["gross_salary"]:
        raise HTTPException(400, f"Cut exceeds this period's gross salary of R {employee['gross_salary']:.2f}")
    amount_delta = r2(D(amount) - previous_cut_total)
    if amount_delta == 0:
        return {"ok": True, "amount": amount}
    if amount_delta < 0:
        for existing_cut in period_cuts:
            await update_doc("salary_cuts", existing_cut["id"], {
                "voided": True, "voided_at": now_iso(), "voided_by": user.get("id"),
            })
            await log_audit("salary_cut", existing_cut["id"], "voided_for_manual_adjustment", user,
                            before=existing_cut)
        amount_delta = amount
    if amount_delta == 0:
        return {"ok": True, "amount": 0}
    data = body.model_dump()
    data["amount"] = amount_delta
    data["voided"] = False
    data["voided_at"] = None
    data["voided_by"] = None
    record = await insert("salary_cuts", data)
    await log_audit("salary_cut", record["id"], "saved", user, before=before, after=record)
    return record

# ---------------- Drivers & Vehicles ----------------
class DriverIn(BaseModel):
    name: str
    preferences: Optional[str] = ""
    size_pref: str = "small"
    active: bool = True

    @field_validator("name")
    @classmethod
    def name_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Driver name is required")
        return value

@api.get("/drivers")
async def get_drivers(user=Depends(get_current_user)):
    return await listall("drivers", sort=("name", 1))

@api.post("/drivers")
async def add_driver(body: DriverIn, user=Depends(get_current_user)):
    rec = await insert("drivers", body.model_dump())
    await emit_workflow_event("driver.created", rec)
    return rec

@api.put("/drivers/{did}")
async def edit_driver(did: str, body: DriverIn, user=Depends(get_current_user)):
    rec = await update_doc("drivers", did, body.model_dump())
    await emit_workflow_event("driver.updated", rec)
    return rec

class VehicleIn(BaseModel):
    name: str
    registration: Optional[str] = ""
    vtype: Optional[str] = ""
    capacity: Optional[str] = ""
    length: Optional[str] = ""
    available: bool = True
    notes: Optional[str] = ""
    model: Optional[str] = ""
    consumption_min: Optional[float] = None
    consumption_max: Optional[float] = None
    payload_kg: Optional[float] = None
    tank_litres: Optional[float] = None

    @field_validator("name")
    @classmethod
    def name_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Vehicle name is required")
        return value

    @field_validator("consumption_min", "consumption_max", "payload_kg", "tank_litres")
    @classmethod
    def vehicle_number_not_negative(cls, value):
        if value is not None and value < 0:
            raise ValueError("Value cannot be negative")
        return value

class VehicleDriverAssignmentIn(BaseModel):
    driver_id: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default="", max_length=500)

class VehicleLicenceDiscIn(BaseModel):
    disc_number: str = Field(min_length=1, max_length=80)
    issue_date: Optional[str] = None
    expiry_date: str
    document_name: str = Field(min_length=1, max_length=200)
    document_content_type: Literal["application/pdf", "image/jpeg", "image/png"]
    document_base64: str = Field(min_length=1)

    @field_validator("disc_number", "document_name")
    @classmethod
    def strip_required_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("This field is required")
        return value

    @field_validator("issue_date", "expiry_date")
    @classmethod
    def validate_licence_date(cls, value, info):
        if info.field_name == "issue_date" and value in (None, ""):
            return None
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("Dates must use YYYY-MM-DD format")
        try:
            date.fromisoformat(value)
        except (TypeError, ValueError) as error:
            raise ValueError("Dates must use YYYY-MM-DD format") from error
        return value

    @field_validator("document_base64")
    @classmethod
    def validate_document_size(cls, value):
        if len(value) > 7_000_000:
            raise ValueError("Licence disc document must be no larger than 5 MB")
        return value

def vehicle_licence_disc_status(expiry_date, today=None):
    try:
        expiry = date.fromisoformat(str(expiry_date))
    except (TypeError, ValueError):
        return {"status": "UNKNOWN", "days_remaining": None}
    remaining = (expiry - (today or local_today())).days
    status = "EXPIRED" if remaining < 0 else "EXPIRING SOON" if remaining <= 30 else "VALID"
    return {"status": status, "days_remaining": remaining}

def vehicle_licence_alert_due(expiry_date, today=None):
    remaining = vehicle_licence_disc_status(expiry_date, today)["days_remaining"]
    return remaining is not None and remaining <= 7

def fleet_notification_recipients(accounts, company_id):
    recipients = {}
    for account in accounts:
        if account.get("active", True) is False or account.get("is_worker"):
            continue
        is_global_owner = (
            account.get("role") == "owner"
            and canonical_email(account.get("email")) == canonical_email(os.environ["ADMIN_EMAIL"])
        )
        role = (account.get("company_roles") or {}).get(company_id)
        if is_global_owner or role in ("owner", "admin"):
            recipients[account["id"]] = account
    return list(recipients.values())

def next_fleet_notification_cycle(now=None):
    now = now or local_now()
    next_cycle = now.replace(hour=8, minute=0, second=0, microsecond=0)
    if next_cycle <= now:
        next_cycle += timedelta(days=1)
    return next_cycle.astimezone(timezone.utc).isoformat()

async def process_daily_vehicle_licence_alerts(today=None):
    report_date = today or local_today()
    accounts = await base_db.users.find(
        {"active": {"$ne": False}},
        {"_id": 0, "id": 1, "email": 1, "role": 1, "company_roles": 1, "is_worker": 1, "name": 1},
    ).to_list(None)
    for profile in COMPANY_PROFILES:
        company_id = profile["id"]
        company_db = tenant_database(client, base_db, company_id)
        latest_discs = await company_db.vehicle_licence_discs.aggregate([
            {"$match": {"company_id": company_id}},
            {"$sort": {"created_at": -1}},
            {"$group": {"_id": "$vehicle_id", "disc": {"$first": "$$ROOT"}}},
        ]).to_list(None)
        vehicles = await company_db.vehicles.find(
            {"company_id": company_id, "archived": {"$ne": True}},
            {"_id": 0, "id": 1, "name": 1, "registration": 1},
        ).to_list(None)
        vehicle_by_id = {vehicle["id"]: vehicle for vehicle in vehicles}
        recipients = fleet_notification_recipients(accounts, company_id)
        for row in latest_discs:
            disc = row["disc"]
            vehicle = vehicle_by_id.get(disc.get("vehicle_id"))
            if not vehicle:
                continue
            await base_db.notifications.update_many(
                {
                    "company_id": company_id,
                    "type": "fleet_licence_expiry",
                    "vehicle_id": vehicle["id"],
                    "disc_id": {"$ne": disc["id"]},
                    "archived": {"$ne": True},
                },
                {"$set": {"archived": True, "archived_at": now_iso()}},
            )
            if not vehicle_licence_alert_due(disc.get("expiry_date"), report_date):
                continue
            status = vehicle_licence_disc_status(disc["expiry_date"], report_date)
            for recipient in recipients:
                event_key = f"fleet-licence:{company_id}:{disc['id']}"
                dynamic_fields = {
                    "days_remaining": status["days_remaining"],
                    "licence_status": status["status"],
                    "title": (
                        "VEHICLE LICENCE DISC EXPIRED"
                        if status["status"] == "EXPIRED"
                        else "VEHICLE LICENCE DISC EXPIRING"
                    ),
                    "message": (
                        f"Vehicle: {vehicle.get('registration') or vehicle.get('name')}. "
                        f"Expiry date: {disc['expiry_date']}. "
                        f"Days remaining: {status['days_remaining']}."
                    ),
                }
                notification = {
                    "id": new_id(),
                    "company_id": company_id,
                    "recipient_user_id": recipient["id"],
                    "type": "fleet_licence_expiry",
                    "event_key": event_key,
                    "vehicle_id": vehicle["id"],
                    "vehicle_name": vehicle.get("name", ""),
                    "registration": vehicle.get("registration", ""),
                    "disc_id": disc["id"],
                    "expiry_date": disc["expiry_date"],
                    "action_path": f"/fleet?vehicleId={vehicle['id']}&section=licence",
                    "created_at": now_iso(),
                    "read": False,
                    "dismiss_count": 0,
                    "permanently_dismissed": False,
                    "archived": False,
                }
                await base_db.notifications.update_one(
                    {
                        "company_id": company_id,
                        "event_key": event_key,
                        "recipient_user_id": recipient["id"],
                    },
                    {"$set": dynamic_fields, "$setOnInsert": notification},
                    upsert=True,
                )

async def scheduled_fleet_notification_loop():
    while True:
        try:
            await process_daily_vehicle_licence_alerts()
        except Exception:
            logging.exception("Daily vehicle licence notifications could not be processed")
        now = local_now()
        next_cycle = now.replace(hour=8, minute=0, second=0, microsecond=0)
        if next_cycle <= now:
            next_cycle += timedelta(days=1)
        await asyncio.sleep(max(1, (next_cycle - now).total_seconds()))

class NotificationDismissIn(BaseModel):
    request_id: str = Field(min_length=8, max_length=100)

@api.get("/notifications")
async def get_notifications(
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    query = {
        "company_id": company_id,
        "recipient_user_id": user["id"],
        "archived": {"$ne": True},
        "permanently_dismissed": {"$ne": True},
        "$or": [
            {"hidden_until": {"$exists": False}},
            {"hidden_until": None},
            {"hidden_until": {"$lte": datetime.now(timezone.utc).isoformat()}},
        ],
    }
    total = await base_db.notifications.count_documents(query)
    records = await base_db.notifications.find(query, {"_id": 0}).sort(
        "created_at", -1,
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    unread = await base_db.notifications.count_documents({**query, "read": {"$ne": True}})
    return {"items": records, "page": page, "page_size": page_size, "total": total, "unread": unread}

@api.post("/notifications/{notification_id}/dismiss")
async def dismiss_notification(
    notification_id: str,
    body: NotificationDismissIn,
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    query = {
        "id": notification_id,
        "company_id": company_id,
        "recipient_user_id": user["id"],
        "archived": {"$ne": True},
    }
    notification = await base_db.notifications.find_one(query, {"_id": 0})
    if not notification:
        raise HTTPException(404, "Notification not found")
    if notification.get("permanently_dismissed"):
        return {"ok": True, "dismiss_count": notification.get("dismiss_count", 2), "permanently_dismissed": True}
    hidden_until = notification.get("hidden_until")
    if hidden_until and hidden_until > datetime.now(timezone.utc).isoformat():
        raise HTTPException(409, "This notification can be dismissed again after the next daily reminder")
    last_request_id = notification.get("last_dismiss_request_id")
    if body.request_id == last_request_id:
        return {
            "ok": True,
            "dismiss_count": notification.get("dismiss_count", 0),
            "permanently_dismissed": notification.get("permanently_dismissed", False),
        }
    last_dismissed = notification.get("last_dismissed_at")
    if last_dismissed:
        last_dismissed_at = datetime.fromisoformat(last_dismissed)
        if last_dismissed_at.tzinfo is None:
            last_dismissed_at = last_dismissed_at.replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - last_dismissed_at).total_seconds() < 5:
            return {"ok": True, "dismiss_count": notification.get("dismiss_count", 0), "permanently_dismissed": False}
    dismiss_count = notification.get("dismiss_count", 0) + 1
    now = datetime.now(timezone.utc).isoformat()
    changes = {
        "dismiss_count": dismiss_count,
        "last_dismissed_at": now,
        "last_dismiss_request_id": body.request_id,
        "read": True,
    }
    permanently_dismissed = dismiss_count >= 2
    changes["permanently_dismissed"] = permanently_dismissed
    if not permanently_dismissed:
        changes["hidden_until"] = next_fleet_notification_cycle()
    result = await base_db.notifications.update_one(
        {
            **query,
            "dismiss_count": notification.get("dismiss_count", 0),
            "last_dismiss_request_id": {"$ne": body.request_id},
        },
        {"$set": changes},
    )
    if not result.modified_count:
        latest = await base_db.notifications.find_one(query, {"_id": 0}) or notification
        return {
            "ok": True,
            "dismiss_count": latest.get("dismiss_count", 0),
            "permanently_dismissed": latest.get("permanently_dismissed", False),
        }
    return {"ok": True, "dismiss_count": dismiss_count, "permanently_dismissed": permanently_dismissed}

@api.post("/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: str, user=Depends(get_current_user)):
    company_id = active_company_id.get()
    result = await base_db.notifications.update_one(
        {
            "id": notification_id,
            "company_id": company_id,
            "recipient_user_id": user["id"],
            "archived": {"$ne": True},
        },
        {"$set": {"read": True}},
    )
    if not result.matched_count:
        raise HTTPException(404, "Notification not found")
    return {"ok": True}

@api.post("/notifications/dismiss-all")
async def dismiss_all_notifications(user=Depends(get_current_user)):
    require_global_owner(user)
    result = await base_db.notifications.update_many(
        {
            "company_id": active_company_id.get(),
            "recipient_user_id": user["id"],
            "archived": {"$ne": True},
            "permanently_dismissed": {"$ne": True},
        },
        {
            "$set": {
                "read": True,
                "permanently_dismissed": True,
                "hidden_until": None,
                "dismissed_at": now_iso(),
                "dismissed_by": user["id"],
            },
        },
    )
    return {"ok": True, "dismissed_count": result.modified_count}

class IntercompanyOrderLineIn(BaseModel):
    stock_id: str = Field(min_length=1, max_length=100)
    quantity: float = Field(gt=0, le=1_000_000)

class IntercompanyOrderRequestIn(BaseModel):
    supplying_company_id: str
    items: List[IntercompanyOrderLineIn] = Field(min_length=1, max_length=100)
    notes: Optional[str] = Field(default="", max_length=2000)

class IntercompanyRejectIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)

class IntercompanyReviewIn(BaseModel):
    item_id: str

class IntercompanyPriceIn(BaseModel):
    stock_id: str
    unit_price: float = Field(gt=0)

class IntercompanyCustomerMapIn(BaseModel):
    requesting_company_id: str
    customer_id: str

class IntercompanyInvoiceLineIn(BaseModel):
    item_id: Optional[str] = Field(default=None, min_length=1, max_length=100)
    stock_id: Optional[str] = Field(default=None, min_length=1, max_length=100)
    quantity: float = Field(gt=0, le=1_000_000, allow_inf_nan=False)

    @model_validator(mode="after")
    def require_one_product_source(self):
        if bool(self.item_id) == bool(self.stock_id):
            raise ValueError("Provide either a requested item or a supplier stock item")
        return self

class IntercompanyCreateInvoiceIn(BaseModel):
    send_to_requesting_company: bool
    delivery_fee: float = Field(default=0, ge=0)
    assigned_driver_id: Optional[str] = ""
    items: Optional[List[IntercompanyInvoiceLineIn]] = Field(default=None, min_length=1, max_length=100)

def require_intercompany_company_access(user, company_id, *, administrator=False):
    if company_id not in {profile["id"] for profile in COMPANY_PROFILES}:
        raise HTTPException(404, "Company not found")
    if worker_restrictions_apply(user):
        if company_id != user.get("_active_company_id") or not {"orders", "invoices"}.intersection(
            user.get("worker_allowed_sections") or []
        ):
            raise HTTPException(403, "This worker account cannot access intercompany requests")
        if administrator:
            raise HTTPException(403, "Company administrator access required")
        return
    role = company_role(user, company_id)
    if role not in ("owner", "admin", "user"):
        raise HTTPException(403, "You are not assigned to this company")
    if administrator and role not in ("owner", "admin"):
        raise HTTPException(403, "Company administrator access required")

async def notify_intercompany_company(company_id, event_key, title, message, action_path, extra_user_ids=()):
    accounts = await base_db.users.find(
        {"active": {"$ne": False}},
        {"_id": 0, "id": 1, "email": 1, "role": 1, "company_roles": 1, "is_worker": 1},
    ).to_list(None)
    recipients = {
        account["id"]: account
        for account in fleet_notification_recipients(accounts, company_id)
    }
    for user_id in extra_user_ids:
        account = next((item for item in accounts if item.get("id") == user_id), None)
        if account:
            recipients[user_id] = account
    for recipient_id in recipients:
        await base_db.notifications.update_one(
            {
                "company_id": company_id,
                "event_key": event_key,
                "recipient_user_id": recipient_id,
            },
            {"$setOnInsert": {
                "id": new_id(),
                "company_id": company_id,
                "recipient_user_id": recipient_id,
                "type": "intercompany",
                "event_key": event_key,
                "title": title,
                "message": message,
                "action_path": action_path,
                "created_at": now_iso(),
                "read": False,
                "dismiss_count": 0,
                "permanently_dismissed": False,
                "archived": False,
            }},
            upsert=True,
        )

async def intercompany_available_stock(company_db, company_id, stock_ids):
    if not stock_ids:
        return {}
    rows = await company_db.stock_movements.aggregate([
        {"$match": {"company_id": company_id, "stock_id": {"$in": stock_ids}}},
        {"$project": {
            "stock_id": 1,
            "signed_quantity": {"$multiply": [
                {"$convert": {"input": "$quantity", "to": "double", "onError": 0, "onNull": 0}},
                {"$cond": [
                    {"$in": ["$direction", [1, -1]]},
                    "$direction",
                    {"$cond": [{"$in": ["$type", list(INC_TYPES)]}, 1, -1]},
                ]},
            ]},
        }},
        {"$group": {"_id": "$stock_id", "quantity": {"$sum": "$signed_quantity"}}},
    ]).to_list(None)
    movement_totals = {row["_id"]: row["quantity"] for row in rows}
    stocks = await company_db.stock.find(
        {"company_id": company_id, "id": {"$in": stock_ids}},
        {"_id": 0, "id": 1, "opening": 1},
    ).to_list(None)
    return {
        stock["id"]: r2(D(stock.get("opening", 0)) + D(movement_totals.get(stock["id"], 0)))
        for stock in stocks
    }

def intercompany_price_zone(supplying_company_id, requesting_company_id, customer=None):
    if supplying_company_id != DEFAULT_COMPANY_ID:
        return 1
    if requesting_company_id == WHOLESALERS_COMPANY_ID:
        return 1
    return int((customer or {}).get("default_zone") or 1)

def public_intercompany_request(request, company_id):
    result = dict(request)
    if result.get("requesting_company_id") == company_id and not result.get("invoice_sent"):
        for key in ("invoice_id", "invoice_number", "invoice_total", "invoice_date", "sent_at"):
            result.pop(key, None)
    return result

@api.get("/intercompany/products")
async def get_intercompany_products(
    supplying_company_id: str,
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    user=Depends(get_current_user),
):
    requesting_company_id = active_company_id.get()
    require_intercompany_company_access(user, requesting_company_id)
    if supplying_company_id == requesting_company_id:
        raise HTTPException(400, "Choose another company as the supplier")
    if supplying_company_id not in {profile["id"] for profile in COMPANY_PROFILES}:
        raise HTTPException(400, "Invalid supplying company")
    company_db = tenant_database(client, base_db, supplying_company_id)
    query = {"company_id": supplying_company_id, "archived": {"$ne": True}}
    if q.strip():
        term = re.escape(q.strip()[:80])
        query["$or"] = [
            {"product": {"$regex": term, "$options": "i"}},
            {"size": {"$regex": term, "$options": "i"}},
        ]
    total = await company_db.stock.count_documents(query)
    stock_items = await company_db.stock.find(query, {"_id": 0}).sort(
        [("product", 1), ("size", 1)],
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    stock_ids = [item["id"] for item in stock_items]
    identities = await base_db.product_identifications.find(
        {
            "company_id": supplying_company_id,
            "stock_id": {"$in": stock_ids},
            "active": {"$ne": False},
        },
        {"_id": 0},
    ).to_list(page_size)
    identity_by_stock = {identity["stock_id"]: identity for identity in identities}
    availability = await intercompany_available_stock(company_db, supplying_company_id, stock_ids)
    items = []
    for stock in stock_items:
        identity = identity_by_stock.get(stock["id"])
        items.append({
            "stock_id": stock["id"],
            "product_id": (identity or {}).get("product_id") or stock.get("product_id"),
            "product": stock.get("product", ""),
            "dimensions": stock.get("size", ""),
            "description": (identity or {}).get("description") or stock.get("description", ""),
            "product_type": (identity or {}).get("product_type") or stock.get("product_type", ""),
            "density": (identity or {}).get("density") or stock.get("density"),
            "available_quantity": availability.get(stock["id"], 0),
            "manual_review": not bool((identity or {}).get("product_id") or stock.get("product_id")),
        })
    return {"items": items, "page": page, "page_size": page_size, "total": total}

@api.get("/intercompany/catalog")
async def get_intercompany_supplier_catalog(
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(1, ge=1, le=100),
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    company_db = tenant_database(client, base_db, company_id)
    query = {"company_id": company_id, "archived": {"$ne": True}}
    if q.strip():
        term = re.escape(q.strip()[:80])
        search_options = [
            {"product": {"$regex": term, "$options": "i"}},
            {"size": {"$regex": term, "$options": "i"}},
        ]
        matching_identities = await base_db.product_identifications.find(
            {
                "company_id": company_id,
                "product_type": {"$regex": term, "$options": "i"},
                "active": {"$ne": False},
            },
            {"_id": 0, "stock_id": 1},
        ).to_list(1000)
        matching_stock_ids = [identity["stock_id"] for identity in matching_identities]
        if matching_stock_ids:
            search_options.append({"id": {"$in": matching_stock_ids}})
        query["$or"] = search_options
    total = await company_db.stock.count_documents(query)
    stock_items = await company_db.stock.find(query, {"_id": 0}).sort(
        [("product", 1), ("size", 1)],
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    stock_ids = [item["id"] for item in stock_items]
    identities = await base_db.product_identifications.find(
        {
            "company_id": company_id,
            "stock_id": {"$in": stock_ids},
            "active": {"$ne": False},
        },
        {"_id": 0},
    ).to_list(page_size)
    identity_by_stock = {identity["stock_id"]: identity for identity in identities}
    availability = await intercompany_available_stock(company_db, company_id, stock_ids)
    return {
        "items": [{
            "stock_id": item["id"],
            "product": item.get("product", ""),
            "product_type": (
                identity_by_stock.get(item["id"], {}).get("product_type")
                or item.get("product_type")
                or item.get("product", "")
            ),
            "dimensions": item.get("size", ""),
            "description": (
                identity_by_stock.get(item["id"], {}).get("description")
                or item.get("description", "")
            ),
            "available_quantity": availability.get(item["id"], 0),
        } for item in stock_items],
        "page": page,
        "page_size": page_size,
        "total": total,
    }

@api.get("/intercompany/requests")
async def list_intercompany_requests(
    status: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id)
    query = {"$or": [
        {"requesting_company_id": company_id},
        {"supplying_company_id": company_id},
    ]}
    if status:
        query["status"] = status.upper()
    total = await base_db.intercompany_order_requests.count_documents(query)
    requests = await base_db.intercompany_order_requests.find(query, {"_id": 0}).sort(
        "created_at", -1,
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {
        "items": [public_intercompany_request(item, company_id) for item in requests],
        "page": page,
        "page_size": page_size,
        "total": total,
    }

@api.post("/intercompany/requests")
async def create_intercompany_request(
    body: IntercompanyOrderRequestIn,
    user=Depends(get_current_user),
):
    requesting_company_id = active_company_id.get()
    require_intercompany_company_access(user, requesting_company_id)
    if body.supplying_company_id == requesting_company_id:
        raise HTTPException(400, "Requesting and supplying companies must be different")
    if body.supplying_company_id not in {profile["id"] for profile in COMPANY_PROFILES}:
        raise HTTPException(400, "Invalid supplying company")
    stock_ids = [item.stock_id for item in body.items]
    if len(stock_ids) != len(set(stock_ids)):
        raise HTTPException(400, "Combine repeated product lines into one quantity")
    supplier_db = tenant_database(client, base_db, body.supplying_company_id)
    stock_records = await supplier_db.stock.find({
        "company_id": body.supplying_company_id,
        "id": {"$in": stock_ids},
        "archived": {"$ne": True},
    }, {"_id": 0}).to_list(len(stock_ids))
    stock_by_id = {stock["id"]: stock for stock in stock_records}
    if len(stock_by_id) != len(stock_ids):
        raise HTTPException(400, "One or more selected products do not belong to the supplying company")
    identities = await base_db.product_identifications.find(
        {
            "company_id": body.supplying_company_id,
            "stock_id": {"$in": stock_ids},
            "active": {"$ne": False},
        },
        {"_id": 0},
    ).to_list(len(stock_ids))
    identity_by_stock = {identity["stock_id"]: identity for identity in identities}
    availability = await intercompany_available_stock(supplier_db, body.supplying_company_id, stock_ids)
    lines = []
    for requested in body.items:
        stock = stock_by_id[requested.stock_id]
        identity = identity_by_stock.get(requested.stock_id)
        lines.append({
            "id": new_id(),
            "stock_id": stock["id"],
            "product_id": (identity or {}).get("product_id") or stock.get("product_id"),
            "product": stock.get("product", ""),
            "dimensions": stock.get("size", ""),
            "description": (identity or {}).get("description") or stock.get("description", ""),
            "product_type": (identity or {}).get("product_type") or stock.get("product_type", ""),
            "density": (identity or {}).get("density") or stock.get("density"),
            "quantity": requested.quantity,
            "available_quantity_at_request": availability.get(stock["id"], 0),
            "manual_review": not bool((identity or {}).get("product_id") or stock.get("product_id")),
            "manual_reviewed_by": None,
            "manual_reviewed_at": None,
        })
    request_id = f"ICR-{uuid.uuid4().hex[:12].upper()}"
    company_names = {profile["id"]: profile["name"] for profile in COMPANY_PROFILES}
    record = {
        "id": request_id,
        "requesting_company_id": requesting_company_id,
        "requesting_company_name": company_names[requesting_company_id],
        "supplying_company_id": body.supplying_company_id,
        "supplying_company_name": company_names[body.supplying_company_id],
        "items": lines,
        "notes": (body.notes or "").strip(),
        "status": "PENDING",
        "created_by": user["id"],
        "created_by_name": user.get("name") or user.get("username") or "",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "audit": [{
            "action": "created",
            "at": now_iso(),
            "by": user["id"],
            "company_id": requesting_company_id,
        }],
        "invoice_sent": False,
    }
    try:
        await base_db.intercompany_order_requests.insert_one(record)
    except DuplicateKeyError as error:
        raise HTTPException(409, "Intercompany request ID collision; retry the request") from error
    record.pop("_id", None)
    total_quantity = sum(item["quantity"] for item in lines)
    await notify_intercompany_company(
        body.supplying_company_id,
        f"intercompany:{request_id}:submitted",
        "New Intercompany Order Request",
        f"{request_id} from {record['requesting_company_name']}: {len(lines)} product lines, {total_quantity:g} units.",
        f"/intercompany?requestId={request_id}",
    )
    return record

@api.get("/intercompany/requests/{request_id}")
async def get_intercompany_request(request_id: str, user=Depends(get_current_user)):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id)
    request = await base_db.intercompany_order_requests.find_one(
        {
            "id": request_id,
            "$or": [
                {"requesting_company_id": company_id},
                {"supplying_company_id": company_id},
            ],
        },
        {"_id": 0},
    )
    if not request:
        raise HTTPException(404, "Intercompany request not found")
    return public_intercompany_request(request, company_id)

@api.post("/intercompany/requests/{request_id}/items/review")
async def review_intercompany_request_item(
    request_id: str,
    body: IntercompanyReviewIn,
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    request = await base_db.intercompany_order_requests.find_one({
        "id": request_id,
        "supplying_company_id": company_id,
        "status": "PENDING",
        "items.id": body.item_id,
    }, {"_id": 0})
    if not request:
        raise HTTPException(404, "Pending request item not found")
    item = next((row for row in request["items"] if row["id"] == body.item_id), None)
    if not item:
        raise HTTPException(404, "Request item not found")
    if item.get("manual_review"):
        await base_db.intercompany_order_requests.update_one(
            {"id": request_id, "supplying_company_id": company_id, "status": "PENDING"},
            {
                "$set": {
                    "items.$[item].manual_review": False,
                    "items.$[item].manual_reviewed_by": user["id"],
                    "items.$[item].manual_reviewed_at": now_iso(),
                    "updated_at": now_iso(),
                },
                "$push": {"audit": {
                    "action": "item_manual_reviewed",
                    "item_id": body.item_id,
                    "at": now_iso(),
                    "by": user["id"],
                    "company_id": company_id,
                }},
            },
            array_filters=[{"item.id": body.item_id}],
        )
    return {"ok": True}

@api.post("/intercompany/requests/{request_id}/accept")
async def accept_intercompany_request(request_id: str, user=Depends(get_current_user)):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    request = await base_db.intercompany_order_requests.find_one({
        "id": request_id,
        "supplying_company_id": company_id,
        "status": "PENDING",
    }, {"_id": 0})
    if not request:
        raise HTTPException(404, "Pending intercompany request not found")
    manual_items = [item for item in request["items"] if item.get("manual_review")]
    if manual_items:
        raise HTTPException(409, "Manually review all unmatched product identities before accepting this request")
    supplier_db = tenant_database(client, base_db, company_id)
    stock_ids = [item["stock_id"] for item in request["items"]]
    available = await intercompany_available_stock(supplier_db, company_id, stock_ids)
    shortages = [
        {
            "product": item["product"],
            "dimensions": item["dimensions"],
            "available": available.get(item["stock_id"], 0),
            "requested": item["quantity"],
        }
        for item in request["items"]
        if D(available.get(item["stock_id"], 0)) < D(item["quantity"])
    ]
    if shortages:
        raise HTTPException(409, {"message": "Insufficient supplier stock; no stock was reserved or deducted", "shortages": shortages})
    now = now_iso()
    updated = await base_db.intercompany_order_requests.find_one_and_update(
        {
            "id": request_id,
            "supplying_company_id": company_id,
            "status": "PENDING",
        },
        {
            "$set": {
                "status": "ACCEPTED",
                "accepted_by": user["id"],
                "accepted_at": now,
                "updated_at": now,
            },
            "$push": {"audit": {
                "action": "accepted", "at": now, "by": user["id"], "company_id": company_id,
            }},
        },
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(409, "Request status changed; reload before accepting")
    await notify_intercompany_company(
        updated["requesting_company_id"],
        f"intercompany:{request_id}:accepted",
        "Intercompany Order Request Accepted",
        f"{request_id} was accepted by {updated['supplying_company_name']}.",
        f"/intercompany?requestId={request_id}",
        extra_user_ids=(updated["created_by"],),
    )
    return updated

@api.post("/intercompany/requests/{request_id}/reject")
async def reject_intercompany_request(
    request_id: str,
    body: IntercompanyRejectIn,
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    reason = body.reason.strip()
    if not reason:
        raise HTTPException(400, "A rejection reason is required")
    now = now_iso()
    updated = await base_db.intercompany_order_requests.find_one_and_update(
        {
            "id": request_id,
            "supplying_company_id": company_id,
            "status": "PENDING",
        },
        {
            "$set": {
                "status": "REJECTED",
                "rejection_reason": reason,
                "rejected_by": user["id"],
                "rejected_at": now,
                "updated_at": now,
            },
            "$push": {"audit": {
                "action": "rejected", "at": now, "by": user["id"],
                "company_id": company_id, "reason": reason,
            }},
        },
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(404, "Pending intercompany request not found")
    await notify_intercompany_company(
        updated["requesting_company_id"],
        f"intercompany:{request_id}:rejected",
        "Intercompany Order Request Rejected",
        f"{request_id} was rejected by {updated['supplying_company_name']}: {reason}",
        f"/intercompany?requestId={request_id}",
        extra_user_ids=(updated["created_by"],),
    )
    return updated

@api.post("/intercompany/prices")
async def set_intercompany_price(body: IntercompanyPriceIn, user=Depends(get_current_user)):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    company_db = tenant_database(client, base_db, company_id)
    stock = await company_db.stock.find_one(
        {"id": body.stock_id, "company_id": company_id, "archived": {"$ne": True}},
        {"_id": 0, "id": 1, "product": 1, "size": 1},
    )
    if not stock:
        raise HTTPException(404, "Supplier stock product not found")
    now = now_iso()
    price = await company_db.intercompany_prices.find_one_and_update(
        {"stock_id": body.stock_id, "company_id": company_id},
        {"$set": {
            "unit_price": r2(body.unit_price),
            "updated_at": now,
            "updated_by": user["id"],
            "product": stock.get("product", ""),
            "dimensions": stock.get("size", ""),
        }, "$setOnInsert": {
            "id": new_id(),
            "company_id": company_id,
            "stock_id": body.stock_id,
            "created_at": now,
            "created_by": user["id"],
        }},
        upsert=True,
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    return price

@api.get("/intercompany/prices")
async def list_intercompany_prices(user=Depends(get_current_user)):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    company_db = tenant_database(client, base_db, company_id)
    return await company_db.intercompany_prices.find(
        {"company_id": company_id}, {"_id": 0},
    ).sort("product", 1).to_list(1000)

@api.post("/intercompany/customer-mappings")
async def set_intercompany_customer_mapping(
    body: IntercompanyCustomerMapIn,
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    if body.requesting_company_id == company_id or body.requesting_company_id not in {
        profile["id"] for profile in COMPANY_PROFILES
    }:
        raise HTTPException(400, "Select a different requesting company")
    company_db = tenant_database(client, base_db, company_id)
    customer = await company_db.customers.find_one(
        {"id": body.customer_id, "company_id": company_id, "active": {"$ne": False}},
        {"_id": 0, "id": 1, "name": 1},
    )
    if not customer:
        raise HTTPException(404, "Active intercompany customer record not found")
    now = now_iso()
    mapping = await company_db.intercompany_customer_mappings.find_one_and_update(
        {
            "requesting_company_id": body.requesting_company_id,
            "company_id": company_id,
        },
        {"$set": {
            "customer_id": customer["id"],
            "customer_name": customer["name"],
            "updated_at": now,
            "updated_by": user["id"],
        }, "$setOnInsert": {
            "id": new_id(),
            "company_id": company_id,
            "requesting_company_id": body.requesting_company_id,
            "created_at": now,
            "created_by": user["id"],
        }},
        upsert=True,
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    return mapping

@api.get("/intercompany/customer-mappings")
async def list_intercompany_customer_mappings(user=Depends(get_current_user)):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    company_db = tenant_database(client, base_db, company_id)
    return await company_db.intercompany_customer_mappings.find(
        {"company_id": company_id}, {"_id": 0},
    ).sort("requesting_company_id", 1).to_list(10)

@api.post("/intercompany/requests/{request_id}/invoice")
async def create_intercompany_invoice(
    request_id: str,
    body: IntercompanyCreateInvoiceIn,
    user=Depends(get_current_user),
):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id, administrator=True)
    request = await base_db.intercompany_order_requests.find_one(
        {
            "id": request_id,
            "supplying_company_id": company_id,
            "status": {"$in": ["ACCEPTED", "INVOICE_CREATED", "INVOICE_SENT"]},
        },
        {"_id": 0},
    )
    if not request:
        raise HTTPException(404, "Accepted intercompany request not found")
    company_db = tenant_database(client, base_db, company_id)
    idempotency_key = f"intercompany:{request_id}"
    invoice = await company_db.invoices.find_one(
        {"idempotency_key": idempotency_key}, {"_id": 0},
    )
    if not invoice:
        requested_quantities = {item["id"]: item["quantity"] for item in request["items"]}
        added_stock_items = []
        if body.items is not None:
            submitted_quantities = {}
            for item in body.items:
                if item.item_id:
                    if item.item_id not in requested_quantities or item.item_id in submitted_quantities:
                        raise HTTPException(400, "Invoice quantities must reference each requested product only once")
                    submitted_quantities[item.item_id] = item.quantity
                else:
                    added_stock_items.append(item)
            if set(submitted_quantities) != set(requested_quantities):
                raise HTTPException(400, "Provide an invoice quantity for every requested product")
            added_stock_ids = [item.stock_id for item in added_stock_items]
            if len(added_stock_ids) != len(set(added_stock_ids)):
                raise HTTPException(400, "A supplier stock product can only be added to the invoice once")
        else:
            submitted_quantities = requested_quantities

        mapping = await company_db.intercompany_customer_mappings.find_one(
            {
                "requesting_company_id": request["requesting_company_id"],
                "company_id": company_id,
            },
            {"_id": 0},
        )
        customer = None
        if mapping:
            customer = await company_db.customers.find_one(
                {"id": mapping["customer_id"], "company_id": company_id, "active": {"$ne": False}},
                {"_id": 0},
            )
        else:
            requesting_profile = next(
                profile for profile in COMPANY_PROFILES
                if profile["id"] == request["requesting_company_id"]
            )
            customer_names = {requesting_profile["name"], requesting_profile["username"]}
            customer = await company_db.customers.find_one(
                {
                    "name": {"$in": list(customer_names)},
                    "company_id": company_id,
                    "active": {"$ne": False},
                },
                {"_id": 0},
            )
        if not customer:
            raise HTTPException(
                409,
                "Add an active customer record for the requesting company before creating its invoice",
            )
        stock_ids = [item["stock_id"] for item in request["items"]]
        zone = intercompany_price_zone(
            company_id, request["requesting_company_id"], customer,
        )
        invoice_items = []
        for item in request["items"]:
            invoice_quantity = submitted_quantities[item["id"]]
            resolved = await resolve_price(
                zone,
                item.get("product_type") or item["product"],
                item["dimensions"],
            )
            if not resolved["found"] or resolved["price"] is None:
                raise HTTPException(
                    409,
                    f"No confirmed saved price for {item['product']} {item['dimensions']} in zone {zone}",
                )
            invoice_items.append({
                "qty": invoice_quantity,
                "category": item.get("product_type") or item["product"],
                "size": item["dimensions"],
                "description": item.get("description") or item["product"],
                "unit_price": resolved["price"],
            })
        for item in added_stock_items:
            stock = await company_db.stock.find_one(
                {
                    "id": item.stock_id,
                    "company_id": company_id,
                    "archived": {"$ne": True},
                },
                {"_id": 0},
            )
            if not stock:
                raise HTTPException(400, "An added product is no longer available in supplier stock")
            identity = await base_db.product_identifications.find_one(
                {
                    "company_id": company_id,
                    "stock_id": item.stock_id,
                    "active": {"$ne": False},
                },
                {"_id": 0},
            )
            category = (identity or {}).get("product_type") or stock.get("product_type") or stock.get("product", "")
            size = stock.get("size", "")
            if not category or not size:
                raise HTTPException(400, "An added supplier product is missing its category or dimensions")
            resolved = await resolve_price(zone, category, size)
            if not resolved["found"] or resolved["price"] is None:
                raise HTTPException(
                    409,
                    f"No confirmed saved price for {stock.get('product', category)} {size} in zone {zone}",
                )
            invoice_items.append({
                "qty": item.quantity,
                "category": category,
                "size": size,
                "description": (identity or {}).get("description") or stock.get("description") or stock.get("product", ""),
                "unit_price": resolved["price"],
            })
        if body.assigned_driver_id:
            driver = await company_db.drivers.find_one(
                {"id": body.assigned_driver_id, "company_id": company_id, "active": {"$ne": False}},
                {"_id": 0, "id": 1},
            )
            if not driver:
                raise HTTPException(400, "Assigned driver is not active in the supplying company")
        invoice_body = InvoiceIn(
            customer_id=customer["id"],
            customer_name=customer["name"],
            client_number=customer.get("client_number", ""),
            zone=zone,
            reference=f"Intercompany {request_id}",
            notes=f"Generated from intercompany order request {request_id}",
            items=invoice_items,
            delivery_fee=body.delivery_fee,
            assigned_driver_id=body.assigned_driver_id or "",
            status="issued",
            invoice_type="standard",
            intercompany_request_id=request_id,
            idempotency_key=idempotency_key,
            made_by=(user.get("name") or user.get("email") or user.get("username") or "Intercompany").strip(),
            deduct_stock=True,
        )
        invoice = await create_invoice(invoice_body, user=user)
        now = now_iso()
        quantity_changes = [
            {
                "item_id": item["id"],
                "product": item["product"],
                "dimensions": item["dimensions"],
                "requested_quantity": item["quantity"],
                "invoice_quantity": submitted_quantities[item["id"]],
            }
            for item in request["items"]
            if submitted_quantities[item["id"]] != item["quantity"]
        ]
        if quantity_changes:
            await base_db.intercompany_order_requests.update_one(
                {"id": request_id, "supplying_company_id": company_id},
                {
                    "$set": {"invoice_quantities": submitted_quantities, "updated_at": now},
                    "$push": {"audit": {
                        "action": "invoice_quantities_changed",
                        "at": now,
                        "by": user["id"],
                        "company_id": company_id,
                        "changes": quantity_changes,
                    }},
                },
            )
    sent_now = body.send_to_requesting_company and not request.get("invoice_sent")
    now = now_iso()
    new_status = "INVOICE_SENT" if body.send_to_requesting_company else "INVOICE_CREATED"
    await base_db.intercompany_order_requests.update_one(
        {"id": request_id, "supplying_company_id": company_id},
        {
            "$set": {
                "status": new_status if body.send_to_requesting_company else (
                    request.get("status") if request.get("invoice_sent") else "INVOICE_CREATED"
                ),
                "invoice_id": invoice["id"],
                "invoice_number": invoice.get("number"),
                "invoice_date": invoice.get("date"),
                "invoice_total": invoice.get("total"),
                "invoice_created_by": user["id"],
                "invoice_created_at": invoice.get("created_at") or invoice.get("issued_at") or now,
                "invoice_sent": bool(request.get("invoice_sent") or body.send_to_requesting_company),
                "sent_at": (request.get("sent_at") or now) if body.send_to_requesting_company else request.get("sent_at"),
                "updated_at": now,
            },
            "$push": {"audit": {
                "action": "invoice_sent" if body.send_to_requesting_company else "invoice_created",
                "invoice_id": invoice["id"],
                "invoice_number": invoice.get("number"),
                "at": now,
                "by": user["id"],
                "company_id": company_id,
            }},
        },
    )
    if sent_now:
        await notify_intercompany_company(
            request["requesting_company_id"],
            f"intercompany:{request_id}:invoice-sent",
            "Intercompany Invoice Sent",
            f"Invoice {invoice.get('number') or '—'} for request {request_id} is available.",
            f"/intercompany?requestId={request_id}",
            extra_user_ids=(request["created_by"],),
        )
    return {
        "invoice": invoice,
        "sent": bool(request.get("invoice_sent") or body.send_to_requesting_company),
        "status": new_status if body.send_to_requesting_company else "INVOICE_CREATED",
    }

@api.get("/intercompany/requests/{request_id}/invoice")
async def get_intercompany_request_invoice(request_id: str, user=Depends(get_current_user)):
    company_id = active_company_id.get()
    require_intercompany_company_access(user, company_id)
    request = await base_db.intercompany_order_requests.find_one(
        {
            "id": request_id,
            "$or": [
                {"requesting_company_id": company_id},
                {"supplying_company_id": company_id},
            ],
        },
        {"_id": 0},
    )
    if not request:
        raise HTTPException(404, "Intercompany request not found")
    is_supplier = request["supplying_company_id"] == company_id
    if not is_supplier and not request.get("invoice_sent"):
        raise HTTPException(404, "Invoice has not been sent to the requesting company")
    if not request.get("invoice_id"):
        raise HTTPException(404, "Invoice has not been created")
    supplier_db = tenant_database(client, base_db, request["supplying_company_id"])
    invoice = await supplier_db.invoices.find_one(
        {"id": request["invoice_id"], "intercompany_request_id": request_id},
        {"_id": 0},
    )
    if not invoice:
        raise HTTPException(404, "Linked invoice not found")
    invoice.pop("audit", None)
    payments = await supplier_db.payments.find(
        {
            "invoice_id": invoice["id"],
            "reversed": {"$ne": True},
            "archived": {"$ne": True},
        },
        {"_id": 0, "amount": 1},
    ).to_list(None)
    invoice["amount_paid"] = r2(dsum(payment.get("amount", 0) for payment in payments))
    compute_invoice(invoice)
    invoice["status"] = derive_status(invoice)

    stored_settings = await supplier_db.settings.find_one(
        {"id": "singleton"}, {"_id": 0},
    ) or {}
    settings_defaults = {
        **seed_data.DEFAULT_SETTINGS,
        **COMPANY_INVOICE_DETAILS.get(request["supplying_company_id"], {}),
    }
    settings = {
        key: stored_settings.get(key, settings_defaults.get(key, ""))
        for key in (
            "company_name", "address", "telephone", "email",
            "tax_number", "banking_details",
        )
    }
    settings["unified_price_list"] = uses_unified_price_list(
        request["supplying_company_id"],
    )
    customer = await supplier_db.customers.find_one(
        {
            "id": invoice.get("customer_id"),
            "company_id": request["supplying_company_id"],
        },
        {"_id": 0, "id": 1, "address": 1, "city": 1, "phone": 1, "email": 1},
    ) if invoice.get("customer_id") else None
    return {"invoice": invoice, "settings": settings, "customer": customer or {}}

@api.get("/vehicles")
async def get_vehicles(user=Depends(get_current_user)):
    vehicles = await listall("vehicles", {"archived": {"$ne": True}}, sort=("name", 1))
    filters = vehicle_operational_filters()
    order_vehicle_ids, delivery_vehicle_ids, maintenance_vehicle_ids = await asyncio.gather(
        db.orders.distinct("vehicle_id", filters["orders"]),
        db.deliveries.distinct("vehicle_id", filters["deliveries"]),
        db.vehicle_records.distinct("vehicle_id", filters["maintenance"]),
    )
    assigned_vehicle_ids = set(order_vehicle_ids) | set(delivery_vehicle_ids)
    assigned_vehicle_ids.discard(None)
    assigned_vehicle_ids.discard("")
    maintenance_vehicle_ids = set(maintenance_vehicle_ids)
    assigned_driver_ids = {
        vehicle.get("assigned_driver_id")
        for vehicle in vehicles
        if vehicle.get("assigned_driver_id")
    }
    driver_rows = await db.drivers.find(
        {"id": {"$in": list(assigned_driver_ids)}},
        {"_id": 0, "id": 1, "name": 1},
    ).to_list(len(assigned_driver_ids)) if assigned_driver_ids else []
    driver_by_id = {driver["id"]: driver for driver in driver_rows}
    licence_rows = await db.vehicle_licence_discs.aggregate([
        {"$sort": {"created_at": -1}},
        {"$group": {"_id": "$vehicle_id", "licence_disc": {"$first": {
            "id": "$id", "disc_number": "$disc_number", "issue_date": "$issue_date",
            "expiry_date": "$expiry_date", "created_at": "$created_at",
        }}}},
    ]).to_list(None)
    licence_by_vehicle = {row["_id"]: row["licence_disc"] for row in licence_rows}
    for vehicle in vehicles:
        vehicle.pop("assignment_history", None)
        driver = driver_by_id.get(vehicle.get("assigned_driver_id"))
        vehicle["assigned_driver"] = driver
        vehicle["assigned_to_work"] = vehicle["id"] in assigned_vehicle_ids
        vehicle["maintenance_due"] = vehicle["id"] in maintenance_vehicle_ids
        vehicle["is_free"] = vehicle_is_free(
            vehicle,
            assigned_vehicle_ids | maintenance_vehicle_ids,
        )
        disc = licence_by_vehicle.get(vehicle["id"])
        vehicle["licence_disc"] = {
            **disc, **vehicle_licence_disc_status(disc.get("expiry_date")),
        } if disc else None
    return vehicles

@api.get("/vehicles/assignment-drivers")
async def list_vehicle_assignment_drivers(
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(1, ge=1, le=100),
    user=Depends(get_current_user),
):
    query = {"active": {"$ne": False}}
    if q.strip():
        term = re.escape(q.strip()[:80])
        query["name"] = {"$regex": term, "$options": "i"}
    total = await db.drivers.count_documents(query)
    drivers = await db.drivers.find(query, {"_id": 0, "id": 1, "name": 1}).sort(
        "name", 1,
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {"items": drivers, "page": page, "page_size": page_size, "total": total}

@api.post("/vehicles/{vid}/driver-assignment")
async def assign_vehicle_driver(
    vid: str,
    body: VehicleDriverAssignmentIn,
    user=Depends(get_current_user),
):
    vehicle = await db.vehicles.find_one(
        {"id": vid, "archived": {"$ne": True}}, {"_id": 0},
    )
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")
    driver_id = (body.driver_id or "").strip()
    if driver_id:
        driver = await db.drivers.find_one(
            {"id": driver_id, "active": {"$ne": False}}, {"_id": 0, "id": 1, "name": 1},
        )
        if not driver:
            raise HTTPException(404, "Active driver not found")
        existing_assignment = await db.vehicles.find_one(
            {
                "id": {"$ne": vid},
                "assigned_driver_id": driver_id,
                "archived": {"$ne": True},
            },
            {"_id": 0, "id": 1, "name": 1},
        )
        if existing_assignment:
            raise HTTPException(409, f"Driver is already assigned to {existing_assignment.get('name', 'another vehicle')}")
    else:
        driver = None
    previous_driver_id = vehicle.get("assigned_driver_id")
    if previous_driver_id == (driver["id"] if driver else None):
        return vehicle
    if not previous_driver_id and not driver:
        return vehicle
    previous_driver = await db.drivers.find_one(
        {"id": previous_driver_id}, {"_id": 0, "name": 1},
    ) if previous_driver_id else None
    event = {
        "id": new_id(),
        "action": "assigned" if driver and not previous_driver_id else (
            "unassigned" if not driver else "reassigned"
        ),
        "previous_driver_id": previous_driver_id,
        "previous_driver_name": (previous_driver or {}).get("name", ""),
        "driver_id": driver["id"] if driver else None,
        "driver_name": driver["name"] if driver else "",
        "notes": (body.notes or "").strip(),
        "at": now_iso(),
        "by": user["id"],
    }
    update = {"$push": {"assignment_history": event}}
    if driver:
        update["$set"] = {
            "assigned_driver_id": driver["id"],
            "assigned_driver_name": driver["name"],
        }
    else:
        update["$unset"] = {
            "assigned_driver_id": "",
            "assigned_driver_name": "",
        }
    update_filter = {"id": vid, "archived": {"$ne": True}}
    if previous_driver_id:
        update_filter["assigned_driver_id"] = previous_driver_id
    else:
        update_filter["$or"] = [
            {"assigned_driver_id": {"$exists": False}},
            {"assigned_driver_id": None},
        ]
    try:
        updated = await db.vehicles.find_one_and_update(
            update_filter,
            update,
            projection={"_id": 0, "assignment_history": 0},
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError as error:
        raise HTTPException(409, "That driver has already been assigned to another vehicle") from error
    if not updated:
        raise HTTPException(409, "Vehicle changed; reload before assigning a driver")
    audit_before = {key: value for key, value in vehicle.items() if key != "assignment_history"}
    await log_audit("vehicle", vid, "driver_assigned", user, before=audit_before, after=updated)
    return updated

@api.get("/vehicles/{vid}/assignment-history")
async def get_vehicle_assignment_history(
    vid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(1, ge=1, le=50),
    user=Depends(get_current_user),
):
    vehicle = await db.vehicles.find_one(
        {"id": vid, "archived": {"$ne": True}},
        {"_id": 0, "assignment_history": 1},
    )
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")
    history = list(reversed(vehicle.get("assignment_history") or []))
    start = (page - 1) * page_size
    return {
        "items": history[start:start + page_size],
        "page": page,
        "page_size": page_size,
        "total": len(history),
    }

@api.get("/vehicles/summary")
async def get_vehicle_summaries(user=Depends(get_current_user)):
    rows = await db.vehicle_records.aggregate([
        {"$match": {"archived": {"$ne": True}, "vehicle_id": {"$nin": ["", None]}}},
        {"$group": {
            "_id": {
                "vehicle_id": "$vehicle_id",
                "type": "$type",
                "status": "$status",
            },
            "amount": {"$sum": {"$convert": {
                "input": "$amount", "to": "double", "onError": 0, "onNull": 0,
            }}},
            "count": {"$sum": 1},
        }},
    ]).to_list(None)
    return [{
        "vehicle_id": row["_id"]["vehicle_id"],
        "type": row["_id"].get("type"),
        "status": row["_id"].get("status"),
        "amount": row["amount"],
        "count": row["count"],
    } for row in rows]

@api.get("/vehicles/{vid}/records/history")
async def get_vehicle_record_history(
    vid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
    user=Depends(get_current_user),
):
    if not await db.vehicles.find_one({"id": vid, "archived": {"$ne": True}}, {"_id": 0, "id": 1}):
        raise HTTPException(404, "Vehicle not found")
    query = {"vehicle_id": vid}
    collection = db.vehicle_records
    total = await collection.count_documents(query)
    records = await collection.find(query, {"_id": 0}).sort(
        "date", -1,
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {"items": records, "page": page, "page_size": page_size, "total": total}

@api.get("/vehicles/{vid}/licence-discs")
async def get_vehicle_licence_discs(
    vid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    user=Depends(get_current_user),
):
    if not await db.vehicles.find_one({"id": vid, "archived": {"$ne": True}}, {"_id": 0, "id": 1}):
        raise HTTPException(404, "Vehicle not found")
    query = {"vehicle_id": vid}
    collection = db.vehicle_licence_discs
    total = await collection.count_documents(query)
    records = await collection.find(query, {"_id": 0, "document_base64": 0}).sort(
        "created_at", -1,
    ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    for record in records:
        record.update(vehicle_licence_disc_status(record.get("expiry_date")))
    return {"items": records, "page": page, "page_size": page_size, "total": total}

@api.post("/vehicles/{vid}/licence-discs")
async def add_vehicle_licence_disc(
    vid: str,
    body: VehicleLicenceDiscIn,
    user=Depends(get_current_user),
):
    if not await db.vehicles.find_one({"id": vid, "archived": {"$ne": True}}, {"_id": 0, "id": 1}):
        raise HTTPException(404, "Vehicle not found")
    try:
        document = base64.b64decode(body.document_base64, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise HTTPException(400, "Licence disc document is not valid base64") from error
    if not document or len(document) > 5 * 1024 * 1024:
        raise HTTPException(400, "Licence disc document must be between 1 byte and 5 MB")
    signatures = {
        "application/pdf": document.startswith(b"%PDF-"),
        "image/jpeg": document.startswith(b"\xff\xd8\xff"),
        "image/png": document.startswith(b"\x89PNG\r\n\x1a\n"),
    }
    if not signatures[body.document_content_type]:
        raise HTTPException(400, "The uploaded file does not match its declared type")
    if body.issue_date and body.issue_date > body.expiry_date:
        raise HTTPException(400, "Issue date cannot be after expiry date")
    record = {
        "id": new_id(),
        "vehicle_id": vid,
        "disc_number": body.disc_number,
        "issue_date": body.issue_date,
        "expiry_date": body.expiry_date,
        "document_name": body.document_name,
        "document_content_type": body.document_content_type,
        "document_base64": body.document_base64,
        "document_size": len(document),
        "created_at": now_iso(),
        "created_by": user["id"],
    }
    try:
        await db.vehicle_licence_discs.insert_one(record)
    except DuplicateKeyError as error:
        raise HTTPException(409, "A licence disc expiry event already exists for this vehicle and date") from error
    await log_audit("vehicle", vid, "licence_disc_registered", user, after={
        key: value for key, value in record.items()
        if key != "document_base64"
    })
    return {
        **{key: value for key, value in record.items() if key != "document_base64"},
        **vehicle_licence_disc_status(record["expiry_date"]),
    }

@api.get("/vehicles/{vid}/licence-discs/{disc_id}/document")
async def get_vehicle_licence_disc_document(vid: str, disc_id: str, user=Depends(get_current_user)):
    record = await db.vehicle_licence_discs.find_one(
        {"id": disc_id, "vehicle_id": vid}, {"_id": 0},
    )
    if not record:
        raise HTTPException(404, "Licence disc document not found")
    document = base64.b64decode(record["document_base64"], validate=True)
    safe_filename = re.sub(r"[^A-Za-z0-9._ -]", "_", record["document_name"]).strip(" .") or "licence-document"
    return StreamingResponse(
        iter([document]),
        media_type=record["document_content_type"],
        headers={
            "Content-Disposition": f'inline; filename="{safe_filename}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )

@api.post("/vehicles")
async def add_vehicle(body: VehicleIn, user=Depends(get_current_user)):
    rec = await insert("vehicles", body.model_dump())
    await emit_workflow_event("vehicle.created", rec)
    return rec

@api.put("/vehicles/{vid}")
async def edit_vehicle(vid: str, body: VehicleIn, user=Depends(get_current_user)):
    rec = await update_doc("vehicles", vid, body.model_dump())
    await emit_workflow_event("vehicle.updated", rec)
    return rec

@api.delete("/vehicles/{vid}")
async def delete_vehicle(vid: str, user=Depends(get_current_user)):
    vehicle = await db.vehicles.find_one({"id": vid}, {"_id": 0})
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")
    updated = await update_doc("vehicles", vid, {
        "archived": True, "archived_at": now_iso(), "archived_by": user.get("id"),
    })
    await log_audit("vehicle", vid, "archived", user, before=vehicle, after=updated)
    await emit_workflow_event("vehicle.archived", updated)
    return {"ok": True, "archived": True}

# ---------------- Deliveries ----------------
class DeliveryIn(BaseModel):
    reference: Optional[str] = ""
    customer_id: Optional[str] = ""
    customer_name: Optional[str] = ""
    destination: str = ""
    size: str = "small"
    products: Optional[str] = ""
    driver_id: Optional[str] = ""
    vehicle_id: Optional[str] = ""
    planned_departure: Optional[str] = None
    actual_departure: Optional[str] = None
    estimated_arrival: Optional[str] = None
    actual_arrival: Optional[str] = None
    status: str = "Planned"
    notes: Optional[str] = ""
    cash_collected: float = Field(default=0, ge=0)
    items: List[dict] = []  # [{stock_id, product, size, qty}]

    @field_validator("status")
    @classmethod
    def valid_delivery_status(cls, value):
        allowed = ("Planned", "Assigned", "Ready", "Dispatched", "Partially Delivered", "Delivered", "Cancelled", "Failed")
        if value not in allowed:
            raise ValueError(f"Status must be one of: {', '.join(allowed)}")
        return value

@api.get("/deliveries")
async def get_deliveries(include_archived: bool = False, user=Depends(get_current_user)):
    flt = {} if include_archived else {"archived": {"$ne": True}}
    return await listall("deliveries", flt, sort=("created_at", -1))

@api.post("/deliveries")
async def add_delivery(body: DeliveryIn, user=Depends(get_current_user)):
    d = body.model_dump()
    if not d.get("reference"):
        d["reference"] = await next_ref("del", "DEL")
    if d.get("customer_id"):
        cust = await db.customers.find_one({"id": d["customer_id"]})
        if cust:
            d["customer_name"] = cust["name"]
    d["dispatched"] = False
    rec = await insert("deliveries", d)
    await emit_workflow_event("delivery.created", rec)
    return rec

@api.delete("/deliveries/{did}")
async def delete_delivery(did: str, user=Depends(get_current_user)):
    existing = await db.deliveries.find_one({"id": did}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Delivery not found")
    if existing.get("dispatching"):
        raise HTTPException(409, "Delivery is being dispatched; try again after the operation completes")
    if existing.get("dispatched"):
        raise HTTPException(409, "A dispatched delivery cannot be cancelled because stock was deducted")
    updated = await update_doc("deliveries", did, {
        "status": "Cancelled",
    })
    await log_audit("delivery", did, "cancelled", user, before=existing, after=updated)
    if existing.get("status") != updated.get("status"):
        await emit_workflow_event("delivery.status_changed", updated)
    return {"ok": True, "cancelled": True}

@api.put("/deliveries/{did}")
async def edit_delivery(did: str, body: DeliveryIn, user=Depends(get_current_user)):
    existing = await db.deliveries.find_one({"id": did})
    if not existing:
        raise HTTPException(404, "Not found")
    d = body.model_dump()
    d["reference"] = existing.get("reference")
    d["dispatched"] = existing.get("dispatched", False)
    if existing.get("dispatched"):
        d["items"] = existing.get("items", [])
        if d["status"] in ("Planned", "Assigned", "Ready"):
            raise HTTPException(400, "A dispatched delivery cannot go back to a pre-dispatch status. Record a return instead")
    elif d["status"] in ("Dispatched", "Partially Delivered", "Delivered"):
        raise HTTPException(400, "Use the Dispatch action first — it checks and deducts stock once")
    if d.get("customer_id"):
        cust = await db.customers.find_one({"id": d["customer_id"]})
        if cust:
            d["customer_name"] = cust["name"]
    rec = await update_doc("deliveries", did, d)
    if existing.get("status") != rec.get("status"):
        await log_audit("delivery", did, "status_changed", user, before={"status": existing.get("status")}, after={"status": rec.get("status")})
        await emit_workflow_event("delivery.status_changed", rec)
    return rec

@api.post("/deliveries/{did}/dispatch")
async def dispatch_delivery(did: str, user=Depends(get_current_user)):
    d = await db.deliveries.find_one({"id": did}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Not found")
    if d.get("status") in ("Cancelled", "Failed"):
        raise HTTPException(400, f"Cannot dispatch a {d['status'].lower()} delivery")
    claimed = await db.deliveries.find_one_and_update(
        {"id": did, "dispatched": {"$ne": True}, "dispatching": {"$ne": True}}, {"$set": {"dispatching": True}})
    if not claimed:
        raise HTTPException(400, "This delivery has already been dispatched (stock deducted once)")
    try:
        need = {}
        for it in d.get("items", []):
            if it.get("stock_id") and (it.get("qty") or 0) > 0:
                need[it["stock_id"]] = D(need.get(it["stock_id"], 0)) + D(it["qty"])
        if not need:
            raise HTTPException(400, "Add at least one stock item to dispatch")
        async with StockLock(need.keys()):
            stocks = {}
            for sid, qty in need.items():
                s = await db.stock.find_one({"id": sid}, {"_id": 0})
                if not s:
                    raise HTTPException(400, "A dispatch item references a missing stock product")
                await stock_current(s)
                if qty > D(s["current"]):
                    raise HTTPException(400, f"Insufficient stock for {s['product']} {s['size']}: available {s['current']}, needed {float(qty):g}")
                stocks[sid] = s
            for sid, qty in need.items():
                try:
                    await post_movement(stocks[sid], "dispatch", float(qty), user, f"Dispatch {d['reference']}", d["reference"],
                                        dedupe_key=f"dispatch:{did}:{sid}", allow_negative=True, extra={"delivery_id": did})
                except DuplicateKeyError:
                    pass
        upd = {"status": "Dispatched", "dispatched": True, "dispatched_at": now_iso(),
               "actual_departure": d.get("actual_departure") or local_now().strftime("%Y-%m-%dT%H:%M")}
        rec = await update_doc("deliveries", did, upd)
        await log_audit("delivery", did, "dispatched", user, after={"items": d.get("items")})
        if d.get("status") != rec.get("status"):
            await emit_workflow_event("delivery.status_changed", rec)
        await emit_workflow_event("delivery.dispatched", rec)
        return rec
    finally:
        await db.deliveries.update_one({"id": did}, {"$unset": {"dispatching": ""}})

@api.get("/deliveries/recommend")
async def recommend_driver(size: str = "small", user=Depends(get_current_user)):
    drivers = await listall("drivers", {"active": True})
    recs = []
    for dr in drivers:
        reason = []
        score = 0
        if size == "large" and dr.get("size_pref") == "large":
            score += 3; reason.append("Prefers larger / long-distance deliveries")
        elif size in ("small", "medium") and dr.get("size_pref") == "small":
            score += 3; reason.append("Prefers small & medium deliveries")
        else:
            score += 1; reason.append("Can handle this delivery when needed")
        recs.append({"driver_id": dr["id"], "name": dr["name"], "score": score, "reason": "; ".join(reason)})
    recs.sort(key=lambda x: -x["score"])
    return recs

# ---------------- Settings ----------------
INTERFACE_NAV_GROUPS = {
    "overview": ("dashboard",),
    "sales": ("customers", "orders", "invoices", "client-payments"),
    "express": ("express-invoices", "express-client-payments"),
    "purchasing": ("intercompany", "grv", "suppliers", "buyings"),
    "operations": ("stock", "fleet"),
    "company-inventory": ("company-inventory",),
    "production": ("production", "chemicals-quantity", "chemical-usage-log"),
    "warehouses": ("warehouse-a", "warehouse-b", "warehouse-c", "warehouse-chemical", "warehouse-chemical-inventory"),
    "finance-team": ("expenses", "daily-report", "attendance"),
    "administration": ("settings",),
}
INTERFACE_SECTIONS = {
    section for sections in INTERFACE_NAV_GROUPS.values() for section in sections
}
INTERFACE_CUSTOM_LINKS = {
    "/": "dashboard",
    "/customers": "customers",
    "/orders": "orders",
    "/invoices": "invoices",
    "/client-payments": "client-payments",
    "/express-invoices": "express-invoices",
    "/express-client-payments": "express-client-payments",
    "/intercompany": "intercompany",
    "/grv": "grv",
    "/suppliers": "suppliers",
    "/buyings": "buyings",
    "/stock": "stock",
    "/fleet": "fleet",
    "/company-inventory": "company-inventory",
    "/production": "production",
    "/warehouses/chemical-inventory": "chemicals-quantity",
    "/warehouses/chemical": "chemical-usage-log",
    "/warehouses/A": "warehouse-a",
    "/warehouses/B": "warehouse-b",
    "/warehouses/C": "warehouse-c",
    "/expenses": "expenses",
    "/daily-report": "daily-report",
    "/attendance": "attendance",
    "/settings": "settings",
}
INTERFACE_CUSTOM_LINK_COMPANIES = {
    "/production": {"superiqfoam"},
    "/warehouses/A": {"iqfoam-manufactoring"},
    "/warehouses/B": {"iqfoam-manufactoring"},
    "/warehouses/C": {"iqfoam-manufactoring"},
}
INTERFACE_CONFIG_KEYS = {
    "hidden_sections", "section_labels", "group_labels", "group_order", "section_order",
    "custom_sections",
}


def normalize_interface_config(config, company_id=None, allow_legacy_fields=False):
    if not isinstance(config, dict):
        raise HTTPException(422, "Interface settings must be an object")
    unknown_keys = set(config) - INTERFACE_CONFIG_KEYS - {
        "id", "updated_at", "updated_by", "company_id", "_id",
    }
    if unknown_keys and not allow_legacy_fields:
        raise HTTPException(422, "Interface settings contain unsupported fields")

    def labels_for(key, allowed):
        labels = config.get(key, {})
        if not isinstance(labels, dict):
            raise HTTPException(422, f"{key} must be an object")
        if any(not isinstance(name, str) or name not in allowed for name in labels):
            raise HTTPException(422, f"{key} contains an unknown menu item")
        normalized = {}
        for name, value in labels.items():
            if not isinstance(value, str) or len(value.strip()) > 48:
                raise HTTPException(422, f"{key} values must be text no longer than 48 characters")
            value = value.strip()
            if value:
                normalized[name] = value
        return normalized

    group_order = config.get("group_order", [])
    if not isinstance(group_order, list) or any(
        not isinstance(group, str) or group not in INTERFACE_NAV_GROUPS
        for group in group_order
    ):
        raise HTTPException(422, "Interface settings contain an unknown menu group")
    group_order = list(dict.fromkeys(group_order))
    group_order.extend(group for group in INTERFACE_NAV_GROUPS if group not in group_order)

    supplied_section_order = config.get("section_order", {})
    if not isinstance(supplied_section_order, dict) or any(
        not isinstance(group, str) or group not in INTERFACE_NAV_GROUPS
        for group in supplied_section_order
    ):
        raise HTTPException(422, "Section order contains an unknown menu group")
    section_order = {}
    for group, sections in INTERFACE_NAV_GROUPS.items():
        custom_order = supplied_section_order.get(group, [])
        if not isinstance(custom_order, list) or any(
            not isinstance(section, str) or section not in sections
            for section in custom_order
        ):
            raise HTTPException(422, f"Section order contains an invalid section for {group}")
        ordered = list(dict.fromkeys(custom_order))
        ordered.extend(section for section in sections if section not in ordered)
        section_order[group] = ordered

    custom_sections = config.get("custom_sections", [])
    if not isinstance(custom_sections, list) or len(custom_sections) > 20:
        raise HTTPException(422, "Create no more than 20 custom menu sections")
    normalized_custom_sections = []
    seen_custom_ids = set()
    for section in custom_sections:
        if not isinstance(section, dict) or set(section) - {
            "id", "label", "path", "access_section",
        }:
            raise HTTPException(422, "Custom menu section contains unsupported fields")
        section_id = section.get("id")
        label = section.get("label")
        path = section.get("path")
        if not isinstance(section_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", section_id):
            raise HTTPException(422, "Custom menu section has an invalid ID")
        if section_id in seen_custom_ids:
            raise HTTPException(422, "Custom menu section IDs must be unique")
        seen_custom_ids.add(section_id)
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > 48:
            raise HTTPException(422, "Custom menu labels must contain 1 to 48 characters")
        if not isinstance(path, str) or path not in INTERFACE_CUSTOM_LINKS:
            raise HTTPException(422, "Custom menu section must link to an existing application page")
        allowed_companies = INTERFACE_CUSTOM_LINK_COMPANIES.get(path)
        if allowed_companies and company_id and company_id not in allowed_companies:
            raise HTTPException(422, "Custom menu destination is not available in this company profile")
        access_section = INTERFACE_CUSTOM_LINKS[path]
        if section.get("access_section", access_section) != access_section:
            raise HTTPException(422, "Custom menu section permissions do not match its destination")
        normalized_custom_sections.append({
            "id": section_id,
            "label": label.strip(),
            "path": path,
            "access_section": access_section,
        })

    custom_section_ids = {f"custom:{section['id']}" for section in normalized_custom_sections}
    hidden_sections = config.get("hidden_sections", [])
    if not isinstance(hidden_sections, list) or any(
        not isinstance(section, str)
        or (
            section not in INTERFACE_SECTIONS
            and section not in custom_section_ids
        )
        for section in hidden_sections
    ):
        raise HTTPException(422, "Interface settings contain an unknown menu section")

    return {
        "hidden_sections": list(dict.fromkeys(hidden_sections)),
        "section_labels": labels_for("section_labels", INTERFACE_SECTIONS),
        "group_labels": labels_for("group_labels", INTERFACE_NAV_GROUPS),
        "group_order": group_order,
        "section_order": section_order,
        "custom_sections": normalized_custom_sections,
    }


@api.get("/interface-settings")
async def get_interface_settings(
    user=Depends(get_current_user), company_id: Optional[str] = None,
):
    company_id = _interface_settings_company_id(company_id, user)
    saved = await base_db.interface_settings.find_one({"id": company_id}, {"_id": 0})
    if not saved and company_id == DEFAULT_COMPANY_ID:
        saved = await base_db.interface_settings.find_one({"id": "singleton"}, {"_id": 0})
    return normalize_interface_config(saved or {}, company_id, allow_legacy_fields=True)


@api.put("/interface-settings")
async def update_interface_settings(
    body: dict, user=Depends(get_current_user), company_id: Optional[str] = None,
):
    require_global_owner(user)
    company_id = _interface_settings_company_id(company_id, user)
    config = normalize_interface_config(body, company_id)
    before = await base_db.interface_settings.find_one({"id": company_id}, {"_id": 0})
    if not before and company_id == DEFAULT_COMPANY_ID:
        before = await base_db.interface_settings.find_one({"id": "singleton"}, {"_id": 0})
    await base_db.interface_settings.update_one(
        {"id": company_id},
        {"$set": {
            "id": company_id,
            **config,
            "updated_at": now_iso(),
            "updated_by": user.get("email", ""),
        }},
        upsert=True,
    )
    await log_audit(
        "interface_settings", company_id, "updated", user,
        before=normalize_interface_config(before or {}, allow_legacy_fields=True),
        after=config,
    )
    return config


def _interface_settings_company_id(requested_company_id, user):
    active_id = active_company_id.get() or user.get("_active_company_id") or DEFAULT_COMPANY_ID
    company_id = requested_company_id or active_id
    if company_id not in {profile["id"] for profile in COMPANY_PROFILES}:
        raise HTTPException(422, "Unknown company profile")
    if company_id != active_id:
        require_global_owner(user)
    return company_id


@api.get("/settings")
async def get_settings(user=Depends(get_current_user)):
    s = await db.settings.find_one({"id": "singleton"}, {"_id": 0})
    for key in ("supervisor_password_hash", "supervisor_password_updated_by", "supervisor_password_updated_at"):
        if s:
            s.pop(key, None)
    extra = {"city_distances": seed_data.CITY_DISTANCES_KM, "diesel_price": None, "diesel_price_date": "", "diesel_updated_at": "",
             "avg_speed_kmh": 60, "offload_minutes_per_stop": 45, "piece_weights_kg": {},
             "unified_price_list": uses_unified_price_list(active_company_id.get())}
    return {**seed_data.DEFAULT_SETTINGS, **extra, **(s or {})}

def require_primary_owner(user):
    if canonical_email(user.get("email")) != canonical_email(os.environ["ADMIN_EMAIL"]):
        raise HTTPException(403, "Primary owner access required")

def backup_database_names():
    return [base_db.name, *(
        f"{base_db.name}__{profile['id']}"
        for profile in COMPANY_PROFILES
        if profile["id"] != DEFAULT_COMPANY_ID
    )]

def backup_runtime_status():
    configuration = backup_configuration()
    tools = {name: shutil.which(name) is not None for name in ("mongodump", "mongorestore")}
    return {
        "configured": configuration["configured"],
        "missing_configuration": configuration["missing"],
        "tools_available": all(tools.values()),
        "tools": tools,
        "storage_provider": "S3-compatible object storage",
        "schedule": "Daily at 02:00 Africa/Johannesburg",
        "retention": "Daily snapshots for 30 days; monthly snapshots for 12 months",
        "scope": "Invoices, payments and customers of all three companies (invoice PDFs are generated from this data)",
    }

def backup_schedule_info():
    now = datetime.now(TZ)
    next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(days=1)
    return next_run.isoformat()

async def backup_history_summary():
    async def last(status):
        return await base_db.backup_operations.find_one({"status": status}, {"_id": 0}, sort=[("created_at", -1)])
    return {"last_success": await last("success"), "last_failure": await last("failed"), "next_scheduled": backup_schedule_info()}

async def record_backup_operation(entry):
    try:
        await base_db.backup_operations.insert_one({"created_at": datetime.now(timezone.utc).isoformat(), **entry})
    except Exception:
        logging.exception("Could not record backup history")

@api.get("/backups/status")
async def get_backup_status(user=Depends(get_current_user)):
    require_primary_owner(user)
    return backup_runtime_status()

@api.get("/backups")
async def get_backups(user=Depends(get_current_user)):
    require_primary_owner(user)
    status = {**backup_runtime_status(), **(await backup_history_summary())}
    if not status["configured"] or not status["tools_available"]:
        return {"snapshots": [], "status": status}
    try:
        listing = await list_snapshots(backup_configuration(), local_today())
        status["r2_connected"] = True
        return {"snapshots": listing["snapshots"], "storage_usage_bytes": listing["storage_usage_bytes"],
                "counts": listing["counts"], "status": status}
    except Exception:
        logging.exception("Could not list external backups")
        raise HTTPException(502, "Could not read the backup archive")

@api.post("/backups/verify")
async def verify_backup(body: BackupRestoreIn, user=Depends(get_current_user)):
    require_primary_owner(user)
    status = backup_runtime_status()
    if not status["configured"]:
        raise HTTPException(503, "Configure the external backup archive first")
    try:
        result = await verify_snapshot_object(configuration=backup_configuration(), snapshot_key_value=body.key)
        return {"key": body.key, "verification_status": "verified", **{k: v for k, v in (result or {}).items() if k in ("size_bytes", "sha256", "database_count", "file_count")}}
    except Exception:
        logging.exception("Backup verification failed")
        raise HTTPException(502, "Backup verification FAILED: the archive is missing, damaged or incomplete")

@api.post("/backups")
async def create_manual_backup(user=Depends(get_current_user)):
    require_primary_owner(user)
    status = backup_runtime_status()
    if not status["configured"] or not status["tools_available"]:
        raise HTTPException(503, "Configure the external backup archive and MongoDB tools first")
    try:
        result = await create_snapshot(
            mongo_url=mongo_url,
            database_names=backup_database_names(),
            configuration=backup_configuration(),
            snapshot_date=datetime.now(timezone.utc),
            kind="manual",
        )
        try:
            await delete_expired_snapshots(backup_configuration(), local_today())
            result["retention_cleanup_ok"] = True
        except Exception:
            logging.exception("Backup succeeded but expired-backup cleanup failed")
            result["retention_cleanup_ok"] = False
        await record_backup_operation({"kind": "manual", "status": "success", "key": result.get("key"),
                                       "size_bytes": result.get("size_bytes"), "verification_status": result.get("verification_status")})
        return result
    except Exception:
        logging.exception("Manual backup failed")
        await record_backup_operation({"kind": "manual", "status": "failed", "verification_status": "failed",
                                       "error": "Manual backup failed; inspect backend logs."})
        raise HTTPException(502, "Backup failed; no success was reported. Check server logs and archive configuration")

@api.post("/backups/restore")
async def restore_backup(body: BackupRestoreIn, user=Depends(get_current_user)):
    require_primary_owner(user)
    status = backup_runtime_status()
    if not status["configured"] or not status["tools_available"]:
        raise HTTPException(503, "Configure the external backup archive and MongoDB tools first")
    try:
        return await restore_snapshot_to_copy(
            mongo_url=mongo_url,
            database_names=backup_database_names(),
            configuration=backup_configuration(),
            snapshot_key_value=body.key,
            base_database_name=base_db.name,
        )
    except ValueError as error:
        raise HTTPException(400, str(error))
    except Exception:
        logging.exception("Historical backup restore failed")
        raise HTTPException(502, "Restore failed. Live databases were not intentionally changed; check the isolated recovery databases and server logs")

@api.get("/settings/supervisor-password")
async def get_supervisor_password_status(user=Depends(get_current_user)):
    require_profile_owner(user)
    settings = await db.settings.find_one({"id": "singleton"}, {"_id": 0, "supervisor_password_hash": 1})
    return {"configured": bool((settings or {}).get("supervisor_password_hash"))}

@api.post("/settings/supervisor-password/authorize")
async def authorize_supervisor_company_change(
    body: SupervisorWriteAuthorizationIn,
    user=Depends(get_current_user),
):
    if worker_restrictions_apply(user):
        action = body.action
        generic_action = None
        if isinstance(action, str) and ":" in action:
            section, operation = action.split(":", 1)
            if operation in {"create", "update", "delete"}:
                configured = (user.get("worker_write_permissions") or {}).get(section, {})
                is_invoice_delete = (
                    section in {"invoices", "express-invoices"}
                    and operation == "delete"
                    and section in set(user.get("worker_allowed_sections") or [])
                    and configured.get(operation) != "deny"
                )
                if configured.get(operation) == "supervisor" or is_invoice_delete:
                    generic_action = (section, operation)
        if not generic_action and action in {"invoices:delete", "express-invoices:delete"}:
            section = action.split(":", 1)[0]
            if section in set(user.get("worker_allowed_sections") or []):
                generic_action = (section, "delete")
        if generic_action:
            grant_company_id = user.get("_active_company_id")
        else:
            if (
                user.get("_active_company_id") != MANUFACTURING_COMPANY_ID
                or not user.get("worker_is_supervisor")
                or action not in WORKER_SUPERVISOR_ACTIONS
                or action not in set(user.get("worker_supervisor_password_actions") or [])
            ):
                raise HTTPException(403, "This worker is not authorized for that supervisor-protected action")
            grant_company_id = MANUFACTURING_COMPANY_ID
        grant_scope = "supervisor_worker_action"
    else:
        if not is_delegated_company_admin(user) and user.get("_active_role") != "admin":
            raise HTTPException(403, "Company administrator access is required for this authorization")
        action = None
        grant_scope = "supervisor_company_write"
        grant_company_id = user.get("_active_company_id")

    settings = await db.settings.find_one({"id": "singleton"}, {"_id": 0, "supervisor_password_hash": 1})
    password_hash = (settings or {}).get("supervisor_password_hash")
    if not password_hash:
        raise HTTPException(403, "Set a Supervisor Password for this company before making changes")
    if not verify_pw(body.password, password_hash):
        raise HTTPException(403, "Supervisor password is incorrect")

    await base_db.supervisor_action_grants.delete_many({
        "expires_at": {"$lte": datetime.now(timezone.utc)},
    })
    grant_id = new_id()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=2)
    grant_record = {
        "id": grant_id,
        "user_id": user["id"],
        "company_id": grant_company_id,
        "session_id": user.get("_session_id"),
        "expires_at": expires_at,
    }
    if action is not None:
        grant_record.update({"scope": grant_scope, "action": action})
    await base_db.supervisor_action_grants.insert_one(grant_record)
    grant_payload = {
        "sub": user["id"],
        "company_id": grant_company_id,
        "sid": user.get("_session_id"),
        "scope": grant_scope,
        "jti": grant_id,
        "exp": expires_at,
    }
    if action is not None:
        grant_payload["action"] = action
    authorization = jwt.encode(grant_payload, JWT_SECRET, algorithm=JWT_ALGO)
    await log_audit("auth", user["id"], "supervisor_write_authorized", user,
                    after={"company_id": grant_company_id, "action": action,
                           "expires_at": expires_at.isoformat()})
    return {"authorization": authorization}

@api.put("/settings/supervisor-password")
async def update_supervisor_password(body: SupervisorPasswordIn, user=Depends(get_current_user)):
    require_profile_owner(user)
    if len(body.password) < 8:
        raise HTTPException(400, "Password must contain at least 8 characters")
    current_company_id = user["_active_company_id"]
    for profile in COMPANY_PROFILES:
        if profile["id"] == current_company_id:
            continue
        profile_db = tenant_database(client, base_db, profile["id"])
        profile_settings = await profile_db.settings.find_one(
            {"id": "singleton"}, {"_id": 0, "supervisor_password_hash": 1},
        )
        existing_hash = (profile_settings or {}).get("supervisor_password_hash")
        if existing_hash and verify_pw(body.password, existing_hash):
            raise HTTPException(400, "Supervisor passwords must be different for each company profile")
    password_hash = hash_pw(body.password)
    await db.settings.update_one({"id": "singleton"}, {"$set": {
        "supervisor_password_hash": password_hash,
        "supervisor_password_updated_by": user["id"],
        "supervisor_password_updated_at": now_iso(),
    }}, upsert=True)
    await log_audit("settings", "singleton", "supervisor_password_updated", user)
    return {"configured": True}

@api.put("/settings")
async def update_settings(body: dict, user=Depends(get_current_user)):
    require_settings_owner(user)
    def _finite(v):
        if isinstance(v, float):
            return math.isfinite(v)
        if isinstance(v, dict):
            return all(_finite(x) for x in v.values())
        if isinstance(v, list):
            return all(_finite(x) for x in v)
        return True
    if not _finite(body):
        raise HTTPException(422, "Settings contain invalid numbers")
    body.pop("_id", None)
    body.pop("unified_price_list", None)
    for key in (
        "diesel_price", "diesel_price_date", "diesel_updated_at", "diesel_sources",
        "diesel_checked_date", "diesel_lookup_attempt_date", "supervisor_password_hash",
        "supervisor_password_updated_by", "supervisor_password_updated_at",
    ):
        body.pop(key, None)
    body["id"] = "singleton"
    before = await db.settings.find_one({"id": "singleton"}, {"_id": 0})
    await db.settings.update_one({"id": "singleton"}, {"$set": body}, upsert=True)
    after = clean(await db.settings.find_one({"id": "singleton"}, {"_id": 0}))
    changed = {k: v for k, v in after.items() if (before or {}).get(k) != v and k != "updated_at"}
    if changed:
        await log_audit("settings", "singleton", "updated", user, before={k: (before or {}).get(k) for k in changed}, after=changed)
    return after

class DieselPriceUpdate(BaseModel):
    price_per_l: float

@api.put("/settings/diesel")
async def update_diesel_price(body: DieselPriceUpdate, user=Depends(get_current_user)):
    require_settings_owner(user)
    if body.price_per_l <= 0 or body.price_per_l > 100:
        raise HTTPException(400, "Enter a valid diesel price per litre")
    updated_at = now_iso()
    updates = {"diesel_price": r2(body.price_per_l), "diesel_price_date": today_str(),
               "diesel_updated_at": updated_at, "diesel_sources": ["https://petrolprices.co.za/"]}
    before = await db.settings.find_one({"id": "singleton"}, {"_id": 0}) or {}
    await db.settings.update_one({"id": "singleton"}, {"$set": updates}, upsert=True)
    after = {**before, **updates}
    await log_audit("settings", "singleton", "diesel_price_updated", user,
                    before={k: before.get(k) for k in updates}, after=updates)
    return after

# ---------------- Dashboard ----------------
@api.get("/dashboard")
async def dashboard(
    period: str = "month",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user=Depends(get_current_user),
):
    (period_start, period_end), (previous_start, previous_end) = dashboard_period_ranges(
        period, start_date, end_date,
    )
    today = today_str()
    week, month = period_starts()
    incomplete_order_statuses = INCOMPLETE_ORDER_STATUSES
    week_range = (week, today)
    month_range = (month, today)
    financial_ranges = (
        week_range,
        month_range,
        (period_start, period_end),
        (previous_start, previous_end),
    )
    if period == "custom":
        financial_tasks = [
            asyncio.create_task(dashboard_financial_period(*bounds))
            for bounds in financial_ranges
        ]
        financial_batch_task = None
    else:
        financial_tasks = None
        financial_batch_task = asyncio.create_task(
            dashboard_financial_periods(financial_ranges),
        )
    fleet_filters = vehicle_operational_filters()
    active_order_vehicle_filter = fleet_filters["orders"]
    active_delivery_vehicle_filter = fleet_filters["deliveries"]
    maintenance_filter = fleet_filters["maintenance"]
    stock_task = asyncio.create_task(listall("stock"))
    (
        recent_invoices, prod, attendance_in_period, deliveries, period_orders,
        vehicles, maintenance_vehicle_ids, assigned_order_vehicle_ids,
        assigned_delivery_vehicle_ids, all_time_payments, all_time_invoice_totals, settings,
        completed_orders_in_period, parts_to_buy, stock,
    ) = await asyncio.gather(
        financial_period_records(
            "invoices", date.fromisoformat(period_start), date.fromisoformat(period_end),
            conditions={"archived": {"$ne": True}},
        ),
        financial_period_records(
            "production",
            date.fromisoformat(period_start), date.fromisoformat(period_end),
            date_field="production_date",
            conditions={
                "status": {"$in": ["Ready for Cutting", "Resting"]},
                "archived": {"$ne": True},
            },
        ),
        financial_period_records(
            "attendance", date.fromisoformat(period_start), date.fromisoformat(period_end),
        ),
        financial_period_records(
            "deliveries",
            date.fromisoformat(period_start), date.fromisoformat(period_end),
            date_field="planned_departure",
            conditions={"status": {"$in": ACTIVE_DELIVERY_STATUSES}, "archived": {"$ne": True}},
        ),
        financial_period_records(
            "orders", date.fromisoformat(period_start), date.fromisoformat(period_end),
            date_field="created_at", conditions={"archived": {"$ne": True}},
        ),
        listall("vehicles", {"archived": {"$ne": True}}),
        db.vehicle_records.distinct("vehicle_id", maintenance_filter),
        db.orders.distinct("vehicle_id", active_order_vehicle_filter),
        db.deliveries.distinct("vehicle_id", active_delivery_vehicle_filter),
        dashboard_all_time_payment_total(),
        dashboard_all_time_invoice_totals(today),
        db.settings.find_one({"id": "singleton"}),
        dashboard_completed_orders_in_period(period_start, period_end),
        listall("spareparts", {"status": "to_buy"}),
        stock_task,
    )
    recent_invoices.sort(
        key=lambda invoice: str(invoice.get("created_at") or invoice.get("date") or ""),
        reverse=True,
    )
    recent_invoices = recent_invoices[:8]
    orders_to_send = sorted(
        (order for order in period_orders if order.get("status") in OPEN_ORDER_STATUSES),
        key=lambda order: str(order.get("created_at") or ""),
        reverse=True,
    )[:8]
    open_order_count = sum(order.get("status") in OPEN_ORDER_STATUSES for order in period_orders)
    urgent_orders = sum(
        order.get("status") in incomplete_order_statuses and order.get("priority") == "Urgent"
        for order in period_orders
    )
    deliveries.sort(
        key=lambda delivery: str(delivery.get("planned_departure") or ""),
    )
    stock_movement_totals = await dashboard_stock_movement_totals(
        [item["id"] for item in stock if item.get("id")],
    )
    upcoming = deliveries
    outstanding = all_time_invoice_totals["outstanding"]
    for item in stock:
        item["current"] = r2(
            D(item.get("opening", 0))
            + D(stock_movement_totals.get(item["id"], 0))
        )
    finished_stock = r2(sum((D(item["current"]) for item in stock), Decimal("0")))
    low_stock = [s for s in stock if s.get("current", 0) <= s.get("threshold", 0)]

    hours = await resting_hours()
    for p in prod:
        enrich_production(p, hours)
    ready_cutting = [p for p in prod if p.get("status") == "Ready for Cutting" or (p.get("status") == "Resting" and p["rest_elapsed"])]
    resting = [p for p in prod if p.get("status") == "Resting" and not p["rest_elapsed"]]
    for invoice in recent_invoices:
        invoice["status"] = derive_status(invoice)
    maintenance_vehicle_ids = set(maintenance_vehicle_ids)
    assigned_vehicle_ids = set(assigned_order_vehicle_ids) | set(assigned_delivery_vehicle_ids)
    active_vehicle_ids = {vehicle["id"] for vehicle in vehicles if vehicle.get("id")}
    maint_due = maintenance_vehicle_ids & active_vehicle_ids
    assigned_driver_vehicle_ids = {
        vehicle["id"] for vehicle in vehicles if vehicle.get("assigned_driver_id")
    }
    assigned_vehicle_ids |= assigned_driver_vehicle_ids
    unavailable_vehicle_ids = assigned_vehicle_ids | maint_due
    available_vehicles = [
        vehicle for vehicle in vehicles
        if vehicle.get("vtype") != "Trailer"
    ]
    free_vehicles = [
        vehicle for vehicle in available_vehicles
        if vehicle_is_free(vehicle, unavailable_vehicle_ids)
    ]
    fleet_alerts_visible = (
        not worker_restrictions_apply(user)
        or "fleet" in (user.get("worker_allowed_sections") or [])
    )
    licence_alerts = (
        await dashboard_vehicle_licence_alerts(today)
        if fleet_alerts_visible else {"expiring_soon": 0, "expired": 0, "items": []}
    )
    licence_alerts["maintenance_required"] = [
        {"vehicle_id": vehicle["id"], "vehicle_name": vehicle.get("name", "")}
        for vehicle in vehicles
        if fleet_alerts_visible and vehicle.get("id") in maint_due
    ][:10]
    licence_alerts["maintenance_required_count"] = len(maint_due) if fleet_alerts_visible else 0

    if financial_batch_task:
        period_totals = await financial_batch_task
        week_profit, month_profit, selected_profit, previous_profit = (
            period_totals[bounds] for bounds in financial_ranges
        )
    else:
        week_profit, month_profit, selected_profit, previous_profit = await asyncio.gather(
            *financial_tasks,
        )
    recent_invoice_balances = await dashboard_invoice_outstanding_by_id(
        recent_invoices,
    )
    for invoice in recent_invoices:
        invoice["outstanding"] = recent_invoice_balances.get(invoice.get("id"), 0)
        invoice["status"] = derive_status({
            **invoice,
            "outstanding": invoice["outstanding"],
        })

    settings = settings or {}
    recommendations = []
    for s in stock:
        target = s.get("target", 0) or s.get("threshold", 0) * 2
        demand = 0
        avail = s.get("current", 0)
        need = max(r2(target - avail + demand), 0)
        if avail < s.get("threshold", 0) and need > 0:
            recommendations.append({"product": s["product"], "size": s["size"], "recommend_qty": need,
                                    "reason": f"Available {avail} is below minimum {s['threshold']}; target stock {target}"})

    return {
        "total_invoiced": selected_profit["total_invoiced"],
        "total_invoiced_all_time": all_time_invoice_totals["total_invoiced"],
        "payments_received": all_time_payments,
        "diesel_price": settings.get("diesel_price"),
        "diesel_price_date": settings.get("diesel_price_date") or "",
        "diesel_updated_at": settings.get("diesel_updated_at") or "",
        "diesel_sources": settings.get("diesel_sources") or [],
        "diesel_price_current": diesel_price_is_current(settings.get("diesel_price_date")) and settings.get("diesel_price") is not None,
        "outstanding": outstanding,
        "overdue": all_time_invoice_totals["overdue"],
        "finished_stock": finished_stock,
        "low_stock": low_stock,
        "recommendations": recommendations,
        "ready_cutting": ready_cutting,
        "resting": resting,
        "completed_today": completed_orders_in_period,
        "attendance_today": attendance_in_period,
        "upcoming_deliveries": upcoming,
        "recent_invoices": recent_invoices,
        "current_stock": stock,
        "orders_to_send": orders_to_send,
        "orders_open_count": open_order_count,
        "urgent_orders": urgent_orders,
        "week_profit": week_profit,
        "month_profit": month_profit,
        "selected_period": period,
        "period_profit": selected_profit,
        "previous_period_profit": previous_profit,
        "period_start": period_start,
        "period_end": period_end,
        "previous_period_start": previous_start,
        "previous_period_end": previous_end,
        "parts_to_buy_count": len(parts_to_buy),
        "vehicles_available": len(free_vehicles),
        "vehicles_total": len(available_vehicles),
        "fleet_alerts": licence_alerts,
        "trailers_total": len([v for v in vehicles if v.get("vtype") == "Trailer"]),
        "maintenance_due": len(maint_due),
        "timezone": "Africa/Johannesburg",
    }

# ---------------- Buyings and expenses ----------------
class BuyingIn(BaseModel):
    product: str = ""
    source: str
    supplier_id: Optional[str] = ""
    stock_id: Optional[str] = ""
    size: Optional[str] = ""
    item_type: str = "raw_material"
    quantity: float
    quantity_unit: Optional[str] = ""
    unit_price: float
    date: str = Field(default_factory=today_str)
    notes: Optional[str] = ""
    supervisor_authorization: Optional[str] = None

async def _check_buying(body):
    if not body.source.strip():
        raise HTTPException(400, "Source is required")
    if not math.isfinite(body.quantity) or body.quantity <= 0:
        raise HTTPException(400, "Quantity must be greater than 0")
    if not math.isfinite(body.unit_price) or body.unit_price <= 0:
        raise HTTPException(400, "Unit price must be greater than 0")
    if body.item_type not in ("selling_product", "raw_material"):
        raise HTTPException(400, "Choose whether this is a selling product or raw material")
    stock = None
    if body.stock_id:
        stock = await db.stock.find_one({"id": body.stock_id}, {"_id": 0})
        if not stock:
            raise HTTPException(400, "Selected stock product not found")
    elif not body.product.strip():
        raise HTTPException(400, "Product is required")
    if body.supplier_id:
        supplier = await db.suppliers.find_one({"id": body.supplier_id}, {"_id": 0})
        if not supplier:
            raise HTTPException(400, "Supplier not found")
        source = supplier["name"]
    else:
        source = body.source.strip()
    product = stock["product"] if stock else body.product.strip()
    size = stock["size"] if stock else (body.size or "").strip()
    return source, product, size

def set_buying_quantity_unit(data):
    data["quantity_unit"] = (
        (data.get("quantity_unit") or "").strip()
        or ("L" if data["product"].strip().casefold() == "chemical" else "")
    )

def buying_amount(quantity, unit_price):
    amount = r2(D(quantity) * D(unit_price))
    if not math.isfinite(amount):
        raise HTTPException(400, "Buying total is too large")
    return amount

@api.get("/buyings")
async def get_buyings(include_archived: bool = False, user=Depends(get_current_user)):
    flt = {"voided": {"$ne": True}}
    if not include_archived:
        flt["archived"] = {"$ne": True}
    return await listall("buyings", flt, sort=("date", -1))

@api.post("/buyings")
async def add_buying(body: BuyingIn, user=Depends(get_current_user)):
    require_global_owner(user)
    source, product, size = await _check_buying(body)
    data = body.model_dump()
    data.pop("supervisor_authorization", None)
    data["product"] = product
    data["size"] = size
    data["source"] = source
    set_buying_quantity_unit(data)
    data["quantity"] = float(data["quantity"])
    data["unit_price"] = r2(data["unit_price"])
    data["amount"] = buying_amount(data["quantity"], data["unit_price"])
    rec = await insert("buyings", data)
    await log_audit("buying", rec["id"], "created", user, after=rec)
    await emit_workflow_event("buying.created", rec)
    return rec

@api.put("/buyings/{bid}")
async def edit_buying(bid: str, body: BuyingIn, user=Depends(get_current_user)):
    require_global_owner(user)
    authorization = None
    if not can_skip_supervisor_approval(user):
        authorization = await db.buying_edit_authorizations.find_one({
            "id": body.supervisor_authorization,
            "buying_id": bid,
            "user_id": user["id"],
            "company_id": user["_active_company_id"],
            "expires_at": {"$gt": datetime.now(timezone.utc)},
        })
        if not authorization:
            raise HTTPException(403, "Supervisor approval is required to edit this buying")
    source, product, size = await _check_buying(body)
    before = await db.buyings.find_one({"id": bid, "voided": {"$ne": True}}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Buying not found")
    data = body.model_dump()
    data.pop("supervisor_authorization", None)
    data["product"] = product
    data["size"] = size
    data["source"] = source
    set_buying_quantity_unit(data)
    data["quantity"] = float(data["quantity"])
    data["unit_price"] = r2(data["unit_price"])
    data["amount"] = buying_amount(data["quantity"], data["unit_price"])
    rec = await update_doc("buyings", bid, data)
    await log_audit("buying", bid, "updated", user, before=before, after=rec)
    await emit_workflow_event("buying.updated", rec)
    if authorization:
        await db.buying_edit_authorizations.delete_one({"id": authorization["id"]})
    return rec

@api.post("/buyings/{bid}/authorize-edit")
async def authorize_buying_edit(
    bid: str, body: BuyingEditAuthorizationIn, user=Depends(get_current_user),
):
    require_global_owner(user)
    buying = await db.buyings.find_one({"id": bid, "voided": {"$ne": True}}, {"_id": 0, "id": 1})
    if not buying:
        raise HTTPException(404, "Buying not found")
    supervisor_id, supervisor_name = await authenticate_supervisor(body.password, user)
    await db.buying_edit_authorizations.delete_many({
        "user_id": user["id"],
        "expires_at": {"$lte": datetime.now(timezone.utc)},
    })
    authorization_id = new_id()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    await db.buying_edit_authorizations.insert_one({
        "id": authorization_id,
        "buying_id": bid,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "supervisor_id": supervisor_id,
        "expires_at": expires_at,
    })
    await log_audit("buying", bid, "edit_authorized", user,
                    reason=f"Supervisor approval by {supervisor_name}")
    return {"authorization_id": authorization_id, "expires_at": expires_at.isoformat()}

@api.post("/buyings/{bid}/void")
async def void_buying(bid: str, body: ReasonIn, user=Depends(get_current_user)):
    require_global_owner(user)
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required")
    rec = await db.buyings.find_one_and_update(
        {"id": bid, "voided": {"$ne": True}},
        {"$set": {"voided": True, "void_reason": body.reason, "voided_at": now_iso()}},
        projection={"_id": 0}, return_document=ReturnDocument.AFTER,
    )
    if not rec:
        raise HTTPException(404, "Buying not found or already voided")
    await log_audit("buying", bid, "voided", user, reason=body.reason)
    await emit_workflow_event("buying.voided", rec)
    return rec


class BuyingGRVTransferIn(BaseModel):
    buying_ids: List[str] = Field(min_length=1, max_length=250)


async def _buying_grv_source(buying):
    supplier_id = (buying.get("supplier_id") or "").strip()
    supplier_name = (buying.get("source") or "").strip()
    if supplier_id:
        supplier = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
        if supplier:
            supplier_name = supplier.get("name") or supplier_name
        else:
            supplier_id = ""
    return supplier_id, supplier_name


async def _buying_grv_line(buying):
    product = (buying.get("product") or "").strip()
    size = (buying.get("size") or "").strip()
    try:
        quantity = float(buying.get("quantity") or 0)
        unit_cost = float(buying.get("unit_price") or 0)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(400, "The purchase quantity and unit cost must be numeric")
    if not product or quantity <= 0 or unit_cost < 0:
        raise HTTPException(400, "The purchase is missing a product, quantity, or valid unit cost")
    if not math.isfinite(quantity) or not math.isfinite(unit_cost):
        raise HTTPException(400, "The purchase quantity and unit cost must be finite")

    common = {
        "product": product,
        "size": size,
        "actual_received_quantity": quantity,
        "accepted_quantity": quantity,
        "rejected_quantity": 0,
        "damaged_quantity": 0,
        "unit_cost": unit_cost,
    }
    if buying.get("item_type") == "selling_product":
        stock = None
        stock_id = (buying.get("stock_id") or "").strip()
        if stock_id:
            stock = await db.stock.find_one({"id": stock_id}, {"_id": 0})
        if not stock:
            stock_size = size
            matches = await listall("stock", {
                "product": {"$regex": f"^{re.escape(product)}$", "$options": "i"},
                "size": {"$regex": f"^{re.escape(stock_size)}$", "$options": "i"},
            })
            if len(matches) == 1:
                stock = matches[0]
            elif len(matches) > 1:
                stock = sorted(matches, key=lambda item: str(item.get("id", "")))[0]
        if stock:
            return {
                **common,
                "stock_id": stock["id"],
                "product": stock["product"],
                "size": stock.get("size", ""),
                "product_code": stock.get("code") or stock.get("product_id") or stock["id"],
                "new_product": False,
            }, False, ""
        return {
            **common,
            "stock_id": "",
            "product_code": "",
            "new_product": True,
        }, False, ""

    if buying.get("item_type") != "raw_material":
        raise HTTPException(400, "The purchase type must be Selling Product or Raw Material")

    unit = (buying.get("quantity_unit") or "").strip()
    category = "Other"
    matches = await listall("company_inventory", {
        "name": {"$regex": f"^{re.escape(product)}$", "$options": "i"},
        "size": {"$regex": f"^{re.escape(size)}$", "$options": "i"},
        "unit": {"$regex": f"^{re.escape(unit)}$", "$options": "i"},
    })
    if len(matches) > 1:
        matches = sorted(matches, key=lambda item: str(item.get("id", "")))
    if len(matches) == 1:
        unit = unit or (matches[0].get("unit") or "").strip()
        category = (matches[0].get("category") or "Other").strip()
    is_chemical = False
    has_chemical_dimensions = bool(unit and size)
    if product.casefold() == "chemical" and has_chemical_dimensions:
        try:
            is_chemical = float(size) > 0
        except (TypeError, ValueError):
            is_chemical = False
    if not is_chemical and has_chemical_dimensions:
        chemical_matches = await listall("chemical_inventory", {
            "chemical": {"$regex": f"^{re.escape(product)}$", "$options": "i"},
            "unit": {"$regex": f"^{re.escape(unit)}$", "$options": "i"},
        })
        if size:
            chemical_matches = [
                item for item in chemical_matches
                if str(item.get("capacity", "")) == size
            ]
        is_chemical = len(chemical_matches) == 1

    return {
        **common,
        "unit": unit,
        "category": category,
        "container_type": "Barrel",
    }, is_chemical, unit


async def _create_grv_from_buying(buying, user):
    existing = await db.grvs.find_one({"source_buying_id": buying["id"]}, {"_id": 0})
    if existing:
        await update_doc("buyings", buying["id"], {"transferred_to_grv_id": existing["id"]})
        return await _confirm_buying_grv(existing, user), False
    if buying.get("transferred_to_grv_id"):
        raise HTTPException(409, "This buying is linked to a GRV that is no longer available")

    supplier_id, supplier_name = await _buying_grv_source(buying)
    line, is_chemical, _unit = await _buying_grv_line(buying)
    purpose = "selling" if buying.get("item_type") == "selling_product" else "raw_material"
    if purpose == "raw_material":
        items = _raw_grv_items(
            [line], is_chemical,
            allow_missing_unit=True,
            allow_missing_chemical_size=True,
        )
    else:
        items = await _grv_items_from_request(
            [line], allow_blank_new_product_size=True,
        )
    received_date = buying.get("date") or today_str()
    _validate_grv_date(received_date)
    reference = await next_ref("grv", "GRV")
    notes = f"Transferred from Buying {buying['id']}."
    if (buying.get("notes") or "").strip():
        notes += f" Original notes: {buying['notes'].strip()}"
    record = {
        "grv_number": reference,
        "supplier_id": supplier_id,
        "supplier_name": supplier_name,
        "purchase_order_id": "",
        "purchase_order_reference": "",
        "delivery_note_number": "",
        "received_date": received_date,
        "received_by": (user.get("name") or user["email"]).strip(),
        "warehouse": "",
        "notes": notes,
        "items": items,
        "purpose": purpose,
        "is_chemical": is_chemical if purpose == "raw_material" else False,
        "status": "draft",
        "created_by": user["email"],
        "edited_by": user["email"],
        "source_buying_id": buying["id"],
        "audit": [{"action": "created_from_buying", "by": user["email"], "at": now_iso()}],
    }
    try:
        created = await insert("grvs", record)
    except DuplicateKeyError:
        created = await db.grvs.find_one({"source_buying_id": buying["id"]}, {"_id": 0})
        if not created:
            raise
        await update_doc("buyings", buying["id"], {"transferred_to_grv_id": created["id"]})
        return await _confirm_buying_grv(created, user), False

    await update_doc("buyings", buying["id"], {"transferred_to_grv_id": created["id"]})
    await log_audit("grv", created["id"], "created_from_buying", user, after=created)
    await emit_workflow_event("grv.created", {
        **created, "item_count": len(created.get("items", [])),
    })
    await log_audit("buying", buying["id"], "transferred_to_grv", user,
                    before=buying, after={**buying, "transferred_to_grv_id": created["id"]})
    return await _confirm_buying_grv(created, user), True


async def _confirm_buying_grv(grv, user):
    if grv.get("status") in ("draft", "pending_inspection", "confirming"):
        return await confirm_grv(grv["id"], user)
    return grv


@api.post("/buyings/transfer-to-grv")
async def transfer_buyings_to_grv(body: BuyingGRVTransferIn, user=Depends(get_current_user)):
    require_global_owner(user)
    ids = list(dict.fromkeys(body.buying_ids))
    if len(ids) != len(body.buying_ids):
        raise HTTPException(400, "Each buying can be selected only once")

    results = []
    for buying_id in ids:
        buying = await db.buyings.find_one({
            "id": buying_id,
            "voided": {"$ne": True},
            "archived": {"$ne": True},
        }, {"_id": 0})
        if not buying:
            results.append({"buying_id": buying_id, "error": "Buying not found or no longer active"})
            continue
        try:
            grv, created = await _create_grv_from_buying(buying, user)
            results.append({
                "buying_id": buying_id,
                "grv_id": grv["id"],
                "grv_number": grv["grv_number"],
                "created": created,
            })
        except HTTPException as error:
            results.append({"buying_id": buying_id, "error": str(error.detail)})
    return {
        "transferred": sum(bool(item.get("grv_id")) for item in results),
        "created": sum(bool(item.get("created")) for item in results),
        "failed": [item for item in results if item.get("error")],
        "items": results,
    }

# ---------------- Suppliers and purchase orders ----------------
class SupplierIn(BaseModel):
    name: str
    contact: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    balance: float = Field(default=0, allow_inf_nan=False)
    terms: Optional[str] = ""
    active: bool = True
    notes: Optional[str] = ""

@api.get("/suppliers")
async def get_suppliers(user=Depends(get_current_user)):
    return await listall("suppliers", sort=("name", 1))

@api.post("/suppliers")
async def add_supplier(body: SupplierIn, user=Depends(get_current_user)):
    if not body.name.strip():
        raise HTTPException(400, "Supplier name is required")
    name = body.name.strip()
    if await db.suppliers.find_one({"name_key": name.casefold()}):
        raise HTTPException(409, "A supplier with this name already exists")
    data = body.model_dump()
    data.update({"name": name, "name_key": name.casefold()})
    rec = await insert("suppliers", data)
    await log_audit("supplier", rec["id"], "created", user, after=rec)
    await emit_workflow_event("supplier.created", rec)
    return rec

@api.put("/suppliers/{supplier_id}")
async def edit_supplier(supplier_id: str, body: SupplierIn, user=Depends(get_current_user)):
    if not body.name.strip():
        raise HTTPException(400, "Supplier name is required")
    before = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Supplier not found")
    name = body.name.strip()
    if await db.suppliers.find_one({"name_key": name.casefold(), "id": {"$ne": supplier_id}}):
        raise HTTPException(409, "A supplier with this name already exists")
    data = body.model_dump()
    data.update({
        "name": name,
        "name_key": name.casefold(),
        "balance": before.get("balance", 0),
    })
    rec = await update_doc("suppliers", supplier_id, data)
    await log_audit("supplier", supplier_id, "updated", user, before=before, after=rec)
    await emit_workflow_event("supplier.updated", rec)
    return rec


class SupplierBalanceIn(BaseModel):
    direction: Literal["add", "subtract"]
    amount: float = Field(gt=0, le=1_000_000_000, allow_inf_nan=False)
    date: str = Field(default_factory=today_str, pattern=r"^\d{4}-\d{2}-\d{2}$")
    notes: str = Field(default="", max_length=500)

    @field_validator("date")
    @classmethod
    def supplier_balance_date_valid(cls, value):
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("Enter a valid transaction date") from error
        return value


@api.post("/suppliers/{supplier_id}/balance")
async def adjust_supplier_balance(
    supplier_id: str,
    body: SupplierBalanceIn,
    user=Depends(get_current_user),
):
    before = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Supplier not found")
    amount = r2(body.amount)
    if amount <= 0:
        raise HTTPException(400, "Balance adjustment must be at least R0.01")
    signed_amount = amount if body.direction == "add" else -amount
    transaction = {
        "id": new_id(),
        "direction": body.direction,
        "amount": amount,
        "date": body.date,
        "notes": body.notes.strip(),
        "created_at": now_iso(),
        "created_by": user.get("id", ""),
        "created_by_name": user.get("name") or user.get("username") or user.get("email") or "",
    }
    result = await db.suppliers.update_one(
        {"id": supplier_id},
        {
            "$inc": {"balance": signed_amount},
            "$push": {"balance_history": transaction},
            "$set": {"updated_at": now_iso()},
        },
    )
    if not result.matched_count:
        raise HTTPException(404, "Supplier not found")
    after = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
    if not after:
        raise RuntimeError("Supplier balance was updated but the supplier could not be reloaded")
    await log_audit(
        "supplier", supplier_id, f"balance_{body.direction}",
        user, before=before, after=after, reason=body.notes.strip(),
    )
    return clean(after)


@api.delete("/suppliers/{supplier_id}")
async def deactivate_supplier(supplier_id: str, permanent: bool = False, user=Depends(get_current_user)):
    before = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Supplier not found")
    if permanent:
        require_profile_owner(user)
        await db.suppliers.delete_one({"id": supplier_id})
        await log_audit("supplier", supplier_id, "permanently_deleted", user, before=before, after={"deleted": True})
        await emit_workflow_event("supplier.deleted", before)
        return {"ok": True, "deleted": True}
    rec = await update_doc("suppliers", supplier_id, {"active": False, "archived_at": now_iso()})
    await log_audit("supplier", supplier_id, "deactivated", user, before=before, after=rec)
    await emit_workflow_event("supplier.deactivated", rec)
    return {"ok": True, "deactivated": True}

class PurchaseOrderLineIn(BaseModel):
    stock_id: Optional[str] = ""
    product: Optional[str] = ""
    size: Optional[str] = ""
    quantity: float
    unit_price: float

class PurchaseOrderIn(BaseModel):
    supplier_id: Optional[str] = ""
    supplier_name: Optional[str] = ""
    expected_date: Optional[str] = ""
    notes: Optional[str] = ""
    items: List[PurchaseOrderLineIn]

class GRVLineIn(BaseModel):
    stock_id: Optional[str] = ""
    product_code: Optional[str] = ""
    new_product: bool = False
    product: str = ""
    size: Optional[str] = ""
    purchase_order_item_index: Optional[int] = None
    ordered_quantity: float = 0
    previously_received_quantity: float = 0
    remaining_quantity: float = 0
    actual_received_quantity: float = 0
    accepted_quantity: float = 0
    rejected_quantity: float = 0
    damaged_quantity: float = 0
    unit_cost: float = 0
    total_value: float = 0
    sale_price_zone_1: Optional[float] = None
    sale_price_zone_2: Optional[float] = None
    category: Optional[str] = ""
    unit: Optional[str] = ""
    container_type: Optional[str] = ""

    @field_validator("sale_price_zone_1", "sale_price_zone_2")
    @classmethod
    def sale_prices_not_negative(cls, value):
        if value is not None and (not math.isfinite(value) or value < 0):
            raise ValueError("Sale prices must be finite and non-negative")
        return value

class GRVIn(BaseModel):
    purpose: str = "selling"
    is_chemical: bool = False
    supplier_id: Optional[str] = ""
    supplier_name: Optional[str] = ""
    purchase_order_id: Optional[str] = ""
    delivery_note_number: Optional[str] = ""
    received_date: str = Field(default_factory=today_str)
    received_by: Optional[str] = ""
    warehouse: Optional[str] = ""
    notes: Optional[str] = ""
    items: List[GRVLineIn] = Field(default_factory=list)

class GRVDeleteIn(BaseModel):
    supervisor_password: Optional[str] = None

class GRVBulkDeleteIn(BaseModel):
    ids: List[str] = Field(min_length=1, max_length=500)

class MonthlyBusinessPurchaseIn(BaseModel):
    name: str
    supplier_name: Optional[str] = ""
    category: str = "Materials"
    monthly_quantity: float = 1
    quantity_unit: Optional[str] = "unit"
    unit_price: float
    expense_day: int = 1
    start_month: Optional[str] = ""
    end_month: Optional[str] = ""
    active: bool = True
    notes: Optional[str] = ""
    edit_reason: Optional[str] = ""
    supervisor_authorization: Optional[str] = None

class MonthlyBusinessPurchaseActualIn(BaseModel):
    quantity: float
    unit_price: float
    edit_reason: Optional[str] = ""
    supervisor_authorization: Optional[str] = None

class MonthlyBusinessPurchaseAuthorizationIn(BaseModel):
    password: str

class MonthlyBusinessPurchaseEditAuthorizationIn(BaseModel):
    password: str

def _check_purchase_order(body):
    if not body.items:
        raise HTTPException(400, "Add at least one item to the purchase order")
    for item in body.items:
        if not item.stock_id and (not (item.product or "").strip() or not (item.size or "").strip()):
            raise HTTPException(400, "Choose a stock item or enter both a product and size")
        if not math.isfinite(item.quantity) or item.quantity <= 0:
            raise HTTPException(400, "Purchase quantities must be greater than 0")
        if not math.isfinite(item.unit_price) or item.unit_price < 0:
            raise HTTPException(400, "Unit prices cannot be negative")

async def _purchase_order_data(body):
    supplier_id = (body.supplier_id or "").strip()
    supplier_name = (body.supplier_name or "").strip()
    supplier = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0}) if supplier_id else None
    if supplier_id and not supplier:
        raise HTTPException(400, "Supplier not found")
    if supplier:
        supplier_name = supplier["name"]
    elif not supplier_name:
        raise HTTPException(400, "Select a supplier or enter a supplier name")
    items = []
    for line in body.items:
        stock = await db.stock.find_one({"id": line.stock_id}, {"_id": 0}) if line.stock_id else None
        product = (line.product or "").strip()
        size = (line.size or "").strip()
        if stock:
            product, size = stock["product"], stock["size"]
        elif line.stock_id:
            raise HTTPException(400, "A selected stock item no longer exists")
        else:
            stock = await db.stock.find_one({
                "product": {"$regex": f"^{re.escape(product)}$", "$options": "i"},
                "size": {"$regex": f"^{re.escape(size)}$", "$options": "i"},
            }, {"_id": 0})
            if not stock:
                stock = await insert("stock", {"product": product, "size": size, "opening": 0, "threshold": 5})
        items.append({
            "stock_id": stock["id"], "product": product, "size": size,
            "quantity": float(line.quantity), "unit_price": r2(line.unit_price),
            "amount": buying_amount(line.quantity, line.unit_price), "received_quantity": 0,
        })
    return {
        "supplier_id": supplier["id"] if supplier else "", "supplier_name": supplier_name,
        "expected_date": body.expected_date or "", "notes": body.notes or "",
        "items": items, "amount": dsum(item["amount"] for item in items),
    }

def _check_monthly_business_purchase(body):
    if not body.name.strip():
        raise HTTPException(400, "Purchase name is required")
    if not math.isfinite(body.monthly_quantity) or body.monthly_quantity <= 0:
        raise HTTPException(400, "Monthly quantity must be greater than 0")
    if not math.isfinite(body.unit_price) or body.unit_price <= 0:
        raise HTTPException(400, "Unit price must be greater than 0")
    if body.start_month and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", body.start_month):
        raise HTTPException(400, "Start month must be in YYYY-MM format")
    if body.end_month and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", body.end_month):
        raise HTTPException(400, "End month must be in YYYY-MM format")
    if body.end_month and body.start_month and body.end_month < body.start_month:
        raise HTTPException(400, "End month cannot be before the start month")
    if not 1 <= body.expense_day <= 28:
        raise HTTPException(400, "Expense day must be between 1 and 28")
    if body.category not in ("Materials", "Fuel", "Salaries", "Rent", "Utilities", "Vehicle", "Maintenance", "General", "Other"):
        raise HTTPException(400, "Choose a valid expense category")

def _next_month(month):
    year, value = map(int, month.split("-"))
    return f"{year + (value == 12):04d}-{1 if value == 12 else value + 1:02d}"

MONTHLY_BUSINESS_SYNC_LOCKS = {}

async def _sync_monthly_business_expenses():
    company_id = active_company_id.get() or DEFAULT_COMPANY_ID
    lock = MONTHLY_BUSINESS_SYNC_LOCKS.setdefault(company_id, asyncio.Lock())
    async with lock:
        await _sync_monthly_business_expenses_locked()

async def _sync_monthly_business_expenses_locked():
    current_month = local_today().strftime("%Y-%m")
    purchases = await listall("monthly_business_purchases", {"active": {"$ne": False}})
    purchase_ids = [purchase["id"] for purchase in purchases]
    existing_occurrences = await db.monthly_business_purchase_occurrences.find(
        {"purchase_id": {"$in": purchase_ids}}, {"_id": 0, "source_key": 1}
    ).to_list(None) if purchase_ids else []
    existing_source_keys = {item["source_key"] for item in existing_occurrences}
    pending = []
    for purchase in purchases:
        created_month = str(purchase.get("created_at", ""))[:7]
        start_month = purchase.get("start_month") or (
            _next_month(created_month) if re.fullmatch(r"\d{4}-\d{2}", created_month)
            else _next_month(current_month)
        )
        month = start_month
        quantity = float(purchase.get("monthly_quantity") or 1)
        unit_price = float(purchase.get("unit_price") or purchase.get("monthly_amount") or 0)
        while month <= current_month and (not purchase.get("end_month") or month <= purchase["end_month"]):
            source_key = f"monthly_business_purchase:{purchase['id']}:{month}"
            if source_key not in existing_source_keys:
                pending.append((purchase, month, quantity, unit_price, buying_amount(quantity, unit_price), source_key))
            month = _next_month(month)

    semaphore = asyncio.Semaphore(20)

    async def create_occurrence(purchase, month, quantity, unit_price, amount, source_key):
        async with semaphore:
            expense_day = min(int(purchase.get("expense_day") or 1), 28)
            expense = await db.expenses.find_one_and_update(
                {"source_key": source_key},
                {"$setOnInsert": {
                    "id": new_id(), "description": purchase["name"], "amount": amount,
                    "date": f"{month}-{expense_day:02d}", "category": purchase.get("category") or "Materials", "payment_method": "Other",
                    "reference": f"Monthly purchase {month}", "vehicle_id": "",
                    "notes": f"Automatically recorded from monthly purchase. Update actual quantity and unit price in Supplier Purchases. No payment was made by this record.",
                    "source_key": source_key, "purchase_id": purchase["id"],
                    "quantity": quantity, "quantity_unit": purchase.get("quantity_unit") or "unit",
                    "unit_price": unit_price, "supplier_name": purchase.get("supplier_name", ""),
                    "created_by": "system",
                    "created_at": now_iso(),
                }},
                upsert=True, projection={"_id": 0}, return_document=ReturnDocument.AFTER,
            )
            await db.monthly_business_purchase_occurrences.find_one_and_update(
                {"source_key": source_key},
                {"$setOnInsert": {
                    "id": new_id(), "source_key": source_key, "purchase_id": purchase["id"],
                    "month": month, "expense_id": expense["id"], "quantity": quantity,
                    "quantity_unit": purchase.get("quantity_unit") or "unit",
                    "unit_price": unit_price, "amount": amount, "actual_updated": False,
                    "created_at": now_iso(),
                }},
                upsert=True, projection={"_id": 0}, return_document=ReturnDocument.AFTER,
            )

    if pending:
        await asyncio.gather(*(create_occurrence(*item) for item in pending))

@api.get("/monthly-business-purchases")
async def get_monthly_business_purchases(user=Depends(get_current_user)):
    await _sync_monthly_business_expenses()
    purchases = await listall("monthly_business_purchases", sort=("name", 1))
    occurrences = await listall(
        "monthly_business_purchase_occurrences",
        {"purchase_id": {"$in": [purchase["id"] for purchase in purchases]}},
        sort=("month", -1),
        limit=None,
    ) if purchases else []
    occurrences_by_purchase = {}
    for occurrence in occurrences:
        occurrences_by_purchase.setdefault(occurrence["purchase_id"], []).append(occurrence)
    for purchase in purchases:
        purchase["monthly_quantity"] = purchase.get("monthly_quantity") or 1
        purchase["unit_price"] = purchase.get("unit_price") or purchase.get("monthly_amount", 0)
        purchase["quantity_unit"] = purchase.get("quantity_unit") or "unit"
        purchase["category"] = purchase.get("category") or "Materials"
        purchase["expense_day"] = int(purchase.get("expense_day") or 1)
        purchase["monthly_amount"] = buying_amount(purchase["monthly_quantity"], purchase["unit_price"])
        created_month = str(purchase.get("created_at", ""))[:7]
        purchase["start_month"] = purchase.get("start_month") or (
            _next_month(created_month) if re.fullmatch(r"\d{4}-\d{2}", created_month)
            else _next_month(local_today().strftime("%Y-%m"))
        )
        purchase["active"] = purchase.get("active", True)
        purchase["end_month"] = purchase.get("end_month") or ""
        purchase["occurrences"] = occurrences_by_purchase.get(purchase["id"], [])
    return purchases

async def create_monthly_purchase_authorization(purchase_id, action, password, user):
    if action not in {"create", "edit"}:
        raise HTTPException(400, "Unsupported supervisor action")
    if purchase_id and not await db.monthly_business_purchases.find_one({"id": purchase_id}, {"_id": 0, "id": 1}):
        raise HTTPException(404, "Monthly business purchase not found")
    supervisor_id, supervisor_name = await authenticate_supervisor(password, user)
    await db.monthly_business_purchase_edit_authorizations.delete_many({
        "user_id": user["id"],
        "expires_at": {"$lte": datetime.now(timezone.utc)},
    })
    authorization_id = new_id()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    authorization = {
        "id": authorization_id,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "supervisor_id": supervisor_id,
        "action": action,
        "expires_at": expires_at,
    }
    if purchase_id:
        authorization["purchase_id"] = purchase_id
        await log_audit("monthly_business_purchase", purchase_id, "edit_authorized", user,
                        reason=f"Supervisor approval by {supervisor_name}")
    await db.monthly_business_purchase_edit_authorizations.insert_one(authorization)
    return {"authorization_id": authorization_id, "expires_at": expires_at.isoformat()}

async def consume_monthly_purchase_authorization(authorization_id, purchase_id, action, user):
    if can_skip_supervisor_approval(user):
        return {
            "id": authorization_id,
            "purchase_id": purchase_id,
            "user_id": user["id"],
            "company_id": user["_active_company_id"],
            "action": action,
            "supervisor_id": user["id"],
            "supervisor_exempt": True,
        }
    query = {
        "id": authorization_id,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "action": action,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    }
    query["purchase_id"] = purchase_id if purchase_id else {"$exists": False}
    authorization = await db.monthly_business_purchase_edit_authorizations.find_one_and_delete(
        query, projection={"_id": 0},
    )
    if not authorization:
        raise HTTPException(403, "Supervisor approval is required for this monthly purchase action")
    return authorization

@api.post("/monthly-business-purchases/authorize-create")
async def authorize_monthly_purchase_create(
    body: MonthlyBusinessPurchaseAuthorizationIn, user=Depends(get_current_user),
):
    return await create_monthly_purchase_authorization(None, "create", body.password, user)

@api.post("/monthly-business-purchases/{purchase_id}/authorize-edit")
async def authorize_monthly_purchase_edit(
    purchase_id: str, body: MonthlyBusinessPurchaseEditAuthorizationIn,
    user=Depends(get_current_user),
):
    return await create_monthly_purchase_authorization(purchase_id, "edit", body.password, user)

@api.post("/monthly-business-purchases")
async def add_monthly_business_purchase(body: MonthlyBusinessPurchaseIn, user=Depends(get_current_user)):
    _check_monthly_business_purchase(body)
    start_month = body.start_month or _next_month(local_today().strftime("%Y-%m"))
    if body.end_month and body.end_month < start_month:
        raise HTTPException(400, "End month cannot be before the start month")
    authorization = await consume_monthly_purchase_authorization(
        body.supervisor_authorization, None, "create", user,
    )
    data = body.model_dump()
    data.pop("edit_reason", None)
    data.pop("supervisor_authorization", None)
    data.update({
        "name": body.name.strip(), "supplier_name": (body.supplier_name or "").strip(),
        "category": body.category, "quantity_unit": (body.quantity_unit or "unit").strip() or "unit",
        "monthly_quantity": body.monthly_quantity, "unit_price": r2(body.unit_price),
        "expense_day": body.expense_day, "end_month": body.end_month or "",
        "monthly_amount": buying_amount(body.monthly_quantity, body.unit_price),
        "start_month": start_month,
        "supervisor_approved_by": authorization["supervisor_id"],
    })
    rec = await insert("monthly_business_purchases", data)
    await log_audit("monthly_business_purchase", rec["id"], "created", user, after=rec,
                    reason=f"Supervisor approval by {authorization['supervisor_id']}")
    return rec

@api.put("/monthly-business-purchases/{purchase_id}")
async def edit_monthly_business_purchase(purchase_id: str, body: MonthlyBusinessPurchaseIn, user=Depends(get_current_user)):
    _check_monthly_business_purchase(body)
    before = await db.monthly_business_purchases.find_one({"id": purchase_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Monthly business purchase not found")
    reason = (body.edit_reason or "").strip()
    if not reason:
        raise HTTPException(400, "A reason is required to edit a monthly purchase")
    authorization = await consume_monthly_purchase_authorization(
        body.supervisor_authorization, purchase_id, "edit", user,
    )
    start_month = body.start_month or before.get("start_month") or _next_month(local_today().strftime("%Y-%m"))
    if body.end_month and body.end_month < start_month:
        raise HTTPException(400, "End month cannot be before the start month")
    data = body.model_dump()
    data.pop("edit_reason", None)
    data.pop("supervisor_authorization", None)
    data.update({
        "name": body.name.strip(), "supplier_name": (body.supplier_name or "").strip(),
        "category": body.category, "quantity_unit": (body.quantity_unit or "unit").strip() or "unit",
        "monthly_quantity": body.monthly_quantity, "unit_price": r2(body.unit_price),
        "expense_day": body.expense_day, "end_month": body.end_month or "",
        "monthly_amount": buying_amount(body.monthly_quantity, body.unit_price),
        "start_month": start_month,
        "supervisor_approved_by": authorization["supervisor_id"],
    })
    rec = await update_doc("monthly_business_purchases", purchase_id, data)
    await log_audit("monthly_business_purchase", purchase_id, "updated", user,
                    before=before, after=rec, reason=reason)
    return rec

@api.put("/monthly-business-purchases/occurrences/{occurrence_id}")
async def update_monthly_business_purchase_actual(
    occurrence_id: str, body: MonthlyBusinessPurchaseActualIn, user=Depends(get_current_user),
):
    if not math.isfinite(body.quantity) or body.quantity <= 0:
        raise HTTPException(400, "Actual quantity must be greater than 0")
    if not math.isfinite(body.unit_price) or body.unit_price <= 0:
        raise HTTPException(400, "Actual unit price must be greater than 0")
    before = await db.monthly_business_purchase_occurrences.find_one({"id": occurrence_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Monthly purchase record not found")
    expense_before = await db.expenses.find_one({"id": before["expense_id"]}, {"_id": 0})
    if not expense_before or expense_before.get("voided"):
        raise HTTPException(409, "The monthly expense is missing or has been voided")
    reason = (body.edit_reason or "").strip()
    if not reason:
        raise HTTPException(400, "A reason is required to update a monthly expense")
    authorization = await consume_expense_authorization(
        body.supervisor_authorization, expense_before["id"], "monthly_actual", user,
    )
    amount = buying_amount(body.quantity, body.unit_price)
    actual = {
        "quantity": body.quantity, "unit_price": r2(body.unit_price), "amount": amount,
        "actual_updated": True, "actual_updated_at": now_iso(),
    }
    updated_expense = await update_doc("expenses", before["expense_id"], {
        "amount": amount, "quantity": body.quantity, "unit_price": r2(body.unit_price),
        "supervisor_approved_by": authorization["supervisor_id"],
    })
    occurrence = await update_doc("monthly_business_purchase_occurrences", occurrence_id, actual)
    await log_audit("monthly_business_purchase_occurrence", occurrence_id, "actual_updated", user,
                    before=before, after=occurrence)
    await log_audit("expense", expense_before["id"], "monthly_purchase_actual_updated", user,
                    before=expense_before, after=updated_expense, reason=reason)
    return occurrence

@api.get("/purchase-orders")
async def get_purchase_orders(user=Depends(get_current_user)):
    return await listall("purchase_orders", sort=("created_at", -1))

@api.get("/grvs/purchase-orders")
async def get_grv_purchase_orders(user=Depends(get_current_user)):
    orders = await listall("purchase_orders", sort=("created_at", -1))
    return [{
        **order,
        "items": [
            {
                **item,
                "remaining_quantity": max(
                    0, float(item["quantity"]) - float(item.get("received_quantity", 0))
                ),
            }
            for item in order.get("items", [])
        ],
    } for order in orders if order.get("status") in ("ordered", "partially_received")]

def _raw_goes_to_chemicals(is_chemical):
    company = active_company_id.get() or DEFAULT_COMPANY_ID
    return bool(is_chemical) and company in (MANUFACTURING_COMPANY_ID, DEFAULT_COMPANY_ID)

def _grv_purpose(body):
    purpose = (body.purpose or "selling").strip().lower()
    if purpose not in ("selling", "raw_material"):
        raise HTTPException(400, "GRV type must be selling or raw_material")
    return purpose

def _grv_sale_price_updates(items, user, *, require_new_product_prices=True):
    company_id = active_company_id.get() or user.get("_active_company_id") or DEFAULT_COMPANY_ID
    is_superiqfoam = company_id == DEFAULT_COMPANY_ID
    updates = {}
    for line in items:
        if not is_superiqfoam and line.get("sale_price_zone_2") is not None:
            raise HTTPException(400, "Zone 2 sale price is available only for SUPERIQFOAM")
        if float(line.get("accepted_quantity", 0) or 0) <= 0:
            continue
        zone_prices = [(1, line.get("sale_price_zone_1"))]
        if is_superiqfoam:
            zone_prices.append((2, line.get("sale_price_zone_2")))
        if (
            require_new_product_prices
            and line.get("new_product")
            and any(value is None for _, value in zone_prices)
        ):
            raise HTTPException(400, "Enter a sale price for every zone before adding a new product")

        for zone, sale_price in zone_prices:
            if sale_price is None:
                continue
            category = price_category(zone, line.get("product"))
            size = str(line.get("size") or "").strip()
            if not category or not size:
                raise HTTPException(400, "Product name and size are required to update the sale price list")
            key = (zone, category, canonical_price_size(size))
            price_value = r2(sale_price)
            if key in updates and updates[key]["price"] != price_value:
                raise HTTPException(400, "A GRV cannot set different sale prices for the same product and zone")
            updates[key] = {
                "zone": zone,
                "category": category,
                "size": size,
                "price": price_value,
            }

    return list(updates.values())

async def _apply_grv_sale_prices(price_updates, user, grv):
    if not price_updates:
        return

    prices = await listall("prices")
    for update in price_updates:
        aliases = {alias.casefold() for alias in price_category_aliases(update["category"])}
        size = canonical_price_size(update["size"])
        existing = next((
            price for price in prices
            if int(price.get("zone", 0)) == update["zone"]
            and str(price.get("category") or "").strip().casefold() in aliases
            and canonical_price_size(price.get("size")) == size
        ), None)
        values = {
            "price": update["price"],
            "active": True,
            "confirmed": True,
            "archived": False,
            "archived_at": None,
            "archived_by": None,
        }
        if existing:
            if all(existing.get(key) == value for key, value in values.items()):
                continue
            changed = await update_doc("prices", existing["id"], values)
            await log_audit(
                "price", existing["id"], "updated_from_grv", user,
                before=existing, after=changed, reason=grv.get("grv_number", ""),
            )
            prices[prices.index(existing)] = changed
        else:
            created = await insert("prices", {**update, **values})
            await log_audit(
                "price", created["id"], "created_from_grv", user,
                after=created, reason=grv.get("grv_number", ""),
            )
            prices.append(created)

def _raw_grv_items(
    requested_items, is_chemical, *, allow_missing_unit=False,
    allow_missing_chemical_size=False,
):
    if not requested_items:
        raise HTTPException(400, "Add at least one product to the GRV")
    to_chemicals = _raw_goes_to_chemicals(is_chemical)
    result = []
    for line in requested_items:
        data = line.model_dump() if isinstance(line, GRVLineIn) else dict(line)
        name = (data.get("product") or "").strip()
        unit = (data.get("unit") or "").strip()
        if not name:
            raise HTTPException(400, "Enter the name of every raw material")
        if not unit and not allow_missing_unit:
            raise HTTPException(400, f"Enter the unit for {name}")
        size = (data.get("size") or "").strip()
        if to_chemicals and not (allow_missing_chemical_size and not size):
            try:
                capacity = float(size)
            except ValueError:
                capacity = 0
            if capacity <= 0:
                raise HTTPException(400, f"Enter a numeric container capacity in Size for {name}")
        try:
            calculated = validate_grv_line_quantities({
                "actual_received_quantity": data.get("actual_received_quantity", 0),
                "accepted_quantity": data.get("accepted_quantity", 0),
                "rejected_quantity": data.get("rejected_quantity", 0),
                "damaged_quantity": data.get("damaged_quantity", 0),
                "unit_cost": data.get("unit_cost", 0),
            })
        except (TypeError, ValueError) as error:
            raise HTTPException(400, str(error))
        result.append({
            "stock_id": "", "product_code": "", "product": name, "size": size,
            "category": "Chemical" if is_chemical else _raw_inventory_category(data.get("category")),
            "unit": unit, "container_type": (data.get("container_type") or "").strip() or "Barrel",
            "purchase_order_item_index": None, "ordered_quantity": 0,
            "previously_received_quantity": 0, "remaining_quantity": 0,
            **calculated,
        })
    return result

def _raw_key(line):
    return "|".join(
        (line.get(k) or "").strip().lower()
        for k in ("product", "size", "unit", "category", "container_type")
    )


def _raw_inventory_category(value):
    category = (value or "").strip()
    canonical = {
        "glue": "Glue",
        "fabric": "Fabric",
        "fabbric": "Fabric",
        "black fabric": "Black Fabric",
        "black fabbric": "Black Fabric",
        "plastic rolls": "Plastic Rolls",
    }
    return canonical.get(category.casefold(), category or "Other")


def _raw_inventory_identity(line):
    return (
        (line.get("product") or line.get("name") or "").strip().casefold(),
        _raw_inventory_category(line.get("category")).casefold(),
        (line.get("size") or "").strip().casefold(),
        (line.get("unit") or "").strip().casefold(),
    )


async def _raw_inventory_target(line, is_chemical, create=False):
    product = line["product"].strip()
    unit_value = line["unit"].strip()
    if _raw_goes_to_chemicals(is_chemical):
        name = re.escape(product)
        unit = re.escape(unit_value)
        container = re.escape(line.get("container_type") or "Barrel")
        query = {
            "chemical": {"$regex": f"^{name}$", "$options": "i"},
            "capacity": float(line["size"]),
            "unit": {"$regex": f"^{unit}$", "$options": "i"},
            "container_type": {"$regex": f"^{container}$", "$options": "i"},
        }
        found = await db.chemical_inventory.find_one(query, {"_id": 0})
        if found or not create:
            return "chemical_inventory", found
        created = await insert("chemical_inventory", {
            "chemical": line["product"].strip(), "container_type": line.get("container_type") or "Barrel",
            "capacity": float(line["size"]), "unit": line["unit"].strip(), "count": 0,
        })
        return "chemical_inventory", created
    category = _raw_inventory_category(line.get("category"))
    size = (line.get("size") or "").strip()
    identity = _raw_inventory_identity({
        **line, "product": product, "category": category, "size": size, "unit": unit_value,
    })
    cursor = db.company_inventory.find(
        {"name": {"$regex": f"^{re.escape(product)}$", "$options": "i"}},
        {"_id": 0},
    )
    found = None
    async for item in cursor:
        if _raw_inventory_identity(item) == identity:
            found = item
            break
    if found:
        normalized = {
            "name": product,
            "category": category,
            "size": size,
            "unit": unit_value,
        }
        if any(found.get(key, "") != value for key, value in normalized.items()):
            found = await update_doc("company_inventory", found["id"], normalized)
        return "company_inventory", found
    if not create:
        return "company_inventory", None
    created = await insert("company_inventory", {
        "name": product, "category": category,
        "size": size, "packaging": "", "packages": 0,
        "units_per_package": 0, "loose_units": 0, "unit": unit_value, "notes": "Created by GRV",
    })
    return "company_inventory", created

async def _apply_raw_grv(grv, user, direction, *, allow_negative=False, allow_missing_target=False):
    """Post (direction=1) or reverse (direction=-1) accepted raw-material quantities; idempotent per GRV line group."""
    is_chemical = bool(grv.get("is_chemical"))
    grouped = {}
    for line in grv.get("items", []):
        quantity = float(line.get("accepted_quantity", 0))
        if quantity <= 0:
            continue
        key = _raw_key(line)
        if key in grouped:
            grouped[key]["quantity"] = round(grouped[key]["quantity"] + quantity, 4)
        else:
            grouped[key] = {"line": line, "quantity": quantity}
    posted = []
    for key, entry in grouped.items():
        dedupe = f"grv-raw:{'in' if direction == 1 else 'out'}:{grv['id']}:{key}"
        if await db.raw_material_movements.find_one({"dedupe_key": dedupe}, {"_id": 0}):
            continue
        if direction == 1:
            collection, target = await _raw_inventory_target(entry["line"], is_chemical, create=True)
            target_id = target["id"]
        else:
            original = await db.raw_material_movements.find_one(
                {"dedupe_key": f"grv-raw:in:{grv['id']}:{key}"}, {"_id": 0})
            if not original:
                continue
            collection, target_id = original["collection"], original["target_id"]
            target = await getattr(db, collection).find_one({"id": target_id}, {"_id": 0})
            if not target:
                if allow_missing_target:
                    continue
                raise HTTPException(409, f"Inventory item no longer exists: {entry['line']['product']}")
        if collection == "chemical_inventory":
            field = "count"
        elif target.get("daily_remaining_quantity") is not None:
            field = "daily_remaining_quantity"
        else:
            field = "loose_units"
        current = float(target.get(field, 0))
        new_value = round(current + direction * entry["quantity"], 4)
        if new_value < -1e-9 and not allow_negative:
            raise HTTPException(409, f"Cannot reverse {entry['line']['product']}: only {current:g} remain in inventory")
        await update_doc(collection, target_id, {
            field: new_value if allow_negative else max(new_value, 0),
        })
        await insert("raw_material_movements", {
            "dedupe_key": dedupe, "grv_id": grv["id"], "grv_number": grv.get("grv_number", ""),
            "collection": collection, "target_id": target_id, "quantity": entry["quantity"],
            "direction": direction, "product": entry["line"]["product"], "created_by": user["email"],
        })
        posted.append({"collection": collection, "target_id": target_id, "quantity": entry["quantity"]})
    return posted


async def rebuild_superiqfoam_company_inventory(user):
    grvs = [grv async for grv in db.grvs.find({}, {"_id": 0})]
    raw_grvs = [grv for grv in grvs if grv.get("purpose") == "raw_material"]
    if any(grv.get("status") in ("confirming", "reversing") for grv in raw_grvs):
        raise HTTPException(409, "Wait for the current raw-material GRV operation to finish, then retry")

    confirmed_statuses = {"completed", "partially_received", "discrepancy"}
    inventory_totals = {}
    source_movements = []
    for grv in raw_grvs:
        if grv.get("status") not in confirmed_statuses or grv.get("is_chemical"):
            continue
        grv_lines = {}
        for line in grv.get("items", []):
            try:
                quantity = float(line.get("accepted_quantity", 0) or 0)
            except (TypeError, ValueError, OverflowError) as error:
                raise HTTPException(409, f"GRV {grv.get('grv_number', grv['id'])} has an invalid accepted quantity") from error
            if not math.isfinite(quantity) or quantity < 0:
                raise HTTPException(409, f"GRV {grv.get('grv_number', grv['id'])} has an invalid accepted quantity")
            if quantity == 0:
                continue
            material = {
                **line,
                "product": (line.get("product") or "").strip(),
                "category": _raw_inventory_category(line.get("category")),
                "size": (line.get("size") or "").strip(),
                "unit": (line.get("unit") or "").strip(),
            }
            if not material["product"]:
                raise HTTPException(409, f"GRV {grv.get('grv_number', grv['id'])} has a raw material without a name")
            key = _raw_key(line)
            if key not in grv_lines:
                grv_lines[key] = {"line": material, "quantity": quantity}
            else:
                grv_lines[key]["quantity"] = round(grv_lines[key]["quantity"] + quantity, 4)

        for raw_key, entry in grv_lines.items():
            identity = _raw_inventory_identity(entry["line"])
            if identity not in inventory_totals:
                inventory_totals[identity] = {
                    "line": entry["line"],
                    "quantity": 0,
                }
            inventory_totals[identity]["quantity"] = round(
                inventory_totals[identity]["quantity"] + entry["quantity"], 4,
            )
            source_movements.append({
                "grv": grv,
                "raw_key": raw_key,
                "line": entry["line"],
                "quantity": entry["quantity"],
                "identity": identity,
            })

    existing_items = [
        item async for item in db.company_inventory.find({}, {"_id": 0})
    ]
    existing_by_identity = {}
    for item in existing_items:
        existing_by_identity.setdefault(_raw_inventory_identity(item), item)

    user_name = user.get("name") or user.get("username") or ""
    rebuilt_ids = set()
    identity_to_id = {}
    for identity, entry in inventory_totals.items():
        existing = existing_by_identity.get(identity)
        item_id = existing["id"] if existing else new_id()
        identity_to_id[identity] = item_id
        rebuilt_ids.add(item_id)
        quantity = round(entry["quantity"], 4)
        item_data = {
            "name": entry["line"]["product"],
            "category": entry["line"]["category"],
            "size": entry["line"]["size"],
            "packaging": "",
            "packages": 0,
            "units_per_package": 0,
            "loose_units": quantity,
            "unit": entry["line"]["unit"],
            "notes": "Rebuilt from confirmed GRVs",
            "stock_reference_quantity": quantity,
            "daily_remaining_quantity": None,
            "daily_remaining_date": None,
            "created_by": user["id"],
            "created_by_name": user_name,
        }
        if existing:
            await update_doc("company_inventory", item_id, item_data)
        else:
            await insert("company_inventory", {"id": item_id, **item_data})

    for movement in source_movements:
        dedupe_key = f"grv-raw:in:{movement['grv']['id']}:{movement['raw_key']}"
        values = {
            "collection": "company_inventory",
            "target_id": identity_to_id[movement["identity"]],
            "quantity": movement["quantity"],
            "direction": 1,
        }
        existing = await db.raw_material_movements.find_one(
            {"dedupe_key": dedupe_key}, {"_id": 0},
        )
        if existing:
            await db.raw_material_movements.update_one(
                {"dedupe_key": dedupe_key}, {"$set": values},
            )
        else:
            await insert("raw_material_movements", {
                "dedupe_key": dedupe_key,
                "grv_id": movement["grv"]["id"],
                "grv_number": movement["grv"].get("grv_number", ""),
                "product": movement["line"]["product"],
                "created_by": user["email"],
                **values,
            })

    if rebuilt_ids:
        await db.company_inventory.delete_many({"id": {"$nin": list(rebuilt_ids)}})
    else:
        await db.company_inventory.delete_many({})
    await db.company_inventory_daily_updates.delete_many({})

    result = {
        "ok": True,
        "grvs_replayed": len({
            movement["grv"]["id"] for movement in source_movements
        }),
        "inventory_items": len(rebuilt_ids),
    }
    await log_audit(
        "company_inventory", "superiqfoam", "rebuilt_from_grvs",
        user, after=result,
    )
    return result


async def _grv_items_from_request(
    requested_items, purchase_order=None, *, allow_blank_new_product_size=False,
):
    if purchase_order and not requested_items:
        requested_items = [
            GRVLineIn(
                stock_id=item.get("stock_id", ""),
                purchase_order_item_index=index,
                actual_received_quantity=0,
            )
            for index, item in enumerate(purchase_order.get("items", []))
            if float(item["quantity"]) > float(item.get("received_quantity", 0))
        ]
    if not requested_items:
        raise HTTPException(400, "Add at least one product to the GRV")

    result = []
    new_product_keys = set()
    for line in requested_items:
        data = line.model_dump() if isinstance(line, GRVLineIn) else dict(line)
        po_index = data.get("purchase_order_item_index")
        po_item = None
        if purchase_order:
            if data.get("new_product"):
                raise HTTPException(400, "New products cannot be added to a purchase-order GRV")
            if po_index is None or not 0 <= po_index < len(purchase_order.get("items", [])):
                raise HTTPException(400, "Each GRV line must identify its purchase-order line")
            po_item = purchase_order["items"][po_index]
            remaining = max(
                0, float(po_item["quantity"]) - float(po_item.get("received_quantity", 0))
            )
            if remaining <= 0:
                raise HTTPException(409, "The selected purchase-order line is already fully received")
            stock_id = po_item.get("stock_id")
            product = po_item.get("product", "")
            size = po_item.get("size", "")
            unit_cost = po_item.get("unit_price", 0)
            ordered_quantity = po_item["quantity"]
            previously_received = po_item.get("received_quantity", 0)
        else:
            is_new_product = bool(data.get("new_product"))
            product = (data.get("product") or "").strip()
            size = (data.get("size") or "").strip()
            stock_id = (data.get("stock_id") or "").strip()
            stock = None
            if is_new_product and (
                not product or (not size and not allow_blank_new_product_size)
            ):
                raise HTTPException(400, "Enter a category/product name and size for every new product")
            if is_new_product:
                new_product_key = (product.casefold(), canonical_price_size(size).casefold())
                if new_product_key in new_product_keys:
                    raise HTTPException(400, "A new product and size can appear only once in the GRV")
                new_product_keys.add(new_product_key)
                stock = await db.stock.find_one({
                    "product": {"$regex": f"^{re.escape(product)}$", "$options": "i"},
                    "size": {"$regex": f"^{re.escape(size)}$", "$options": "i"},
                }, {"_id": 0})
                if stock:
                    raise HTTPException(400, "This product and size already exist in stock; select the existing product")
            else:
                stock = await db.stock.find_one({"id": stock_id}, {"_id": 0}) if stock_id else None
            if not is_new_product and not stock and product and size:
                stock = await db.stock.find_one({
                    "product": {"$regex": f"^{re.escape(product)}$", "$options": "i"},
                    "size": {"$regex": f"^{re.escape(size)}$", "$options": "i"},
                }, {"_id": 0})
            if not is_new_product and not stock:
                raise HTTPException(400, "Select a valid stock product for every GRV line")
            if stock:
                stock_id = stock["id"]
                product = stock["product"]
                size = stock.get("size", "")
            unit_cost = data.get("unit_cost", 0)
            ordered_quantity = data.get("ordered_quantity", 0)
            previously_received = data.get("previously_received_quantity", 0)
            remaining = data.get("remaining_quantity", 0)

        if not (not purchase_order and data.get("new_product")):
            stock = await db.stock.find_one({"id": stock_id}, {"_id": 0}) if stock_id else None
            if not stock:
                raise HTTPException(409, f"Stock item is missing for {product} {size}")
        quantity_values = {
            "actual_received_quantity": data.get("actual_received_quantity", 0),
            "accepted_quantity": data.get("accepted_quantity", 0),
            "rejected_quantity": data.get("rejected_quantity", 0),
            "damaged_quantity": data.get("damaged_quantity", 0),
            "unit_cost": unit_cost,
        }
        try:
            calculated = validate_grv_line_quantities(
                quantity_values, remaining=remaining if purchase_order else None,
            )
        except (TypeError, ValueError) as error:
            raise HTTPException(400, str(error))
        result.append({
            "stock_id": stock_id,
            "product_code": (
                data.get("product_code") or (stock or {}).get("code") or stock_id
            ),
            "new_product": bool(data.get("new_product")),
            "product": product,
            "size": size,
            "purchase_order_item_index": po_index,
            "ordered_quantity": float(ordered_quantity or 0),
            "previously_received_quantity": float(previously_received or 0),
            "remaining_quantity": float(remaining or 0),
            "sale_price_zone_1": data.get("sale_price_zone_1"),
            "sale_price_zone_2": data.get("sale_price_zone_2"),
            **calculated,
        })
    return result

async def _materialize_grv_new_products(grv, user):
    items = [dict(line) for line in grv.get("items", [])]
    changed = False
    for index, line in enumerate(items):
        if not line.get("new_product"):
            continue
        product = (line.get("product") or "").strip()
        size = (line.get("size") or "").strip()
        if not product or (not size and not grv.get("source_buying_id")):
            raise HTTPException(400, "Enter a category/product name and size for every new product")
        existing = await db.stock.find_one(
            {"created_from_grv_id": grv["id"], "created_from_grv_line": index},
            {"_id": 0},
        )
        if not existing:
            duplicate = await db.stock.find_one({
                "product": {"$regex": f"^{re.escape(product)}$", "$options": "i"},
                "size": {"$regex": f"^{re.escape(size)}$", "$options": "i"},
            }, {"_id": 0})
            if duplicate:
                raise HTTPException(
                    409,
                    f"{product} {size} already exists in stock; edit this GRV to select the existing product",
                )
            existing = await insert("stock", {
                "product": product,
                "size": size,
                "unit_cost": float(line.get("unit_cost", 0) or 0),
                "threshold": 5,
                "created_from_grv_id": grv["id"],
                "created_from_grv_line": index,
            })
        await ensure_product_identification(
            existing, user.get("_active_company_id") or DEFAULT_COMPANY_ID,
        )
        line["stock_id"] = existing["id"]
        line["product_code"] = existing.get("code") or existing.get("product_id") or existing["id"]
        changed = True

    if changed:
        saved = await db.grvs.update_one(
            {"id": grv["id"], "status": "confirming"},
            {"$set": {"items": items, "edited_by": user["email"]}},
        )
        if not saved.matched_count:
            raise HTTPException(409, "GRV confirmation state changed; reload and retry")
        grv["items"] = items
    return items

def _validate_grv_date(value):
    try:
        parsed = date.fromisoformat(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "Received date must use YYYY-MM-DD format")
    if parsed.isoformat() != value:
        raise HTTPException(400, "Received date must use YYYY-MM-DD format")

def _grv_status_filter(query_params, user):
    filters = {}
    profile_id = query_params.get("company_profile_id")
    if profile_id and profile_id != user["_active_company_id"]:
        raise HTTPException(403, "GRVs are only available for the active company profile")
    supplier_id = query_params.get("supplier_id")
    if supplier_id:
        filters["supplier_id"] = supplier_id
    status = query_params.get("status")
    if status:
        if status not in ("draft", "pending_inspection", "partially_received", "completed", "discrepancy", "cancelled"):
            raise HTTPException(400, "Invalid GRV status filter")
        filters["status"] = status
    received_from = query_params.get("date_from")
    received_to = query_params.get("date_to")
    if received_from:
        _validate_grv_date(received_from)
    if received_to:
        _validate_grv_date(received_to)
    if received_from and received_to and received_from > received_to:
        raise HTTPException(400, "Start date must not be after end date")
    if received_from or received_to:
        filters["received_date"] = {
            **({"$gte": received_from} if received_from else {}),
            **({"$lte": received_to} if received_to else {}),
        }
    return filters

@api.get("/grvs/dashboard")
async def get_grv_dashboard(
    date_from: str = "", date_to: str = "", supplier_id: str = "",
    company_profile_id: str = "", status: str = "", user=Depends(get_current_user),
):
    filters = _grv_status_filter({
        "date_from": date_from, "date_to": date_to,
        "supplier_id": supplier_id, "company_profile_id": company_profile_id,
        "status": status,
    }, user)
    records = await listall("grvs", filters, sort=("created_at", -1))
    profile = next(
        (item for item in COMPANY_PROFILES if item["id"] == user["_active_company_id"]), None,
    )
    return {
        "company_profile_id": user["_active_company_id"],
        "company_profile_name": profile["name"] if profile else user["_active_company_id"],
        "total_grvs": len(records),
        "pending_grvs": sum(
            item.get("status") in ("draft", "pending_inspection", "confirming")
            for item in records
        ),
        "completed_grvs": sum(item.get("status") == "completed" for item in records),
        "partially_received_grvs": sum(item.get("status") == "partially_received" for item in records),
        "discrepancy_grvs": sum(item.get("status") == "discrepancy" for item in records),
        "rejected_items": sum(
            float(line.get("rejected_quantity", 0)) > 0
            for item in records for line in item.get("items", [])
        ),
        "rejected_quantity": sum(
            float(line.get("rejected_quantity", 0))
            for item in records for line in item.get("items", [])
        ),
        "recent_grvs": records[:10],
    }

@api.get("/grvs")
async def get_grvs(
    date_from: str = "", date_to: str = "", supplier_id: str = "",
    company_profile_id: str = "", status: str = "", user=Depends(get_current_user),
):
    filters = _grv_status_filter({
        "date_from": date_from, "date_to": date_to,
        "supplier_id": supplier_id, "company_profile_id": company_profile_id,
        "status": status,
    }, user)
    return await listall("grvs", filters, sort=("created_at", -1))

@api.post("/grvs")
async def create_grv(body: GRVIn, user=Depends(get_current_user)):
    _validate_grv_date(body.received_date)
    purchase_order_id = (body.purchase_order_id or "").strip()
    purchase_order = None
    if purchase_order_id:
        purchase_order = await db.purchase_orders.find_one({"id": purchase_order_id}, {"_id": 0})
        if not purchase_order:
            raise HTTPException(404, "Purchase order not found in the active company")
        if purchase_order.get("status") not in ("ordered", "partially_received"):
            raise HTTPException(409, "Only open purchase orders can be linked to a new GRV")
    supplier_id = (body.supplier_id or "").strip()
    supplier_name = (body.supplier_name or "").strip()
    if purchase_order:
        supplier_id = purchase_order.get("supplier_id", "")
        supplier_name = purchase_order.get("supplier_name", "")
    elif supplier_id:
        supplier = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
        if not supplier:
            raise HTTPException(400, "Supplier not found in the active company")
        supplier_name = supplier["name"]
    if not supplier_name:
        raise HTTPException(400, "Select a supplier")
    purpose = _grv_purpose(body)
    if purpose == "raw_material":
        if purchase_order:
            raise HTTPException(400, "Raw-material GRVs cannot be linked to a purchase order")
        items = _raw_grv_items(body.items, body.is_chemical)
    else:
        items = await _grv_items_from_request(body.items, purchase_order)
    reference = await next_ref("grv", "GRV")
    record = {
        "grv_number": reference,
        "supplier_id": supplier_id,
        "supplier_name": supplier_name,
        "purchase_order_id": purchase_order_id,
        "purchase_order_reference": purchase_order.get("reference", "") if purchase_order else "",
        "delivery_note_number": (body.delivery_note_number or "").strip(),
        "received_date": body.received_date,
        "received_by": (body.received_by or user.get("name") or user["email"]).strip(),
        "warehouse": (body.warehouse or "").strip(),
        "notes": (body.notes or "").strip(),
        "items": items,
        "purpose": purpose,
        "is_chemical": bool(body.is_chemical) if purpose == "raw_material" else False,
        "status": "draft",
        "created_by": user["email"],
        "edited_by": user["email"],
        "audit": [{"action": "created", "by": user["email"], "at": now_iso()}],
    }
    created = await insert("grvs", record)
    await log_audit("grv", created["id"], "created", user, after=created)
    await emit_workflow_event("grv.created", {
        **created, "item_count": len(created.get("items", [])),
    })
    return created

@api.put("/grvs/{grv_id}")
async def edit_grv(grv_id: str, body: GRVIn, user=Depends(get_current_user)):
    before = await db.grvs.find_one({"id": grv_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "GRV not found")
    if before.get("status") != "draft":
        raise HTTPException(409, "Only draft GRVs can be edited; confirmed GRVs require a traceable reversal")
    _validate_grv_date(body.received_date)
    purchase_order_id = (body.purchase_order_id or "").strip()
    purchase_order = await db.purchase_orders.find_one({"id": purchase_order_id}, {"_id": 0}) if purchase_order_id else None
    if purchase_order_id and not purchase_order:
        raise HTTPException(404, "Purchase order not found in the active company")
    supplier_id = purchase_order.get("supplier_id", "") if purchase_order else (body.supplier_id or "").strip()
    supplier_name = purchase_order.get("supplier_name", "") if purchase_order else (body.supplier_name or "").strip()
    if not purchase_order and supplier_id:
        supplier = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
        if not supplier:
            raise HTTPException(400, "Supplier not found in the active company")
        supplier_name = supplier["name"]
    if not supplier_name:
        raise HTTPException(400, "Select a supplier")
    purpose = _grv_purpose(body)
    if purpose == "raw_material":
        if purchase_order:
            raise HTTPException(400, "Raw-material GRVs cannot be linked to a purchase order")
        items = _raw_grv_items(body.items, body.is_chemical)
    else:
        items = await _grv_items_from_request(body.items, purchase_order)
    audit = before.get("audit", []) + [{"action": "edited", "by": user["email"], "at": now_iso()}]
    updates = {
        "supplier_id": supplier_id,
        "supplier_name": supplier_name,
        "purchase_order_id": purchase_order_id,
        "purchase_order_reference": purchase_order.get("reference", "") if purchase_order else "",
        "delivery_note_number": (body.delivery_note_number or "").strip(),
        "received_date": body.received_date,
        "received_by": (body.received_by or user.get("name") or user["email"]).strip(),
        "warehouse": (body.warehouse or "").strip(),
        "notes": (body.notes or "").strip(),
        "items": items,
        "purpose": purpose,
        "is_chemical": bool(body.is_chemical) if purpose == "raw_material" else False,
        "edited_by": user["email"],
        "audit": audit,
    }
    changed = await db.grvs.update_one(
        {"id": grv_id, "status": "draft"},
        {"$set": {**updates, "updated_at": now_iso()}},
    )
    if not changed.matched_count:
        raise HTTPException(409, "Only draft GRVs can be edited; reload and try again")
    updated = await db.grvs.find_one({"id": grv_id}, {"_id": 0})
    await log_audit("grv", grv_id, "edited", user, before=before, after=updated)
    await emit_workflow_event("grv.updated", {
        **updated, "item_count": len(updated.get("items", [])),
    })
    return updated

@api.post("/grvs/{grv_id}/inspect")
async def mark_grv_pending_inspection(grv_id: str, user=Depends(get_current_user)):
    before = await db.grvs.find_one_and_update(
        {"id": grv_id, "status": "draft"},
        {"$set": {
            "status": "pending_inspection",
            "edited_by": user["email"],
            "updated_at": now_iso(),
        }, "$push": {
            "audit": {"action": "pending_inspection", "by": user["email"], "at": now_iso()},
        }},
        projection={"_id": 0}, return_document=ReturnDocument.AFTER,
    )
    if not before:
        if not await db.grvs.find_one({"id": grv_id}, {"_id": 1}):
            raise HTTPException(404, "GRV not found")
        raise HTTPException(409, "Only draft GRVs can enter inspection")
    updated = before
    await log_audit("grv", grv_id, "pending_inspection", user, before=before, after=updated)
    await emit_workflow_event("grv.pending_inspection", {
        **updated, "item_count": len(updated.get("items", [])),
    })
    return updated

@api.post("/grvs/{grv_id}/confirm")
async def confirm_grv(grv_id: str, user=Depends(get_current_user)):
    grv = await db.grvs.find_one({"id": grv_id}, {"_id": 0})
    if not grv:
        raise HTTPException(404, "GRV not found")
    if grv.get("status") in ("completed", "partially_received", "discrepancy", "cancelled"):
        raise HTTPException(409, "This GRV has already been confirmed or cancelled")
    _validate_grv_date(grv["received_date"])
    price_check_items = []
    for line in grv.get("items", []):
        try:
            calculated = validate_grv_line_quantities(
                line,
                remaining=line.get("remaining_quantity") if grv.get("purchase_order_id") else None,
            )
        except (TypeError, ValueError) as error:
            raise HTTPException(400, str(error))
        price_check_items.append({**line, **calculated})
    price_updates = (
        _grv_sale_price_updates(
            price_check_items,
            user,
            require_new_product_prices=not bool(grv.get("source_buying_id")),
        )
        if grv.get("purpose") != "raw_material" else []
    )
    if price_updates:
        if worker_restrictions_apply(user):
            raise HTTPException(403, "A company owner must confirm GRVs that change the price list")
        require_price_list_owner(user)
    if grv.get("status") in ("draft", "pending_inspection"):
        grv = await db.grvs.find_one_and_update(
            {"id": grv_id, "status": {"$in": ["draft", "pending_inspection"]}},
            {"$set": {"status": "confirming"}},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER,
        )
        if not grv:
            raise HTTPException(409, "GRV confirmation is already in progress")

    try:
        await _materialize_grv_new_products(grv, user)
        normalized_items = []
        po = None
        if grv.get("purchase_order_id"):
            po = await db.purchase_orders.find_one({"id": grv["purchase_order_id"]}, {"_id": 0})
            if not po:
                raise HTTPException(409, "Linked purchase order is no longer available")
        for line in grv.get("items", []):
            try:
                calculated = validate_grv_line_quantities(
                    line,
                    remaining=line.get("remaining_quantity") if po else None,
                )
            except (TypeError, ValueError) as error:
                raise HTTPException(400, str(error))
            normalized_items.append({**line, **calculated})
        if not normalized_items:
            raise HTTPException(400, "GRV has no product lines")
        if not any(line["actual_received_quantity"] > 0 for line in normalized_items):
            raise HTTPException(400, "Enter an actual received quantity before confirming the GRV")
        if grv.get("purpose") == "raw_material":
            await _apply_raw_grv({**grv, "items": normalized_items}, user, 1)
            audit = grv.get("audit", []) + [{"action": "confirmed", "by": user["email"], "at": now_iso()}]
            updated = await update_doc("grvs", grv_id, {
                "items": normalized_items,
                "status": grv_confirmation_status(normalized_items, True),
                "movement_ids": [],
                "confirmed_by": user["email"], "confirmed_at": now_iso(),
                "edited_by": user["email"], "audit": audit,
            })
            await log_audit("grv", grv_id, "confirmed", user, before=grv, after=updated)
            await emit_workflow_event("grv.confirmed", {**updated, "item_count": len(updated.get("items", []))})
            return updated
        accepted = aggregate_accepted_stock_lines(normalized_items)
        stock_ids = [item["stock_id"] for item in accepted]
        async with StockLock(stock_ids):
            po_lock_acquired = False
            if po:
                locked = await db.purchase_orders.find_one_and_update(
                    {
                        "id": po["id"],
                        "$or": [
                            {"receiving_grv_id": {"$exists": False}},
                            {"receiving_grv_id": grv_id},
                        ],
                    },
                    {"$set": {"receiving_grv_id": grv_id}},
                    projection={"_id": 0}, return_document=ReturnDocument.AFTER,
                )
                if not locked:
                    raise HTTPException(409, "Another GRV is currently receiving this purchase order")
                po_lock_acquired = True
                po = locked
                received_by_index = {}
                for line in normalized_items:
                    index = line.get("purchase_order_item_index")
                    if index is None or not 0 <= index < len(po.get("items", [])):
                        raise HTTPException(409, "GRV purchase-order line mapping is invalid")
                    po_item = po["items"][index]
                    if po_item.get("stock_id") != line["stock_id"]:
                        raise HTTPException(409, "GRV product no longer matches its purchase-order line")
                    received_by_index[index] = (
                        received_by_index.get(index, 0)
                        + line["actual_received_quantity"]
                    )
                for index, quantity in received_by_index.items():
                    po_item = po["items"][index]
                    remaining = max(
                        0, float(po_item["quantity"]) - float(po_item.get("received_quantity", 0))
                    )
                    if grv_id not in po.get("grv_receipts", []) and quantity > remaining:
                        raise HTTPException(
                            409,
                            f"Only {remaining:g} remain for {po_item['product']} {po_item.get('size', '')}",
                        )

            movement_ids = []
            try:
                for item in accepted:
                    stock = await db.stock.find_one({"id": item["stock_id"]}, {"_id": 0})
                    if not stock:
                        raise HTTPException(409, f"Stock item no longer exists: {item['product']} {item['size']}")
                    if stock["product"] != item["product"] or stock.get("size", "") != item["size"]:
                        raise HTTPException(409, "GRV product no longer matches its stock record")
                    dedupe_key = f"grv:{grv_id}:{item['stock_id']}"
                    movement = await db.stock_movements.find_one({"dedupe_key": dedupe_key}, {"_id": 0})
                    if movement:
                        if (
                            movement.get("grv_id") != grv_id
                            or float(movement.get("quantity", 0)) != item["quantity"]
                            or movement.get("direction", 1) != 1
                        ):
                            raise HTTPException(409, "A conflicting stock movement already uses this GRV")
                    else:
                        movement = await post_movement(
                            stock, "purchase", item["quantity"], user,
                            reason=f"Goods received {grv['grv_number']}",
                            reference=grv["grv_number"],
                            dedupe_key=dedupe_key, direction=1,
                            extra={
                                "grv_id": grv_id,
                                "grv_number": grv["grv_number"],
                                "purchase_order_id": grv.get("purchase_order_id", ""),
                                "receiving_date": grv["received_date"],
                                "date": grv["received_date"],
                                "warehouse": grv.get("warehouse", ""),
                                "unit_cost": item["unit_cost"],
                                "total_value": item["total_value"],
                                "batch_id": f"grv:{grv_id}:{item['stock_id']}",
                                "batch_date": grv["received_date"],
                                "batch_quantity": item["quantity"],
                                "historical_cost_status": "verified" if D(item["unit_cost"]) > 0 else "unavailable",
                            },
                        )
                        await log_audit("stock_movement", movement["id"], "posted", user, after=movement)
                    movement_ids.append(movement["id"])

                po_complete = True
                if po:
                    increments = {}
                    next_received = []
                    for index, item in enumerate(po["items"]):
                        quantity = received_by_index.get(index, 0)
                        if quantity:
                            increments[f"items.{index}.received_quantity"] = quantity
                        current_received = float(item.get("received_quantity", 0)) + quantity
                        next_received.append(current_received)
                        if current_received + 1e-8 < float(item["quantity"]):
                            po_complete = False
                    update = {
                        "$addToSet": {"grv_receipts": grv_id},
                        "$set": {
                            "status": "received" if po_complete else "partially_received",
                            **({"received_at": now_iso()} if po_complete else {}),
                        },
                    }
                    if increments:
                        update["$inc"] = increments
                    changed = await db.purchase_orders.update_one(
                        {"id": po["id"], "grv_receipts": {"$ne": grv_id}}, update,
                    )
                    if changed.matched_count == 0:
                        latest = await db.purchase_orders.find_one({"id": po["id"]}, {"_id": 0})
                        if grv_id not in latest.get("grv_receipts", []):
                            raise HTTPException(409, "Purchase order receipt could not be recorded")
                        next_received = [
                            float(item.get("received_quantity", 0))
                            for item in latest.get("items", [])
                        ]
                        po_complete = all(
                            received + 1e-8 >= float(item["quantity"])
                            for received, item in zip(next_received, latest.get("items", []))
                        )
                status = grv_confirmation_status(
                    normalized_items, po_complete if po else True,
                )
                await _apply_grv_sale_prices(price_updates, user, grv)
                audit = grv.get("audit", []) + [{
                    "action": "confirmed", "by": user["email"], "at": now_iso(),
                }]
                updated = await update_doc("grvs", grv_id, {
                    "items": normalized_items,
                    "status": status,
                    "movement_ids": movement_ids,
                    "confirmed_by": user["email"],
                    "confirmed_at": now_iso(),
                    "edited_by": user["email"],
                    "audit": audit,
                })
            finally:
                if po_lock_acquired:
                    await db.purchase_orders.update_one(
                        {"id": po["id"], "receiving_grv_id": grv_id},
                        {"$unset": {"receiving_grv_id": ""}},
                    )
        await log_audit("grv", grv_id, "confirmed", user, before=grv, after=updated)
        await emit_workflow_event("grv.confirmed", {
            **updated, "item_count": len(updated.get("items", [])),
        })
        if updated.get("purchase_order_id"):
            received_order = await db.purchase_orders.find_one(
                {"id": updated["purchase_order_id"]}, {"_id": 0},
            )
            if received_order:
                await emit_workflow_event("purchase_order.received", received_order)
        return updated
    except HTTPException:
        raise
    except Exception:
        logging.exception("GRV confirmation failed; retry is safe because stock movement keys are idempotent")
        raise HTTPException(502, "GRV confirmation failed. Retry the confirmation or ask an administrator to inspect the GRV.")

@api.post("/grvs/{grv_id}/cancel")
async def cancel_grv(grv_id: str, body: ReasonIn, user=Depends(get_current_user)):
    if not body.reason.strip():
        raise HTTPException(400, "A cancellation reason is required")
    audit_entry = {
        "action": "cancelled", "by": user["email"], "at": now_iso(),
        "reason": body.reason.strip(),
    }
    original = await db.grvs.find_one({"id": grv_id}, {"_id": 0})
    if not original:
        raise HTTPException(404, "GRV not found")
    before = await db.grvs.find_one_and_update(
        {"id": grv_id, "status": {"$in": ["draft", "pending_inspection"]}},
        {"$set": {"status": "cancelled", "cancel_reason": body.reason.strip(),
                  "cancelled_by": user["email"], "cancelled_at": now_iso(),
                  "updated_at": now_iso()},
         "$push": {"audit": audit_entry},
        },
        projection={"_id": 0}, return_document=ReturnDocument.AFTER,
    )
    if not before:
        raise HTTPException(409, "Only unconfirmed GRVs can be cancelled")
    await log_audit("grv", grv_id, "cancelled", user, before=original, after=before,
                    reason=body.reason.strip())
    await emit_workflow_event("grv.cancelled", {
        **before, "item_count": len(before.get("items", [])),
    })
    return before

async def _reverse_grv(
    grv_id: str, body: ReasonIn, user, *, allow_negative=False, allow_missing_items=False,
):
    if not allow_negative:
        require_admin(user)
    reason = body.reason.strip()
    if not reason:
        raise HTTPException(400, "A reason is required to reverse a confirmed GRV")
    grv = await db.grvs.find_one({"id": grv_id}, {"_id": 0})
    if not grv:
        raise HTTPException(404, "GRV not found")
    if grv.get("status") == "cancelled":
        raise HTTPException(409, "This GRV has already been reversed or cancelled")
    if grv.get("status") not in ("completed", "partially_received", "discrepancy", "reversing"):
        raise HTTPException(409, "Only a confirmed GRV can be reversed")
    if grv.get("status") != "reversing":
        grv = await db.grvs.find_one_and_update(
            {"id": grv_id, "status": {"$in": ["completed", "partially_received", "discrepancy"]}},
            {"$set": {
                "status": "reversing",
                "reversal_reason": reason,
                "reversal_started_by": user["email"],
                "reversal_started_at": now_iso(),
            }},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER,
        )
        if not grv:
            raise HTTPException(409, "GRV reversal is already in progress")

    if grv.get("purpose") == "raw_material":
        await _apply_raw_grv(
            grv, user, -1,
            allow_negative=allow_negative,
            allow_missing_target=allow_missing_items,
        )
        updated = await update_doc("grvs", grv_id, {
            "status": "cancelled", "reversed_by": user["email"], "reversed_at": now_iso(),
            "reversal_reason": reason, "reversal_movement_ids": [], "edited_by": user["email"],
            "audit": grv.get("audit", []) + [{"action": "reversed", "by": user["email"], "at": now_iso(), "reason": reason}],
        })
        await log_audit("grv", grv_id, "reversed", user, before=grv, after=updated, reason=reason)
        await emit_workflow_event("grv.cancelled", {**updated, "item_count": len(updated.get("items", []))})
        return updated

    accepted = aggregate_accepted_stock_lines(grv.get("items", []))
    po = None
    if grv.get("purchase_order_id"):
        po = await db.purchase_orders.find_one({"id": grv["purchase_order_id"]}, {"_id": 0})
        if not po:
            raise HTTPException(409, "Linked purchase order is no longer available")

    requested_stock_ids = list({item["stock_id"] for item in accepted})
    stock_cursor = db.stock.find({"id": {"$in": requested_stock_ids}}, {"_id": 0})
    existing_stock_ids = {stock["id"] async for stock in stock_cursor}
    missing_stock_items = [item for item in accepted if item["stock_id"] not in existing_stock_ids]
    if missing_stock_items and not allow_missing_items:
        item = missing_stock_items[0]
        raise HTTPException(409, f"Stock item no longer exists: {item['product']} {item['size']}")

    async with StockLock(
        existing_stock_ids,
        wait_seconds=30 if allow_missing_items else 5,
        skip_missing=allow_missing_items,
    ), PurchaseOrderReceiptLock(
        po["id"] if po else "", grv_id,
    ):
        stock_cursor = db.stock.find({"id": {"$in": list(existing_stock_ids)}}, {"_id": 0})
        stocks = {stock["id"]: stock async for stock in stock_cursor}
        stock_ids = list(stocks)
        for item in accepted:
            if item["stock_id"] not in stocks and allow_missing_items:
                continue
            if item["stock_id"] not in stocks:
                raise HTTPException(409, f"Stock item no longer exists: {item['product']} {item['size']}")

        reversal_keys = [f"grv-reversal:{grv_id}:{stock_id}" for stock_id in stock_ids]
        receipt_keys = [f"grv:{grv_id}:{stock_id}" for stock_id in stock_ids]
        movement_cursor = db.stock_movements.find(
            {"dedupe_key": {"$in": reversal_keys + receipt_keys}}, {"_id": 0},
        )
        movements_by_key = {
            movement["dedupe_key"]: movement async for movement in movement_cursor
        }
        stock_deltas = await stock_movement_totals_by_stock_id(stock_ids)

        reverse_ids = []
        for item in accepted:
            if item["stock_id"] not in stocks and allow_missing_items:
                continue
            stock = stocks[item["stock_id"]]
            key = f"grv-reversal:{grv_id}:{item['stock_id']}"
            movement = movements_by_key.get(key)
            if not movement:
                current = r2(D(stock.get("opening", 0)) + stock_deltas[item["stock_id"]])
                if D(item["quantity"]) > D(current) and not allow_negative:
                    raise HTTPException(
                        409,
                        f"Cannot reverse {item['product']} {item['size']}: only {current} remain in stock",
                    )
                received_movement = movements_by_key.get(f"grv:{grv_id}:{item['stock_id']}")
                unit_cost = received_movement.get("unit_cost") if received_movement else item.get("unit_cost")
                cost_status = (
                    received_movement.get("historical_cost_status")
                    if received_movement else None
                )
                if not cost_status:
                    cost_status = "verified" if unit_cost is not None and D(unit_cost) > 0 else "unavailable"
                movement = await post_movement(
                    stock, "reversal", item["quantity"], user,
                    reason=f"Reversal of {grv['grv_number']}",
                    reference=grv["grv_number"], dedupe_key=key,
                    direction=-1, allow_negative=True, extra={
                        "grv_id": grv_id,
                        "grv_number": grv["grv_number"],
                        "reverses_grv": True,
                        "reversal_reason": reason,
                        "warehouse": grv.get("warehouse", ""),
                        "batch_allocations": [{
                            "batch_id": (
                                (received_movement.get("batch_id") or received_movement.get("id"))
                                if received_movement else f"grv:{grv_id}:{item['stock_id']}"
                            ),
                            "quantity": item["quantity"],
                            "unit_cost": unit_cost if cost_status == "verified" else None,
                            "cost_status": cost_status,
                            "source_type": "purchase",
                            "source_date": grv.get("received_date"),
                            "grv_id": grv_id,
                        }],
                    },
                )
                await log_audit("stock_movement", movement["id"], "posted", user, after=movement,
                                reason=reason)
            reverse_ids.append(movement["id"])

        if po:
            increments = {}
            if grv_id not in po.get("grv_reversals", []):
                for line in grv.get("items", []):
                    index = line.get("purchase_order_item_index")
                    quantity = float(line.get("actual_received_quantity", 0))
                    if index is None or not quantity:
                        continue
                    if not 0 <= index < len(po.get("items", [])):
                        raise HTTPException(409, "GRV purchase-order line mapping is invalid")
                    if float(po["items"][index].get("received_quantity", 0)) < quantity:
                        raise HTTPException(409, "Purchase-order quantities no longer match this GRV")
                    increments[f"items.{index}.received_quantity"] = (
                        increments.get(f"items.{index}.received_quantity", 0) - quantity
                    )
                update = {
                    "$addToSet": {"grv_reversals": grv_id},
                    "$set": {"status": "ordered"},
                }
                if increments:
                    update["$inc"] = increments
                changed = await db.purchase_orders.update_one(
                    {"id": po["id"], "grv_reversals": {"$ne": grv_id}}, update,
                )
                if changed.matched_count == 0:
                    latest = await db.purchase_orders.find_one({"id": po["id"]}, {"_id": 0})
                    if grv_id not in latest.get("grv_reversals", []):
                        raise HTTPException(409, "Purchase-order receipt could not be reversed")
            latest = await db.purchase_orders.find_one({"id": po["id"]}, {"_id": 0})
            complete = all(
                float(item.get("received_quantity", 0)) >= float(item["quantity"])
                for item in latest.get("items", [])
            )
            any_received = any(float(item.get("received_quantity", 0)) > 0 for item in latest.get("items", []))
            po_status = "received" if complete else ("partially_received" if any_received else "ordered")
            await db.purchase_orders.update_one(
                {"id": po["id"]}, {"$set": {"status": po_status}},
            )

    audit = grv.get("audit", []) + [{
        "action": "reversed", "by": user["email"], "at": now_iso(), "reason": reason,
    }]
    updated = await update_doc("grvs", grv_id, {
        "status": "cancelled",
        "reversed_by": user["email"],
        "reversed_at": now_iso(),
        "reversal_reason": reason,
        "reversal_movement_ids": reverse_ids,
        "edited_by": user["email"],
        "audit": audit,
    })
    await log_audit("grv", grv_id, "reversed", user, before=grv, after=updated, reason=reason)
    await emit_workflow_event("grv.cancelled", {
        **updated, "item_count": len(updated.get("items", [])),
    })
    return updated


@api.post("/grvs/{grv_id}/reverse")
async def reverse_grv(grv_id: str, body: ReasonIn, user=Depends(get_current_user)):
    return await _reverse_grv(grv_id, body, user)


def require_grv_delete_owner(user):
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    is_company_owner = (
        not user.get("is_worker")
        and (
            user.get("_active_role") == "owner"
            or (user.get("company_roles") or {}).get(company_id) == "owner"
        )
    )
    if not is_global_owner_account(user) and not is_company_owner:
        raise HTTPException(403, "Global owner or active company owner access required")


@api.post("/grvs/rebuild-company-inventory")
async def rebuild_company_inventory_from_grvs(user=Depends(get_current_user)):
    company_id = active_company_id.get() or user.get("_active_company_id") or DEFAULT_COMPANY_ID
    if company_id != DEFAULT_COMPANY_ID:
        raise HTTPException(404, "This action is available only for SUPERIQFOAM")
    require_grv_delete_owner(user)
    return await rebuild_superiqfoam_company_inventory(user)


async def _delete_grv_record(grv_id, user):
    grv = await db.grvs.find_one({"id": grv_id}, {"_id": 0})
    if not grv:
        raise HTTPException(404, "GRV not found")
    if grv.get("status") in ("completed", "partially_received", "discrepancy", "reversing"):
        await _reverse_grv(
            grv_id,
            ReasonIn(reason="GRV permanently deleted by an authorized owner"),
            user,
            allow_negative=True,
            allow_missing_items=True,
        )
        grv = await db.grvs.find_one({"id": grv_id}, {"_id": 0})
    if grv.get("status") not in ("draft", "pending_inspection", "cancelled"):
        raise HTTPException(409, "GRV is being confirmed or cannot be safely deleted")

    result = await db.grvs.delete_one({
        "id": grv_id,
        "status": {"$in": ["draft", "pending_inspection", "cancelled"]},
    })
    if result.deleted_count != 1:
        raise HTTPException(409, "GRV changed before it could be deleted")
    source_buying_id = grv.get("source_buying_id")
    if source_buying_id:
        buying = await db.buyings.find_one({
            "id": source_buying_id,
            "transferred_to_grv_id": grv_id,
        }, {"_id": 0})
        if buying:
            await db.buyings.update_one(
                {"id": source_buying_id, "transferred_to_grv_id": grv_id},
                {"$unset": {"transferred_to_grv_id": ""}},
            )
            after = dict(buying)
            after.pop("transferred_to_grv_id", None)
            await log_audit(
                "buying", source_buying_id, "linked_grv_deleted", user,
                before=buying, after=after,
            )
    await log_audit("grv", grv_id, "deleted", user, before=grv)
    return grv


@api.delete("/grvs/{grv_id}")
async def delete_grv(
    grv_id: str, body: GRVDeleteIn = GRVDeleteIn(),
    user=Depends(get_current_user),
):
    require_grv_delete_owner(user)
    await _delete_grv_record(grv_id, user)
    return {"ok": True, "deleted": True}


@api.post("/grvs/bulk-delete")
async def bulk_delete_grvs(body: GRVBulkDeleteIn, user=Depends(get_current_user)):
    require_grv_delete_owner(user)
    ids = list(dict.fromkeys(grv_id.strip() for grv_id in body.ids if grv_id.strip()))
    if not ids:
        raise HTTPException(400, "Select at least one GRV to delete")

    deleted = []
    failed = []
    for grv_id in ids:
        try:
            grv = await _delete_grv_record(grv_id, user)
            deleted.append({"id": grv_id, "grv_number": grv.get("grv_number", grv_id)})
        except HTTPException as error:
            failed.append({
                "id": grv_id,
                "message": error.detail,
            })
    return {"deleted": deleted, "failed": failed}

@api.post("/purchase-orders")
async def add_purchase_order(body: PurchaseOrderIn, user=Depends(get_current_user)):
    _check_purchase_order(body)
    data = await _purchase_order_data(body)
    data.update({"reference": await next_ref("purchase-order", "PO"), "status": "draft"})
    rec = await insert("purchase_orders", data)
    await log_audit("purchase_order", rec["id"], "created", user, after=rec)
    await emit_workflow_event("purchase_order.created", rec)
    return rec

@api.put("/purchase-orders/{order_id}")
async def edit_purchase_order(order_id: str, body: PurchaseOrderIn, user=Depends(get_current_user)):
    _check_purchase_order(body)
    before = await db.purchase_orders.find_one({"id": order_id}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Purchase order not found")
    if before.get("status") != "draft":
        raise HTTPException(409, "Only draft purchase orders can be edited")
    data = await _purchase_order_data(body)
    rec = await update_doc("purchase_orders", order_id, data)
    await log_audit("purchase_order", order_id, "updated", user, before=before, after=rec)
    await emit_workflow_event("purchase_order.updated", rec)
    return rec

@api.post("/purchase-orders/{order_id}/order")
async def place_purchase_order(order_id: str, user=Depends(get_current_user)):
    rec = await db.purchase_orders.find_one_and_update(
        {"id": order_id, "status": "draft"},
        {"$set": {"status": "ordered", "ordered_at": now_iso()}},
        projection={"_id": 0}, return_document=ReturnDocument.AFTER,
    )
    if not rec:
        raise HTTPException(409, "Purchase order is not a draft")
    await log_audit("purchase_order", order_id, "ordered", user, after=rec)
    await emit_workflow_event("purchase_order.ordered", rec)
    return rec

@api.post("/purchase-orders/{order_id}/receive")
async def receive_purchase_order(order_id: str, user=Depends(get_current_user)):
    raise HTTPException(
        409,
        "Direct purchase-order receiving is disabled. Create and confirm a GRV instead.",
    )

class ExpenseIn(BaseModel):
    description: str
    amount: float
    date: str = Field(default_factory=today_str)
    category: str = "General"
    payment_method: Optional[str] = "Cash"
    reference: Optional[str] = ""
    vehicle_id: Optional[str] = ""
    destination_city: Optional[str] = Field(default="", max_length=100)
    notes: Optional[str] = ""
    edit_reason: Optional[str] = ""
    supervisor_authorization: Optional[str] = None

class ExpenseAuthorizationIn(BaseModel):
    password: str

class ExpenseActionAuthorizationIn(BaseModel):
    password: str
    action: str

class ProductionCostItemIn(BaseModel):
    description: str
    quantity: float
    unit: str
    unit_cost: float

class ProductionCostRecordIn(BaseModel):
    product: str
    production_date: str = Field(default_factory=today_str)
    quantity_produced: float
    quantity_unit: str = "block"
    selling_price_per_unit: float
    cost_items: List[ProductionCostItemIn]
    notes: Optional[str] = ""

def production_cost_record_data(body):
    if not body.product.strip():
        raise HTTPException(400, "Product name is required")
    if not math.isfinite(body.quantity_produced) or body.quantity_produced <= 0:
        raise HTTPException(400, "Quantity produced must be greater than 0")
    if not math.isfinite(body.selling_price_per_unit) or body.selling_price_per_unit <= 0:
        raise HTTPException(400, "Selling price per unit must be greater than 0")
    try:
        date.fromisoformat(body.production_date)
    except ValueError:
        raise HTTPException(400, "Production date must use YYYY-MM-DD format")
    if not body.cost_items:
        raise HTTPException(400, "Add at least one production material or cost")

    items = []
    for item in body.cost_items:
        if not item.description.strip():
            raise HTTPException(400, "Every production cost needs a description")
        if not item.unit.strip():
            raise HTTPException(400, "Every production cost needs a unit of measure")
        if not math.isfinite(item.quantity) or item.quantity <= 0:
            raise HTTPException(400, "Material quantities must be greater than 0")
        if not math.isfinite(item.unit_cost) or item.unit_cost <= 0:
            raise HTTPException(400, "Material unit costs must be greater than 0")
        if not math.isfinite(item.quantity * item.unit_cost):
            raise HTTPException(400, "Material cost is too large")
        items.append({
            "description": item.description.strip(),
            "quantity": item.quantity,
            "unit": item.unit.strip(),
            "unit_cost": item.unit_cost,
        })

    if not math.isfinite(body.quantity_produced * body.selling_price_per_unit):
        raise HTTPException(400, "Potential sales revenue is too large")
    calculations = calculate_production_cost(
        body.quantity_produced, body.selling_price_per_unit, items,
    )
    if any(not math.isfinite(value) for value in (
        calculations["total_production_cost"],
        calculations["cost_per_unit"],
        calculations["selling_price_per_unit"],
        calculations["profit_per_unit"],
        calculations["revenue_if_all_sold"],
        calculations["total_profit_if_all_sold"],
    )):
        raise HTTPException(400, "Calculated production cost is too large")
    return {
        "product": body.product.strip(),
        "production_date": body.production_date,
        "quantity_produced": body.quantity_produced,
        "quantity_unit": body.quantity_unit.strip() or "unit",
        "notes": (body.notes or "").strip(),
        **calculations,
        "calculation_method": "sum(quantity used × unit cost); total cost ÷ quantity produced",
    }

@api.get("/cost-records")
async def get_cost_records(user=Depends(get_current_user)):
    return await listall("cost_records", sort=("production_date", -1))

@api.post("/cost-records")
async def add_cost_record(body: ProductionCostRecordIn, user=Depends(get_current_user)):
    record = await insert("cost_records", production_cost_record_data(body))
    await log_audit("cost_record", record["id"], "created", user, after=record)
    return record

@api.delete("/cost-records/{record_id}")
async def delete_cost_record(record_id: str, user=Depends(get_current_user)):
    record = await db.cost_records.find_one({"id": record_id}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Production cost not found")
    result = await db.cost_records.delete_one({"id": record_id})
    if not result.deleted_count:
        raise HTTPException(404, "Production cost not found")
    await log_audit("cost_record", record_id, "permanently_deleted", user, before=record,
                    after={"permanently_deleted": True})
    return {"ok": True, "deleted": True}

async def create_expense_authorization(expense_id, action, password, user):
    if action not in {"create", "edit", "void", "monthly_actual"}:
        raise HTTPException(400, "Unsupported supervisor action")
    if expense_id:
        expense = await db.expenses.find_one({"id": expense_id}, {"_id": 0, "id": 1, "voided": 1})
        if not expense:
            raise HTTPException(404, "Expense not found")
        if expense.get("voided") and action in {"edit", "monthly_actual"}:
            raise HTTPException(409, "A voided expense cannot be changed")
        expense_details = await db.expenses.find_one({"id": expense_id}, {"_id": 0, "source_key": 1}) or {}
        if action == "edit" and expense_details.get("source_key"):
            raise HTTPException(400, "This expense is linked to a purchase and cannot be edited directly")
        if action == "monthly_actual" and not (expense_details.get("source_key") or "").startswith("monthly_business_purchase:"):
            raise HTTPException(400, "This is not a monthly purchase expense")
        if action == "void" and expense.get("voided"):
            raise HTTPException(400, "Expense is already voided")
    supervisor_id, supervisor_name = await authenticate_supervisor(password, user)
    await db.expense_edit_authorizations.delete_many({
        "user_id": user["id"],
        "expires_at": {"$lte": datetime.now(timezone.utc)},
    })
    authorization_id = new_id()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    authorization = {
        "id": authorization_id,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "supervisor_id": supervisor_id,
        "action": action,
        "expires_at": expires_at,
    }
    if expense_id:
        authorization["expense_id"] = expense_id
        await log_audit("expense", expense_id, f"{action}_authorized", user,
                        reason=f"Supervisor approval by {supervisor_name}")
    await db.expense_edit_authorizations.insert_one(authorization)
    return {"authorization_id": authorization_id, "expires_at": expires_at.isoformat()}

async def consume_expense_authorization(authorization_id, expense_id, action, user):
    if can_skip_supervisor_approval(user):
        return {
            "id": authorization_id,
            "expense_id": expense_id,
            "user_id": user["id"],
            "company_id": user["_active_company_id"],
            "action": action,
            "supervisor_id": user["id"],
            "supervisor_exempt": True,
        }
    query = {
        "id": authorization_id,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "action": action,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    }
    if expense_id:
        query["expense_id"] = expense_id
    else:
        query["expense_id"] = {"$exists": False}
    authorization = await db.expense_edit_authorizations.find_one_and_delete(query, projection={"_id": 0})
    if not authorization:
        raise HTTPException(403, "Supervisor approval is required for this expense action")
    return authorization

@api.post("/expenses/authorize-create")
async def authorize_expense_create(body: ExpenseAuthorizationIn, user=Depends(get_current_user)):
    return await create_expense_authorization(None, "create", body.password, user)

@api.post("/expenses/{eid}/authorize-action")
async def authorize_expense_action(eid: str, body: ExpenseActionAuthorizationIn, user=Depends(get_current_user)):
    if body.action not in {"edit", "void", "monthly_actual"}:
        raise HTTPException(400, "Unsupported supervisor action")
    return await create_expense_authorization(eid, body.action, body.password, user)

def _check_expense(body, user):
    if body.amount <= 0:
        raise HTTPException(400, "Amount must be greater than 0")
    if not body.description.strip():
        raise HTTPException(400, "Description is required")
    if (body.destination_city or "").strip():
        if user.get("_active_company_id") != DEFAULT_COMPANY_ID:
            raise HTTPException(400, "Diesel destination cities are only available for SUPERIQFOAM")
        if body.category != "Diesel" or not body.vehicle_id:
            raise HTTPException(400, "A destination city can only be recorded for diesel expenses assigned to a vehicle")
    if body.category in {"Bilal", "Yassine", "Bilal and Yassine", "Personal Car", "Home"}:
        if user.get("_active_company_id") != DEFAULT_COMPANY_ID:
            raise HTTPException(400, "Personal expense categories are only available for SUPERIQFOAM")

@api.get("/expenses")
async def get_expenses(include_voided: bool = False, include_archived: bool = False, user=Depends(get_current_user)):
    flt = {}
    if not include_voided:
        flt["voided"] = {"$ne": True}
    if not include_archived:
        flt["archived"] = {"$ne": True}
    return await listall("expenses", flt, sort=("date", -1))

def report_date_filter(selected_date):
    selected = date.fromisoformat(selected_date)
    dates = [(selected + timedelta(days=offset)).isoformat() for offset in (-1, 0, 1)]
    start = datetime.combine(selected, datetime.min.time(), TZ).astimezone(timezone.utc)
    end = datetime.combine(selected + timedelta(days=1), datetime.min.time(), TZ).astimezone(timezone.utc)
    return {"$or": [
        {"date": {"$in": dates}},
        *({"date": {"$regex": f"^{day}T"}} for day in dates),
        {"date": {"$gte": start, "$lt": end}},
    ]}

def record_local_date(record):
    value = record.get("date")
    try:
        if isinstance(value, datetime):
            parsed = value
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            parsed = parse_dt(value)
        if parsed is None:
            return None
        return parsed.astimezone(TZ).date().isoformat()
    except (TypeError, ValueError, OverflowError):
        return None

async def daily_report_records(collection_name, selected_date, conditions=None, sort_field="date"):
    query = {"$and": [report_date_filter(selected_date), conditions or {}]}
    cursor = db[collection_name].find(query, {"_id": 0}).sort(sort_field, 1)
    records = await cursor.to_list(None)
    return [record for record in records if record_local_date(record) == selected_date]

@api.get("/daily-report")
async def get_daily_report(report_date: Optional[str] = None, user=Depends(get_current_user)):
    company_id = user.get("_active_company_id") or DEFAULT_COMPANY_ID
    company_name = {
        "superiqfoam": "SUPER IQ-FOAM",
        "iqfoam-whole-sallers": "IQFOAM WHOLESALERS",
        "iqfoam-manufactoring": "IQFOAM MANUFACTURING",
    }.get(company_id, "SUPER IQ-FOAM")
    selected_date = report_date or today_str()
    try:
        selected_date = date.fromisoformat(selected_date).isoformat()
    except ValueError:
        raise HTTPException(422, "Report date must be a valid YYYY-MM-DD date")

    invoice_records, payments, expense_records = await asyncio.gather(
        daily_report_records(
            "invoices",
            selected_date,
            {
                "archived": {"$ne": True},
                "$or": [
                    {"invoice_type": {"$ne": "express"}},
                    {"invoice_type": "express", "include_on_daily_report": True},
                ],
            },
        ),
        daily_report_records(
            "payments",
            selected_date,
            {"archived": {"$ne": True}, "reversed": {"$ne": True}},
            "created_at",
        ),
        daily_report_records(
            "expenses",
            selected_date,
            {"voided": {"$ne": True}, "archived": {"$ne": True}},
            "created_at",
        ),
    )
    invoice_records.sort(key=lambda invoice: str(invoice.get("number") or ""))
    invoices = [
        {
            "id": invoice.get("id"),
            "number": invoice.get("number"),
            "client_name": invoice.get("customer_name") or invoice.get("description") or "",
            "amount": r2(invoice.get("total", 0)),
        }
        for invoice in invoice_records
        if invoice.get("number") and invoice.get("status") != "void"
    ]
    pending_invoices = [
        {
            "id": invoice.get("id"),
            "client_name": invoice.get("customer_name") or invoice.get("description") or "",
            "amount": r2(invoice.get("total", 0)),
        }
        for invoice in invoice_records
        if not invoice.get("number") and invoice.get("status") not in ("void",)
    ]

    linked_invoice_ids = list({payment.get("invoice_id") for payment in payments if payment.get("invoice_id")})
    fuel_categories = {"fuel", "diesel"}
    fuel_expenses = [
        expense for expense in expense_records
        if str(expense.get("category") or "").strip().casefold() in fuel_categories
    ]
    vehicle_ids = list({expense.get("vehicle_id") for expense in fuel_expenses if expense.get("vehicle_id")})
    async def find_records(collection, ids):
        if not ids:
            return []
        return await db[collection].find({"id": {"$in": ids}}, {"_id": 0}).to_list(None)

    linked_invoices, vehicles = await asyncio.gather(
        find_records("invoices", linked_invoice_ids),
        find_records("vehicles", vehicle_ids),
    )
    invoice_by_id = {invoice["id"]: invoice for invoice in linked_invoices}
    payment_rows = []
    for payment in payments:
        invoice = invoice_by_id.get(payment.get("invoice_id"), {})
        if invoice.get("invoice_type") == "express" or (payment.get("other_balance_payment") and payment.get("express")):
            if payment.get("daily_report_inclusion_set"):
                if not payment.get("include_on_daily_report"):
                    continue
            elif not invoice.get("include_on_daily_report") and not payment.get("include_on_daily_report"):
                continue
        note_parts = []
        for value in (
            payment.get("notes"),
            payment.get("reference"),
            payment.get("description"),
            payment.get("method"),
            payment.get("receiving_on"),
        ):
            text = str(value or "").strip()
            if text and text not in note_parts:
                note_parts.append(text)
        payment_rows.append({
            "id": payment.get("id"),
            "client_name": payment.get("customer_name") or invoice.get("customer_name") or "",
            "invoice_number": payment.get("invoice_number") or invoice.get("number") or "",
            "amount": r2(payment.get("amount", 0)),
            "notes": " | ".join(note_parts),
        })

    home_expense_rows = [
        {
            "id": expense.get("id"),
            "category": expense.get("category") or "Home",
            "description": expense.get("description") or "",
            "amount": r2(expense.get("amount", 0)),
        }
        for expense in expense_records
        if str(expense.get("category") or "").strip().casefold() == "home"
    ]
    expense_rows = [
        {
            "id": expense.get("id"),
            "category": expense.get("category") or "General",
            "description": expense.get("description") or "",
            "amount": r2(expense.get("amount", 0)),
        }
        for expense in expense_records
        if str(expense.get("category") or "").strip().casefold() not in fuel_categories | {"home"}
    ]
    vehicle_by_id = {vehicle["id"]: vehicle for vehicle in vehicles}
    diesel_rows = []
    unassigned_fuel_rows = []
    for expense in fuel_expenses:
        vehicle = vehicle_by_id.get(expense.get("vehicle_id"))
        row = {
            "id": expense.get("id"),
            "vehicle": vehicle.get("name") if vehicle else "VEHICLE REQUIRED",
            "amount": r2(expense.get("amount", 0)),
            "notes": " | ".join(dict.fromkeys(
                str(value).strip()
                for value in (expense.get("notes"), expense.get("reference"))
                if str(value or "").strip()
            )),
        }
        diesel_rows.append(row)
        if not vehicle:
            unassigned_fuel_rows.append({
                "id": expense.get("id"),
                "description": expense.get("description") or "",
                "amount": r2(expense.get("amount", 0)),
            })

    return {
        "company_id": company_id,
        "company_name": company_name,
        "date": selected_date,
        "day": date.fromisoformat(selected_date).strftime("%A"),
        "prepared_by": "Mr. Zuny",
        "main_invoice_no": invoices[0]["number"] if invoices else "",
        "invoices": invoices,
        "pending_invoices": pending_invoices,
        "payments": payment_rows,
        "expenses": expense_rows,
        "home_expenses": home_expense_rows,
        "diesel_usage": diesel_rows,
        "unassigned_fuel_expenses": unassigned_fuel_rows,
        "totals": {
            "sending": dsum(row["amount"] for row in invoices),
            "received": dsum(row["amount"] for row in payment_rows),
            "expenses": dsum(row["amount"] for row in expense_rows),
            "home_expenses": dsum(row["amount"] for row in home_expense_rows),
            "diesel": dsum(row["amount"] for row in diesel_rows),
        },
    }

def financial_period_range(period, value):
    if period == "weekly":
        try:
            selected = date.fromisoformat(value)
        except (TypeError, ValueError):
            raise HTTPException(422, "Week selector must be a valid YYYY-MM-DD date")
        start = selected - timedelta(days=selected.weekday())
        return start, start + timedelta(days=6)
    if period == "monthly":
        if not re.fullmatch(r"\d{4}-\d{2}", str(value or "")):
            raise HTTPException(422, "Month selector must use YYYY-MM format")
        try:
            start = date.fromisoformat(f"{value}-01")
        except ValueError:
            raise HTTPException(422, "Month selector must be a valid YYYY-MM month")
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        return start, next_month - timedelta(days=1)
    raise HTTPException(422, "Period must be weekly or monthly")

def financial_previous_period_range(period, start, end):
    previous_end = start - timedelta(days=1)
    if period == "monthly":
        previous_start = previous_end.replace(day=1)
    else:
        previous_start = previous_end - (end - start)
    return previous_start, previous_end

def financial_record_date(record, field="date"):
    value = record.get(field)
    if isinstance(value, datetime):
        parsed = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return parsed.astimezone(TZ).date()
    if not value:
        return None
    try:
        text = str(value)
        if len(text) > 10:
            return parse_dt(text).astimezone(TZ).date()
        return date.fromisoformat(text[:10])
    except (TypeError, ValueError, OverflowError):
        return None

def financial_report_company(user, requested_company_id=None):
    company_id = requested_company_id or user.get("_active_company_id") or DEFAULT_COMPANY_ID
    if company_id not in allowed_company_ids(user):
        raise HTTPException(403, "You do not have access to financial reports for this company")
    return company_id

async def financial_period_records(collection, start, end, date_field="date", conditions=None):
    lower_date = (start - timedelta(days=1)).isoformat()
    upper_date = (end + timedelta(days=2)).isoformat()
    lower_dt = datetime.combine(start, datetime.min.time(), TZ).astimezone(timezone.utc) - timedelta(days=1)
    upper_dt = datetime.combine(end + timedelta(days=1), datetime.min.time(), TZ).astimezone(timezone.utc)
    query = {"$and": [
        {"$or": [
            {date_field: {"$gte": lower_date, "$lt": upper_date}},
            {date_field: {"$gte": lower_dt, "$lt": upper_dt}},
        ]},
        conditions or {},
    ]}
    records = await db[collection].find(query, {"_id": 0}).to_list(None)
    return [
        record for record in records
        if (record_date := financial_record_date(record, date_field)) is not None
        and start <= record_date <= end
    ]

def _financial_transaction(record, category, amount, description=None, supplier=None, reference=None):
    return {
        "id": record.get("id"),
        "date": record.get("date") or record.get("received_date") or "",
        "category": category,
        "description": description or record.get("description") or "",
        "supplier": supplier or "",
        "amount": r2(amount),
        "reference": reference or record.get("reference") or record.get("number") or "",
        "source_record": record,
    }


GRV_CONFIRMED_STATUSES = ("completed", "partially_received", "discrepancy")


def grv_accepted_value(grv):
    return dsum(
        line.get(
            "total_value",
            D(line.get("accepted_quantity", 0)) * D(line.get("unit_cost", 0)),
        )
        for line in grv.get("items", [])
    )


def build_financial_report(start, end, mode, *, invoices, payments, linked_payments,
                           expenses, vehicle_records, buyings, grvs, invoice_movements,
                           payment_invoices=None, salary_rows=(), vehicles_by_id=None,
                           all_outstanding_invoices=None, all_outstanding_payments=None):
    invoices = unique_financial_records(invoices)
    payments = unique_financial_records(payments)
    linked_payments = unique_financial_records(linked_payments)
    expenses = unique_financial_records(expenses)
    vehicle_records = unique_financial_records(vehicle_records)
    buyings = unique_financial_records(buyings)
    grvs = unique_financial_records(grvs)
    invoice_movements = unique_financial_records(invoice_movements)
    payment_invoices = unique_financial_records(payment_invoices or [])

    payments_by_invoice = {}
    for payment in linked_payments:
        if payment.get("reversed") or payment.get("archived"):
            continue
        payment_id = payment.get("invoice_id")
        payments_by_invoice[payment_id] = (
            D(payments_by_invoice.get(payment_id, 0)) + D(payment.get("amount", 0))
        )

    issued_invoices = [
        invoice for invoice in invoices
        if not invoice.get("archived")
        and invoice.get("invoice_type") != "express"
        and invoice.get("status") not in ("draft", "void")
        and invoice.get("number")
    ]
    sales_invoices = [
        invoice for invoice in issued_invoices if not invoice.get("opening_balance")
    ]
    invoice_rows = []
    pending_rows = []
    revenue_values = []
    invoices_by_id = {invoice.get("id"): invoice for invoice in issued_invoices}
    referenced_invoices_by_id = {
        invoice.get("id"): invoice
        for invoice in (payment_invoices or [])
        if invoice.get("id")
    }
    referenced_invoices_by_id.update(invoices_by_id)
    payment_history_by_invoice = {}
    payment_balance_after_by_id = {}
    for payment in linked_payments:
        if payment.get("reversed") or payment.get("archived"):
            continue
        invoice_id = payment.get("invoice_id")
        if invoice_id:
            payment_history_by_invoice.setdefault(invoice_id, []).append(payment)
    for invoice_id, history in payment_history_by_invoice.items():
        invoice = referenced_invoices_by_id.get(invoice_id)
        if not invoice:
            continue
        running_paid = Decimal("0")
        for payment in sorted(
            history,
            key=lambda row: (
                str(row.get("date") or ""),
                str(row.get("created_at") or ""),
                str(row.get("id") or ""),
            ),
        ):
            running_paid += D(payment.get("amount", 0))
            if payment.get("id"):
                payment_balance_after_by_id[payment["id"]] = r2(
                    max(D(invoice.get("total", 0)) - running_paid, Decimal("0"))
                )

    for invoice in sales_invoices:
        amount = r2(invoice.get("total", 0))
        revenue_values.append(amount)
        paid = payments_by_invoice.get(invoice.get("id"))
        if paid is None:
            paid = D(invoice.get("amount_paid", 0))
        outstanding = max(D(amount) - paid, Decimal("0"))
        status_invoice = {
            **invoice,
            "amount_paid": float(paid),
            "outstanding": float(outstanding),
        }
        payment_history = sorted(
            payment_history_by_invoice.get(invoice.get("id"), []),
            key=lambda row: (
                str(row.get("date") or ""),
                str(row.get("created_at") or ""),
                str(row.get("id") or ""),
            ),
        )
        invoice_rows.append(_financial_transaction(
            invoice, "Invoice", amount,
            description=invoice.get("customer_name") or invoice.get("description") or "",
            reference=invoice.get("number") or "",
        ) | {"number": invoice.get("number"), "customer_name": invoice.get("customer_name", ""),
             "amount_paid": r2(paid), "outstanding": r2(outstanding),
             "balance_remaining": r2(outstanding), "status": derive_status(status_invoice),
             "payment_records": [
                 {
                     "id": payment.get("id"),
                     "date": payment.get("date") or "",
                     "amount": r2(payment.get("amount", 0)),
                     "method": payment.get("method") or "",
                     "reference": payment.get("reference") or "",
                     "notes": payment.get("notes") or "",
                     "balance_remaining": payment_balance_after_by_id.get(payment.get("id")),
                 }
                 for payment in payment_history
             ],
             "items": invoice.get("items") or []})
    payment_rows = []
    for payment in payments:
        if payment.get("reversed") or payment.get("archived"):
            continue
        linked_invoice = referenced_invoices_by_id.get(payment.get("invoice_id"))
        payment_rows.append(
            _financial_transaction(
                payment,
                "Payment",
                payment.get("amount", 0),
                description=(
                    payment.get("customer_name")
                    or (linked_invoice or {}).get("customer_name")
                    or payment.get("notes")
                    or ""
                ),
                reference=payment.get("reference") or payment.get("invoice_number") or "",
            )
            | {
                "invoice_id": payment.get("invoice_id"),
                "invoice_number": (
                    payment.get("invoice_number")
                    or (linked_invoice or {}).get("number")
                    or ""
                ),
                "customer_name": (
                    payment.get("customer_name")
                    or (linked_invoice or {}).get("customer_name")
                    or ""
                ),
                "method": payment.get("method", ""),
                "notes": payment.get("notes", ""),
                "invoice_total": (
                    r2(linked_invoice.get("total", 0)) if linked_invoice else None
                ),
                "balance_remaining": payment_balance_after_by_id.get(payment.get("id")),
                "invoice_items": (linked_invoice or {}).get("items") or [],
            }
        )

    expense_rows = [
        _financial_transaction(
            expense, expense.get("category") or "General", expense.get("amount", 0),
            supplier=expense.get("payee") or "",
            reference=expense.get("reference") or "",
        ) | {"source": expense.get("source_key") or "expense"}
        for expense in expenses
        if not expense.get("voided") and not expense.get("archived")
    ]
    expense_rows.extend(
        _financial_transaction(
            record, f"Vehicle {str(record.get('type') or 'expense').title()}",
            record.get("amount", 0),
            description=record.get("description") or "",
            supplier=record.get("payee") or "",
            reference=record.get("reference") or "",
        ) | {"source": "fleet"}
        for record in vehicle_records
        if record.get("status") in VEHICLE_COST_DONE and D(record.get("amount", 0)) > 0
    )
    diesel_by_vehicle = {}
    for row in expense_rows:
        source_record = row.get("source_record") or {}
        category = str(row.get("category") or "").strip().casefold()
        description = str(row.get("description") or "").strip().casefold()
        if category not in {"diesel", "fuel"} and not any(
            word in description for word in ("diesel", "fuel")
        ):
            continue
        vehicle_id = source_record.get("vehicle_id")
        vehicle_name = (
            source_record.get("vehicle_name")
            or (vehicles_by_id or {}).get(vehicle_id)
            or "Unassigned vehicle"
        )
        current = diesel_by_vehicle.setdefault(
            vehicle_id or vehicle_name,
            {"vehicle_id": vehicle_id, "vehicle": vehicle_name, "amount": Decimal("0"), "records": 0},
        )
        current["amount"] += D(row.get("amount", 0))
        current["records"] += 1
    diesel_usage = [
        {**row, "amount": r2(row["amount"])}
        for row in sorted(diesel_by_vehicle.values(), key=lambda item: item["vehicle"].casefold())
    ]
    buying_rows = [
        _financial_transaction(
            buying, f"Buying · {buying.get('item_type') or 'purchase'}",
            buying.get("amount", D(buying.get("quantity", 0)) * D(buying.get("unit_price", 0))),
            description=buying.get("product") or "",
            supplier=buying.get("source") or buying.get("supplier_name") or "",
            reference=buying.get("reference") or buying.get("purchase_order_reference") or "",
        ) | {"item_type": buying.get("item_type", ""),
             "quantity": buying.get("quantity"), "unit_price": buying.get("unit_price")}
        for buying in buyings
        if not buying.get("voided") and not buying.get("archived")
    ]
    grv_rows = []
    for grv in grvs:
        if grv.get("status") not in GRV_CONFIRMED_STATUSES:
            continue
        amount = grv_accepted_value(grv)
        grv_rows.append(_financial_transaction(
            grv, "GRV · Inventory received", amount,
            description=grv.get("grv_number") or "",
            supplier=grv.get("supplier_name") or "",
            reference=grv.get("delivery_note_number") or grv.get("purchase_order_reference") or "",
        ) | {"grv_number": grv.get("grv_number", ""),
             "status": grv.get("status"), "items": grv.get("items") or []})
    salary_rows = [
        {
            "id": row.get("employee_id"),
            "date": end.isoformat(),
            "category": "Salary",
            "description": row.get("name") or "",
            "supplier": row.get("department") or "",
            "amount": salary_amount_for_period(row, start, end),
            "reference": "",
            "status": "Calculated",
        }
        for row in salary_rows if salary_amount_for_period(row, start, end) > 0
    ]

    movements_by_invoice = {}
    for movement in invoice_movements:
        if movement.get("type") == "invoice" and movement.get("invoice_id"):
            movements_by_invoice.setdefault(movement["invoice_id"], []).append(movement)
    cogs_rows = []
    unavailable_rows = []
    cogs_values = []
    for invoice in sales_invoices:
        movements = movements_by_invoice.get(invoice.get("id"), [])
        if not movements:
            unavailable_rows.append({
                "id": invoice.get("id"), "number": invoice.get("number"),
                "customer_name": invoice.get("customer_name", ""),
                "status": "Historical Cost Unavailable",
                "reason": "No sale-to-stock-batch allocation is recorded for this invoice.",
            })
            continue
        invoice_cost = Decimal("0")
        invoice_batches = []
        complete_cost = True
        net_quantity_by_stock = {}
        net_allocations = {}
        allocated_quantity_by_stock = {}
        for movement in movements:
            allocations = movement.get("batch_allocations")
            moved_quantity = D(movement.get("quantity", 0))
            if not isinstance(allocations, list) or not allocations:
                complete_cost = False
                break
            stock_id = movement.get("stock_id") or ""
            movement_sign = -mov_sign(movement)
            net_quantity_by_stock[stock_id] = (
                D(net_quantity_by_stock.get(stock_id, 0)) + moved_quantity * movement_sign
            )
            allocated_quantity = Decimal("0")
            for allocation in allocations:
                quantity = D(allocation.get("quantity", 0))
                unit_cost = allocation.get("unit_cost")
                if quantity <= 0:
                    complete_cost = False
                    break
                allocated_quantity += quantity
                batch_id = allocation.get("batch_id") or f"unavailable:{stock_id}"
                allocation_key = (stock_id, batch_id)
                signed_quantity = quantity * movement_sign
                previous = net_allocations.get(allocation_key, {})
                net_allocations[allocation_key] = {
                    "quantity": D(previous.get("quantity", 0)) + signed_quantity,
                    "unit_cost": unit_cost,
                    "cost_status": allocation.get("cost_status", "unavailable"),
                    "source_type": allocation.get("source_type", ""),
                    "source_date": allocation.get("source_date"),
                }
            if not complete_cost or allocated_quantity != moved_quantity:
                complete_cost = False
                break
        if complete_cost:
            for key, allocation in net_allocations.items():
                quantity = allocation["quantity"]
                if quantity < 0:
                    complete_cost = False
                    break
                if quantity == 0:
                    continue
                stock_id = key[0]
                allocated_quantity_by_stock[stock_id] = (
                    D(allocated_quantity_by_stock.get(stock_id, 0)) + quantity
                )
                if allocation["unit_cost"] is None or allocation["cost_status"] == "unavailable":
                    complete_cost = False
                    break
                invoice_cost += quantity * D(allocation["unit_cost"])
                invoice_batches.append({
                    "batch_id": key[1],
                    "quantity": float(quantity),
                    "unit_cost": r2(allocation["unit_cost"]),
                    "source_type": allocation["source_type"],
                    "source_date": allocation["source_date"],
                })
        if complete_cost and any(
            quantity != D(allocated_quantity_by_stock.get(stock_id, 0))
            for stock_id, quantity in net_quantity_by_stock.items()
        ):
            complete_cost = False
        if complete_cost:
            cost = r2(invoice_cost)
            cogs_values.append(cost)
            cogs_rows.append({
                "id": invoice.get("id"), "number": invoice.get("number"),
                "customer_name": invoice.get("customer_name", ""),
                "date": invoice.get("date"), "amount": cost, "status": "Verified",
                "batches": invoice_batches,
            })
        else:
            unavailable_rows.append({
                "id": invoice.get("id"), "number": invoice.get("number"),
                "customer_name": invoice.get("customer_name", ""),
                "status": "Historical Cost Unavailable",
                "reason": "At least one sold quantity has no complete historical batch cost allocation.",
            })

    revenue = dsum(revenue_values)
    payment_total = dsum(row["amount"] for row in payment_rows)
    outstanding_invoices = unique_financial_records(
        all_outstanding_invoices if all_outstanding_invoices is not None else invoices
    )
    outstanding_invoice_ids = {
        invoice.get("id")
        for invoice in outstanding_invoices
        if invoice.get("id")
    }
    outstanding_payments_by_invoice = {}
    for payment in unique_financial_records(
        all_outstanding_payments if all_outstanding_payments is not None else linked_payments
    ):
        if payment.get("reversed") or payment.get("archived"):
            continue
        invoice_id = payment.get("invoice_id")
        if invoice_id in outstanding_invoice_ids:
            outstanding_payments_by_invoice[invoice_id] = (
                D(outstanding_payments_by_invoice.get(invoice_id, 0))
                + D(payment.get("amount", 0))
            )
    pending_values = []
    for invoice in outstanding_invoices:
        if (
            invoice.get("archived")
            or invoice.get("invoice_type") == "express"
            or invoice.get("status") in ("draft", "void")
            or not invoice.get("number")
        ):
            continue
        amount = r2(invoice.get("total", 0))
        paid = outstanding_payments_by_invoice.get(invoice.get("id"))
        if paid is None:
            paid = D(invoice.get("amount_paid", 0))
        outstanding = max(D(amount) - paid, Decimal("0"))
        if outstanding <= 0:
            continue
        pending_values.append(outstanding)
        pending_rows.append({
            "id": invoice.get("id"),
            "date": invoice.get("date") or "",
            "number": invoice.get("number"),
            "customer_name": invoice.get("customer_name", ""),
            "due_date": invoice.get("due_date"),
            "amount": r2(outstanding),
        })
    pending_total = dsum(pending_values)
    expense_total = dsum(row["amount"] for row in expense_rows)
    buying_total = dsum(row["amount"] for row in buying_rows)
    grv_total = dsum(row["amount"] for row in grv_rows)
    salary_total = dsum(row["amount"] for row in salary_rows)
    cogs_total = dsum(cogs_values)
    cash_result = r2(
        D(payment_total) - D(expense_total) - D(buying_total)
        - D(salary_total) - D(grv_total)
    )
    cogs_complete = not unavailable_rows
    gross_profit = r2(D(revenue) - D(cogs_total)) if cogs_complete else None
    final_profit = cash_result
    profit_status = "Payments received less recorded expenses, Buyings, calculated salaries, and accepted GRV costs."

    daily = {}
    for offset in range((end - start).days + 1):
        day = (start + timedelta(days=offset)).isoformat()
        daily[day] = {
            "date": day, "invoice_count": 0, "sales_revenue": 0,
            "payment_count": 0, "payments_received": 0,
            "expense_count": 0, "expenses": 0, "buyings": 0, "grv": 0,
        }
    def add_daily(rows, key, count_key=None, date_field="date", amount_field="amount"):
        for row in rows:
            day = financial_record_date(row, date_field)
            if day is None or day.isoformat() not in daily:
                continue
            bucket = daily[day.isoformat()]
            bucket[key] = r2(D(bucket[key]) + D(row.get(amount_field, 0)))
            if count_key:
                bucket[count_key] += 1
    add_daily(sales_invoices, "sales_revenue", "invoice_count", amount_field="total")
    add_daily(payment_rows, "payments_received", "payment_count")
    add_daily(expense_rows, "expenses", "expense_count")
    add_daily(buying_rows, "buyings")
    add_daily(grv_rows, "grv")
    for day in daily.values():
        known_cost = sum(
            D(row["amount"]) for row in cogs_rows
            if str(row.get("date", ""))[:10] == day["date"]
        )
        day["cogs"] = r2(known_cost) if cogs_complete or mode == "expenses_only" else None

    return {
        "start": start.isoformat(), "end": end.isoformat(), "mode": mode,
        "summary": {
            "invoice_count": len(invoice_rows), "total_invoices": revenue,
            "payment_count": len(payment_rows), "payments_received": payment_total,
            "pending_payments": pending_total,
            "sales_revenue": revenue,
            "cogs": cogs_total if mode == "full_production_cost" and cogs_complete else None,
            "known_cogs": cogs_total if mode == "full_production_cost" else None,
            "gross_profit": gross_profit if mode == "full_production_cost" else None,
            "buying_count": len(buying_rows), "buyings": buying_total,
            "expense_count": len(expense_rows), "expenses": expense_total,
            "grv_count": len(grv_rows), "grv": grv_total,
            "salary_count": len(salary_rows), "salaries": salary_total,
            "cash_result": cash_result,
            "final_profit": final_profit, "profit_status": profit_status,
            "historical_cost_unavailable_count": len(unavailable_rows),
        },
        "accounting_notes": [
            "Buyings and confirmed GRVs are deducted separately as stock purchases, not included in recorded operating expenses.",
            "This payments-based estimate does not also deduct COGS, so inventory purchases are not counted twice.",
            "Company profit is based on payments received minus recorded expenses, Buyings, calculated gross salaries, and accepted GRV costs.",
            "Only issued, non-void invoices count as sales; payments are reported by payment date and are not added to sales revenue.",
        ],
        "transactions": {
            "invoices": invoice_rows, "payments": payment_rows,
            "pending_payments": pending_rows, "cogs": cogs_rows,
            "historical_cost_unavailable": unavailable_rows,
            "expenses": expense_rows, "buyings": buying_rows, "grvs": grv_rows,
            "salaries": salary_rows,
        },
        "diesel_usage": diesel_usage,
        "daily": list(daily.values()),
    }

@api.get("/reports/financial")
async def get_financial_report(
    period: str = "weekly", value: str = "", mode: str = "expenses_only",
    company_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    if mode not in ("expenses_only", "full_production_cost"):
        raise HTTPException(422, "Mode must be expenses_only or full_production_cost")
    start, end = financial_period_range(period, value or today_str())
    report_company_id = financial_report_company(user, company_id)
    company_context = active_company_id.set(report_company_id)

    async def load_period(period_start, period_end, include_company_outstanding=False):
        invoices, payments, expenses, vehicle_records, buyings, grvs, salary_data = await asyncio.gather(
            financial_period_records("invoices", period_start, period_end, conditions={"archived": {"$ne": True}}),
            financial_period_records("payments", period_start, period_end, conditions={"archived": {"$ne": True}}),
            financial_period_records("expenses", period_start, period_end, conditions={"archived": {"$ne": True}}),
            financial_period_records("vehicle_records", period_start, period_end),
            financial_period_records("buyings", period_start, period_end, conditions={"archived": {"$ne": True}}),
            financial_period_records("grvs", period_start, period_end, date_field="received_date"),
            salary_report(period_start.isoformat(), period_end.isoformat()),
        )
        vehicle_ids = {
            record.get("vehicle_id")
            for record in [*expenses, *vehicle_records]
            if record.get("vehicle_id")
        }
        vehicle_rows = await db.vehicles.find(
            {"id": {"$in": list(vehicle_ids)}},
            {"_id": 0, "id": 1, "name": 1},
        ).to_list(len(vehicle_ids)) if vehicle_ids else []
        vehicles_by_id = {vehicle["id"]: vehicle.get("name") or "Unassigned vehicle" for vehicle in vehicle_rows}
        all_outstanding_invoices = None
        all_outstanding_payments = None
        if include_company_outstanding:
            all_outstanding_invoices = await db.invoices.find(
                {
                    "archived": {"$ne": True},
                    "invoice_type": {"$ne": "express"},
                    "status": {"$nin": ["draft", "void"]},
                    "number": {"$exists": True, "$nin": [None, ""]},
                },
                {"_id": 0},
            ).to_list(None)
            all_invoice_ids = [
                invoice["id"] for invoice in all_outstanding_invoices if invoice.get("id")
            ]
            all_outstanding_payments = await db.payments.find(
                {
                    "invoice_id": {"$in": all_invoice_ids},
                    "archived": {"$ne": True},
                },
                {"_id": 0},
            ).to_list(None) if all_invoice_ids else []
        invoice_ids = [invoice["id"] for invoice in invoices if invoice.get("id")]
        payment_invoice_ids = list({
            payment["invoice_id"]
            for payment in payments
            if payment.get("invoice_id")
        } - set(invoice_ids))
        payment_invoices = await db.invoices.find(
            {"id": {"$in": payment_invoice_ids}, "archived": {"$ne": True}},
            {"_id": 0},
        ).to_list(len(payment_invoice_ids)) if payment_invoice_ids else []
        linked_invoice_ids = list(set(invoice_ids) | set(payment_invoice_ids))
        linked_payments, invoice_movements = await asyncio.gather(
            db.payments.find({
                "invoice_id": {"$in": linked_invoice_ids}, "archived": {"$ne": True},
            }, {"_id": 0}).to_list(None) if linked_invoice_ids else asyncio.sleep(0, result=[]),
            db.stock_movements.find({
                "invoice_id": {"$in": invoice_ids}, "type": "invoice",
            }, {"_id": 0}).to_list(None) if invoice_ids else asyncio.sleep(0, result=[]),
        )
        return build_financial_report(
            period_start, period_end, mode,
            invoices=invoices, payments=payments, linked_payments=linked_payments,
            expenses=expenses, vehicle_records=vehicle_records, buyings=buyings,
            grvs=grvs, invoice_movements=invoice_movements,
            payment_invoices=payment_invoices,
            salary_rows=salary_data["employees"],
            vehicles_by_id=vehicles_by_id,
            all_outstanding_invoices=all_outstanding_invoices,
            all_outstanding_payments=all_outstanding_payments,
        )

    try:
        report = await load_period(start, end, include_company_outstanding=True)
        previous_start, previous_end = financial_previous_period_range(period, start, end)
        previous = await load_period(previous_start, previous_end)
    finally:
        active_company_id.reset(company_context)
    report["period"] = period
    report["value"] = value
    report["company_id"] = report_company_id
    profile = next(
        (item for item in COMPANY_PROFILES if item["id"] == report["company_id"]), None,
    )
    report["company_name"] = profile["name"] if profile else report["company_id"]
    report["generated_at"] = now_iso()
    report["previous_period"] = {
        "start": previous_start.isoformat(), "end": previous_end.isoformat(),
        "summary": previous["summary"],
    }
    return report

@api.post("/expenses")
async def add_expense(body: ExpenseIn, user=Depends(get_current_user)):
    _check_expense(body, user)
    authorization = await consume_expense_authorization(
        body.supervisor_authorization, None, "create", user,
    )
    d = body.model_dump()
    d.pop("edit_reason", None)
    d.pop("supervisor_authorization", None)
    destination_city = (d.pop("destination_city", "") or "").strip()
    if destination_city:
        d["destination_city"] = destination_city
    d["amount"] = r2(d["amount"])
    d["supervisor_approved_by"] = authorization["supervisor_id"]
    rec = await insert("expenses", d)
    await log_audit("expense", rec["id"], "created", user, after=rec,
                    reason=f"Supervisor approval by {authorization['supervisor_id']}")
    await emit_workflow_event("expense.recorded", rec)
    return rec

@api.put("/expenses/{eid}")
async def edit_expense(eid: str, body: ExpenseIn, user=Depends(get_current_user)):
    _check_expense(body, user)
    before = await db.expenses.find_one({"id": eid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Expense not found")
    if before.get("voided"):
        raise HTTPException(409, "A voided expense cannot be edited")
    if before.get("source_key"):
        raise HTTPException(400, "This expense is linked to a spare-part purchase. Edit it from Fleet > Spare Parts")
    reason = (body.edit_reason or "").strip()
    if not reason:
        raise HTTPException(400, "A reason is required to edit an expense")
    authorization = await consume_expense_authorization(
        body.supervisor_authorization, eid, "edit", user,
    )
    d = body.model_dump()
    d.pop("edit_reason", None)
    d.pop("supervisor_authorization", None)
    destination_city = (d.pop("destination_city", "") or "").strip()
    if destination_city:
        d["destination_city"] = destination_city
    d["amount"] = r2(d["amount"])
    d["supervisor_approved_by"] = authorization["supervisor_id"]
    rec = await update_doc("expenses", eid, d)
    await log_audit("expense", eid, "updated", user, before=before, after=rec, reason=reason)
    return rec

@api.post("/expenses/{eid}/void")
async def void_expense(eid: str, body: ReasonIn, user=Depends(get_current_user)):
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required")
    authorization = await consume_expense_authorization(
        body.supervisor_authorization, eid, "void", user,
    )
    rec = await db.expenses.find_one_and_update({"id": eid, "voided": {"$ne": True}},
                                                {"$set": {"voided": True, "void_reason": body.reason, "voided_at": now_iso(), "supervisor_approved_by": authorization["supervisor_id"]}},
                                                projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if not rec:
        raise HTTPException(400, "Expense not found or already voided")
    await log_audit("expense", eid, "voided", user, reason=body.reason)
    await emit_workflow_event("expense.voided", rec)
    return rec

@api.delete("/expenses/{eid}")
async def del_expense(eid: str, user=Depends(get_current_user)):
    raise HTTPException(400, "Expenses are kept for history. Use Void with a reason instead")

def period_starts():
    t = local_today()
    week = (t - timedelta(days=t.weekday())).isoformat()
    month = t.replace(day=1).isoformat()
    return week, month

def dashboard_period_ranges(period, start_date=None, end_date=None):
    end = local_today()
    if period == "today":
        start = end
    elif period == "week":
        start = end - timedelta(days=end.weekday())
    elif period == "month":
        start = end.replace(day=1)
    elif period == "year":
        start = end.replace(month=1, day=1)
    elif period == "custom":
        if (
            not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(start_date or ""))
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(end_date or ""))
        ):
            raise HTTPException(422, "Custom period requires valid start_date and end_date values")
        try:
            start = date.fromisoformat(start_date)
            end = date.fromisoformat(end_date)
        except ValueError:
            raise HTTPException(422, "Custom period dates must be valid YYYY-MM-DD dates")
        if start > end:
            raise HTTPException(422, "Custom period start_date cannot be after end_date")
    else:
        raise HTTPException(400, "Period must be today, week, month, year or custom")

    previous_end = start - timedelta(days=1)
    if period == "month":
        previous_start = previous_end.replace(day=1)
        selected_month_end = end.replace(
            day=calendar.monthrange(end.year, end.month)[1],
        )
        previous_end = previous_start.replace(
            day=calendar.monthrange(previous_start.year, previous_start.month)[1]
            if end == selected_month_end
            else min(end.day, calendar.monthrange(previous_start.year, previous_start.month)[1]),
        )
    elif period == "year":
        previous_start = previous_end.replace(month=1, day=1)
        previous_end = previous_end.replace(
            year=previous_end.year,
            month=end.month,
            day=min(end.day, calendar.monthrange(previous_end.year, end.month)[1]),
        )
    elif period == "week":
        previous_start = start - timedelta(days=7)
        previous_end = previous_start + (end - start)
    else:
        previous_start = previous_end - (end - start)
    return (start.isoformat(), end.isoformat()), (previous_start.isoformat(), previous_end.isoformat())

VEHICLE_COST_DONE = ("Done", "done")

async def cost_ledger(since=None, until=None):
    expenses, vehicles, vehicle_records = await asyncio.gather(
        listall("expenses", {"voided": {"$ne": True}, "archived": {"$ne": True}}),
        listall("vehicles"),
        listall("vehicle_records"),
    )
    return cost_ledger_from_records(expenses, vehicles, vehicle_records, since, until)

def cost_ledger_from_records(expenses, vehicles, vehicle_records, since=None, until=None):
    rows = []
    for x in expenses:
        source_key = x.get("source_key", "")
        source = (
            "spare_part" if source_key.startswith("sparepart:")
            else "monthly_purchase" if source_key.startswith("monthly_business_purchase:")
            else "expense"
        )
        rows.append({"id": x["id"], "date": x.get("date"), "description": x.get("description"), "category": x.get("category", "General"),
                     "amount": x.get("amount", 0), "vehicle_id": x.get("vehicle_id", ""), "source": source})
    vnames = {v["id"]: v["name"] for v in vehicles}
    for x in vehicle_records:
        if x.get("status") in VEHICLE_COST_DONE and (x.get("amount") or 0) > 0:
            rows.append({"id": x["id"], "date": x.get("date"), "description": f"{vnames.get(x.get('vehicle_id'), '')}: {x.get('description', '')}",
                         "category": f"Vehicle {x.get('type', 'expense').title()}", "amount": x.get("amount", 0),
                         "vehicle_id": x.get("vehicle_id"), "source": "fleet"})
    for r in rows:
        r["vehicle_name"] = vnames.get(r.get("vehicle_id"), "")
    return [r for r in rows if (not since or (r["date"] or "") >= since) and (not until or (r["date"] or "") <= until)]

def unique_financial_records(records):
    seen = set()
    result = []
    for record in records:
        record_id = record.get("id")
        if record_id and record_id in seen:
            continue
        if record_id:
            seen.add(record_id)
        result.append(record)
    return result

def dashboard_financial_totals(start, end, *, invoices, payments, expenses, vehicle_records, buyings, grvs=(), salaries=0):
    start_date = date.fromisoformat(str(start)[:10])
    end_date = date.fromisoformat(str(end)[:10])
    valid_invoices = unique_financial_records(invoices)
    issued_total = dsum(
        invoice.get("total", 0)
        for invoice in valid_invoices
        if not invoice.get("archived")
        and invoice.get("invoice_type") != "express"
        and invoice.get("status") not in ("draft", "void")
        and invoice.get("number")
        and not invoice.get("opening_balance")
        and (invoice_date := financial_record_date(invoice)) is not None
        and start_date <= invoice_date <= end_date
    )
    totals = profit_from_records(
        start,
        end,
        payments=payments,
        expenses=expenses,
        vehicle_records=vehicle_records,
        buyings=buyings,
        grvs=grvs,
        salaries=salaries,
    )
    return {"total_invoiced": issued_total, **totals}

def invoice_outstanding_amount(invoice, paid):
    if (
        invoice.get("archived")
        or invoice.get("status") in ("draft", "void")
        or not invoice.get("number")
    ):
        return 0
    return r2(max(D(invoice.get("total", 0)) - D(paid), Decimal("0")))

def profit_from_records(since, until=None, *, payments, expenses, vehicle_records, buyings, grvs=(), salaries=0):
    start_date = date.fromisoformat(str(since)[:10])
    end_date = date.fromisoformat(str(until)[:10]) if until else None

    def in_period(item):
        record_date = financial_record_date(item)
        return (
            record_date is not None
            and record_date >= start_date
            and (end_date is None or record_date <= end_date)
        )

    revenue = dsum(
        payment.get("amount", 0)
        for payment in unique_financial_records(payments)
        if not payment.get("reversed") and not payment.get("archived") and in_period(payment)
    )
    expense_total = dsum([
        *(
            expense.get("amount", 0)
            for expense in unique_financial_records(expenses)
            if not expense.get("voided") and not expense.get("archived") and in_period(expense)
        ),
        *(
            record.get("amount", 0)
            for record in unique_financial_records(vehicle_records)
            if record.get("status") in VEHICLE_COST_DONE
            and (record.get("amount") or 0) > 0
            and in_period(record)
        ),
    ])
    buying_total = dsum(
        buying.get("amount", D(buying.get("quantity", 0)) * D(buying.get("unit_price", 0)))
        for buying in unique_financial_records(buyings)
        if not buying.get("voided") and not buying.get("archived") and in_period(buying)
    )
    grv_total = dsum(
        grv_accepted_value(grv)
        for grv in unique_financial_records(grvs)
        if grv.get("status") in GRV_CONFIRMED_STATUSES
        and in_period({**grv, "date": grv.get("received_date") or grv.get("date")})
    )
    return {
        "revenue": revenue,
        "expenses": expense_total,
        "buyings": buying_total,
        "grv_expenses": grv_total,
        "salaries": r2(salaries),
        "profit": r2(D(revenue) - D(expense_total) - D(buying_total) - D(grv_total) - D(salaries)),
        "label": "Estimated result — payments received minus recorded expenses, buyings, salaries and GRV costs",
        "basis": "payment dates, expense dates, buying dates, salary period & GRV receipt dates",
    }

async def dashboard_vehicle_licence_alerts(today):
    rows = await db.vehicle_licence_discs.aggregate([
        {"$sort": {"created_at": -1}},
        {"$group": {"_id": "$vehicle_id", "disc": {"$first": "$$ROOT"}}},
    ]).to_list(None)
    vehicle_ids = [row["_id"] for row in rows if row.get("_id")]
    vehicles = await db.vehicles.find(
        {"id": {"$in": vehicle_ids}, "archived": {"$ne": True}},
        {"_id": 0, "id": 1, "name": 1, "registration": 1},
    ).to_list(None)
    vehicle_by_id = {vehicle["id"]: vehicle for vehicle in vehicles}
    alerts = []
    for row in rows:
        vehicle = vehicle_by_id.get(row.get("_id"))
        disc = row.get("disc") or {}
        if not vehicle:
            continue
        status = vehicle_licence_disc_status(disc.get("expiry_date"), date.fromisoformat(today))
        if status["status"] == "VALID":
            continue
        alerts.append({
            "vehicle_id": vehicle["id"],
            "vehicle_name": vehicle.get("name", ""),
            "registration": vehicle.get("registration", ""),
            "expiry_date": disc.get("expiry_date"),
            **status,
        })
    alerts.sort(key=lambda item: item["days_remaining"] if item["days_remaining"] is not None else -1)
    return {
        "expiring_soon": sum(item["status"] == "EXPIRING SOON" for item in alerts),
        "expired": sum(item["status"] == "EXPIRED" for item in alerts),
        "items": alerts[:10],
    }

async def dashboard_stock_movement_totals(stock_ids):
    if not stock_ids:
        return {}
    rows = await db.stock_movements.aggregate([
        {"$match": {"stock_id": {"$in": stock_ids}}},
        {"$project": {
            "stock_id": 1,
            "signed_quantity": {
                "$multiply": [
                    "$quantity",
                    {"$cond": [
                        {"$in": ["$direction", [1, -1]]},
                        "$direction",
                        {"$cond": [{"$in": ["$type", list(INC_TYPES)]}, 1, -1]},
                    ]},
                ],
            },
        }},
        {"$group": {"_id": "$stock_id", "quantity": {"$sum": "$signed_quantity"}}},
    ]).to_list(None)
    return {row["_id"]: row["quantity"] for row in rows}

async def dashboard_all_time_payment_total():
    rows = await db.payments.aggregate([
        {"$match": {"reversed": {"$ne": True}, "archived": {"$ne": True}}},
        {"$group": {
            "_id": {"$ifNull": ["$id", "$_id"]},
            "amount": {"$first": "$amount"},
        }},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    return r2(rows[0]["total"]) if rows else 0

async def dashboard_all_time_invoice_totals(today):
    company_id = active_company_id.get()
    payment_scope = {"company_id": company_id} if company_id else {}
    rows = await db.invoices.aggregate([
        {"$match": {
            "archived": {"$ne": True},
            "status": {"$nin": ["draft", "void"]},
            "number": {"$exists": True, "$nin": [None, ""]},
        }},
        {"$lookup": {
            "from": "payments",
            "let": {"invoice_id": "$id"},
            "pipeline": [
                {"$match": {
                    "$expr": {"$eq": ["$invoice_id", "$$invoice_id"]},
                    "reversed": {"$ne": True},
                    "archived": {"$ne": True},
                    **payment_scope,
                }},
                {"$group": {
                    "_id": {"$ifNull": ["$id", "$_id"]},
                    "invoice_id": {"$first": "$invoice_id"},
                    "amount": {"$first": "$amount"},
                }},
                {"$group": {"_id": None, "paid": {"$sum": "$amount"}}},
            ],
            "as": "payment_totals",
        }},
        {"$project": {
            "total": {"$ifNull": ["$total", 0]},
            "opening_balance": {"$eq": ["$opening_balance", True]},
            "due_date": 1,
            "outstanding": {
                "$cond": [
                    {"$gt": [
                        {"$subtract": [
                            {"$ifNull": ["$total", 0]},
                            {"$ifNull": [{"$arrayElemAt": ["$payment_totals.paid", 0]}, 0]},
                        ]},
                        0,
                    ]},
                    {"$subtract": [
                        {"$ifNull": ["$total", 0]},
                        {"$ifNull": [{"$arrayElemAt": ["$payment_totals.paid", 0]}, 0]},
                    ]},
                    0,
                ],
            },
        }},
        {"$group": {
            "_id": None,
            "total_invoiced": {
                "$sum": {"$cond": [
                    {"$and": [
                        {"$eq": ["$opening_balance", False]},
                        {"$ne": [{"$ifNull": ["$invoice_type", "standard"]}, "express"]},
                    ]},
                    "$total",
                    0,
                ]},
            },
            "outstanding": {"$sum": "$outstanding"},
            "overdue": {"$sum": {
                "$cond": [
                    {"$and": [
                        {"$lt": [{"$ifNull": ["$due_date", "9999-12-31"]}, today]},
                        {"$gt": ["$outstanding", 0]},
                    ]},
                    "$outstanding",
                    0,
                ],
            }},
        }},
    ]).to_list(1)
    balance_rows = await db.customers.aggregate([
        {"$group": {
            "_id": None,
            "total": {"$sum": {"$ifNull": ["$other_balance", 0]}},
        }},
    ]).to_list(1)
    invoice_totals = rows[0] if rows else {}
    other_balance = balance_rows[0].get("total", 0) if balance_rows else 0
    return {
        "total_invoiced": r2(invoice_totals.get("total_invoiced", 0)),
        "outstanding": r2(D(invoice_totals.get("outstanding", 0)) + D(other_balance)),
        "overdue": r2(invoice_totals.get("overdue", 0)),
    }

async def dashboard_payment_totals_by_invoice(invoice_ids):
    if not invoice_ids:
        return {}
    rows = await db.payments.aggregate([
        {"$match": {
            "invoice_id": {"$in": invoice_ids},
            "reversed": {"$ne": True},
            "archived": {"$ne": True},
        }},
        {"$group": {
            "_id": {
                "payment_id": {"$ifNull": ["$id", "$_id"]},
                "invoice_id": "$invoice_id",
            },
            "amount": {"$first": "$amount"},
        }},
        {"$group": {"_id": "$_id.invoice_id", "paid": {"$sum": "$amount"}}},
    ]).to_list(None)
    return {row["_id"]: row["paid"] for row in rows}

async def dashboard_invoice_outstanding_by_id(invoices):
    valid_invoices = [
        invoice for invoice in invoices
        if not invoice.get("archived")
        and invoice.get("status") not in ("draft", "void")
        and invoice.get("number")
    ]
    payments = await dashboard_payment_totals_by_invoice([
        invoice["id"] for invoice in valid_invoices if invoice.get("id")
    ])
    balances = {}
    for invoice in invoices:
        invoice_id = invoice.get("id")
        if not invoice_id:
            continue
        balances[invoice_id] = invoice_outstanding_amount(
            invoice, payments.get(invoice_id, 0),
        )
    return balances

async def dashboard_financial_periods(periods):
    unique_periods = sorted({tuple(period) for period in periods})
    starts = [date.fromisoformat(bounds[0]) for bounds in unique_periods]
    ends = [date.fromisoformat(bounds[1]) for bounds in unique_periods]
    start, end = min(starts), max(ends)
    bounds = (start, end)
    invoices, payments, expenses, vehicle_records, buyings, grvs = await asyncio.gather(
        financial_period_records(
            "invoices", *bounds,
            conditions={
                "archived": {"$ne": True},
                "invoice_type": {"$ne": "express"},
                "status": {"$nin": ["draft", "void"]},
                "number": {"$exists": True, "$nin": [None, ""]},
            },
        ),
        financial_period_records(
            "payments", *bounds,
            conditions={"reversed": {"$ne": True}, "archived": {"$ne": True}},
        ),
        financial_period_records(
            "expenses", *bounds,
            conditions={"voided": {"$ne": True}, "archived": {"$ne": True}},
        ),
        financial_period_records(
            "vehicle_records", *bounds,
            conditions={"status": {"$in": list(VEHICLE_COST_DONE)}, "amount": {"$gt": 0}},
        ),
        financial_period_records(
            "buyings", *bounds,
            conditions={"voided": {"$ne": True}, "archived": {"$ne": True}},
        ),
        financial_period_records(
            "grvs", *bounds, date_field="received_date",
            conditions={"status": {"$in": list(GRV_CONFIRMED_STATUSES)}},
        ),
    )
    salary_costs = await asyncio.gather(*(
        salary_cost_for_period(period[0], period[1])
        for period in unique_periods
    ))
    salaries_by_period = dict(zip(unique_periods, salary_costs))
    records_by_type = {
        "invoices": invoices,
        "payments": payments,
        "expenses": expenses,
        "vehicle_records": vehicle_records,
        "buyings": buyings,
        "grvs": grvs,
    }
    return {
        period: dashboard_financial_totals(
            period[0],
            period[1],
            **records_by_type,
            salaries=salaries_by_period[period],
        )
        for period in unique_periods
    }

async def dashboard_completed_orders_in_period(start, end):
    records = await financial_period_records(
        "orders", date.fromisoformat(start), date.fromisoformat(end),
        date_field="completed_at",
        conditions={"status": "Delivered", "archived": {"$ne": True}},
    )
    return len({record["id"] for record in records if record.get("id")})

async def dashboard_financial_period(start, end):
    bounds = date.fromisoformat(str(start)[:10]), date.fromisoformat(str(end)[:10])
    invoices, payments, expenses, vehicle_records, buyings, grvs, salaries = await asyncio.gather(
        financial_period_records(
            "invoices", *bounds,
            conditions={
                "archived": {"$ne": True},
                "invoice_type": {"$ne": "express"},
                "status": {"$nin": ["draft", "void"]},
                "number": {"$exists": True, "$nin": [None, ""]},
            },
        ),
        financial_period_records(
            "payments", *bounds,
            conditions={"reversed": {"$ne": True}, "archived": {"$ne": True}},
        ),
        financial_period_records(
            "expenses", *bounds,
            conditions={"voided": {"$ne": True}, "archived": {"$ne": True}},
        ),
        financial_period_records(
            "vehicle_records", *bounds,
            conditions={"status": {"$in": list(VEHICLE_COST_DONE)}, "amount": {"$gt": 0}},
        ),
        financial_period_records(
            "buyings", *bounds,
            conditions={"voided": {"$ne": True}, "archived": {"$ne": True}},
        ),
        financial_period_records(
            "grvs", *bounds, date_field="received_date",
            conditions={"status": {"$in": list(GRV_CONFIRMED_STATUSES)}},
        ),
        salary_cost_for_period(start, end),
    )
    return dashboard_financial_totals(
        start,
        end,
        invoices=invoices,
        payments=payments,
        expenses=expenses,
        vehicle_records=vehicle_records,
        buyings=buyings,
        grvs=grvs,
        salaries=salaries,
    )

async def load_profit_records():
    return await asyncio.gather(
        listall("payments", {"archived": {"$ne": True}}),
        listall("expenses", {"voided": {"$ne": True}, "archived": {"$ne": True}}),
        listall("vehicle_records"),
        listall("buyings", {"voided": {"$ne": True}, "archived": {"$ne": True}}),
        listall("grvs", {"status": {"$in": list(GRV_CONFIRMED_STATUSES)}}),
    )

async def profit_for(since, until=None):
    payments, expenses, vehicle_records, buyings, grvs = await load_profit_records()
    salaries = await salary_cost_for_period(since, until or today_str())
    return profit_from_records(
        since,
        until,
        payments=payments,
        expenses=expenses,
        vehicle_records=vehicle_records,
        buyings=buyings,
        grvs=grvs,
        salaries=salaries,
    )

@api.get("/dashboard/compare")
async def compare_dashboard_periods(kind: str, first: str, second: str, user=Depends(get_current_user)):
    if kind == "month":
        values = []
        for value in (first, second):
            if not re.fullmatch(r"\d{4}-\d{2}", value):
                raise HTTPException(400, "Months must use YYYY-MM format")
            try:
                month_start = date.fromisoformat(f"{value}-01")
            except ValueError:
                raise HTTPException(400, f"Invalid month: {value}")
            next_month = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
            values.append((month_start.isoformat(), (next_month - timedelta(days=1)).isoformat()))
    elif kind == "year":
        values = []
        for value in (first, second):
            if not re.fullmatch(r"\d{4}", value):
                raise HTTPException(400, "Years must use YYYY format")
            year = int(value)
            try:
                values.append((date(year, 1, 1).isoformat(), date(year, 12, 31).isoformat()))
            except ValueError:
                raise HTTPException(400, f"Invalid year: {value}")
    else:
        raise HTTPException(400, "Comparison kind must be month or year")
    first_totals, second_totals = await asyncio.gather(
        dashboard_financial_period(*values[0]),
        dashboard_financial_period(*values[1]),
    )
    return {
        "kind": kind,
        "first": {
            "value": first, "start": values[0][0], "end": values[0][1],
            **first_totals,
        },
        "second": {
            "value": second, "start": values[1][0], "end": values[1][1],
            **second_totals,
        },
    }

@api.get("/reports/profit")
async def profit_report(user=Depends(get_current_user)):
    week, month = period_starts()
    t = today_str()
    (payments, expenses, vehicle_records, buyings, grvs), vehicles, salary_costs = await asyncio.gather(
        load_profit_records(),
        listall("vehicles"),
        asyncio.gather(
            salary_cost_for_period(t, t),
            salary_cost_for_period(week, t),
            salary_cost_for_period(month, t),
        ),
    )
    today_salaries, week_salaries, month_salaries = salary_costs
    return {
        "today": profit_from_records(
            t, t, payments=payments, expenses=expenses,
            vehicle_records=vehicle_records, buyings=buyings, grvs=grvs,
            salaries=today_salaries,
        ),
        "week": profit_from_records(
            week, payments=payments, expenses=expenses,
            vehicle_records=vehicle_records, buyings=buyings, grvs=grvs,
            salaries=week_salaries,
        ),
        "month": profit_from_records(
            month, payments=payments, expenses=expenses,
            vehicle_records=vehicle_records, buyings=buyings, grvs=grvs,
            salaries=month_salaries,
        ),
        "total_expenses": dsum(
            row["amount"] for row in cost_ledger_from_records(expenses, vehicles, vehicle_records)
        ),
        "week_start": week, "month_start": month, "timezone": "Africa/Johannesburg",
    }

@api.get("/reports/costs")
async def cost_report(since: Optional[str] = None, until: Optional[str] = None, user=Depends(get_current_user)):
    rows = sorted(await cost_ledger(since, until), key=lambda r: r["date"] or "", reverse=True)
    by_cat, by_veh = {}, {}
    for r in rows:
        by_cat[r["category"]] = r2(D(by_cat.get(r["category"], 0)) + D(r["amount"]))
        if r.get("vehicle_name"):
            by_veh[r["vehicle_name"]] = r2(D(by_veh.get(r["vehicle_name"], 0)) + D(r["amount"]))
    return {"rows": rows, "total": dsum(r["amount"] for r in rows), "by_category": by_cat, "by_vehicle": by_veh}

# ---------------- Vehicle records (expenses/repairs/maintenance) ----------------
VREC_STATUSES = ("Needed", "Scheduled", "In Progress", "Done", "Cancelled")

class VehicleRecordIn(BaseModel):
    type: str = "expense"  # expense, repair, maintenance
    description: str = ""
    amount: float = 0
    date: str = Field(default_factory=today_str)
    status: str = "Done"
    notes: Optional[str] = ""
    edit_reason: Optional[str] = ""
    supervisor_authorization: Optional[str] = None

class VehicleRecordCancelIn(BaseModel):
    reason: str
    supervisor_authorization: Optional[str] = None

@api.get("/vehicles/records/all")
async def all_vehicle_records(user=Depends(get_current_user)):
    return await listall("vehicle_records", sort=("date", -1))

@api.get("/vehicles/{vid}/records")
async def get_vehicle_records(vid: str, user=Depends(get_current_user)):
    return await listall("vehicle_records", {"vehicle_id": vid}, ("date", -1))

def _check_vrec(d):
    d["status"] = {"done": "Done", "needed": "Needed"}.get(d["status"], d["status"])
    if d["status"] not in VREC_STATUSES:
        raise HTTPException(400, f"Status must be one of {', '.join(VREC_STATUSES)}")
    if d["type"] not in ("expense", "repair", "maintenance"):
        raise HTTPException(400, "Type must be expense, repair or maintenance")
    if not d["description"].strip():
        raise HTTPException(400, "Description is required")
    if d["amount"] < 0:
        raise HTTPException(400, "Amount cannot be negative")
    d["amount"] = r2(d["amount"])
    return d

@api.post("/vehicles/{vid}/records")
async def add_vehicle_record(vid: str, body: VehicleRecordIn, user=Depends(get_current_user)):
    v = await db.vehicles.find_one({"id": vid})
    if not v:
        raise HTTPException(404, "Vehicle not found")
    d = _check_vrec(body.model_dump())
    d.pop("edit_reason", None)
    d.pop("supervisor_authorization", None)
    if is_billable_vehicle_record(d):
        authorization = await consume_fleet_expense_authorization(
            body.supervisor_authorization, "vehicle_record", "create", user, target_id=vid,
        )
        d["supervisor_approved_by"] = authorization["supervisor_id"]
    d["vehicle_id"] = vid
    d["vehicle_name"] = v["name"]
    rec = await insert("vehicle_records", d)
    await log_audit("vehicle_record", rec["id"], "created", user, after=rec)
    await emit_workflow_event("vehicle_record.created", rec)
    return rec

@api.put("/vehicles/records/{rid}")
async def edit_vehicle_record(rid: str, body: VehicleRecordIn, user=Depends(get_current_user)):
    before = await db.vehicle_records.find_one({"id": rid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Record not found")
    data = _check_vrec(body.model_dump())
    data.pop("edit_reason", None)
    data.pop("supervisor_authorization", None)
    if is_billable_vehicle_record(before) or is_billable_vehicle_record(data):
        authorization = await consume_fleet_expense_authorization(
            body.supervisor_authorization, "vehicle_record", "edit", user, resource_id=rid,
        )
        data["supervisor_approved_by"] = authorization["supervisor_id"]
    rec = await update_doc("vehicle_records", rid, data)
    await log_audit("vehicle_record", rid, "updated", user, before=before, after=rec)
    await emit_workflow_event("vehicle_record.updated", rec)
    return rec

async def _cancel_vehicle_record(rid, supervisor_authorization, user):
    before = await db.vehicle_records.find_one({"id": rid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Record not found")
    updates = {"status": "Cancelled"}
    if is_billable_vehicle_record(before):
        authorization = await consume_fleet_expense_authorization(
            supervisor_authorization, "vehicle_record", "cancel", user, resource_id=rid,
        )
        updates["supervisor_approved_by"] = authorization["supervisor_id"]
    rec = await update_doc("vehicle_records", rid, updates)
    await log_audit("vehicle_record", rid, "cancelled", user, before=before, after=rec)
    await emit_workflow_event("vehicle_record.cancelled", rec)
    return {"ok": True, "cancelled": True}

@api.delete("/vehicles/records/{rid}")
async def del_vehicle_record(rid: str, user=Depends(get_current_user)):
    return await _cancel_vehicle_record(rid, None, user)

@api.post("/vehicles/records/{rid}/cancel")
async def cancel_vehicle_record(rid: str, body: VehicleRecordCancelIn, user=Depends(get_current_user)):
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required to cancel a vehicle cost")
    return await _cancel_vehicle_record(rid, body.supervisor_authorization, user)

# ---------------- Spare parts ----------------
PART_FLOW = {"to_buy": 0, "bought": 1, "installed": 2}

class SparePartIn(BaseModel):
    name: str
    quantity: float = Field(default=1, ge=0)
    expected_price: float = Field(default=0, ge=0)
    actual_cost: Optional[float] = Field(default=None, ge=0)
    vehicle_id: Optional[str] = ""
    status: str = "to_buy"  # to_buy, bought, installed
    notes: Optional[str] = ""
    edit_reason: Optional[str] = ""
    supervisor_authorization: Optional[str] = None

    @field_validator("name")
    @classmethod
    def name_required(cls, value):
        value = (value or "").strip()
        if not value:
            raise ValueError("Part name is required")
        return value

    @field_validator("status")
    @classmethod
    def valid_part_status(cls, value):
        if value not in ("to_buy", "bought", "installed"):
            raise ValueError("Status must be to_buy, bought or installed")
        return value

class FleetExpenseAuthorizationIn(BaseModel):
    password: str
    resource_type: str
    action: str
    resource_id: Optional[str] = None
    target_id: Optional[str] = None

def is_billable_vehicle_record(record):
    return record.get("status") in ("Done", "done") and D(record.get("amount", 0)) > 0

async def create_fleet_expense_authorization(body, user):
    allowed = {
        "vehicle_record": {"create", "edit", "cancel"},
        "spare_part": {"create", "edit"},
    }
    if body.resource_type not in allowed or body.action not in allowed[body.resource_type]:
        raise HTTPException(400, "Unsupported Fleet expense action")
    if body.resource_type == "vehicle_record":
        if body.action == "create":
            if not body.target_id or not await db.vehicles.find_one({"id": body.target_id}, {"_id": 0, "id": 1}):
                raise HTTPException(404, "Vehicle not found")
        elif not body.resource_id or not await db.vehicle_records.find_one({"id": body.resource_id}, {"_id": 0, "id": 1}):
            raise HTTPException(404, "Vehicle record not found")
    elif body.action == "edit":
        if not body.resource_id or not await db.spareparts.find_one({"id": body.resource_id}, {"_id": 0, "id": 1}):
            raise HTTPException(404, "Spare part not found")

    supervisor_id, supervisor_name = await authenticate_supervisor(body.password, user)
    await db.fleet_expense_authorizations.delete_many({
        "user_id": user["id"],
        "expires_at": {"$lte": datetime.now(timezone.utc)},
    })
    authorization_id = new_id()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    authorization = {
        "id": authorization_id,
        "resource_type": body.resource_type,
        "action": body.action,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "supervisor_id": supervisor_id,
        "expires_at": expires_at,
    }
    for key in ("resource_id", "target_id"):
        value = getattr(body, key)
        if value:
            authorization[key] = value
    await db.fleet_expense_authorizations.insert_one(authorization)
    if body.resource_id:
        await log_audit(body.resource_type, body.resource_id, f"{body.action}_authorized", user,
                        reason=f"Supervisor approval by {supervisor_name}")
    return {"authorization_id": authorization_id, "expires_at": expires_at.isoformat()}

async def consume_fleet_expense_authorization(authorization_id, resource_type, action, user, resource_id=None, target_id=None):
    if can_skip_supervisor_approval(user):
        return {
            "id": authorization_id,
            "resource_type": resource_type,
            "action": action,
            "user_id": user["id"],
            "company_id": user["_active_company_id"],
            "supervisor_id": user["id"],
            "resource_id": resource_id,
            "target_id": target_id,
            "supervisor_exempt": True,
        }
    query = {
        "id": authorization_id,
        "resource_type": resource_type,
        "action": action,
        "user_id": user["id"],
        "company_id": user["_active_company_id"],
        "expires_at": {"$gt": datetime.now(timezone.utc)},
        "resource_id": resource_id if resource_id else {"$exists": False},
        "target_id": target_id if target_id else {"$exists": False},
    }
    authorization = await db.fleet_expense_authorizations.find_one_and_delete(query, projection={"_id": 0})
    if not authorization:
        raise HTTPException(403, "Supervisor approval is required for this Fleet cost action")
    return authorization

@api.post("/fleet-expense-authorizations")
async def authorize_fleet_expense_action(body: FleetExpenseAuthorizationIn, user=Depends(get_current_user)):
    return await create_fleet_expense_authorization(body, user)

async def sync_part_expense(part, user, supervisor_id=None):
    key = f"sparepart:{part['id']}"
    if PART_FLOW.get(part["status"], 0) < 1:
        return
    cost = part.get("actual_cost")
    if cost is None or cost <= 0:
        raise HTTPException(400, "Enter the actual purchase cost (total) when marking a part as bought")
    existing = await db.expenses.find_one({"source_key": key})
    data = {"description": f"Spare part: {part['name']} x{part.get('quantity', 1):g}", "amount": r2(cost),
            "category": "Vehicle", "vehicle_id": part.get("vehicle_id", ""), "source_key": key,
            "date": part.get("bought_date") or today_str(), "payment_method": "", "reference": "", "notes": ""}
    if supervisor_id:
        data["supervisor_approved_by"] = supervisor_id
    if existing:
        if r2(existing.get("amount")) != r2(cost):
            await db.expenses.update_one({"source_key": key}, {"$set": {
                "amount": r2(cost), "updated_at": now_iso(), "supervisor_approved_by": supervisor_id,
            }})
    else:
        try:
            await insert("expenses", data)
        except DuplicateKeyError:
            pass

@api.get("/spareparts")
async def get_spareparts(user=Depends(get_current_user)):
    parts = await listall("spareparts", sort=("created_at", -1))
    vehicles = {v["id"]: v["name"] for v in await listall("vehicles")}
    for p in parts:
        p["vehicle_name"] = vehicles.get(p.get("vehicle_id"), "")
    return parts

@api.post("/spareparts")
async def add_sparepart(body: SparePartIn, user=Depends(get_current_user)):
    d = body.model_dump()
    if d["status"] not in PART_FLOW:
        raise HTTPException(400, "Invalid status")
    d.pop("edit_reason", None)
    d.pop("supervisor_authorization", None)
    supervisor_id = None
    if d["status"] != "to_buy":
        authorization = await consume_fleet_expense_authorization(
            body.supervisor_authorization, "spare_part", "create", user,
        )
        supervisor_id = authorization["supervisor_id"]
        d["supervisor_approved_by"] = supervisor_id
    if d["status"] != "to_buy":
        d["bought_date"] = today_str()
    d["id"] = new_id()
    await sync_part_expense(d, user, supervisor_id)
    rec = await insert("spareparts", d)
    await log_audit("spare_part", rec["id"], "created", user, after=rec)
    await emit_workflow_event("spare_part.created", rec)
    return rec

@api.put("/spareparts/{pid}")
async def edit_sparepart(pid: str, body: SparePartIn, user=Depends(get_current_user)):
    before = await db.spareparts.find_one({"id": pid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Part not found")
    d = body.model_dump()
    if d["status"] not in PART_FLOW:
        raise HTTPException(400, "Invalid status")
    if PART_FLOW[d["status"]] < PART_FLOW.get(before.get("status"), 0):
        raise HTTPException(400, "A part cannot move back to an earlier status")
    d.pop("edit_reason", None)
    d.pop("supervisor_authorization", None)
    supervisor_id = None
    if d["status"] != "to_buy" or before.get("status") != "to_buy":
        authorization = await consume_fleet_expense_authorization(
            body.supervisor_authorization, "spare_part", "edit", user, resource_id=pid,
        )
        supervisor_id = authorization["supervisor_id"]
        d["supervisor_approved_by"] = supervisor_id
    d["bought_date"] = before.get("bought_date") or (today_str() if d["status"] != "to_buy" else None)
    d["id"] = pid
    await sync_part_expense(d, user, supervisor_id)
    rec = await update_doc("spareparts", pid, d)
    await log_audit("spare_part", pid, "updated", user, before=before, after=rec)
    await emit_workflow_event("spare_part.updated", rec)
    return rec

@api.delete("/spareparts/{pid}")
async def del_sparepart(pid: str, user=Depends(get_current_user)):
    p = await db.spareparts.find_one({"id": pid}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Part not found")
    if p.get("status") != "to_buy":
        raise HTTPException(400, "Bought or installed parts are kept for history and cannot be deleted")
    updated = await update_doc("spareparts", pid, {
        "archived": True, "archived_at": now_iso(), "archived_by": user.get("id"),
    })
    await log_audit("spare_part", pid, "archived", user, before=p, after=updated)
    await emit_workflow_event("spare_part.archived", updated)
    return {"ok": True, "archived": True}

@api.post("/spareparts/{pid}/restore")
async def restore_sparepart(pid: str, user=Depends(get_current_user)):
    before = await db.spareparts.find_one({"id": pid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Part not found")
    updated = await update_doc("spareparts", pid, {
        "archived": False, "archived_at": None, "archived_by": None,
    })
    await log_audit("spare_part", pid, "restored", user, before=before, after=updated)
    await emit_workflow_event("spare_part.restored", updated)
    return {"ok": True}

# ---------------- Customer import with opening balances ----------------
class ImportRow(BaseModel):
    name: str
    balance: float = 0

class ImportIn(BaseModel):
    rows: List[ImportRow]

@api.post("/customers/import")
async def import_customers(body: ImportIn, user=Depends(get_current_user)):
    seen, created, reused, ob_created, ob_skipped = {}, 0, 0, 0, 0
    today = local_today()
    for row in body.rows:
        name = row.name.strip()
        if not name:
            continue
        if row.balance < 0:
            raise HTTPException(400, f"Negative balance for {name} is not supported")
        k = seen.get(name, 0)
        seen[name] = k + 1
        same = await db.customers.find({"name": name}, {"_id": 0}).sort("created_at", 1).to_list(100)
        if len(same) > k:
            cust = same[k]
            reused += 1
        else:
            cust = {"id": new_id(), "name": name, "phone": "", "email": "", "address": "", "city": "", "notes": "",
                    "default_zone": 1, "payment_terms": "Due on Delivery", "active": True, "created_at": now_iso()}
            await db.customers.insert_one(dict(cust))
            created += 1
        amt = r2(row.balance)
        if amt <= 0:
            continue
        if await db.invoices.find_one({"customer_id": cust["id"], "opening_balance": True}):
            ob_skipped += 1
            continue
        inv = {"customer_id": cust["id"], "customer_name": name, "date": today.isoformat(),
               "due_date": (today + timedelta(days=30)).isoformat(), "zone": cust.get("default_zone", 1),
               "payment_terms": "Opening Balance", "reference": "", "destination": "", "order_ids": [],
               "notes": "", "discount": 0, "extra_charges": 0,
               "tax_enabled": False, "tax_rate": 0, "amount_paid": 0, "opening_balance": True, "status": "issued",
               "items": [{"qty": 1, "category": "", "size": "", "description": "Opening Balance", "unit_price": amt,
                          "price_override": True, "tax": False, "order_id": ""}],
               "audit": [{"action": "opening_balance_imported", "at": now_iso(), "by": user["email"]}]}
        compute_invoice(inv)
        inv["number"] = await next_invoice_number(inv.get("date"))
        inv["numbering_year"] = invoice_numbering_year(inv.get("date"))
        inv["issued_at"] = now_iso()
        rec = await insert("invoices", inv)
        await log_audit("invoice", rec["id"], "opening_balance_imported", user, after={"customer": name, "amount": amt})
        ob_created += 1
    return {"customers_created": created, "customers_reused": reused, "opening_balances_created": ob_created, "opening_balances_skipped": ob_skipped}

# ---------------- AI Business Assistant ----------------
ASSISTANT_MODEL = ("openai", "gpt-5.2")
SEARCH_MODEL = ("gemini", "gemini-3-flash-preview")

async def web_search(query):
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    c = LlmChat(api_key=os.environ["EMERGENT_LLM_KEY"], session_id=new_id(),
                system_message=f"Today is {today_str()} (Africa/Johannesburg). Search the web, answer factually and concisely, and list the source URLs you used.").with_model(*SEARCH_MODEL).with_tools([{"googleSearch": {}}])
    return await c.send_message(UserMessage(text=query))

WEB_TOOL = [{"type": "function", "function": {"name": "web_search", "description": "Search the live web for current/general information (fuel prices, news, weather, regulations, suppliers...). Returns an answer with source URLs.",
             "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}]

async def business_snapshot(user):
    dash = await dashboard(user=user)
    week, month = period_starts()
    invs, costs, order_records, vrecs, driver_records, vehicles, spare_parts = await asyncio.gather(
        listall("invoices", {"archived": {"$ne": True}}, sort=("date", -1)),
        cost_ledger(month),
        listall("orders", {"archived": {"$ne": True}}),
        listall("vehicle_records"),
        listall("drivers"),
        listall("vehicles"),
        listall("spareparts", {"status": "to_buy"}),
    )
    for i in invs:
        i["status"] = derive_status(i)
    open_inv = [{"number": i.get("number"), "customer": i.get("customer_name"), "date": i.get("date"), "due": i.get("due_date"),
                 "total": i.get("total"), "outstanding": i.get("outstanding"), "status": i["status"]}
                for i in invs if i["status"] in ("issued", "partially_paid", "overdue")]
    debtors = {}
    for i in open_inv:
        debtors[i["customer"]] = r2(D(debtors.get(i["customer"], 0)) + D(i["outstanding"]))
    orders = [{"ref": o.get("reference"), "customer": o.get("customer_name"), "destination": o.get("destination"), "products": o.get("products"),
               "priority": o.get("priority"), "status": o.get("status"), "ship_date": o.get("expected_ship_date")}
              for o in order_records if o.get("status") in OPEN_ORDER_STATUSES]
    drivers = {d["id"]: d["name"] for d in driver_records}
    return {
        "today": today_str(), "timezone": "Africa/Johannesburg", "currency": "ZAR",
        "totals": {
            "total_invoiced": dash["total_invoiced_all_time"],
            **{k: dash[k] for k in ("payments_received", "outstanding", "overdue", "finished_stock")},
        },
        "week": dash["week_profit"], "month": dash["month_profit"], "week_start": week, "month_start": month,
        "debtors_outstanding": dict(sorted(debtors.items(), key=lambda x: -x[1])),
        "open_invoices": open_inv[:60],
        "stock": [{"product": s["product"], "size": s["size"], "current": s["current"], "minimum": s.get("threshold")} for s in dash["current_stock"]],
        "low_stock": [{"product": s["product"], "size": s["size"], "current": s["current"], "minimum": s.get("threshold")} for s in dash["low_stock"]],
        "production": {"resting": len(dash["resting"]), "ready_for_cutting": [p.get("block_ref") for p in dash["ready_cutting"]]},
        "open_orders": orders[:40],
        "upcoming_deliveries": [{"ref": d.get("reference"), "customer": d.get("customer_name"), "destination": d.get("destination"),
                                 "status": d.get("status"), "driver": drivers.get(d.get("driver_id"), ""), "planned": d.get("planned_departure")} for d in dash["upcoming_deliveries"]],
        "attendance_today": dash["attendance_today"],
        "expenses_this_month": [{"date": c["date"], "description": c["description"], "category": c["category"], "amount": c["amount"]} for c in costs][:80],
        "fleet": [{"name": v["name"], "type": v.get("vtype"), "length": v.get("length"), "available": v.get("available"),
                   "pending_work": len([r for r in vrecs if r.get("vehicle_id") == v["id"] and r.get("status") in ("Needed", "Scheduled", "In Progress")])}
                  for v in vehicles],
        "spare_parts_to_buy": [{"name": p["name"], "qty": p.get("quantity")} for p in spare_parts],
    }

ASSISTANT_RULES = """You are the business assistant for SUPER IQ-FOAM, a foam mattress manufacturer and wholesaler in Kokstad, KwaZulu-Natal, South Africa.

STRICT OPERATING RULES
1) Answer only using the ERP business data provided below. Do not invent business facts, customer names, numbers, dates, prices, statuses, or stock levels.
2) If the answer is not in the ERP data, say exactly that. Do not guess. Suggest the page or record where the owner can verify it.
3) For non-business / general questions (weather, fuel prices, news, current market, regulations, suppliers, general advice, personal questions, unrelated topics), respond: "This is outside the ERP data. I can help with business questions only." You may use web search only for genuine current-events or general business info that is relevant to the factory/business. If you do use web search, you MUST end with a "Sources:" list of URLs.
4) Keep answers concise, practical and business-focused. Prefer short bullets, brief summary tables, and action-led responses.
5) Always use South African Rand formatting, e.g. R 1,234.56.
6) If discussing profit, explain that total invoiced is not the same as collected revenue. Estimated result = payments received minus recorded expenses, Buyings, calculated salaries, and accepted GRV costs; note that it is an estimate based on records in the ERP.
7) You cannot create, edit, delete, or change data. You can only explain what exists and tell the user which ERP page to use for the action.
8) If the user asks for a number but the ERP does not contain it, say: "I don't have enough data in the ERP to confirm this." Do not answer from memory.
9) If the question is ambiguous, ask one short clarifying question instead of guessing.
10) The assistant should behave like a disciplined operations analyst for the business, not like a general chatbot.

RESPONSE FORMAT
- Start with the direct answer in 1 sentence.
- Then add a short bullet list with the relevant facts.
- If needed, finish with a "Next step:" suggestion pointing to the ERP page or record to check.
- If no answer exists in ERP, finish with: "I don't have enough data in the ERP to confirm this."

BUSINESS DATA:
"""

class AssistantIn(BaseModel):
    message: str
    session_id: Optional[str] = None

@api.get("/assistant/sessions")
async def assistant_sessions(user=Depends(get_current_user)):
    return await db.assistant_sessions.find({"user_id": user["id"]}, {"_id": 0}).sort("updated_at", -1).to_list(100)

@api.get("/assistant/sessions/{sid}")
async def assistant_session(sid: str, user=Depends(get_current_user)):
    s = await db.assistant_sessions.find_one({"id": sid, "user_id": user["id"]}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Conversation not found")
    s["messages"] = await db.assistant_messages.find({"session_id": sid}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return s

@api.delete("/assistant/sessions/{sid}")
async def assistant_delete(sid: str, user=Depends(get_current_user)):
    await db.assistant_sessions.delete_one({"id": sid, "user_id": user["id"]})
    await db.assistant_messages.delete_many({"session_id": sid})
    return {"ok": True}

@api.post("/assistant/chat")
async def assistant_chat(body: AssistantIn, user=Depends(get_current_user)):
    text = body.message.strip()
    if not text:
        raise HTTPException(400, "Message is empty")
    sid = body.session_id
    if sid and not await db.assistant_sessions.find_one({"id": sid, "user_id": user["id"]}):
        raise HTTPException(404, "Conversation not found")
    from emergentintegrations.llm.chat import LlmChat, UserMessage, TextDelta, StreamDone, ToolCallReady
    if not sid:
        sid = new_id()
        await db.assistant_sessions.insert_one({"id": sid, "user_id": user["id"], "title": text[:60], "created_at": now_iso(), "updated_at": now_iso()})
    history = await db.assistant_messages.find({"session_id": sid}, {"_id": 0}).sort("created_at", 1).to_list(40)
    snapshot = await business_snapshot(user)
    system = ASSISTANT_RULES + json.dumps(snapshot, default=str)
    initial = [{"role": "system", "content": system}] + [{"role": m["role"], "content": m["content"]} for m in history]
    await db.assistant_messages.insert_one({"id": new_id(), "session_id": sid, "role": "user", "content": text, "created_at": now_iso()})
    chat = LlmChat(api_key=os.environ["EMERGENT_LLM_KEY"], session_id=sid, system_message=system, initial_messages=initial).with_model(*ASSISTANT_MODEL).with_tools(WEB_TOOL, tool_choice="auto")

    async def gen():
        yield f"data: {json.dumps({'type': 'session', 'session_id': sid})}\n\n"
        parts = []
        try:
            msg = UserMessage(text=text)
            for _ in range(4):
                pending = []
                async for ev in chat.stream_message(msg):
                    if isinstance(ev, TextDelta):
                        parts.append(ev.content)
                        yield f"data: {json.dumps({'type': 'delta', 'content': ev.content})}\n\n"
                    elif isinstance(ev, ToolCallReady):
                        pending.append(ev.tool_call)
                    elif isinstance(ev, StreamDone):
                        break
                if not pending:
                    break
                for tc in pending:
                    q = (tc.arguments or {}).get("query", "")
                    yield f"data: {json.dumps({'type': 'status', 'content': 'Searching the web: ' + q})}\n\n"
                    try:
                        res = await web_search(q)
                    except Exception as e:
                        res = f"Web search failed: {str(e)[:120]}"
                    chat.add_tool_result(tc.id, json.dumps({"result": res}))
                msg = None
        except Exception as e:
            logging.exception("assistant error")
            yield f"data: {json.dumps({'type': 'error', 'message': 'The AI assistant is unavailable right now. ' + str(e)[:160]})}\n\n"
        answer = "".join(parts)
        if answer:
            await db.assistant_messages.insert_one({"id": new_id(), "session_id": sid, "role": "assistant", "content": answer, "created_at": now_iso()})
        await db.assistant_sessions.update_one({"id": sid}, {"$set": {"updated_at": now_iso()}})
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# ---------------- Audit ----------------
@api.get("/audit")
async def get_audit(entity: Optional[str] = None, entity_id: Optional[str] = None, user=Depends(get_current_user)):
    flt = {k: v for k, v in {"entity": entity, "entity_id": entity_id}.items() if v}
    if not can_view_invoice_audit(user):
        if entity == "invoice":
            raise HTTPException(403, "Invoice audit history is restricted to company owners")
        flt["entity"] = {"$ne": "invoice"}
    return await db.audit_log.find(flt, {"_id": 0}).sort("at", -1).to_list(500)

# ---------------- Orders to send ----------------
class OrderIn(BaseModel):
    customer_id: Optional[str] = ""
    customer_name: Optional[str] = ""
    customer_address: Optional[str] = ""
    customer_phone: Optional[str] = ""
    customer_email: Optional[str] = ""
    invoice_id: Optional[str] = ""
    invoice_number: Optional[str] = ""
    destination: str = ""
    products: str = ""
    items: List[dict] = []  # [{qty, category, size}]
    priority: str = "Normal"  # Low, Normal, High, Urgent
    status: str = "To Send"  # To Send, Preparing, Assigned, Dispatched, Delivered, Cancelled
    expected_ship_date: Optional[str] = None
    vehicle_id: Optional[str] = ""
    notes: Optional[str] = ""

    @field_validator("status")
    @classmethod
    def valid_order_status(cls, value):
        allowed = ("To Send", "Preparing", "Assigned", "Dispatched", "Partially Delivered", "Delivered", "Cancelled")
        if value not in allowed:
            raise ValueError(f"Status must be one of: {', '.join(allowed)}")
        return value

    @field_validator("priority")
    @classmethod
    def valid_order_priority(cls, value):
        if value not in ("Low", "Normal", "High", "Urgent"):
            raise ValueError("Priority must be Low, Normal, High or Urgent")
        return value

class DriverDeliveryConfirmationIn(BaseModel):
    signature_data: str = Field(min_length=30, max_length=180000)
    driver_name: str = Field(min_length=1, max_length=100)
    driver_confirmed: bool

    @field_validator("driver_name")
    @classmethod
    def clean_driver_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Driver name is required")
        return value

    @field_validator("driver_confirmed")
    @classmethod
    def require_driver_confirmation(cls, value):
        if not value:
            raise ValueError("Driver must confirm the loaded items")
        return value

def validate_signature_png(signature_data):
    prefix = "data:image/png;base64,"
    if not signature_data.startswith(prefix):
        raise HTTPException(422, "Signature must be a PNG image")
    try:
        image = base64.b64decode(signature_data[len(prefix):], validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise HTTPException(422, "Signature image is invalid") from error
    if len(image) > 128 * 1024:
        raise HTTPException(413, "Signature image is too large")
    if not image.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(422, "Signature image is invalid")

def delivery_invoice_snapshot(invoice):
    if not invoice:
        return None
    return {
        "invoice_number": invoice.get("number") or invoice.get("reference") or "",
        "items": [
            {
                key: item.get(key)
                for key in ("qty", "category", "description", "size")
                if key in item
            }
            for item in invoice.get("items", [])
            if isinstance(item, dict)
        ],
    }

def delivery_invoice_matches_order(invoice, order):
    invoice_customer_id = invoice.get("customer_id")
    order_customer_id = order.get("customer_id")
    if invoice_customer_id and order_customer_id:
        return invoice_customer_id == order_customer_id
    invoice_customer_name = " ".join(str(invoice.get("customer_name") or "").split()).casefold()
    order_customer_name = " ".join(str(order.get("customer_name") or "").split()).casefold()
    return bool(invoice_customer_name and invoice_customer_name == order_customer_name)

@api.get("/orders")
async def get_orders(
    include_archived: bool = False,
    page: Optional[int] = Query(None, ge=1),
    page_size: int = Query(50, ge=1, le=50),
    status: Literal["all", "open", "To Send", "Preparing", "Assigned", "Dispatched",
                    "Delivered", "Cancelled", "Partially Delivered"] = "all",
    order_date: Optional[str] = None,
    q: str = Query("", max_length=100),
    user=Depends(get_current_user),
):
    flt = {} if include_archived else {"archived": {"$ne": True}}
    if page is not None:
        clauses = [flt]
        if status == "open":
            clauses.append({"status": {"$in": ["To Send", "Preparing", "Assigned"]}})
        elif status != "all":
            clauses.append({"status": status})
        if order_date:
            try:
                selected = date.fromisoformat(validate_iso_date(order_date))
            except ValueError as error:
                raise HTTPException(422, "Order date must use YYYY-MM-DD format") from error
            start = datetime.combine(selected, datetime.min.time(), TZ).astimezone(timezone.utc)
            end = datetime.combine(selected + timedelta(days=1), datetime.min.time(), TZ).astimezone(timezone.utc)
            clauses.append({"$or": [
                {"created_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}},
                {"created_at": {"$gte": start, "$lt": end}},
            ]})
        term = q.strip()
        search_query = None
        if term:
            pattern = {"$regex": re.escape(term), "$options": "i"}
            search_query = {"$or": [
                {"reference": pattern},
                {"customer_name": pattern},
                {"invoice_number": pattern},
                {"destination": pattern},
                {"products": pattern},
                {"items.category": pattern},
                {"items.size": pattern},
                {"items.description": pattern},
            ]}
            clauses.append(search_query)
        query = {"$and": clauses}
        status_count_query = {"$and": [flt, *([search_query] if search_query else [])]}
        projection = {
            "_id": 0, "id": 1, "reference": 1, "invoice_id": 1, "invoice_number": 1,
            "customer_id": 1, "customer_name": 1, "customer_address": 1, "customer_phone": 1,
            "customer_email": 1, "destination": 1, "items": 1, "products": 1,
            "priority": 1, "status": 1, "expected_ship_date": 1, "vehicle_id": 1,
            "notes": 1, "created_at": 1, "archived": 1,
        }
        cursor = db.orders.aggregate([
            {"$match": query},
            {"$addFields": {
                "_priority_rank": {"$switch": {
                    "branches": [
                        {"case": {"$eq": ["$priority", "Urgent"]}, "then": 0},
                        {"case": {"$eq": ["$priority", "High"]}, "then": 1},
                        {"case": {"$eq": ["$priority", "Normal"]}, "then": 2},
                        {"case": {"$eq": ["$priority", "Low"]}, "then": 3},
                    ],
                    "default": 9,
                }},
                "_ship_date_sort": {"$cond": [
                    {"$eq": [{"$ifNull": ["$expected_ship_date", ""]}, ""]},
                    "9",
                    "$expected_ship_date",
                ]},
            }},
            {"$sort": {"_priority_rank": 1, "_ship_date_sort": 1, "id": 1}},
            {"$skip": (page - 1) * page_size},
            {"$limit": page_size},
            {"$project": {
                "_id": 0,
                **{field: 1 for field, included in projection.items() if included and field != "_id"},
            }},
        ])
        status_cursor = db.orders.aggregate([
            {"$match": status_count_query},
            {"$group": {"_id": "$status", "count": {"$sum": 1}}},
        ])
        items, total, status_rows, all_status_total = await asyncio.gather(
            cursor.to_list(length=page_size),
            db.orders.count_documents(query),
            status_cursor.to_list(length=16),
            db.orders.count_documents(status_count_query),
        )
        status_counts = {row["_id"]: row["count"] for row in status_rows if row.get("_id")}
        status_counts["all"] = all_status_total
        status_counts["open"] = sum(
            status_counts.get(value, 0) for value in ("To Send", "Preparing", "Assigned")
        )
        return {
            "items": items, "total": total, "page": page, "page_size": page_size,
            "status_counts": status_counts,
        }
    orders = await listall("orders", flt, sort=("created_at", -1))
    for order in orders:
        order.pop("signature_data", None)
        order.pop("driver_signature_data", None)
    return orders

@api.post("/orders")
async def add_order(body: OrderIn, user=Depends(get_current_user)):
    d = body.model_dump()
    d["reference"] = await next_ref("ord", "ORD")
    if d.get("status") == "Delivered":
        d["completed_at"] = now_iso()
    if d.get("customer_id"):
        c = await db.customers.find_one({"id": d["customer_id"]})
        if c:
            d["customer_name"] = c["name"]
            d["customer_address"] = c.get("address", "")
            d["customer_phone"] = c.get("phone", "")
            d["customer_email"] = c.get("email", "")
    if d.get("invoice_id"):
        invoice = await db.invoices.find_one({"id": d["invoice_id"]}, {"_id": 0})
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        if invoice.get("customer_id") != d.get("customer_id"):
            raise HTTPException(400, "Invoice must belong to the selected customer")
        d["invoice_number"] = invoice.get("number") or invoice.get("reference") or ""
    record = await insert("orders", d)
    await emit_workflow_event("order.created", record)
    return record

@api.put("/orders/{oid}")
async def edit_order(oid: str, body: OrderIn, user=Depends(get_current_user)):
    existing = await db.orders.find_one({"id": oid})
    if not existing:
        raise HTTPException(404, "Order not found")
    if existing.get("archived") or existing.get("status") == "Cancelled":
        raise HTTPException(404, "Order not found")
    d = body.model_dump()
    if existing.get("driver_signature_data") and (
        d.get("items", []) != existing.get("items", [])
        or d.get("products", "") != existing.get("products", "")
        or d.get("invoice_id", "") != existing.get("invoice_id", "")
    ):
        raise HTTPException(409, "Order items and invoice cannot be changed after driver confirmation")
    d["reference"] = existing.get("reference")
    if d.get("status") == "Delivered":
        d["completed_at"] = (
            now_iso()
            if existing.get("status") != "Delivered" or not existing.get("completed_at")
            else existing["completed_at"]
        )
    if d.get("customer_id"):
        c = await db.customers.find_one({"id": d["customer_id"]})
        if c:
            d["customer_name"] = c["name"]
            d["customer_address"] = c.get("address", "")
            d["customer_phone"] = c.get("phone", "")
            d["customer_email"] = c.get("email", "")
    if d.get("invoice_id"):
        invoice = await db.invoices.find_one({"id": d["invoice_id"]}, {"_id": 0})
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        if invoice.get("customer_id") != d.get("customer_id"):
            raise HTTPException(400, "Invoice must belong to the selected customer")
        d["invoice_number"] = invoice.get("number") or invoice.get("reference") or ""
    record = await update_doc("orders", oid, d)
    record.pop("signature_data", None)
    record.pop("driver_signature_data", None)
    await emit_workflow_event("order.updated", record)
    return record

class SmartProductionArrangementIn(BaseModel):
    order_ids: List[str] = Field(min_length=1, max_length=50)


def require_smart_production_planner(user):
    company_id = user.get("_active_company_id") or active_company_id.get() or DEFAULT_COMPANY_ID
    if company_id != DEFAULT_COMPANY_ID:
        raise HTTPException(403, "Smart Production Planner is only available for SUPERIQFOAM")
    require_admin(user)


async def acquire_smart_production_planner_lock():
    owner = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    try:
        lock = await db.smart_production_arrangement_locks.find_one_and_update(
            {
                "_id": "planner",
                "$or": [
                    {"lease_until": {"$lte": now}},
                    {"lease_until": {"$exists": False}},
                ],
            },
            {"$set": {"owner": owner, "lease_until": now + timedelta(seconds=30)}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError as error:
        raise HTTPException(409, "Another arrangement is being planned. Try again shortly.") from error
    if not lock or lock.get("owner") != owner:
        raise HTTPException(409, "Another arrangement is being planned. Try again shortly.")
    return owner


async def create_or_refresh_smart_production_arrangement(order_ids, user):
    normalized_ids = [str(order_id).strip() for order_id in order_ids]
    if any(not order_id for order_id in normalized_ids) or len(set(normalized_ids)) != len(normalized_ids):
        raise HTTPException(422, "Select each order only once.")
    owner = await acquire_smart_production_planner_lock()
    try:
        active_plans = await listall("smart_production_arrangements", {"status": "active"})
        selected_ids = set(normalized_ids)
        existing_plan = next((
            plan for plan in active_plans
            if set(plan.get("order_ids", [])) == selected_ids
        ), None)
        overlapping_plans = [
            plan for plan in active_plans
            if selected_ids.intersection(str(value) for value in plan.get("order_ids", []))
        ]
        if existing_plan is None and overlapping_plans:
            existing_plan = overlapping_plans[0]
        superseded_plans = [
            plan for plan in overlapping_plans
            if not existing_plan or plan.get("id") != existing_plan.get("id")
        ]

        all_orders = await listall("orders", {"archived": {"$ne": True}}, sort=("created_at", 1))
        orders_by_id = {str(order.get("id") or ""): order for order in all_orders}
        selected_orders = [orders_by_id[order_id] for order_id in normalized_ids if order_id in orders_by_id]
        if len(selected_orders) != len(normalized_ids):
            raise HTTPException(404, "One or more selected orders could not be found in this company.")

        stock_items = await listall("stock", sort=("product", 1))
        movements_by_stock = await stock_movements_for_stock_ids([item["id"] for item in stock_items])
        for stock_item in stock_items:
            apply_stock_movements(stock_item, movements_by_stock.get(stock_item["id"], []))
        employees = await listall("employees", sort=("name", 1))
        superseded_ids = {plan.get("id") for plan in superseded_plans}
        other_plans = [
            plan for plan in active_plans
            if plan.get("id") not in superseded_ids
            and (not existing_plan or plan.get("id") != existing_plan.get("id"))
        ]
        try:
            plan = build_smart_production_plan(
                selected_orders,
                all_orders,
                stock_items,
                employees,
                active_arrangements=other_plans,
            )
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

        plan_key = hashlib.sha256("|".join(sorted(normalized_ids)).encode("utf-8")).hexdigest()
        plan.update({
            "plan_key": plan_key,
            "status": "active",
            "stage": "proposal",
            "generated_at": now_iso(),
            "generated_by": user.get("id"),
        })
        if existing_plan:
            updated = await update_doc(
                "smart_production_arrangements",
                existing_plan["id"],
                plan,
            )
            plan_id = existing_plan["id"]
            await log_audit(
                "smart_production_arrangement",
                plan_id,
                "proposal_revalidated" if not superseded_plans else "proposal_rearranged",
                user,
                before=existing_plan,
                after=updated,
            )
        else:
            updated = await insert("smart_production_arrangements", plan)
            plan_id = updated["id"]
            await log_audit(
                "smart_production_arrangement",
                plan_id,
                "proposal_created",
                user,
                after=updated,
            )

        for superseded_plan in superseded_plans:
            released = await update_doc(
                "smart_production_arrangements",
                superseded_plan["id"],
                {
                    "status": "released",
                    "released_at": now_iso(),
                    "released_by": user.get("id"),
                    "superseded_by": plan_id,
                },
            )
            await log_audit(
                "smart_production_arrangement",
                superseded_plan["id"],
                "proposal_superseded",
                user,
                before=superseded_plan,
                after=released,
            )
        return updated
    finally:
        await db.smart_production_arrangement_locks.delete_one({
            "_id": "planner",
            "owner": owner,
        })


@api.post("/orders/smart-production-arrangements")
async def create_smart_production_arrangement(
    body: SmartProductionArrangementIn,
    user=Depends(get_current_user),
):
    require_smart_production_planner(user)
    return await create_or_refresh_smart_production_arrangement(body.order_ids, user)


@api.delete("/orders/smart-production-arrangements/{arrangement_id}")
async def release_smart_production_arrangement(
    arrangement_id: str,
    user=Depends(get_current_user),
):
    require_smart_production_planner(user)
    owner = await acquire_smart_production_planner_lock()
    try:
        plan = await db.smart_production_arrangements.find_one(
            {"id": arrangement_id, "status": "active"},
            {"_id": 0},
        )
        if not plan:
            raise HTTPException(404, "Active arrangement not found.")
        released = await update_doc(
            "smart_production_arrangements",
            arrangement_id,
            {"status": "released", "released_at": now_iso(), "released_by": user.get("id")},
        )
        await log_audit(
            "smart_production_arrangement",
            arrangement_id,
            "proposal_released",
            user,
            before=plan,
            after=released,
        )
        return released
    finally:
        await db.smart_production_arrangement_locks.delete_one({
            "_id": "planner",
            "owner": owner,
        })

@api.get("/orders/{oid}/driver-confirmation")
async def get_order_driver_confirmation(oid: str, user=Depends(get_current_user)):
    order = await db.orders.find_one(
        {"id": oid, "archived": {"$ne": True}, "status": {"$ne": "Cancelled"}},
        {"_id": 0, "invoice_id": 1, "invoice_number": 1, "customer_id": 1,
         "driver_signature_data": 1, "driver_name": 1, "driver_confirmed_at": 1,
         "driver_confirmation_snapshot": 1},
    )
    if not order:
        raise HTTPException(404, "Order not found")
    invoice_snapshot = None
    if order.get("driver_confirmation_snapshot"):
        invoice_snapshot = order["driver_confirmation_snapshot"].get("invoice_snapshot")
    elif order.get("invoice_id"):
        invoice = await db.invoices.find_one(
            {"id": order["invoice_id"]},
            {"_id": 0, "number": 1, "reference": 1, "customer_id": 1,
             "customer_name": 1, "items": 1},
        )
        if invoice and delivery_invoice_matches_order(invoice, order):
            invoice_snapshot = delivery_invoice_snapshot(invoice)
    return {
        "signature_data": order.get("driver_signature_data", ""),
        "driver_name": order.get("driver_name", ""),
        "confirmed_at": order.get("driver_confirmed_at", ""),
        "confirmation_snapshot": order.get("driver_confirmation_snapshot"),
        "invoice_snapshot": invoice_snapshot,
    }

@api.post("/orders/{oid}/driver-confirmation")
async def save_order_driver_confirmation(oid: str, body: DriverDeliveryConfirmationIn, user=Depends(get_current_user)):
    validate_signature_png(body.signature_data)
    existing = await db.orders.find_one(
        {"id": oid, "archived": {"$ne": True}, "status": {"$ne": "Cancelled"}},
        {"_id": 0, "id": 1, "reference": 1, "invoice_id": 1, "invoice_number": 1,
         "items": 1, "products": 1, "driver_signature_data": 1},
    )
    if not existing:
        raise HTTPException(404, "Order not found")
    if existing.get("driver_signature_data"):
        raise HTTPException(409, "This delivery has already been confirmed by the driver")
    invoice_snapshot = None
    if existing.get("invoice_id"):
        invoice = await db.invoices.find_one(
            {"id": existing["invoice_id"]},
            {"_id": 0, "number": 1, "reference": 1, "customer_id": 1,
             "customer_name": 1, "items": 1},
        )
        if not invoice or not delivery_invoice_matches_order(invoice, existing):
            raise HTTPException(409, "The linked invoice could not be verified for this order")
        invoice_snapshot = delivery_invoice_snapshot(invoice)
    confirmation_time = now_iso()
    snapshot = {
        "order_reference": existing.get("reference", ""),
        "invoice_id": existing.get("invoice_id", ""),
        "invoice_number": existing.get("invoice_number", ""),
        "invoice_snapshot": invoice_snapshot,
        "items": [
            {
                key: item.get(key)
                for key in ("qty", "category", "description", "size")
                if key in item
            }
            for item in existing.get("items", [])
            if isinstance(item, dict)
        ],
        "products": existing.get("products", ""),
        "driver_confirmed_items_match": True,
    }
    result = await db.orders.update_one(
        {
            "id": oid,
            "archived": {"$ne": True},
            "status": {"$ne": "Cancelled"},
            "driver_signature_data": {"$in": [None, ""]},
        },
        {"$set": {
            "driver_signature_data": body.signature_data,
            "driver_name": body.driver_name,
            "driver_confirmed_at": confirmation_time,
            "driver_confirmation_snapshot": snapshot,
            "updated_at": confirmation_time,
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(409, "This delivery has already been confirmed by the driver")
    confirmation = {
        "driver_name": body.driver_name,
        "confirmed_at": confirmation_time,
        "confirmation_snapshot": snapshot,
    }
    await log_audit(
        "order", oid, "driver_confirmed_delivery_items", user,
        after={key: value for key, value in confirmation.items() if key != "confirmation_snapshot"}
        | {"confirmation_snapshot": snapshot},
    )
    return confirmation

@api.delete("/orders/{oid}")
async def del_order(oid: str, permanent: bool = False, user=Depends(get_current_user)):
    order = await db.orders.find_one({"id": oid}, {"_id": 0})
    if not order:
        raise HTTPException(404, "Order not found")
    if permanent:
        require_profile_owner(user)
        await db.orders.delete_one({"id": oid})
        await log_audit("order", oid, "permanently_deleted", user, before=order, after={"deleted": True})
        await emit_workflow_event("order.deleted", order)
        return {"ok": True, "deleted": True}
    updated = await update_doc("orders", oid, {
        "status": "Cancelled",
    })
    await log_audit("order", oid, "cancelled", user, before=order, after=updated)
    await emit_workflow_event("order.updated", updated)
    return {"ok": True, "cancelled": True}

# ---------------- Attendance summary ----------------
# ---------------- Simple daily production (white / blue blocks) ----------------
class DailyProductionBlock(BaseModel):
    block: str
    quantity: int = 0

class DailyProdIn(BaseModel):
    date: str = Field(default_factory=today_str)
    white_blocks: int = 0
    blue_blocks: int = 0
    blocks: list[DailyProductionBlock] = Field(default_factory=list)
    notes: Optional[str] = ""

    @field_validator("date")
    @classmethod
    def daily_date_valid(cls, value):
        return validate_iso_date(value)

def daily_production_blocks(record):
    blocks = record.get("blocks") or []
    if blocks:
        return [
            {"block": normalize_block_name(item.get("block")), "quantity": int(item.get("quantity", 0) or 0)}
            for item in blocks
        ]
    return [
        {"block": name, "quantity": int(record.get(field, 0) or 0)}
        for name, field in (("White", "white_blocks"), ("Blue", "blue_blocks"))
        if int(record.get(field, 0) or 0) > 0
    ]

@api.get("/production/daily")
async def get_daily_prod(
    include_archived: bool = False,
    page: Optional[int] = Query(None, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    user=Depends(get_current_user),
):
    flt = {} if include_archived else {"archived": {"$ne": True}}
    if page is None:
        rows = await listall("production_daily", flt, sort=("date", -1))
        total = len(rows)
    else:
        cursor = (
            db.production_daily.find(flt, {"_id": 0})
            .sort([("date", -1), ("id", 1)])
            .skip((page - 1) * page_size)
            .limit(page_size)
        )
        rows, total = await asyncio.gather(
            cursor.to_list(length=page_size),
            db.production_daily.count_documents(flt),
        )
    week, month = period_starts()
    summary_start = min(week, month)
    active_rows = await listall(
        "production_daily",
        {"archived": {"$ne": True}, "date": {"$gte": summary_start}},
        sort=("date", -1),
    )
    for row in rows:
        row["blocks"] = daily_production_blocks(row)
        row["total_blocks"] = sum(item["quantity"] for item in row["blocks"])
    def tot(since):
        totals = {}
        for record in active_rows:
            if record["date"] < since:
                continue
            for item in daily_production_blocks(record):
                block = item["block"]
                totals[block] = totals.get(block, 0) + item["quantity"]
        return {
            "blocks": totals,
            "total_blocks": sum(totals.values()),
            "white_blocks": totals.get("White", 0),
            "blue_blocks": totals.get("Blue", 0),
        }
    return {
        "rows": rows, "today": tot(today_str()), "week": tot(week), "month": tot(month),
        "total": total, "page": page, "page_size": page_size if page is not None else None,
    }

@api.post("/production/daily")
async def save_daily_prod(body: DailyProdIn, user=Depends(get_current_user)):
    blocks = [
        {"block": normalize_block_name(item.block), "quantity": item.quantity}
        for item in body.blocks
    ]
    if blocks:
        if any(not item["block"] for item in blocks):
            raise HTTPException(400, "A block name is required")
        if any(item["quantity"] < 0 for item in blocks):
            raise HTTPException(400, "Block counts cannot be negative")
        white_blocks = sum(item["quantity"] for item in blocks if item["block"].casefold() == "white")
        blue_blocks = sum(item["quantity"] for item in blocks if item["block"].casefold() == "blue")
    else:
        if body.white_blocks < 0 or body.blue_blocks < 0:
            raise HTTPException(400, "Block counts cannot be negative")
        white_blocks, blue_blocks = body.white_blocks, body.blue_blocks
        blocks = [
            {"block": name, "quantity": quantity}
            for name, quantity in (("White", white_blocks), ("Blue", blue_blocks))
            if quantity > 0
        ]
    if any(not item["block"] for item in blocks):
        raise HTTPException(400, "A block name is required")
    if any(item["quantity"] < 0 for item in blocks):
        raise HTTPException(400, "Block counts cannot be negative")
    d = body.model_dump()
    d.update({"blocks": blocks, "white_blocks": white_blocks, "blue_blocks": blue_blocks})
    ex = await db.production_daily.find_one({"date": d["date"]}, {"_id": 0})
    rec = await update_doc("production_daily", ex["id"], d) if ex else await insert("production_daily", d)
    await log_audit("production_daily", rec["id"], "saved", user, before=ex, after=rec)
    await emit_workflow_event("production.daily_saved", {
        **rec,
        "total_blocks": sum(item["quantity"] for item in rec.get("blocks", [])),
    })
    return rec

@api.delete("/production/daily/{pid}")
async def del_daily_prod(pid: str, user=Depends(get_current_user)):
    before = await db.production_daily.find_one({"id": pid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Production record not found")
    updated = await update_doc("production_daily", pid, {
        "archived": True, "archived_at": now_iso(), "archived_by": user.get("id"),
    })
    await log_audit("production_daily", pid, "archived", user, before=before, after=updated)
    return {"ok": True, "archived": True}

@api.post("/production/daily/{pid}/restore")
async def restore_daily_prod(pid: str, user=Depends(get_current_user)):
    before = await db.production_daily.find_one({"id": pid}, {"_id": 0})
    if not before:
        raise HTTPException(404, "Production record not found")
    updated = await update_doc("production_daily", pid, {
        "archived": False, "archived_at": None, "archived_by": None,
    })
    await log_audit("production_daily", pid, "restored", user, before=before, after=updated)
    return {"ok": True}

class ProductionRunMaterialIn(BaseModel):
    stock_id: str
    quantity: float
    unit_cost: float = 0

class ProductionRunIn(BaseModel):
    date: str = Field(default_factory=today_str)
    product: str
    order_id: Optional[str] = ""
    planned_quantity: float
    planned_hours: float = 0
    labor_rate: float = 0
    materials: List[ProductionRunMaterialIn] = Field(default_factory=list)
    notes: Optional[str] = ""

class CompleteProductionRunIn(BaseModel):
    actual_quantity: float
    scrap_quantity: float = 0
    actual_hours: float
    materials: List[ProductionRunMaterialIn] = Field(default_factory=list)

def _validate_run_materials(materials):
    for material in materials:
        if not math.isfinite(material.quantity) or material.quantity <= 0:
            raise HTTPException(400, "Material quantities must be greater than 0")
        if not math.isfinite(material.unit_cost) or material.unit_cost < 0:
            raise HTTPException(400, "Material unit costs cannot be negative")

@api.get("/production/runs")
async def get_production_runs(user=Depends(get_current_user)):
    return await listall("production_runs", sort=("date", -1))

@api.post("/production/runs")
async def create_production_run(body: ProductionRunIn, user=Depends(get_current_user)):
    if not body.product.strip():
        raise HTTPException(400, "Product is required")
    if not math.isfinite(body.planned_quantity) or body.planned_quantity <= 0:
        raise HTTPException(400, "Planned quantity must be greater than 0")
    if not math.isfinite(body.planned_hours) or body.planned_hours < 0:
        raise HTTPException(400, "Planned hours cannot be negative")
    if not math.isfinite(body.labor_rate) or body.labor_rate < 0:
        raise HTTPException(400, "Labor rate cannot be negative")
    _validate_run_materials(body.materials)
    order = None
    if body.order_id:
        order = await db.orders.find_one({"id": body.order_id}, {"_id": 0})
        if not order:
            raise HTTPException(400, "Linked order not found")
    materials = []
    for item in body.materials:
        stock = await db.stock.find_one({"id": item.stock_id}, {"_id": 0})
        if not stock:
            raise HTTPException(400, "A selected material stock item no longer exists")
        materials.append({
            **item.model_dump(), "product": stock["product"], "size": stock["size"],
        })
    planned_material_cost = dsum(buying_amount(item["quantity"], item["unit_cost"]) for item in materials)
    planned_labor_cost = body.planned_hours * body.labor_rate
    if not math.isfinite(planned_labor_cost):
        raise HTTPException(400, "Planned labor cost is too large")
    data = body.model_dump()
    data.update({
        "product": body.product.strip(), "order_reference": order.get("reference", "") if order else "",
        "materials": materials, "planned_material_cost": planned_material_cost,
        "planned_labor_cost": r2(planned_labor_cost),
        "status": "planned",
    })
    rec = await insert("production_runs", data)
    await log_audit("production_run", rec["id"], "planned", user, after=rec)
    await emit_workflow_event("production.created", {
        **rec,
        "quantity": rec["planned_quantity"],
        "block_ref": rec["product"],
        "production_date": rec["date"],
    })
    return rec

@api.post("/production/runs/{run_id}/complete")
async def complete_production_run(run_id: str, body: CompleteProductionRunIn, user=Depends(get_current_user)):
    run = await db.production_runs.find_one({"id": run_id}, {"_id": 0})
    if not run:
        raise HTTPException(404, "Production plan not found")
    if run.get("status") != "planned":
        raise HTTPException(409, "Only planned production runs can be completed")
    if not math.isfinite(body.actual_quantity) or body.actual_quantity <= 0:
        raise HTTPException(400, "Actual production quantity must be greater than 0")
    if not math.isfinite(body.scrap_quantity) or body.scrap_quantity < 0 or body.scrap_quantity > body.actual_quantity:
        raise HTTPException(400, "Scrap quantity must be between zero and actual production")
    if not math.isfinite(body.actual_hours) or body.actual_hours < 0:
        raise HTTPException(400, "Actual hours cannot be negative")
    _validate_run_materials(body.materials)
    materials = []
    for item in body.materials:
        stock = await db.stock.find_one({"id": item.stock_id}, {"_id": 0})
        if not stock:
            raise HTTPException(400, "A selected material stock item no longer exists")
        materials.append({**item.model_dump(), "product": stock["product"], "size": stock["size"]})
    stock_ids = [item["stock_id"] for item in materials]
    async with StockLock(stock_ids):
        claimed = await db.production_runs.find_one_and_update(
            {"id": run_id, "status": "planned"},
            {"$set": {"status": "processing"}},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER,
        )
        if not claimed:
            raise HTTPException(409, "Production run is already being completed or is complete")
        try:
            totals = {}
            for item in materials:
                totals[item["stock_id"]] = totals.get(item["stock_id"], 0) + item["quantity"]
            for stock_id, quantity in totals.items():
                stock = await db.stock.find_one({"id": stock_id}, {"_id": 0})
                await stock_current(stock)
                if quantity > stock["current"]:
                    raise HTTPException(400, f"Insufficient stock for {stock['product']} {stock['size']}: available {stock['current']}, requested {quantity}")
            for index, item in enumerate(materials):
                key = f"production-run:{run_id}:{index}"
                if not await db.stock_movements.find_one({"dedupe_key": key}):
                    stock = await db.stock.find_one({"id": item["stock_id"]}, {"_id": 0})
                    await post_movement(
                        stock, "production_consumption", item["quantity"], user,
                        reason=f"Production run {run_id}", reference=run.get("order_reference", ""),
                        dedupe_key=key, direction=-1,
                        extra={"production_run_id": run_id, "unit_cost": item["unit_cost"]},
                    )
            material_cost = dsum(buying_amount(item["quantity"], item["unit_cost"]) for item in materials)
            labor_cost_value = body.actual_hours * run["labor_rate"]
            if not math.isfinite(labor_cost_value):
                raise HTTPException(400, "Actual labor cost is too large")
            labor_cost = r2(labor_cost_value)
            if not math.isfinite(material_cost + labor_cost):
                raise HTTPException(400, "Actual production cost is too large")
            total_cost = r2(material_cost + labor_cost)
            good_quantity = body.actual_quantity - body.scrap_quantity
            rec = await update_doc("production_runs", run_id, {
                "status": "completed", "actual_quantity": body.actual_quantity,
                "scrap_quantity": body.scrap_quantity, "good_quantity": good_quantity,
                "actual_hours": body.actual_hours, "actual_materials": materials,
                "actual_material_cost": material_cost, "actual_labor_cost": labor_cost,
                "actual_total_cost": total_cost,
                "cost_per_good_unit": r2(total_cost / good_quantity) if good_quantity else None,
                "completed_at": now_iso(),
            })
        except Exception:
            await update_doc("production_runs", run_id, {"status": "planned"})
            raise
    await log_audit("production_run", run_id, "completed", user, before=run, after=rec)
    await emit_workflow_event("production.completed", {
        **rec,
        "quantity": rec["actual_quantity"],
        "block_ref": rec["product"],
        "production_date": rec["date"],
    })
    return rec

class BulkAttendanceIn(BaseModel):
    date: str
    status: str = "Present"
    employee_ids: List[str]

    @field_validator("date")
    @classmethod
    def bulk_date_valid(cls, value):
        return validate_iso_date(value)

@api.post("/attendance/bulk")
async def bulk_attendance(body: BulkAttendanceIn, user=Depends(get_current_user)):
    employee_ids = list(dict.fromkeys(body.employee_ids))
    known = {e["id"] async for e in db.employees.find({"id": {"$in": employee_ids}}, {"id": 1, "_id": 0})}
    missing = [eid for eid in employee_ids if eid not in known]
    if missing:
        raise HTTPException(400, "Employee not found")
    for eid in employee_ids:
        await add_attendance(AttendanceIn(employee_id=eid, date=body.date, status=body.status), user)
    return {"ok": True, "count": len(employee_ids)}

# ---------------- Trip planner ----------------
class TripPlanIn(BaseModel):
    invoice_numbers: List[str]
    vehicle_id: Optional[str] = ""
    trailer_id: Optional[str] = ""
    fuel_in_tank_l: float = 0
    departure: Optional[str] = None
    cities: dict = {}  # invoice_number -> city override

def _guess_city(text, table):
    t = (text or "").upper()
    hits = [c for c in table if c and c in t]
    return max(hits, key=len) if hits else ""

@api.post("/deliveries/plan")
async def plan_trip(body: TripPlanIn, user=Depends(get_current_user)):
    st = await get_settings(user)
    table = {k.upper(): v for k, v in (st.get("city_distances") or {}).items()}
    weights = st.get("piece_weights_kg") or {}
    stops, missing, warnings = [], [], []
    for raw in body.invoice_numbers:
        num = raw.strip().upper()
        if not num:
            continue
        inv = await db.invoices.find_one({"number": {"$regex": f"^{num}$", "$options": "i"}}, {"_id": 0})
        if not inv:
            missing.append(f"Invoice {num} not found")
            continue
        cust = await db.customers.find_one({"id": inv["customer_id"]}, {"_id": 0}) or {}
        city = (body.cities.get(inv["number"]) or inv.get("destination") or cust.get("city") or "").strip()
        guessed = False
        if not city:
            city, guessed = _guess_city(cust.get("name", ""), table), True
        dist = table.get(city.upper()) if city else None
        pieces = sum(int(it.get("qty") or 0) for it in inv.get("items", []) if it.get("size"))
        kg = 0
        unknown_w = False
        for it in inv.get("items", []):
            if it.get("size"):
                w = weights.get(it["size"])
                if w is None:
                    unknown_w = True
                else:
                    kg += float(w) * int(it.get("qty") or 0)
        stops.append({"invoice": inv["number"], "customer": inv.get("customer_name"), "city": city, "city_guessed": guessed and bool(city),
                      "distance_km": dist, "pieces": pieces, "weight_kg": None if unknown_w else round(kg),
                      "items": [{"qty": it.get("qty"), "category": it.get("category"), "size": it.get("size"), "description": it.get("description")} for it in inv.get("items", [])]})
        if not city:
            missing.append(f"{inv['number']} ({inv.get('customer_name')}): city unknown — enter it")
        elif dist is None:
            missing.append(f"{city}: distance from Kokstad not configured — add it in Settings")
    stops.sort(key=lambda s: s["distance_km"] if s["distance_km"] is not None else 9999)
    total_pieces = sum(s["pieces"] for s in stops)
    weight_known = all(s["weight_kg"] is not None for s in stops) and stops
    total_kg = sum(s["weight_kg"] or 0 for s in stops) if weight_known else None
    if not weight_known:
        warnings.append("Weight per mattress size not configured (Settings > piece weights) — truck choice is based on pieces/distance only")
    far = max([s["distance_km"] for s in stops if s["distance_km"] is not None], default=None)
    route_km = round(far * 2 * 1.1) if far is not None else None  # out-and-back along route + 10% detours (estimate)
    vehicles = await listall("vehicles")
    trucks = [v for v in vehicles if v.get("vtype") != "Trailer" and v.get("available") and v.get("consumption_max")]
    trailers = [v for v in vehicles if v.get("vtype") == "Trailer" and v.get("available")]
    trucks.sort(key=lambda v: v.get("payload_kg") or 0)
    sel = next((v for v in trucks if v["id"] == body.vehicle_id), None)
    if not sel and trucks:
        if total_kg is not None:
            sel = next((v for v in trucks if (v.get("payload_kg") or 0) >= total_kg), None)
            if not sel:
                sel = trucks[-1]
                warnings.append(f"Load {total_kg} kg exceeds largest truck payload — split the trip or add a trailer")
        else:
            sel = trucks[-1] if (total_pieces > 150 or (far or 0) > 150) else trucks[0]
    trailer = next((v for v in trailers if v["id"] == body.trailer_id), None)
    if not trailer and sel and total_kg is not None and total_kg > (sel.get("payload_kg") or 0) and trailers:
        trailer = sorted(trailers, key=lambda v: float((v.get("length") or "0").split()[0] or 0))[-1]
        warnings.append("Trailer suggested because load exceeds truck payload — confirm the truck can tow it")
    fuel = None
    if sel and route_km is not None:
        load_factor = (total_kg / sel["payload_kg"]) if (total_kg and sel.get("payload_kg")) else 0.5
        cons = sel["consumption_min"] + (sel["consumption_max"] - sel["consumption_min"]) * min(max(load_factor, 0), 1)
        if trailer:
            cons *= 1.15
        need = round(route_km * cons / 100 * 1.1, 1)  # +10% reserve
        to_buy = max(round(need - (body.fuel_in_tank_l or 0), 1), 0)
        price = st.get("diesel_price") if diesel_price_is_current(st.get("diesel_price_date")) else None
        fuel = {"consumption_l_100km": round(cons, 1), "needed_l": need, "in_tank_l": body.fuel_in_tank_l, "to_give_l": to_buy,
                "price_per_l": price, "price_date": st.get("diesel_price_date"), "cost": round(to_buy * price, 2) if price else None}
        if not price:
            warnings.append("Current diesel price unavailable or outdated — check today's price before relying on the fuel cost")
    timing = None
    if route_km is not None:
        drive_h = route_km / float(st.get("avg_speed_kmh") or 60)
        stops_h = len(stops) * float(st.get("offload_minutes_per_stop") or 45) / 60
        dep = parse_dt(body.departure) if body.departure else local_now().replace(hour=8, minute=0, second=0, microsecond=0)
        ret = dep + timedelta(hours=drive_h + stops_h + 0.5)
        timing = {"drive_hours": round(drive_h, 1), "offload_hours": round(stops_h, 1), "departure": dep.isoformat(), "return_eta": ret.isoformat()}
        if ret.hour >= 17 or ret.date() > dep.date():
            warnings.append("Estimated return is after 17:00 — consider leaving earlier or splitting the trip")
    return {"stops": stops, "missing": missing, "warnings": warnings, "total_pieces": total_pieces, "total_kg": total_kg,
            "route_km": route_km, "vehicle": sel, "trailer": trailer, "fuel": fuel, "timing": timing,
            "note": "Distances, consumption and times are ESTIMATES based on configured values"}

@api.get("/attendance/summary")
async def attendance_summary(user=Depends(get_current_user)):
    week, month = period_starts()
    recs = await listall("attendance", {"date": {"$gte": min(week, month)}})
    emps = await listall("employees", {"active": True}, ("name", 1))
    return summarize_attendance_records(recs, emps, week, month, today_str())

# ---------------- Seeding ----------------
async def seed():
    admin_email = canonical_email(os.environ["ADMIN_EMAIL"])
    admin_pw = os.environ["ADMIN_PASSWORD"]
    existing_admin = await base_db.users.find_one({"email": admin_email}, {"_id": 0})
    if not existing_admin:
        await db.users.insert_one({"id": new_id(), "email": admin_email,
                                   "password_hash": hash_pw(admin_pw), "name": "Admin",
                                   "role": "admin", "created_at": now_iso()})

    for n in seed_data.CUSTOMERS:
        if not await db.customers.find_one({"name": n}):
            await db.customers.insert_one({"id": new_id(), "name": n, "phone": "", "email": "",
                                           "address": "", "city": "", "notes": "", "default_zone": 1,
                                           "payment_terms": "Due on Delivery", "active": True,
                                           "created_at": now_iso()})
    for p in seed_data.PRICES:
        if not await db.prices.find_one({"zone": p["zone"], "category": p["category"], "size": p["size"]}):
            await db.prices.insert_one({"id": new_id(), **p, "updated_at": now_iso(), "created_at": now_iso()})
    for s in seed_data.STOCK:
        if not await db.stock.find_one({"product": s["product"], "size": s["size"]}):
            await db.stock.insert_one({"id": new_id(), **s, "created_at": now_iso()})
    for d in seed_data.DRIVERS:
        if not await db.drivers.find_one({"name": d["name"]}):
            await db.drivers.insert_one({"id": new_id(), **d, "created_at": now_iso()})

    # fleet migration: rename first trailer, retire placeholder vehicles without history
    await db.vehicles.update_one({"name": "Trailer", "length": "9 m"}, {"$set": {"name": "Trailer (1)"}})
    for name in seed_data.RETIRED_PLACEHOLDERS:
        v = await db.vehicles.find_one({"name": name})
        if v:
            used = sum([await db[c].count_documents({"vehicle_id": v["id"]}) for c in ("vehicle_records", "spareparts", "orders", "deliveries", "expenses")])
            if used == 0:
                await db.vehicles.update_one({"id": v["id"]}, {"$set": {"active": False}})
    for v in seed_data.FLEET:
        if not await db.vehicles.find_one({"name": v["name"]}):
            await db.vehicles.insert_one({"id": new_id(), **v, "created_at": now_iso()})

    if await db.settings.count_documents({}) == 0:
        await db.settings.insert_one({**seed_data.DEFAULT_SETTINGS, "created_at": now_iso()})
    await db.vehicle_records.update_many({"status": "done"}, {"$set": {"status": "Done"}})
    # split generic Ribbon into Ribbon Black / Ribbon Pink
    if await db.prices.count_documents({
        "category": {"$in": ["Ribbon", "Ribbon Black & Pink"]}, "active": {"$ne": False},
    }):
        await db.prices.update_many(
            {"category": {"$in": ["Ribbon", "Ribbon Black & Pink"]}, "active": {"$ne": False}},
            {"$set": {"active": False, "migration_note": "Replaced by Ribbon Black / Ribbon Pink"}},
        )
        for p in seed_data.PRICES:
            if p["category"] in ("Ribbon Black", "Ribbon Pink") and not await db.prices.find_one({"zone": p["zone"], "category": p["category"], "size": p["size"]}):
                await db.prices.insert_one({"id": new_id(), **p, "updated_at": now_iso(), "created_at": now_iso()})
        await db.stock.update_many({"product": "Ribbon"}, {"$set": {"product": "Ribbon Pink"}})
        await db.stock.update_many({"product": "Black"}, {"$set": {"product": "Ribbon Black"}})
        await db.settings.update_one({"id": "singleton"}, {"$set": {"product_categories": seed_data.DEFAULT_SETTINGS["product_categories"]}})
    for v in seed_data.FLEET:
        if v.get("payload_kg"):
            await db.vehicles.update_one({"name": v["name"], "consumption_max": {"$exists": False}},
                                         {"$set": {k: v[k] for k in ("model", "consumption_min", "consumption_max", "payload_kg", "capacity")}})
    await db.vehicle_records.update_many({"status": "needed"}, {"$set": {"status": "Needed"}})
    year = local_today().year
    for key, coll in (("del", "deliveries"), ("ord", "orders")):
        if not await db.counters.find_one({"id": f"{key}-{year}"}):
            await db.counters.insert_one({"id": f"{key}-{year}", "seq": await db[coll].count_documents({})})

    for coll, keys, kw in (("payments", "idempotency_key", {"unique": True, "sparse": True}),
                           ("stock_movements", "dedupe_key", {"unique": True, "sparse": True}),
                           ("expenses", "source_key", {"unique": True, "sparse": True}),
                           ("monthly_business_purchase_occurrences", "source_key", {"unique": True}),
                           ("attendance", [("employee_id", 1), ("date", 1)], {"unique": True}),
                           ("piece_production", [("employee_id", 1), ("date", 1)], {"unique": True}),
                           ("prices", [("zone", 1), ("category", 1), ("size", 1)], {"unique": True}),
                           ("audit_log", [("entity", 1), ("entity_id", 1)], {})):
        try:
            await db[coll].create_index(keys, **kw)
        except Exception as e:
            logging.warning(f"Index on {coll} not created: {e}")

async def initialize_multi_company():
    for profile in COMPANY_PROFILES:
        await base_db.companies.update_one(
            {"id": profile["id"]},
            {"$setOnInsert": {**profile, "active": True, "created_at": now_iso()}},
            upsert=True,
        )

    owner_email = canonical_email(os.environ["ADMIN_EMAIL"])
    owner = await base_db.users.find_one({"email": owner_email}, {"_id": 0})
    if not owner:
        raise RuntimeError("Configured ADMIN_EMAIL account is missing; refusing multi-company migration")
    await base_db.users.update_one({"id": owner["id"]}, {"$set": {
        "role": "owner", "company_roles": {},
        "company_ids": [profile["id"] for profile in COMPANY_PROFILES], "active": True,
    }})

    users = await base_db.users.find({
        "id": {"$ne": owner["id"]}, "role": {"$ne": "owner"},
    }, {"_id": 0}).to_list(5000)
    for account in users:
        roles = account.get("company_roles") or {
            DEFAULT_COMPANY_ID: "admin" if account.get("role") == "admin" else "user"
        }
        profile_id = account.get("profile_id")
        is_legacy_profile_admin = (
            account.get("profile_login") == "user"
            and profile_id in {profile["id"] for profile in COMPANY_PROFILES}
            and roles.get(profile_id) != "owner"
        )
        if is_legacy_profile_admin:
            roles[profile_id] = "admin"
        updates = {
            "role": "user", "company_roles": roles,
            "company_ids": list(dict.fromkeys([*account.get("company_ids", []), *roles.keys()])),
            "active": account.get("active", True),
        }
        if is_legacy_profile_admin:
            updates["profile_login"] = "admin"
        await base_db.users.update_one({"id": account["id"]}, {"$set": updates})

    for profile in COMPANY_PROFILES:
        company_id = profile["id"]
        count = await base_db.users.count_documents({
            f"company_roles.{company_id}": "admin", "active": {"$ne": False},
        })
        await base_db.company_admin_counts.replace_one(
            {"_id": company_id}, {"_id": company_id, "count": count}, upsert=True,
        )

    for collection_name in await base_db.list_collection_names():
        if collection_name in GLOBAL_COLLECTIONS:
            continue
        await base_db[collection_name].update_many(
            {"company_id": {"$exists": False}},
            {"$set": {"company_id": DEFAULT_COMPANY_ID}},
        )
        await base_db[collection_name].create_index("company_id")
    for collection_name in ("invoices", "payments", "expenses"):
        await base_db[collection_name].create_index([("company_id", 1), ("date", 1)])
    await base_db.invoices.create_index(
        [("company_id", 1), ("idempotency_key", 1)],
        unique=True,
        partialFilterExpression={"idempotency_key": {"$type": "string"}},
        name="invoice_submission_once",
    )
    await base_db.invoice_share_links.create_index(
        "invoice_id", unique=True, name="invoice_share_once",
    )
    await base_db.invoice_share_links.create_index(
        "token_hash", unique=True, name="invoice_share_token_once",
    )
    await base_db.warehouse_report_share_links.create_index(
        [("warehouse_id", 1), ("warehouse_report_id", 1)],
        unique=True,
        name="warehouse_report_share_once",
    )
    await base_db.warehouse_report_share_links.create_index(
        "token_hash", unique=True, name="warehouse_report_share_token_once",
    )
    await ensure_performance_indexes(base_db)

    for company_id in ("iqfoam-manufactoring", "iqfoam-whole-sallers"):
        await initialize_empty_company(company_id)

    await base_db.product_identifications.create_index("product_id", unique=True)
    await base_db.product_identifications.create_index(
        [("company_id", 1), ("stock_id", 1)], unique=True
    )
    await base_db.product_identifications.create_index("ean13", unique=True, sparse=True)
    await base_db.product_identifications.create_index("sku", unique=True, sparse=True)
    await base_db.product_identifications.create_index(
        [("company_id", 1), ("category", 1), ("active", 1)]
    )
    await base_db.product_identifications.create_index(
        [("company_id", 1), ("density", 1), ("active", 1)]
    )
    await base_db.product_identifications.create_index("qr_payload", unique=True)
    await base_db.product_identifications.create_index("data_matrix_payload", unique=True)
    await base_db.product_scans.create_index("scan_id", unique=True, sparse=True)
    await base_db.product_scans.create_index([("company_id", 1), ("scanned_at", -1)])
    await base_db.product_scans.create_index([("company_id", 1), ("product_id", 1)])
    for profile in COMPANY_PROFILES:
        company_database = tenant_database(client, base_db, profile["id"])
        async for stock in company_database.stock.find({}, {"_id": 0}):
            await ensure_product_identification(stock, profile["id"], company_database.stock)

    for index_name, index in (await base_db.users.index_information()).items():
        if index_name != "_id_" and index.get("key") == [("username", 1)] and index.get("unique"):
            await base_db.users.drop_index(index_name)
    await base_db.users.create_index("username", sparse=True)
    await base_db.companies.create_index("id", unique=True)
    await asyncio.gather(
        base_db.users.create_index("id"),
        base_db.users.create_index("email"),
        base_db.user_sessions.create_index("id"),
        base_db.user_sessions.create_index("session_token"),
        base_db.user_devices.create_index([("user_id", 1), ("last_seen", -1)]),
    )
    await initialize_company_profile_users()

async def initialize_workflow_indexes():
    for profile in COMPANY_PROFILES:
        workflow_db = _workflow_database(profile["id"])
        await workflow_db.workflows.create_index([("company_id", 1), ("updated_at", -1)])
        await workflow_db.workflow_runs.create_index(
            [("company_id", 1), ("workflow_id", 1), ("event_id", 1)],
            unique=True,
            name="workflow_event_once",
        )
        await workflow_db.workflow_runs.create_index([("company_id", 1), ("started_at", -1)])
        await workflow_db.workflow_runs.create_index(
            [("company_id", 1), ("workflow_id", 1), ("started_at", -1)]
        )
        await workflow_db.workflow_artifacts.create_index(
            [("company_id", 1), ("created_at", -1)]
        )
        await workflow_db.workflow_artifacts.create_index(
            [("company_id", 1), ("type", 1), ("status", 1), ("created_at", -1)]
        )

async def initialize_company_profile_users():
    profiles = [
        ("iqfoam-manufactoring", "IQFOAM MANUFACTORING", "manufactoring@profiles.invalid", "INITIAL_MANUFACTURING_PASSWORD"),
        ("iqfoam-whole-sallers", "IQFOAM WHOLESALERS", "wholesallers@profiles.invalid", "INITIAL_WHOLESALER_PASSWORD"),
    ]
    for company_id, username, email, env_name in profiles:
        initial_password = os.environ.get(env_name)
        account = await base_db.users.find_one({"profile_id": company_id}, {"_id": 0})
        if not account:
            account = await base_db.users.find_one({"username": username}, {"_id": 0})
        if not account and company_id == "iqfoam-whole-sallers":
            account = await base_db.users.find_one({"username": "IQFOAM WHOLE SALLERS"}, {"_id": 0})
        if account:
            updates = {}
            if not account.get("profile_id"):
                updates["profile_id"] = company_id
            if company_id == "iqfoam-whole-sallers" and account.get("username") == "IQFOAM WHOLE SALLERS":
                updates["username"] = username
            if updates:
                await base_db.users.update_one({"id": account["id"]}, {"$set": updates})
            continue
        if not initial_password:
            logging.warning("Initial profile %s is waiting for a secure server-side password configuration", username)
            continue
        await base_db.users.insert_one({"id": new_id(), "username": username, "email": email,
            "name": username, "password_hash": hash_pw(initial_password), "role": "user",
            "company_roles": {company_id: "user"}, "company_ids": [company_id], "active": True,
            "auth_provider": "password", "profile_id": company_id, "created_at": now_iso()})

async def ensure_performance_indexes(database):
    indexes = {
        "customers": [
            [("name", 1), ("id", 1)],
            [("active", 1), ("name", 1), ("id", 1)],
        ],
        "invoices": [
            [("created_at", -1), ("id", 1)],
            [("customer_id", 1), ("created_at", -1)],
            [("invoice_type", 1), ("created_at", -1), ("id", 1)],
        ],
        "payments": [
            [("customer_id", 1), ("created_at", -1)],
            [("invoice_id", 1), ("created_at", -1)],
        ],
        "orders": [[("created_at", -1)], [("customer_id", 1), ("created_at", -1)]],
        "deliveries": [[("created_at", -1)], [("customer_id", 1), ("created_at", -1)]],
        "stock": [[("product", 1)]],
        "stock_movements": [
            [("stock_id", 1), ("created_at", -1)],
            [("invoice_id", 1), ("type", 1)],
        ],
        "production": [[("created_at", -1)]],
        "production_daily": [[("date", -1)]],
        "production_runs": [[("date", -1)]],
        "attendance": [[("date", 1)]],
        "piece_production": [[("date", 1)]],
        "employees": [[("name", 1)]],
        "drivers": [[("name", 1)]],
        "vehicles": [[("name", 1)]],
        "vehicle_licence_discs": [
            [("vehicle_id", 1), ("created_at", -1)],
            [("vehicle_id", 1), ("expiry_date", 1)],
            [("created_at", -1)],
        ],
        "intercompany_prices": [[("stock_id", 1)]],
        "intercompany_customer_mappings": [[("requesting_company_id", 1)]],
        "vehicle_records": [
            [("date", -1)],
            [("vehicle_id", 1), ("date", -1)],
            [("vehicle_id", 1), ("status", 1), ("type", 1)],
        ],
        "buyings": [[("date", -1)]],
        "grvs": [
            [("created_at", -1)],
            [("received_date", -1)],
            [("supplier_id", 1), ("received_date", -1)],
        ],
        "suppliers": [[("name", 1)]],
        "spareparts": [[("status", 1), ("created_at", -1)]],
        "monthly_business_purchases": [[("name", 1)]],
        "monthly_business_purchase_occurrences": [[("purchase_id", 1), ("month", -1)]],
    }
    semaphore = asyncio.Semaphore(4)

    async def create_collection_indexes(collection_name, definitions):
        async with semaphore:
            await database[collection_name].create_indexes([
                IndexModel([("company_id", 1), ("id", 1)]),
                *(
                    [IndexModel([("company_id", 1), ("grv_number", 1)], unique=True)]
                    if collection_name == "grvs" else []
                ),
                *(
                    [IndexModel([("source_buying_id", 1)], unique=True, sparse=True,
                                name="grv_source_buying_once")]
                    if collection_name == "grvs" else []
                ),
                *(
                    IndexModel([("company_id", 1), *definition])
                    for definition in definitions
                ),
            ])

    await asyncio.gather(*(
        create_collection_indexes(collection_name, definitions)
        for collection_name, definitions in indexes.items()
    ))

async def initialize_empty_company(company_id):
    company_db = tenant_database(client, base_db, company_id)
    invoice_details = COMPANY_INVOICE_DETAILS.get(company_id, {})
    if await company_db.settings.count_documents({}) == 0:
        await company_db.settings.insert_one({**seed_data.DEFAULT_SETTINGS, **invoice_details, "id": "singleton",
                                              "company_id": company_id, "created_at": now_iso()})
    elif invoice_details:
        await company_db.settings.update_one(
            {"id": "singleton", "company_name": seed_data.DEFAULT_SETTINGS["company_name"],
             "address": "", "telephone": ""},
            {"$set": invoice_details},
        )
    if uses_unified_price_list(company_id):
        settings = await company_db.settings.find_one({"id": "singleton"}, {"_id": 0}) or {}
        if settings.get("unified_price_list_version") != 2:
            for price in seed_data.IQFOAM_UNIFIED_PRICES:
                key = {"zone": 1, "category": price["category"], "size": price["size"]}
                if not await company_db.prices.find_one(key, {"_id": 1}):
                    await company_db.prices.insert_one({
                        "id": new_id(), **key, **price, "active": True,
                        "confirmed": price["price"] is not None, "company_id": company_id,
                        "created_at": now_iso(), "updated_at": now_iso(),
                    })
            await company_db.customers.update_many({}, {"$set": {"default_zone": 1}})
            await company_db.settings.update_one(
                {"id": "singleton"}, {"$set": {"unified_price_list_version": 2}}
            )

        existing_stock = await company_db.stock.find({}, {"_id": 0, "product": 1, "size": 1}).to_list(5000)
        stock_keys = {
            (str(item.get("product", "")).strip().casefold(), str(item.get("size", "")).strip().casefold())
            for item in existing_stock
        }
        for item in seed_data.STOCK:
            key = (item["product"].strip().casefold(), item["size"].strip().casefold())
            if key in stock_keys:
                continue
            await company_db.stock.insert_one({
                "id": new_id(), "product": item["product"], "size": item["size"],
                "opening": 0, "threshold": item.get("threshold", 0),
                "company_id": company_id, "created_at": now_iso(),
            })
            stock_keys.add(key)
    else:
        for price in seed_data.PRICES:
            key = {k: price[k] for k in ("zone", "category", "size")}
            if not await company_db.prices.find_one(key):
                await company_db.prices.insert_one({"id": new_id(), **price, "company_id": company_id,
                                                    "created_at": now_iso(), "updated_at": now_iso()})
    for coll, keys, options in (("payments", "idempotency_key", {"unique": True, "sparse": True}),
                                ("stock_movements", "dedupe_key", {"unique": True, "sparse": True}),
                                ("expenses", "source_key", {"unique": True, "sparse": True}),
                                ("monthly_business_purchase_occurrences", "source_key", {"unique": True}),
                                ("attendance", [("employee_id", 1), ("date", 1)], {"unique": True}),
                                ("piece_production", [("employee_id", 1), ("date", 1)], {"unique": True}),
                                ("prices", [("zone", 1), ("category", 1), ("size", 1)], {"unique": True}),
                                ("audit_log", [("entity", 1), ("entity_id", 1)], {})):
        await company_db[coll].create_index(keys, **options)
    if company_id == MANUFACTURING_COMPANY_ID:
        await company_db.production_block_records.create_index(
            "request_id",
            unique=True,
            partialFilterExpression={"request_id": {"$type": "string"}},
            name="block_production_request_once",
        )
    for coll in ("invoices", "payments", "expenses"):
        await company_db[coll].create_index([("company_id", 1), ("date", 1)])
    await company_db.invoices.create_index(
        "idempotency_key",
        unique=True,
        partialFilterExpression={"idempotency_key": {"$type": "string"}},
        name="invoice_submission_once",
    )
    await company_db.invoice_share_links.create_index(
        "invoice_id", unique=True, name="invoice_share_once",
    )
    await company_db.invoice_share_links.create_index(
        "token_hash", unique=True, name="invoice_share_token_once",
    )
    await company_db.warehouse_report_share_links.create_index(
        [("warehouse_id", 1), ("warehouse_report_id", 1)],
        unique=True,
        name="warehouse_report_share_once",
    )
    await company_db.warehouse_report_share_links.create_index(
        "token_hash", unique=True, name="warehouse_report_share_token_once",
    )
    await company_db.vehicle_licence_discs.create_index(
        [("vehicle_id", 1), ("expiry_date", 1)],
        unique=True,
        name="vehicle_licence_expiry_once",
    )
    await company_db.vehicles.create_index(
        "assigned_driver_id", unique=True, sparse=True, name="vehicle_driver_assignment_once",
    )
    await company_db.intercompany_prices.create_index(
        "stock_id", unique=True, name="intercompany_price_stock_once",
    )
    await company_db.intercompany_customer_mappings.create_index(
        "requesting_company_id", unique=True, name="intercompany_customer_mapping_once",
    )
    await company_db.salary_payments.create_index(
        [("employee_id", 1), ("payroll_key", 1)],
        unique=True,
        name="salary_payment_once",
    )
    await company_db.salary_payments.create_index(
        [("payment_date", -1)],
        name="salary_payment_date",
    )
    await ensure_performance_indexes(company_db)

@app.on_event("startup")
async def on_startup():
    global backup_scheduler_task, fleet_notification_scheduler_task
    await seed()
    await initialize_multi_company()
    await initialize_workflow_indexes()
    await base_db.notifications.create_index(
        [("company_id", 1), ("event_key", 1), ("recipient_user_id", 1)],
        unique=True,
        name="notification_event_recipient_once",
    )
    await base_db.notifications.create_index(
        [("company_id", 1), ("recipient_user_id", 1), ("created_at", -1)],
        name="notification_recipient_feed",
    )
    await base_db.intercompany_order_requests.create_index("id", unique=True)
    await base_db.interface_settings.create_index("id", unique=True)
    await base_db.intercompany_order_requests.create_index(
        [("requesting_company_id", 1), ("created_at", -1)],
        name="intercompany_requesting_feed",
    )
    await base_db.intercompany_order_requests.create_index(
        [("supplying_company_id", 1), ("created_at", -1)],
        name="intercompany_supplier_feed",
    )
    fleet_notification_scheduler_task = asyncio.create_task(
        scheduled_fleet_notification_loop()
    )
    status = backup_runtime_status()
    if status["configured"] and status["tools_available"]:
        backup_scheduler_task = asyncio.create_task(scheduled_backup_loop(
            mongo_url=mongo_url,
            database_names=backup_database_names(),
            configuration=backup_configuration(),
            local_timezone=TZ,
            lock_database=base_db,
        ))
    else:
        logging.warning(
            "Automated backups are not active; configure S3-compatible storage and MongoDB backup tools"
        )

app.include_router(api)
configured_cors_origins = [origin.strip() for origin in os.environ.get("CORS_ORIGINS", "*").split(",") if origin.strip()]
cors_origin_regex = r"https://[a-zA-Z0-9-]+(?:\.preview)?\.emergentagent\.com"
if "*" in configured_cors_origins:
    configured_cors_origins = ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000", "http://127.0.0.1:3001"]
app.add_middleware(CORSMiddleware, allow_credentials=True,
                   allow_origins=configured_cors_origins, allow_origin_regex=cors_origin_regex,
                   allow_methods=["*"], allow_headers=["*"])

@app.middleware("http")
async def reset_company_scope(request: Request, call_next):
    token = active_company_id.set(None)
    try:
        if (
            request.url.path.startswith("/api/workflow-builder")
            and request.method != "OPTIONS"
        ):
            try:
                require_global_owner(await get_current_user(request))
            except HTTPException as error:
                return JSONResponse(
                    status_code=error.status_code,
                    content={"detail": error.detail},
                )
        return await call_next(request)
    finally:
        active_company_id.reset(token)
logging.basicConfig(level=logging.INFO)

@app.on_event("shutdown")
async def shutdown_db_client():
    if fleet_notification_scheduler_task:
        fleet_notification_scheduler_task.cancel()
        try:
            await fleet_notification_scheduler_task
        except asyncio.CancelledError:
            pass
    if backup_scheduler_task:
        backup_scheduler_task.cancel()
        try:
            await backup_scheduler_task
        except asyncio.CancelledError:
            pass
    client.close()
