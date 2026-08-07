import io
import zipfile
import hashlib
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.config import Settings
from app.factory import create_app
from app.services.file_guard_client import ProcessedFile
from app.seed import DDS_LICENSE_ID, MODULE_ALPHA_ID, DEPARTMENT_ID
from tests.in_memory_repository import InMemoryRepository


class AllowingFileGuard:
    async def validate(self, upload):
        return SimpleNamespace(
            valid=True,
            detected_mime_type=upload.content_type or "application/octet-stream",
            size_bytes=0,
            reason_code=None,
            message=None,
            warnings=[],
        )

    async def process(self, upload):
        await upload.seek(0)
        content = await upload.read()
        await upload.seek(0)
        digest = hashlib.sha256(content).hexdigest()
        return ProcessedFile(
            content=content, original_name=upload.filename or "file", output_name=upload.filename or "file",
            source_mime_type=upload.content_type or "application/octet-stream", output_mime_type=upload.content_type or "application/octet-stream",
            source_size_bytes=len(content), output_size_bytes=len(content), source_sha256=digest, output_sha256=digest,
            sanitized=False,
        )


def make_client(tmp_path) -> TestClient:
    app = create_app(repository=InMemoryRepository(), settings=Settings(database_url=None, s3_endpoint=None))
    app.state.file_service.object_storage.root = tmp_path / "storage" / "uploads"
    guard = AllowingFileGuard()
    app.state.file_guard_client = guard
    app.state.file_service.file_guard = guard
    app.state.excel_service.file_guard = guard
    return TestClient(app)


def auth(client: TestClient, login: str, password: str) -> dict[str, str]:
    response = client.post("/auth/login", json={"login": login, "password": password})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_login_all_roles(tmp_path):
    client = make_client(tmp_path)
    assert client.post("/auth/login", json={"login": "admin", "password": "admin"}).json()["user"]["role"] == "admin"
    assert client.post("/auth/login", json={"login": "economist", "password": "economist"}).json()["user"]["role"] == "economist"
    assert client.post("/auth/login", json={"login": "employee", "password": "employee"}).json()["user"]["role"] == "employee"


def test_nsi_article_creates_default_category_and_request_uses_category(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    economist = auth(client, "economist", "economist")
    employee = auth(client, "employee", "employee")

    article = client.post(
        "/catalog/dds",
        json={"name": "Новая статья", "unit_id": DEPARTMENT_ID},
        headers=admin,
    )
    assert article.status_code == 200
    catalog = client.get("/catalog/dds", params={"unit_id": DEPARTMENT_ID}, headers=employee).json()
    default_category = next(item for item in catalog if item["parent_id"] == article.json()["id"])
    assert default_category["name"] == "Новая статья"

    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    root_line = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": article.json()["id"], "name": "Недопустимо", "sum_plan": 1},
        headers=employee,
    )
    assert root_line.status_code == 400
    category_line = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": default_category["id"], "name": "Допустимо", "sum_plan": 1},
        headers=employee,
    )
    assert category_line.status_code == 200

    renamed = client.patch(
        f"/catalog/dds/{default_category['id']}",
        json={"name": "Переименованная категория"},
        headers=economist,
    )
    assert renamed.status_code == 200
    extra = client.post(
        "/catalog/dds",
        json={"parent_id": article.json()["id"], "name": "Ещё одна категория", "unit_id": DEPARTMENT_ID},
        headers=economist,
    )
    assert extra.status_code == 200


def test_employee_can_attach_and_download_zip_archive(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    item = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Archive", "sum_plan": 100, "justification": ""},
        headers=employee,
    ).json()
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("readme.txt", "Attachment archive")

    uploaded = client.post(
        f"/items/{item['id']}/files",
        files={"file": ("attachments.zip", payload.getvalue(), "application/zip")},
        headers=employee,
    )

    assert uploaded.status_code == 200
    downloaded = client.get(f"/files/{uploaded.json()['id']}/download", headers=employee)
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"] == "application/zip"
    assert downloaded.content == payload.getvalue()


