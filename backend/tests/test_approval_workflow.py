from app.seed import APPROVER_STEP_ID, DDS_LICENSE_ID, LEAF_STEP_ID, MODULE_ALPHA_ID, ROOT_STEP_ID
from tests.test_api import auth, make_client


def create_submitted_request(client, employee):
    created = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee)
    assert created.status_code == 200
    request_id = created.json()["id"]
    item = client.post(
        f"/requests/{request_id}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Лицензия", "sum_plan": 100, "justification": "Для работы"},
        headers=employee,
    )
    assert item.status_code == 200
    assert client.post(f"/requests/{request_id}/submit", headers=employee).status_code == 200
    return request_id, item.json()["id"]


def finalize_by_economist(client, request_id, item_id, economist):
    assert client.patch(f"/items/{item_id}", json={"status": "approved"}, headers=economist).status_code == 200
    finalized = client.post(f"/requests/{request_id}/finalize", headers=economist)
    assert finalized.status_code == 200
    assert finalized.json()["frozen"] is True
    return finalized.json()


def test_submission_creates_independent_step_states_and_economist_task(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    request_id, _ = create_submitted_request(client, employee)

    route = client.get(f"/requests/{request_id}/approval-route", headers=employee).json()
    assert [(item["step"]["id"], item["step"]["request_status"]) for item in route] == [
        (LEAF_STEP_ID, "on_approval"),
        (APPROVER_STEP_ID, "waiting"),
        (ROOT_STEP_ID, "waiting"),
    ]
    tasks = client.get("/steps/my", headers=economist).json()
    assert [(step["id"], step["active_requests_count"]) for step in tasks] == [(LEAF_STEP_ID, 1)]


def test_economist_freezes_and_sends_request_to_next_step(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    request_id, item_id = create_submitted_request(client, employee)

    finalized = finalize_by_economist(client, request_id, item_id, economist)
    assert finalized["status"] == "approved"
    assert finalized["fixed"] is False
    assert client.get(f"/requests/{request_id}/approval-step", headers=approver).json()["can_approve"] is True
    route = client.get(f"/requests/{request_id}/approval-route", headers=employee).json()
    assert [item["step"]["request_status"] for item in route] == ["approved", "on_approval", "waiting"]


def test_return_reaches_economist_then_employee_for_revision(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    request_id, item_id = create_submitted_request(client, employee)
    finalize_by_economist(client, request_id, item_id, economist)

    returned = client.post(
        f"/steps/{APPROVER_STEP_ID}/return",
        json={"targets": [{"child_step_id": LEAF_STEP_ID, "request_ids": [request_id]}], "comment": "Уточнить обоснование"},
        headers=approver,
    )
    assert returned.status_code == 200
    request = client.get(f"/requests/{request_id}", headers=employee).json()
    assert request["frozen"] is True
    assert client.get(f"/requests/{request_id}/approval-step", headers=economist).json()["request_status"] == "on_revision"

    assert client.post(
        f"/steps/{LEAF_STEP_ID}/return",
        json={"request_ids": [request_id], "comment": "Вернуть сотруднику"},
        headers=economist,
    ).status_code == 200
    request = client.get(f"/requests/{request_id}", headers=employee).json()
    assert request["status"] == "draft"
    assert request["frozen"] is False
    assert client.post(f"/requests/{request_id}/cancel", headers=employee).status_code == 200


def test_zgd_is_the_only_actor_that_sets_fixed_and_closes_final_step(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    zgd = auth(client, "zgd", "zgd")
    request_id, item_id = create_submitted_request(client, employee)
    finalize_by_economist(client, request_id, item_id, economist)

    assert client.post(f"/steps/{APPROVER_STEP_ID}/requests/{request_id}/approve", headers=approver).status_code == 200
    assert client.post(f"/steps/{APPROVER_STEP_ID}/approve", headers=approver).status_code == 200
    fixed = client.post(f"/steps/{ROOT_STEP_ID}/requests/{request_id}/approve", headers=zgd)
    assert fixed.status_code == 200
    request = client.get(f"/requests/{request_id}", headers=employee).json()
    assert request["fixed"] is True
    route = client.get(f"/requests/{request_id}/approval-route", headers=employee).json()
    assert [item["step"]["request_status"] for item in route] == ["closed", "closed", "closed"]
    assert client.post(f"/steps/{ROOT_STEP_ID}/requests/{request_id}/approve", headers=zgd).status_code == 409


def test_reviewer_forwards_only_a_full_reviewed_package(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")

    first_request_id, first_item_id = create_submitted_request(client, employee)
    second_request_id, second_item_id = create_submitted_request(client, employee)
    finalize_by_economist(client, first_request_id, first_item_id, economist)

    assert client.post(
        f"/steps/{APPROVER_STEP_ID}/requests/{first_request_id}/approve",
        headers=approver,
    ).status_code == 200
    blocked = client.post(f"/steps/{APPROVER_STEP_ID}/approve", headers=approver)
    assert blocked.status_code == 409
    assert "не все заявки" in blocked.json()["detail"]

    finalize_by_economist(client, second_request_id, second_item_id, economist)
    assert client.post(
        f"/steps/{APPROVER_STEP_ID}/requests/{second_request_id}/approve",
        headers=approver,
    ).status_code == 200
    forwarded = client.post(f"/steps/{APPROVER_STEP_ID}/approve", headers=approver)
    assert forwarded.status_code == 200

    for request_id in (first_request_id, second_request_id):
        route = client.get(f"/requests/{request_id}/approval-route", headers=employee).json()
        assert [item["step"]["request_status"] for item in route] == ["approved", "approved", "on_approval"]


def test_cancel_is_available_only_for_a_draft(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request_id, _ = create_submitted_request(client, employee)
    assert client.post(f"/requests/{request_id}/cancel", headers=employee).status_code == 400
    draft = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    assert client.post(f"/requests/{draft['id']}/cancel", headers=employee).status_code == 200
