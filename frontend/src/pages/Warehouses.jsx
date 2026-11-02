import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { BedDouble, ClipboardList, FlaskConical, Layers3, MessageCircle, PackageCheck, Plus, Save, Scissors, Trash2, TriangleAlert, Truck, Warehouse } from "lucide-react";
import { Btn, Card, Empty, Input, Modal, PageHeader } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";
import { warehouseReportMetrics, warehouseReportTotalsForDate } from "@/lib/warehouseReports.mjs";

const WAREHOUSES = [
  { id: "A" },
  { id: "B" },
  { id: "C" },
];

const REPORT_SECTIONS = [
  {
    key: "chemicals",
    title: "Chemical usage count",
    icon: FlaskConical,
    description: "Record each chemical used and its quantity.",
    fields: [
      { key: "chemical", label: "Chemical" },
      { key: "quantity", label: "Quantity", numeric: true },
      { key: "unit", label: "Unit (e.g. kg, L)" },
    ],
  },
  {
    key: "manufactured_blocks",
    title: "Manufactured blocks",
    icon: Layers3,
    description: "Record the type, size and number of blocks produced.",
    fields: [
      { key: "block_type", label: "Block type" },
      { key: "size", label: "Block size" },
      { key: "quantity", label: "Quantity", numeric: true, integer: true },
    ],
  },
  {
    key: "foam_cut",
    title: "Foam cut",
    icon: Scissors,
    description: "Record cut sizes and the amount produced.",
    fields: [
      { key: "size", label: "Cut size" },
      { key: "quantity", label: "Quantity", numeric: true },
      { key: "unit", label: "Unit (e.g. m, m2, m3)" },
    ],
  },
  {
    key: "damaged_blocks",
    title: "Damaged and broken blocks",
    icon: TriangleAlert,
    description: "Record the type, size and number of damaged blocks.",
    fields: [
      { key: "block_type", label: "Block type" },
      { key: "size", label: "Block size" },
      { key: "quantity", label: "Quantity", numeric: true, integer: true },
    ],
  },
  {
    key: "sheets_cut",
    title: "Sheets cut",
    icon: PackageCheck,
    description: "Record each sheet size and the number cut.",
    fields: [
      { key: "size", label: "Sheet size" },
      { key: "quantity", label: "Quantity", numeric: true, integer: true },
    ],
  },
];

const WAREHOUSE_B_REPORT_SECTIONS = [
  {
    key: "foam_received",
    title: "Foam received",
    icon: Truck,
    description: "Record the amount of foam received.",
    fields: [
      { key: "quantity", label: "Quantity", numeric: true },
      { key: "unit", label: "Unit (e.g. m, m2, m3, blocks)" },
    ],
  },
  {
    key: "mattresses_received",
    title: "Mattresses received",
    icon: BedDouble,
    description: "Record quantities received for each mattress size.",
    fields: [
      { key: "size", label: "Mattress size" },
      { key: "quantity", label: "Quantity", numeric: true, integer: true },
    ],
  },
  {
    key: "mattresses_completed",
    title: "Mattresses completed and bundled",
    icon: PackageCheck,
    description: "Record fully completed mattresses, bundled and ready for dispatch.",
    fields: [
      { key: "size", label: "Mattress size" },
      { key: "quantity", label: "Quantity", numeric: true, integer: true },
    ],
  },
];

const WAREHOUSE_C_REPORT_SECTIONS = [
  {
    key: "completed_stock",
    title: "Completed stock put into warehouse",
    icon: PackageCheck,
    description: "Record the size and quantity of completed stock added to Warehouse C.",
    fields: [
      { key: "size", label: "Stock size" },
      { key: "quantity", label: "Quantity", numeric: true, integer: true },
    ],
  },
  {
    key: "dispatches",
    title: "Customer stock loaded and dispatched",
    icon: Truck,
    description: "Add one row per size. Repeat the customer and invoice for each size on the same invoice.",
    fields: [
      { key: "customer_name", label: "Customer name" },
      { key: "invoice_number", label: "Invoice number" },
      { key: "size", label: "Stock size" },
      { key: "ordered_quantity", label: "Quantity ordered", numeric: true, integer: true },
      { key: "loaded_quantity", label: "Quantity loaded", numeric: true, integer: true, allowZero: true },
    ],
  },
];