def test_expense_and_income_dashboards_are_separate(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    admin = auth(client, "admin", "admin")
    initial_expense_total = client.get("/dashboard", headers=admin).json()["totals"]["planned"]
    initial_income_total = client.get("/dashboard/income", headers=admin).json()["totals"]["planned"]
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()

    expense = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Expense", "sum_plan": 100, "justification": "Plan"},
        headers=employee,
    )
    income = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "is_income": True, "name": "Income", "sum_plan": 250, "justification": "Plan"},
        headers=employee,
    )
    assert expense.status_code == 200
    assert income.status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200
    for item in (expense.json(), income.json()):
        assert client.post(
            f"/items/{item['id']}/cfo-decision",
            json={"decision": "approved", "comment": ""},
            headers=employee,
        ).status_code == 200
    assert client.post(
        f"/requests/{request['id']}/complete-cfo-review", headers=employee
    ).status_code == 200

    expenses = client.get("/dashboard", headers=admin).json()
    incomes = client.get("/dashboard/income", headers=admin).json()
    assert expenses["totals"]["planned"] == initial_expense_total + 100
    assert incomes["totals"]["planned"] == initial_income_total + 250


def test_dashboard_table_returns_hierarchical_request_rows(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    admin = auth(client, "admin", "admin")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    assert client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "License", "sum_plan": 100, "justification": "Plan"},
        headers=employee,
    ).status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200
    item = client.get(f"/requests/{request['id']}/items", headers=employee).json()[0]
    client.post(
        f"/items/{item['id']}/cfo-decision",
        json={"decision": "approved", "comment": ""},
        headers=employee,
    )
    client.post(f"/requests/{request['id']}/complete-cfo-review", headers=employee)

    rows = client.get("/dashboard/table", headers=admin).json()
    row = next(item for item in rows if item["request_id"] == request["id"])
    assert row["organization"]
    assert row["cfo"]
    assert row["unit"]
    assert row["article"] == "Лицензии и подписки"
    assert row["planned"] == 100


def test_approval_register_groups_visible_lines_and_paginates_module_rows(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    for index in range(26):
        created = client.post(
            f"/requests/{request['id']}/items",
            json={"dds_id": DDS_LICENSE_ID, "name": f"Line {index:02}", "sum_plan": index + 1},
            headers=employee,
        )
        assert created.status_code == 200

    register = client.get("/approval-register", params={"view": "article"}, headers=employee)
    assert register.status_code == 200
    body = register.json()
    assert body["aggregates"]["total_rows"] >= 26
    assert body["aggregates"]["collecting_requests"] >= 1
    assert body["aggregates"]["actionable_positions"] == 0
    article = next(group for group in body["groups"] if group["aggregates"]["total_rows"] >= 26)
    category = next(group for group in article["children"] if group["aggregates"]["total_rows"] >= 26)
    module = next(group for group in category["children"] if group["module_id"] == MODULE_ALPHA_ID)
    assert module["aggregates"]["requested_sum"] == sum(range(1, 27))
    assert module["aggregates"]["aggregate_status"] == "on_review"
    assert module["children"] == []
    assert module["can_load_rows"] is True

    first = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "page": 1, "page_size": 25},
        headers=employee,
    )
    second = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "page": 2, "page_size": 25},
        headers=employee,
    )
    assert first.status_code == second.status_code == 200
    assert first.json()["pagination"]["total_items"] >= 26
    assert first.json()["pagination"]["total_pages"] >= 2
    assert not {item["id"] for item in first.json()["items"]} & {item["id"] for item in second.json()["items"]}
    category_rows = client.get(
        "/approval-register/rows",
        params={
            "module_id": MODULE_ALPHA_ID,
            "article_id": module["article_id"],
            "category_id": module["category_id"],
            "page_size": 25,
        },
        headers=employee,
    )
    assert category_rows.status_code == 200
    assert category_rows.json()["pagination"]["total_items"] == 26
    assert client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "page_size": 30},
        headers=employee,
    ).status_code == 422


