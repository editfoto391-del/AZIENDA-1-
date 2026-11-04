import "@/App.css";
import { Component, lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { ThemeProvider } from "next-themes";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import Layout from "@/components/Layout";
import { pageLoaders } from "@/lib/pageLoaders";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Layers } from "lucide-react";

const AuthCallback = lazy(() => import("@/pages/AuthCallback"));
const Login = lazy(() => import("@/pages/Login"));
const SharedInvoice = lazy(() => import("@/pages/SharedInvoice"));
const SharedWarehouseReport = lazy(() => import("@/pages/SharedWarehouseReport"));
const Dashboard = lazy(pageLoaders["/"]);
const Customers = lazy(pageLoaders["/customers"]);
const Suppliers = lazy(pageLoaders["/suppliers"]);
const ClientPayments = lazy(pageLoaders["/client-payments"]);
const ExpressClientPayments = lazy(pageLoaders["/express-client-payments"]);
const Buyings = lazy(pageLoaders["/buyings"]);
const Intercompany = lazy(pageLoaders["/intercompany"]);
const InvoiceList = lazy(pageLoaders["/invoices"]);
const InvoiceEditor = lazy(pageLoaders["/invoices/new"]);
const ExpressInvoiceList = lazy(pageLoaders["/express-invoices"]);
const ExpressInvoiceEditor = lazy(pageLoaders["/express-invoices/new"]);
const Orders = lazy(pageLoaders["/orders"]);
const Stock = lazy(pageLoaders["/stock"]);
const Production = lazy(pageLoaders["/production"]);
const Warehouses = lazy(pageLoaders["/warehouses"]);
const ChemicalStock = lazy(pageLoaders["/warehouses/chemical"]);
const ChemicalInventory = lazy(pageLoaders["/warehouses/chemical-inventory"]);
const CompanyInventory = lazy(pageLoaders["/company-inventory"]);
const Attendance = lazy(pageLoaders["/attendance"]);
const Fleet = lazy(pageLoaders["/fleet"]);
const Expenses = lazy(pageLoaders["/expenses"]);
const Costs = lazy(pageLoaders["/costs"]);
const GRV = lazy(pageLoaders["/grv"]);
const DailyReport = lazy(pageLoaders["/daily-report"]);
const Settings = lazy(pageLoaders["/settings"]);
const WorkflowBuilder = lazy(pageLoaders["/workflow-builder"]);

class AppErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error("Application error", error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="min-h-screen bg-slate-100 p-6">
        <section className="mx-auto mt-12 max-w-lg rounded-xl bg-white p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900">Something went wrong</h1>
          <p className="mt-2 text-sm text-slate-600">The page could not be displayed. Reload, or go back to the dashboard.</p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={() => window.location.reload()} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white">Reload page</button>
            <button type="button" onClick={() => window.location.replace("/")} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Dashboard</button>
          </div>
        </section>
      </main>
    );
  }
}

class SharedInvoiceErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="min-h-screen bg-slate-100 p-6">
          <section className="mx-auto mt-12 max-w-lg rounded-xl bg-white p-6 text-center shadow-sm">
            <h1 className="text-xl font-semibold text-slate-900">Invoice could not be displayed</h1>
            <p className="mt-2 text-sm text-slate-600">Reload the page or request a new invoice link.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white">
              Reload page
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

