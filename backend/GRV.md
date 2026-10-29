# Goods Received Vouchers

GRV is the official receiving workflow for new supplier deliveries. Create a draft linked to an open purchase order (or a standalone GRV), record actual/accepted/rejected/damaged quantities, then confirm it after inspection.

On confirmation, accepted quantities are grouped by stock item and posted once to the existing stock movement ledger with the GRV number, received date, warehouse, and weighted unit cost. The purchase order's received quantities are updated using the actual delivered quantities, including rejected goods. Duplicate GRV confirmations are guarded by unique movement keys and a receipt marker on the purchase order.

GRVs do not create Buyings, expenses, supplier invoices, or payments. The legacy `POST /purchase-orders/{id}/receive` endpoint returns HTTP 409 and cannot post receipts; use GRV instead. Existing purchase orders, Buyings, and stock movements are not migrated or rewritten.

Confirmed GRVs are immutable. Company administrators can reverse one with a required reason; the reversal posts separate stock movements and reopens the related purchase-order quantities when stock is available. GRV records and the new indexes are scoped to the active company database/profile.

PDF vouchers are generated in the browser. The current ERP has no document-upload storage, so GRVs retain delivery-note numbers and notes rather than uploaded attachments.
