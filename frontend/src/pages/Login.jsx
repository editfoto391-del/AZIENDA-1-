import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { Building2, Factory, Store, Layers, ArrowLeft, LockKeyhole } from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { companyProfileName, dedicatedCompanyDomain } from "@/lib/company";

const PROFILE_ICONS = [Building2, Factory, Store];
const PROFILE_TONES = [
  "bg-emerald-100 text-emerald-900 border-emerald-200",
  "bg-lime-100 text-lime-950 border-lime-200",
  "bg-amber-100 text-amber-950 border-amber-200",
];

export default function Login() {
  const { login, apiError, user } = useAuth();
  const location = useLocation();
  const { token: personalAccessToken } = useParams();
  const dedicatedDomain = dedicatedCompanyDomain();
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState(() => !personalAccessToken && dedicatedDomain
    ? { id: dedicatedDomain.companyId, username: dedicatedDomain.username }
    : null);
  const [username, setUsername] = useState(!personalAccessToken ? dedicatedDomain?.username || "" : "");
  const [accessLink, setAccessLink] = useState(null);
  const [linkLoading, setLinkLoading] = useState(Boolean(personalAccessToken));
  const [password, setPassword] = useState("");
  const [shareLocation, setShareLocation] = useState(false);
  const [err, setErr] = useState(location.state?.error || "");
  const [loading, setLoading] = useState(false);
  const [loadingProfiles, setLoadingProfiles] = useState(true);

  useEffect(() => {
    if (personalAccessToken) {
      api.getUncached(`/worker-access/${encodeURIComponent(personalAccessToken)}`)
        .then((details) => {
          setAccessLink(details);
          setSelected({ id: details.company_id, username: details.username });
          setUsername(details.username);
          setErr("");
        })
        .catch((error) => setErr(apiError(error)))
        .finally(() => setLinkLoading(false));
      return;
    }
    api.get("/companies/profiles").then(setProfiles).catch((e) => setErr(apiError(e))).finally(() => setLoadingProfiles(false));
  }, [personalAccessToken]);

  const googleLogin = () => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + "/";
    localStorage.setItem("selectedCompanyId", selected.id);
    localStorage.setItem("shareDeviceLocation", String(shareLocation));
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  const chooseProfile = (profile) => {
    setSelected(profile);
    setUsername(profile.username);
    setPassword("");
    setErr("");
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setLoading(true);
    try { await login(username, password, selected.id, shareLocation, personalAccessToken); }
    catch (e) { setErr(apiError(e)); }
    finally { setLoading(false); }
  };

  if (user) return <Navigate to="/" replace />;

  if (personalAccessToken && linkLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(var(--navy))] text-sm text-emerald-50/70" role="status">Verifying worker access link...</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[hsl(var(--navy))] px-4 py-8">
      <div className="w-full max-w-3xl profile-screen-enter">
        <div className="flex items-center gap-3 justify-center mb-4">
          <div className="h-12 w-12 rounded-lg border border-emerald-100/20 bg-[hsl(158_28%_15%)] flex items-center justify-center">
            <Layers className="text-emerald-100" size={24} />
          </div>
          <div>
            <div className="text-white font-bold text-xl font-display">SUPER IQ-FOAM</div>
            <div className="text-emerald-100/55 text-[10px] font-semibold uppercase tracking-[0.16em]">Business Management</div>
          </div>
        </div>
        {personalAccessToken && !accessLink ? <section className="mx-auto max-w-md text-center" data-testid="worker-access-link-error">
          <div className="luxury-card rounded-xl border border-white/15 bg-white/[0.06] p-6 text-white">
            <LockKeyhole className="mx-auto mb-3 text-amber-200" size={28} />
            <h1 className="text-xl font-semibold">Worker access link unavailable</h1>
            <p className="mt-2 text-sm text-emerald-50/70">{err || "This link is invalid or has been revoked. Ask the company owner for a new link."}</p>
          </div>
        </section> : !selected ? <section className="text-center" data-testid="company-profile-selector">
          <div>
            <h1 className="text-3xl sm:text-4xl font-normal text-white font-display">Choose your workspace</h1>
            <p className="text-sm text-emerald-50/60 mt-2">Select a company profile to continue</p>
          </div>
          {err && <div className="mx-auto mt-4 max-w-md rounded-md border border-red-200/40 bg-red-950/30 px-3 py-2 text-sm text-red-100" data-testid="login-error">{err}</div>}
          {loadingProfiles ? <p className="mt-8 text-sm text-emerald-50/60">Loading company profiles...</p> : (
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
              {profiles.map((profile, index) => {
                const Icon = PROFILE_ICONS[index] || Building2;
                return <button key={profile.id} type="button" onClick={() => chooseProfile(profile)} data-testid={`company-profile-${profile.id}`}
                  className="group flex flex-row items-center gap-4 rounded-xl border border-white/10 bg-white/[0.035] px-5 py-4 text-left transition-all duration-300 hover:-translate-y-1 hover:border-emerald-100/30 hover:bg-white/[0.07] focus:outline-none focus:ring-2 focus:ring-emerald-100/40 sm:flex-col sm:gap-4 sm:border-0 sm:bg-transparent sm:px-3 sm:py-3 sm:text-center sm:hover:bg-transparent motion-reduce:transform-none motion-reduce:transition-none">
                  <span className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full border shadow-[0_8px_24px_rgba(0,0,0,0.16)] transition-transform duration-300 group-hover:scale-105 sm:h-24 sm:w-24 ${PROFILE_TONES[index] || PROFILE_TONES[0]} motion-reduce:transition-none`}>
                    <Icon size={28} strokeWidth={1.5} className="sm:hidden" />
                    <Icon size={36} strokeWidth={1.4} className="hidden sm:block" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold tracking-wide text-white sm:mt-1">{companyProfileName(profile.id)}</span>
                    <span className="mt-1 block text-xs text-emerald-50/50 sm:hidden">Select workspace</span>
                  </span>
                </button>;
              })}
            </div>
          )}
          <p className="mt-7 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-50/35"><LockKeyhole size={12} className="mr-1 inline" /> Secure company access</p>
        </section> : (
          <form key={selected.id} onSubmit={submit} className="luxury-card mx-auto max-w-md space-y-3 rounded-xl border border-white/70 bg-[hsl(45_28%_98%)] p-5 sm:p-6 profile-screen-enter" data-testid="login-form">
            {!dedicatedDomain && !personalAccessToken && <button type="button" onClick={() => { setSelected(null); setErr(""); setPassword(""); }} className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" data-testid="back-to-company-profiles"><ArrowLeft size={14} /> Change company</button>}
            <div className="pb-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">{personalAccessToken ? "Personal worker access" : "Selected workspace"}</p>
              <h1 className="mt-1 text-2xl font-normal text-slate-900 font-display">{accessLink?.company_name || companyProfileName(selected.id)}</h1>
            </div>
            {err && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="login-error">{err}</div>}
            {personalAccessToken ? <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-500">Username</label>
              <p className="w-full rounded-md border border-input bg-slate-100 px-3 py-2 text-sm text-slate-700" data-testid="login-username">{username}</p>
            </div> : dedicatedDomain ? <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-500">Username</label>
              <p className="w-full rounded-md border border-input bg-slate-100 px-3 py-2 text-sm text-slate-700" data-testid="login-username">{dedicatedDomain.username}</p>
            </div> : <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-500">Username</label>
              <input data-testid="login-username" type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required
                className="w-full rounded-md border border-input bg-white/80 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
            </div>}
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-500">Password</label>
              <input data-testid="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
                className="w-full rounded-md border border-input bg-white/80 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
            </div>
            {!dedicatedDomain && !personalAccessToken && <label className="flex items-start gap-2 text-xs text-slate-500">
              <input type="checkbox" checked={shareLocation} onChange={(e) => setShareLocation(e.target.checked)} className="mt-0.5" data-testid="share-location-consent" />
              <span>Share this device's precise location with the administrator. Device, IP address and time zone are recorded when you sign in.</span>
            </label>}
            <button type="submit" disabled={loading} data-testid="login-submit" className="w-full rounded-md bg-primary py-2.5 font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50">
              {loading ? "Please wait..." : "Sign In"}
            </button>
            {!dedicatedDomain && !personalAccessToken && <>
              <div className="flex items-center gap-3 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
              <button type="button" onClick={googleLogin} data-testid="google-login-btn" className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-white/70 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-white">
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
              Continue with Google
              </button>
            </>}
          </form>
        )}
      </div>
    </div>
  );
}
