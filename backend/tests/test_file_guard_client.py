from __future__ import annotations

import asyncio
from io import BytesIO

import httpx
import pytest
from starlette.datastructures import Headers, UploadFile

from app.config import Settings
from app.services.file_guard_client import FileGuardClient, FileGuardUnavailableError


def upload() -> UploadFile:
    return UploadFile(
        file=BytesIO(b"content"),
        filename="offer.pdf",
        headers=Headers({"content-type": "application/pdf"}),
    )


def test_client_maps_timeout_to_unavailable_and_rewinds_upload(monkeypatch) -> None:
    class TimeoutClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            raise httpx.ReadTimeout("timed out")

    monkeypatch.setattr(httpx, "AsyncClient", TimeoutClient)
    file = upload()

    with pytest.raises(FileGuardUnavailableError):
        asyncio.run(FileGuardClient(Settings()).validate(file))

    assert file.file.tell() == 0


def test_client_rejects_malformed_response(monkeypatch) -> None:
    class BadResponse:
        status_code = 200

        def json(self):
            return {"valid": True}

    class BadClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return BadResponse()

    monkeypatch.setattr(httpx, "AsyncClient", BadClient)

    with pytest.raises(FileGuardUnavailableError):
        asyncio.run(FileGuardClient(Settings()).validate(upload()))