function Protected({ children }) {
  const { user, booting } = useAuth();
  const location = useLocation();
  if (booting || user === null) return <RouteLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.is_worker) {
    const warehousePath = location.pathname.match(/^\/warehouses\/([^/]+)/)?.[1];
    const warehouseSection = warehousePath === "chemical"
      ? user.company_id === "superiqfoam" ? "chemical-usage-log" : "warehouse-chemical"
      : warehousePath === "chemical-inventory"
        ? user.company_id === "superiqfoam" ? "chemicals-quantity" : "warehouse-chemical-inventory"
        : ["A", "B", "C"].includes(warehousePath) ? `warehouse-${warehousePath.toLowerCase()}`
          : null;
    const section = location.pathname.startsWith("/express-invoices") ? "express-invoices"
      : location.pathname.startsWith("/express-client-payments") ? "express-client-payments"
        : location.pathname.startsWith("/intercompany") ? "intercompany"
        : location.pathname.startsWith("/invoices") ? "invoices"
      : location.pathname.startsWith("/customers") ? "customers"
        : location.pathname.startsWith("/suppliers") ? "suppliers"
          : location.pathname.startsWith("/buyings") ? "buyings"
            : location.pathname.startsWith("/orders") ? "orders"
              : location.pathname.startsWith("/stock") ? "stock"
                : location.pathname.startsWith("/production") ? "production"
                    : location.pathname.startsWith("/company-inventory") ? "company-inventory"
                      : location.pathname.startsWith("/warehouses") ? warehouseSection
                  : location.pathname.startsWith("/attendance") ? "attendance"
                      : location.pathname.startsWith("/fleet") ? "fleet"
                        : location.pathname.startsWith("/expenses") ? "expenses"
                          : location.pathname.startsWith("/grv") ? "grv"
                          : location.pathname.startsWith("/costs") ? "costs"
                            : location.pathname.startsWith("/daily-report") ? "daily-report"
                              : location.pathname.startsWith("/client-payments") ? "client-payments"
                                : location.pathname.startsWith("/settings") ? "settings"
                                  : null;
    const allowedSections = user.allowed_sections || [];
    if (!section || !allowedSections.includes(section)) {
      const landingPath = [
        ["express-invoices", "/express-invoices"],
        ["express-client-payments", "/express-client-payments"],
        ["intercompany", "/intercompany"],
        ["invoices", "/invoices"],
        ["customers", "/customers"],
        ["suppliers", "/suppliers"],
        ["buyings", "/buyings"],
        ["orders", "/orders"],
        ["stock", "/stock"],
        ["company-inventory", "/company-inventory"],
        ["production", "/production"],
        ["chemicals-quantity", "/warehouses/chemical-inventory"],
        ["chemical-usage-log", "/warehouses/chemical"],
        ["warehouse-a", "/warehouses/A"],
        ["warehouse-b", "/warehouses/B"],
        ["warehouse-c", "/warehouses/C"],
        ["warehouse-chemical", "/warehouses/chemical"],
        ["warehouse-chemical-inventory", "/warehouses/chemical-inventory"],
        ["attendance", "/attendance"],
        ["fleet", "/fleet"],
        ["expenses", "/expenses"],
        ["grv", "/grv"],
        ["costs", "/costs"],
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

function GlobalOwnerOnly({ children }) {
  const { user, booting } = useAuth();
  if (booting || user === null) return <RouteLoading />;
  if (!user || !user.is_primary_owner || !user.is_owner || user.is_worker) {
    return <Navigate to="/" replace />;
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
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.65, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
        </motion.div>
      ) : (
        <motion.div
          key="welcome"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0, scale: 1.015 }}
          transition={{ duration: reduceMotion ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-0 z-[100] flex min-h-screen items-center justify-center overflow-hidden bg-[#091b17] px-5 py-10 text-white"
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_18%_18%,rgba(52,125,99,0.3),transparent_42%),radial-gradient(ellipse_at_82%_78%,rgba(180,151,81,0.18),transparent_40%)]" />
          <div className="relative w-full max-w-3xl">
            <AnimatePresence mode="wait" initial={false}>
              {stage === "choose" ? (
            <motion.section
              key="choose"
              initial={reduceMotion ? false : { opacity: 0, y: 20, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -12, scale: 0.99 }}
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
                      className="owner-welcome-card group flex min-h-24 w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.045] px-5 text-left shadow-[0_14px_40px_rgba(0,0,0,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
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
              initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 1.01 }}
              transition={{ duration: reduceMotion ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto flex max-w-lg flex-col items-center text-center"
            >
              <motion.div
                className="mb-7 flex h-20 w-20 items-center justify-center rounded-full border border-emerald-100/20 bg-white/[0.06]"
              >
                <motion.span
                  className="h-7 w-7 rounded-full border-2 border-emerald-100/25 border-t-emerald-100"
                  animate={reduceMotion ? undefined : { rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                />
              </motion.div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-100/65">SUPERIQFOAM</p>
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
          <Route path="/shared-invoice/:token" element={<SharedInvoiceErrorBoundary><Suspense fallback={<RouteLoading />}><SharedInvoice /></Suspense></SharedInvoiceErrorBoundary>} />
          <Route path="/shared-warehouse-report/:token" element={<Suspense fallback={<RouteLoading />}><SharedWarehouseReport /></Suspense>} />
          <Route element={<Protected><Layout /></Protected>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/suppliers" element={<Suppliers />} />
            <Route path="/client-payments" element={<ClientPayments />} />
            <Route path="/express-client-payments" element={<ExpressClientPayments express />} />
            <Route path="/buyings" element={<Buyings />} />
            <Route path="/intercompany" element={<Intercompany />} />
            <Route path="/invoices" element={<InvoiceList />} />
            <Route path="/invoices/new" element={<InvoiceEditor />} />
            <Route path="/invoices/:id" element={<InvoiceEditor />} />
            <Route path="/express-invoices" element={<ExpressInvoiceList express />} />
            <Route path="/express-invoices/new" element={<ExpressInvoiceEditor express />} />
            <Route path="/express-invoices/:id" element={<ExpressInvoiceEditor express />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/stock" element={<Stock />} />
            <Route path="/production" element={<Production />} />
            <Route path="/warehouses" element={<Warehouses />} />
            <Route path="/warehouses/chemical" element={<ChemicalStock />} />
            <Route path="/warehouses/chemical-inventory" element={<ChemicalInventory />} />
            <Route path="/company-inventory" element={<CompanyInventory />} />
            <Route path="/warehouses/:warehouseId" element={<Warehouses />} />
            <Route path="/attendance" element={<Attendance />} />
            <Route path="/fleet" element={<Fleet />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/grv" element={<GRV />} />
            <Route path="/daily-report" element={<DailyReport />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/workflow-builder" element={<GlobalOwnerOnly><WorkflowBuilder /></GlobalOwnerOnly>} />
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
    <ThemeProvider attribute="class" defaultTheme="light" forcedTheme="light" enableSystem={false} storageKey="erp-theme" disableTransitionOnChange>
      <AuthProvider>
        <Toaster position="top-right" richColors />
        <BrowserRouter>
          <AppErrorBoundary>
            <AppRouter />
          </AppErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
