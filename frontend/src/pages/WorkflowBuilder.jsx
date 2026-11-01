import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, Bell, Building2, Check, ChevronDown, CircleAlert,
  CircleCheck, CirclePause, CirclePlay, ClipboardList, Clock3, Copy, GitBranch,
  History, Plus, ShieldCheck, Trash2, Workflow, X,
} from "lucide-react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Badge, Btn, Card, Input, PageHeader, Select, Textarea } from "@/components/common";

const EMPTY_WORKFLOW = {
  company_id: "",
  name: "",
  trigger: "",
  logic: "all",
  conditions: [],
  actions: [{ type: "create_notification", title: "", message: "" }],
  enabled: false,
};

const TABS = [
  { id: "overview", label: "Workflows", icon: Workflow },
  { id: "history", label: "Execution history", icon: History },
  { id: "outputs", label: "Outputs & approvals", icon: ClipboardList },
];

const WORKFLOW_TEMPLATES = [
  {
    name: "Large payment follow-up",
    trigger: "payment.recorded",
    logic: "all",
    conditions: [{ field: "amount", operator: "greater_than", value: 500 }],
    actions: [{ type: "create_follow_up_task", title: "Payment received · {{invoice_number}}", message: "Review payment of R {{amount}} by {{method}} for invoice {{invoice_number}}." }],
  },
  {
    name: "New invoice alert",
    trigger: "invoice.issued",
    logic: "all",
    conditions: [],
    actions: [{ type: "create_notification", title: "Invoice issued · {{number}}", message: "{{customer_name}} · R {{total}} · {{date}}" }],
  },
  {
    name: "Goods receipt inspection",
    trigger: "grv.pending_inspection",
    logic: "all",
    conditions: [],
    actions: [{ type: "request_global_owner_approval", title: "Inspect GRV {{grv_number}}", message: "{{supplier_name}} · {{item_count}} item lines · received {{received_date}}" }],
  },
  {
    name: "Purchase order placed",
    trigger: "purchase_order.ordered",
    logic: "all",
    conditions: [],
    actions: [{ type: "update_internal_report", title: "Purchase order {{reference}}", message: "Order for {{supplier_name}} placed. Expected {{expected_date}} · total R {{total}}." }],
  },
  {
    name: "Production completion follow-up",
    trigger: "production.completed",
    logic: "all",
    conditions: [],
    actions: [{ type: "create_follow_up_task", title: "Production complete · {{block_ref}}", message: "Check completed quantity {{quantity}} for production dated {{production_date}}." }],
  },
  {
    name: "Stock movement notice",
    trigger: "stock.movement_recorded",
    logic: "all",
    conditions: [],
    actions: [{ type: "create_notification", title: "Stock movement · {{product}} {{size}}", message: "{{type}} movement recorded: {{quantity}} units." }],
  },
  {
    name: "Delivery status report",
    trigger: "delivery.status_changed",
    logic: "all",
    conditions: [],
    actions: [{ type: "update_internal_report", title: "Delivery {{reference}} · {{status}}", message: "{{customer_name}} · {{size}} load · {{destination}}" }],
  },
  {
    name: "Expense review",
    trigger: "expense.recorded",
    logic: "all",
    conditions: [{ field: "amount", operator: "greater_than", value: 1000 }],
    actions: [{ type: "request_global_owner_approval", title: "Review expense · {{category}}", message: "{{description}} · R {{amount}} · {{date}}" }],
  },
  {
    name: "New supplier follow-up",
    trigger: "supplier.created",
    logic: "all",
    conditions: [],
    actions: [{ type: "create_follow_up_task", title: "Review supplier · {{name}}", message: "Review the new supplier profile for {{name}} in {{city}}." }],
  },
  {
    name: "New customer follow-up",
    trigger: "customer.created",
    logic: "all",
    conditions: [],
    actions: [{ type: "create_follow_up_task", title: "Welcome {{name}}", message: "Review the new customer profile for {{name}} in {{city}}." }],
  },
];

const TRIGGER_GROUPS = [
  { label: "Sales & customers", startsWith: ["invoice.", "payment.", "customer.", "order."] },
  { label: "Purchasing", startsWith: ["buying.", "supplier.", "purchase_order.", "grv."] },
  { label: "Operations & inventory", startsWith: ["stock.", "production.", "delivery.", "vehicle.", "vehicle_record.", "spare_part."] },
  { label: "People & fleet", startsWith: ["attendance.", "employee.", "piece_production.", "driver."] },
  { label: "Finance", startsWith: ["expense."] },
];

