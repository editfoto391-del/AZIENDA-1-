import server


def test_new_invoice_defaults_to_issued_when_status_is_omitted():
    body = server.InvoiceIn()

    assert body.status == "issued"
    assert "status" not in body.model_fields_set


def test_new_invoice_is_draft_only_when_explicitly_requested():
    body = server.InvoiceIn(status="draft")

    assert body.status == "draft"
    assert "status" in body.model_fields_set


def test_update_preserves_existing_draft_when_status_is_omitted():
    body = server.InvoiceIn()

    assert server.invoice_status_for_update(body, "draft") == "draft"


def test_update_can_issue_a_draft_when_status_is_explicitly_issued():
    body = server.InvoiceIn(status="issued")

    assert server.invoice_status_for_update(body, "draft") == "issued"
