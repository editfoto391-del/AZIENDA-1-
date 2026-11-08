import asyncio

import pytest
from fastapi import HTTPException

import server


@pytest.mark.parametrize(
    ("endpoint", "args"),
    [
        (
            server.add_buying,
            (server.BuyingIn(source="Supplier", quantity=1, unit_price=1),),
        ),
        (
            server.edit_buying,
            ("buying-1", server.BuyingIn(source="Supplier", quantity=1, unit_price=1)),
        ),
        (
            server.authorize_buying_edit,
            ("buying-1", server.BuyingEditAuthorizationIn(password="password")),
        ),
        (
            server.void_buying,
            ("buying-1", server.ReasonIn(reason="Duplicate")),
        ),
        (
            server.transfer_buyings_to_grv,
            (server.BuyingGRVTransferIn(buying_ids=["buying-1"]),),
        ),
    ],
)
def test_buying_mutations_are_global_owner_only(monkeypatch, endpoint, args):
    monkeypatch.setenv("ADMIN_EMAIL", "primary@example.test")
    non_global_users = [
        {"id": "company-owner", "email": "company@example.test", "role": "owner"},
        {"id": "other-owner", "email": "other@example.test", "role": "owner"},
        {"id": "worker", "email": "worker@example.test", "role": "user", "is_worker": True},
    ]

    for user in non_global_users:
        with pytest.raises(HTTPException) as error:
            asyncio.run(endpoint(*args, user=user))
        assert error.value.status_code == 403
