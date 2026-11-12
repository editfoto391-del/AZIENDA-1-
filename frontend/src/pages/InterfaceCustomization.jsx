import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown, ArrowUp, Eye, EyeOff, Plus, RotateCcw, Save, ShieldCheck, Trash2,
} from "lucide-react";
import { Badge, Btn, Card, Input, Modal, PageHeader, Select } from "@/components/common";
import { api, apiError } from "@/lib/api";
import { NAV_GROUPS, navigationLinksForCompany } from "@/lib/navigation";
import { useAuth } from "@/context/AuthContext";

const editableGroups = NAV_GROUPS.map((group) => ({
  ...group,
  items: group.items.filter((item) => !item.globalOwnerOnly),
}));
const defaultConfig = () => ({
  hidden_sections: [],
  section_labels: {},
  group_labels: {},
  group_order: editableGroups.map((group) => group.id),
  section_order: Object.fromEntries(editableGroups.map((group) => [
    group.id, group.items.map((item) => item.section),
  ])),
  custom_sections: [],
});

function groupsForCompany(companyId) {
  return editableGroups.filter((group) =>
    (!group.companyId || group.companyId === companyId)
    && (!group.companyIds || group.companyIds.includes(companyId))
  ).map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.companyId || item.companyId === companyId),
  }));
}

function orderedItems(group, config) {
  const order = config.section_order?.[group.id] || [];
  return [...group.items].sort((left, right) => order.indexOf(left.section) - order.indexOf(right.section));
}

function orderedGroups(config, companyId) {
  const order = config.group_order || [];
  return [...groupsForCompany(companyId)]
    .sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
}

