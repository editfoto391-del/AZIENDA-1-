import { NavLink, useNavigate, Outlet, useLocation } from "react-router-dom";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  LayoutDashboard, ContactRound, ReceiptText, Package, Factory, CalendarCheck,
  Truck, Menu, X, LogOut, Search, Bell, Layers,
  ShoppingBag, HandCoins, CarFront, Receipt, ChartNoAxesCombined, ShoppingCart, ChevronDown, Building2, Handshake, Settings as Cog, ClipboardCheck, LockKeyhole,
  Warehouse, FlaskConical, Boxes,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { preloadPage } from "@/lib/pageLoaders";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { companyBrandName, companyProfileName, dedicatedCompanyDomain } from "@/lib/company";

const NAV_GROUPS = [
  { label: "Overview", items: [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true, section: "dashboard" },
  ] },
  { label: "Sales", items: [
    { to: "/customers", label: "Customers", icon: ContactRound, section: "customers" },
    { to: "/orders", label: "Orders", icon: ShoppingBag, section: "orders" },
    { to: "/invoices", label: "Invoice", icon: ReceiptText, section: "invoices" },
    { to: "/client-payments", label: "Clients payment and balances", icon: HandCoins, section: "client-payments" },
  ] },
  { label: "Express Websites - Old Invoices and Payments", collapsible: true, items: [
    { to: "/express-invoices", label: "Express Website Invoices", icon: ReceiptText, section: "express-invoices" },
    { to: "/express-client-payments", label: "Express Website Payments and Balances", icon: HandCoins, section: "express-client-payments" },
  ] },
  { label: "Purchasing", items: [
    { to: "/intercompany", label: "Intercompany", icon: Building2, section: "intercompany" },
    { to: "/grv", label: "GRV", icon: ClipboardCheck, section: "grv" },
    { to: "/suppliers", label: "Suppliers", icon: Handshake, section: "suppliers" },
    { to: "/buyings", label: "Buyings", icon: ShoppingCart, section: "buyings" },
  ] },
  { label: "Operations", items: [
    { to: "/stock", label: "Stock", icon: Package, section: "stock" },
    { to: "/fleet", label: "Fleet", icon: CarFront, section: "fleet" },
  ] },
  { label: "COMPANY INVENTORY", collapsible: true, items: [
    { to: "/company-inventory", label: "Company Inventory", icon: Boxes, section: "company-inventory" },
  ] },
  { label: "PRODUCTION", collapsible: true, companyIds: ["superiqfoam"], items: [
    { to: "/production", label: "Production", icon: Factory, section: "production" },
    { to: "/warehouses/chemical-inventory", label: "Chemicals Quantity", icon: FlaskConical, section: "chemicals-quantity", companyId: "superiqfoam" },
    { to: "/warehouses/chemical", label: "Chemical Usage Log", icon: FlaskConical, section: "chemical-usage-log", companyId: "superiqfoam" },
  ] },
  { label: "WAREHOUSES", collapsible: true, companyId: "iqfoam-manufactoring", items: [
    { to: "/warehouses/A", label: "Warehouse A", icon: Warehouse, section: "warehouse-a", warehouseId: "A" },
    { to: "/warehouses/B", label: "Warehouse B", icon: Warehouse, section: "warehouse-b", warehouseId: "B" },
    { to: "/warehouses/C", label: "Warehouse C", icon: Warehouse, section: "warehouse-c", warehouseId: "C" },
    { to: "/warehouses/chemical", label: "Chemical", icon: FlaskConical, section: "warehouse-chemical" },
    { to: "/warehouses/chemical-inventory", label: "Chemical Inventory", icon: Boxes, section: "warehouse-chemical-inventory" },
  ] },
  { label: "Finance & team", items: [
    { to: "/expenses", label: "Expenses", icon: Receipt, section: "expenses" },
    { to: "/daily-report", label: "Daily Report", icon: ChartNoAxesCombined, section: "daily-report" },
    { to: "/attendance", label: "Attendance", icon: CalendarCheck, section: "attendance" },
  ] },
  { label: "Administration", items: [
    { to: "/settings", label: "Settings", icon: Cog, section: "settings" },
  ] },
];

