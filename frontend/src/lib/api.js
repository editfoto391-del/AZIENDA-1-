import axios from "axios";

const BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;
const client = axios.create({ baseURL: BASE, withCredentials: true });
const pendingGets = new Map();
const cachedGets = new Map();
const GET_CACHE_MS = 30_000;

export function invalidateGetCache() {
  cachedGets.clear();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("erp:data-changed"));
  }
}

client.interceptors.request.use((cfg) => {
  const t = localStorage.getItem("token");
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

client.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && !err.config.url.includes("/auth/")) {
      localStorage.removeItem("token");
      if (window.location.pathname !== "/login") window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export const api = {
  get: (u, params) => {
    const token = localStorage.getItem("token") || "anonymous";
    const key = `${token}:${client.getUri({ url: u, params })}`;
    const cached = cachedGets.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    if (cached) cachedGets.delete(key);
    const pending = pendingGets.get(key);
    if (pending) return pending;

    let request;
    request = client.get(u, { params }).then((r) => {
      cachedGets.set(key, { data: r.data, expiresAt: Date.now() + GET_CACHE_MS });
      return r.data;
    }).finally(() => {
      if (pendingGets.get(key) === request) pendingGets.delete(key);
    });
    pendingGets.set(key, request);
    return request;
  },
  getUncached: (u, params) => client.get(u, { params }).then((r) => r.data),
  post: (u, d) => client.post(u, d).then((r) => { invalidateGetCache(); return r.data; }),
  put: (u, d) => client.put(u, d).then((r) => { invalidateGetCache(); return r.data; }),
  del: (u) => client.delete(u).then((r) => { invalidateGetCache(); return r.data; }),
};

export function apiError(e) {
  const d = e.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join(" ");
  return e.message || "Something went wrong";
}

export default client;
