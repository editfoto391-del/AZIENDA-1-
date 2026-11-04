import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CreditCard, Eye, ReceiptText, Search, Wallet } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtMoney, newKey, STATUS_META, today } from "@/lib/format";
import { Badge, Btn, Card, Empty, Input, Modal, PageHeader, Select, Textarea } from "@/components/common";
import { usesUnifiedPriceList } from "@/lib/company";
import { PAYMENT_METHODS, RECEIVING_OPTIONS } from "@/lib/paymentMethods";
import { useAuth } from "@/context/AuthContext";

const newPayment = (invoice) => ({
  invoice,
  amount: Number(invoice.outstanding || 0).toFixed(2),
  method: "Cash",
  receiving_on: "",
  date: today(),
  reference: "",
  notes: "",
  idempotency_key: newKey(),
});

const toCents = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};

export default function ClientPayments({ express = false }) {
  const { user } = useAuth();
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [query, setQuery] = useState("");
  const [balanceFilter, setBalanceFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [payment, setPayment] = useState(null);
  const [viewPayment, setViewPayment] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingPaymentReverse, setPendingPaymentReverse] = useState(null);
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [authorizingReverse, setAuthorizingReverse] = useState(false);
  const [expressPaymentsSummaryOpen, setExpressPaymentsSummaryOpen] = useState(false);
  const [expressPaymentsDate, setExpressPaymentsDate] = useState(today());
  const [expressPayments, setExpressPayments] = useState([]);
  const [expressPaymentsLoading, setExpressPaymentsLoading] = useState(false);
  const [expressPaymentsError, setExpressPaymentsError] = useState("");
  const [updatingExpressPaymentId, setUpdatingExpressPaymentId] = useState("");

  const loadCustomers = () => Promise.all([
    api.get("/customers"),
    api.get("/invoices", express ? { express: true } : undefined),
  ])
    .then(([customerData, invoiceData]) => {
      const customerIds = new Set(customerData.map((customer) => customer.id));
      const deletedCustomers = new Map();
      invoiceData.forEach((invoice) => {
        if (invoice.customer_deleted && invoice.customer_id && !customerIds.has(invoice.customer_id) && !deletedCustomers.has(invoice.customer_id)) {
          deletedCustomers.set(invoice.customer_id, {
            id: invoice.customer_id,
            name: invoice.deleted_customer_name || invoice.customer_name || "Deleted customer",
            default_zone: invoice.zone || 1,
            active: false,
            customer_deleted: true,
          });
        }
      });
      setCustomers([...customerData, ...deletedCustomers.values()]);
      setInvoices(invoiceData);
    })
    .catch((error) => toast.error(apiError(error)))
    .finally(() => setLoading(false));

  useEffect(() => { loadCustomers(); }, [express]);

  useEffect(() => {
    if (!express || !expressPaymentsSummaryOpen) return undefined;
    let active = true;
    setExpressPaymentsLoading(true);
    setExpressPaymentsError("");
    api.getUncached("/express-payments", { payment_date: expressPaymentsDate })
      .then((records) => {
        if (active) setExpressPayments(records);
      })
      .catch((error) => {
        if (!active) return;
        setExpressPayments([]);
        setExpressPaymentsError(apiError(error));
      })
      .finally(() => {
        if (active) setExpressPaymentsLoading(false);
      });
    return () => { active = false; };
  }, [express, expressPaymentsSummaryOpen, expressPaymentsDate]);

  const filteredCustomers = useMemo(() => customers.filter((customer) =>
    `${customer.name} ${customer.phone || ""} ${customer.email || ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  ), [customers, query]);
  const balanceCentsByCustomer = useMemo(() => {
    const balances = invoices.reduce((totals, invoice) => {
      if (!["void", "draft"].includes(invoice.status)) {
        totals[invoice.customer_id] = (totals[invoice.customer_id] || 0) + toCents(invoice.outstanding);
      }
      return totals;
    }, {});
    customers.forEach((customer) => {
      if (express ? customer.other_balance_express : !customer.other_balance_express) {
        balances[customer.id] = (balances[customer.id] || 0) + toCents(customer.other_balance);
      }
    });
    return balances;
  }, [invoices, customers, express]);
  const customerCounts = useMemo(() => customers.reduce((counts, customer) => {
    if ((balanceCentsByCustomer[customer.id] || 0) > 0) counts.withBalance += 1;
    else counts.withoutBalance += 1;
    return counts;
  }, { withBalance: 0, withoutBalance: 0 }), [customers, balanceCentsByCustomer]);
  const totalOutstandingCents = customers.reduce(
    (total, customer) => total + (balanceCentsByCustomer[customer.id] || 0),
    0,
  );
  const visibleCustomers = filteredCustomers.filter((customer) => {
    const hasBalance = (balanceCentsByCustomer[customer.id] || 0) > 0;
    return balanceFilter === "all" || (balanceFilter === "with-balance" ? hasBalance : !hasBalance);
  });

  const openProfile = async (customer) => {
    setProfile({ customer, summary: null });
    setProfileLoading(true);
    try {
      const summary = await api.get(`/customers/${customer.id}/summary`, express ? { express_only: true } : undefined);
      setProfile({ customer, summary });
    } catch (error) {
      setProfile(null);
      toast.error(apiError(error));
    } finally {
      setProfileLoading(false);
    }
  };

  const openPayment = async (invoice) => {
    setPayment(newPayment(invoice));
  };

  const openOtherBalancePayment = () => {
    const customer = profile.customer;
    setPayment({
      ...newPayment({ customer_name: customer.name, number: "Other balance", outstanding: profile.summary.other_balance }),
      otherBalanceCustomerId: customer.id,
    });
  };

  const refreshProfile = async () => {
    if (!profile?.customer) return;
    const summary = await api.get(`/customers/${profile.customer.id}/summary`, express ? { express_only: true } : undefined);
    setProfile((current) => current ? { ...current, summary } : current);
  };

  const reverseOtherBalancePayment = async (record) => {
    const reason = window.prompt(`Reverse payment of ${fmtMoney(record.amount)}? Enter a reason:`);
    if (!reason || !reason.trim()) return;
    try {
      await api.post(`/payments/${record.id}/reverse`, { reason: reason.trim() });
      toast.success("Payment reversed");
      await Promise.all([refreshProfile(), loadCustomers()]);
    } catch (error) { toast.error(apiError(error)); }
  };

  const deleteOtherBalancePayment = async (record) => {
    if (!window.confirm(`Delete this payment from the history? The balance will NOT change.`)) return;
    try {
      await api.del(`/payments/${record.id}/other-balance`);
      toast.success("Payment deleted");
      await Promise.all([refreshProfile(), loadCustomers()]);
    } catch (error) { toast.error(apiError(error)); }
  };

  const performInvoicePaymentAction = async (action, record, reason, supervisorAuthorization) => {
    try {
      if (action === "delete_payment") {
        await api.delWithData(`/payments/${record.id}`, {
          reason,
          supervisor_authorization: supervisorAuthorization,
        });
      } else {
        await api.post(`/payments/${record.id}/reverse`, {
          reason,
          supervisor_authorization: supervisorAuthorization,
        });
      }
      setPendingPaymentReverse(null);
      setSupervisorPassword("");
      toast.success(action === "delete_payment" ? "Payment deleted" : "Payment reversed");
      await Promise.all([refreshProfile(), loadCustomers()]);
    } catch (error) { toast.error(apiError(error)); }
  };

  const requestInvoicePaymentAction = (action, record) => {
    if (action === "delete_payment" && !window.confirm(`Permanently delete this payment of ${fmtMoney(record.amount)}? Its invoice balance will be recalculated.`)) return;
    const verb = action === "delete_payment" ? "Delete" : "Reverse";
    const reason = window.prompt(`${verb} payment of ${fmtMoney(record.amount)}? Enter a reason:`);
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required");
    const pendingAction = { action, record, reason: reason.trim() };
    if (user?.can_skip_supervisor_approval) {
      performInvoicePaymentAction(action, record, pendingAction.reason);
    } else {
      setPendingPaymentReverse(pendingAction);
    }
  };

  const authorizePaymentReverse = async (event) => {
    event.preventDefault();
    if (!pendingPaymentReverse || !supervisorPassword || authorizingReverse) return;
    setAuthorizingReverse(true);
    try {
      const { action, record } = pendingPaymentReverse;
      const approval = await api.post(`/invoices/${record.invoice_id}/authorize-action`, {
        password: supervisorPassword,
        action,
        target_id: record.id,
      });
      await performInvoicePaymentAction(action, record, pendingPaymentReverse.reason, approval.authorization_id);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setAuthorizingReverse(false);
    }
  };

  const recordPayment = async () => {
    if (!payment || saving) return;
    const amount = Number(payment.amount);
    if (!(amount > 0)) {
      toast.error("Amount must be greater than 0");
      return;
    }
    if (payment.method !== "Cash" && !payment.receiving_on) {
      toast.error("Select where the payment was received");
      return;
    }
    setSaving(true);
    try {
      const { invoice, otherBalanceCustomerId, idempotency_key, ...paymentDetails } = payment;
      if (otherBalanceCustomerId) {
        await api.post(`/customers/${otherBalanceCustomerId}/other-balance/pay`, { ...paymentDetails, note: paymentDetails.notes, amount, express });
      } else {
        await api.post(`/invoices/${invoice.id}/payments`, { ...paymentDetails, idempotency_key, amount });
      }
      setPayment(null);
      toast.success("Payment recorded");
      try {
        await Promise.all([refreshProfile(), loadCustomers()]);
      } catch (error) {
        toast.error(`Payment recorded, but balances could not be refreshed: ${apiError(error)}`);
      }
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const setExpressPaymentDailyReportInclusion = async (record) => {
    if (updatingExpressPaymentId) return;
    const included = !record.include_on_daily_report;
    setUpdatingExpressPaymentId(record.id);
    setExpressPaymentsError("");
    try {
      await api.post(`/payments/${record.id}/daily-report`, { included });
      setExpressPayments((current) => current.map((paymentRecord) => (
        paymentRecord.id === record.id
          ? { ...paymentRecord, include_on_daily_report: included }
          : paymentRecord
      )));
      toast.success(included ? "Payment included in the daily report" : "Payment removed from the daily report");
    } catch (error) {
      setExpressPaymentsError(apiError(error));
      toast.error(apiError(error));
    } finally {
      setUpdatingExpressPaymentId("");
    }
  };

  const expressPaymentsTotal = expressPayments.reduce((total, record) => total + toCents(record.amount), 0) / 100;
  const expressPaymentsReportTotal = expressPayments
    .filter((record) => record.include_on_daily_report)
    .reduce((total, record) => total + toCents(record.amount), 0) / 100;

  const mostUsedZone = (invoices, fallback) => {
    const counts = (invoices || []).reduce((result, invoice) => {
      if (!["void", "draft"].includes(invoice.status)) {
        const zone = Number(invoice.zone || fallback || 1);
        result[zone] = (result[zone] || 0) + 1;
      }
      return result;
    }, {});
    const zones = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || Number(a) - Number(b));
    return zones.length ? `Zone ${zones[0]}` : (fallback ? `Zone ${fallback}` : "—");
  };

  return (
    <div>
      <PageHeader title={express ? "Express Website Payments and Balances" : "Clients Payments and Balances"} subtitle={loading ? "Loading clients..." : `${customers.length} clients`}>
        {express && <Btn
          variant="outline"
          onClick={() => {
            setExpressPaymentsDate(today());
            setExpressPaymentsSummaryOpen(true);
          }}
          data-testid="express-payments-summary-open"
        >
          <ReceiptText size={16} /> Payments summary
        </Btn>}
      </PageHeader>

      <Card className="p-4 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search clients..."
            aria-label="Search clients"
            data-testid="client-payments-search"
            className="w-full rounded-lg border border-input pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary"
          />
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { id: "all", title: "All clients", count: customers.length, amount: null, cls: "border-slate-200" },
          { id: "with-balance", title: "Clients with balance", count: customerCounts.withBalance, amount: fmtMoney(totalOutstandingCents / 100), cls: "border-red-200" },
          { id: "without-balance", title: "Clients with no balance", count: customerCounts.withoutBalance, amount: null, cls: "border-emerald-200" },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setBalanceFilter(item.id)}
            aria-pressed={balanceFilter === item.id}
            data-testid={`client-balance-filter-${item.id}`}
            className={`rounded-lg border bg-white p-4 text-left shadow-sm transition-colors ${item.cls} ${balanceFilter === item.id ? "ring-2 ring-primary/30" : "hover:bg-slate-50"}`}
          >
            <span className="block text-xs font-semibold text-slate-500">{item.title}</span>
            <span className="mt-1 block text-xl font-bold text-slate-800">{item.count}</span>
            {item.amount !== null && <span className="mt-1 block text-sm font-mono font-semibold text-red-600">Total outstanding: {item.amount}</span>}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading clients...</p> : visibleCustomers.length === 0 ? (
          <Empty
            icon={Wallet}
            title={filteredCustomers.length === 0 ? "No clients found" : balanceFilter === "with-balance" ? "No clients with a balance" : "No clients without a balance"}
            hint={query ? "Try changing your search." : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                  <th className="px-4 py-3 font-semibold">Client</th>
                  <th className="px-4 py-3 font-semibold">Phone</th>
                  {!unifiedPriceList && <th className="px-4 py-3 font-semibold">Zone</th>}
                  <th className="px-4 py-3 font-semibold">Payment Terms</th>
                  <th className="px-4 py-3 font-semibold text-right">Outstanding</th>
                  <th className="px-4 py-3 font-semibold text-right">Details</th>
                </tr>
              </thead>
              <tbody>
                {visibleCustomers.map((customer) => (
                  <tr key={customer.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`client-balance-row-${customer.id}`}>
                    <td className="px-4 py-3 font-semibold text-slate-800">{customer.name}{customer.customer_deleted && <Badge cls="ml-2 border-red-200 bg-red-50 text-red-700">Deleted customer</Badge>}</td>
                    <td className="px-4 py-3 text-slate-500">{customer.phone || "—"}</td>
                    {!unifiedPriceList && <td className="px-4 py-3"><Badge cls="bg-blue-50 text-blue-700 border-blue-200">Zone {customer.default_zone}</Badge></td>}
                    <td className="px-4 py-3 text-slate-500">{customer.payment_terms || "—"}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-red-600">{fmtMoney((balanceCentsByCustomer[customer.id] || 0) / 100)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => openProfile(customer)}
                        aria-label={`View balance for ${customer.name}`}
                        title="View client balances"
                        data-testid={`view-client-balance-${customer.id}`}
                        className="rounded-md p-2 text-slate-400 hover:bg-blue-50 hover:text-primary"
                      >
                        <Eye size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={!!profile}
        onClose={() => setProfile(null)}
        title={profile?.customer.name || "Client details"}
        wide
      >
        {profileLoading || !profile?.summary ? (
          <p className="py-8 text-center text-sm text-slate-400" role="status">Loading client balances...</p>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-400">Zone</p>
                <p className="font-bold text-slate-800">{unifiedPriceList ? "Zone 1" : `Zone ${profile.customer.default_zone || 1}`}</p>
              </div>
              {profile.customer.customer_deleted && <div className="rounded-lg border border-red-200 bg-red-50 p-3 sm:col-span-3">
                <p className="text-sm font-semibold text-red-700">Deleted customer</p>
                <p className="mt-1 text-xs text-red-600">Invoices and payments are retained as financial history.</p>
              </div>}
              <div className="rounded-lg bg-violet-50 p-3">
                <p className="text-xs text-slate-400">Most Used Zone</p>
                <p className="font-bold text-slate-800">{mostUsedZone(profile.summary.invoices, profile.customer.default_zone)}</p>
              </div>
              <div className="rounded-lg bg-blue-50 p-3">
                <p className="text-xs text-slate-400">Total Invoiced</p>
                <p className="font-mono font-bold text-slate-800">{fmtMoney(profile.summary.total_invoiced)}</p>
              </div>
              <div className="rounded-lg bg-red-50 p-3">
                <p className="text-xs text-slate-400">Outstanding</p>
                <p className="font-mono font-bold text-red-600" data-testid="client-outstanding">{fmtMoney(profile.summary.outstanding)}</p>
              </div>
              <div className="rounded-lg bg-emerald-50 p-3">
                <p className="text-xs text-slate-400">Payments Received</p>
                <p className="font-mono font-bold text-emerald-700">{fmtMoney(profile.summary.payments_received)}</p>
              </div>
            </div>

            {(express ? profile.customer.other_balance_express : !profile.customer.other_balance_express) && (
              <section className="rounded-lg border border-orange-200 bg-orange-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-orange-800">Other Balances (Old Invoices)</h4>
                    <p className="font-mono text-lg font-bold text-orange-700" data-testid="client-other-balance">{fmtMoney(profile.summary.other_balance)}</p>
                  </div>
                  <Btn
                    variant="success"
                    disabled={!(Number(profile.summary.other_balance) > 0)}
                    onClick={openOtherBalancePayment}
                    data-testid="pay-client-other-balance"
                  >Pay balance</Btn>
                </div>
              </section>
            )}

            <section>
              <h4 className="mb-2 text-sm font-bold text-slate-700">Invoice History</h4>
              {!profile.summary.invoices.length ? <p className="text-sm text-slate-400">No invoices.</p> : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-400">
                      <tr>
                        <th className="px-3 py-2">Invoice</th>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2 text-right">Total</th>
                        <th className="px-3 py-2 text-right">Outstanding</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.summary.invoices.map((invoice) => (
                        <tr key={invoice.id} className="border-t border-border/60">
                          <td className="px-3 py-2 font-mono font-semibold">{invoice.number || "DRAFT"}{invoice.customer_deleted && <Badge cls="ml-2 border-red-200 bg-red-50 text-red-700">Deleted customer</Badge>}</td>
                          <td className="px-3 py-2 text-slate-500">{fmtDate(invoice.date)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtMoney(invoice.total)}</td>
                          <td className="px-3 py-2 text-right font-mono text-red-600">{fmtMoney(invoice.outstanding)}</td>
                          <td className="px-3 py-2"><Badge cls={STATUS_META[invoice.status]?.cls}>{STATUS_META[invoice.status]?.label || invoice.status}</Badge></td>
                          <td className="px-3 py-2 text-right">
                            {invoice.outstanding > 0 && !["draft", "void"].includes(invoice.status) && (
                              <Btn
                                variant="success"
                                className="px-2.5 py-1.5 text-xs"
                                onClick={() => openPayment(invoice)}
                                data-testid={`make-payment-${invoice.id}`}
                              >
                                <CreditCard size={13} /> Make Payment
                              </Btn>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {(profile.summary.other_balance_payments || []).length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-bold text-slate-700">Other Balances Payments History</h4>
                <div className="space-y-1.5">
                  {profile.summary.other_balance_payments.map((record) => (
                    <div key={record.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm ${record.reversed ? "opacity-60" : ""}`} data-testid={`other-balance-payment-${record.id}`}>
                      <span className="text-slate-500">
                        {fmtDate(record.date)} · {record.method}{record.receiving_on ? ` · ${record.receiving_on}` : ""}
                        {record.reversed && <span className="ml-2 font-semibold text-red-600">Reversed</span>}
                      </span>
                      <div className="flex items-center gap-3">
                        <span className={`font-mono font-semibold ${record.reversed ? "line-through text-slate-400" : "text-emerald-600"}`}>{fmtMoney(record.amount)}</span>
                        {!record.reversed && <button type="button" onClick={() => reverseOtherBalancePayment(record)} className="text-xs text-red-500 hover:underline" data-testid={`reverse-other-balance-${record.id}`}>Reverse</button>}
                        <button type="button" onClick={() => deleteOtherBalancePayment(record)} className="text-xs text-red-600 hover:underline" data-testid={`delete-other-balance-${record.id}`}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h4 className="mb-2 text-sm font-bold text-slate-700">Payments</h4>
              {!profile.summary.payments.length ? <p className="text-sm text-slate-400">No payments.</p> : (
                <div className="space-y-1.5">
                  {profile.summary.payments.map((record) => (
                    <div key={record.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm ${record.reversed ? "opacity-60" : ""}`}>
                      <span className="text-slate-500">
                        {fmtDate(record.date)} · {record.method} · {record.invoice_number || "Invoice"}
                        {record.customer_deleted && <Badge cls="ml-2 border-red-200 bg-red-50 text-red-700">Deleted customer</Badge>}
                        {record.reversed && <span className="ml-2 font-semibold text-red-600">Reversed</span>}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className={`font-mono font-semibold ${record.reversed ? "line-through text-slate-400" : "text-emerald-600"}`}>{fmtMoney(record.amount)}</span>
                        {!record.reversed && <button
                          type="button"
                          onClick={() => requestInvoicePaymentAction("reverse_payment", record)}
                          className="text-xs text-red-500 hover:underline"
                          data-testid={`reverse-payment-${record.id}`}
                        >Reverse</button>}
                        <button
                          type="button"
                          onClick={() => requestInvoicePaymentAction("delete_payment", record)}
                          className="text-xs text-red-700 hover:underline"
                          data-testid={`delete-payment-${record.id}`}
                        >Delete</button>
                        <button
                          type="button"
                          onClick={() => setViewPayment(record)}
                          aria-label={`View payment details for ${record.invoice_number || "invoice"}`}
                          title="View payment details"
                          data-testid={`view-payment-${record.id}`}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-blue-50 hover:text-primary"
                        >
                          <Eye size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </Modal>

      {express && <Modal
        open={expressPaymentsSummaryOpen}
        onClose={() => setExpressPaymentsSummaryOpen(false)}
        title="Express Website Payments Summary"
        wide
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Input
              label="Payment date"
              type="date"
              value={expressPaymentsDate}
              onChange={(event) => setExpressPaymentsDate(event.target.value || today())}
              data-testid="express-payments-summary-date"
            />
            <div className="flex flex-wrap gap-3">
              <div className="rounded-lg bg-emerald-50 px-4 py-2">
                <p className="text-xs text-slate-500">Payments on this date</p>
                <p className="font-mono font-bold text-emerald-700" data-testid="express-payments-summary-total">{fmtMoney(expressPaymentsTotal)}</p>
              </div>
              <div className="rounded-lg bg-blue-50 px-4 py-2">
                <p className="text-xs text-slate-500">Selected for Daily Report</p>
                <p className="font-mono font-bold text-blue-700" data-testid="express-payments-report-total">{fmtMoney(expressPaymentsReportTotal)}</p>
              </div>
            </div>
          </div>

          {expressPaymentsError && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{expressPaymentsError}</p>}
          {expressPaymentsLoading ? (
            <p className="py-8 text-center text-sm text-slate-400" role="status">Loading payments...</p>
          ) : expressPayments.length === 0 ? (
            <Empty title="No Express Website payments on this date" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Client</th>
                    <th className="px-3 py-2">Invoice</th>
                    <th className="px-3 py-2">Method</th>
                    <th className="px-3 py-2">Reference / notes</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-center">Daily Report</th>
                  </tr>
                </thead>
                <tbody>
                  {expressPayments.map((record) => (
                    <tr key={record.id} className="border-t border-border/60">
                      <td className="px-3 py-2 font-semibold text-slate-800">{record.customer_name || "—"}</td>
                      <td className="px-3 py-2">{record.invoice_number || "—"}</td>
                      <td className="px-3 py-2">{record.method || "—"}</td>
                      <td className="px-3 py-2 text-slate-500">{[record.reference, record.notes].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold text-emerald-700">{fmtMoney(record.amount)}</td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={!!record.include_on_daily_report}
                          disabled={!!updatingExpressPaymentId}
                          onChange={() => setExpressPaymentDailyReportInclusion(record)}
                          aria-label={`Include payment for ${record.customer_name || record.invoice_number || "client"} on Daily Report`}
                          data-testid={`express-payment-daily-report-${record.id}`}
                          className="h-4 w-4 accent-emerald-600"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>}

      <Modal open={!!viewPayment} onClose={() => setViewPayment(null)} title="Payment Details" wide>
        {viewPayment && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Invoice", viewPayment.invoice_number || "—"],
                ["Date", fmtDate(viewPayment.date) || "—"],
                ["Method", viewPayment.method || "—"],
                ["Receiving on", viewPayment.receiving_on || "—"],
                ["Amount", fmtMoney(viewPayment.amount)],
                ["Reference", viewPayment.reference || "—"],
                ["Notes", viewPayment.notes || "—"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{value}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!pendingPaymentReverse && !user?.can_skip_supervisor_approval}
        onClose={() => { setPendingPaymentReverse(null); setSupervisorPassword(""); }}
        title="Supervisor approval required"
      >
        <form onSubmit={authorizePaymentReverse} className="space-y-4" data-testid="payment-action-authorization-form">
          <p className="text-sm text-slate-600">Enter the supervisor password to {pendingPaymentReverse?.action === "delete_payment" ? "delete" : "reverse"} this payment. This approval is required for every user role.</p>
          <Input
            label="Supervisor password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={supervisorPassword}
            onChange={(event) => setSupervisorPassword(event.target.value)}
            data-testid="supervisor-password-input"
          />
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => { setPendingPaymentReverse(null); setSupervisorPassword(""); }}>Cancel</Btn>
            <Btn type="submit" disabled={authorizingReverse} data-testid="authorize-payment-action-btn">{authorizingReverse ? "Checking..." : "Approve action"}</Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!payment} onClose={() => setPayment(null)} title="Make Payment">
        {payment && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              {payment.invoice.customer_name} · {payment.invoice.number || "Invoice"} · Outstanding: {fmtMoney(payment.invoice.outstanding)}
            </p>
            <Input
              label="Amount (R)"
              type="number"
              min="0.01"
              step="0.01"
              value={payment.amount}
              onChange={(event) => setPayment({ ...payment, amount: event.target.value })}
              data-testid="client-payment-amount"
            />
            <div className="grid grid-cols-2 gap-3">
              <Select label="Payment Method" value={payment.method} onChange={(event) => setPayment({ ...payment, method: event.target.value })}>
                {PAYMENT_METHODS.map((method) => <option key={method}>{method}</option>)}
              </Select>
              <Input label="Date" type="date" value={payment.date} onChange={(event) => setPayment({ ...payment, date: event.target.value })} />
            </div>
            <Select label="Receiving on" value={payment.receiving_on} onChange={(event) => setPayment({ ...payment, receiving_on: event.target.value })}>
              <option value="">Select receiving account</option>
              {RECEIVING_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </Select>
            <Input label="Reference (optional)" value={payment.reference} onChange={(event) => setPayment({ ...payment, reference: event.target.value })} />
            <Textarea label="Notes (optional)" rows={2} value={payment.notes} onChange={(event) => setPayment({ ...payment, notes: event.target.value })} />
            <div className="flex justify-end gap-2">
              <Btn variant="outline" onClick={() => setPayment(null)}>Cancel</Btn>
              <Btn variant="success" disabled={saving} onClick={recordPayment} data-testid="confirm-client-payment">
                {saving ? "Saving..." : "Confirm Payment"}
              </Btn>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
