from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from app.repositories.base import Repository


class NotificationService:
    def __init__(self, repo: Repository):
        self.repo = repo

    def create(
        self,
        user_id: str,
        notification_type: str,
        payload: dict,
        *,
        repo: Repository | None = None,
    ) -> dict:
        return (repo or self.repo).create(
            "notifications",
            {
                "user_id": user_id,
                "type": notification_type,
                "payload": payload,
                "read_at": None,
            },
        )

    def list_for_user(self, user: dict, *, unread_only: bool = False) -> list[dict]:
        items = [
            item
            for item in self.repo.load_all("notifications")
            if item.get("user_id") == user["id"]
            and (not unread_only or not item.get("read_at"))
        ]
        return sorted(items, key=lambda item: str(item.get("created_at") or ""), reverse=True)

    def mark(self, user: dict, notification_id: str, *, read: bool) -> dict:
        notification = self.repo.get_by_id("notifications", notification_id)
        if not notification or notification.get("user_id") != user["id"]:
            raise HTTPException(status_code=404, detail="Уведомление не найдено")
        return self.repo.update(
            "notifications",
            notification_id,
            {
                "read_at": datetime.now(timezone.utc).isoformat() if read else None,
            },
        )

    def mark_all_read(self, user: dict) -> dict:
        count = 0
        now = datetime.now(timezone.utc).isoformat()
        for item in self.list_for_user(user, unread_only=True):
            self.repo.update("notifications", item["id"], {"read_at": now})
            count += 1
        return {"updated": count}
