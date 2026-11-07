import { forwardRef } from "react";
import { COMPANY } from "@/components/InvoiceDocument";
import { companyDisplayName } from "@/lib/company";

const T = {
  en: { title: "DELIVERY NOTE", date: "Date", no: "Delivery Note No.", invoice: "Invoice No.", deliverTo: "Deliver To", details: "Details", qty: "Quantity", product: "Product", size: "Size", total: "Total quantity", phone: "Phone", email: "Email",
    priority: "Priority", ship: "Ship date", vehicle: "Vehicle", notes: "Notes", invoiceItems: "Items on linked invoice", loadedBy: "Loaded items confirmed by driver", sign: "Driver signature", driver: "Driver", signedBy: "Driver", signedAt: "Confirmed at", confirmation: "The driver confirms the loaded pieces are complete and match the products and quantities listed for this order and linked invoice." },
  ur: { title: "ڈلیوری نوٹ", date: "تاریخ", no: "نوٹ نمبر", invoice: "انوائس نمبر", deliverTo: "ترسیل برائے", details: "تفصیلات", qty: "مقدار", product: "پروڈکٹ", size: "سائز / پیمائش", total: "کل تعداد", phone: "فون", email: "ای میل",
    priority: "ترجیح", ship: "روانگی کی تاریخ", vehicle: "گاڑی", notes: "نوٹس", invoiceItems: "منسلک انوائس کی اشیاء", loadedBy: "ڈرائیور نے لوڈ شدہ سامان کی تصدیق کی", sign: "ڈرائیور کے دستخط", driver: "ڈرائیور", signedBy: "ڈرائیور", signedAt: "تصدیق کا وقت", confirmation: "ڈرائیور تصدیق کرتا ہے کہ لوڈ شدہ سامان مکمل ہے اور اس آرڈر اور منسلک انوائس میں درج مصنوعات اور مقدار سے میل کھاتا ہے۔" },
};
const UR_PRODUCTS = { Simple: "سادہ", Standard: "سادہ", "Simple/Mix color": "سادہ / مکس رنگ", "Ribbon Black": "ربن کالا", "Ribbon Pink": "ربن گلابی", "Strong Boy": "سٹرانگ بوائے", Uncovered: "بغیر کور", Candy: "کینڈی", "Uncovered Blue 16 Density": "بغیر کور نیلا 16 ڈینسٹی" };
const UR_PRIORITY = { Low: "کم", Normal: "عام", High: "زیادہ", Urgent: "فوری" };

export function orderLines(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (items.length) return items.filter((i) => i && Number(i.qty) > 0 && (i.size || i.description || i.category));
  const products = typeof order?.products === "string" ? order.products : "";
  return products.split(/\n|,/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)\s*[x×]?\s*(.*)$/i);
    return m ? { qty: Number(m[1]), category: m[2], size: "" } : { qty: "", category: l, size: "" };
  });
}

