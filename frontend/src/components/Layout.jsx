import { NavLink, useNavigate, Outlet, useLocation } from "react-router-dom";
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  Menu, X, LogOut, Search, Bell, ChevronDown, Building2, LockKeyhole,
  Moon, Smartphone, Sun,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { preloadPage } from "@/lib/pageLoaders";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { companyBrandName, companyProfileName, dedicatedCompanyDomain } from "@/lib/company";
import { NAV_GROUPS } from "@/lib/navigation";

function SidebarContent({ onNav, companyName, companyId, user, interfaceConfig }) {
  const reduceMotion = useReducedMotion();
  const [openGroups, setOpenGroups] = useState({});
  const navigationId = (id) => ({
    warehouses: "warehouses-navigation",
    production: "production-navigation",
    "company-inventory": "company-inventory-navigation",
    express: "old-express-navigation",
  }[id] || `${id}-navigation`);
  const hiddenSections = new Set(interfaceConfig?.hidden_sections || []);
  const groupOrder = interfaceConfig?.group_order || [];
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      (!item.companyId || item.companyId === companyId)
      && (item.section !== "settings" || (!user?.is_worker && user?.role !== "admin"))
      && (!user?.is_worker || !item.warehouseId || (user.warehouse_ids || []).includes(item.warehouseId))
      && (!item.globalOwnerOnly || (user?.is_primary_owner && user?.is_owner && !user?.is_worker))
      && (!user?.is_worker || user.allowed_sections?.includes(item.section))
      && (item.globalOwnerOnly || !hiddenSections.has(item.section))
    ).map((item) => ({
      ...item,
      label: interfaceConfig?.section_labels?.[item.section] || item.label,
    })).sort((left, right) => {
      const order = interfaceConfig?.section_order?.[group.id] || [];
      const leftIndex = order.indexOf(left.section);
      const rightIndex = order.indexOf(right.section);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }),
    label: interfaceConfig?.group_labels?.[group.id] || group.label,
  })).filter((group) => (!group.companyId || group.companyId === companyId) && (!group.companyIds || group.companyIds.includes(companyId)) && group.items.length)
    .sort((left, right) => {
      const leftIndex = groupOrder.indexOf(left.id);
      const rightIndex = groupOrder.indexOf(right.id);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    });
  return (
    <>
      <div className="erp-sidebar-brand relative z-10 flex items-center gap-3 px-5 h-16 border-b border-white/10">
        <div className="erp-sidebar-brand-icon h-10 w-10 rounded-lg border border-emerald-100/20 bg-[hsl(158_28%_15%)] flex items-center justify-center shrink-0">
            <span className="erp-sidebar-brand-mark font-display text-3xl leading-none text-white" aria-hidden="true">S</span>
        </div>
        <div>
          <div className="text-white font-bold text-base font-display leading-tight">{companyName || "SUPER IQ-FOAM"}</div>
          <div className="erp-sidebar-subtitle text-emerald-100/55 text-[10px] font-semibold uppercase tracking-[0.16em]">Business Management</div>
        </div>
      </div>
      <nav className="erp-sidebar-nav relative z-10 flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
        {navGroups.map((group) => {
          const expanded = !!openGroups[group.id];
          const groupNavId = navigationId(group.id);
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
                className={({ isActive }) => `relative isolate flex min-h-10 items-center gap-3 px-3 py-2 rounded-lg text-[13px] leading-tight font-medium transition-[color,background-color] duration-150 ${isActive ? "text-white" : "text-emerald-50/65 hover:bg-white/5 hover:text-white"}`}>
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
                onClick={() => setOpenGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                aria-expanded={expanded}
                aria-controls={groupNavId}
                data-testid={`${groupNavId}-toggle`}
                className="flex w-full items-center justify-between px-3 pt-3 pb-1 text-left text-[9px] font-bold uppercase tracking-[0.14em] text-yellow-300 hover:text-yellow-200"
              >
                <span>{group.label}</span>
                <ChevronDown size={13} className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
            ) : (
              <p className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-100/45">{group.label}</p>
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

function AnimatedOutlet({ scrollContainerRef }) {
  const location = useLocation();
  useLayoutEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [location.pathname, scrollContainerRef]);

  return <div key={location.pathname} className="app-page-enter"><Outlet /></div>;
}

export default function Layout() {
  const { user, logout, switchCompany } = useAuth();
  const { theme, setTheme } = useTheme();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [phoneOptimized, setPhoneOptimized] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [interfaceConfig, setInterfaceConfig] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [dismissingNotificationIds, setDismissingNotificationIds] = useState([]);
  const [dismissingAllNotifications, setDismissingAllNotifications] = useState(false);
  const mainScrollRef = useRef(null);
  const nav = useNavigate();
  const dedicatedDomain = dedicatedCompanyDomain();
  const canTogglePhoneView = user?.is_primary_owner
    && user?.is_owner
    && !user?.is_worker;

  const findHorizontalScrollRegion = (target) => {
    if (!(target instanceof Element)) return null;
    const region = target.closest(".overflow-x-auto, .overflow-x-scroll, .grv-horizontal-scroll");
    return region && region.scrollWidth > region.clientWidth ? region : null;
  };
  const handleHorizontalWheel = (event) => {
    if (event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return;
    const scrollRegion = findHorizontalScrollRegion(event.target);
    if (!scrollRegion) return;
    const maxScrollLeft = scrollRegion.scrollWidth - scrollRegion.clientWidth;
    if ((event.deltaY > 0 && scrollRegion.scrollLeft >= maxScrollLeft)
      || (event.deltaY < 0 && scrollRegion.scrollLeft <= 0)) return;
    scrollRegion.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  useEffect(() => { api.get("/companies/profiles").then(setProfiles).catch(() => {}); }, []);
  useEffect(() => {
    let active = true;
    const loadInterfaceConfig = () => {
      api.getUncached("/interface-settings")
        .then((config) => { if (active) setInterfaceConfig(config); })
        .catch((error) => { if (active) toast.error(apiError(error)); });
    };
    const applyInterfaceConfig = (event) => {
      if (event.detail) setInterfaceConfig(event.detail);
      else loadInterfaceConfig();
    };
    loadInterfaceConfig();
    window.addEventListener("erp:interface-settings-updated", applyInterfaceConfig);
    window.addEventListener("focus", loadInterfaceConfig);
    return () => {
      active = false;
      window.removeEventListener("erp:interface-settings-updated", applyInterfaceConfig);
      window.removeEventListener("focus", loadInterfaceConfig);
    };
  }, []);
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
  const dismissAllNotifications = async () => {
    if (dismissingAllNotifications) return;
    setDismissingAllNotifications(true);
    try {
      const result = await api.post("/notifications/dismiss-all", {});
      await loadNotifications(true);
      toast.success(`${result.dismissed_count} notification${result.dismissed_count === 1 ? "" : "s"} dismissed`);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setDismissingAllNotifications(false);
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
    <div className={`app-shell flex h-dvh flex-col overflow-hidden bg-background print:h-auto print:overflow-visible${canTogglePhoneView && phoneOptimized ? " phone-optimized" : ""}`}>
      {/* Desktop sidebar */}
      <aside className="erp-sidebar desktop-sidebar no-print hidden lg:flex fixed inset-y-0 left-0 w-64 flex-col border-r border-white/10 bg-[hsl(222_47%_11%)] shadow-[4px_0_18px_rgba(15,23,42,0.08)] z-30">
        <svg className="erp-sidebar-decoration pointer-events-none absolute inset-x-0 bottom-0 h-56 w-full" viewBox="0 0 280 224" preserveAspectRatio="none" aria-hidden="true">
          <path d="M-25 225c56-68 113-142 188-172 35-14 70-18 126-8-70 27-111 58-154 114-20 27-39 49-64 66Z" fill="#c6d2c8" fillOpacity=".035" />
          <path d="M-24 220c73-77 132-144 197-169 39-15 76-16 116-9M-14 224c76-66 136-117 204-146 36-15 67-20 99-21M-16 211c76-56 136-99 205-123 33-12 62-17 91-18" fill="none" stroke="#c6d2c8" strokeOpacity=".24" strokeWidth="1" />
          <path d="M95 224c43-42 81-71 125-88 30-12 55-16 80-17" fill="none" stroke="#c6d2c8" strokeOpacity=".12" strokeWidth="4" />
        </svg>
        <SidebarContent companyName={activeBrandName} companyId={user?.company_id} user={user} interfaceConfig={interfaceConfig} />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence initial={false}>
        {open && (
        <motion.div key="mobile-navigation" className="lg:hidden fixed inset-0 z-50 flex" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}>
          <motion.div className="fixed inset-0 bg-slate-900/60" onClick={() => setOpen(false)} />
          <motion.aside className="erp-sidebar mobile-nav-panel liquid-glass-dark relative flex w-[min(18rem,calc(100vw-2.5rem))] flex-col bg-[hsl(222_47%_11%)]" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }} initial={reduceMotion ? false : { x: -36, opacity: 0.85 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.7 }}>
            <button className="absolute right-3 top-3 rounded-full p-2 text-slate-300 hover:bg-white/10" onClick={() => setOpen(false)} aria-label="Close navigation">
              <X size={22} />
            </button>
            <SidebarContent onNav={() => setOpen(false)} companyName={activeBrandName} companyId={user?.company_id} user={user} interfaceConfig={interfaceConfig} />
          </motion.aside>
        </motion.div>
        )}
      </AnimatePresence>

      <div className="app-content flex min-h-0 min-w-0 flex-1 flex-col lg:pl-64 print:overflow-visible print:pl-0">
        {/* Topbar */}
        <header className="mobile-topbar no-print liquid-glass-surface sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 border-b border-white/70 px-3 sm:gap-4 sm:px-6">
          <motion.button whileHover={reduceMotion ? undefined : { scale: 1.04, rotate: 0.5 }} whileTap={reduceMotion ? undefined : { scale: 0.96 }} transition={{ type: "spring", stiffness: 440, damping: 24 }} className="phone-menu-button lg:hidden rounded-full p-2 text-slate-600 hover:bg-white/40" onClick={() => setOpen(true)} aria-label="Open navigation" data-testid="menu-toggle">
            <Menu size={22} />
          </motion.button>
          {canTogglePhoneView && <button
            type="button"
            onClick={() => {
              setPhoneOptimized((current) => !current);
              setOpen(false);
            }}
            aria-pressed={phoneOptimized}
            aria-label={phoneOptimized ? "Exit phone-optimized view" : "Optimize view for phone screens"}
            title={phoneOptimized ? "Exit phone-optimized view" : "Optimize view for phone screens"}
            data-testid="phone-view-toggle"
            className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-semibold transition-colors ${phoneOptimized ? "border-primary bg-primary text-white" : "border-border bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            <Smartphone size={17} />
            <span>{phoneOptimized ? "Exit phone view" : "Phone view"}</span>
          </button>}
          <div className="phone-search flex-1 max-w-md hidden sm:block">
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
          <div className="phone-header-spacer flex-1 sm:hidden" />
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
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            data-testid="theme-toggle"
            className="rounded-full border border-border p-2 text-slate-500 hover:bg-white/40 hover:text-slate-800"
          >
            {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
          </button>
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
                <div className="flex items-center gap-3">
                  {user?.is_primary_owner && user?.is_owner && !user?.is_worker && <button type="button" onClick={dismissAllNotifications} disabled={dismissingAllNotifications || notifications.length === 0} className="text-xs font-semibold text-red-600 hover:text-red-800 disabled:opacity-50" data-testid="dismiss-all-notifications-btn">{dismissingAllNotifications ? "Dismissing…" : "Dismiss all"}</button>}
                  <button type="button" onClick={() => setNotificationsOpen(false)} className="text-xs font-semibold text-slate-500 hover:text-slate-900">Close</button>
                </div>
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
            <div className="phone-profile-info hidden sm:block leading-tight">
              <div className="text-sm font-semibold text-slate-800">{user?.name || "Admin"}</div>
              <div className="text-[11px] text-slate-500">{user?.is_worker ? user.worker_role || "Worker" : user?.is_owner || user?.is_company_owner ? "Owner" : user?.is_admin || user?.role === "admin" ? "Administrator" : "Team member"}</div>
            </div>
            {!user?.is_worker && !user?.is_worker_account && !dedicatedDomain && (
              <motion.button type="button" whileHover={reduceMotion ? undefined : { x: -1, scale: 1.04 }} whileTap={reduceMotion ? undefined : { scale: 0.97 }} transition={{ type: "spring", stiffness: 500, damping: 22 }} onClick={() => { setLoggingOut(true); logout(); }} disabled={loggingOut} aria-label="Log out" title="Log out" data-testid="logout-btn" className="inline-flex items-center gap-1.5 rounded-full px-2 py-2 text-slate-500 hover:text-red-600 hover:bg-red-50 ml-1 disabled:opacity-60">
                <LogOut size={18} />
                <span className="hidden text-xs font-semibold sm:inline">{loggingOut ? "Logging out…" : "Log out"}</span>
              </motion.button>
            )}
          </div>
        </header>

        <main
          ref={mainScrollRef}
          onWheelCapture={handleHorizontalWheel}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain p-3 sm:p-5 lg:p-6 2xl:p-8 w-full max-w-none print:h-auto print:flex-none print:overflow-visible"
        >
          <Suspense fallback={<div className="text-slate-400">Loading...</div>}>
            <AnimatedOutlet scrollContainerRef={mainScrollRef} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
