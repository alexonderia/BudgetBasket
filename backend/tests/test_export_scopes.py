from io import BytesIO

from openpyxl import load_workbook

from app.seed import DDS_LICENSE_ID, DEPARTMENT_ID, MODULE_ALPHA_ID, MODULE_BETA_ID, REQUEST_ID
from tests.test_api import auth, make_client


def exported_request_ids(content: bytes) -> set[str]:
    sheet = load_workbook(BytesIO(content)).active
    return {row[9] for row in sheet.iter_rows(min_row=2, values_only=True) if row[9]}


def exported_purposes(content: bytes) -> set[str]:
    sheet = load_workbook(BytesIO(content)).active
    return {row[4] for row in sheet.iter_rows(min_row=2, values_only=True) if row[4]}


def test_export_can_select_a_department_modules_and_fixed_requests(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    repo = client.app.state.repo
    repo.create(
        "requests",
        {
            "id": REQUEST_ID,
            "economist_id": None,
            "unit_id": MODULE_ALPHA_ID,
            "sum_plan": 0,
            "sum_fact": 0,
            "status": "approved",
            "frozen": True,
            "fixed": True,
        },
    )
    beta_request_id = "40000000-0000-0000-0000-000000000099"
    repo.create(
        "requests",
        {
            "id": beta_request_id,
            "economist_id": None,
            "unit_id": MODULE_BETA_ID,
            "sum_plan": 0,
            "sum_fact": 0,
            "status": "approved",
            "frozen": False,
        },
    )
    repo.create(
        "req_items",
        {
            "id": "80000000-0000-0000-0000-000000000099",
            "request_id": REQUEST_ID,
            "dds_id": DDS_LICENSE_ID,
            "invest_id": None,
            "name": "Доход от лицензий",
            "sum_plan": 100,
            "sum_fact": 0,
            "justification": "Доход",
            "status": "approved",
            "comment": "",
            "is_income": True,
        },
    )

    department_export = client.get(
        "/requests/export/closed",
        params={"department_ids": DEPARTMENT_ID, "statuses": "approved", "fixed_only": "true"},
        headers=admin,
    )
    assert department_export.status_code == 200
    assert exported_request_ids(department_export.content) == {REQUEST_ID}

    module_export = client.get(
        "/requests/export/closed",
        params={"module_ids": MODULE_BETA_ID, "statuses": "approved"},
        headers=admin,
    )
    assert module_export.status_code == 200
    assert exported_request_ids(module_export.content) == {beta_request_id}

    income_export = client.get(
        "/requests/export/closed",
        params={"department_ids": DEPARTMENT_ID, "statuses": "approved", "export_kind": "income"},
        headers=admin,
    )
    assert income_export.status_code == 200
    assert exported_request_ids(income_export.content) == {REQUEST_ID}
    assert exported_purposes(income_export.content) == {"Доход"}
