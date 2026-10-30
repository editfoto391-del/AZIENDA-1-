import "@/App.css";
import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import Layout from "@/components/Layout";
import { pageLoaders } from "@/lib/pageLoaders";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Layers } from "lucide-react";

const AuthCallback = lazy(() => import("@/pages/AuthCallback"));
const Login = lazy(() => import("@/pages/Login"));
const Dashboard = lazy(pageLoaders["/"]);
const Customers = lazy(pageLoaders["/customers"]);
const Suppliers = lazy(pageLoaders["/suppliers"]);
const ClientPayments = lazy(pageLoaders["/client-payments"]);
const Buyings = lazy(pageLoaders["/buyings"]);
const InvoiceList = lazy(pageLoaders["/invoices"]);
const InvoiceEditor = lazy(pageLoaders["/invoices/new"]);
const Orders = lazy(pageLoaders["/orders"]);
const Stock = lazy(pageLoaders["/stock"]);
const Production = lazy(pageLoaders["/production"]);
const Attendance = lazy(pageLoaders["/attendance"]);
const Deliveries = lazy(pageLoaders["/deliveries"]);
const Fleet = lazy(pageLoaders["/fleet"]);
const Expenses = lazy(pageLoaders["/expenses"]);
const Costs = lazy(pageLoaders["/costs"]);
const GRV = lazy(pageLoaders["/grv"]);
const DailyReport = lazy(pageLoaders["/daily-report"]);
const Settings = lazy(pageLoaders["/settings"]);

function Protected({ children }) {
  const { user, booting } = useAuth();
  const location = useLocation();
  if (booting || user === null) return <RouteLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.is_worker) {
    const section = location.pathname.startsWith("/invoices") ? "invoices"
      : location.pathname.startsWith("/customers") ? "customers"
        : location.pathname.startsWith("/suppliers") ? "suppliers"
          : location.pathname.startsWith("/buyings") ? "buyings"
            : location.pathname.startsWith("/orders") ? "orders"
              : location.pathname.startsWith("/stock") ? "stock"
                : location.pathname.startsWith("/production") ? "production"
                  : location.pathname.startsWith("/attendance") ? "attendance"
                    : location.pathname.startsWith("/deliveries") ? "deliveries"
                      : location.pathname.startsWith("/fleet") ? "fleet"
                        : location.pathname.startsWith("/expenses") ? "expenses"
                          : location.pathname.startsWith("/grv") ? "grv"
                          : location.pathname.startsWith("/costs") ? "costs"
                            : location.pathname.startsWith("/daily-report") ? "daily-report"
                              : location.pathname.startsWith("/client-payments") ? "client-payments"
                                : location.pathname.startsWith("/settings") ? "settings"
                                  : null;
    const allowedSections = user.allowed_sections || [];
    if (!section || (!allowedSections.includes(section) && !(section === "grv" && allowedSections.includes("costs")))) {
      const landingPath = [
        ["invoices", "/invoices"],
        ["customers", "/customers"],
        ["suppliers", "/suppliers"],
        ["buyings", "/buyings"],
        ["orders", "/orders"],
        ["stock", "/stock"],
        ["production", "/production"],
        ["attendance", "/attendance"],
        ["deliveries", "/deliveries"],
        ["fleet", "/fleet"],
        ["expenses", "/expenses"],
        ["grv", "/grv"],
        ["costs", "/grv"],
        ["daily-report", "/daily-report"],
        ["client-payments", "/client-payments"],
        ["settings", "/settings"],
      ].find(([allowed]) => allowedSections.includes(allowed))?.[1] || "/login";
      return <Navigate to={landingPath} replace />;
    }
  }
  if (user.is_owner && user.company_id === "superiqfoam") {
    return <OwnerWelcome key={localStorage.getItem("token")} user={user}>{children}</OwnerWelcome>;
  }
  return children;
}

