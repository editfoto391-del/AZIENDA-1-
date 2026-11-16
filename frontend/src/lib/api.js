import axios from "axios";
import { GET_CACHE_MS, isCacheEntryFresh, pruneExpiredCache } from "./apiCache.mjs";
import { activeAuthToken } from "./activeAuthToken.mjs";

export const API_BASE_URL = import.meta.env.DEV
  ? "/__api"
  : "/api";
const BASE = API_BASE_URL;
const client = axios.create({ baseURL: BASE, withCredentials: true });
const pendingGets = new Map();
const cachedGets = new Map();
let supervisorPromptQueue = Promise.resolve();
let getCacheGeneration = 0;

function activeToken() {
  return activeAuthToken(localStorage, sessionStorage);
}

function requestSupervisorPassword() {
  const prompt = supervisorPromptQueue.then(() => new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent("erp:supervisor-password-required", { detail: { resolve } }));
  }));
  supervisorPromptQueue = prompt.then(() => undefined, () => undefined);
  return prompt;
}

const SUPERVISOR_ROUTES = [
  ["PUT", /^invoices\/[^/]+$/, "invoice_edit"],
  ["POST", /^prices$/, "price_edit"],
  ["PUT", /^prices\/[^/]+$/, "price_edit"],
  ["DELETE", /^prices\/[^/]+$/, "price_delete"],
  ["DELETE", /^customers\/[^/]+$/, "customer_delete"],
  ["DELETE", /^stock\/[^/]+$/, "stock_delete"],
  ["DELETE", /^payments\/[^/]+\/other-balance$/, "balance_payment_delete"],
];

const WORKER_SECTION_PREFIXES = [
  ["reports/costs", "costs"], ["simple-production", "production"],
  ["piece-production", "production"], ["cost-records", "costs"],
  ["intercompany", "orders"], ["employees", "attendance"],
  ["salaries", "attendance"], ["deliveries", "deliveries"],
  ["customers", "customers"], ["suppliers", "suppliers"], ["buyings", "buyings"],
  ["invoices", "invoices"], ["orders", "orders"], ["stock", "stock"],
  ["production", "production"], ["attendance", "attendance"], ["drivers", "settings"],
  ["vehicles", "fleet"], ["spareparts", "fleet"], ["fleet", "fleet"],
  ["expenses", "expenses"], ["grvs", "grv"], ["grv", "grv"],
  ["daily-report", "daily-report"], ["prices", "settings"], ["settings", "settings"],
  ["payments", "client-payments"], ["dashboard", "dashboard"], ["warehouses", "warehouses"],
];

function workerWriteActionForRequest(config) {
  const path = String(config.url || "").split("?")[0].replace(/^\/api\//, "").replace(/\/+$/, "");
  const method = String(config.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method) || /\/authorize(?:-|$)/.test(path)) return null;
  if (method === "POST" && path === "invoices/bulk-delete") return "invoices:delete";
  const section = /^invoices\/[^/]+\/payments$/.test(path)
    ? "client-payments"
    : WORKER_SECTION_PREFIXES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1];
  if (!section) return null;
  let operation = method === "DELETE" ? "delete" : ["PUT", "PATCH"].includes(method) ? "update" : "create";
  if (
    /^invoices\/[^/]+\/(issue|void|daily-report)$/.test(path)
    || /^payments\/[^/]+\/(reverse|daily-report)$/.test(path)
    || path === "daily-report"
  ) operation = "update";
  return `${section}:${operation}`;
}

function supervisorActionForRequest(config) {
  if (sessionStorage.getItem("erp-worker-access-session") === "true") {
    const workerAction = workerWriteActionForRequest(config);
    if (workerAction) {
      try {
        const [section, operation] = workerAction.split(":");
        const permissions = JSON.parse(sessionStorage.getItem("erp-worker-write-permissions") || "{}");
        if (
          permissions[section]?.[operation] === "supervisor"
          || (operation === "delete" && ["invoices", "express-invoices"].includes(section)
            && permissions[section]?.[operation] !== "deny")
        ) return workerAction;
      } catch {
        return null;
      }
    }
  }
  const path = String(config.url || "").split("?")[0].replace(/^\/api\//, "").replace(/\/+$/, "");
  const method = String(config.method || "GET").toUpperCase();
  return SUPERVISOR_ROUTES.find(([m, pattern]) => m === method && pattern.test(path))?.[2];
}

export function dispatchDataRefresh() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("erp:data-changed"));
  }
}

