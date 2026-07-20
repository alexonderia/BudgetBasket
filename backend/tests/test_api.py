from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.config import Settings
from app.factory import create_app
from app.seed import DDS_LICENSE_ID, MODULE_ALPHA_ID
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

    expenses = client.get("/dashboard", headers=admin).json()
    incomes = client.get("/dashboard/income", headers=admin).json()
    assert expenses["totals"]["planned"] == initial_expense_total + 100
    assert incomes["totals"]["planned"] == initial_income_total + 250
