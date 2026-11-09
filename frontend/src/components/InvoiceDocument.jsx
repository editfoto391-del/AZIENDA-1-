import { forwardRef } from "react";
import { fmtMoney, fmtDate } from "@/lib/format";
import { companyDisplayName, invoiceCustomerBalanceLabels } from "@/lib/company";
import shop2shopQr from "@/assets/shop2shop-n29rxh.png";

export const COMPANY = { name: "SUPER IQ-FOAM", address: ["ROCKY RIDGE LODGE", "ROCKY RIDGE FARM", "KOKSTAD, 4700"], phones: "0659279036 - 0634029112" };

const SUPER_IQ_FOAM_BANK_ACCOUNTS = [
  ["FNB", "711 security", "63189328412"],
  ["Standard bank", "IQ FOAM", "301654387"],
  ["Capitec business", "Super  IQ FOAM", "1051246610"],
];

const Logo = () => (
  <svg width="44" height="44" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 6 58 20 32 34 6 20Z" fill="#2563EB" /><path d="M6 20v8l26 14 26-14v-8L32 34Z" fill="#1D4ED8" />
    <path d="M6 34l26 14 26-14v8L32 56 6 42Z" fill="none" stroke="#2563EB" strokeWidth="4" strokeLinejoin="round" />
    <circle cx="24" cy="18" r="1.6" fill="#fff" /><circle cx="32" cy="22" r="1.6" fill="#fff" /><circle cx="40" cy="18" r="1.6" fill="#fff" /><circle cx="32" cy="14" r="1.6" fill="#fff" />
  </svg>
);

