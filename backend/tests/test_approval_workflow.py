from app.seed import (
    APPROVER_ID,
    APPROVER_STEP_ID,
    DDS_LICENSE_ID,
    LEAF_STEP_ID,
    MODULE_ALPHA_ID,
    REQUEST_ID,
    ROOT_STEP_ID,
)
from tests.test_api import auth, make_client


ITEM_ID = "80000000-0000-0000-0000-000000000001"


def prepare_economist_approval(client, economist):
    reviewed = client.patch(
        f"/items/{ITEM_ID}",
        json={"status": "approved"},
        headers=economist,
    )
    assert reviewed.status_code == 200
    finalized = client.post(
        f"/requests/{REQUEST_ID}/finalize",
        headers=economist,
    )
    assert finalized.status_code == 200
    assert finalized.json()["frozen"] is True
    assert finalized.json()["fixed"] is False


def test_roles_graph_guards_and_chat_scope(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    employee = auth(client, "employee", "employee")
    approver = auth(client, "approver", "approver")
    zgd = auth(client, "zgd", "zgd")

    assert client.post("/steps/validate", headers=admin).json()["valid"] is True
    assert client.get("/steps/my", headers=employee).status_code == 403
    assert client.post(f"/steps/{LEAF_STEP_ID}/approve", headers=admin).status_code == 403
    assert client.get(f"/requests/{REQUEST_ID}/chat", headers=approver).status_code == 403
    assert client.get(f"/requests/{REQUEST_ID}/chat", headers=zgd).status_code == 403

    self_link = client.post(
        "/step-edges",
        json={"parent_step_id": ROOT_STEP_ID, "child_step_id": ROOT_STEP_ID},
        headers=admin,
    )
    assert self_link.status_code == 400
    cycle = client.post(
        "/step-edges",
        json={"parent_step_id": APPROVER_STEP_ID, "child_step_id": ROOT_STEP_ID},
        headers=admin,
    )
    assert cycle.status_code == 400


def test_first_module_step_is_created_when_employee_submits_request(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    employee = auth(client, "employee", "employee")

    assert client.delete(f"/steps/{LEAF_STEP_ID}", headers=admin).status_code == 200
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    assert client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Новая строка", "sum_plan": 100, "justification": "Проверка"},
        headers=employee,
    ).status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200

    steps = client.get("/steps", headers=admin).json()
    leaf = next(step for step in steps if step["unit_id"] == MODULE_ALPHA_ID)
    assert leaf["user"]["role"] == "economist"
    assert leaf["status"] == "on_approval"
    logs = client.get(f"/steps/{leaf['id']}/logs", headers=admin).json()
    assert any(item["log"]["action"] == "step_created" and item["log"].get("created_automatically") for item in logs)


def test_admin_can_backfill_first_steps_for_reviewed_requests(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    economist = auth(client, "economist", "economist")
    prepare_economist_approval(client, economist)

    assert client.delete(f"/steps/{LEAF_STEP_ID}", headers=admin).status_code == 200
    result = client.post("/steps/bootstrap-reviewed", headers=admin)
    assert result.status_code == 200
    assert len(result.json()["created"]) == 1

    leaf = next(step for step in client.get("/steps", headers=admin).json() if step["unit_id"] == MODULE_ALPHA_ID)
    assert leaf["status"] == "on_approval"
    request = client.get(f"/requests/{REQUEST_ID}", headers=auth(client, "employee", "employee")).json()
    assert request["frozen"] is True
    assert client.post("/steps/bootstrap-reviewed", headers=admin).json()["created"] == []


def test_dag_scope_deduplicates_requests(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    prepare_economist_approval(client, economist)

    extra_step = client.post(
        "/steps",
        json={"user_id": APPROVER_ID},
        headers=admin,
    )
    assert extra_step.status_code == 200
    extra_step_id = extra_step.json()["id"]
    assert client.post(
        "/step-edges",
        json={"parent_step_id": extra_step_id, "child_step_id": LEAF_STEP_ID},
        headers=admin,
    ).status_code == 200
    assert client.post(
        "/step-edges",
        json={"parent_step_id": ROOT_STEP_ID, "child_step_id": extra_step_id},
        headers=admin,
    ).status_code == 200

    assert client.post(f"/steps/{LEAF_STEP_ID}/approve", headers=economist).status_code == 200
    requests = client.get(f"/steps/{extra_step_id}/requests", headers=approver)
    assert requests.status_code == 200
    assert [item["id"] for item in requests.json()] == [REQUEST_ID]
    assert client.post("/steps/validate", headers=admin).json()["valid"] is True


def test_stepwise_return_keeps_request_frozen_until_economist_returns_it(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    prepare_economist_approval(client, economist)

    # The approver can see requests in the route before they are delivered to
    # their own step, but cannot act until that step is opened.
    assert client.get(f"/requests/{REQUEST_ID}", headers=approver).status_code == 200
    visible_before_delivery = client.get(f"/steps/{APPROVER_STEP_ID}/requests", headers=approver)
    assert [item["id"] for item in visible_before_delivery.json()] == [REQUEST_ID]
    assert client.post(f"/steps/{LEAF_STEP_ID}/approve", headers=economist).status_code == 200

    route = client.get(f"/requests/{REQUEST_ID}/approval-route", headers=approver)
    assert route.status_code == 200
    assert [item["step"]["id"] for item in route.json()] == [
        LEAF_STEP_ID,
        APPROVER_STEP_ID,
        ROOT_STEP_ID,
    ]
    assert any(item["log"]["action"] == "step_approved" for item in route.json()[0]["logs"])
    assert any(item["log"]["action"] == "step_opened" for item in route.json()[1]["logs"])

    # A request becomes actionable for the approver as soon as the child sends
    # it up.  The step package cannot move further until the request itself is
    # reviewed.
    action = client.get(f"/requests/{REQUEST_ID}/approval-step", headers=approver)
    assert action.status_code == 200
    assert action.json()["can_approve"] is True
    assert action.json()["can_forward"] is False
    assert client.post(
        f"/steps/{APPROVER_STEP_ID}/requests/{REQUEST_ID}/approve",
        headers=approver,
    ).status_code == 200
    assert client.get(f"/requests/{REQUEST_ID}/approval-step", headers=approver).json()["can_forward"] is True

    returned = client.post(
        f"/steps/{APPROVER_STEP_ID}/return",
        json={
            "targets": [
                {
                    "child_step_id": LEAF_STEP_ID,
                    "request_ids": [REQUEST_ID],
                }
            ],
            "comment": "Исправить обоснование заявки",
        },
        headers=approver,
    )
    assert returned.status_code == 200
    assert returned.json()["status"] == "on_revision"
    request = client.get(f"/requests/{REQUEST_ID}", headers=employee).json()
    assert request["frozen"] is True
    assert client.patch(
        f"/items/{ITEM_ID}",
        json={"justification": "Изменение до разморозки"},
        headers=employee,
    ).status_code == 400

    step_logs = client.get(f"/steps/{APPROVER_STEP_ID}/logs", headers=approver).json()
    return_event = next(
        item["log"]["event_id"]
        for item in step_logs
        if item["log"]["action"] == "step_returned"
    )
    request_logs = client.get(f"/requests/{REQUEST_ID}/logs", headers=employee).json()
    request_event = next(
        item["log"]["event_id"]
        for item in request_logs
        if item["log"]["action"] == "approval_request_returned"
    )
    assert request_event == return_event

    leaf_return = client.post(
        f"/steps/{LEAF_STEP_ID}/return",
        json={
            "request_ids": [REQUEST_ID],
            "comment": "Размораживаю и возвращаю сотруднику",
        },
        headers=economist,
    )
    assert leaf_return.status_code == 200
    request = client.get(f"/requests/{REQUEST_ID}", headers=employee).json()
    assert request["status"] == "draft"
    assert request["frozen"] is False
    assert client.patch(
        f"/items/{ITEM_ID}",
        json={"justification": "Исправленное обоснование"},
        headers=employee,
    ).status_code == 200


def test_approver_can_review_first_received_request_but_waits_to_forward_package(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    prepare_economist_approval(client, economist)

    second_request = client.post(
        "/requests",
        json={"unit_id": MODULE_ALPHA_ID},
        headers=employee,
    )
    assert second_request.status_code == 200
    second_request_id = second_request.json()["id"]
    second_item = client.post(
        f"/requests/{second_request_id}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Вторая заявка", "sum_plan": 250, "justification": "Проверка пакета"},
        headers=employee,
    )
    assert second_item.status_code == 200
    assert client.post(f"/requests/{second_request_id}/submit", headers=employee).status_code == 200
    assert client.patch(
        f"/items/{second_item.json()['id']}",
        json={"status": "approved"},
        headers=economist,
    ).status_code == 200
    assert client.post(f"/requests/{second_request_id}/finalize", headers=economist).status_code == 200

    assert client.post(f"/steps/{LEAF_STEP_ID}/approve", headers=economist).status_code == 200
    assert client.post(
        f"/steps/{APPROVER_STEP_ID}/requests/{REQUEST_ID}/approve",
        headers=approver,
    ).status_code == 200

    first_action = client.get(f"/requests/{REQUEST_ID}/approval-step", headers=approver).json()
    assert first_action["can_forward"] is False
    assert client.post(
        f"/steps/{APPROVER_STEP_ID}/requests/{second_request_id}/approve",
        headers=approver,
    ).status_code == 200
    assert client.get(f"/requests/{REQUEST_ID}/approval-step", headers=approver).json()["can_forward"] is True


def test_zgd_closes_graph_and_irreversibly_fixes_requests(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    zgd = auth(client, "zgd", "zgd")
    prepare_economist_approval(client, economist)

    unrelated = client.post("/steps", json={"user_id": APPROVER_ID}, headers=admin)
    assert unrelated.status_code == 200
    unrelated_step_id = unrelated.json()["id"]

    assert client.post(f"/steps/{LEAF_STEP_ID}/approve", headers=economist).status_code == 200
    assert client.post(
        f"/steps/{APPROVER_STEP_ID}/requests/{REQUEST_ID}/approve",
        headers=approver,
    ).status_code == 200
    assert client.post(f"/steps/{APPROVER_STEP_ID}/approve", headers=approver).status_code == 200
    fixed = client.post(
        f"/steps/{ROOT_STEP_ID}/requests/{REQUEST_ID}/approve",
        headers=zgd,
    )
    assert fixed.status_code == 200

    request = client.get(f"/requests/{REQUEST_ID}", headers=employee).json()
    assert request["frozen"] is True
    assert request["fixed"] is True
    assert client.post(f"/requests/{REQUEST_ID}/reopen", headers=economist).status_code == 400
    assert client.patch(
        f"/items/{ITEM_ID}",
        json={"comment": "Попытка изменения после фиксации"},
        headers=economist,
    ).status_code == 400
    route = client.get(f"/requests/{REQUEST_ID}/approval-route", headers=employee).json()
    assert all(item["step"]["request_status"] == "closed" for item in route)
    assert client.post(
        f"/steps/{ROOT_STEP_ID}/requests/{REQUEST_ID}/approve",
        headers=zgd,
    ).status_code == 409

    statuses = {
        item["id"]: item["status"]
        for item in client.get("/steps", headers=auth(client, "admin", "admin")).json()
    }
    assert statuses == {
        LEAF_STEP_ID: "approved",
        APPROVER_STEP_ID: "approved",
        ROOT_STEP_ID: "on_approval",
        unrelated_step_id: "waiting",
    }


def test_non_zgd_step_without_parent_cannot_close_the_route(tmp_path):
    client = make_client(tmp_path)
    admin = auth(client, "admin", "admin")
    economist = auth(client, "economist", "economist")
    approver = auth(client, "approver", "approver")
    employee = auth(client, "employee", "employee")
    prepare_economist_approval(client, economist)

    assert client.request(
        "DELETE",
        "/step-edges",
        json={"parent_step_id": ROOT_STEP_ID, "child_step_id": APPROVER_STEP_ID},
        headers=admin,
    ).status_code == 200
    assert client.post(
        "/step-edges",
        json={"parent_step_id": APPROVER_STEP_ID, "child_step_id": ROOT_STEP_ID},
        headers=admin,
    ).status_code == 400

    assert client.post(f"/steps/{LEAF_STEP_ID}/approve", headers=economist).status_code == 200
    assert client.post(
        f"/steps/{APPROVER_STEP_ID}/requests/{REQUEST_ID}/approve",
        headers=approver,
    ).status_code == 200
    assert client.post(f"/steps/{APPROVER_STEP_ID}/approve", headers=approver).status_code == 200

    request = client.get(f"/requests/{REQUEST_ID}", headers=employee).json()
    assert request["fixed"] is False
    statuses = {
        item["id"]: item["status"]
        for item in client.get("/steps", headers=admin).json()
    }
    assert statuses[LEAF_STEP_ID] == "approved"
    assert statuses[APPROVER_STEP_ID] == "approved"
    assert statuses[ROOT_STEP_ID] == "waiting"
