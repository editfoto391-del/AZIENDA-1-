import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { InvoiceDocument } from "@/components/InvoiceDocument";
import { Btn } from "@/components/common";
import { api, apiError } from "@/lib/api";
import { documentFilename } from "@/lib/format";
import { elementToPdf } from "@/lib/pdf";
import { Download } from "lucide-react";

export default function SharedInvoice() {
  const { token } = useParams();
  const [sharedInvoice, setSharedInvoice] = useState(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const documentRef = useRef(null);

  useEffect(() => {
    let active = true;
    api.getUncached(`/public/invoices/${encodeURIComponent(token)}`)
      .then((data) => {
        if (active) setSharedInvoice(data);
      })
      .catch((requestError) => {
        if (active) setError(apiError(requestError));
      });
    return () => { active = false; };
  }, [token]);

  const downloadPdf = async () => {
    if (!documentRef.current || !sharedInvoice) return;
    setDownloading(true);
    try {
      const { invoice } = sharedInvoice;
      await elementToPdf(
        documentRef.current,
        `${documentFilename("Invoice", invoice.number, invoice.customer_name)}.pdf`,
      );
    } catch (downloadError) {
      toast.error(apiError(downloadError));
    } finally {
      setDownloading(false);
    }
  };

  if (error) {
    return <main className="min-h-screen bg-slate-100 p-6">
      <section className="mx-auto mt-12 max-w-lg rounded-xl bg-white p-6 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Invoice link unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">This link may have been revoked or the invoice is no longer available.</p>
        <p className="mt-2 break-words text-xs text-slate-400" role="status">{error}</p>
      </section>
    </main>;
  }

  if (!sharedInvoice) {
    return <main className="min-h-screen bg-slate-100 p-6">
      <p className="mx-auto mt-12 max-w-lg text-center text-sm text-slate-600" role="status">Loading invoice...</p>
    </main>;
  }

  const { invoice, customer, settings } = sharedInvoice;
  const totals = {
    subtotal: Number(invoice.subtotal) || 0,
    tax: Number(invoice.tax_amount) || 0,
    total: Number(invoice.total) || 0,
    outstanding: Number(invoice.outstanding) || 0,
  };

  return <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
    <section className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Invoice {invoice.number}</h1>
          <p className="text-sm text-slate-600">{invoice.customer_name}</p>
        </div>
        <Btn onClick={downloadPdf} disabled={downloading} data-testid="shared-invoice-download">
          <Download size={15} /> {downloading ? "Preparing PDF..." : "Download PDF"}
        </Btn>
      </div>
      <div className="overflow-auto rounded-xl shadow-sm">
        <div className="mx-auto w-fit">
          <InvoiceDocument
            ref={documentRef}
            inv={invoice}
            totals={totals}
            customer={customer}
            settings={settings}
          />
        </div>
      </div>
    </section>
  </main>;
}
