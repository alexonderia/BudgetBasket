from __future__ import annotations

from fastapi import HTTPException

from app.models import RequestStatus
from app.repositories.base import Repository
from app.services.common import get_required
from app.services.permission_service import PermissionService


class ChatService:
    """Conversations scoped to an organisational unit and a budget year."""

    def __init__(self, repo: Repository, permissions: PermissionService, requests=None):
        self.repo = repo
        self.permissions = permissions
        # Retained as an optional dependency for factory compatibility. Chat
        # messages are intentionally no longer added to request audit logs.
        self.requests = requests

    def _unit_type(self, unit_id: str, *, repo: Repository) -> str:
        get_required(repo, "units", unit_id)
        level = self.permissions.unit_level(unit_id)
        return "department" if level == 1 else "cfo" if level == 2 else "module" if level == 3 else "unknown"

    def _validate_context(self, kind: str, unit_id: str, budget_year: int, *, repo: Repository) -> None:
        if kind not in {"module_cfo", "cfo_economist"}:
            raise HTTPException(status_code=400, detail="Неизвестный вид чата")
        if not 2000 <= int(budget_year) <= 2200:
            raise HTTPException(status_code=400, detail="Некорректный бюджетный год")
        expected_type = "module" if kind == "module_cfo" else "cfo"
        if self._unit_type(unit_id, repo=repo) != expected_type:
            raise HTTPException(
                status_code=409,
                detail=f"Чат {kind} можно создать только для юнита типа {expected_type}",
            )

    def _single_assignee(self, unit_id: str, role: str, label: str, *, repo: Repository) -> str | None:
        users = {row["id"]: row for row in repo.load_all("users")}
        matches = [
            row["user_id"]
            for row in repo.load_all("units_responsibles")
            if row.get("unit_id") == unit_id
            and row.get("is_active")
            and users.get(row.get("user_id"), {}).get("role") == role
        ]
        if len(matches) > 1:
            raise HTTPException(status_code=409, detail=f"Для {label} назначено несколько активных пользователей")
        return matches[0] if matches else None

    def _participant_ids(self, chat: dict, *, repo: Repository) -> set[str]:
        if chat["kind"] == "module_cfo":
            cfo_id = self.permissions.cfo_for_module(chat["unit_id"])
            if not cfo_id:
                raise HTTPException(status_code=409, detail="Для модуля не определен родительский ЦФО")
            return {
                user_id
                for user_id in (
                    self._single_assignee(chat["unit_id"], "employee", "модуля", repo=repo),
                    self._single_assignee(cfo_id, "employee", "ЦФО", repo=repo),
                )
                if user_id
            }
        return {
            user_id
            for user_id in (
                self._single_assignee(chat["unit_id"], "employee", "ЦФО", repo=repo),
                self._single_assignee(chat["unit_id"], "economist", "ЦФО", repo=repo),
            )
            if user_id
        }

    def _sync_participants(self, chat: dict, *, repo: Repository) -> None:
        expected = self._participant_ids(chat, repo=repo)
        actual = {
            row["user_id"]
            for row in repo.load_all("chats_participants")
            if row.get("chat_id") == chat["id"]
        }
        for user_id in actual - expected:
            repo.delete_where("chats_participants", {"chat_id": chat["id"], "user_id": user_id})
        for user_id in expected - actual:
            repo.insert("chats_participants", {"chat_id": chat["id"], "user_id": user_id})

    def _get_or_create(self, kind: str, unit_id: str, budget_year: int, *, repo: Repository) -> dict:
        self._validate_context(kind, unit_id, budget_year, repo=repo)
        chat = next(
            (
                row for row in repo.load_all("chats")
                if row.get("kind") == kind
                and row.get("unit_id") == unit_id
                and int(row.get("budget_year")) == int(budget_year)
            ),
            None,
        )
        if not chat:
            try:
                chat = repo.create("chats", {"kind": kind, "unit_id": unit_id, "budget_year": int(budget_year)})
            except HTTPException as exc:
                # A concurrent transaction may have inserted the unique chat.
                if exc.status_code != 400:
                    raise
                chat = next(
                    (
                        row for row in repo.load_all("chats")
                        if row.get("kind") == kind and row.get("unit_id") == unit_id
                        and int(row.get("budget_year")) == int(budget_year)
                    ),
                    None,
                )
                if not chat:
                    raise
        self._sync_participants(chat, repo=repo)
        return chat

    def _require_access(self, user: dict, chat: dict, *, write: bool = False, repo: Repository | None = None) -> None:
        storage = repo or self.repo
        if user.get("role") == "admin":
            if write:
                raise HTTPException(status_code=403, detail="Администратор может только просматривать чаты")
            return
        if not any(
            row.get("chat_id") == chat["id"] and row.get("user_id") == user.get("id")
            for row in storage.load_all("chats_participants")
        ):
            raise HTTPException(status_code=403, detail="Нет доступа к этому чату")

    def can_access(self, user: dict, chat_id: str) -> bool:
        try:
            chat = get_required(self.repo, "chats", chat_id)
            self._sync_participants(chat, repo=self.repo)
            self._require_access(user, chat)
        except HTTPException:
            return False
        return True

    def _message_payload(self, chat: dict, *, repo: Repository) -> dict:
        users = {row["id"]: row for row in repo.load_all("users")}
        profiles = {row["user_id"]: row for row in repo.load_all("profiles")}
        files = {row["id"]: row for row in repo.load_all("files")}
        files_by_message: dict[str, list[dict]] = {}
        for link in repo.load_all("message_files"):
            file = files.get(link.get("file_id"))
            if file:
                files_by_message.setdefault(link["message_id"], []).append(file)
        messages = []
        for message in repo.load_all("chat_messages"):
            if message.get("chat_id") != chat["id"]:
                continue
            sender_id = message.get("sender_id")
            sender = users.get(sender_id, {})
            messages.append({
                **message,
                "files": files_by_message.get(message["id"], []),
                "sender": ({"id": sender.get("id"), "login": sender.get("login"), "role": sender.get("role"), "profile": profiles.get(sender_id)} if sender_id else None),
            })
        messages.sort(key=lambda row: str(row.get("created_at") or ""))
        participants = [row for row in repo.load_all("chats_participants") if row.get("chat_id") == chat["id"]]
        return {"participants": participants, "messages": messages}

    def _public_chat(self, chat: dict, *, repo: Repository, user: dict | None = None, include_messages: bool = True) -> dict:
        units = {row["id"]: row for row in repo.load_all("units")}
        unit = units[chat["unit_id"]]
        unit_type = self._unit_type(unit["id"], repo=repo)
        cfo_id = self.permissions.cfo_for_module(unit["id"]) if chat["kind"] == "module_cfo" else unit["id"]
        related = units.get(cfo_id) if cfo_id else None
        payload = {
            "id": chat["id"], "kind": chat["kind"], "unit_id": chat["unit_id"], "budget_year": int(chat["budget_year"]),
            "unit": {"id": unit["id"], "name": unit["name"], "type": unit_type},
            "related_cfo": ({"id": related["id"], "name": related["name"]} if related else None),
        }
        details = self._message_payload(chat, repo=repo)
        messages = details["messages"]
        participant = next((row for row in details["participants"] if user and row.get("user_id") == user.get("id")), None)
        last_read_id = participant.get("last_read_message_id") if participant else None
        last_read_index = next((i for i, row in enumerate(messages) if row["id"] == last_read_id), -1)
        payload.update({
            "participants": details["participants"],
            "unread_count": 0 if not user or user.get("role") == "admin" else sum(1 for row in messages[last_read_index + 1:] if row.get("sender_id") != user.get("id")),
            "last_message": messages[-1] if messages else None,
        })
        if include_messages:
            payload["messages"] = messages
        return payload

    def get_chat(self, user: dict, chat_id: str) -> dict:
        chat = get_required(self.repo, "chats", chat_id)
        self._sync_participants(chat, repo=self.repo)
        self._require_access(user, chat)
        return self._public_chat(chat, repo=self.repo, user=user)

    def get_request_chat(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        if request.get("status") == RequestStatus.draft:
            raise HTTPException(status_code=400, detail="Чат становится доступен после отправки заявки на рассмотрение")
        chat = self._get_or_create("module_cfo", request["unit_id"], request["budget_year"], repo=self.repo)
        self._require_access(user, chat)
        return self._public_chat(chat, repo=self.repo, user=user)

    def get_position_chat(self, user: dict, position_id: str) -> dict:
        position = get_required(self.repo, "cfo_positions", position_id)
        self.permissions.require_view_position(user, position)
        chat = self._get_or_create("cfo_economist", position["cfo_unit_id"], position["budget_year"], repo=self.repo)
        self._require_access(user, chat)
        return self._public_chat(chat, repo=self.repo, user=user)

    def list_chats(self, user: dict) -> list[dict]:
        chats = self.repo.load_all("chats")
        for chat in chats:
            self._sync_participants(chat, repo=self.repo)
        result = []
        for chat in chats:
            if user.get("role") != "admin" and not any(
                row.get("chat_id") == chat["id"] and row.get("user_id") == user.get("id")
                for row in self.repo.load_all("chats_participants")
            ):
                continue
            result.append(self._public_chat(chat, repo=self.repo, user=user, include_messages=False))
        return sorted(result, key=lambda row: str((row["last_message"] or {}).get("created_at") or ""), reverse=True)

    def send(self, user: dict, chat_id: str, payload: dict, *, allow_empty: bool = False) -> dict:
        chat = get_required(self.repo, "chats", chat_id)
        self._sync_participants(chat, repo=self.repo)
        self._require_access(user, chat, write=True)
        text = payload.get("text", "").strip()
        if not text and not allow_empty:
            raise HTTPException(status_code=400, detail="Сообщение не может быть пустым")
        reply_to = payload.get("reply_to")
        if reply_to and get_required(self.repo, "chat_messages", reply_to).get("chat_id") != chat["id"]:
            raise HTTPException(status_code=400, detail="Сообщение для ответа относится к другому чату")
        message = self.repo.create("chat_messages", {"chat_id": chat["id"], "reply_to": reply_to, "sender_id": user["id"], "text": text})
        self.repo.update_where("chats_participants", {"chat_id": chat["id"], "user_id": user["id"]}, {"last_read_message_id": message["id"]})
        return message

    def mark_read(self, user: dict, chat_id: str, message_id: str | None) -> dict:
        chat = get_required(self.repo, "chats", chat_id)
        self._sync_participants(chat, repo=self.repo)
        self._require_access(user, chat)
        if message_id and get_required(self.repo, "chat_messages", message_id).get("chat_id") != chat["id"]:
            raise HTTPException(status_code=400, detail="Сообщение относится к другому чату")
        if user.get("role") != "admin":
            self.repo.update_where("chats_participants", {"chat_id": chat["id"], "user_id": user["id"]}, {"last_read_message_id": message_id})
        return {"ok": True}

    def notification_recipient_ids(self, chat_id: str, sender_id: str) -> set[str]:
        chat = get_required(self.repo, "chats", chat_id)
        self._sync_participants(chat, repo=self.repo)
        return {row["user_id"] for row in self.repo.load_all("chats_participants") if row.get("chat_id") == chat_id and row.get("user_id") != sender_id}

    def system_message_for_request(self, request: dict, text: str, *, repo: Repository | None = None) -> dict:
        storage = repo or self.repo
        chat = self._get_or_create("module_cfo", request["unit_id"], request["budget_year"], repo=storage)
        return storage.create("chat_messages", {"chat_id": chat["id"], "reply_to": None, "sender_id": None, "text": text, "is_system": True})

    def system_message_for_position(self, position: dict, text: str, *, repo: Repository | None = None) -> dict:
        storage = repo or self.repo
        chat = self._get_or_create("cfo_economist", position["cfo_unit_id"], position["budget_year"], repo=storage)
        return storage.create("chat_messages", {"chat_id": chat["id"], "reply_to": None, "sender_id": None, "text": text, "is_system": True})

    def comment_for_position(self, user: dict, position: dict, text: str, *, repo: Repository | None = None) -> dict:
        """Persist a workflow comment as an authored message in the CFO chat."""
        storage = repo or self.repo
        chat = self._get_or_create("cfo_economist", position["cfo_unit_id"], position["budget_year"], repo=storage)
        self._sync_participants(chat, repo=storage)
        return storage.create(
            "chat_messages",
            {"chat_id": chat["id"], "reply_to": None, "sender_id": user["id"], "text": text.strip()},
        )

    def comment_for_request(self, user: dict, request: dict, text: str, *, repo: Repository | None = None) -> dict:
        storage = repo or self.repo
        chat = self._get_or_create("module_cfo", request["unit_id"], request["budget_year"], repo=storage)
        self._sync_participants(chat, repo=storage)
        return storage.create(
            "chat_messages",
            {"chat_id": chat["id"], "reply_to": None, "sender_id": user["id"], "text": text.strip()},
        )
