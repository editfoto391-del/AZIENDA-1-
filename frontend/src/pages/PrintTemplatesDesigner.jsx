import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { Btn, Card, Input, Select } from "@/components/common";
import { InvoiceDocument } from "@/components/InvoiceDocument";
import { usesFreeformInvoiceItems } from "@/lib/company";

const COLUMN_OPTIONS = [
  ["category", "Category / service"],
  ["size", "Size"],
  ["quantity", "Quantity"],
  ["unit_price", "Unit price"],
  ["total", "Line total"],
];

const SAMPLE_INVOICE = {
  id: "print-template-preview",
  number: "INV-PREVIEW",
  customer_name: "Sample customer",
  date: new Date().toISOString().slice(0, 10),
  due_date: "",
  zone: 1,
  payment_terms: "Cash",
  items: [{ category: "Sample product", size: "1 unit", qty: 2, unit_price: 125 }],
  subtotal: 250,
  total: 250,
  outstanding: 250,
  amount_paid: 0,
};

const EMPTY_TEMPLATE = {
  name: "Default invoice",
  logo_data_url: "",
  font_family: "Arial",
  font_size: 14,
  primary_color: "#1e293b",
  margin_mm: 6,
  spacing: 1,
  header_text: "",
  footer_text: "",
  signature_text: "",
  show_company_details: true,
  alignment: "left",
  columns: [],
  print_trigger: "manual",
};