function companyName(companies, id) {
  return companies.find((company) => company.id === id)?.name || id;
}

function formatTime(value) {
  if (!value) return "No executions yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function resultStyle(result) {
  if (result === "success" || result === "dry_run_matched") return "bg-emerald-50 text-emerald-800 border-emerald-200";
  if (result === "partial" || result === "conditions_not_met") return "bg-amber-50 text-amber-800 border-amber-200";
  if (result === "running") return "bg-sky-50 text-sky-800 border-sky-200";
  return "bg-red-50 text-red-800 border-red-200";
}

function WorkflowStep({ number, title, caption, icon: Icon, children, last = false }) {
  return (
    <div className="relative grid grid-cols-[42px_minmax(0,1fr)] gap-3 sm:grid-cols-[54px_minmax(0,1fr)] sm:gap-4">
      <div className="flex flex-col items-center">
        <div className="z-10 flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-900/10 bg-[#102e25] text-emerald-50 shadow-md shadow-emerald-950/10">
          <Icon size={18} />
        </div>
        {!last && <div className="my-1 min-h-8 w-px flex-1 bg-gradient-to-b from-emerald-800/35 to-emerald-800/10" />}
      </div>
      <div className="pb-5">
        <div className="mb-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-800">Step {number}</p>
          <h3 className="mt-0.5 font-display text-base font-bold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">{caption}</p>
        </div>
        <Card className="space-y-4 p-4 sm:p-5">{children}</Card>
      </div>
    </div>
  );
}

function ConditionEditor({ condition, index, fields, operators, onChange, onRemove }) {
  const fieldType = fields[condition.field] || "text";
  const choices = operators[fieldType] || [];
  return (
    <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/80 p-3 sm:grid-cols-[1.1fr_1fr_1.2fr_auto] sm:items-end">
      <Select label={index === 0 ? "Field" : undefined} value={condition.field}
        onChange={(event) => {
          const nextField = event.target.value;
          const nextType = fields[nextField];
          onChange({ ...condition, field: nextField, operator: (operators[nextType] || ["equals"])[0], value: nextType === "boolean" ? false : "" });
        }}>
        {Object.keys(fields).map((field) => <option key={field} value={field}>{field.replaceAll("_", " ")}</option>)}
      </Select>
      <Select label={index === 0 ? "Operator" : undefined} value={condition.operator}
        onChange={(event) => onChange({ ...condition, operator: event.target.value })}>
        {choices.map((operator) => <option key={operator} value={operator}>{operator.replaceAll("_", " ")}</option>)}
      </Select>
      {["is_empty", "is_not_empty"].includes(condition.operator) ? (
        <div className="pb-2 text-xs text-slate-400">No value needed</div>
      ) : fieldType === "boolean" ? (
        <Select label={index === 0 ? "Value" : undefined} value={String(condition.value)}
          onChange={(event) => onChange({ ...condition, value: event.target.value === "true" })}>
          <option value="true">True</option><option value="false">False</option>
        </Select>
      ) : (
        <Input label={index === 0 ? "Value" : undefined}
          type={fieldType === "number" ? "number" : "text"}
          step={fieldType === "number" ? "any" : undefined}
          value={condition.value ?? ""}
          onChange={(event) => onChange({
            ...condition,
            value: fieldType === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value,
          })}
        />
      )}
      <button type="button" onClick={onRemove} aria-label="Remove condition"
        className="mb-1 inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-700">
        <X size={17} />
      </button>
    </div>
  );
}