def test_approval_register_analytics_fields_and_filters(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    tagged = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Tagged line", "sum_plan": 100, "analytics_1": "Проект А"},
        headers=employee,
    )
    plain = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Plain line", "sum_plan": 50},
        headers=employee,
    )
    assert tagged.status_code == plain.status_code == 200
    assert tagged.json()["analytics_1"] == "Проект А"

    filters = client.get("/approval-register/analytics-filters", headers=employee)
    assert filters.status_code == 200
    assert "Проект А" in filters.json()["analytics_1"]

    filtered = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "analytics_1": "Проект А", "page_size": 25},
        headers=employee,
    )
    assert filtered.status_code == 200
    items = filtered.json()["items"]
    assert len(items) == 1
    assert items[0]["name"] == "Tagged line"
    assert items[0]["analytics_1"] == "Проект А"


def test_approval_register_analytics_fields_and_filters(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    tagged = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Tagged line", "sum_plan": 100, "analytics_1": "Проект А"},
        headers=employee,
    )
    plain = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Plain line", "sum_plan": 50},
        headers=employee,
    )
    assert tagged.status_code == plain.status_code == 200
    assert tagged.json()["analytics_1"] == "Проект А"

    filters = client.get("/approval-register/analytics-filters", headers=employee)
    assert filters.status_code == 200
    assert "Проект А" in filters.json()["analytics_1"]

    filtered = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "analytics_1": "Проект А", "page_size": 25},
        headers=employee,
    )
    assert filtered.status_code == 200
    items = filtered.json()["items"]
    assert len(items) == 1
    assert items[0]["name"] == "Tagged line"
    assert items[0]["analytics_1"] == "Проект А"


def test_analytics_can_be_edited_along_approval_route(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    item = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Route line", "sum_plan": 100},
        headers=employee,
    ).json()
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200

    blocked = client.patch(
        f"/items/{item['id']}",
        json={"name": "Renamed"},
        headers=employee,
    )
    assert blocked.status_code == 409

    updated = client.patch(
        f"/items/{item['id']}",
        json={"analytics_1": "Метка ЦФО", "analytics_2": "Код 42"},
        headers=employee,
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["analytics_1"] == "Метка ЦФО"
    assert body["analytics_2"] == "Код 42"

    rows = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "page_size": 25},
        headers=employee,
    ).json()["items"]
    row = next(entry for entry in rows if entry["id"] == item["id"])
    assert row["status_context"]["editability"]["can_edit_analytics"] is True


def test_group_analytics_applies_to_category_and_article_lines(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    assert client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Line A", "sum_plan": 10},
        headers=employee,
    ).status_code == 200
    assert client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Line B", "sum_plan": 20},
        headers=employee,
    ).status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200

    rows = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "page_size": 25},
        headers=employee,
    ).json()["items"]
    category_id = rows[0]["category_id"]
    article_id = rows[0]["article_id"]

    category_result = client.patch(
        f"/approval-register/groups/category/{category_id}/analytics",
        json={"analytics_1": "Общий проект"},
        headers=employee,
    )
    assert category_result.status_code == 200
    assert category_result.json()["updated_count"] == 2

    rows_after = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "page_size": 25},
        headers=employee,
    ).json()["items"]
    assert all(row["analytics_1"] == "Общий проект" for row in rows_after)

    article_result = client.patch(
        f"/approval-register/groups/article/{article_id}/analytics",
        json={"analytics_2": "Статья X"},
        headers=employee,
    )
    assert article_result.status_code == 200
    assert article_result.json()["updated_count"] == 2

    register = client.get("/approval-register", params={"view": "cfo"}, headers=employee).json()

    def find_group(groups, group_type, group_value):
        for group in groups:
            if group["type"] == group_type and group.get(f"{group_type}_id") == group_value:
                return group
            found = find_group(group.get("children", []), group_type, group_value)
            if found:
                return found
        return None

    category_group = find_group(register["groups"], "category", category_id)
    article_group = find_group(register["groups"], "article", article_id)
    assert category_group["analytics"]["fields"]["analytics_1"]["value"] == "Общий проект"
    assert article_group["analytics"]["fields"]["analytics_2"]["value"] == "Статья X"