function WhatsAppFloatingButton() {
  return (
    <a href="https://web.whatsapp.com/" target="_blank" rel="noreferrer"
      aria-label="Open WhatsApp Web" title="Open WhatsApp Web"
      data-testid="whatsapp-floating-button"
      className="fixed left-5 top-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-105 hover:bg-[#20bd5a] focus:outline-none focus:ring-4 focus:ring-[#25D366]/30"
    >
      <svg viewBox="0 0 32 32" className="pointer-events-none h-8 w-8" aria-hidden="true">
        <path fill="currentColor" d="M16.02 3.2A12.7 12.7 0 0 0 5.08 22.35L3.3 28.8l6.6-1.73A12.8 12.8 0 1 0 16.02 3.2Zm0 23.3c-1.94 0-3.84-.52-5.5-1.5l-.4-.24-3.92 1.03 1.05-3.82-.26-.42a10.48 10.48 0 1 1 9.03 4.95Zm5.75-7.85c-.31-.16-1.84-.91-2.12-1.02-.28-.1-.49-.15-.69.16-.21.31-.8 1.02-.98 1.23-.18.21-.36.23-.67.08-.31-.16-1.3-.48-2.48-1.52-.92-.82-1.54-1.84-1.72-2.15-.18-.31-.02-.48.14-.64.14-.14.31-.36.46-.54.15-.18.21-.31.31-.52.1-.2.05-.39-.03-.54-.08-.15-.69-1.66-.94-2.28-.25-.6-.5-.51-.69-.52h-.59c-.2 0-.54.08-.82.39-.28.31-1.08 1.05-1.08 2.56s1.1 2.97 1.26 3.18c.15.2 2.17 3.32 5.25 4.66.73.32 1.3.51 1.74.65.73.23 1.4.2 1.93.12.59-.09 1.84-.75 2.1-1.48.26-.72.26-1.33.18-1.46-.08-.13-.28-.2-.59-.36Z" />
      </svg>
    </a>
  );
}

function SidebarContent({ onNav, companyName, companyId, user }) {
  const reduceMotion = useReducedMotion();
  const [openGroups, setOpenGroups] = useState({});
  const navigationId = (label) => ({
    WAREHOUSES: "warehouses-navigation",
    PRODUCTION: "production-navigation",
    "COMPANY INVENTORY": "company-inventory-navigation",
  }[label] || "old-express-navigation");
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      (!item.companyId || item.companyId === companyId)
      && (!user?.is_worker || !item.warehouseId || (user.warehouse_ids || []).includes(item.warehouseId))
      && (!item.globalOwnerOnly || (user?.is_primary_owner && user?.is_owner && !user?.is_worker))
      && (!user?.is_worker || user.allowed_sections?.includes(item.section))
    ),
  })).filter((group) => (!group.companyId || group.companyId === companyId) && (!group.companyIds || group.companyIds.includes(companyId)) && group.items.length);
  return (
    <>
      <div className="flex items-center gap-3 px-5 h-16 border-b border-white/10">
        <div className="h-10 w-10 rounded-lg border border-emerald-100/20 bg-[hsl(158_28%_15%)] flex items-center justify-center shrink-0">
          <Layers className="text-white" size={22} />
        </div>
        <div>
          <div className="text-white font-bold text-base font-display leading-tight">{companyName || "SUPER IQ-FOAM"}</div>
          <div className="text-emerald-100/55 text-[10px] font-semibold uppercase tracking-[0.16em]">Business Management</div>
        </div>
      </div>
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
        {navGroups.map((group) => {
          const expanded = !!openGroups[group.label];
          const groupNavId = navigationId(group.label);
          const items = group.items.map((n) => (
            user?.is_worker
              && !user.allowed_sections?.includes(n.section)
              ? <div key={n.to} aria-disabled="true" title="Your administrator has not granted access to this section" data-testid={`nav-locked-${n.label.toLowerCase()}`}
                className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium leading-tight text-emerald-50/35">
                <n.icon size={18} />
                <span className="flex-1">{n.label}</span>
                <LockKeyhole size={13} />
              </div>
              : <NavLink key={n.to} to={n.to} end={n.end} onClick={onNav} onMouseEnter={() => preloadPage(n.to)} onFocus={() => preloadPage(n.to)} onPointerDown={() => preloadPage(n.to)} data-testid={`nav-${n.label.toLowerCase()}`}
                className={({ isActive }) => `relative isolate flex min-h-9 items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs leading-tight font-medium transition-colors ${isActive ? "text-white" : "text-emerald-50/65 hover:bg-white/5 hover:text-white"}`}>
                {({ isActive }) => <>
                  {isActive && <motion.span layoutId={`active-nav-${onNav ? "mobile" : "desktop"}`} className="pointer-events-none absolute inset-0 z-0 rounded-md bg-white/10 shadow-[inset_2px_0_0_hsl(72_42%_65%)]" transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 38, mass: 0.5 }} />}
                  <n.icon className="relative z-10" size={18} />
                  <span className="relative z-10">{n.label}</span>
                </>}
              </NavLink>
          ));
          return (
          <div key={group.label} className="mb-2">
            {group.collapsible ? (
              <button
                type="button"
                onClick={() => setOpenGroups((current) => ({ ...current, [group.label]: !current[group.label] }))}
                aria-expanded={expanded}
                aria-controls={groupNavId}
                data-testid={`${groupNavId}-toggle`}
                className="flex w-full items-center justify-between px-3 pt-3 pb-1 text-left text-[9px] font-bold uppercase tracking-[0.14em] text-yellow-300 hover:text-yellow-200"
              >
                <span>{group.label}</span>
                <ChevronDown size={13} className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
            ) : (
              <p className="px-3 pt-3 pb-1 text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-100/40">{group.label}</p>
            )}
            {group.collapsible ? (
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    id={groupNavId}
                    initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: "easeInOut" }}
                    style={{ overflow: "hidden" }}
                  >
                    {items}
                  </motion.div>
                )}
              </AnimatePresence>
            ) : <div>{items}</div>}
          </div>
        );})}
      </nav>
    </>
  );
}