const blankLine = (section) => Object.fromEntries(section.fields.map(({ key }) => [key, ""]));
const blankReport = (sections) => ({
  date: today(),
  notes: "",
  ...Object.fromEntries(sections.map((section) => [section.key, [blankLine(section)]])),
});

function ReportLineSection({ section, lines, onChange }) {
  const Icon = section.icon;
  return (
    <Card className="p-4 sm:p-5" data-testid={`warehouse-report-section-${section.key}`}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
          <Icon size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-display text-base font-bold text-slate-800">{section.title}</h2>
          <p className="mt-1 text-xs text-slate-500">{section.description}</p>
        </div>
      </div>
      <div className="space-y-3">
        {lines.map((line, index) => (
          <div
            key={index}
            className="grid items-end gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 xl:grid-cols-4"
            data-testid={`${section.key}-row-${index}`}
          >
            {section.fields.map((field) => (
              <Input
                key={field.key}
                label={field.label}
                type={field.numeric ? "number" : "text"}
                min={field.numeric ? "0" : undefined}
                step={field.integer ? "1" : field.numeric ? "any" : undefined}
                value={line[field.key]}
                onChange={(event) => onChange(index, field.key, event.target.value)}
                data-testid={`${section.key}-${field.key}-${index}`}
              />
            ))}
            {lines.length > 1 && (
              <Btn
                type="button"
                variant="outline"
                className="sm:col-span-2 xl:col-span-1"
                onClick={() => onChange(index, null, null)}
                aria-label={`Remove ${section.title.toLowerCase()} row ${index + 1}`}
                data-testid={`${section.key}-remove-${index}`}
              >
                <Trash2 size={16} /> Remove
              </Btn>
            )}
          </div>
        ))}
      </div>
      <Btn
        type="button"
        variant="outline"
        className="mt-4"
        onClick={() => onChange(null, null, null)}
        data-testid={`${section.key}-add-row`}
      >
        <Plus size={16} /> Add row
      </Btn>
    </Card>
  );
}

function reportLineSummary(line) {
  if (line.customer_name) {
    return `${line.customer_name} · Invoice ${line.invoice_number} · ${line.size}: ${line.loaded_quantity} loaded / ${line.ordered_quantity} ordered`;
  }
  const quantity = `${line.quantity} ${line.unit || ""}`.trim();
  if (line.chemical) return `${line.chemical}: ${quantity}`;
  if (line.block_type) return `${line.block_type} · ${line.size}: ${line.quantity}`;
  if (line.size) return `${line.size}: ${quantity}`;
  return quantity;
}

