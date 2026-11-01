import server


def test_invoice_list_query_keeps_express_invoices_separate():
    assert server.invoice_list_query() == {
        "archived": {"$ne": True},
        "invoice_type": {"$ne": "express"},
    }
    assert server.invoice_list_query(express=True) == {
        "archived": {"$ne": True},
        "invoice_type": "express",
    }


def test_archived_invoice_query_preserves_type_separation():
    assert server.invoice_list_query(include_archived=True) == {
        "invoice_type": {"$ne": "express"},
    }
    assert server.invoice_list_query(express=True, include_archived=True) == {
        "invoice_type": "express",
    }


def test_previous_invoice_query_limits_balances_to_older_invoices_in_same_section():
    assert server.previous_invoice_query(
        "customer-1", "standard", "2026-11-01", "new-invoice",
    ) == {
        "customer_id": "customer-1",
        "date": {"$lt": "2026-11-01"},
        "archived": {"$ne": True},
        "status": {"$nin": ["draft", "void"]},
        "invoice_type": {"$ne": "express"},
        "id": {"$ne": "new-invoice"},
    }

    express_query = server.previous_invoice_query(
        "customer-1", "express", "2026-11-01",
    )
    assert express_query["invoice_type"] == "express"
    assert "id" not in express_query
