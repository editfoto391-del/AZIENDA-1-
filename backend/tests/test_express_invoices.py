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


def test_previous_invoice_query_includes_older_invoices_from_both_sections():
    assert server.previous_invoice_query(
        "customer-1", "2026-11-01", "new-invoice",
    ) == {
        "customer_id": "customer-1",
        "date": {"$lt": "2026-11-01"},
        "archived": {"$ne": True},
        "status": {"$nin": ["draft", "void"]},
        "id": {"$ne": "new-invoice"},
    }

    cross_section_query = server.previous_invoice_query("customer-1", "2026-11-01")
    assert "invoice_type" not in cross_section_query
    assert "id" not in cross_section_query
