import { createContext, useContext, useEffect, useState } from "react";
import { api, apiError, dispatchDataRefresh } from "@/lib/api";
import { dedicatedCompanyDomain } from "@/lib/company";
import { Btn, Input, Modal } from "@/components/common";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

async function deviceInfo(shareLocation) {
  let deviceId = localStorage.getItem("erp_device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("erp_device_id", deviceId);
  }
  let position = {};
  if (shareLocation && navigator.geolocation) {
    position = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      () => resolve({}), { enableHighAccuracy: false, timeout: 7000, maximumAge: 300000 },
    ));
  }
  return {
    device_id: deviceId,
    device_name: `${navigator.platform || "Device"} · ${navigator.userAgent}`.slice(0, 180),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    share_location: shareLocation && position.latitude != null,
    ...position,
  };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // null=loading, false=unauth, obj=auth
  const [booting, setBooting] = useState(true);
  const [supervisorPrompt, setSupervisorPrompt] = useState(null);
  const [supervisorPassword, setSupervisorPassword] = useState("");

  useEffect(() => {
    const showSupervisorPrompt = (event) => {
      setSupervisorPrompt({ resolve: event.detail.resolve });
      setSupervisorPassword("");
    };
    window.addEventListener("erp:supervisor-password-required", showSupervisorPrompt);
    return () => window.removeEventListener("erp:supervisor-password-required", showSupervisorPrompt);
  }, []);

  useEffect(() => {
    let refreshTimer;
    const refreshVisibleData = () => {
      if (document.visibilityState !== "visible" || refreshTimer) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        if (document.visibilityState === "visible") dispatchDataRefresh();
      }, 100);
    };
    window.addEventListener("focus", refreshVisibleData);
    document.addEventListener("visibilitychange", refreshVisibleData);
    return () => {
      window.clearTimeout(refreshTimer);
      window.removeEventListener("focus", refreshVisibleData);
      document.removeEventListener("visibilitychange", refreshVisibleData);
    };
  }, []);

  useEffect(() => {
    // Returning from Google OAuth: AuthCallback exchanges session_id first
    if (window.location.hash?.includes("session_id=")) { setBooting(false); return; }
    const sharedEntry = new URLSearchParams(window.location.search).get("utm_source") === "share";
    const workerAccessEntry = window.location.pathname.startsWith("/worker-access/");
    if (sharedEntry) {
      window.history.replaceState(null, "", "/login");
      localStorage.removeItem("token");
      window.sessionStorage.removeItem("erp-worker-access-session");
      window.sessionStorage.removeItem("erp-worker-session-token");
    }
    if (workerAccessEntry || sharedEntry) {
      if (workerAccessEntry) {
        localStorage.removeItem("token");
        window.sessionStorage.removeItem("erp-worker-session-token");
        window.sessionStorage.removeItem("erp-worker-access-session");
        window.sessionStorage.removeItem("erp-worker-write-permissions");
      }
      setUser(false);
      setBooting(false);
      return;
    }
    if (
      window.location.pathname.startsWith("/shared-invoice/")
      || window.location.pathname.startsWith("/shared-warehouse-report/")
    ) {
      setUser(false);
      setBooting(false);
      return;
    }
    const navigationType = window.performance.getEntriesByType("navigation")[0]?.type;
    const generalSiteEntry = window.location.pathname === "/" && navigationType === "navigate";
    const dedicatedDomain = dedicatedCompanyDomain();
    api.get("/auth/me").then((authenticatedUser) => {
      if (authenticatedUser.is_worker && (
        generalSiteEntry
        || window.sessionStorage.getItem("erp-worker-access-session") !== "true"
      )) {
        window.sessionStorage.removeItem("erp-worker-session-token");
        window.sessionStorage.removeItem("erp-worker-access-session");
        window.sessionStorage.removeItem("erp-worker-write-permissions");
        setUser(false);
        return;
      }
      if (dedicatedDomain && !authenticatedUser.is_worker && !authenticatedUser.can_switch_company
        && authenticatedUser.company_id !== dedicatedDomain.companyId) {
        localStorage.removeItem("token");
        setUser(false);
        return;
      }
      setUser(authenticatedUser);
    }).catch(() => setUser(false)).finally(() => setBooting(false));
  }, []);

  const finishLogin = async (data, shareLocation, workerAccessLogin = false) => {
    if (workerAccessLogin && (data.user.is_worker || data.user.is_worker_account)) {
      localStorage.removeItem("token");
      window.sessionStorage.setItem("erp-worker-access-session", "true");
      window.sessionStorage.setItem("erp-worker-session-token", data.token);
      window.sessionStorage.setItem("erp-worker-access-entry", window.location.pathname);
      window.sessionStorage.setItem("erp-worker-write-permissions", JSON.stringify(data.user.write_permissions || {}));
    } else {
      localStorage.setItem("token", data.token);
      window.sessionStorage.removeItem("erp-worker-session-token");
      window.sessionStorage.removeItem("erp-worker-access-session");
      window.sessionStorage.removeItem("erp-worker-access-entry");
      window.sessionStorage.removeItem("erp-worker-write-permissions");
    }
    setUser(data.user);
    deviceInfo(shareLocation).then((info) => api.post("/auth/device", info)).catch(() => {});
    return data.user;
  };

  const login = async (username, password, companyId, shareLocation = false, personalAccessToken = "") => {
    const dedicatedDomain = dedicatedCompanyDomain();
    const data = await api.post("/auth/login", {
      username: personalAccessToken ? username : dedicatedDomain?.username || username,
      password,
      company_id: personalAccessToken ? companyId : dedicatedDomain?.companyId || companyId,
      ...(personalAccessToken ? { personal_access_token: personalAccessToken } : {}),
    });
    return finishLogin(data, shareLocation, Boolean(personalAccessToken));
  };

  const register = async (name, email, password, shareLocation = false) => {
    const data = await api.post("/auth/register", { name, email, password });
    return finishLogin(data, shareLocation);
  };

  const completeGoogle = async (sessionId) => {
    const companyId = dedicatedCompanyDomain()?.companyId || localStorage.getItem("selectedCompanyId");
    const data = await api.post("/auth/google/session", { session_id: sessionId, company_id: companyId });
    localStorage.removeItem("selectedCompanyId");
    const shareLocation = localStorage.getItem("shareDeviceLocation") === "true";
    localStorage.removeItem("shareDeviceLocation");
    return finishLogin(data, shareLocation);
  };

  const switchCompany = async (companyId) => {
    const data = await api.post("/auth/switch-company", { company_id: companyId });
    // Reload with the new token without re-rendering the current page under the other company's user.
    localStorage.setItem("token", data.token);
    window.location.replace("/");
  };

  const logout = async () => {
    const workerSession = user?.is_worker === true || user?.is_worker_account === true;
    const workerEntry = window.sessionStorage.getItem("erp-worker-access-entry");
    try { await api.logout(); } catch { /* Local logout must still complete if the server is unavailable. */ }
    finally {
      if (workerSession) {
        localStorage.removeItem("token");
        window.sessionStorage.removeItem("erp-worker-session-token");
        window.sessionStorage.removeItem("erp-worker-write-permissions");
      } else {
        localStorage.removeItem("token");
      }
      window.sessionStorage.removeItem("erp-worker-access-session");
      setUser(false);
      window.location.replace(workerSession && workerEntry ? workerEntry : "/login");
    }
  };

  const closeSupervisorPrompt = (password = null) => {
    supervisorPrompt?.resolve(typeof password === "string" ? password : null);
    setSupervisorPrompt(null);
    setSupervisorPassword("");
  };

  return (
    <AuthCtx.Provider value={{ user, setUser, booting, login, register, completeGoogle, switchCompany, logout, apiError }}>
      {children}
      <Modal
        open={!!supervisorPrompt}
        onClose={() => closeSupervisorPrompt()}
        title="Supervisor Password required"
      >
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          closeSupervisorPrompt(supervisorPassword);
        }}>
          <p className="text-sm text-slate-600">Changes to SUPERIQFOAM require approval with its Supervisor Password.</p>
          <Input
            autoFocus
            label="SUPERIQFOAM Supervisor Password"
            type="password"
            autoComplete="current-password"
            value={supervisorPassword}
            onChange={(event) => setSupervisorPassword(event.target.value)}
            data-testid="company-supervisor-password"
          />
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => closeSupervisorPrompt()}>Cancel</Btn>
            <Btn type="submit" disabled={!supervisorPassword}>Authorize change</Btn>
          </div>
        </form>
      </Modal>
    </AuthCtx.Provider>
  );
}
