import { NavLink, useNavigate, Outlet, useLocation } from "react-router-dom";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  LayoutDashboard, Users, FileText, Boxes, Factory, CalendarCheck,
  Truck, Menu, X, LogOut, Search, Bell, Layers,
  ClipboardList, Banknote, Wrench, Wallet, ShoppingCart, ChevronDown, Building2, Settings as Cog, Calculator, LockKeyhole,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { preloadPage } from "@/lib/pageLoaders";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { companyBrandName, companyProfileName } from "@/lib/company";

const NAV_GROUPS = [
  { label: "Overview", items: [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true, section: "dashboard" },
  ] },
  { label: "Sales", items: [
    { to: "/customers", label: "Customers", icon: Users, section: "customers" },
    { to: "/orders", label: "Orders", icon: ClipboardList, section: "orders" },
    { to: "/invoices", label: "Invoice", icon: FileText, section: "invoices" },
    { to: "/client-payments", label: "Clients payment and balances", icon: Wallet, section: "client-payments" },
  ] },
  { label: "Fulfilment", items: [
    { to: "/deliveries", label: "Deliveries", icon: Truck, section: "deliveries" },
  ] },
  { label: "Purchasing", items: [
    { to: "/buyings", label: "Buyings", icon: ShoppingCart, section: "buyings" },
    { to: "/suppliers", label: "Suppliers", icon: Building2, section: "suppliers" },
  ] },
  { label: "Operations", items: [
    { to: "/stock", label: "Stock", icon: Boxes, section: "stock" },
    { to: "/production", label: "Production", icon: Factory, section: "production" },
    { to: "/fleet", label: "Fleet", icon: Wrench, section: "fleet" },
  ] },
  { label: "Finance & team", items: [
    { to: "/costs", label: "Costs", icon: Calculator, section: "costs" },
    { to: "/expenses", label: "Expenses", icon: Banknote, section: "expenses" },
    { to: "/daily-report", label: "Daily Report", icon: FileText, section: "daily-report" },
    { to: "/attendance", label: "Attendance", icon: CalendarCheck, section: "attendance" },
  ] },
  { label: "Administration", items: [
    { to: "/settings", label: "Settings", icon: Cog, section: "settings" },
  ] },
];

const WHATSAPP_POSITION_KEY = "whatsapp-floating-position";
const WHATSAPP_BUTTON_SIZE = 56;
const WHATSAPP_EDGE_GAP = 8;

function clampWhatsAppPosition(position) {
  return {
    x: Math.max(WHATSAPP_EDGE_GAP, Math.min(position.x, window.innerWidth - WHATSAPP_BUTTON_SIZE - WHATSAPP_EDGE_GAP)),
    y: Math.max(WHATSAPP_EDGE_GAP, Math.min(position.y, window.innerHeight - WHATSAPP_BUTTON_SIZE - WHATSAPP_EDGE_GAP)),
  };
}

function WhatsAppFloatingButton() {
  const [position, setPosition] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(WHATSAPP_POSITION_KEY) || "null");
      return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? clampWhatsAppPosition(saved)
        : null;
    } catch {
      return null;
    }
  });
  const drag = useRef(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const keepInViewport = () => {
      setPosition((current) => current ? clampWhatsAppPosition(current) : current);
    };
    window.addEventListener("resize", keepInViewport);
    return () => window.removeEventListener("resize", keepInViewport);
  }, []);

  const startDrag = (event) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      position: { x: rect.left, y: rect.top },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < 4) return;
    active.moved = true;
    active.position = clampWhatsAppPosition({
      x: active.originX + dx,
      y: active.originY + dy,
    });
    setPosition(active.position);
  };

  const endDrag = (event) => {
    moveDrag(event);
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.moved) {
      suppressClick.current = true;
      try {
        localStorage.setItem(WHATSAPP_POSITION_KEY, JSON.stringify(active.position));
      } catch {
        toast.error("Could not save the WhatsApp button position");
      }
    }
    drag.current = null;
  };

  return (
    <a href="https://web.whatsapp.com/" target="_blank" rel="noreferrer"
      aria-label="Open WhatsApp Web" title="Drag to move · click to open WhatsApp Web"
      data-testid="whatsapp-floating-button"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(event) => {
        if (!suppressClick.current) return;
        event.preventDefault();
        suppressClick.current = false;
      }}
      style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}
      className={`fixed z-40 flex h-14 w-14 touch-none items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-105 hover:bg-[#20bd5a] focus:outline-none focus:ring-4 focus:ring-[#25D366]/30 ${position ? "" : "right-5 bottom-5"} cursor-grab active:cursor-grabbing`}
    >
      <svg viewBox="0 0 32 32" className="pointer-events-none h-8 w-8" aria-hidden="true">
        <path fill="currentColor" d="M16.02 3.2A12.7 12.7 0 0 0 5.08 22.35L3.3 28.8l6.6-1.73A12.8 12.8 0 1 0 16.02 3.2Zm0 23.3c-1.94 0-3.84-.52-5.5-1.5l-.4-.24-3.92 1.03 1.05-3.82-.26-.42a10.48 10.48 0 1 1 9.03 4.95Zm5.75-7.85c-.31-.16-1.84-.91-2.12-1.02-.28-.1-.49-.15-.69.16-.21.31-.8 1.02-.98 1.23-.18.21-.36.23-.67.08-.31-.16-1.3-.48-2.48-1.52-.92-.82-1.54-1.84-1.72-2.15-.18-.31-.02-.48.14-.64.14-.14.31-.36.46-.54.15-.18.21-.31.31-.52.1-.2.05-.39-.03-.54-.08-.15-.69-1.66-.94-2.28-.25-.6-.5-.51-.69-.52h-.59c-.2 0-.54.08-.82.39-.28.31-1.08 1.05-1.08 2.56s1.1 2.97 1.26 3.18c.15.2 2.17 3.32 5.25 4.66.73.32 1.3.51 1.74.65.73.23 1.4.2 1.93.12.59-.09 1.84-.75 2.1-1.48.26-.72.26-1.33.18-1.46-.08-.13-.28-.2-.59-.36Z" />
      </svg>
    </a>
  );
}

