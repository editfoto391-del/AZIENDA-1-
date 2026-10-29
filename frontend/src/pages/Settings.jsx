import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtMoney, fmtDateTime } from "@/lib/format";
import { Card, Btn, Input, Select, Badge, Modal, PageHeader } from "@/components/common";
import { Building2, Receipt, Tag, Truck, Save, Pencil, Plus, ShieldCheck, Fuel, MapPin, Smartphone, Trash2, UserPlus, CirclePause, CirclePlay, KeyRound, Database, RotateCcw } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { usesUnifiedPriceList } from "@/lib/company";

const TABS = [
  { k: "company", l: "Company", icon: Building2 },
  { k: "invoice", l: "Invoice & Tax", icon: Receipt },
  { k: "prices", l: "Price List and Products", icon: Tag },
  { k: "drivers", l: "Drivers", icon: Truck },
  { k: "diesel", l: "Diesel", icon: Fuel },
  { k: "access", l: "Access", icon: ShieldCheck },
  { k: "profiles", l: "Password and Credentials", icon: KeyRound },
  { k: "backups", l: "Backups", icon: Database },
];

function AccessTab({ users, companies, loading, currentUserId, isPrimaryOwner, onRoleChange, onStatusChange, onRemove, onCreate, onMakeOwner }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ username: "", name: "", email: "", password: "", company_ids: [] });
  const [ownerTarget, setOwnerTarget] = useState(null);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [ownerCompanyId, setOwnerCompanyId] = useState("");
  const [assigningOwner, setAssigningOwner] = useState(false);
  const adminCounts = Object.fromEntries(companies.map((company) => [company.id,
    users.filter((account) => !account.is_owner && account.active !== false && account.company_roles?.[company.id] === "admin").length]));
  const companyName = (id) => companies.find((company) => company.id === id)?.name || id;

  const submitCreate = async (event) => {
    event.preventDefault();
    setCreating(true);
    try {
      await onCreate(draft);
      setDraft({ username: "", name: "", email: "", password: "", company_ids: [] });
      setCreateOpen(false);
    } catch { /* Parent displays the API error. */ }
    finally { setCreating(false); }
  };

  const submitOwner = async (event) => {
    event.preventDefault();
    if (!ownerTarget || !ownerPassword || assigningOwner) return;
    setAssigningOwner(true);
    try {
      if (await onMakeOwner(ownerTarget, ownerPassword, ownerCompanyId)) {
        setOwnerTarget(null);
        setOwnerPassword("");
        setOwnerCompanyId("");
      }
    } finally {
      setAssigningOwner(false);
    }
  };

  return (
    <Card className="p-5 space-y-4" data-testid="access-tab">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-bold text-slate-800 font-display">Users and company access</h3>
          <p className="text-sm text-slate-500 mt-1">Assign each account to companies and manage its role independently in each one.</p>
        </div>
        <Btn onClick={() => setCreateOpen(true)} data-testid="create-company-user"><UserPlus size={16} /> Add user</Btn>
      </div>
      {loading ? <p className="text-sm text-slate-400 py-4">Loading accounts...</p> : users.length === 0 ? <p className="text-sm text-slate-400 py-4">No accounts found.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-slate-400">
              <th className="py-2 font-semibold">Account</th>{companies.map((company) => <th key={company.id} className="min-w-44 font-semibold">{company.name}</th>)}
              <th className="font-semibold">Presence</th><th className="font-semibold">Current company · Last login</th><th />
            </tr></thead>
            <tbody>{users.map((account) => (
              <tr key={account.id} className="border-b border-border/60 align-top" data-testid={`access-user-${account.id}`}>
                <td className="py-3 pr-3"><p className="font-semibold text-slate-700">{account.name || account.username || "-"}</p><p className="text-xs text-slate-500">{account.username || account.email}</p>{account.is_owner && <Badge cls="mt-1 bg-amber-50 text-amber-800 border-amber-200">Global owner</Badge>}</td>
                {companies.map((company) => {
                  const role = account.is_owner ? "owner" : account.company_roles?.[company.id] || "none";
                  const count = adminCounts[company.id] || 0;
                  return <td key={company.id} className="py-3 pr-3">
                    {role === "owner" ? <Badge cls="bg-amber-50 text-amber-800 border-amber-200">Owner</Badge> :
                      <>
                        <select aria-label={`${company.name} role for ${account.username}`} value={role}
                          onChange={(event) => onRoleChange(account, company.id, event.target.value)}
                          data-testid={`access-role-${account.id}-${company.id}`}
                          className="w-full rounded-md border border-input bg-white px-2 py-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/15">
                          <option value="none">No access</option><option value="user">User</option>
                          <option value="admin" disabled={count >= 3 && role !== "admin"}>Admin ({count}/3)</option>
                        </select>
                        {count >= 3 && role !== "admin" && <p className="mt-1 text-[10px] text-amber-800">Maximum 3 admins</p>}
                      </>}
                  </td>;
                })}
                <td className="py-3 pr-3">
                  <Badge cls={account.active === false ? "bg-slate-100 text-slate-600 border-slate-200" : account.online ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-600 border-slate-200"}>
                    {account.active === false ? "Disabled" : account.online ? "Online" : "Offline"}
                  </Badge>
                  {!account.is_owner && <button type="button" onClick={() => onStatusChange(account, account.active === false)} aria-label={account.active === false ? `Enable ${account.username}` : `Disable ${account.username}`}
                    className="ml-2 inline-flex align-middle text-slate-500 hover:text-primary" data-testid={`toggle-user-${account.id}`}>
                    {account.active === false ? <CirclePlay size={17} /> : <CirclePause size={17} />}
                  </button>}
                </td>
                <td className="py-3 text-xs text-slate-600">{account.current_company_id ? companyName(account.current_company_id) : "-"}<p className="mt-1 text-slate-400">{account.last_login ? fmtDateTime(account.last_login) : "No login yet"}</p></td>
                <td className="py-3 text-right whitespace-nowrap">
                  {isPrimaryOwner && !account.is_owner && account.active !== false && <button type="button" onClick={() => { setOwnerTarget(account); setOwnerPassword(""); setOwnerCompanyId(account.company_ids?.[0] || companies[0]?.id || ""); }} title={`Make ${account.username} a company owner`} aria-label={`Make ${account.username} a company owner`} className="rounded p-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50" data-testid={`make-owner-${account.id}`}>Make company owner</button>}
                  {!account.is_owner && account.id !== currentUserId && <button type="button" onClick={() => onRemove(account)} title={`Remove ${account.username}`} aria-label={`Remove ${account.username}`} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" data-testid={`remove-user-${account.id}`}><Trash2 size={16} /></button>}
                </td>
              </tr>))}</tbody>
          </table>
        </div>
      )}

      <Modal open={createOpen} onClose={() => !creating && setCreateOpen(false)} title="Create user">
        <form onSubmit={submitCreate} className="space-y-4">
          <Input label="Username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} required data-testid="new-user-username" />
          <Input label="Display name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required data-testid="new-user-name" />
          <Input label="Email (optional)" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} data-testid="new-user-email" />
          <Input label="Initial password" type="password" minLength={8} value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} required data-testid="new-user-password" />
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-slate-600">Company access</legend>
            {companies.map((company) => <label key={company.id} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={draft.company_ids.includes(company.id)} onChange={(e) => setDraft({ ...draft, company_ids: e.target.checked ? [...draft.company_ids, company.id] : draft.company_ids.filter((id) => id !== company.id) })} />
              {company.name}
            </label>)}
          </fieldset>
          <div className="flex justify-end gap-2"><Btn type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Btn><Btn type="submit" disabled={creating || draft.company_ids.length === 0} data-testid="save-company-user">{creating ? "Creating..." : "Create user"}</Btn></div>
        </form>
      </Modal>
      <Modal open={!!ownerTarget} onClose={() => !assigningOwner && setOwnerTarget(null)} title="Assign company owner">
        {ownerTarget && <form onSubmit={submitOwner} className="space-y-4">
          <p className="text-sm text-slate-600">Give <b>{ownerTarget.name || ownerTarget.username}</b> owner access to one company only.</p>
          <Select label="Company" value={ownerCompanyId} onChange={(event) => setOwnerCompanyId(event.target.value)} required data-testid="owner-company-select">
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </Select>
          <Input label="Primary owner password" type="password" autoComplete="current-password" minLength={8} required value={ownerPassword} onChange={(event) => setOwnerPassword(event.target.value)} data-testid="assign-owner-password" />
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => { setOwnerTarget(null); setOwnerCompanyId(""); }} disabled={assigningOwner}>Cancel</Btn>
            <Btn type="submit" disabled={assigningOwner} data-testid="confirm-make-owner">{assigningOwner ? "Checking..." : "Confirm owner access"}</Btn>
          </div>
        </form>}
      </Modal>
    </Card>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
  const [tab, setTab] = useState("company");
  const [s, setS] = useState(null);
  const [dieselPrice, setDieselPrice] = useState("");
  const [dieselSaving, setDieselSaving] = useState(false);
  const [prices, setPrices] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [accessUsers, setAccessUsers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [profileAccounts, setProfileAccounts] = useState([]);
  const [profileDrafts, setProfileDrafts] = useState({});
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profileSavingId, setProfileSavingId] = useState("");
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [supervisorConfigured, setSupervisorConfigured] = useState(false);
  const [supervisorStatusLoading, setSupervisorStatusLoading] = useState(false);
  const [supervisorSaving, setSupervisorSaving] = useState(false);
  const [removeUser, setRemoveUser] = useState(null);
  const [removingUser, setRemovingUser] = useState(false);
  const [pModal, setPModal] = useState(null);
  const [priceSaving, setPriceSaving] = useState(false);
  const [dModal, setDModal] = useState(null);
  const [zone, setZone] = useState(1);
  const [backupStatus, setBackupStatus] = useState(null);
  const [backups, setBackups] = useState([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupAction, setBackupAction] = useState("");
  const [recoveryCopy, setRecoveryCopy] = useState(null);

  const load = () => {
    api.get("/settings").then((settings) => { setS(settings); setDieselPrice(settings.diesel_price == null ? "" : String(settings.diesel_price)); });
    api.get("/prices").then(setPrices); api.get("/drivers").then(setDrivers);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (tab !== "access" || !user?.is_owner) return;
    setAccessLoading(true);
    Promise.all([api.get("/access/users"), api.get("/companies/profiles")])
      .then(([accounts, profiles]) => { setAccessUsers(accounts); setCompanies(profiles); })
      .catch((e) => toast.error(apiError(e))).finally(() => setAccessLoading(false));
  }, [tab, user?.is_owner]);
  useEffect(() => {
    if (tab !== "profiles") return;
    if (user?.is_owner) {
      setProfilesLoading(true);
      api.get("/access/profiles")
        .then((profiles) => {
        setProfileAccounts(profiles);
        setProfileDrafts(Object.fromEntries(profiles.map((profile) => [
          profile.id, { userPassword: "", ownerPassword: "" },
        ])));
        })
        .catch((e) => toast.error(apiError(e)))
        .finally(() => setProfilesLoading(false));
    }
    if (user?.is_owner || user?.is_company_owner) {
      setSupervisorStatusLoading(true);
      api.get("/settings/supervisor-password")
        .then((status) => setSupervisorConfigured(status.configured))
        .catch((e) => toast.error(apiError(e)))
        .finally(() => setSupervisorStatusLoading(false));
    }
  }, [tab, user?.is_owner, user?.is_company_owner]);
  useEffect(() => {
    if (tab !== "backups" || !user?.is_primary_owner) return;
    setBackupsLoading(true);
    api.get("/backups")
      .then((result) => {
        setBackupStatus(result.status);
        setBackups(result.snapshots);
      })
      .catch((error) => toast.error(apiError(error)))
      .finally(() => setBackupsLoading(false));
  }, [tab, user?.is_primary_owner]);

  const refreshBackups = async () => {
    setBackupsLoading(true);
    try {
      const result = await api.get("/backups");
      setBackupStatus(result.status);
      setBackups(result.snapshots);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBackupsLoading(false);
    }
  };

  const createBackup = async () => {
    setBackupAction("create");
    try {
      const result = await api.post("/backups", {});
      if (result.retention_cleanup_ok === false) {
        toast.error("Backup was created, but expired-backup cleanup failed. Ask the administrator to check server logs.");
      } else {
        toast.success(result.already_exists ? "A backup already exists for this time" : "Backup created in the external archive");
      }
      await refreshBackups();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBackupAction("");
    }
  };

  const restoreBackup = async (backup) => {
    const confirmed = window.confirm(
      `Restore ${backup.key} into a separate copy of the databases? Current live data will not be overwritten.`
    );
    if (!confirmed) return;
    setBackupAction(backup.key);
    setRecoveryCopy(null);
    try {
      const result = await api.post("/backups/restore", { key: backup.key });
      setRecoveryCopy(result);
      toast.success("Historical backup restored into a separate database copy");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBackupAction("");
    }
  };

  const saveSupervisorPassword = async () => {
    if (supervisorPassword.length < 8 || supervisorSaving) return;
    setSupervisorSaving(true);
    try {
      const result = await api.put("/settings/supervisor-password", { password: supervisorPassword });
      setSupervisorConfigured(result.configured);
      setSupervisorPassword("");
      toast.success("Supervisor password updated");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSupervisorSaving(false);
    }
  };

  const makeOwner = async (account, owner_password, company_id) => {
    try {
      const result = await api.put(`/access/users/${account.id}/owner`, { owner_password, company_id });
      setAccessUsers((current) => current.map((userAccount) => userAccount.id === account.id
        ? { ...userAccount, ...result, is_owner: false, company_ids: result.company_ids, company_roles: result.company_roles }
        : userAccount));
      toast.success(`${account.username} is now an owner for this company`);
      return true;
    } catch (error) {
      toast.error(apiError(error));
      return false;
    }
  };

  const saveProfileCredentials = async (profile, accountType) => {
    const draft = profileDrafts[profile.id];
    if (!draft || !["owner", "user"].includes(accountType)) return;
    const savingId = `${profile.id}-${accountType}`;
    setProfileSavingId(savingId);
    try {
      await api.put(`/access/profiles/${profile.id}/password/${accountType}`, {
        password: accountType === "user" ? draft.userPassword : draft.ownerPassword,
      });
      setProfileAccounts((current) => current.map((item) => item.id === profile.id
        ? { ...item, [`${accountType}_configured`]: true }
        : item));
      setProfileDrafts((current) => ({
        ...current,
        [profile.id]: { ...current[profile.id], [`${accountType}Password`]: "" },
      }));
      toast.success(`${accountType === "owner" ? "Owner" : "User"} password updated`);
    } catch (e) { toast.error(apiError(e)); }
    finally { setProfileSavingId(""); }
  };

  const changeRole = async (account, companyId, role) => {
    try {
      if (role === "none") {
        const company_ids = account.company_ids.filter((id) => id !== companyId);
        const result = await api.put(`/access/users/${account.id}/companies`, { company_ids });
        setAccessUsers((current) => current.map((u) => u.id === account.id ? { ...u, company_ids: result.company_ids, company_roles: result.company_roles } : u));
      } else {
        await api.put(`/access/users/${account.id}/role`, { role, company_id: companyId });
        setAccessUsers((current) => current.map((u) => u.id === account.id ? {
          ...u, company_ids: [...new Set([...u.company_ids, companyId])], company_roles: { ...u.company_roles, [companyId]: role },
        } : u));
      }
      toast.success(`${account.username} access updated`);
    } catch (e) { toast.error(apiError(e)); }
  };

  const changeStatus = async (account, active) => {
    try {
      await api.put(`/access/users/${account.id}/status`, { active });
      setAccessUsers((current) => current.map((u) => u.id === account.id ? { ...u, active, online: active ? u.online : false } : u));
      toast.success(`${account.username} ${active ? "enabled" : "disabled"}`);
    } catch (e) { toast.error(apiError(e)); }
  };

  const createAccessUser = async (body) => {
    try {
      const created = await api.post("/access/users", body);
      setAccessUsers((current) => [...current, { ...created, online: false, last_login: "", current_company_id: "", devices: [] }]);
      toast.success("User created");
    } catch (e) { toast.error(apiError(e)); throw e; }
  };

  const confirmRemoveUser = async () => {
    if (!removeUser) return;
    setRemovingUser(true);
    try {
      await api.del(`/access/users/${removeUser.id}`);
      setAccessUsers((current) => current.filter((u) => u.id !== removeUser.id));
      toast.success("Account removed");
      setRemoveUser(null);
    } catch (e) { toast.error(apiError(e)); } finally { setRemovingUser(false); }
  };

  const saveSettings = async () => {
    try { const r = await api.put("/settings", s); setS(r); toast.success("Settings saved"); }
    catch (e) { toast.error(apiError(e)); }
  };

  const saveDieselPrice = async () => {
    const price = Number(dieselPrice);
    if (!Number.isFinite(price) || price <= 0) return toast.error("Enter a valid diesel price");
    setDieselSaving(true);
    try {
      const r = await api.put("/settings/diesel", { price_per_l: price });
      setS((current) => ({ ...current, ...r }));
      setDieselPrice(String(r.diesel_price));
      toast.success("Diesel price updated");
    } catch (e) { toast.error(apiError(e)); } finally { setDieselSaving(false); }
  };

  const savePrice = async () => {
    if (priceSaving) return;
    try {
      if (!pModal.category?.trim()) return toast.error("Product name is required");
      if (!pModal.size?.trim()) return toast.error("Size or unit is required");
      const hasPrice = pModal.price !== "" && pModal.price != null;
      if (hasPrice && !(Number(pModal.price) > 0)) return toast.error("Enter a valid product price");
      const body = {
        ...pModal,
        category: pModal.category.trim(),
        size: pModal.size.trim(),
        zone: unifiedPriceList ? 1 : pModal.zone,
        price: hasPrice ? Number(pModal.price) : null,
      };
      setPriceSaving(true);
      if (pModal.id) await api.put(`/prices/${pModal.id}`, body);
      else await api.post("/prices", body);
      toast.success(pModal.newProduct ? "Product saved and available on invoices" : "Price saved");
      setPModal(null);
      setPrices(await api.get("/prices"));
    } catch (e) { toast.error(apiError(e)); }
    finally { setPriceSaving(false); }
  };

  const deletePrice = async (price) => {
    if (!window.confirm(`Permanently delete ${priceProductName(price.category)} — ${price.size}? This cannot be undone.`)) return;
    try {
      await api.del(`/prices/${price.id}`);
      setPrices((current) => current.filter((item) => item.id !== price.id));
      toast.success("Product price permanently deleted");
    } catch (e) { toast.error(apiError(e)); }
  };

  const saveDriver = async () => {
    try {
      if (dModal.id) await api.put(`/drivers/${dModal.id}`, dModal);
      else await api.post("/drivers", dModal);
      toast.success("Driver saved"); setDModal(null); api.get("/drivers").then(setDrivers);
    } catch (e) { toast.error(apiError(e)); }
  };

  if (!s) return <div className="text-slate-400">Loading...</div>;
  const zonePrices = prices.filter((p) => p.zone === (unifiedPriceList ? 1 : zone));
  const priceProductName = (category) => ["Standard", "Simple"].includes(category) ? "Simple/Mix color" : category;

  return (
    <div>
      <PageHeader title="Settings" subtitle="Configure your business" />
      <div className="flex gap-2 mb-6 overflow-x-auto no-print">
        {TABS.filter((t) => (t.k !== "diesel" || user?.is_admin) && (t.k !== "access" || user?.is_owner) && (t.k !== "profiles" || user?.is_owner || user?.is_company_owner) && (t.k !== "backups" || user?.is_primary_owner)).map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)} data-testid={`settings-tab-${t.k}`}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold whitespace-nowrap ${tab === t.k ? "bg-primary text-white" : "bg-white border border-border text-slate-600"}`}>
            <t.icon size={16} /> {t.l}
          </button>
        ))}
      </div>

      {tab === "company" && (
        <Card className="p-6 max-w-2xl space-y-4">
          <Input label="Company Name" value={s.company_name} onChange={(e) => setS({ ...s, company_name: e.target.value })} data-testid="company-name-input" />
          <Input label="Address" value={s.address} onChange={(e) => setS({ ...s, address: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Telephone" value={s.telephone} onChange={(e) => setS({ ...s, telephone: e.target.value })} />
            <Input label="Email" value={s.email} onChange={(e) => setS({ ...s, email: e.target.value })} />
          </div>
          <label className="block"><span className="block text-xs font-semibold text-slate-500 mb-1.5">Banking Details</span>
            <textarea rows={3} value={s.banking_details} onChange={(e) => setS({ ...s, banking_details: e.target.value })} className="w-full rounded-lg border border-input px-3 py-2.5 text-sm" /></label>
          <Input label="Tax Number (optional)" value={s.tax_number} onChange={(e) => setS({ ...s, tax_number: e.target.value })} />
          <Btn onClick={saveSettings} data-testid="save-settings-btn"><Save size={16} /> Save Settings</Btn>
        </Card>
      )}

      {tab === "invoice" && (
        <Card className="p-6 max-w-2xl space-y-4">
          <Input label="Invoice Prefix" value={s.invoice_prefix} onChange={(e) => setS({ ...s, invoice_prefix: e.target.value })} />
          <Select label="Default Payment Terms" value={s.default_payment_terms} onChange={(e) => setS({ ...s, default_payment_terms: e.target.value })}>
            {s.payment_terms.map((t) => <option key={t}>{t}</option>)}
          </Select>
          <div className="border-t border-border pt-4">
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-3">
              <input type="checkbox" checked={s.tax_enabled} onChange={(e) => setS({ ...s, tax_enabled: e.target.checked })} data-testid="tax-enabled-toggle" /> Enable Tax on Invoices
            </label>
            {s.tax_enabled && <Input label="Tax Rate (%)" type="number" value={s.tax_rate} onChange={(e) => setS({ ...s, tax_rate: Number(e.target.value) })} className="max-w-xs" />}
            <p className="text-xs text-slate-400 mt-2">Business is not assumed VAT registered. Tax is off by default.</p>
          </div>
          <Input label="Default Resting Time (hours)" type="number" value={s.resting_hours} onChange={(e) => setS({ ...s, resting_hours: Number(e.target.value) })} className="max-w-xs" />
          <Input label="Safety Stock Level" type="number" value={s.safety_stock} onChange={(e) => setS({ ...s, safety_stock: Number(e.target.value) })} className="max-w-xs" />
          <Btn onClick={saveSettings} data-testid="save-invoice-settings-btn"><Save size={16} /> Save Settings</Btn>
        </Card>
      )}

      {tab === "prices" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex gap-2">
              <Btn onClick={() => setPModal({ zone: unifiedPriceList ? 1 : zone, category: "", size: "Unit", price: "", active: true, newProduct: true })} data-testid="add-product-btn"><Plus size={16} /> Add Product</Btn>
              {!unifiedPriceList && <>
              {[1, 2].map((z) => <button key={z} onClick={() => setZone(z)} className={`px-4 py-2 rounded-lg text-sm font-semibold ${zone === z ? "bg-primary text-white" : "bg-white border border-border text-slate-600"}`}>Zone {z}</button>)}
              </>}
            </div>
            <Btn onClick={() => setPModal({ zone: unifiedPriceList ? 1 : zone, category: "Simple/Mix color", size: "", price: "", active: true })} data-testid="add-price-btn"><Plus size={16} /> Add Price</Btn>
          </div>
          <p className="mb-3 text-sm text-slate-500">Add a product with a name and price to make it immediately selectable in invoice product lists.</p>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                  <th className="px-4 py-3 font-semibold">Product / Category</th><th className="px-4 font-semibold">Size / Unit</th><th className="px-4 font-semibold text-right">Unit Price</th><th className="px-4 font-semibold text-center">Status</th><th className="px-4 font-semibold text-right">Actions</th>
                </tr></thead>
                <tbody>{zonePrices.map((p) => (
                  <tr key={p.id} className="border-b border-border/60 hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-semibold text-slate-700">{priceProductName(p.category)}</td>
                    <td className="px-4 font-mono text-slate-600">{p.size}</td>
                    <td className="px-4 text-right font-mono">{p.price == null ? <span className="text-red-600 text-xs font-semibold">NEEDS CONFIG</span> : fmtMoney(p.price)}</td>
                    <td className="px-4 text-center"><Badge cls={p.active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-500 border-slate-200"}>{p.active ? "Active" : "Inactive"}</Badge></td>
                    <td className="px-4 text-right whitespace-nowrap">
                      <button onClick={() => setPModal({ ...p, category: priceProductName(p.category), price: p.price == null ? "" : p.price })} className="text-slate-400 hover:text-primary p-1" aria-label={`Edit ${priceProductName(p.category)} ${p.size}`} data-testid={`edit-price-${p.id}`}><Pencil size={15} /></button>
                      <button onClick={() => deletePrice(p)} title="Permanently delete product price" className="ml-2 p-1 text-slate-400 hover:text-red-600" aria-label={`Permanently delete ${priceProductName(p.category)} ${p.size}`} data-testid={`delete-price-${p.id}`}><Trash2 size={15} /></button>
                    </td>
                  </tr>))}</tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === "drivers" && (
        <div>
          <div className="flex justify-end mb-4"><Btn onClick={() => setDModal({ name: "", preferences: "", size_pref: "small", active: true })} data-testid="add-driver-btn"><Plus size={16} /> Add Driver</Btn></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {drivers.map((d) => (
              <Card key={d.id} className="p-5">
                <div className="flex items-center justify-between mb-2"><h4 className="font-bold text-slate-800">{d.name}</h4>
                  <div className="flex items-center gap-2"><Badge cls="bg-blue-50 text-blue-700 border-blue-200">{d.size_pref}</Badge>
                    <button onClick={() => setDModal({ ...d })} className="text-slate-400 hover:text-primary"><Pencil size={15} /></button></div></div>
                <p className="text-sm text-slate-500">{d.preferences}</p>
              </Card>))}
          </div>
        </div>
      )}

      {tab === "diesel" && user?.is_admin && (
        <Card className="p-6 max-w-2xl space-y-4" data-testid="diesel-settings-tab">
          <div>
            <h3 className="font-bold text-slate-800 font-display">Diesel price · Kokstad</h3>
            <p className="text-sm text-slate-500 mt-1">Check the current local price on <a href="https://petrolprices.co.za/" target="_blank" rel="noreferrer" className="font-semibold text-primary underline">PetrolPrices.co.za</a>, then enter it here. Only an administrator can save a new price.</p>
          </div>
          <Input label="Diesel price per litre (R)" type="number" min="0" step="0.01" value={dieselPrice} onChange={(e) => setDieselPrice(e.target.value)} data-testid="diesel-price-input" />
          <p className="text-xs text-slate-500">Last updated: {s.diesel_updated_at ? fmtDateTime(s.diesel_updated_at) : "Never"}</p>
          <div><Btn onClick={saveDieselPrice} disabled={dieselSaving} data-testid="save-diesel-price-btn"><Save size={16} /> {dieselSaving ? "Saving..." : "Save Diesel Price"}</Btn></div>
        </Card>
      )}

      {tab === "access" && user?.is_owner && <AccessTab users={accessUsers} companies={companies} loading={accessLoading} currentUserId={user.id} isPrimaryOwner={user.is_primary_owner} onRoleChange={changeRole} onStatusChange={changeStatus} onRemove={setRemoveUser} onCreate={createAccessUser} onMakeOwner={makeOwner} />}

      {tab === "backups" && (
        <div className="space-y-4" data-testid="backups-tab">
          <Card className="p-5 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-800 font-display">Historical backups</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Daily copies are kept for 30 days and one monthly copy for 12 months. Backups cover all company databases; uploaded files are not included.
                </p>
              </div>
              <div className="flex gap-2">
                <Btn variant="outline" onClick={refreshBackups} disabled={backupsLoading}>
                  Refresh
                </Btn>
                <Btn onClick={createBackup} disabled={!backupStatus?.configured || !backupStatus?.tools_available || Boolean(backupAction)} data-testid="create-backup">
                  <Database size={16} /> {backupAction === "create" ? "Creating..." : "Backup now"}
                </Btn>
              </div>
            </div>
            {backupStatus && (!backupStatus.configured || !backupStatus.tools_available) && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
                <p className="font-semibold">Backups are not active yet.</p>
                <p className="mt-1">Choose a private S3-compatible archive such as Cloudflare R2, then configure these protected server variables:</p>
                <ul className="mt-2 list-disc pl-5 font-mono text-xs">
                  {backupStatus.missing_configuration.map((name) => <li key={name}>{name}</li>)}
                  {Object.entries(backupStatus.tools).filter(([, available]) => !available).map(([name]) => (
                    <li key={name}>MongoDB Database Tools ({name} executable)</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs">Never paste access keys into this page or send them in chat. Ask the hosting administrator to configure them as server secrets.</p>
              </div>
            )}
            {recoveryCopy && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
                <p className="font-semibold">Separate recovery copy created. Live data was not overwritten.</p>
                <p className="mt-1">Recovery ID: <span className="font-mono">{recoveryCopy.restore_id}</span></p>
                <p className="mt-1">Database names: <span className="font-mono break-all">{Object.values(recoveryCopy.databases).join(", ")}</span></p>
                <p className="mt-2 text-xs">This copy is isolated in MongoDB and is not opened as an editable workspace in the live app.</p>
              </div>
            )}
          </Card>
          <Card className="overflow-hidden">
            {backupsLoading ? <p className="p-5 text-sm text-slate-500">Loading backups...</p> : backups.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">No backup snapshots are available.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-500">
                    <th className="px-4 py-3">Snapshot</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Size</th><th className="px-4 py-3 text-right">Action</th>
                  </tr></thead>
                  <tbody>{backups.map((backup) => (
                    <tr key={backup.key} className="border-b border-border/60">
                      <td className="px-4 py-3 font-mono text-xs">{backup.key}</td>
                      <td className="px-4 py-3 capitalize">{backup.kind}</td>
                      <td className="px-4 py-3">{(backup.size_bytes / (1024 * 1024)).toFixed(2)} MB</td>
                      <td className="px-4 py-3 text-right">
                        <Btn variant="outline" disabled={Boolean(backupAction)} onClick={() => restoreBackup(backup)} data-testid={`restore-backup-${backup.kind}`}>
                          <RotateCcw size={15} /> {backupAction === backup.key ? "Restoring..." : "Restore to copy"}
                        </Btn>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "profiles" && (user?.is_owner || user?.is_company_owner) && (
        <div className="space-y-4 max-w-3xl" data-testid="profile-credentials-tab">
          <p className="text-sm text-slate-500">Passwords are stored securely and cannot be viewed. Check whether a supervisor password is configured and replace it here when needed.</p>
          <Card className="p-5 space-y-4" data-testid="supervisor-password-settings">
            <div>
              <h3 className="font-bold text-slate-800 font-display">Supervisor password</h3>
              <p className="mt-1 text-sm text-slate-500">{supervisorStatusLoading ? "Checking password status..." : supervisorConfigured ? "Configured for this profile. It is required to edit existing invoices and buyings." : "Not configured. Until one is set, active admin/owner passwords remain valid."}</p>
              <p className="mt-1 text-xs text-slate-500">Each company profile must use a different supervisor password. The current password cannot be displayed; set a new one to replace it.</p>
            </div>
            <Input label="New supervisor password (at least 8 characters)" type="password" minLength={8} autoComplete="new-password" value={supervisorPassword} onChange={(event) => setSupervisorPassword(event.target.value)} data-testid="supervisor-password-settings-input" />
            <Btn onClick={saveSupervisorPassword} disabled={supervisorSaving || supervisorPassword.length < 8} data-testid="save-supervisor-password">
              <Save size={16} /> {supervisorSaving ? "Saving..." : "Save supervisor password"}
            </Btn>
          </Card>
          {user?.is_owner && (profilesLoading ? <p className="text-sm text-slate-400 py-4">Loading profiles...</p> : profileAccounts.map((profile) => {
            const draft = profileDrafts[profile.id] || { userPassword: "", ownerPassword: "" };
            return (
              <Card key={profile.id} className="p-5 space-y-5" data-testid={`profile-credentials-${profile.id}`}>
                <div>
                  <h3 className="font-bold text-slate-800 font-display">{profile.name}</h3>
                  <p className="text-sm text-slate-500 mt-1">Owner and User sign in independently using username <b>{profile.username}</b>. The owner account has owner access only to this profile.</p>
                </div>
                {[
                  { type: "owner", label: "Owner", configured: profile.owner_configured, password: draft.ownerPassword },
                  { type: "user", label: "User", configured: profile.user_configured, password: draft.userPassword },
                ].map(({ type, label, configured, password }) => {
                  const savingId = `${profile.id}-${type}`;
                  return <div key={type} className="space-y-3 rounded-lg border border-border p-4">
                    <div>
                      <h4 className="font-semibold text-slate-800">{label} password</h4>
                      <p className="text-xs text-slate-500">{configured ? "Configured. Set a new password to replace it." : "Not configured. Saving creates this profile login."}</p>
                    </div>
                    <Input label={`New ${label.toLowerCase()} password (at least 8 characters)`} type="password" minLength={8}
                      value={password}
                      onChange={(event) => setProfileDrafts((current) => ({
                        ...current, [profile.id]: { ...draft, [`${type}Password`]: event.target.value },
                      }))}
                      data-testid={`profile-${type}-password-${profile.id}`} />
                    <Btn onClick={() => saveProfileCredentials(profile, type)}
                      disabled={profileSavingId === savingId || password.length < 8}
                      data-testid={`save-profile-${type}-${profile.id}`}>
                      <Save size={16} /> {profileSavingId === savingId ? "Saving..." : `Save ${label} password`}
                    </Btn>
                  </div>;
                })}
              </Card>
            );
          }))}
        </div>
      )}

      <Modal open={!!removeUser} onClose={() => !removingUser && setRemoveUser(null)} title="Remove Account">
        {removeUser && <div className="space-y-4">
          <p className="text-sm text-slate-600">Remove <b>{removeUser.email}</b>? Their sessions, device records and assistant conversations will also be deleted. This cannot be undone.</p>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setRemoveUser(null)} disabled={removingUser}>Cancel</Btn><Btn variant="danger" onClick={confirmRemoveUser} disabled={removingUser} data-testid="confirm-remove-user">{removingUser ? "Removing..." : "Remove account"}</Btn></div>
        </div>}
      </Modal>

      <Modal open={!!pModal} onClose={() => setPModal(null)} title={pModal?.id ? "Edit Product Price" : pModal?.newProduct ? "Add Product" : "Add Price"}>
        {pModal && <div className="space-y-4">
          <div className={`grid ${unifiedPriceList ? "grid-cols-1" : "grid-cols-2"} gap-3`}>
            {!unifiedPriceList && <Select label="Zone" value={pModal.zone} onChange={(e) => setPModal({ ...pModal, zone: Number(e.target.value) })}><option value={1}>Zone 1</option><option value={2}>Zone 2</option></Select>}
            <Input label={pModal.newProduct ? "Product name" : "Product / Category"} value={pModal.category} onChange={(e) => setPModal({ ...pModal, category: e.target.value })} placeholder={pModal.newProduct ? "Enter product name" : "Product or category"} data-testid="price-product-name" />
            </div>
            {pModal.newProduct ? <p className="text-xs text-slate-500">This product will be available on invoices after saving.</p> : <Input label="Size / Unit" value={pModal.size} onChange={(e) => setPModal({ ...pModal, size: e.target.value })} placeholder="910x100 or Unit" />}
          <Input label="Unit Price (R) — leave empty if unconfirmed" type="number" step="0.01" value={pModal.price} onChange={(e) => setPModal({ ...pModal, price: e.target.value })} data-testid="price-value-input" />
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-600"><input type="checkbox" checked={pModal.active} onChange={(e) => setPModal({ ...pModal, active: e.target.checked })} /> Active</label>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setPModal(null)} disabled={priceSaving}>Cancel</Btn><Btn onClick={savePrice} disabled={priceSaving} data-testid="save-price-btn">{priceSaving ? "Saving..." : "Save"}</Btn></div>
        </div>}
      </Modal>

      <Modal open={!!dModal} onClose={() => setDModal(null)} title={dModal?.id ? "Edit Driver" : "Add Driver"}>
        {dModal && <div className="space-y-4">
          <Input label="Name" value={dModal.name} onChange={(e) => setDModal({ ...dModal, name: e.target.value })} data-testid="driver-name-input" />
          <Select label="Size Preference" value={dModal.size_pref} onChange={(e) => setDModal({ ...dModal, size_pref: e.target.value })}>
            <option value="small">Small / Medium</option><option value="large">Large / Long-distance</option>
          </Select>
          <label className="block"><span className="block text-xs font-semibold text-slate-500 mb-1.5">Preferences</span>
            <textarea rows={3} value={dModal.preferences} onChange={(e) => setDModal({ ...dModal, preferences: e.target.value })} className="w-full rounded-lg border border-input px-3 py-2.5 text-sm" /></label>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-600"><input type="checkbox" checked={dModal.active} onChange={(e) => setDModal({ ...dModal, active: e.target.checked })} /> Active</label>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setDModal(null)}>Cancel</Btn><Btn onClick={saveDriver} data-testid="save-driver-btn">Save</Btn></div>
        </div>}
      </Modal>
    </div>
  );
}