export const DeliveryNote = forwardRef(function DeliveryNote({ order, signature = null, invoiceSnapshot = null, lang = "en", vehicleName = "", settings = {} }, ref) {
  const t = T[lang]; const ur = lang === "ur";
  const lines = orderLines(order);
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const prod = (c) => (ur ? UR_PRODUCTS[c] || c : c);
  const companyName = companyDisplayName(settings.company_name || COMPANY.name);
  const cell = "border border-slate-800 px-3 py-3";
  return (
    <div ref={ref} dir={ur ? "rtl" : "ltr"} lang={lang} className="bg-white text-slate-950 mx-auto p-8 text-[16px] leading-7" style={{ width: 794, minHeight: 1123, boxSizing: "border-box", fontFamily: ur ? "'Noto Nastaliq Urdu','Jameel Noori Nastaleeq',Tahoma,sans-serif" : "Arial, sans-serif" }} data-testid="delivery-note">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[30px] font-extrabold leading-tight" dir="ltr">{companyName}</p>
          <p className="whitespace-pre-line text-[16px] leading-7" dir="ltr">{settings.address || COMPANY.address.join(", ")}</p>
          <p className="text-[16px] leading-7" dir="ltr">{settings.telephone || COMPANY.phones}</p>
        </div>
        <div className={ur ? "text-left" : "text-right"}>
          <p className="text-[30px] font-bold leading-tight mb-3">{t.title}</p>
          <table className="border border-slate-800 text-[16px]">
            <thead><tr className="bg-slate-100"><th className={cell}>{t.date}</th><th className={cell}>{t.no}</th></tr></thead>
            <tbody><tr><td className={cell} dir="ltr">{order.expected_ship_date || new Date().toISOString().slice(0, 10)}</td><td className={`${cell} font-mono`} dir="ltr">{order.reference}</td></tr></tbody>
          </table>
          {order.invoice_number && <p className="mt-2 text-sm"><b>{t.invoice}:</b> <span dir="ltr">{order.invoice_number}</span></p>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-6 mt-6">
        <div className="border border-slate-800"><div className="border-b border-slate-800 bg-slate-100 px-3 py-3 text-[18px] font-bold">{t.deliverTo}</div><div className="px-3 py-3 min-h-[90px] leading-7">
          <p dir="ltr" className={ur ? "text-right" : ""}>{order.customer_name}</p>
          {order.customer_address && <p dir="ltr" className={ur ? "text-right" : ""}>{order.customer_address}</p>}
          {order.destination && order.destination !== order.customer_address && <p dir="ltr" className={ur ? "text-right" : ""}>{order.destination}</p>}
          {order.customer_phone && <p dir="ltr" className={ur ? "text-right" : ""}>{t.phone}: {order.customer_phone}</p>}
          {order.customer_email && <p dir="ltr" className={ur ? "text-right" : ""}>{t.email}: {order.customer_email}</p>}
        </div></div>
        <div className="border border-slate-800"><div className="border-b border-slate-800 bg-slate-100 px-3 py-3 text-[18px] font-bold">{t.details}</div><div className="px-3 py-3 min-h-[90px] leading-7">
          {order.priority && <p>{t.priority}: {ur ? UR_PRIORITY[order.priority] || order.priority : order.priority}</p>}
          {vehicleName && <p>{t.vehicle}: <span dir="ltr">{vehicleName}</span></p>}
        </div></div>
      </div>
      <table className="w-full border border-slate-800 text-[16px] mt-5">
        <thead><tr className="bg-slate-100">
          <th className={`${cell} w-1/4 text-left`}>{t.size}</th>
          <th className={`${cell} w-1/2 text-left`}>{t.product}</th>
          <th className={`${cell} w-1/4 text-center`}>{t.qty}</th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => <tr key={i}>
            <td className={`${cell} text-center text-[18px] font-bold`} dir="ltr">{l.size || "-"}</td>
            <td className={`${cell} text-[18px]`}>{prod(l.category || l.description) || "-"}</td>
            <td className={`${cell} text-center text-[20px] font-extrabold`} dir="ltr">{l.qty}</td>
          </tr>)}
          <tr className="bg-slate-100"><td className={cell} /><td className={`${cell} text-right font-bold`}>{t.total}</td><td className={`${cell} text-center text-[20px] font-extrabold`} dir="ltr">{total}</td></tr>
        </tbody>
      </table>
      {invoiceSnapshot && <div className="mt-5">
        <p className="mb-2 font-bold">{t.invoiceItems} {invoiceSnapshot.invoice_number && <span dir="ltr">({invoiceSnapshot.invoice_number})</span>}</p>
        <table className="w-full border border-slate-800 text-sm">
          <thead><tr className="bg-slate-100">
            <th className={`${cell} w-1/4 text-left`}>{t.size}</th>
            <th className={`${cell} w-1/2 text-left`}>{t.product}</th>
            <th className={`${cell} w-1/4 text-center`}>{t.qty}</th>
          </tr></thead>
          <tbody>{invoiceSnapshot.items.map((item, index) => (
            <tr key={index}>
              <td className={`${cell} text-center`} dir="ltr">{item.size || "-"}</td>
              <td className={cell}>{prod(item.category || item.description) || "-"}</td>
              <td className={`${cell} text-center`} dir="ltr">{item.qty}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>}
      {order.notes && <p className="mt-4"><b>{t.notes}:</b> {order.notes}</p>}
      <div className="mt-12 border-t border-slate-300 pt-4">
        <p className="font-semibold">{t.loadedBy}</p>
        <p className="mt-1 text-sm">{t.confirmation}</p>
        <div className="mt-3 flex min-h-20 items-end gap-4">
          {signature?.signature_data && <img src={signature.signature_data} alt={t.sign} className="max-h-16 max-w-56 object-contain" />}
          <div className="min-w-52 flex-1 border-b border-slate-800 pb-1 text-sm">
            {signature?.driver_name && <span>{t.signedBy}: {signature.driver_name}</span>}
          </div>
        </div>
        <p className="mt-1">{t.sign}</p>
        {signature?.confirmed_at && <p className="mt-1 text-xs">{t.signedAt}: {new Date(signature.confirmed_at).toLocaleString()}</p>}
      </div>
    </div>
  );
});
