# Goods Received Vouchers

GRV is the official receiving workflow for new supplier deliveries. Create a standard draft linked to an open purchase order (or a standalone GRV), record actual/accepted/rejected/damaged quantities, then confirm it after inspection. Quick GRV is a standalone scanner workflow: choose a supplier and receiver, scan product labels to match stock sizes, then enter quantities and optional unit costs before saving and confirming.

On confirmation, accepted quantities are grouped by stock item and posted once to the existing stock movement ledger with the GRV number, received date, warehouse, and weighted unit cost. The purchase order's received quantities are updated using the actual delivered quantities, including rejected goods. Duplicate GRV confirmations are guarded by unique movement keys and a receipt marker on the purchase order.

For selling-product GRVs, each line can record its purchase unit cost and intended sale price. On SUPERIQFOAM, sale prices are entered separately for Zones 1 and 2; other companies use one sale price. Confirming the GRV creates or updates the matching active, confirmed price-list entry for accepted products. Existing price-list access restrictions apply; a worker must have a company owner confirm a GRV that changes the price list. Reversing a GRV reverses stock but does not roll back its price-list changes.

Standalone selling-product GRVs can also add a new product/category. The new stock record and product-catalog identity are created on confirmation and accepted quantities are posted to its stock ledger. A sale price for each applicable zone is required so the new category and size can be selected on invoices. A GRV cannot create a product that already exists in stock or add new products to a purchase-order GRV.

GRVs do not create Buyings, expense records, supplier invoices, or payments. Confirmed accepted GRV costs are included separately in estimated company profit (payments received minus recorded expenses, Buyings, calculated gross salaries, and GRV costs); drafts and cancelled/reversed GRVs are excluded. The report keeps GRV inventory movements separate from operating expenses and never treats total invoiced as collected revenue. The legacy `POST /purchase-orders/{id}/receive` endpoint returns HTTP 409 and cannot post receipts; use GRV instead. Existing purchase orders, Buyings, and stock movements are not migrated or rewritten.

Confirmed GRVs are immutable. Company administrators can reverse one with a required reason; the reversal posts separate stock movements and reopens the related purchase-order quantities when stock is available. An interrupted reversal remains retryable and uses expiring stock locks so an abandoned lock does not permanently block later stock operations. Only the global owner and the owner of the active company can delete GRVs. They may select and delete one or multiple draft, pending-inspection, or cancelled (including reversed) GRVs; a confirmed GRV must be reversed before deletion. Admins and workers cannot delete GRVs. GRV records and the new indexes are scoped to the active company database/profile.

PDF vouchers are generated in the browser. The current ERP has no document-upload storage, so GRVs retain delivery-note numbers and notes rather than uploaded attachments.

## Raw-material GRVs

A GRV has `purpose`: `selling` (default, posts to Stock) or `raw_material` (no stock item or purchase order needed).
On confirmation raw-material quantities are added, idempotently via `raw_material_movements`, to:
- `chemical_inventory` (Chemicals Quantity) when `is_chemical` is set and the company is SUPERIQFOAM or IQFOAM MANUFACTORING (Size must be a numeric capacity);
- `company_inventory` otherwise (including chemicals for IQFOAM WHOLESALERS).
Reversing the GRV subtracts the same quantities and fails if not enough remain.