function SidebarContent({ onNav, companyName, companyId, user }) {
  const reduceMotion = useReducedMotion();
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.companyId || item.companyId === companyId),
  })).filter((group) => group.items.length);
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
        {navGroups.map((group) => (
          <div key={group.label} className="mb-2">
            <p className="px-3 pt-3 pb-1 text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-100/40">{group.label}</p>
            {group.items.map((n) => (
              user?.is_worker && !user.allowed_sections?.includes(n.section)
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
            ))}
          </div>
        ))}
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
  const [profiles, setProfiles] = useState([]);
  const [switching, setSwitching] = useState(false);
  const nav = useNavigate();

  useEffect(() => { api.get("/companies/profiles").then(setProfiles).catch(() => {}); }, []);
  const availableProfiles = profiles.filter((profile) => user?.company_ids?.includes(profile.id));
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
          <motion.aside className="liquid-glass-dark relative w-64 flex flex-col bg-[hsl(222_47%_11%)]" initial={reduceMotion ? false : { x: -36, opacity: 0.85 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.7 }}>
            <button className="absolute top-5 right-4 text-slate-500" onClick={() => setOpen(false)} aria-label="Close navigation">
              <X size={22} />
            </button>
            <SidebarContent onNav={() => setOpen(false)} companyName={activeBrandName} companyId={user?.company_id} user={user} />
          </motion.aside>
        </motion.div>
        )}
      </AnimatePresence>

      <div className="lg:pl-64 print:pl-0">
        {/* Topbar */}
        <header className="no-print liquid-glass-surface sticky top-0 z-20 h-16 border-b border-white/70 flex items-center gap-4 px-4 sm:px-6">
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
          {user?.is_owner && availableProfiles.length > 1 && (
            <div className="relative" onMouseEnter={() => setProfileMenuOpen(true)} onMouseLeave={() => setProfileMenuOpen(false)}>
              <button
                type="button"
                onClick={() => setProfileMenuOpen((current) => !current)}
                onFocus={() => setProfileMenuOpen(true)}
                disabled={switching}
                aria-expanded={profileMenuOpen}
                aria-haspopup="menu"
                data-testid="company-profile-menu"
                className="flex max-w-36 sm:max-w-56 items-center gap-2 rounded-md border border-border bg-white px-2 py-2 text-left text-xs font-semibold text-slate-700 hover:border-primary/50 disabled:opacity-60"
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
          <motion.button whileHover={reduceMotion ? undefined : { scale: 1.06, y: -1 }} whileTap={reduceMotion ? undefined : { scale: 0.96 }} transition={{ type: "spring", stiffness: 480, damping: 24 }} className="relative rounded-full p-2 text-slate-500 hover:text-slate-800 hover:bg-white/40" data-testid="notifications-btn">
            <Bell size={20} />
          </motion.button>
          <div className="flex items-center gap-3">
            <motion.div whileHover={reduceMotion ? undefined : { scale: 1.05, y: -1 }} whileTap={reduceMotion ? undefined : { scale: 0.98 }} transition={{ type: "spring", stiffness: 500, damping: 22 }} className="h-9 w-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
              {(user?.name || "A")[0]}
            </motion.div>
            <div className="hidden sm:block leading-tight">
              <div className="text-sm font-semibold text-slate-800">{user?.name || "Admin"}</div>
              <div className="text-[11px] text-slate-500">{user?.is_worker ? user.worker_role || "Worker" : user?.is_owner ? "Owner" : user?.is_admin || user?.role === "admin" ? "Administrator" : "Team member"}</div>
            </div>
            <motion.button whileHover={reduceMotion ? undefined : { x: -1, scale: 1.04 }} whileTap={reduceMotion ? undefined : { scale: 0.97 }} transition={{ type: "spring", stiffness: 500, damping: 22 }} onClick={logout} data-testid="logout-btn" className="rounded-full p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 ml-1">
              <LogOut size={18} />
            </motion.button>
          </div>
        </header>

        <main className="p-4 sm:p-6 lg:p-8 max-w-[1500px] mx-auto">
          <Suspense fallback={<div className="text-slate-400">Loading...</div>}>
            <AnimatedOutlet />
          </Suspense>
        </main>
      </div>
      {(user?.is_admin || user?.role === "admin") && <WhatsAppFloatingButton />}
    </div>
  );
}
