import { useEffect, useState } from "react";
import { api, apiError } from "@/lib/api";
import { Btn, Card, Input, Textarea } from "@/components/common";
import { Plus, Trash2 } from "lucide-react";

const emptyItem = () => ({ qty: "", category: "", size: "", description: "" });
const newSubmissionId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export default function CustomerOrder() {
  const token = window.location.hash.slice(1);
  const [company, setCompany] = useState(null);
  const [items, setItems] = useState([emptyItem()]);
  const [form, setForm] = useState({ name: "", shop_name: "", phone: "", city: "", notes: "" });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  const [website, setWebsite] = useState("");
  const [submissionId, setSubmissionId] = useState(newSubmissionId);

  useEffect(() => {
    window.posthog?.stopSessionRecording?.();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getUncached("/public/customer-orders", undefined, {
      headers: { "X-Customer-Order-Token": token },
    })
      .then((result) => {
        if (active) setCompany(result);
      })
      .catch((requestError) => {
        if (active) setError(apiError(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [token]);

  const updateItem = (index, patch) => {
    setItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...patch } : item
    )));
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    const enteredItems = items.filter((item) => (
      item.category.trim() || item.qty || item.size.trim() || item.description.trim()
    ));
    if (enteredItems.some((item) => !item.category.trim() || Number(item.qty) <= 0)) {
      setError("Each product needs a product name and a quantity greater than zero.");
      return;
    }
    setSubmitting(true);
    try {
      const orderItems = items
        .filter((item) => item.category.trim() && Number(item.qty) > 0)
        .map((item) => ({ ...item, qty: Number(item.qty) }));
      const result = await api.post("/public/customer-orders", {
        ...form,
        items: orderItems,
        submission_id: submissionId,
        website,
      }, {
        headers: { "X-Customer-Order-Token": token },
      });
      setReference(result.reference);
      setForm({ name: "", shop_name: "", phone: "", city: "", notes: "" });
      setItems([emptyItem()]);
      setSubmissionId(newSubmissionId());
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-sm text-slate-500">Loading order form...</main>;
  }
  if (!company) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="max-w-lg p-6 text-center">
        <h1 className="text-xl font-bold text-slate-900">Order form unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{error || "This company does not accept orders from this link."}</p>
      </Card>
    </main>;
  }
  if (reference) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-lg p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">✓</div>
        <h1 className="mt-4 text-2xl font-bold text-slate-900">Order received</h1>
        <p className="mt-2 text-sm text-slate-600">Your order was sent to {company.company_name}.</p>
        <p className="mt-4 rounded-lg bg-slate-50 px-4 py-3 font-mono font-semibold text-slate-800">{reference}</p>
        <Btn className="mt-5" onClick={() => setReference("")}>Place another order</Btn>
      </Card>
    </main>;
  }

  const validItems = items.some((item) => item.category.trim() && Number(item.qty) > 0);
  return <main className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6">
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">Customer Order</p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">{company.company_name}</h1>
        <p className="mt-2 text-sm text-slate-600">Enter your contact details and the products you would like to order.</p>
      </header>
      <Card className="p-5 sm:p-7">
        <form className="space-y-5" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Contact name *" required maxLength={160} autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            <Input label="Shop name *" required maxLength={160} autoComplete="organization" value={form.shop_name} onChange={(event) => setForm({ ...form, shop_name: event.target.value })} />
            <Input label="Phone number *" required type="tel" maxLength={100} autoComplete="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
            <div className="sm:col-span-2">
              <Input label="City *" required maxLength={120} autoComplete="address-level2" value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} />
            </div>
          </div>

          <section aria-labelledby="products-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 id="products-heading" className="font-semibold text-slate-900">Products *</h2>
                <p className="text-xs text-slate-500">Add at least one product and quantity.</p>
              </div>
              <Btn type="button" variant="outline" className="px-3 py-2" onClick={() => setItems((current) => [...current, emptyItem()])} disabled={items.length >= 50}>
                <Plus size={15} /> Add product
              </Btn>
            </div>
            <div className="space-y-3">
              {items.map((item, index) => (
                <div key={index} className="rounded-lg border border-border bg-slate-50/70 p-3" data-testid={`public-order-item-${index}`}>
                  <div className="grid gap-3 sm:grid-cols-[100px_1fr_1fr_auto]">
                    <Input label="Quantity *" type="number" min="1" max="1000000" step="1" value={item.qty} onChange={(event) => updateItem(index, { qty: event.target.value })} />
                    <Input label="Product *" maxLength={120} placeholder="Product name" value={item.category} onChange={(event) => updateItem(index, { category: event.target.value })} />
                    <Input label="Size" maxLength={120} placeholder="e.g. 910x100" value={item.size} onChange={(event) => updateItem(index, { size: event.target.value })} />
                    <button type="button" aria-label={`Remove product ${index + 1}`} className="mt-5 flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={items.length === 1}>
                      <Trash2 size={17} />
                    </button>
                  </div>
                  <div className="mt-3">
                    <Input label="Product details" maxLength={500} placeholder="Optional details" value={item.description} onChange={(event) => updateItem(index, { description: event.target.value })} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <Textarea label="Order notes" rows={3} maxLength={2000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          <div aria-live="polite">
            {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          </div>
          <Btn type="submit" className="w-full" disabled={submitting || !validItems} data-testid="public-order-submit">
            {submitting ? "Sending order..." : "Send order"}
          </Btn>
          <p className="text-center text-xs text-slate-500">Your phone number is required to match your order to your customer account.</p>
          <input name="website" tabIndex="-1" autoComplete="off" aria-hidden="true" value={website} onChange={(event) => setWebsite(event.target.value)} className="absolute -left-[10000px] h-px w-px opacity-0" />
        </form>
      </Card>
    </div>
  </main>;
}
