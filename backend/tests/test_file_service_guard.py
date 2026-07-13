from __future__ import annotations

import asyncio
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

from app.config import Settings
from app.services.file_guard_client import FileGuardUnavailableError
from app.services.file_service import FileService


class FakeRepository:
    def __init__(self):
        self.rows = {"storage_objects": [], "files": []}

    def load_all(self, collection):
        return list(self.rows[collection])

    def create(self, collection, payload):
        row = {"id": len(self.rows[collection]) + 1, **payload}
        self.rows[collection].append(row)
        return row


class FakeStorage:
    def __init__(self):
        self.puts = []

    def put_object(self, key, content, content_type):
        self.puts.append((key, content, content_type))


class AllowingGuard:
    async def validate(self, upload):
        return SimpleNamespace(
            valid=True,
            detected_mime_type="application/pdf",
            size_bytes=7,
            reason_code=None,
            message=None,
            warnings=[],
        )


class RejectingGuard:
    async def validate(self, upload):
        return SimpleNamespace(
            valid=False,
            detected_mime_type="application/octet-stream",
            size_bytes=7,
            reason_code="MIME_MISMATCH",
            message="Тип содержимого файла не соответствует его расширению.",
            warnings=[],
        )


class UnavailableGuard:
    async def validate(self, upload):
        raise FileGuardUnavailableError


def make_upload() -> UploadFile:
    return UploadFile(
        file=BytesIO(b"content"),
        filename="offer.pdf",
        headers=Headers({"content-type": "application/pdf"}),
    )


def make_service(guard):
    repo = FakeRepository()
    storage = FakeStorage()
    service = FileService(repo, SimpleNamespace(), ".", Settings(), guard, object_storage=storage)
    return service, repo, storage


def test_successful_validation_precedes_normal_storage_and_database_write() -> None:
    service, repo, storage = make_service(AllowingGuard())

    created = asyncio.run(service._upload(make_upload()))

    assert created["original_name"] == "offer.pdf"
    assert len(storage.puts) == 1
    assert storage.puts[0][1:] == (b"content", "application/pdf")
    assert len(repo.rows["storage_objects"]) == 1
    assert len(repo.rows["files"]) == 1


@pytest.mark.parametrize("guard", [RejectingGuard(), UnavailableGuard()])
def test_rejection_or_unavailability_writes_nothing(guard) -> None:
    service, repo, storage = make_service(guard)

    with pytest.raises(HTTPException):
        asyncio.run(service._upload(make_upload()))

    assert storage.puts == []
    assert repo.rows["storage_objects"] == []
    assert repo.rows["files"] == []
