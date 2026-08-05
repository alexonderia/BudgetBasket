from app.seed import DDS_LICENSE_ID, MODULE_ALPHA_ID
from app.security import hash_password
from tests.test_api import auth, make_client


def submitted_request(client, employee):
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()
    line = client.post(
        f"/requests/{request['id']}/items",
        json={"dds_id": DDS_LICENSE_ID, "name": "Лицензия", "sum_plan": 1, "justification": ""},
        headers=employee,
    )
    assert line.status_code == 200
    assert client.post(f"/requests/{request['id']}/submit", headers=employee).status_code == 200
    return request


def test_draft_request_has_no_chat(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = client.post("/requests", json={"unit_id": MODULE_ALPHA_ID}, headers=employee).json()

    response = client.get(f"/requests/{request['id']}/chat", headers=employee)
    assert response.status_code == 400
    assert client.post(f"/requests/{request['id']}/chat/messages", json={"text": "Черновик"}, headers=employee).status_code == 400


def test_chat_websocket_notifies_request_participants(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    request = submitted_request(client, employee)
    economist_token = economist["Authorization"].removeprefix("Bearer ")

    with client.websocket_connect(f"/ws/requests/{request['id']}/chat?token={economist_token}") as websocket:
        response = client.post(
            f"/requests/{request['id']}/chat/messages",
            json={"text": "Нужно согласование"},
            headers=employee,
        )
        assert response.status_code == 200
        assert websocket.receive_json() == {
            "type": "chat.message.created",
            "message_id": response.json()["id"],
        }


def test_chat_excludes_another_employee_of_the_same_module(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    repo = client.app.state.repo
    employee_role_id = next(role["id"] for role in repo.load_all("roles") if role["name"] == "employee")
    colleague_id = "90000000-0000-0000-0000-000000000001"
    repo.insert(
        "users",
        {"id": colleague_id, "login": "colleague", "password": hash_password("colleague"), "id_role": employee_role_id},
    )
    repo.insert("units_responsibles", {"unit_id": MODULE_ALPHA_ID, "user_id": colleague_id, "is_active": True})
    colleague = auth(client, "colleague", "colleague")
    request = submitted_request(client, employee)

    assert client.get(f"/requests/{request['id']}/chat", headers=employee).status_code == 200
    assert client.get(f"/requests/{request['id']}/chat", headers=economist).status_code == 200
    assert client.get(f"/requests/{request['id']}/chat", headers=colleague).status_code == 403
    assert client.get("/chats", headers=colleague).json() == []


def test_chat_image_is_visible_to_chat_participants_and_downloadable(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    request = submitted_request(client, employee)

    response = client.post(
        f"/requests/{request['id']}/chat/messages/images",
        data={"text": "Схема"},
        files=[("images", ("diagram.png", b"not-a-real-png", "image/png"))],
        headers=employee,
    )

    assert response.status_code == 200
    message = response.json()
    assert message["text"] == "Схема"
    assert len(message["files"]) == 1
    chat = client.get(f"/requests/{request['id']}/chat", headers=economist)
    attached = chat.json()["messages"][-1]["files"]
    assert attached == message["files"]
    download = client.get(f"/files/{attached[0]['id']}/download", headers=economist)
    assert download.status_code == 200
    assert download.headers["content-type"] == "image/png"
    assert download.content == b"not-a-real-png"


def test_chat_rejects_non_image_attachment(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    request = submitted_request(client, employee)

    response = client.post(
        f"/requests/{request['id']}/chat/messages/images",
        files=[("images", ("document.pdf", b"pdf", "application/pdf"))],
        headers=employee,
    )

    assert response.status_code == 400
    assert client.get(f"/requests/{request['id']}/chat", headers=employee).json()["messages"] == []


def test_chat_notification_and_list_include_unread_message(tmp_path):
    client = make_client(tmp_path)
    employee = auth(client, "employee", "employee")
    economist = auth(client, "economist", "economist")
    request = submitted_request(client, employee)
    economist_token = economist["Authorization"].removeprefix("Bearer ")

    with client.websocket_connect(f"/ws/chat-notifications?token={economist_token}") as websocket:
        response = client.post(
            f"/requests/{request['id']}/chat/messages",
            json={"text": "Проверьте, пожалуйста, сумму"},
            headers=employee,
        )
        assert response.status_code == 200
        assert websocket.receive_json() == {
            "type": "chat.message.created",
            "request_id": request["id"],
            "message_id": response.json()["id"],
            "text": "Проверьте, пожалуйста, сумму",
        }

    chats = client.get("/chats", headers=economist)
    assert chats.status_code == 200
    assert chats.json()[0]["request_id"] == request["id"]
    assert chats.json()[0]["unread_count"] == 1
    assert chats.json()[0]["last_message"]["text"] == "Проверьте, пожалуйста, сумму"