export function invalidateGetCache() {
  getCacheGeneration += 1;
  cachedGets.clear();
  pendingGets.clear();
  dispatchDataRefresh();
}

client.interceptors.request.use((cfg) => {
  const t = activeToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

client.interceptors.response.use(
  (r) => r,
  async (err) => {
    const isPublicInvoiceRequest = err.config?.url?.includes("/public/invoices/");
    if (err.response?.status === 401 && err.config?.url && !err.config.url.includes("/auth/") && !isPublicInvoiceRequest) {
      if (sessionStorage.getItem("erp-worker-access-session") === "true") {
        const workerEntry = sessionStorage.getItem("erp-worker-access-entry");
        sessionStorage.removeItem("erp-worker-session-token");
        sessionStorage.removeItem("erp-worker-access-session");
        sessionStorage.removeItem("erp-worker-write-permissions");
        if (workerEntry && window.location.pathname !== workerEntry) {
          window.location.href = workerEntry;
          return Promise.reject(err);
        }
      } else {
        localStorage.removeItem("token");
      }
      if (window.location.pathname !== "/login") window.location.href = "/login";
    }
    if (
      err.response?.status === 428
      && err.config
      && !err.config._supervisorRetried
      && !err.config.url.includes("/settings/supervisor-password/authorize")
      && String(err.response.data?.detail || "").toLowerCase().includes("supervisor")
    ) {
      const password = await requestSupervisorPassword();
      if (typeof password !== "string" || !password) {
        throw new Error("Change cancelled: the Supervisor Password is required.");
      }
      const action = supervisorActionForRequest(err.config);
      const authorization = await client.post("/settings/supervisor-password/authorize", {
        password,
        ...(action ? { action } : {}),
      });
      err.config._supervisorRetried = true;
      err.config.headers = {
        ...err.config.headers,
        "X-Supervisor-Authorization": authorization.data.authorization,
      };
      return client.request(err.config);
    }
    return Promise.reject(err);
  }
);

export const api = {
  get: (u, params) => {
    const token = activeToken() || "anonymous";
    const key = `${token}:${client.getUri({ url: u, params })}`;
    const cached = cachedGets.get(key);
    if (isCacheEntryFresh(cached, Date.now())) return Promise.resolve(cached.data);
    if (cached) cachedGets.delete(key);
    const pending = pendingGets.get(key);
    if (pending) return pending;

    const requestGeneration = getCacheGeneration;
    let request;
    request = client.get(u, { params }).then((r) => {
      if (requestGeneration === getCacheGeneration) {
        const cachedAt = Date.now();
        pruneExpiredCache(cachedGets, cachedAt);
        cachedGets.set(key, { data: r.data, expiresAt: cachedAt + GET_CACHE_MS });
      }
      return r.data;
    }).finally(() => {
      if (pendingGets.get(key) === request) pendingGets.delete(key);
    });
    pendingGets.set(key, request);
    return request;
  },
  getUncached: (u, params, config = {}) => client.get(u, { ...config, params }).then((r) => r.data),
  getBlob: (u) => client.get(u, { responseType: "blob" }).then((r) => r.data),
  post: (u, d) => client.post(u, d).then((r) => { invalidateGetCache(); return r.data; }),
  logout: () => {
    const token = activeToken();
    return client.post("/auth/logout", {}, {
      timeout: 5000,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    }).then((r) => { invalidateGetCache(); return r.data; });
  },
  put: (u, d) => client.put(u, d).then((r) => { invalidateGetCache(); return r.data; }),
  del: (u) => client.delete(u).then((r) => { invalidateGetCache(); return r.data; }),
  delWithData: (u, d) => client.delete(u, { data: d }).then((r) => { invalidateGetCache(); return r.data; }),
};

export function apiError(e) {
  const d = e.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join(" ");
  return e.message || "Something went wrong";
}

export default client;