function AnimatedOutlet() {
  const location = useLocation();
  return <div key={location.pathname} className="app-page-enter"><Outlet /></div>;
}

export default function Layout() {
  const { user, logout, switchCompany } = useAuth();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [switching, setSwitching] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [dismissingNotificationIds, setDismissingNotificationIds] = useState([]);
  const nav = useNavigate();
  const dedicatedDomain = dedicatedCompanyDomain();

  useEffect(() => { api.get("/companies/profiles").then(setProfiles).catch(() => {}); }, []);
  const loadNotifications = async (uncached = false) => {
    try {
      const response = await (uncached ? api.getUncached("/notifications") : api.get("/notifications"));
      setNotifications(response.items || []);
      setUnreadNotifications(response.unread || 0);
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  useEffect(() => { if (user?.company_id) loadNotifications(); }, [user?.company_id]);
  const dismissNotification = async (event, notification) => {
    event.stopPropagation();
    if (dismissingNotificationIds.includes(notification.id)) return;
    setDismissingNotificationIds((current) => [...current, notification.id]);
    try {
      await api.post(`/notifications/${notification.id}/dismiss`, {
        request_id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${notification.id}`,
      });
      await loadNotifications(true);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setDismissingNotificationIds((current) => current.filter((id) => id !== notification.id));
    }
  };
  const openNotification = async (notification) => {
    setNotificationsOpen(false);
    try {
      await api.post(`/notifications/${notification.id}/read`, {});
      if (notification.action_path) nav(notification.action_path);
      await loadNotifications(true);
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const availableProfiles = profiles.filter((profile) =>
    user?.company_ids?.includes(profile.id)
    && (!dedicatedDomain || user?.is_worker || user?.can_switch_company || profile.id === dedicatedDomain.companyId)
  );
  const activeProfile = availableProfiles.find((profile) => profile.id === user?.company_id);
  const activeBrandName = companyBrandName(activeProfile?.id);
  const changeCompany = async (companyId) => {
    if (!companyId || companyId === user?.company_id) return;
    setSwitching(true);
    try { await switchCompany(companyId); }
    catch (e) { toast.error(apiError(e)); setSwitching(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="no-print hidden lg:flex fixed inset-y-0 left-0 w-64 flex-col bg-[hsl(222_47%_11%)] z-30">
        <SidebarContent companyName={activeBrandName} companyId={user?.company_id} user={user} />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence initial={false}>
        {open && (
        <motion.div key="mobile-navigation" className="lg:hidden fixed inset-0 z-50 flex" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}>
          <motion.div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <motion.aside className="mobile-nav-panel liquid-glass-dark relative flex w-[min(18rem,calc(100vw-2.5rem))] flex-col bg-[hsl(222_47%_11%)]" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }} initial={reduceMotion ? false : { x: -36, opacity: 0.85 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.7 }}>
            <button className="absolute right-3 top-3 rounded-full p-2 text-slate-300 hover:bg-white/10" onClick={() => setOpen(false)} aria-label="Close navigation">
              <X size={22} />
            </button>
            <SidebarContent onNav={() => setOpen(false)} companyName={activeBrandName} companyId={user?.company_id} user={user} />
          </motion.aside>
        </motion.div>
        )}
      </AnimatePresence>

      <div className="lg:pl-64 print:pl-0">
        {/* Topbar */}
        <header className="mobile-topbar no-print liquid-glass-surface sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-white/70 px-3 sm:gap-4 sm:px-6">
          <motion.button whileHover={reduceMotion ? undefined : { scale: 1.04, rotate: 0.5 }} whileTap={reduceMotion ? undefined : { scale: 0.96 }} transition={{ type: "spring", stiffness: 440, damping: 24 }} className="lg:hidden rounded-full p-2 text-slate-600 hover:bg-white/40" onClick={() => setOpen(true)} aria-label="Open navigation" data-testid="menu-toggle">
            <Menu size={22} />
          </motion.button>
          <div className="flex-1 max-w-md hidden sm:block">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                data-testid="global-search"
                placeholder="Search invoices, customers..."
                className="w-full rounded-lg bg-slate-100 border border-transparent pl-9 pr-3 py-2 text-sm outline-none focus:border-primary focus:bg-white"
                onKeyDown={(e) => { if (e.key === "Enter" && e.target.value) nav(`/invoices?q=${encodeURIComponent(e.target.value)}`); }}
              />
            </div>
          </div>
          <div className="flex-1 sm:hidden" />
          {user?.can_switch_company && availableProfiles.length > 1 && (
            <div className="relative" onMouseEnter={() => setProfileMenuOpen(true)} onMouseLeave={() => setProfileMenuOpen(false)}>
              <button
                type="button"
                onClick={() => setProfileMenuOpen((current) => !current)}
                onFocus={() => setProfileMenuOpen(true)}
                disabled={switching}
                aria-expanded={profileMenuOpen}
                aria-haspopup="menu"
                data-testid="company-profile-menu"
                className="flex max-w-28 items-center gap-1.5 rounded-md border border-border bg-white px-2 py-2 text-left text-xs font-semibold text-slate-700 hover:border-primary/50 disabled:opacity-60 sm:max-w-56 sm:gap-2"
              >
                <Building2 size={15} className="shrink-0 text-primary" />
                <span className="truncate">{companyProfileName(activeProfile?.id) || "Company"}</span>
                <ChevronDown size={14} className={`shrink-0 transition-transform ${profileMenuOpen ? "rotate-180" : ""}`} />
              </button>
              <AnimatePresence>
                {profileMenuOpen && (
                  <motion.div
                    role="menu"
                    initial={reduceMotion ? false : { opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}
                    className="absolute right-0 top-full z-40 w-64 overflow-hidden rounded-lg border border-border bg-white py-1 shadow-xl"
                  >
                    {availableProfiles.filter((profile) => profile.id !== user.company_id).map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        role="menuitem"
                        disabled={switching}
                        onClick={() => {
                          setProfileMenuOpen(false);
                          changeCompany(profile.id);
                        }}
                        data-testid={`company-profile-option-${profile.id}`}
                        className="block w-full px-3 py-2.5 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 hover:text-primary disabled:opacity-60"
                      >
                        {companyProfileName(profile.id)}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
          <div className="relative">
            <motion.button
              type="button"
              whileHover={reduceMotion ? undefined : { scale: 1.06, y: -1 }}
              whileTap={reduceMotion ? undefined : { scale: 0.96 }}
              transition={{ type: "spring", stiffness: 480, damping: 24 }}
              onClick={() => {
                const nextOpen = !notificationsOpen;
                setNotificationsOpen(nextOpen);
                if (nextOpen) loadNotifications(true);
              }}
              aria-expanded={notificationsOpen}
              aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ""}`}
              className="relative rounded-full p-2 text-slate-500 hover:text-slate-800 hover:bg-white/40"
              data-testid="notifications-btn"
            >
              <Bell size={20} />
              {unreadNotifications > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-4 text-white" data-testid="notification-unread-count">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}
            </motion.button>
            {notificationsOpen && <div className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl" role="dialog" aria-label="Notifications">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <h2 className="font-bold text-slate-900">Notifications</h2>
                <button type="button" onClick={() => setNotificationsOpen(false)} className="text-xs font-semibold text-slate-500 hover:text-slate-900">Close</button>
              </div>
              <div className="max-h-[min(65vh,28rem)] overflow-y-auto">
                {notifications.length === 0 ? <p className="px-4 py-7 text-center text-sm text-slate-500">You are all caught up.</p> : notifications.map((notification) => (
                  <div key={notification.id} className={`border-b border-slate-100 px-4 py-3 ${notification.read ? "" : "bg-blue-50/50"}`} data-testid={`notification-${notification.id}`}>
                    <button type="button" onClick={() => openNotification(notification)} className="block w-full text-left">
                      <p className="text-sm font-bold text-slate-900">{notification.title}</p>
                      <p className="mt-1 text-xs text-slate-600">{notification.message}</p>
                    </button>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] text-slate-400">{notification.dismiss_count === 1 ? "Reminder will return in the next daily cycle" : notification.type === "fleet_licence_expiry" ? "Fleet alert" : "ERP alert"}</span>
                      <button type="button" onClick={(event) => dismissNotification(event, notification)} disabled={dismissingNotificationIds.includes(notification.id)} className="text-xs font-semibold text-slate-500 hover:text-red-600 disabled:opacity-50" data-testid={`dismiss-notification-${notification.id}`}>Dismiss</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>}
          </div>
          <div className="flex items-center gap-3">
            <motion.div whileHover={reduceMotion ? undefined : { scale: 1.05, y: -1 }} whileTap={reduceMotion ? undefined : { scale: 0.98 }} transition={{ type: "spring", stiffness: 500, damping: 22 }} className="h-9 w-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
              {(user?.name || "A")[0]}
            </motion.div>
            <div className="hidden sm:block leading-tight">
              <div className="text-sm font-semibold text-slate-800">{user?.name || "Admin"}</div>
              <div className="text-[11px] text-slate-500">{user?.is_worker ? user.worker_role || "Worker" : user?.is_owner || user?.is_company_owner ? "Owner" : user?.is_admin || user?.role === "admin" ? "Administrator" : "Team member"}</div>
            </div>
            {!user?.is_worker && !dedicatedDomain && (
              <motion.button type="button" whileHover={reduceMotion ? undefined : { x: -1, scale: 1.04 }} whileTap={reduceMotion ? undefined : { scale: 0.97 }} transition={{ type: "spring", stiffness: 500, damping: 22 }} onClick={() => { setLoggingOut(true); logout(); }} disabled={loggingOut} aria-label="Log out" title="Log out" data-testid="logout-btn" className="inline-flex items-center gap-1.5 rounded-full px-2 py-2 text-slate-500 hover:text-red-600 hover:bg-red-50 ml-1 disabled:opacity-60">
                <LogOut size={18} />
                <span className="hidden text-xs font-semibold sm:inline">{loggingOut ? "Logging out…" : "Log out"}</span>
              </motion.button>
            )}
          </div>
        </header>

        <main className="min-w-0 p-3 sm:p-6 lg:p-8 max-w-[1500px] mx-auto">
          <Suspense fallback={<div className="text-slate-400">Loading...</div>}>
            <AnimatedOutlet />
          </Suspense>
        </main>
      </div>
      {(user?.is_admin || user?.role === "admin") && <WhatsAppFloatingButton />}
    </div>
  );
}