def test_approval_register_can_approve_all_available_article_lines(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    for index in range(2):
        assert client.post(
            f"/requests/{request['id']}/items",
            json={"dds_id": DDS_LICENSE_ID, "name": f"Article line {index}", "sum_plan": 100},
            headers=employee,
        ).status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200

    register = client.get("/approval-register", params={"view": "article"}, headers=employee).json()
    article = next(group for group in register["groups"] if group["type"] == "article" and group["aggregates"]["total_rows"] >= 2)
    article_id = article["id"].rsplit("article:", 1)[1]
    result = client.post(
        f"/approval-register/groups/article/{article_id}/cfo-decision",
        json={"decision": "approved", "comment": ""},
        headers=employee,
    )
    assert result.status_code == 200
    rows = client.get(
        "/approval-register/rows",
        params={"module_id": MODULE_ALPHA_ID, "page_size": 25},
        headers=employee,
    ).json()["items"]
    decided = next(item for item in rows if item["status"] == "approved")
    assert decided["status_context"]["editability"]["mode"] == "readonly"
    assert decided["status_context"]["last_decision"]["action"] == "cfo_item_decided"
    assert decided["status_context"]["last_decision"]["by_name"]
    assert decided["is_cfo_review_actionable"] is False
    assert len(result.json()) >= 2
    assert all(item["status"] == "approved" for item in result.json())
    assert article["aggregates"]["cfo_review_actionable_requests"] >= 1


def test_dashboard_article_cfo_returns_selected_article_breakdown(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    admin = auth(client, "admin", "admin")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    assert client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "License", "sum_plan": 100, "justification": "Plan"},
        headers=employee,
    ).status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200
    item = client.get(f"/requests/{request['id']}/items", headers=employee).json()[0]
    client.post(
        f"/items/{item['id']}/cfo-decision",
        json={"decision": "approved", "comment": ""},
        headers=employee,
    )
    client.post(f"/requests/{request['id']}/complete-cfo-review", headers=employee)

    rows = client.get("/dashboard/article-cfo", params={"article_key": f"dds:{DDS_LICENSE_ID}"}, headers=admin).json()
    assert rows
    assert rows[0]["name"] == "ЦФО цифровых продуктов"
    assert rows[0]["planned"] >= 100


def test_dashboard_articles_cfo_returns_all_articles(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    admin = auth(client, "admin", "admin")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    assert client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "License", "sum_plan": 100, "justification": "Plan"},
        headers=employee,
    ).status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200
    item = client.get(f"/requests/{request['id']}/items", headers=employee).json()[0]
    client.post(
        f"/items/{item['id']}/cfo-decision",
        json={"decision": "approved", "comment": ""},
        headers=employee,
    )
    client.post(f"/requests/{request['id']}/complete-cfo-review", headers=employee)

    articles = client.get("/dashboard/articles-cfo", headers=admin).json()
    article = next(item for item in articles if item["id"] == f"dds:{DDS_LICENSE_ID}")
    assert article["planned"] >= 100
    assert article["cfo"][0]["name"] == "ЦФО цифровых продуктов"


def test_draft_request_shows_cfo_responsible_contact(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    client.app.state.repo.create(
        "requests",
        {
            "id": "draft-with-module-economist",
            "economist_id": None,
            "unit_id": MODULE_ALPHA_ID,
            "status": "draft",
            "frozen": False,
        },
    )

    response = client.get("/requests/draft-with-module-economist/counterparty-contact", headers=employee)

    assert response.status_code == 200
    assert response.json()["role"] == "employee"
    assert response.json()["login"] == "employee"


def test_request_history_hides_corrupted_import_suffix(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    item = client.post(
        f"/requests/{request['id']}/items",
        json={
            "dds_id": DDS_LICENSE_ID,
            "name": "Юридические услуги (списание) — M-1, ????? 1",
            "sum_plan": 100,
            "justification": "Проверка",
        },
        headers=employee,
    )
    assert item.status_code == 200

    logs = client.get(f"/requests/{request['id']}/logs", headers=employee)
    assert logs.status_code == 200
    line_log = next(entry for entry in logs.json() if entry["subject"])
    assert line_log["subject"]["name"] == "Юридические услуги (списание)"
    items = client.get(f"/requests/{request['id']}/items", headers=employee)
    assert items.status_code == 200
    assert items.json()[0]["name"] == "Юридические услуги (списание)"
