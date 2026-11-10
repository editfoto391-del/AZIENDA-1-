import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { Badge, Btn, Card, Input, PageHeader } from "@/components/common";
import { api, apiError } from "@/lib/api";
import { NAV_GROUPS } from "@/lib/navigation";

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
});

function orderedItems(group, config) {
  const order = config.section_order?.[group.id] || [];
  return [...group.items].sort((left, right) => order.indexOf(left.section) - order.indexOf(right.section));
}

function orderedGroups(config) {
  const order = config.group_order || [];
  return [...editableGroups].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
}

export default function InterfaceCustomization() {
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.getUncached("/interface-settings")
      .then((config) => { if (active) setDraft(config); })
      .catch((error) => { if (active) toast.error(apiError(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const groups = useMemo(() => (draft ? orderedGroups(draft) : []), [draft]);
  const moveGroup = (index, direction) => {
    setDraft((current) => {
      const order = [...current.group_order];
      const target = index + direction;
      [order[index], order[target]] = [order[target], order[index]];
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
      const saved = await api.put("/interface-settings", draft);
      setDraft(saved);
      window.dispatchEvent(new CustomEvent("erp:interface-settings-updated", { detail: saved }));
      toast.success("The site navigation was updated for all companies");
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
        subtitle="Manage the navigation menu used across all company profiles."
      >
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
            These settings affect the menu for every company. Hiding a menu item does not change user permissions
            or block access through other authorized routes. You can rename, reorder, and enable existing sections;
            adding new features still requires development.
          </p>
        </div>
      </Card>

      {loading ? <Card className="p-6 text-sm text-slate-500">Loading interface settings...</Card> : !draft ? (
        <Card className="p-6 text-sm text-red-700" role="alert">
          Interface settings could not be loaded. Refresh the page and try again.
        </Card>
      ) : (
        <div className="space-y-4">
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
                      onClick={() => moveGroup(groupIndex, -1)}
                      className="rounded border border-border bg-white p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                      data-testid={`move-interface-group-up-${group.id}`}
                    ><ArrowUp size={16} /></button>
                    <button
                      type="button"
                      aria-label={`Move ${group.label} down`}
                      title="Move group down"
                      disabled={saving || groupIndex === groups.length - 1}
                      onClick={() => moveGroup(groupIndex, 1)}
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
    </div>
  );
}