function OwnerWelcome({ children, user }) {
  const reduceMotion = useReducedMotion();
  const token = localStorage.getItem("token") || user.id;
  const [stage, setStage] = useState(() =>
    sessionStorage.getItem("owner-welcome-session") === token ? "done" : "choose"
  );
  const [selectedName, setSelectedName] = useState("");

  useEffect(() => {
    if (stage !== "loading") return undefined;
    const timer = window.setTimeout(() => {
      sessionStorage.setItem("owner-welcome-session", token);
      setStage("done");
    }, reduceMotion ? 100 : 2500);
    return () => window.clearTimeout(timer);
  }, [reduceMotion, stage, token]);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {stage === "done" ? (
        <motion.div
          key="business"
          initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.995, filter: "blur(5px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: reduceMotion ? 0 : 0.65, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
        </motion.div>
      ) : (
        <motion.div
          key="welcome"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0, scale: 1.025, filter: "blur(8px)" }}
          transition={{ duration: reduceMotion ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-0 z-[100] flex min-h-screen items-center justify-center overflow-hidden bg-[#091b17] px-5 py-10 text-white"
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_18%_18%,rgba(52,125,99,0.3),transparent_42%),radial-gradient(ellipse_at_82%_78%,rgba(180,151,81,0.18),transparent_40%)]" />
          {!reduceMotion && <>
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute -left-24 top-1/4 h-72 w-72 rounded-full border border-emerald-100/10"
              animate={{ x: [0, 38, 0], y: [0, 24, 0], scale: [1, 1.14, 1], opacity: [0.2, 0.55, 0.2] }}
              transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-40 -right-20 h-[28rem] w-[28rem] rounded-full bg-emerald-300/[0.07] blur-3xl"
              animate={{ x: [0, -45, 0], y: [0, -30, 0], scale: [1, 1.12, 1] }}
              transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute right-[14%] top-[12%] h-40 w-40 rounded-full bg-amber-200/[0.06] blur-3xl"
              animate={{ x: [0, -24, 0], y: [0, 35, 0], opacity: [0.35, 0.8, 0.35] }}
              transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
            />
          </>}
          <div className="relative w-full max-w-3xl">
            <AnimatePresence mode="wait" initial={false}>
              {stage === "choose" ? (
            <motion.section
              key="choose"
              initial={reduceMotion ? false : { opacity: 0, y: 26, scale: 0.97, filter: "blur(7px)" }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -20, scale: 0.98, filter: "blur(5px)" }}
              transition={{ duration: reduceMotion ? 0 : 0.7, ease: [0.22, 1, 0.36, 1] }}
              className="text-center"
              aria-labelledby="owner-welcome-title"
            >
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, scale: 0.6, rotate: -14 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                transition={{ delay: reduceMotion ? 0 : 0.12, type: "spring", stiffness: 180, damping: 16 }}
                className="mx-auto mb-8 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-100/20 bg-white/[0.06] shadow-lg shadow-black/10"
              >
                <Layers className="text-emerald-100" size={27} aria-hidden="true" />
              </motion.div>
              <motion.p
                initial={reduceMotion ? false : { opacity: 0, y: 9 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: reduceMotion ? 0 : 0.2, duration: 0.5 }}
                className="text-xs font-semibold uppercase tracking-[0.28em] text-emerald-100/65"
              >SUPERIQFOAM · BUSINESS MANAGEMENT</motion.p>
              <motion.h1
                id="owner-welcome-title"
                initial={reduceMotion ? false : { opacity: 0, y: 18, letterSpacing: "0.14em" }}
                animate={{ opacity: 1, y: 0, letterSpacing: "-0.025em" }}
                transition={{ delay: reduceMotion ? 0 : 0.26, duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
                className="mt-4 font-display text-4xl font-normal sm:text-6xl"
              >HELLO, MR?</motion.h1>
              <motion.p
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: reduceMotion ? 0 : 0.36, duration: 0.5 }}
                className="mt-3 text-sm text-white/60 sm:text-base"
              >Choose your name to continue to your business profile.</motion.p>
              <div className="mx-auto mt-9 grid max-w-2xl gap-3 sm:grid-cols-3">
                {["Zeen", "Zuneer Khan", "Hassan Khan"].map((name, index) => (
                  <motion.div
                    key={name}
                    initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: reduceMotion ? 0 : 0.42 + index * 0.11, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                    className="h-full"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedName(name);
                        setStage("loading");
                      }}
                      className="owner-welcome-card group flex min-h-24 w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.045] px-5 text-left shadow-[0_14px_40px_rgba(0,0,0,0.12)] backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
                      data-testid={`owner-welcome-${name.toLowerCase().replaceAll(" ", "-")}`}
                    >
                      <span>
                        {name === "Zuneer Khan" && <span className="block text-[10px] font-semibold uppercase tracking-[0.19em] text-emerald-100/55">BOSS</span>}
                        {name === "Hassan Khan" && <span className="block text-[10px] font-semibold uppercase tracking-[0.19em] text-amber-100/65">BIG BOSS</span>}
                        <span className="mt-1 block text-lg font-medium text-white">{name}</span>
                      </span>
                      <ArrowRight size={18} className="text-emerald-100/45 transition-transform duration-150 ease-out group-hover:translate-x-1 group-hover:text-emerald-100" aria-hidden="true" />
                    </button>
                  </motion.div>
                ))}
              </div>
            </motion.section>
              ) : (
            <motion.section
              key="loading"
              role="status"
              aria-live="polite"
              initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 1.02, filter: "blur(4px)" }}
              transition={{ duration: reduceMotion ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto flex max-w-lg flex-col items-center text-center"
            >
              <motion.div
                className="mb-7 flex h-20 w-20 items-center justify-center rounded-full border border-emerald-100/20 bg-white/[0.06] shadow-[0_0_50px_rgba(167,243,208,0.09)]"
                animate={reduceMotion ? undefined : { boxShadow: ["0 0 28px rgba(167,243,208,0.05)", "0 0 58px rgba(167,243,208,0.2)", "0 0 28px rgba(167,243,208,0.05)"] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
              >
                <motion.span
                  className="h-7 w-7 rounded-full border-2 border-emerald-100/25 border-t-emerald-100"
                  animate={reduceMotion ? undefined : { rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                />
              </motion.div>
              <motion.p animate={reduceMotion ? undefined : { opacity: [0.55, 1, 0.55] }} transition={{ duration: 2.2, repeat: Infinity }} className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-100/65">SUPERIQFOAM</motion.p>
              <h2 className="mt-3 font-display text-3xl font-normal sm:text-4xl">Loading your business profile</h2>
              <p className="mt-3 text-sm font-medium tracking-[0.18em] text-emerald-100/75">(BOSS) ...</p>
              {selectedName && <motion.p initial={reduceMotion ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : 0.18 }} className="mt-5 text-sm text-white/50">Welcome, {selectedName}.</motion.p>}
              <div className="mt-9 h-px w-48 overflow-hidden rounded-full bg-white/10">
                <motion.div
                  className="h-full origin-left rounded-full bg-gradient-to-r from-emerald-200/40 via-emerald-100 to-amber-100"
                  initial={reduceMotion ? false : { scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: reduceMotion ? 0.1 : 2.2, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
            </motion.section>
          )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AppRouter() {
  const location = useLocation();
  if (location.hash?.includes("session_id=")) return <Suspense fallback={<RouteLoading />}><AuthCallback /></Suspense>;
  return (
        <Routes>
          <Route path="/login" element={<Suspense fallback={<RouteLoading />}><Login /></Suspense>} />
          <Route path="/worker-access/:token" element={<Suspense fallback={<RouteLoading />}><Login /></Suspense>} />
          <Route element={<Protected><Layout /></Protected>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/suppliers" element={<Suppliers />} />
            <Route path="/client-payments" element={<ClientPayments />} />
            <Route path="/buyings" element={<Buyings />} />
            <Route path="/invoices" element={<InvoiceList />} />
            <Route path="/invoices/new" element={<InvoiceEditor />} />
            <Route path="/invoices/:id" element={<InvoiceEditor />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/stock" element={<Stock />} />
            <Route path="/production" element={<Production />} />
            <Route path="/attendance" element={<Attendance />} />
            <Route path="/deliveries" element={<Deliveries />} />
            <Route path="/fleet" element={<Fleet />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/grv" element={<GRV />} />
            <Route path="/daily-report" element={<DailyReport />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
  );
}

function RouteLoading() {
  return <div className="route-loading" role="status" aria-live="polite">Loading workspace...</div>;
}

function App() {
  return (
    <AuthProvider>
      <Toaster position="top-right" richColors />
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
