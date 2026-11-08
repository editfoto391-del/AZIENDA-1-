import { Check, Clock3, Factory, RefreshCw, Trash2 } from "lucide-react";
import { Badge, Btn, Card, Modal } from "@/components/common";

const moneySafeQuantity = (value) => Number(value || 0).toLocaleString("en-ZA");

const statusDetails = {
  ready: { label: "Completed · available on floor", cls: "border-emerald-200 bg-emerald-50 text-emerald-800", icon: Check },
  partial: { label: "In progress · partial stock available", cls: "border-amber-200 bg-amber-50 text-amber-800", icon: Clock3 },
  pending: { label: "Pending · production required", cls: "border-slate-200 bg-slate-100 text-slate-700", icon: Factory },
};

function QuantityCard({ label, value, subdued = false }) {
  return (
    <div className={"rounded-xl border p-4 " + (subdued ? "border-slate-200 bg-slate-50" : "border-emerald-100 bg-white")}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-slate-950">{moneySafeQuantity(value)}</p>
    </div>
  );
}

export default function SmartProductionPlanner({ plan, loading, onRefresh, onRelease, onClose }) {
  const readyCount = plan?.ready_orders?.length || 0;
  const employees = plan?.employee_tasks || [];
  return (
    <Modal open={!!plan || loading} onClose={onClose} title="Smart Production Planner" wide>
      {loading && !plan ? (
        <div className="p-8 text-center text-sm text-slate-500" role="status">Checking selected orders and current floor stock…</div>
      ) : plan ? (
        <div className="max-h-[calc(100vh-9rem)] space-y-6 overflow-y-auto p-1" data-testid="smart-production-planner">
          <div className="flex flex-col gap-3 rounded-2xl bg-[#10251f] p-5 text-white sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-200">Proposal · no inventory or production changes</p>
              <p className="mt-1 text-sm text-emerald-50/80">
                Current stock is revalidated on refresh. Production, orders and piecework are changed only by existing authorised workflows.
              </p>
            </div>
            <Badge cls="border-white/20 bg-white/10 text-white">{plan.status === "active" ? "Active proposal" : plan.status}</Badge>
          </div>

          <section className="space-y-3">
            <div>
              <h3 className="font-display text-lg font-semibold text-slate-950">Order summary</h3>
              <p className="text-xs text-slate-500">{readyCount} of {plan.orders.filter((order) => order.has_production_items).length} orders with Candy, Strong Boy or Ribbon pieces can be fulfilled immediately from available stock.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <QuantityCard label="Eligible pieces required" value={plan.total_required} />
              <QuantityCard label="Available after reservations" value={plan.total_available} subdued />
              <QuantityCard label="Missing pieces" value={plan.total_missing} />
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr><th className="px-3 py-2">Order</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Required</th><th className="px-3 py-2">Available</th><th className="px-3 py-2">Missing</th><th className="px-3 py-2">Status</th></tr>
                </thead>
                <tbody>{plan.orders.map((order) => (
                  <tr key={order.order_id} className="border-t border-slate-100">
                    <td className="px-3 py-3 font-mono font-semibold">{order.reference}</td>
                    <td className="px-3 py-3">{order.customer_name || "—"}</td>
                    <td className="px-3 py-3">{moneySafeQuantity(order.required_quantity)}</td>
                    <td className="px-3 py-3">{moneySafeQuantity(order.available_quantity)}</td>
                    <td className="px-3 py-3">{moneySafeQuantity(order.missing_quantity)}</td>
                    <td className="px-3 py-3">
                      {order.unresolved
                        ? <Badge cls="border-red-200 bg-red-50 text-red-800">Needs review</Badge>
                        : !order.has_production_items
                          ? <Badge cls="border-slate-200 bg-slate-50 text-slate-500">No matching pieces</Badge>
                          : <Badge cls={order.ready ? statusDetails.ready.cls : statusDetails.pending.cls}>{order.ready ? "Ready" : "Production needed"}</Badge>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-display text-lg font-semibold text-slate-950">Pieces to make</h3>
              <p className="text-xs text-slate-500">Only Candy, Strong Boy, Ribbon Black and Ribbon Pink are shown. Quantities are consolidated by size and allocated to each order once.</p>
            </div>
            {plan.lines.length ? <div className="grid gap-3">
              {plan.lines.map((line) => {
                const status = statusDetails[line.status] || statusDetails.pending;
                const StatusIcon = status.icon;
                return (
                  <Card key={line.key.join("|")} className="space-y-3 rounded-xl border-slate-200 p-4 shadow-none">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-slate-950">{line.product} · {line.size}</p>
                        <p className="text-xs text-slate-500">{line.color || "Colour not specified"} · {line.product_type}</p>
                      </div>
                      <Badge cls={status.cls}><StatusIcon size={13} /> {status.label}</Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                              <p>Ordered <strong>{moneySafeQuantity(line.total_required)}</strong></p>
                              <p>On floor <strong>{moneySafeQuantity(line.available_quantity)}</strong></p>
                              <p>To make <strong>{moneySafeQuantity(line.missing_quantity)}</strong></p>
                            </div>
                            <p className="text-xs text-slate-600">
                              {line.missing_quantity > 0 ? "Make for: " : "Allocated to: "}
                              {line.orders.map((allocation) => (
                                `${allocation.order_reference} (${moneySafeQuantity(line.missing_quantity > 0 ? allocation.missing_quantity : allocation.quantity)} pcs)`
                              )).filter((entry) => !entry.includes("(0 pcs)")).join(" · ") || "No order allocation"}
                            </p>
                  </Card>
                );
              })}
            </div> : <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">No exact product requirements could be read from these orders. Review the listed order lines before planning production.</p>}
            {!!plan.unresolved_lines?.length && <div role="alert" className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <p className="font-semibold">Manual order-line review required</p>
              {plan.unresolved_lines.map((line, index) => <p key={`${line.order_id}-${line.line_number}-${index}`}>{line.order_reference} · line {line.line_number}: {line.reason}</p>)}
            </div>}
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-display text-lg font-semibold text-slate-950">Employee production assignments</h3>
              <p className="text-xs text-slate-500">Only Candy, Strong Boy, Ribbon Black and Ribbon Pink shortages are assigned to Hassan, Ayanda and Asive. No salary or piecework record is created.</p>
            </div>
            {employees.length ? <div className="grid gap-3 md:grid-cols-3">
              {employees.map((employee) => (
                <Card key={employee.employee_id} className="rounded-xl border-slate-200 p-4 shadow-none">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-semibold text-slate-950">{employee.employee_name}</h4>
                    <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800">{moneySafeQuantity(employee.total_pieces)} pcs</Badge>
                  </div>
                  {employee.tasks.length ? <ul className="mt-3 space-y-3 text-xs">
                    {employee.tasks.map((task, index) => (
                      <li key={`${task.orders.map((order) => order.order_id).join("-")}-${task.product}-${task.size}-${index}`} className="border-t border-slate-100 pt-2">
                        <p className="font-semibold">Make {moneySafeQuantity(task.quantity)} pcs · {task.product} · {task.size}{task.color ? ` · ${task.color}` : ""}</p>
                        <p className="mt-1 text-slate-500">For {task.orders.map((order) => `${order.order_reference} (${moneySafeQuantity(order.quantity)} pcs)`).join(" · ")}</p>
                      </li>
                    ))}
                  </ul> : <p className="mt-3 text-xs text-slate-500">No pieces currently assigned.</p>}
                </Card>
              ))}
            </div> : <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">No active ASIVE TAILOR, AYANDA TAILOR or HASSAN TAILOR profile was found. Eligible pieces cannot be assigned.</p>}
            {plan.unassigned_employee_quantity > 0 && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{moneySafeQuantity(plan.unassigned_employee_quantity)} eligible pieces remain unassigned because no active named employee profile was found.</p>}
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-display text-lg font-semibold text-slate-950">Progress tracking</h3>
              <p className="text-xs text-slate-500">Status reflects revalidated stock availability only. This planner does not attribute production output to an order.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 p-3 text-sm"><Badge cls={statusDetails.pending.cls}>Pending</Badge><p className="mt-2 text-xs text-slate-500">Requirements with no available floor stock.</p></div>
              <div className="rounded-lg border border-slate-200 p-3 text-sm"><Badge cls={statusDetails.partial.cls}>In progress</Badge><p className="mt-2 text-xs text-slate-500">Some, but not all, required pieces are available.</p></div>
              <div className="rounded-lg border border-slate-200 p-3 text-sm"><Badge cls={statusDetails.ready.cls}>Completed</Badge><p className="mt-2 text-xs text-slate-500">All requested pieces are available on the floor.</p></div>
            </div>
          </section>

          {!!plan.warnings?.length && <div className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
            {plan.warnings.map((warning) => <p key={warning}>• {warning}</p>)}
          </div>}

          <div className="sticky bottom-0 flex flex-wrap justify-between gap-2 border-t border-slate-200 bg-white py-3">
            <Btn variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={onRelease} data-testid="release-smart-arrangement"><Trash2 size={14} /> Release proposal</Btn>
            <div className="flex flex-wrap justify-end gap-2">
              <Btn variant="outline" onClick={onClose}>Close</Btn>
              <Btn onClick={onRefresh} disabled={loading} data-testid="revalidate-smart-arrangement"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Revalidate stock</Btn>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