export default function PrintTemplatesDesigner() {
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [template, setTemplate] = useState(EMPTY_TEMPLATE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.get("/companies/profiles")
      .then((profiles) => {
        if (!active) return;
        if (!Array.isArray(profiles) || profiles.length === 0) {
          throw new Error("No company profiles are available for template configuration.");
        }
        setCompanies(profiles);
        setCompanyId(profiles[0].id);
      })
      .catch((error) => {
        if (active) {
          toast.error(`Could not load company profiles: ${apiError(error)}`);
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!companyId) return undefined;
    let active = true;
    setLoading(true);
    setLoadError("");
    setTemplate(EMPTY_TEMPLATE);
    api.getUncached(`/print-templates?company_id=${encodeURIComponent(companyId)}`)
      .then((saved) => {
        if (active) {
          const defaultColumns = usesFreeformInvoiceItems(companyId)
            ? ["category", "quantity", "unit_price", "total"]
            : ["category", "size", "quantity", "unit_price", "total"];
          setTemplate({
            ...EMPTY_TEMPLATE,
            ...saved,
            columns: saved.columns?.length ? saved.columns : defaultColumns,
          });
        }
      })
      .catch((error) => {
        if (active) {
          setLoadError(`Could not load the invoice template: ${apiError(error)}`);
          toast.error(`Could not load the invoice template: ${apiError(error)}`);
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId]);

  const update = (key, value) => setTemplate((current) => ({ ...current, [key]: value }));
  const toggleColumn = (column) => {
    const currentColumns = template.columns.length ? template.columns : ["category", "total"];
    const nextColumns = currentColumns.includes(column)
      ? currentColumns.filter((item) => item !== column)
      : [...currentColumns, column];
    const columns = COLUMN_OPTIONS.map(([value]) => value).filter((value) => nextColumns.includes(value));
    update("columns", columns);
  };
  const uploadLogo = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 256_000) {
      toast.error("Choose a PNG, JPEG, or WebP logo smaller than 256 KB.");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        if (image.width > 1600 || image.height > 1000) {
          toast.error("Logo dimensions must not exceed 1600 x 1000 pixels.");
          event.target.value = "";
          return;
        }
        update("logo_data_url", String(reader.result || ""));
      };
      image.onerror = () => toast.error("The selected logo could not be decoded.");
      image.src = String(reader.result || "");
    };
    reader.onerror = () => toast.error("Could not read the selected logo.");
    reader.readAsDataURL(file);
  };
  const save = async () => {
    if (saving || loading || loadError) return;
    setSaving(true);
    try {
      const saved = await api.put(`/print-templates?company_id=${encodeURIComponent(companyId)}`, template);
      setTemplate({ ...EMPTY_TEMPLATE, ...saved });
      toast.success("Invoice template saved for this company.");
    } catch (error) {
      toast.error(`Could not save the invoice template: ${apiError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="print-templates-designer">
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-bold text-slate-800">Company print templates</h2>
          <p className="mt-1 text-sm text-slate-500">Configure the approved invoice and delivery-note layout for each company. Table columns apply to invoices. Regular users can use these templates but cannot edit them.</p>
        </div>
        <Select label="Company" value={companyId} onChange={(event) => setCompanyId(event.target.value)} data-testid="print-template-company">
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </Select>
        {loading ? <p className="text-sm text-slate-500" role="status">Loading template...</p> : loadError ? <p className="text-sm text-red-700" role="alert">{loadError}</p> : <>
          <Input label="Template name" value={template.name} onChange={(event) => update("name", event.target.value)} maxLength={80} data-testid="print-template-name" />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-500">
              Company logo (PNG, JPEG, WebP; up to 256 KB and 1600 x 1000 px)
              <input className="mt-1.5 block w-full text-sm" type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadLogo} data-testid="print-template-logo" />
            </label>
            {template.logo_data_url && <div className="flex items-center gap-3">
              <img src={template.logo_data_url} alt="Uploaded company logo preview" className="h-14 max-w-40 object-contain" />
              <Btn type="button" variant="outline" onClick={() => update("logo_data_url", "")}>Remove logo</Btn>
            </div>}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Select label="Font" value={template.font_family} onChange={(event) => update("font_family", event.target.value)}>
              {["Arial", "Helvetica", "Georgia", "Times New Roman"].map((font) => <option key={font}>{font}</option>)}
            </Select>
            <Input label="Font size (px)" type="number" min="10" max="18" value={template.font_size} onChange={(event) => update("font_size", Number(event.target.value))} />
            <label className="block"><span className="block text-xs font-semibold text-slate-500 mb-1.5">Accent colour</span><input type="color" value={template.primary_color} onChange={(event) => update("primary_color", event.target.value)} className="h-10 w-full rounded border border-input" /></label>
            <Input label="Page margin (mm)" type="number" min="4" max="25" value={template.margin_mm} onChange={(event) => update("margin_mm", Number(event.target.value))} />
            <Input label="Line spacing" type="number" min="0.8" max="1.6" step="0.1" value={template.spacing} onChange={(event) => update("spacing", Number(event.target.value))} />
            <Select label="Header/footer alignment" value={template.alignment} onChange={(event) => update("alignment", event.target.value)}>
              {["left", "center", "right"].map((alignment) => <option key={alignment}>{alignment}</option>)}
            </Select>
          </div>
          <Input label="Header text" value={template.header_text} onChange={(event) => update("header_text", event.target.value)} maxLength={200} />
          <Input label="Footer text" value={template.footer_text} onChange={(event) => update("footer_text", event.target.value)} maxLength={300} />
          <Input label="Signature label" value={template.signature_text} onChange={(event) => update("signature_text", event.target.value)} maxLength={100} placeholder="Authorized signature" />
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={template.show_company_details} onChange={(event) => update("show_company_details", event.target.checked)} />
            Show configured company address, contact, and tax details
          </label>
          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-slate-500">Invoice table columns (Category and Total are required)</legend>
            <div className="flex flex-wrap gap-4">
              {COLUMN_OPTIONS.map(([value, label]) => <label key={value} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={template.columns.length === 0 ? ["category", "total"].includes(value) : template.columns.includes(value)} disabled={["category", "total"].includes(value)} onChange={() => toggleColumn(value)} />
                {label}
              </label>)}
            </div>
            <p className="mt-1 text-xs text-slate-500">An empty selection preserves the existing invoice table layout.</p>
          </fieldset>
          <Select label="Invoice printing trigger" value={template.print_trigger} onChange={(event) => update("print_trigger", event.target.value)} data-testid="print-template-trigger">
            <option value="manual">Manual printing only</option>
            <option value="on_issue">When an invoice is issued (always ask first)</option>
          </Select>
          <div className="flex justify-end"><Btn onClick={save} disabled={saving} data-testid="save-print-template">{saving ? "Saving..." : "Save template"}</Btn></div>
        </>}
      </Card>
      {!loading && !loadError && <Card className="overflow-x-auto p-4">
        <h3 className="mb-3 text-sm font-bold text-slate-700">Preview</h3>
        <div className="mx-auto w-fit border border-slate-200 shadow-sm">
          <InvoiceDocument
            inv={SAMPLE_INVOICE}
            totals={{ subtotal: 250, tax: 0, total: 250, outstanding: 250 }}
            customer={{}}
            settings={{
              company_name: companies.find((company) => company.id === companyId)?.name || "Sample company",
              freeform_invoice_items: usesFreeformInvoiceItems(companyId),
            }}
            printTemplate={{ ...template, is_configured: true }}
          />
        </div>
      </Card>}
    </div>
  );
}
