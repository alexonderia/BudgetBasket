import io
import zipfile

from openpyxl import load_workbook

from app.seed import CFO_ID, DDS_LICENSE_ID, MODULE_ALPHA_ID, REQUEST_ID
from tests.test_api import auth, make_client


def create_fixed_position_data(client):
    repo = client.app.state.repo
    request = repo.create(
        "requests",
        {
            "id": REQUEST_ID,
            "created_by_id": "00000000-0000-0000-0000-000000000003",
            "budget_year": 2026,
            "unit_id": MODULE_ALPHA_ID,
            "sum_plan": 100,
            "sum_fact": 80,
            "status": "approved",
        },
    )
    position = repo.create(
        "cfo_positions",
        {
            "budget_year": 2026,
            "cfo_unit_id": CFO_ID,
            "dds_id": DDS_LICENSE_ID,
            "invest_id": None,
            "is_income": False,
            "status": "approved",
            "current_step_id": None,
            "frozen": True,
            "fixed": True,
        },
    )
    item = repo.create(
        "req_items",
        {
            "request_id": request["id"],
            "cfo_position_id": position["id"],
            "dds_id": DDS_LICENSE_ID,
            "invest_id": None,
            "name": "Лицензия",
            "sum_plan": 100,
            "sum_fact": 80,
            "justification": "",
            "status": "approved_with_changes",
            "comment": "Снижено",
            "is_income": False,
        },
    )
    return request, position, item


def test_export_fixed_scope_uses_cfo_positions(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    create_fixed_position_data(client)

    exported = client.get(
        "/requests/export/closed",
        params={"statuses": "approved", "fixed_only": "true"},
        headers=admin,
    )
    assert exported.status_code == 200, exported.text
    workbook = load_workbook(io.BytesIO(exported.content))
    assert "Состав" in workbook.sheetnames
    assert any(
        cell.value == "Лицензия"
        for row in workbook["Состав"].iter_rows()
        for cell in row
    )


def test_export_archive_keeps_files_linked_to_position_contributions(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    _request, _position, item = create_fixed_position_data(client)
    repo = client.app.state.repo
    storage = repo.create(
        "storage_objects",
        {
            "storage_bucket": "budgetbasket-files",
            "storage_key": "tests/evidence.png",
            "content_sha256": "0" * 64,
            "mime_type": "image/png",
            "size_bytes": 4,
        },
    )
    file = repo.create(
        "files",
        {"id_storage_object": storage["id"], "original_name": "evidence.png"},
    )
    repo.insert("req_item_files", {"file_id": file["id"], "req_item_id": item["id"]})
    client.app.state.file_service.object_storage.put_object(
        "tests/evidence.png", b"test", "image/png"
    )

    exported = client.get(
        "/requests/export/closed",
        params={
            "statuses": "approved",
            "fixed_only": "true",
            "include_files": "true",
        },
        headers=admin,
    )
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        names = archive.namelist()
    assert any(name.endswith(".xlsx") for name in names)
    assert any(name.endswith("evidence.png") for name in names)