function ActionEditor({ action, index, actions, onChange, onRemove }) {
  return (
    <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <Select label={`Action ${index + 1}`} value={action.type}
          onChange={(event) => onChange({ ...action, type: event.target.value })}>
          {actions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
        <Input label="Internal title (optional)" maxLength={120} value={action.title}
          onChange={(event) => onChange({ ...action, title: event.target.value })} />
      </div>
      <div className="flex gap-2">
        <Textarea label="Internal message" rows={3} maxLength={1000} value={action.message}
          onChange={(event) => onChange({ ...action, message: event.target.value })} />
        <button type="button" onClick={onRemove} disabled={actions.length === 1} aria-label="Remove action"
          className="mt-7 h-9 w-9 shrink-0 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-30">
          <X size={17} />
        </button>
      </div>
    </div>
  );
}

export default function WorkflowBuilder() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns] = useState([]);
  const [runTotals, setRunTotals] = useState({});
  const [outputs, setOutputs] = useState([]);
  const [outputTotals, setOutputTotals] = useState({});
  const [runPages, setRunPages] = useState({});
  const [outputPages, setOutputPages] = useState({});
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_WORKFLOW);
  const [testData, setTestData] = useState({});
  const [testResult, setTestResult] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState("");

  const companies = catalog?.companies || [];
  const selectedTrigger = catalog?.triggers?.find((item) => item.id === draft.trigger);
  const visibleWorkflows = useMemo(() => workflows.filter((item) =>
    companyFilter === "all" || item.company_id === companyFilter
  ), [companyFilter, workflows]);
  const visibleRuns = useMemo(() => runs.filter((item) =>
    companyFilter === "all" || item.company_id === companyFilter
  ), [companyFilter, runs]);
  const visibleOutputs = useMemo(() => outputs.filter((item) =>
    companyFilter === "all" || item.company_id === companyFilter
  ), [companyFilter, outputs]);
  const runsByWorkflow = useMemo(() => {
    const grouped = {};
    for (const run of runs) {
      if (!grouped[run.workflow_id]) grouped[run.workflow_id] = [];
      grouped[run.workflow_id].push(run);
    }
    return grouped;
  }, [runs]);

  const loadData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const currentCatalog = catalog || await api.get("/workflow-builder/catalog");
      if (!catalog) setCatalog(currentCatalog);
      const pages = await Promise.all(currentCatalog.companies.map(async (company) => {
        const [companyWorkflows, companyRuns, companyOutputs] = await Promise.all([
          api.get(`/workflow-builder?company_id=${encodeURIComponent(company.id)}`),
          api.get("/workflow-builder/runs", { company_id: company.id, page: 1, page_size: 30 }),
          api.get("/workflow-builder/outputs", { company_id: company.id, page: 1, page_size: 30 }),
        ]);
        return { companyId: company.id, workflows: companyWorkflows, runs: companyRuns, outputs: companyOutputs };
      }));
      setWorkflows(pages.flatMap((page) => page.workflows));
      setRuns(pages.flatMap((page) => page.runs.items));
      setRunTotals(Object.fromEntries(pages.map((page) => [page.companyId, page.runs.total])));
      setOutputs(pages.flatMap((page) => page.outputs.items));
      setOutputTotals(Object.fromEntries(pages.map((page) => [page.companyId, page.outputs.total])));
      setRunPages(Object.fromEntries(pages.map((page) => [page.companyId, 1])));
      setOutputPages(Object.fromEntries(pages.map((page) => [page.companyId, 1])));
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [catalog]);

  useEffect(() => { loadData(); }, [loadData]);

  const openNew = () => {
    setEditingId(null);
    setTestResult(null);
    setTestData({});
    setSelectedTemplate("");
    setDraft({ ...EMPTY_WORKFLOW, company_id: companyFilter === "all" ? (user?.company_id || companies[0]?.id || "") : companyFilter, trigger: catalog?.triggers?.[0]?.id || "" });
    setEditorOpen(true);
  };

  const openEdit = (workflow) => {
    setEditingId(workflow.id);
    setTestResult(null);
    setTestData({});
    setSelectedTemplate("");
    setDraft({
      company_id: workflow.company_id,
      name: workflow.name,
      trigger: workflow.trigger,
      logic: workflow.logic || "all",
      conditions: workflow.conditions || [],
      actions: workflow.actions || [],
      enabled: workflow.enabled === true,
    });
    setEditorOpen(true);
  };

  const applyTemplate = (templateIndex) => {
    setSelectedTemplate(templateIndex);
    if (templateIndex === "") return;
    const template = WORKFLOW_TEMPLATES[Number(templateIndex)];
    if (!template || !catalog?.triggers?.some((trigger) => trigger.id === template.trigger)) return;
    setDraft((current) => ({ ...current, ...template, company_id: current.company_id, enabled: false }));
    setTestData({});
    setTestResult(null);
  };

  const setCondition = (index, condition) => setDraft((current) => ({
    ...current,
    conditions: current.conditions.map((item, currentIndex) => currentIndex === index ? condition : item),
  }));
  const setAction = (index, action) => setDraft((current) => ({
    ...current,
    actions: current.actions.map((item, currentIndex) => currentIndex === index ? action : item),
  }));

  const saveWorkflow = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const request = editingId
        ? api.put(`/workflow-builder/${editingId}`, draft)
        : api.post("/workflow-builder", draft);
      await request;
      toast.success(editingId ? "Workflow updated" : "Workflow created");
      setEditorOpen(false);
      await loadData(false);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleWorkflow = async (workflow) => {
    try {
      await api.post(`/workflow-builder/${workflow.id}/status?company_id=${encodeURIComponent(workflow.company_id)}`, { enabled: !workflow.enabled });
      toast.success(workflow.enabled ? "Workflow paused" : "Workflow enabled");
      await loadData(false);
    } catch (error) { toast.error(apiError(error)); }
  };

  const duplicateWorkflow = async (workflow) => {
    try {
      await api.post(`/workflow-builder/${workflow.id}/duplicate?company_id=${encodeURIComponent(workflow.company_id)}`);
      toast.success("Disabled copy created");
      await loadData(false);
    } catch (error) { toast.error(apiError(error)); }
  };

  const removeWorkflow = async (workflow) => {
    if (!window.confirm(`Permanently delete “${workflow.name}”? Existing execution history will be retained.`)) return;
    try {
      await api.del(`/workflow-builder/${workflow.id}?company_id=${encodeURIComponent(workflow.company_id)}`);
      toast.success("Workflow deleted; execution history retained");
      await loadData(false);
    } catch (error) { toast.error(apiError(error)); }
  };

  const testWorkflow = async () => {
    if (!editingId || saving) return;
    const eventData = Object.fromEntries(Object.entries(testData).filter(([, value]) => value !== "" && value != null));
    setSaving(true);
    try {
      const result = await api.post(`/workflow-builder/${editingId}/test?company_id=${encodeURIComponent(draft.company_id)}`, { event_data: eventData });
      setTestResult(result);
      toast.success(result.matched ? "Dry run matched; no ERP records were changed" : "Dry run did not match; no ERP records were changed");
      await loadData(false);
    } catch (error) { toast.error(apiError(error)); }
    finally { setSaving(false); }
  };

  const decideApproval = async (output, decision) => {
    const note = decision === "rejected" ? window.prompt("Optional note for this decision") || "" : "";
    try {
      await api.post(`/workflow-builder/outputs/${output.id}/decision?company_id=${encodeURIComponent(output.company_id)}`, { decision, note });
      toast.success(`Approval request ${decision}`);
      await loadData(false);
    } catch (error) { toast.error(apiError(error)); }
  };

  const loadMore = async (kind) => {
    const currentCompanies = companyFilter === "all" ? companies : companies.filter((company) => company.id === companyFilter);
    const pageState = kind === "runs" ? runPages : outputPages;
    const nextPages = Object.fromEntries(currentCompanies.map((company) => [company.id, (pageState[company.id] || 1) + 1]));
    try {
      const batches = await Promise.all(currentCompanies.map((company) => api.get(
        kind === "runs" ? "/workflow-builder/runs" : "/workflow-builder/outputs",
        { company_id: company.id, page: nextPages[company.id], page_size: 30 },
      )));
      if (kind === "runs") {
        setRuns((items) => [...items, ...batches.flatMap((batch) => batch.items)]);
        setRunPages((pages) => ({ ...pages, ...nextPages }));
      } else {
        setOutputs((items) => [...items, ...batches.flatMap((batch) => batch.items)]);
        setOutputPages((pages) => ({ ...pages, ...nextPages }));
      }
    } catch (error) { toast.error(apiError(error)); }
  };

  const scopedCompanies = companyFilter === "all" ? companies : companies.filter((company) => company.id === companyFilter);
  const hasMoreRuns = scopedCompanies.some((company) =>
    runs.filter((run) => run.company_id === company.id).length < (runTotals[company.id] || 0)
  );
  const hasMoreOutputs = scopedCompanies.some((company) =>
    outputs.filter((output) => output.company_id === company.id).length < (outputTotals[company.id] || 0)
  );

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-10">
      <PageHeader title="WORKFLOW BUILDER" subtitle="Build safe, company-scoped automations from real ERP events.">
        <Btn onClick={openNew} data-testid="create-workflow"><Plus size={16} /> Create workflow</Btn>
      </PageHeader>

      <Card className="overflow-hidden border-emerald-950/10 bg-[linear-gradient(112deg,#0d2b22_0%,#174b3a_52%,#1f5a43_100%)] p-5 text-white sm:p-7">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
          <div className="max-w-2xl">
            <div className="mb-3 flex items-center gap-2 text-emerald-100/70"><Workflow size={16} /><span className="text-[10px] font-bold uppercase tracking-[0.2em]">Owner automation studio</span></div>
            <h2 className="font-display text-2xl font-bold sm:text-3xl">Turn ERP events into clear next steps.</h2>
            <p className="mt-2 text-sm leading-6 text-emerald-50/70">Every workflow is isolated to one company. Actions create internal drafts, flags or approval requests only; they never silently change financial or operational records.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge cls="border-white/15 bg-white/10 text-emerald-50"><ShieldCheck size={13} className="mr-1.5" /> Global Owner only</Badge>
            <Badge cls="border-white/15 bg-white/10 text-emerald-50"><Activity size={13} className="mr-1.5" /> Event-driven · no scheduler</Badge>
          </div>
        </div>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} onClick={() => setTab(id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${tab === id ? "bg-[#102e25] text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <Select label="Company scope" value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)} className="min-w-52">
          <option value="all">All companies</option>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </Select>
      </div>

      {tab === "overview" && (
        loading ? <Card className="p-12 text-center text-sm text-slate-400">Loading workflows…</Card> :
          visibleWorkflows.length === 0 ? (
            <Card className="flex flex-col items-center px-5 py-14 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-800"><GitBranch size={26} /></div>
              <h3 className="font-display text-lg font-bold text-slate-900">No workflows in this scope</h3>
              <p className="mt-1 max-w-md text-sm text-slate-500">Start with a real ERP event, add optional conditions, then prepare safe internal actions.</p>
              <Btn className="mt-5" onClick={openNew}><Plus size={16} /> Create workflow</Btn>
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {visibleWorkflows.map((workflow) => {
                const latest = workflow.last_execution || runsByWorkflow[workflow.id]?.[0];
                const trigger = catalog?.triggers?.find((item) => item.id === workflow.trigger)?.label || workflow.trigger;
                return (
                  <Card key={workflow.id} className="group overflow-hidden p-0 transition-all hover:-translate-y-0.5 hover:shadow-lg">
                    <div className={`h-1 ${workflow.enabled ? "bg-emerald-600" : "bg-slate-300"}`} />
                    <div className="space-y-4 p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Badge cls={workflow.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-600"}>
                              {workflow.enabled ? <><CirclePlay size={12} className="mr-1" /> Active</> : <><CirclePause size={12} className="mr-1" /> Paused</>}
                            </Badge>
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500"><Building2 size={12} />{companyName(companies, workflow.company_id)}</span>
                          </div>
                          <h3 className="truncate font-display text-lg font-bold text-slate-900">{workflow.name}</h3>
                          <p className="mt-1 text-sm text-slate-500">{trigger}</p>
                        </div>
                        <button type="button" onClick={() => openEdit(workflow)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-emerald-700/30 hover:bg-emerald-50">Edit flow</button>
                      </div>
                      <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3">
                        <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Flow steps</p><p className="mt-1 text-sm font-semibold text-slate-700">{workflow.conditions?.length || 0} conditions · {workflow.actions?.length || 0} actions</p></div>
                        <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Last execution</p><p className="mt-1 truncate text-sm font-semibold text-slate-700">{formatTime(latest?.completed_at || latest?.started_at)}</p></div>
                        <div className="col-span-2 flex items-center justify-between gap-2 border-t border-slate-200/80 pt-2">
                          <span className="text-xs text-slate-500">Last result</span>
                          {latest ? <Badge cls={resultStyle(latest.result)}>{latest.result.replaceAll("_", " ")}</Badge> : <span className="text-xs text-slate-400">Not run yet</span>}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                        <Btn variant="outline" className="px-3 py-2 text-xs" onClick={() => toggleWorkflow(workflow)}>
                          {workflow.enabled ? <><CirclePause size={14} /> Pause</> : <><CirclePlay size={14} /> Enable</>}
                        </Btn>
                        <Btn variant="ghost" className="px-3 py-2 text-xs" onClick={() => duplicateWorkflow(workflow)}><Copy size={14} /> Duplicate</Btn>
                        <Btn variant="ghost" className="px-3 py-2 text-xs text-red-700 hover:bg-red-50" onClick={() => removeWorkflow(workflow)}><Trash2 size={14} /> Delete</Btn>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )
      )}

      {tab === "history" && (
        <div className="space-y-3">
          {visibleRuns.length === 0 ? <Card className="p-10 text-center text-sm text-slate-400">No executions recorded yet.</Card> : visibleRuns.map((run) => (
            <Card key={run.id} className="space-y-4 p-4 sm:p-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <div className="flex flex-wrap items-center gap-2"><h3 className="font-display font-bold text-slate-900">{run.workflow_name}</h3><Badge cls={resultStyle(run.result)}>{run.dry_run ? "dry run · " : ""}{run.result.replaceAll("_", " ")}</Badge></div>
                  <p className="mt-1 text-xs text-slate-500">{companyName(companies, run.company_id)} · {run.trigger} · {formatTime(run.started_at)} · {run.duration_ms ?? 0} ms</p>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-slate-500"><Clock3 size={14} />{run.completed_at ? formatTime(run.completed_at) : "In progress"}</div>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Conditions evaluated</p>
                  {run.conditions_evaluated?.length ? run.conditions_evaluated.map((condition, index) => (
                    <p key={`${condition.field}-${index}`} className="flex items-center gap-2 py-1 text-xs text-slate-600">
                      {condition.matched ? <CircleCheck size={14} className="text-emerald-700" /> : <CircleAlert size={14} className="text-amber-700" />}
                      {condition.field.replaceAll("_", " ")} {condition.operator.replaceAll("_", " ")} · {condition.matched ? "matched" : "not matched"}
                    </p>
                  )) : <p className="text-xs text-slate-400">No conditions configured</p>}
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Actions</p>
                  {run.actions_attempted?.length ? run.actions_attempted.map((action, index) => (
                    <p key={`${action.type}-${index}`} className="flex items-center gap-2 py-1 text-xs text-slate-600">
                      {action.status === "completed" ? <Check size={14} className="text-emerald-700" /> : action.status === "failed" ? <X size={14} className="text-red-700" /> : <Activity size={14} className="text-sky-700" />}
                      {(catalog?.actions?.find((item) => item.id === action.type)?.label || action.type)} · {action.status}
                    </p>
                  )) : <p className="text-xs text-slate-400">No actions attempted</p>}
                  {!!run.actions_requiring_approval?.length && <p className="mt-2 text-xs font-semibold text-amber-800">Approval requested · {run.actions_requiring_approval.length}</p>}
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Errors</p>
                  {run.error_details?.length ? run.error_details.map((error, index) => <p key={index} className="break-words text-xs text-red-700">{error}</p>) : <p className="text-xs text-slate-400">No errors</p>}
                </div>
              </div>
            </Card>
          ))}
          {hasMoreRuns && <div className="flex justify-center"><Btn variant="outline" onClick={() => loadMore("runs")}>Load older executions <ChevronDown size={15} /></Btn></div>}
        </div>
      )}

      {tab === "outputs" && (
        <div className="space-y-3">
          {visibleOutputs.length === 0 ? <Card className="p-10 text-center text-sm text-slate-400">No workflow outputs or approval requests yet.</Card> : visibleOutputs.map((output) => (
            <Card key={output.id} className="flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-start sm:p-5">
              <div className="flex min-w-0 gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
                  {output.type === "create_notification" ? <Bell size={18} /> : output.type === "request_global_owner_approval" ? <ShieldCheck size={18} /> : <ClipboardList size={18} />}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-900">{output.title}</h3><Badge cls={output.status === "pending" ? "border-amber-200 bg-amber-50 text-amber-800" : output.status === "rejected" ? "border-red-200 bg-red-50 text-red-800" : "border-slate-200 bg-slate-100 text-slate-600"}>{output.status}</Badge></div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">{output.message}</p>
                  <p className="mt-2 text-xs text-slate-400">{companyName(companies, output.company_id)} · {output.workflow_name} · {formatTime(output.created_at)}</p>
                  {output.decision_note && <p className="mt-2 text-xs text-slate-500">Decision note: {output.decision_note}</p>}
                </div>
              </div>
              {output.type === "request_global_owner_approval" && output.status === "pending" && (
                <div className="flex shrink-0 gap-2">
                  <Btn variant="outline" className="px-3 py-2 text-xs" onClick={() => decideApproval(output, "rejected")}>Reject</Btn>
                  <Btn className="px-3 py-2 text-xs" onClick={() => decideApproval(output, "approved")}><Check size={14} /> Mark approved</Btn>
                </div>
              )}
            </Card>
          ))}
          {hasMoreOutputs && <div className="flex justify-center"><Btn variant="outline" onClick={() => loadMore("outputs")}>Load older outputs <ChevronDown size={15} /></Btn></div>}
        </div>
      )}

      {editorOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/55 p-2 backdrop-blur-sm sm:p-5">
          <div className="mx-auto my-2 max-w-5xl overflow-hidden rounded-2xl border border-white/60 bg-[#f7f8f6] shadow-2xl sm:my-4">
            <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-white/10 bg-[#102e25] px-4 py-4 text-white sm:px-7">
              <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-100/60">Visual flow editor</p><h2 className="mt-1 font-display text-xl font-bold">{editingId ? "Edit workflow" : "Create workflow"}</h2></div>
              <button type="button" onClick={() => setEditorOpen(false)} aria-label="Close editor" className="rounded-full p-2 text-emerald-50/70 hover:bg-white/10 hover:text-white"><X size={21} /></button>
            </div>
            <form onSubmit={saveWorkflow} className="p-4 sm:p-7">
              <div className="mb-4">
                <Select label="Start with a workflow template" value={selectedTemplate} onChange={(event) => applyTemplate(event.target.value)}>
                  <option value="">Build from scratch</option>
                  {WORKFLOW_TEMPLATES.map((template, index) => <option key={template.name} value={index}>{template.name}</option>)}
                </Select>
              </div>
              <div className="mb-6 grid gap-3 sm:grid-cols-[1fr_0.8fr_auto] sm:items-end">
                <Input label="Workflow name" required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Follow up on large payments" />
                <Select label="Company scope" required value={draft.company_id} onChange={(event) => setDraft({ ...draft, company_id: event.target.value })}>
                  <option value="" disabled>Select company</option>
                  {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                </Select>
                <label className="mb-2 inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="h-4 w-4 accent-emerald-800" />
                  Enable after save
                </label>
              </div>

              <div className="space-y-1">
                <WorkflowStep number="01" title="Trigger" caption="When a verified ERP event occurs." icon={Activity}>
                  <Select label="Start when" required value={draft.trigger} onChange={(event) => {
                    setDraft({ ...draft, trigger: event.target.value, conditions: [] });
                    setTestData({});
                    setTestResult(null);
                  }}>
                    {TRIGGER_GROUPS.map((group) => {
                      const groupTriggers = (catalog?.triggers || []).filter((trigger) =>
                        group.startsWith.some((prefix) => trigger.id.startsWith(prefix))
                      );
                      return groupTriggers.length ? (
                        <optgroup key={group.label} label={group.label}>
                          {groupTriggers.map((trigger) => <option key={trigger.id} value={trigger.id}>{trigger.label}</option>)}
                        </optgroup>
                      ) : null;
                    })}
                  </Select>
                  <p className="text-xs leading-5 text-slate-500">Events are emitted only after the ERP operation has persisted successfully. Data stays within the selected company.</p>
                </WorkflowStep>

                <WorkflowStep number="02" title="Conditions" caption="Optional rules evaluated with safe, typed operators." icon={GitBranch}>
                  {draft.conditions.length > 1 && <Select label="Match conditions" value={draft.logic} onChange={(event) => setDraft({ ...draft, logic: event.target.value })}><option value="all">All conditions (AND)</option><option value="any">Any condition (OR)</option></Select>}
                  {!draft.conditions.length && <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-500">No conditions — every event for this trigger will match.</p>}
                  <div className="space-y-2">
                    {draft.conditions.map((condition, index) => (
                      <ConditionEditor key={`${index}-${condition.field}`} condition={condition} index={index}
                        fields={selectedTrigger?.fields || {}} operators={catalog?.operators || {}}
                        onChange={(value) => setCondition(index, value)}
                        onRemove={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, currentIndex) => currentIndex !== index) })} />
                    ))}
                  </div>
                  <Btn type="button" variant="outline" className="px-3 py-2 text-xs" disabled={!selectedTrigger || draft.conditions.length >= 20}
                    onClick={() => {
                      const [field, type] = Object.entries(selectedTrigger.fields)[0] || ["", "text"];
                      setDraft({ ...draft, conditions: [...draft.conditions, { field, operator: (catalog.operators[type] || ["equals"])[0], value: type === "boolean" ? false : "" }] });
                    }}><Plus size={14} /> Add condition</Btn>
                </WorkflowStep>

                <WorkflowStep number="03" title="Actions" caption="Prepare internal outputs; no silent changes to ERP records." icon={Bell} last>
                  <div className="space-y-3">
                    {draft.actions.map((action, index) => (
                      <ActionEditor key={index} action={action} index={index} actions={catalog?.actions || []}
                        onChange={(value) => setAction(index, value)}
                        onRemove={() => setDraft({ ...draft, actions: draft.actions.filter((_, currentIndex) => currentIndex !== index) })} />
                    ))}
                  </div>
                  <Btn type="button" variant="outline" className="px-3 py-2 text-xs" disabled={draft.actions.length >= 10}
                    onClick={() => setDraft({ ...draft, actions: [...draft.actions, { type: catalog?.actions?.[0]?.id || "create_notification", title: "", message: "" }] })}>
                    <Plus size={14} /> Add action
                  </Btn>
                  {selectedTrigger && <p className="text-xs leading-5 text-slate-500">
                    Personalise with approved event values: {Object.keys(selectedTrigger.fields).map((field) => <code key={field} className="mx-0.5 rounded bg-white px-1 py-0.5 text-[10px] text-emerald-900">{`{{${field}}}`}</code>)}
                  </p>}
                </WorkflowStep>
              </div>

              {editingId && (
                <Card className="mb-5 space-y-4 border-emerald-900/10 p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800"><Activity size={17} /></div>
                    <div><h3 className="font-display font-bold text-slate-900">Dry-run this workflow</h3><p className="text-xs text-slate-500">Use sample event values. This only records a dry-run entry; it does not create workflow outputs or change ERP records.</p></div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {Object.entries(selectedTrigger?.fields || {}).map(([field, type]) => (
                      type === "boolean" ? (
                        <Select key={field} label={field.replaceAll("_", " ")} value={String(testData[field] ?? "")}
                          onChange={(event) => setTestData({ ...testData, [field]: event.target.value === "" ? "" : event.target.value === "true" })}>
                          <option value="">Not supplied</option><option value="true">True</option><option value="false">False</option>
                        </Select>
                      ) : (
                        <Input key={field} label={field.replaceAll("_", " ")} type={type === "number" ? "number" : "text"}
                          step={type === "number" ? "any" : undefined} value={testData[field] ?? ""}
                          onChange={(event) => setTestData({ ...testData, [field]: type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value })} />
                      )
                    ))}
                  </div>
                  <Btn type="button" variant="outline" disabled={saving} onClick={testWorkflow}><CirclePlay size={15} /> Run dry test</Btn>
                  {testResult && <div className="rounded-lg border border-emerald-100 bg-emerald-50/70 p-3 text-sm">
                    <p className="font-semibold text-emerald-900">{testResult.matched ? "Conditions matched" : "Conditions did not match"} · no records changed</p>
                    <p className="mt-1 text-xs text-emerald-800">{testResult.actions.length} planned action(s)</p>
                  </div>}
                </Card>
              )}

              <div className="flex flex-col-reverse justify-between gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center">
                <p className="max-w-lg text-xs leading-5 text-slate-500"><ShieldCheck size={13} className="mr-1 inline text-emerald-800" /> Business-critical actions are deliberately excluded. Outputs are isolated drafts, internal notes or approval requests.</p>
                <div className="flex justify-end gap-2"><Btn type="button" variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Btn><Btn type="submit" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create workflow"}</Btn></div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