function WarehouseReportSummary({ warehouseId, report, date }) {
  return (
    <Card className="border-emerald-200 bg-emerald-50/40 p-4 sm:p-5" data-testid={`warehouse-${warehouseId.toLowerCase()}-report-summary`}>
      <div className="mb-4 flex items-center gap-2">
        <ClipboardList size={18} className="text-emerald-800" aria-hidden="true" />
        <h2 className="font-display text-base font-bold text-slate-800">Daily report totals</h2>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Totals include saved reports and current entries for {date}.
      </p>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {warehouseReportMetrics(warehouseId, report).map((metric) => (
          <div key={metric.label} className="min-w-0 rounded-lg border border-emerald-100 bg-white/80 p-3">
            <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{metric.label}</dt>
            <dd className="mt-1 break-words text-sm font-semibold text-slate-800">{metric.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default function Warehouses() {
  const { user } = useAuth();
  const { warehouseId } = useParams();
  const manufacturingProfile = user?.company_id === "iqfoam-manufactoring";
  const reportSections = warehouseId === "B"
    ? WAREHOUSE_B_REPORT_SECTIONS
    : warehouseId === "C" ? WAREHOUSE_C_REPORT_SECTIONS : REPORT_SECTIONS;
  const canAccessWarehouseA = manufacturingProfile && (
    !user?.is_worker
    || (user.allowed_sections?.includes("warehouses") && (user.warehouse_ids || []).includes(warehouseId))
  );
  const canAccessReports = ["A", "B", "C"].includes(warehouseId) && canAccessWarehouseA;
  const canDeleteReports = !user?.is_worker && (user?.is_owner || user?.is_company_owner);
  const selectedWarehouse = WAREHOUSES.find((warehouse) => warehouse.id === warehouseId);
  const canLoadReports = canAccessReports;
  const [form, setForm] = useState(() => blankReport(reportSections));
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingReportId, setDeletingReportId] = useState(null);
  const [sharingReportId, setSharingReportId] = useState(null);
  const [whatsappDraft, setWhatsappDraft] = useState(null);
  const reportTotals = warehouseReportTotalsForDate(form.date, form, reports);

  useEffect(() => {
    setForm(blankReport(reportSections));
    setReports([]);
  }, [warehouseId]);

  const loadReports = async () => {
    setLoadingReports(true);
    try {
      setReports(await api.getUncached(`/warehouses/${warehouseId}/reports`));
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setLoadingReports(false);
    }
  };

  useEffect(() => {
    if (canLoadReports) loadReports();
  }, [canLoadReports, warehouseId]);

  if (!manufacturingProfile || (
    user?.is_worker
    && (!user.allowed_sections?.includes("warehouses"))
  )) {
    return <Navigate to="/" replace />;
  }

  const workerWarehouseHome = `/warehouses/${user?.warehouse_ids?.[0] || "chemical"}`;
  if (warehouseId && (!selectedWarehouse || (user?.is_worker && !(user.warehouse_ids || []).includes(warehouseId)))) {
    return <Navigate to={user?.is_worker ? workerWarehouseHome : "/warehouses"} replace />;
  }
  if (!warehouseId && user?.is_worker) {
    return <Navigate to={workerWarehouseHome} replace />;
  }

  const changeLine = (section, index, field, value) => {
    setForm((current) => {
      const lines = [...(current[section.key] || [blankLine(section)])];
      if (index === null) lines.push(blankLine(section));
      else if (field === null) lines.splice(index, 1);
      else lines[index] = { ...lines[index], [field]: value };
      return { ...current, [section.key]: lines };
    });
  };

  const saveReport = async (event) => {
    event.preventDefault();
    if (saving) return;

    const report = { date: form.date, notes: form.notes.trim() };
    for (const section of reportSections) {
      const entries = (form[section.key] || []).filter((line) =>
        section.fields.some(({ key }) => String(line[key] ?? "").trim() !== "")
      );
      report[section.key] = [];
      for (const [index, line] of entries.entries()) {
        const normalizedLine = {};
        for (const field of section.fields) {
          const value = String(line[field.key] ?? "").trim();
          if (!value) {
            toast.error(`Complete ${field.label.toLowerCase()} in ${section.title}, row ${index + 1}.`);
            return;
          }
          if (field.numeric) {
            const quantity = Number(value);
            if (
              !Number.isFinite(quantity)
              || quantity < (field.allowZero ? 0 : 1)
              || (field.integer && !Number.isInteger(quantity))
            ) {
              toast.error(`Enter a valid ${field.integer ? "whole-number " : ""}quantity in ${section.title}, row ${index + 1}.`);
              return;
            }
            normalizedLine[field.key] = quantity;
          } else {
            normalizedLine[field.key] = value;
          }
        }
        report[section.key].push(normalizedLine);
      }
    }

    if (!reportSections.some(({ key }) => report[key].length > 0)) {
      toast.error("Add at least one warehouse activity before saving.");
      return;
    }
    if (warehouseId === "C") {
      const invalidDispatch = report.dispatches.find((dispatch) => dispatch.loaded_quantity > dispatch.ordered_quantity);
      if (invalidDispatch) {
        toast.error("Loaded quantity cannot exceed the ordered quantity.");
        return;
      }
      report.total_quantity_loaded = report.dispatches.reduce((total, dispatch) => total + dispatch.loaded_quantity, 0);
    }

    setSaving(true);
    try {
      await api.post(`/warehouses/${warehouseId}/reports`, report);
      toast.success(`Warehouse ${warehouseId} report saved.`);
      setForm(blankReport(reportSections));
      await loadReports();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteReport = async (report) => {
    if (!window.confirm(`Permanently delete the Warehouse ${warehouseId} daily report for ${report.date}? This cannot be undone.`)) return;
    if (deletingReportId) return;
    setDeletingReportId(report.id);
    try {
      await api.del(`/warehouses/${warehouseId}/reports/${report.id}`);
      setReports((current) => current.filter((item) => item.id !== report.id));
      toast.success(`Warehouse ${warehouseId} report deleted.`);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setDeletingReportId(null);
    }
  };

  const sendWarehouseReportViaWhatsApp = async (report) => {
    if (sharingReportId) return;
    setSharingReportId(report.id);
    try {
      const { token } = await api.post(
        `/warehouses/${warehouseId}/reports/${report.id}/share-link`,
        {},
      );
      const link = `${window.location.origin}/shared-warehouse-report/${encodeURIComponent(token)}`;
      const message = `Hello, view or download the Warehouse ${warehouseId} daily report PDF for ${report.date} here: ${link}`;
      setWhatsappDraft({
        url: `https://wa.me/27710222222?text=${encodeURIComponent(message)}`,
        warehouseId,
        date: report.date,
      });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSharingReportId(null);
    }
  };

  if (["A", "B", "C"].includes(warehouseId)) {
    return (
      <div className="dashboard-stagger space-y-6">
        <PageHeader
          title={`Warehouse ${warehouseId}`}
          subtitle={{
            A: "Daily manufacturing and material usage report",
            B: "Daily foam and mattress report",
            C: "Completed stock, customer orders and dispatch report",
          }[warehouseId]}
        />
        <form onSubmit={saveReport} className="space-y-4">
          <Card className="p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Report date"
                type="date"
                value={form.date}
                onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
                required
                data-testid="warehouse-report-date"
              />
              <Input
                label="Notes (optional)"
                value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                maxLength={2000}
                data-testid="warehouse-report-notes"
              />
            </div>
          </Card>
          <WarehouseReportSummary warehouseId={warehouseId} report={reportTotals} date={form.date} />
          {reportSections.map((section) => (
            <ReportLineSection
              key={section.key}
              section={section}
              lines={form[section.key] || [blankLine(section)]}
              onChange={(index, field, value) => changeLine(section, index, field, value)}
            />
          ))}
          <div className="flex justify-end">
            <Btn type="submit" disabled={saving} data-testid={`warehouse-${warehouseId.toLowerCase()}-report-save`}>
              <Save size={16} /> {saving ? "Saving..." : "Save daily report"}
            </Btn>
          </div>
        </form>

        <section className="space-y-3" aria-labelledby="warehouse-report-history">
          <div className="flex items-center gap-2">
            <ClipboardList size={19} className="text-emerald-800" />
            <h2 id="warehouse-report-history" className="font-display text-lg font-bold text-slate-800">Report history</h2>
          </div>
          {loadingReports ? (
            <Card className="p-6 text-center text-sm text-slate-500">Loading warehouse reports...</Card>
          ) : reports.length === 0 ? (
            <Card><Empty icon={ClipboardList} title="No reports recorded yet" hint={`Saved Warehouse ${warehouseId} reports will appear here.`} /></Card>
          ) : (
            <div className="space-y-3">
              {reports.map((report) => (
                <Card key={report.id} className="space-y-4 p-4 sm:p-5" data-testid={`warehouse-report-${report.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                    <h3 className="font-semibold text-slate-800">{report.date}</h3>
                    <div className="flex items-center gap-3">
                      {warehouseId === "C" && (
                        <p className="text-sm font-semibold text-slate-700" data-testid={`warehouse-c-total-loaded-${report.id}`}>
                          Total loaded and dispatched: {report.total_quantity_loaded ?? 0}
                        </p>
                      )}
                      <p className="text-xs text-slate-500">
                        {report.created_by_name ? `Recorded by ${report.created_by_name}` : ""}
                      </p>
                      <Btn
                        type="button"
                        variant="outline"
                        className="px-2.5 py-1.5 text-xs text-emerald-700 hover:border-emerald-200 hover:bg-emerald-50"
                        onClick={() => sendWarehouseReportViaWhatsApp(report)}
                        disabled={Boolean(sharingReportId)}
                        aria-label={`Send Warehouse ${warehouseId} daily report for ${report.date} via WhatsApp`}
                        data-testid={`warehouse-report-whatsapp-${report.id}`}
                      >
                        <MessageCircle size={14} />
                        {sharingReportId === report.id ? "Preparing..." : "Send PDF"}
                      </Btn>
                      {canDeleteReports && (
                        <Btn
                          type="button"
                          variant="outline"
                          className="px-2.5 py-1.5 text-xs text-red-700 hover:border-red-200 hover:bg-red-50"
                          onClick={() => deleteReport(report)}
                          disabled={Boolean(deletingReportId)}
                          aria-label={`Delete daily report for ${report.date}`}
                          data-testid={`warehouse-report-delete-${report.id}`}
                        >
                          <Trash2 size={14} /> {deletingReportId === report.id ? "Deleting..." : "Delete"}
                        </Btn>
                      )}
                    </div>
                  </div>
                  <WarehouseReportSummary warehouseId={warehouseId} report={report} />
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {reportSections.filter(({ key }) => report[key]?.length > 0).map((section) => (
                      <div key={section.key}>
                        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">{section.title}</h4>
                        <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
                          {report[section.key].map((line, index) => (
                            <li key={`${section.key}-${index}`}>{reportLineSummary(line)}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                  {report.notes && <p className="border-t border-slate-100 pt-3 text-sm text-slate-600">{report.notes}</p>}
                </Card>
              ))}
            </div>
          )}
        </section>
        <Modal
          open={!!whatsappDraft}
          onClose={() => setWhatsappDraft(null)}
          title={`Warehouse ${whatsappDraft?.warehouseId || ""} report ready`}
        >
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              The PDF link for {whatsappDraft?.date} is ready. Open WhatsApp to review the message, then press Send.
            </p>
            <div className="flex justify-end gap-2">
              <Btn type="button" variant="outline" onClick={() => setWhatsappDraft(null)}>Cancel</Btn>
              <a
                href={whatsappDraft?.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setWhatsappDraft(null)}
                data-testid="open-warehouse-report-whatsapp"
                className="inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
              >
                <MessageCircle size={15} /> Open WhatsApp
              </a>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  const visibleWarehouses = selectedWarehouse ? [selectedWarehouse] : WAREHOUSES;
  return (
    <div className="dashboard-stagger space-y-5">
      <PageHeader title="WAREHOUSES" subtitle="IQFOAM Manufacturing warehouses" />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Warehouses">
        {visibleWarehouses.map((warehouse) => (
          <Link
            key={warehouse.id}
            to={`/warehouses/${warehouse.id}`}
            aria-label={`Open Warehouse ${warehouse.id}`}
            className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
          >
            <Card className="flex items-start gap-4 p-5" data-testid={`warehouse-card-${warehouse.id}`}>
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
                <Warehouse size={24} aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-display text-xl font-semibold text-slate-800">Warehouse {warehouse.id}</h2>
              </div>
            </Card>
          </Link>
        ))}
      </section>
    </div>
  );
}