export const InvoiceDocument = forwardRef(function InvoiceDocument({
  inv,
  totals,
  customer = {},
  settings = {},
  previousInvoices = [],
  customerBalanceBeforeInvoice = 0,
  showCustomerBalance = false,
}, ref) {
  const rows = (inv.items || []).filter((it) => (it.size || it.description) &&
    !(!it.category && !it.size && it.description?.trim().toLowerCase() === "opening balance"));
  const shipTo = inv.destination || customer.city || customer.address || "";
  const companyName = companyDisplayName(settings.company_name || COMPANY.name);
  const customerBalanceLabels = invoiceCustomerBalanceLabels(companyName);
  const previousInvoicesBalance = previousInvoices.reduce(
    (total, invoice) => total + (Number(invoice.outstanding) || 0),
    0,
  );
  const isSuperIqFoam = /super/i.test(companyName) && /iq\s*[- ]?foam/i.test(companyName);
  const invoiceBrand = /wholesale/i.test(companyName) ? { blue: "IQ FOAM", black: "WHOLESALERS" } :
    /manufactur|manufactor/i.test(companyName) ? { blue: "IQ FOAM", black: "MANUFACTURING" } :
      /super/i.test(companyName) && /iq\s*[- ]?foam/i.test(companyName) ? { blue: "SUPER", black: "IQFOAM" } :
        /iq\s*[- ]?foam/i.test(companyName) ? { blue: "IQFOAM", black: "" } : { blue: "", black: companyName };
  const L = ({ k, v }) => (v ? <p className="leading-5"><span className="font-semibold text-slate-900">{k}</span> <span className="text-slate-800">{v}</span></p> : null);
  return (
    <div ref={ref} className="invoice-document bg-white text-slate-950 p-6 text-[14px]" style={{ width: 794, fontFamily: "Arial, sans-serif" }} data-testid="invoice-document">
      <div className="flex items-center gap-2">
        <Logo />
        <div>
          <p className="text-[24px] font-extrabold leading-tight tracking-tight"><span className="text-blue-700">{invoiceBrand.blue}</span>{invoiceBrand.blue && invoiceBrand.black ? " " : ""}<span className="text-slate-950">{invoiceBrand.black}</span></p>
        </div>
      </div>
      <div className="flex justify-between items-start mt-3">
        <div className="leading-5 text-slate-800">
          <p className="font-bold text-slate-950">{companyName}</p>
          <p className="whitespace-pre-line">{settings.address || COMPANY.address.join(", ")}</p>
          <p>Tel: {settings.telephone || COMPANY.phones}</p>
          {settings.email && <p>Email: {settings.email}</p>}
          {settings.tax_number && <p>VAT No: {settings.tax_number}</p>}
        </div>
        <div className="text-right"><p className="text-[24px] font-extrabold">INVOICE</p><p className="text-[16px] font-bold font-mono" data-testid="doc-invoice-number">{inv.number || "DRAFT"}</p></div>
      </div>
      <div className="border-t border-slate-200 mt-3 pt-3 grid grid-cols-2 gap-4">
        <div>
          <p className="text-[12px] font-bold uppercase text-slate-700 mb-1">Bill To</p>
          <L k="Customer:" v={inv.customer_name} /><L k="Client Number:" v={inv.client_number} /><L k="Address:" v={customer.address} /><L k="City:" v={customer.city} /><L k="Phone:" v={customer.phone} /><L k="Email:" v={customer.email} />
          <L k="Made By:" v={inv.made_by} /><L k="Assigned Driver:" v={inv.assigned_driver_name} />
          <p className="text-[12px] font-bold uppercase text-slate-700 mt-2 mb-1">Ship To</p>
          <p className="leading-5 text-slate-800">{[inv.customer_name, shipTo].filter(Boolean).join(" — ")}</p>
        </div>
        <div className="justify-self-end w-[280px] text-[13px]">
            {[["Invoice Date:", fmtDate(inv.date)], ["Due Date:", fmtDate(inv.due_date)], ["Price Zone:", `Zone ${inv.zone}`], ["Payment Terms:", inv.payment_terms], ["Reference:", inv.reference]].filter(([k, v]) => v && (k !== "Price Zone:" || !settings.unified_price_list) && !(inv.opening_balance && k === "Reference:")).map(([k, v]) => (
            <div key={k} className="flex justify-between leading-5"><span className="font-semibold">{k}</span><span className="text-slate-800">{v}</span></div>))}
        </div>
      </div>
      {!inv.opening_balance && previousInvoices.length > 0 && <div
        className="mt-3 rounded border border-amber-400 bg-amber-50 px-3 py-2 text-[12px] text-amber-950"
        style={{ breakInside: "avoid", pageBreakInside: "avoid" }}
        data-testid="doc-previous-invoices-pending"
      >
        <div className="flex flex-wrap justify-between gap-2 font-bold">
          <span>PREVIOUS INVOICES PENDING PAYMENTS:</span>
          <span>Total previous BLN: {fmtMoney(previousInvoicesBalance)}</span>
        </div>
        <div className="mt-1 space-y-0.5">
          {previousInvoices.map((invoice) => (
            <div key={invoice.id} className="flex flex-wrap justify-between gap-x-4 border-t border-amber-200 pt-0.5">
              <span>{fmtDate(invoice.date)} · INV. {invoice.number || "—"}</span>
              <span className="font-bold">BLN: {fmtMoney(invoice.outstanding)}</span>
            </div>
          ))}
        </div>
      </div>}
      {rows.length > 0 && <table className="w-full mt-3 border border-slate-300 text-[13px]">
        <thead><tr className="bg-slate-100 text-left">{["#", "Category", "Size", "Qty", "Unit Price", "Total"].map((h, i) => <th key={h} className={`px-2 py-1.5 font-bold ${i >= 3 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((it, i) => (
          <tr key={i} className="border-t border-slate-200">
            <td className="px-2 py-1.5">{i + 1}</td><td className="px-2 py-1.5">{it.category || it.description}</td><td className="px-2 py-1.5">{it.size}</td>
            <td className="px-2 py-1.5 text-right">{it.qty}</td><td className="px-2 py-1.5 text-right">{fmtMoney(it.unit_price)}</td><td className="px-2 py-1.5 text-right">{fmtMoney((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</td>
          </tr>))}</tbody>
      </table>}
      <div className="mt-2 flex items-start justify-between gap-3">
        {(inv.payment_terms || "").trim().toLowerCase() === "cash on delivery" && <div
          className="pt-1 text-[10px] font-bold leading-4 text-red-700"
          style={{ breakInside: "avoid", pageBreakInside: "avoid" }}
          data-testid="doc-cod"
        >
          <p className="uppercase">Cash on Delivery</p>
          <p>Cash to collect: {inv.cod_amount_due != null ? fmtMoney(inv.cod_amount_due) : fmtMoney(totals.total)}</p>
          <p className="flex items-end gap-1">
            <span>Cash actually collected:</span>
            {inv.cod_amount_collected != null
              ? <span>{fmtMoney(inv.cod_amount_collected)}</span>
              : <span className="inline-block w-12 border-b border-red-700">&nbsp;</span>}
          </p>
        </div>}
        <div className="ml-auto w-[320px] text-[13px]">
          {[["Subtotal", totals.subtotal], ["Discount", Number(inv.discount) || 0], ...(Number(inv.delivery_fee) ? [["Delivery Fee", inv.delivery_fee]] : []), ...(Number(inv.extra_charges) ? [["Added", inv.extra_charges]] : []), ...(inv.tax_enabled ? [[`Tax (${inv.tax_rate}%)`, totals.tax]] : [])].map(([k, v]) => (
            <div key={k} className="flex justify-between py-0.5 px-2"><span className="font-semibold text-slate-700">{k}</span><span>{fmtMoney(v)}</span></div>))}
          <div className="flex justify-between py-1 px-2 text-[16px] font-extrabold"><span>Total</span><span data-testid="doc-total">{fmtMoney(totals.total)}</span></div>
          <div className="flex justify-between py-0.5 px-2 mt-1"><span className="font-semibold text-slate-700">Amount Paid</span><span>{fmtMoney(inv.amount_paid)}</span></div>
          <div className="flex justify-between py-1.5 px-2 bg-red-50 text-red-800 font-bold"><span>BLN (Balance Remaining)</span><span>{fmtMoney(totals.outstanding)}</span></div>
          {showCustomerBalance && <div className="flex justify-between py-1.5 px-2 bg-amber-50 text-amber-900 font-bold" data-testid="doc-total-customer-balance">
            <span>{customerBalanceLabels.invoice}</span><span>{fmtMoney(customerBalanceBeforeInvoice + totals.outstanding)}</span>
          </div>}
        </div>
      </div>
      <div className="flex justify-between gap-4 mt-4 border-b border-slate-300 pb-3">
        <div className="leading-4 whitespace-pre-line text-[12px]">
          <p className="font-bold text-[14px]">Banking Details</p>
          {isSuperIqFoam ? (
            <div className="text-slate-700">
              <p className="font-bold">USE ONLY THIS ACCOUNT NOT THE OLDEST ONES</p>
              <p className="font-bold">SUPER IQ FOAM ACCOUNTS</p>
              {SUPER_IQ_FOAM_BANK_ACCOUNTS.map(([bank, accountName, accountNumber]) => (
                <p key={bank}><b>{bank}</b> — <i>{accountName}</i> — <b>{accountNumber}</b></p>
              ))}
              <div className="mt-1 flex items-center gap-2">
                <img src={shop2shopQr} alt="Shop2Shop QR code for N29RXH" className="h-16 w-16 border border-slate-300 bg-white p-0.5" />
                <p><b>SHOP2SHOP</b><br /><b>N29RXH</b></p>
              </div>
              <p>Reference: Use invoice number</p>
            </div>
          ) : (
            <>
              <p className="text-slate-700">{settings.banking_details || "Bank: N/A"}</p>
              <p className="text-slate-700">Reference: Use invoice number</p>
            </>
          )}
          {inv.notes && !inv.opening_balance && <p className="text-slate-800 mt-1"><b>Notes:</b> {inv.notes}</p>}
        </div>
        <p className="italic text-slate-700 text-[12px]">Thank you for your business!</p>
      </div>
    </div>
  );
});