export default function InterfaceCustomization() {
  const { user } = useAuth();
  const [companyId, setCompanyId] = useState(user?.company_id || "superiqfoam");
  const [companies, setCompanies] = useState([]);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [customSectionOpen, setCustomSectionOpen] = useState(false);
  const [newSection, setNewSection] = useState({ label: "", path: "" });
  const routeOptions = useMemo(() => navigationLinksForCompany(companyId), [companyId]);

  useEffect(() => {
    api.get("/companies/profiles")
      .then(setCompanies)
      .catch((error) => toast.error(apiError(error)));
  }, []);

  useEffect(() => {
    let active = true;
    setDraft(null);
    setLoading(true);
    setLoadError("");
    api.getUncached(`/interface-settings?company_id=${encodeURIComponent(companyId)}`)
      .then((config) => { if (active) setDraft(config); })
      .catch((error) => {
        if (active) {
          setLoadError(apiError(error));
          toast.error(apiError(error));
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId, loadAttempt]);

  const groups = useMemo(
    () => (draft ? orderedGroups(draft, companyId) : []),
    [draft, companyId],
  );
  const moveGroup = (groupId, index, direction) => {
    setDraft((current) => {
      const order = [...current.group_order];
      const visibleGroups = orderedGroups(current, companyId);
      const targetGroup = visibleGroups[index + direction];
      if (!targetGroup) return current;
      const sourceIndex = order.indexOf(groupId);
      const targetIndex = order.indexOf(targetGroup.id);
      [order[sourceIndex], order[targetIndex]] = [order[targetIndex], order[sourceIndex]];
      return { ...current, group_order: order };
    });
  };
  const moveSection = (group, index, direction) => {
    setDraft((current) => {
      const order = [...current.section_order[group.id]];
      const target = index + direction;
      [order[index], order[target]] = [order[target], order[index]];
      return { ...current, section_order: { ...current.section_order, [group.id]: order } };
    });
  };
  const setSectionVisible = (section, visible) => {
    setDraft((current) => ({
      ...current,
      hidden_sections: visible
        ? current.hidden_sections.filter((item) => item !== section)
        : [...new Set([...current.hidden_sections, section])],
    }));
  };
  const setCustomSection = (sectionId, key, value) => {
    setDraft((current) => ({
      ...current,
      custom_sections: current.custom_sections.map((section) => (
        section.id === sectionId ? { ...section, [key]: value } : section
      )),
    }));
  };
  const moveCustomSection = (index, direction) => {
    setDraft((current) => {
      const customSections = [...current.custom_sections];
      const target = index + direction;
      [customSections[index], customSections[target]] = [customSections[target], customSections[index]];
      return { ...current, custom_sections: customSections };
    });
  };
  const addCustomSection = (event) => {
    event.preventDefault();
    if (!newSection.label.trim() || !newSection.path) return;
    const option = routeOptions.find((item) => item.path === newSection.path);
    if (!option) {
      toast.error("Choose an existing page for this menu section");
      return;
    }
    const id = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setDraft((current) => ({
      ...current,
      custom_sections: [
        ...current.custom_sections,
        { id, label: newSection.label.trim(), path: option.path, access_section: option.section },
      ],
    }));
    setNewSection({ label: "", path: routeOptions[0]?.path || "" });
    setCustomSectionOpen(false);
  };
  const removeCustomSection = (sectionId) => {
    setDraft((current) => ({
      ...current,
      custom_sections: current.custom_sections.filter((section) => section.id !== sectionId),
      hidden_sections: current.hidden_sections.filter((section) => section !== `custom:${sectionId}`),
    }));
  };
  const setLabel = (key, value, group = false) => {
    const field = group ? "group_labels" : "section_labels";
    setDraft((current) => ({
      ...current,
      [field]: { ...current[field], [key]: value },
    }));
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const saved = await api.put(
        `/interface-settings?company_id=${encodeURIComponent(companyId)}`,
        draft,
      );
      setDraft(saved);
      window.dispatchEvent(new CustomEvent("erp:interface-settings-updated", {
        detail: { ...saved, company_id: companyId },
      }));
      toast.success(`The ${companies.find((company) => company.id === companyId)?.name || "company"} menu was updated`);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Interface customization"
        subtitle="Customize the navigation for each company profile independently."
      >
        <Select
          label="Company profile"
          value={companyId}
          disabled={loading || saving}
          onChange={(event) => setCompanyId(event.target.value)}
          data-testid="interface-company-select"
        >
          {(companies.length ? companies : [{ id: companyId, name: companyId }])
            .map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </Select>
        <Btn variant="outline" disabled={!draft || loading || saving} onClick={() => setDraft(defaultConfig())}>
          <RotateCcw size={16} /> Restore defaults
        </Btn>
        <Btn disabled={!draft || loading || saving} onClick={save} data-testid="save-interface-settings">
          <Save size={16} /> {saving ? "Saving..." : "Save changes"}
        </Btn>
      </PageHeader>

      <Card className="mb-5 flex items-start gap-3 p-4">
        <ShieldCheck className="mt-0.5 shrink-0 text-emerald-700" size={20} />
        <div className="text-sm text-slate-600">
          <p className="font-semibold text-slate-800">Global Owner controls</p>
          <p className="mt-1">
            Menu changes apply only to the selected company. Hiding a menu item does not change user permissions.
            New sections can link to existing pages; building new functionality still requires development.
          </p>
        </div>
      </Card>

      {loading ? <Card className="p-6 text-sm text-slate-500">Loading interface settings...</Card> : !draft ? (
        <Card className="space-y-3 p-6 text-sm text-red-700" role="alert">
          <p>Interface settings could not be loaded{loadError ? `: ${loadError}` : "."}</p>
          <Btn variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            <RotateCcw size={16} /> Retry
          </Btn>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="overflow-hidden" data-testid="interface-custom-sections">
            <div className="flex items-center justify-between gap-3 border-b border-border bg-slate-50 p-4">
              <div>
                <h2 className="font-bold text-slate-800">Custom menu sections</h2>
                <p className="mt-1 text-xs text-slate-500">Add shortcuts to existing pages for this company.</p>
              </div>
              <Btn
                type="button"
                disabled={saving || draft.custom_sections.length >= 20 || routeOptions.length === 0}
                onClick={() => {
                  setNewSection({ label: "", path: routeOptions[0]?.path || "" });
                  setCustomSectionOpen(true);
                }}
                data-testid="add-interface-section"
              >
                <Plus size={16} /> Create section
              </Btn>
            </div>
            {draft.custom_sections.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No custom sections for this company yet.</p>
            ) : (
              <div className="divide-y divide-border/70">
                {draft.custom_sections.map((section, index) => {
                  const hiddenKey = `custom:${section.id}`;
                  const visible = !draft.hidden_sections.includes(hiddenKey);
                  return (
                    <div key={section.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
                      <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                        <Input
                          label="Section name"
                          maxLength={48}
                          disabled={saving}
                          value={section.label}
                          onChange={(event) => setCustomSection(section.id, "label", event.target.value)}
                          data-testid={`custom-section-label-${section.id}`}
                        />
                        <Select
                          label="Opens page"
                          disabled={saving}
                          value={section.path}
                          onChange={(event) => {
                            const route = routeOptions.find((item) => item.path === event.target.value);
                            if (route) {
                              setCustomSection(section.id, "path", route.path);
                              setCustomSection(section.id, "access_section", route.section);
                            }
                          }}
                          data-testid={`custom-section-route-${section.id}`}
                        >
                          {routeOptions.map((option) => (
                            <option key={option.path} value={option.path}>{option.label}</option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => setSectionVisible(hiddenKey, !visible)}
                          aria-pressed={visible}
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-semibold ${visible ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-600"}`}
                          data-testid={`toggle-custom-section-${section.id}`}
                        >{visible ? <Eye size={15} /> : <EyeOff size={15} />}{visible ? "Visible" : "Hidden"}</button>
                        <button type="button" disabled={saving || index === 0} onClick={() => moveCustomSection(index, -1)} aria-label={`Move ${section.label} up`} className="rounded border border-border bg-white p-2 text-slate-600 disabled:opacity-40"><ArrowUp size={16} /></button>
                        <button type="button" disabled={saving || index === draft.custom_sections.length - 1} onClick={() => moveCustomSection(index, 1)} aria-label={`Move ${section.label} down`} className="rounded border border-border bg-white p-2 text-slate-600 disabled:opacity-40"><ArrowDown size={16} /></button>
                        <button type="button" disabled={saving} onClick={() => removeCustomSection(section.id)} aria-label={`Delete ${section.label}`} className="rounded border border-red-200 bg-white p-2 text-red-700 hover:bg-red-50 disabled:opacity-40" data-testid={`delete-custom-section-${section.id}`}><Trash2 size={16} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          {groups.map((group, groupIndex) => {
            const items = orderedItems(group, draft);
            return (
              <Card key={group.id} className="overflow-hidden" data-testid={`interface-group-${group.id}`}>
                <div className="flex flex-col gap-3 border-b border-border bg-slate-50 p-4 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Input
                      label="Menu group name"
                      maxLength={48}
                      disabled={saving}
                      value={draft.group_labels[group.id] ?? group.label}
                      onChange={(event) => setLabel(group.id, event.target.value, true)}
                      data-testid={`interface-group-label-${group.id}`}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge>{items.length} sections</Badge>
                    <button
                      type="button"
                      aria-label={`Move ${group.label} up`}
                      title="Move group up"
                      disabled={saving || groupIndex === 0}
                      onClick={() => moveGroup(group.id, groupIndex, -1)}
                      className="rounded border border-border bg-white p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                      data-testid={`move-interface-group-up-${group.id}`}
                    ><ArrowUp size={16} /></button>
                    <button
                      type="button"
                      aria-label={`Move ${group.label} down`}
                      title="Move group down"
                      disabled={saving || groupIndex === groups.length - 1}
                      onClick={() => moveGroup(group.id, groupIndex, 1)}
                      className="rounded border border-border bg-white p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                      data-testid={`move-interface-group-down-${group.id}`}
                    ><ArrowDown size={16} /></button>
                  </div>
                </div>
                <div className="divide-y divide-border/70">
                  {items.map((item, index) => {
                    const visible = !draft.hidden_sections.includes(item.section);
                    return (
                      <div key={item.section} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <item.icon className="shrink-0 text-primary" size={18} />
                          <div className="min-w-0 flex-1">
                            <Input
                              label="Menu label"
                              maxLength={48}
                              disabled={saving}
                              value={draft.section_labels[item.section] ?? item.label}
                              onChange={(event) => setLabel(item.section, event.target.value)}
                              data-testid={`interface-section-label-${item.section}`}
                            />
                          </div>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => setSectionVisible(item.section, !visible)}
                            aria-pressed={visible}
                            aria-label={`${visible ? "Hide" : "Show"} ${item.label}`}
                            className={`mt-5 inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-semibold ${visible ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-600"}`}
                            data-testid={`toggle-interface-section-${item.section}`}
                          >
                            {visible ? <Eye size={15} /> : <EyeOff size={15} />}
                            {visible ? "Visible" : "Hidden"}
                          </button>
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            aria-label={`Move ${item.label} up`}
                            title="Move section up"
                            disabled={saving || index === 0}
                            onClick={() => moveSection(group, index, -1)}
                            className="rounded border border-border bg-white p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                            data-testid={`move-interface-section-up-${item.section}`}
                          ><ArrowUp size={16} /></button>
                          <button
                            type="button"
                            aria-label={`Move ${item.label} down`}
                            title="Move section down"
                            disabled={saving || index === items.length - 1}
                            onClick={() => moveSection(group, index, 1)}
                            className="rounded border border-border bg-white p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                            data-testid={`move-interface-section-down-${item.section}`}
                          ><ArrowDown size={16} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Modal
        open={customSectionOpen}
        onClose={() => setCustomSectionOpen(false)}
        title="Create menu section"
      >
        <form className="space-y-4" onSubmit={addCustomSection} data-testid="create-interface-section-form">
          <p className="text-sm text-slate-600">
            This adds a company-specific shortcut to an existing page. It does not create new application features.
          </p>
          <Input
            label="Section name"
            autoFocus
            required
            maxLength={48}
            value={newSection.label}
            onChange={(event) => setNewSection((current) => ({ ...current, label: event.target.value }))}
            data-testid="new-interface-section-label"
          />
          <Select
            label="Page to open"
            required
            value={newSection.path}
            onChange={(event) => setNewSection((current) => ({ ...current, path: event.target.value }))}
            data-testid="new-interface-section-route"
          >
            {routeOptions.map((option) => (
              <option key={option.path} value={option.path}>{option.label}</option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => setCustomSectionOpen(false)}>Cancel</Btn>
            <Btn type="submit"><Plus size={16} /> Create section</Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
