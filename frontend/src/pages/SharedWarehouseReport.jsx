import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Download, Warehouse } from "lucide-react";
import { toast } from "sonner";
import { Btn, Card } from "@/components/common";
import { api, apiError } from "@/lib/api";
import { documentFilename } from "@/lib/format";
import { elementToPdf } from "@/lib/pdf";
import { warehouseReportDetails, warehouseReportMetrics } from "@/lib/warehouseReports.mjs";

function WarehouseReportDocument({ report, reportRef }) {
  const sections = warehouseReportDetails(report.warehouse_id, report);
  const metrics = warehouseReportMetrics(report.warehouse_id, report);
  return (
    <article
      ref={reportRef}
      className="mx-auto w-full max-w-[794px] bg-white p-6 text-slate-950 sm:p-10"
      style={{ fontFamily: "Arial, sans-serif" }}
      data-testid="shared-warehouse-report-document"
    >
      <header className="border-b-2 border-emerald-800 pb-5">
        <p className="text-sm font-bold uppercase tracking-[0.18em] text-emerald-800">IQFOAM Manufacturing</p>
        <h1 className="mt-2 text-3xl font-bold">Warehouse {report.warehouse_id}</h1>
        <p className="mt-1 text-lg text-slate-600">Daily report · {report.date}</p>
      </header>

      <section className="mt-6">
        <h2 className="mb-3 text-lg font-bold">Daily report totals</h2>
        <dl className="grid grid-cols-2 gap-3">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <dt className="text-xs font-bold uppercase tracking-wide text-slate-600">{metric.label}</dt>
              <dd className="mt-1 break-words text-sm font-semibold">{metric.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {sections.map((section) => (
        <section key={section.key} className="mt-7">
          <h2 className="mb-3 border-b border-slate-200 pb-2 text-lg font-bold">{section.title}</h2>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-100">
                <tr>
                  {section.fields.map(([, label]) => (
                    <th key={label} className="px-3 py-2 font-semibold">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, index) => (
                  <tr key={`${section.key}-${index}`} className="border-t border-slate-200">
                    {section.fields.map(([key]) => (
                      <td key={key} className="px-3 py-2">{row[key] ?? "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {report.notes && (
        <section className="mt-7 border-t border-slate-200 pt-4">
          <h2 className="font-bold">Notes</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{report.notes}</p>
        </section>
      )}
      <footer className="mt-10 border-t border-slate-200 pt-3 text-xs text-slate-500">
        IQFOAM Manufacturing · Warehouse {report.warehouse_id} · {report.date}
      </footer>
    </article>
  );
}

export default function SharedWarehouseReport() {
  const { token } = useParams();
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const reportRef = useRef(null);

  useEffect(() => {
    let active = true;
    api.getUncached(`/public/warehouse-reports/${encodeURIComponent(token)}`)
      .then(({ report: sharedReport }) => {
        if (active) setReport(sharedReport);
      })
      .catch((requestError) => {
        if (active) setError(apiError(requestError));
      });
    return () => { active = false; };
  }, [token]);

  const downloadPdf = async () => {
    if (!reportRef.current || !report) return;
    setDownloading(true);
    try {
      await elementToPdf(
        reportRef.current,
        `${documentFilename("Daily-Report", `Warehouse-${report.warehouse_id}`, report.date)}.pdf`,
      );
    } catch (downloadError) {
      toast.error(apiError(downloadError));
    } finally {
      setDownloading(false);
    }
  };

  if (error) {
    return (
      <main className="min-h-screen bg-slate-100 p-6">
        <section className="mx-auto mt-12 max-w-lg rounded-xl bg-white p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900">Report link unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">This report may have been deleted or its link is no longer available.</p>
          <p className="mt-2 break-words text-xs text-slate-400" role="status">{error}</p>
        </section>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="min-h-screen bg-slate-100 p-6">
        <p className="mx-auto mt-12 max-w-lg text-center text-sm text-slate-600" role="status">Loading warehouse report...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
      <section className="mx-auto max-w-5xl">
        <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-800">
              <Warehouse size={20} aria-hidden="true" />
            </span>
            <div>
              <h1 className="font-semibold text-slate-900">Warehouse {report.warehouse_id} daily report</h1>
              <p className="text-sm text-slate-600">{report.date}</p>
            </div>
          </div>
          <Btn onClick={downloadPdf} disabled={downloading} data-testid="shared-warehouse-report-download">
            <Download size={15} /> {downloading ? "Preparing PDF..." : "Download PDF"}
          </Btn>
        </div>
        <div className="overflow-auto rounded-xl shadow-sm">
          <WarehouseReportDocument report={report} reportRef={reportRef} />
        </div>
      </section>
    </main>
  );
}
