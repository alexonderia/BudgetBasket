from __future__ import annotations

from datetime import date
from urllib.parse import quote
from uuid import uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from app.models import APPROVED_ITEM_STATUSES, CfoPositionStatus, ItemStatus, RequestStatus
from app.repositories.base import Repository
from app.services.common import (
    cfo_position_current_step_id,
    get_required,
    request_author_id,
    request_cfo_review_completed,
    request_returned_item_ids,
)
from app.services.permission_service import PermissionService


ANALYTICS_FIELDS = tuple(f"analytics_{index}" for index in range(1, 6))
EMPTY_ANALYTICS_GROUP_VALUE = "__empty__"
REGISTER_GROUP_LEVELS = ("cfo", "article", "category", "module", "request", *ANALYTICS_FIELDS)
DEFAULT_REGISTER_GROUPS = {
    "cfo": ("cfo", "article", "category", "module"),
    "category": ("category", "module"),
    "article": ("article", "category", "module"),
    "module": ("module", "article", "category"),
    "request": ("request",),
}


class RequestService:
    def __init__(self, repo: Repository, permissions: PermissionService):
        self.repo = repo
        self.permissions = permissions
        self.notifications = None

    @staticmethod
    def _catalog_article_id(catalog: dict[str, dict], leaf_id: str | None) -> str | None:
        """Resolve register-level article id (parent) from a catalog leaf/category id."""
        if not leaf_id:
            return None
        leaf = catalog.get(leaf_id) or {}
        parent_id = leaf.get("parent_id")
        if parent_id and parent_id in catalog:
            return parent_id
        return leaf_id

    def _items(
        self,
        request_id: str,
        *,
        include_deleted: bool = False,
        repo: Repository | None = None,
    ) -> list[dict]:
        storage = repo or self.repo
        items = [
            item
            for item in storage.load_all("req_items")
            if item.get("request_id") == request_id
        ]
        return (
            items
            if include_deleted
            else [item for item in items if item.get("status") != ItemStatus.deleted]
        )

    def log(
        self,
        user: dict,
        request_id: str,
        action: str,
        *,
        entity: str = "request",
        entity_id: str | None = None,
        before: dict | None = None,
        after: dict | None = None,
        event_id: str | None = None,
        comment: str | None = None,
        stage: str = "request",
        repo: Repository | None = None,
        **extra,
    ) -> None:
        before = before or {}
        after = after or {}
        changes = {
            key: {"from": before.get(key), "to": after.get(key)}
            for key in set(before) | set(after)
            if before.get(key) != after.get(key)
        }
        (repo or self.repo).create(
            "req_logs",
            {
                "req_id": request_id,
                "user_id": user["id"],
                "log": jsonable_encoder(
                    {
                        "event_id": event_id or str(uuid4()),
                        "action": action,
                        "stage": stage,
                        "entity": entity,
                        "entity_id": entity_id or request_id,
                        "request_id": request_id,
                        "changes": changes,
                        "comment": comment,
                        **extra,
                    }
                ),
            },
        )

    def summary(self, request_id: str) -> dict:
        items = self._items(request_id)
        accepted = [item for item in items if item.get("status") in APPROVED_ITEM_STATUSES]
        rejected = [item for item in items if item.get("status") == ItemStatus.rejected]
        in_review = [item for item in items if item.get("status") == ItemStatus.on_review]
        expenses = [item for item in items if not item.get("is_income", False)]
        income = [item for item in items if item.get("is_income", False)]
        return {
            "request_id": request_id,
            "planned_sum": sum(float(item.get("sum_plan") or 0) for item in expenses),
            "approved_sum": sum(
                float(item.get("sum_fact") or 0)
                for item in accepted
                if not item.get("is_income", False)
            ),
            "income_planned_sum": sum(float(item.get("sum_plan") or 0) for item in income),
            "income_approved_sum": sum(
                float(item.get("sum_fact") or 0)
                for item in accepted
                if item.get("is_income", False)
            ),
            "items_count": len(items),
            "accepted_count": len(accepted),
            "rejected_count": len(rejected),
            "in_review_count": len(in_review),
            "deleted_count": len(self._items(request_id, include_deleted=True)) - len(items),
        }

    def recalculate_total(
        self,
        request_id: str,
        *,
        repo: Repository | None = None,
    ) -> dict:
        # Request totals are derived from request lines and are not duplicated
        # in the requests table.
        return get_required(repo or self.repo, "requests", request_id)

    def _has_module_access(self, user: dict | None, request: dict) -> bool:
        return bool(
            user
            and user.get("role") == "employee"
            and request.get("unit_id") in self.permissions.employee_module_ids(user["id"])
        )

    def _has_cfo_access(self, user: dict | None, request: dict) -> bool:
        if not user or user.get("role") != "employee":
            return False
        cfo_id = self.permissions.cfo_for_module(request["unit_id"])
        return bool(cfo_id and cfo_id in self.permissions.employee_cfo_ids(user["id"]))

    def _can_cancel_before_general_route(
        self,
        request: dict,
        *,
        repo: Repository | None = None,
    ) -> bool:
        storage = repo or self.repo
        if request.get("status") != RequestStatus.on_review:
            return False
        position_ids = {
            item.get("cfo_position_id")
            for item in self._items(request["id"], repo=storage)
            if item.get("cfo_position_id")
        }
        if not position_ids:
            return False
        positions = {
            row["id"]: row
            for row in storage.load_all("cfo_positions")
            if row["id"] in position_ids
        }
        if len(positions) != len(position_ids):
            return False
        steps = {row["id"]: row for row in storage.load_all("steps")}
        users = {row["id"]: row for row in storage.load_all("users")}
        cfo_id = self.permissions.cfo_for_module(request["unit_id"])
        if not cfo_id:
            return False
        for position in positions.values():
            step = steps.get(cfo_position_current_step_id(storage, position))
            step_user = users.get(step.get("user_id"), {}) if step else {}
            if not step or not (
                step.get("unit_id") == cfo_id
                or step_user.get("role") == "economist"
            ):
                return False
        downstream_actions = {
            "position_frozen_and_forwarded",
            "position_approved_at_step",
            "position_returned",
            "position_items_fixed",
            "position_fixed",
        }
        return not any(
            row.get("cfo_position_id") in position_ids
            and (row.get("log") or {}).get("action") in downstream_actions
            for row in storage.load_all("cfo_position_logs")
        )

    def public_request(
        self,
        request: dict,
        summary: dict | None = None,
        *,
        user: dict | None = None,
    ) -> dict:
        summary = summary or self.summary(request["id"])
        active_items = self._items(request["id"])
        all_items_frozen = bool(active_items) and all(bool(item.get("frozen")) for item in active_items)
        all_items_fixed = bool(active_items) and all(bool(item.get("fixed")) for item in active_items)
        cfo_id = self.permissions.cfo_for_module(request["unit_id"])
        actions: list[str] = []
        if request.get("status") == RequestStatus.draft and self._has_module_access(user, request):
            actions.extend(["edit", "submit", "delete"])
        elif request.get("status") == RequestStatus.cancelled and self._has_module_access(user, request):
            actions.append("restore")
        elif request.get("status") == RequestStatus.on_review:
            if self._has_module_access(user, request) and self._can_cancel_before_general_route(request):
                actions.append("cancel")
            if self.returned_item_ids(request["id"]) and self._has_module_access(user, request):
                actions.extend(["edit_revision", "submit"])
            elif not self.cfo_review_completed(request["id"]) and self._has_cfo_access(user, request):
                actions.append("complete_cfo_review")
        return {
            **request,
            "sum": summary["planned_sum"],
            "sum_plan": summary["planned_sum"],
            "cfo_unit_id": cfo_id,
            "cfo_responsible_id": (
                self.permissions.cfo_responsible_id(cfo_id) if cfo_id else None
            ),
            "sum_fact": summary["approved_sum"],
            "total_approved_sum": summary["approved_sum"],
            "summary": summary,
            "frozen": all_items_frozen,
            "fixed": all_items_fixed,
            "available_actions": actions,
            "unit_budget": {
                "annual_budget": float(
                    get_required(self.repo, "units", request["unit_id"]).get("annual_budget") or 0
                )
            },
        }

    def list_requests(
        self,
        user: dict,
        status: str | None = None,
        unit_id: str | None = None,
        created_from: str | None = None,
        created_to: str | None = None,
        budget_year: int | None = None,
    ) -> list[dict]:
        visible = self.permissions.visible_request_ids(user)
        result: list[dict] = []
        for request in self.repo.load_all("requests"):
            if visible is not None and request["id"] not in visible:
                continue
            if status and request.get("status") != status:
                continue
            if unit_id and request.get("unit_id") != unit_id:
                continue
            if budget_year and request.get("budget_year") != budget_year:
                continue
            created_at = str(request.get("created_at") or "")
            if created_from and created_at < created_from:
                continue
            if created_to and created_at > created_to:
                continue
            result.append(self.public_request(request, user=user))
        return sorted(result, key=lambda item: str(item.get("created_at") or ""), reverse=True)

    def get_request(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_view_request(user, request)
        return self.public_request(request, user=user)

    def list_cfo_incoming(self, user: dict) -> list[dict]:
        cfo_ids = self.permissions.employee_cfo_ids(user["id"])
        if user.get("role") != "employee" or not cfo_ids:
            return []
        module_ids = self.permissions.modules_for_cfos(cfo_ids)
        return [
            self.public_request(request, user=user)
            for request in self.repo.load_all("requests")
            if request.get("unit_id") in module_ids
            and request.get("status") == RequestStatus.on_review
        ]

    @staticmethod
    def _items_for_position(repo: Repository, position_id: str) -> list[dict]:
        active_request_ids = {
            request["id"]
            for request in repo.load_all("requests")
            if request.get("status") != RequestStatus.cancelled
        }
        return [
            row for row in repo.load_all("req_items")
            if row.get("cfo_position_id") == position_id and row.get("status") != ItemStatus.deleted
            and row.get("request_id") in active_request_ids
        ]

    def cfo_review_completed(self, request_id: str, *, repo: Repository | None = None) -> bool:
        return request_cfo_review_completed(repo or self.repo, request_id)

    def returned_item_ids(self, request_id: str, *, repo: Repository | None = None) -> set[str]:
        return request_returned_item_ids(repo or self.repo, request_id)

    def _latest_cfo_decisions(
        self,
        request_id: str,
        *,
        repo: Repository | None = None,
    ) -> dict[str, str]:
        storage = repo or self.repo
        decisions: dict[str, str] = {}
        rows = sorted(
            (
                row for row in storage.load_all("req_logs")
                if row.get("req_id") == request_id
            ),
            key=lambda row: (str(row.get("created_at") or ""), int(row.get("id") or 0)),
        )
        for row in rows:
            log = row.get("log") or {}
            if log.get("action") == "request_restored":
                decisions.clear()
                continue
            if log.get("action") == "cfo_items_returned_for_revision":
                for item_id in log.get("item_ids") or []:
                    decisions.pop(str(item_id), None)
                continue
            if log.get("action") != "cfo_item_decided":
                continue
            item_id = log.get("entity_id") if log.get("entity") == "req_item" else None
            decision = log.get("decision")
            if not decision:
                decision = ((log.get("changes") or {}).get("status") or {}).get("to")
            if not item_id or decision not in {
                ItemStatus.approved,
                ItemStatus.approved_with_changes,
                ItemStatus.rejected,
            }:
                continue
            decisions[str(item_id)] = str(decision)
        return decisions

    def create_request(self, user: dict, payload: dict) -> dict:
        unit_id = payload["unit_id"]
        self.permissions.require_employee_unit_access(user, unit_id)
        budget_year = date.today().year
        with self.repo.transaction() as repo:
            existing = next(
                (
                    request
                    for request in repo.load_all("requests")
                    if request.get("unit_id") == unit_id
                    and int(request.get("budget_year") or 0) == budget_year
                    and request.get("status") != RequestStatus.cancelled
                ),
                None,
            )
            if existing:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "Для модуля уже существует активная заявка текущего года",
                        "request_id": existing["id"],
                    },
                )
            created = repo.create(
                "requests",
                {
                    "unit_id": unit_id,
                    "budget_year": budget_year,
                    "status": RequestStatus.draft,
                },
            )
            self.log(user, created["id"], "request_created", after=created, repo=repo)
        return self.public_request(created, user=user)

    def delete_request(self, user: dict, request_id: str) -> None:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_request_delete_request(user, request)
        self.repo.delete("requests", request_id)

    def patch_request(self, user: dict, request_id: str, patch: dict) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_employee_edit_request(user, request)
        if patch:
            raise HTTPException(status_code=400, detail="У заявки нет свободно редактируемых полей")
        return self.public_request(request, user=user)

    def submit(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        is_revision = (
            request.get("status") == RequestStatus.on_review
            and bool(self.returned_item_ids(request_id))
        )
        if is_revision:
            self.permissions.require_employee_unit_access(user, request["unit_id"])
        else:
            self.permissions.require_employee_edit_request(user, request)
        items = self._items(request_id)
        if not items:
            raise HTTPException(status_code=400, detail="Нельзя отправить заявку без строк")
        cfo_id = self.permissions.cfo_for_module(request["unit_id"])
        if not cfo_id:
            raise HTTPException(status_code=409, detail="Для модуля не определен ЦФО")
        responsible_id = self.permissions.cfo_responsible_id(cfo_id)
        if not responsible_id:
            raise HTTPException(status_code=409, detail="Для ЦФО не назначен ответственный")
        approval_service = getattr(self, "approval_service", None)
        if approval_service:
            approval_service.sync_automatic_steps(user)
        event_id = str(uuid4())
        with self.repo.transaction() as repo:
            locked = repo.lock_by_id("requests", request_id)
            returned_ids = self.returned_item_ids(request_id, repo=repo)
            revision_submit = bool(
                locked
                and locked.get("status") == RequestStatus.on_review
                and returned_ids
            )
            if not locked or (
                locked.get("status") != RequestStatus.draft and not revision_submit
            ):
                raise HTTPException(status_code=409, detail="Заявка уже была отправлена")

            cfo_step = next(
                (step for step in repo.load_all("steps") if step.get("unit_id") == cfo_id),
                None,
            )
            if not cfo_step:
                raise HTTPException(status_code=409, detail="Для ЦФО не настроен нижний шаг маршрута")

            positions = repo.load_all("cfo_positions")
            by_key: dict[tuple, dict] = {}
            for position in positions:
                key = self._position_key(repo, position["cfo_unit_id"], position, position)
                if key in by_key and by_key[key]["id"] != position["id"]:
                    raise HTTPException(
                        status_code=409,
                        detail="В базе обнаружены дублирующие позиции одной статьи ЦФО",
                    )
                by_key[key] = position

            affected_positions: set[str] = set()
            link_items = [
                item for item in self._items(request_id, repo=repo)
                if not revision_submit or item["id"] in returned_ids
            ]
            for item in link_items:
                if item.get("fixed") or item.get("frozen"):
                    raise HTTPException(status_code=409, detail="Закрытую строку нельзя отправить повторно")
                key = self._position_key(repo, cfo_id, locked, item)
                position = by_key.get(key)
                if position:
                    position_items = self._items_for_position(repo, position["id"])
                    current_step_id = cfo_position_current_step_id(repo, position)
                    if any(row.get("frozen") or row.get("fixed") for row in position_items):
                        raise HTTPException(
                            status_code=409,
                            detail="Нельзя дополнить замороженную или зафиксированную позицию",
                        )
                    if current_step_id not in {None, cfo_step["id"]}:
                        raise HTTPException(
                            status_code=409,
                            detail="Позиция уже передана выше и не принимает поздние строки",
                        )
                    position = repo.update(
                        "cfo_positions",
                        position["id"],
                        {"status": "on_review", "current_step_id": cfo_step["id"]},
                    )
                else:
                    position = repo.create(
                        "cfo_positions",
                        {
                            "budget_year": locked["budget_year"],
                            "cfo_unit_id": cfo_id,
                            "dds_id": key[2],
                            "invest_id": key[3],
                            "status": "on_review",
                            "current_step_id": cfo_step["id"],
                        },
                    )
                    by_key[key] = position
                before_item = dict(item)
                linked = (
                    repo.update("req_items", item["id"], {"cfo_position_id": position["id"]})
                    if item.get("cfo_position_id") != position["id"]
                    else item
                )
                repo.create(
                    "cfo_position_logs",
                    {
                        "cfo_position_id": position["id"],
                        "user_id": user["id"],
                        "step_id": cfo_step["id"],
                        "log": jsonable_encoder(
                            {
                                "event_id": event_id,
                                "action": "position_item_linked" if not revision_submit else "position_item_resubmitted",
                                "stage": "cfo_review",
                                "entity": "req_item",
                                "entity_id": item["id"],
                                "request_id": request_id,
                                "req_item_id": item["id"],
                                "cfo_position_id": position["id"],
                                "step_id": cfo_step["id"],
                                "changes": {
                                    "cfo_position_id": {
                                        "from": before_item.get("cfo_position_id"),
                                        "to": linked.get("cfo_position_id"),
                                    }
                                },
                                "comment": None,
                            }
                        ),
                    },
                )
                affected_positions.add(position["id"])

            updated = (
                locked
                if revision_submit
                else repo.update("requests", request_id, {"status": RequestStatus.on_review})
            )
            self.log(
                user,
                request_id,
                "request_revision_resubmitted_to_cfo" if revision_submit else "request_submitted_to_cfo",
                before=locked,
                after=updated,
                event_id=event_id,
                stage="cfo_review",
                cfo_unit_id=cfo_id,
                cfo_position_ids=sorted(affected_positions),
                item_ids=sorted(returned_ids) if revision_submit else [row["id"] for row in items],
                repo=repo,
            )
            repo.update("steps", cfo_step["id"], {"status": "on_approval"})
            if getattr(self, "chat_service", None):
                self.chat_service.system_message_for_request(
                    updated,
                    f"Заявка {request_id[:8]} направлена ответственному за ЦФО.",
                    repo=repo,
                )
            if self.notifications:
                self.notifications.create(
                    responsible_id,
                    "request.submitted_to_cfo",
                    {"request_id": request_id, "cfo_unit_id": cfo_id},
                    repo=repo,
                )
        result = self.public_request(updated, user=user)
        result["notification_user_ids"] = [responsible_id]
        result["affected_cfo_position_ids"] = sorted(affected_positions)
        return result

    def cancel(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_employee_unit_access(user, request["unit_id"])
        if request.get("status") == RequestStatus.cancelled:
            return self.public_request(request, user=user)
        with self.repo.transaction() as repo:
            locked = repo.lock_by_id("requests", request_id)
            if not locked:
                raise HTTPException(status_code=404, detail="Заявка не найдена")
            if locked.get("status") == RequestStatus.cancelled:
                updated = locked
            else:
                self.permissions.require_employee_cancel_request(user, locked)
                if not self._can_cancel_before_general_route(locked, repo=repo):
                    raise HTTPException(
                        status_code=409,
                        detail="Заявку можно отменить только до передачи на общий маршрут согласования",
                    )
                updated = repo.update("requests", request_id, {"status": RequestStatus.cancelled})
                self.log(user, request_id, "request_cancelled", before=locked, after=updated, repo=repo)
                approval_service = getattr(self, "approval_service", None)
                if approval_service:
                    approval_service._sync_step_statuses(repo)
        return self.public_request(updated, user=user)

    def restore(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_employee_unit_access(user, request["unit_id"])
        if request.get("status") == RequestStatus.draft:
            return self.public_request(request, user=user)
        if request.get("status") != RequestStatus.cancelled:
            raise HTTPException(status_code=409, detail="Восстановить можно только отмененную заявку")
        with self.repo.transaction() as repo:
            locked = repo.lock_by_id("requests", request_id)
            if not locked:
                raise HTTPException(status_code=404, detail="Заявка не найдена")
            if locked.get("status") == RequestStatus.draft:
                updated = locked
            elif locked.get("status") != RequestStatus.cancelled:
                raise HTTPException(status_code=409, detail="Восстановить можно только отмененную заявку")
            else:
                active_request = next(
                    (
                        candidate
                        for candidate in repo.load_all("requests")
                        if candidate["id"] != locked["id"]
                        and candidate.get("unit_id") == locked["unit_id"]
                        and int(candidate.get("budget_year") or 0) == int(locked.get("budget_year") or 0)
                        and candidate.get("status") != RequestStatus.cancelled
                    ),
                    None,
                )
                if active_request:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "message": "Нельзя восстановить заявку: для модуля уже существует активная заявка этого года",
                            "request_id": active_request["id"],
                        },
                    )
                for item in self._items(request_id, repo=repo):
                    repo.update(
                        "req_items",
                        item["id"],
                        {
                            "status": ItemStatus.on_review,
                            # req_items.sum_fact is NOT NULL in PostgreSQL;
                            # restored drafts have no accepted fact yet.
                            "sum_fact": 0,
                            "frozen": False,
                            "fixed": False,
                            "cfo_position_id": None,
                        },
                    )
                updated = repo.update("requests", request_id, {"status": RequestStatus.draft})
                self.log(user, request_id, "request_restored", before=locked, after=updated, repo=repo)
                approval_service = getattr(self, "approval_service", None)
                if approval_service:
                    approval_service._sync_step_statuses(repo)
        return self.public_request(updated, user=user)

    def _position_key(self, repo: Repository, cfo_id: str, request: dict, item: dict) -> tuple:
        dds_id = self._catalog_article_id(
            {row["id"]: row for row in repo.load_all("dds_catalog")},
            item.get("dds_id"),
        )
        invest_id = self._catalog_article_id(
            {row["id"]: row for row in repo.load_all("invests_catalog")},
            item.get("invest_id"),
        )
        return (
            int(request["budget_year"]),
            cfo_id,
            dds_id,
            invest_id,
        )

    def complete_cfo_review(self, user: dict, request_id: str) -> dict:
        with self.repo.transaction() as repo:
            request = repo.lock_by_id("requests", request_id)
            if not request:
                raise HTTPException(status_code=404, detail="Заявка не найдена")
            self.permissions.require_cfo_request_access(user, request)
            if request.get("status") != RequestStatus.on_review:
                raise HTTPException(status_code=409, detail="Заявка не находится на проверке ЦФО")
            if self.cfo_review_completed(request_id, repo=repo):
                raise HTTPException(status_code=409, detail="Проверка ЦФО уже завершена")
            if self.returned_item_ids(request_id, repo=repo):
                raise HTTPException(status_code=409, detail="Заявка находится на доработке у модуля")
            items = self._items(request_id, repo=repo)
            if not items:
                raise HTTPException(status_code=409, detail="У заявки нет активных строк")
            decisions = self._latest_cfo_decisions(request_id, repo=repo)
            pending = [item["id"] for item in items if item["id"] not in decisions]
            if pending:
                raise HTTPException(
                    status_code=409,
                    detail={"message": "Не все строки рассмотрены", "item_ids": pending},
                )
            accepted = [
                item for item in items
                if decisions.get(item["id"]) in APPROVED_ITEM_STATUSES
            ]
            cfo_id = self.permissions.cfo_for_module(request["unit_id"])
            if not cfo_id:
                raise HTTPException(status_code=409, detail="Для модуля не определен ЦФО")
            event_id = str(uuid4())
            affected = sorted({
                item["cfo_position_id"] for item in items if item.get("cfo_position_id")
            })
            if len(affected) == 0:
                raise HTTPException(status_code=409, detail="Строки заявки не связаны с позициями ЦФО")
            next_status = RequestStatus.rejected if not accepted else RequestStatus.on_review
            updated = repo.update(
                "requests",
                request_id,
                {
                    "status": next_status,
                },
            )
            self.log(
                user,
                request_id,
                "cfo_request_review_completed",
                before=request,
                after=updated,
                event_id=event_id,
                stage="cfo_review",
                cfo_unit_id=cfo_id,
                cfo_position_ids=affected,
                accepted_item_ids=[item["id"] for item in accepted],
                rejected_item_ids=[
                    item["id"] for item in items
                    if decisions.get(item["id"]) == ItemStatus.rejected
                ],
                repo=repo,
            )
            author_id = request_author_id(repo, request_id)
            if self.notifications and author_id:
                self.notifications.create(
                    author_id,
                    "request.cfo_review_completed",
                    {"request_id": request_id, "status": str(next_status)},
                    repo=repo,
                )
        return {
            **self.public_request(updated, user=user),
            "affected_cfo_position_ids": affected,
            "notification_user_ids": [
                user_id
                for user_id in {author_id}
                if user_id
            ],
        }

    def counterparty_contact(self, user: dict, request_id: str) -> dict | None:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_view_request(user, request)
        cfo_id = self.permissions.cfo_for_module(request["unit_id"])
        target_id = None
        if user.get("role") == "employee":
            if request["unit_id"] in self.permissions.employee_module_ids(user["id"]):
                target_id = self.permissions.cfo_responsible_id(cfo_id) if cfo_id else None
            else:
                target_id = request_author_id(self.repo, request_id)
        elif user.get("role") == "economist":
            target_id = self.permissions.cfo_responsible_id(cfo_id) if cfo_id else None
        target = self.repo.get_by_id("users", target_id) if target_id else None
        profile = next(
            (
                item
                for item in self.repo.load_all("profiles")
                if item.get("user_id") == target_id
            ),
            None,
        )
        return (
            {
                "user_id": target["id"],
                "login": target["login"],
                "role": target["role"],
                "profile": profile,
            }
            if target
            else None
        )

    def _visible_positions(self, user: dict, *, is_income: bool | None = None) -> list[dict]:
        visible = self.permissions.visible_position_ids(user)
        position_income: dict[str, set[bool]] = {}
        for item in self.repo.load_all("req_items"):
            position_id = item.get("cfo_position_id")
            if position_id:
                position_income.setdefault(position_id, set()).add(
                    bool(item.get("is_income", False))
                )
        return [
            item
            for item in self.repo.load_all("cfo_positions")
            if (visible is None or item["id"] in visible)
            and (is_income is None or is_income in position_income.get(item["id"], set()))
        ]

    def _position_sum(self, position_id: str, *, is_income: bool | None = None) -> tuple[float, float, int]:
        items = [
            item
            for item in self.repo.load_all("req_items")
            if item.get("cfo_position_id") == position_id
            and item.get("status") != ItemStatus.deleted
            and (is_income is None or bool(item.get("is_income", False)) == is_income)
        ]
        return (
            sum(
                float(item.get("sum_plan") or 0)
                for item in items
                if item.get("status") != ItemStatus.rejected
            ),
            sum(
                float(item.get("sum_fact") or 0)
                for item in items
                if item.get("status") in APPROVED_ITEM_STATUSES
            ),
            len(items),
        )

    def dashboard(self, user: dict, unit_id: str | None = None, *, is_income: bool = False) -> dict:
        positions = [
            item
            for item in self._visible_positions(user, is_income=is_income)
            if not unit_id or item.get("cfo_unit_id") == unit_id
        ]
        units = {item["id"]: item for item in self.repo.load_all("units")}
        rows: list[dict] = []
        for position in positions:
            planned, approved, count = self._position_sum(position["id"], is_income=is_income)
            rows.append(
                {
                    "id": position["id"],
                    "cfo_id": position["cfo_unit_id"],
                    "name": units.get(position["cfo_unit_id"], {}).get("name", "ЦФО"),
                    "kind": "cfo",
                    "planned": planned,
                    "approved": approved,
                    "items_count": count,
                }
            )
        position_ids = {position["id"] for position in positions}
        requests = {item["id"]: item for item in self.repo.load_all("requests")}
        scoped_request_ids = {
            item["request_id"]
            for item in self.repo.load_all("req_items")
            if item.get("cfo_position_id") in position_ids
        }
        articles = self.dashboard_articles_cfo(user, unit_id, is_income=is_income)
        by_article = [
            {
                "id": article["id"],
                "article_id": article["id"].partition(":")[2],
                "name": article["name"],
                "kind": "dds" if article["id"].startswith("dds:") else "invest",
                "planned": article["planned"],
                "approved": article["approved"],
                "items_count": article["items_count"],
            }
            for article in articles
        ]
        return {
            "scope": {
                "unit_id": unit_id,
                "available_units": [
                    {"id": item["id"], "name": item["name"], "parent_id": item.get("parent_id")}
                    for item in units.values()
                    if any(position.get("cfo_unit_id") == item["id"] for position in positions)
                ],
                "table_units": [],
            },
            "totals": {
                "planned": sum(item["planned"] for item in rows),
                "approved": sum(item["approved"] for item in rows),
                "frozen": sum(
                    float(item.get("sum_fact") or 0)
                    for item in self.repo.load_all("req_items")
                    if item.get("cfo_position_id") in {position["id"] for position in positions}
                    and item.get("frozen") and item.get("status") in APPROVED_ITEM_STATUSES
                ),
                "remaining": max(
                    sum(item["planned"] for item in rows)
                    - sum(item["approved"] for item in rows),
                    0,
                ),
                "requests_count": len(scoped_request_ids),
                "approved_requests_count": sum(
                    1 for request_id in scoped_request_ids
                    if requests.get(request_id, {}).get("status") == "approved"
                ),
                "review_requests_count": sum(
                    1 for request_id in scoped_request_ids
                    if requests.get(request_id, {}).get("status") == "on_review"
                ),
                "frozen_requests_count": len({
                    item.get("request_id") for item in self.repo.load_all("req_items")
                    if item.get("cfo_position_id") in position_ids and item.get("frozen")
                }),
            },
            "by_unit": rows,
            "by_category": [],
            "by_article": by_article,
        }

    def dashboard_article_cfo(
        self,
        user: dict,
        article_key: str,
        unit_id: str | None = None,
        *,
        is_income: bool = False,
    ) -> list[dict]:
        kind, separator, article_id = article_key.partition(":")
        if not separator or kind not in {"dds", "invest"}:
            return []
        result: list[dict] = []
        units = {item["id"]: item for item in self.repo.load_all("units")}
        catalog = {
            item["id"]: item
            for item in self.repo.load_all("dds_catalog" if kind == "dds" else "invests_catalog")
        }
        requested_article_id = self._catalog_article_id(catalog, article_id)
        for position in self._visible_positions(user, is_income=is_income):
            if unit_id and position.get("cfo_unit_id") != unit_id:
                continue
            leaf_id = position.get(f"{kind}_id")
            resolved = self._catalog_article_id(catalog, leaf_id)
            # Accept both article (parent) and category (leaf) keys for drill-down.
            if leaf_id != article_id and resolved != requested_article_id:
                continue
            planned, approved, count = self._position_sum(position["id"], is_income=is_income)
            result.append(
                {
                    "id": position["cfo_unit_id"],
                    "cfo_id": position["cfo_unit_id"],
                    "name": units.get(position["cfo_unit_id"], {}).get("name", "ЦФО"),
                    "planned": planned,
                    "approved": approved,
                    "items_count": count,
                }
            )
        return result

    def dashboard_articles_cfo(
        self,
        user: dict,
        unit_id: str | None = None,
        *,
        is_income: bool = False,
    ) -> list[dict]:
        result: list[dict] = []
        seen: set[tuple[str, str]] = set()
        catalogs = {
            "dds": {item["id"]: item for item in self.repo.load_all("dds_catalog")},
            "invest": {item["id"]: item for item in self.repo.load_all("invests_catalog")},
        }
        for position in self._visible_positions(user, is_income=is_income):
            if unit_id and position.get("cfo_unit_id") != unit_id:
                continue
            kind = "dds" if position.get("dds_id") else "invest"
            leaf_id = position.get("dds_id") or position.get("invest_id")
            article_id = self._catalog_article_id(catalogs[kind], leaf_id)
            if not article_id:
                continue
            key = (kind, article_id)
            if key in seen:
                continue
            seen.add(key)
            cfo_rows = self.dashboard_article_cfo(
                user,
                f"{kind}:{article_id}",
                unit_id,
                is_income=is_income,
            )
            result.append(
                {
                    "id": f"{kind}:{article_id}",
                    "article_id": article_id,
                    "name": catalogs[kind].get(article_id, {}).get("name", article_id),
                    "kind": kind,
                    "planned": sum(row["planned"] for row in cfo_rows),
                    "approved": sum(row["approved"] for row in cfo_rows),
                    "items_count": sum(row["items_count"] for row in cfo_rows),
                    "cfo": cfo_rows,
                }
            )
        return result

    def dashboard_table(
        self,
        user: dict,
        unit_id: str | None = None,
        *,
        is_income: bool = False,
    ) -> list[dict]:
        rows: list[dict] = []
        requests = {item["id"]: item for item in self.repo.load_all("requests")}
        units = {item["id"]: item for item in self.repo.load_all("units")}
        dds = {item["id"]: item for item in self.repo.load_all("dds_catalog")}
        invests = {item["id"]: item for item in self.repo.load_all("invests_catalog")}
        positions = {
            item["id"]: item
            for item in self._visible_positions(user, is_income=is_income)
            if not unit_id or item.get("cfo_unit_id") == unit_id
        }
        for item in self.repo.load_all("req_items"):
            if bool(item.get("is_income", False)) != is_income:
                continue
            position = positions.get(item.get("cfo_position_id"))
            request = requests.get(item.get("request_id"))
            if not position or not request:
                continue
            module = units.get(request["unit_id"], {})
            cfo = units.get(position["cfo_unit_id"], {})
            organization = units.get(cfo.get("parent_id"), {})
            article = (
                dds.get(item.get("dds_id"), {})
                if item.get("dds_id")
                else invests.get(item.get("invest_id"), {})
            )
            rows.append(
                {
                    "request_id": request["id"],
                    "organization": organization.get("name", ""),
                    "cfo": cfo.get("name", ""),
                    "unit": module.get("name", ""),
                    "article": article.get("name", ""),
                    "module_id": request["unit_id"],
                    "module_name": units.get(request["unit_id"], {}).get("name", "Модуль"),
                    "cfo_id": position["cfo_unit_id"],
                    "cfo_name": units.get(position["cfo_unit_id"], {}).get("name", "ЦФО"),
                    "article_id": item.get("dds_id") or item.get("invest_id"),
                    "planned": float(item.get("sum_plan") or 0),
                    "approved": float(item.get("sum_fact") or 0)
                    if item.get("status") in APPROVED_ITEM_STATUSES
                    else 0,
                    "status": position["status"],
                    "fixed": bool(item.get("fixed")),
                }
            )
        return rows

    _REGISTER_DECISION_ACTIONS = {
        "cfo_item_decided": "Проверка ЦФО",
        "economist_item_decided": "Согласование экономиста",
        "item_returned_for_revision": "Возврат на доработку",
    }

    _REGISTER_DECISION_LABELS = {
        "cfo_item_decided": "Решение ответственного ЦФО",
        "economist_item_decided": "Решение экономиста",
        "item_returned_for_revision": "Возврат на доработку",
    }

    @staticmethod
    def _register_user_display_name(
        users: dict[str, dict],
        profiles: dict[str, dict],
        user_id: str | None,
    ) -> str | None:
        if not user_id:
            return None
        actor = users.get(user_id)
        if not actor:
            return None
        profile = profiles.get(user_id) or {}
        parts = [profile.get("last_name"), profile.get("name"), profile.get("second_name")]
        name = " ".join(part for part in parts if part)
        return name or actor.get("login")

    def _build_register_item_decisions(
        self,
        users: dict[str, dict],
        profiles: dict[str, dict],
    ) -> dict[str, dict]:
        latest: dict[str, dict] = {}

        def consider(
            item_id: str | None,
            created_at: str | None,
            user_id: str | None,
            action: str | None,
            stage: str | None = None,
        ) -> None:
            if not item_id or not action or action not in self._REGISTER_DECISION_ACTIONS:
                return
            current = latest.get(item_id)
            if current and str(created_at or "") <= str(current.get("at") or ""):
                return
            latest[item_id] = {
                "at": created_at,
                "by_id": user_id,
                "by_name": self._register_user_display_name(users, profiles, user_id),
                "action": action,
                "action_label": self._REGISTER_DECISION_LABELS.get(action, action),
                "stage": stage or self._REGISTER_DECISION_ACTIONS.get(action),
            }

        for row in self.repo.load_all("req_logs"):
            log = row.get("log") or {}
            action = log.get("action")
            item_id = log.get("entity_id") if log.get("entity") == "req_item" else None
            consider(item_id, row.get("created_at"), row.get("user_id"), action, log.get("stage"))

        for row in self.repo.load_all("cfo_position_logs"):
            log = row.get("log") or {}
            action = log.get("action")
            item_id = log.get("req_item_id")
            if not item_id and log.get("entity") == "req_item":
                item_id = log.get("entity_id")
            consider(item_id, row.get("created_at"), row.get("user_id"), action, log.get("stage"))

        return latest

    def _build_register_item_step_decisions(
        self,
        users: dict[str, dict],
        profiles: dict[str, dict],
    ) -> dict[str, dict[str, dict]]:
        items_by_id = {row["id"]: row for row in self.repo.load_all("req_items")}
        by_item: dict[str, dict[str, dict]] = {}

        def consider(
            item_id: str | None,
            created_at: str | None,
            user_id: str | None,
            action: str | None,
            stage: str | None,
            log: dict,
        ) -> None:
            if not item_id or not action or action not in self._REGISTER_DECISION_ACTIONS:
                return
            bucket = by_item.setdefault(item_id, {})
            current = bucket.get(action)
            if current and str(created_at or "") <= str(current.get("at") or ""):
                return
            item = items_by_id.get(item_id) or {}
            amount, item_status = self._register_decision_amount_status(
                log.get("changes") or {},
                str(item.get("status") or ItemStatus.on_review),
                float(item.get("sum_fact") or 0),
                float(item.get("sum_plan") or 0),
            )
            bucket[action] = {
                "at": created_at,
                "by_id": user_id,
                "by_name": self._register_user_display_name(users, profiles, user_id),
                "action": action,
                "action_label": self._REGISTER_DECISION_LABELS.get(action, action),
                "stage": stage or self._REGISTER_DECISION_ACTIONS.get(action),
                "amount": amount,
                "item_status": item_status,
            }

        for row in self.repo.load_all("req_logs"):
            log = row.get("log") or {}
            action = log.get("action")
            item_id = log.get("entity_id") if log.get("entity") == "req_item" else None
            consider(
                item_id,
                row.get("created_at"),
                row.get("user_id"),
                action,
                log.get("stage"),
                log,
            )

        for row in self.repo.load_all("cfo_position_logs"):
            log = row.get("log") or {}
            action = log.get("action")
            item_id = log.get("req_item_id")
            if not item_id and log.get("entity") == "req_item":
                item_id = log.get("entity_id")
            consider(
                item_id,
                row.get("created_at"),
                row.get("user_id"),
                action,
                log.get("stage"),
                log,
            )

        return by_item

    @staticmethod
    def _register_decision_amount_status(
        changes: dict,
        fallback_status: str,
        fallback_sum_fact: float,
        fallback_sum_plan: float,
    ) -> tuple[float | None, str]:
        status_change = changes.get("status") or {}
        sum_change = changes.get("sum_fact") or {}
        status = str(status_change.get("to") or fallback_status)
        if status in APPROVED_ITEM_STATUSES:
            if sum_change.get("to") is not None:
                amount = float(sum_change.get("to"))
            else:
                amount = float(fallback_sum_fact or fallback_sum_plan or 0)
        elif status == ItemStatus.rejected:
            amount = 0.0
        else:
            amount = None
        return amount, status

    @staticmethod
    def _register_step_display(
        label: str,
        tone: str,
        hint: str,
        *,
        ready: bool = False,
        amount: float | None = None,
        item_status: str | None = None,
    ) -> dict:
        payload = {
            "label": label,
            "tone": tone,
            "hint": hint,
            "ready": ready,
        }
        if amount is not None:
            payload["amount"] = amount
        if item_status is not None:
            payload["item_status"] = item_status
        return payload

    def _register_status_step_display(
        self,
        status: str,
        prefix: str = "",
        *,
        amount: float | None = None,
    ) -> dict:
        if status in APPROVED_ITEM_STATUSES:
            label = "Согласовано"
            if status == ItemStatus.approved_with_changes:
                label = "Согласовано с изменениями"
            tone = "success"
            resolved_amount = amount
        elif status == ItemStatus.rejected:
            label = "Отклонено"
            tone = "error"
            resolved_amount = 0.0 if amount is None else amount
        elif status == ItemStatus.on_review:
            label = "Не проверено"
            tone = "warning"
            resolved_amount = None
        else:
            label = "—"
            tone = "default"
            resolved_amount = None
        if prefix:
            label = f"{prefix}: {label}"
        return self._register_step_display(
            label,
            tone,
            "",
            amount=resolved_amount,
            item_status=status,
        )

    def _register_decision_step_display(self, decision: dict, fallback_status: str) -> dict:
        item_status = str(decision.get("item_status") or fallback_status)
        label = decision.get("action_label") or "Решение принято"
        by_name = decision.get("by_name")
        if by_name:
            label = f"{label} · {by_name}"
        if item_status in APPROVED_ITEM_STATUSES:
            tone = "success"
        elif item_status == ItemStatus.rejected:
            tone = "error"
        else:
            tone = "warning"
        hint_parts = [part for part in [decision.get("stage")] if part]
        return self._register_step_display(
            label,
            tone,
            " · ".join(hint_parts),
            amount=decision.get("amount"),
            item_status=item_status,
        )

    def _register_entry_amount_for_status(self, entry: dict, status: str) -> float | None:
        if status in APPROVED_ITEM_STATUSES:
            approved = float(entry.get("approved_sum") or 0)
            if approved:
                return approved
            return float(entry.get("requested_sum") or 0)
        if status == ItemStatus.rejected:
            return 0.0
        return None

    def _register_workflow_step_displays(
        self,
        *,
        user: dict,
        users: dict[str, dict],
        steps: dict[str, dict],
        position: dict | None,
        entry: dict,
        item_step_decisions: dict[str, dict[str, dict]],
        economist_decided_by_position: dict[str, set[str]],
    ) -> dict:
        role = user.get("role")
        if role not in {"economist", "approver", "zgd"}:
            return {}

        item_id = entry["id"]
        status = str(entry.get("status") or ItemStatus.on_review)
        step_decisions = item_step_decisions.get(item_id, {})
        cfo_decision = step_decisions.get("cfo_item_decided")
        economist_decision = step_decisions.get("economist_item_decided")

        if entry.get("is_collecting") or entry.get("request_status") == RequestStatus.draft:
            return {
                "previous_step": self._register_step_display(
                    "Черновик",
                    "default",
                    "Заявка ещё не отправлена на проверку",
                ),
                "your_step": self._register_step_display(
                    "Недоступно",
                    "default",
                    "Согласование станет доступно после отправки заявки",
                ),
            }

        if entry.get("fixed"):
            return {
                "previous_step": (
                    self._register_decision_step_display(
                        economist_decision or cfo_decision or {},
                        status,
                    )
                    if (economist_decision or cfo_decision)
                    else self._register_status_step_display(
                        status,
                        "Итог",
                        amount=self._register_entry_amount_for_status(entry, status),
                    )
                ),
                "your_step": self._register_step_display(
                    "Зафиксировано",
                    "success",
                    "Строка зафиксирована после финального согласования",
                    amount=self._register_entry_amount_for_status(entry, status),
                    item_status=status,
                ),
            }

        if entry.get("is_cfo_review"):
            return {
                "previous_step": self._register_step_display(
                    "Отправлено автором",
                    "info",
                    "Заявка отправлена на проверку ответственным ЦФО",
                ),
                "your_step": self._register_step_display(
                    "Не ваш этап",
                    "default",
                    "Сейчас проверка у ответственного ЦФО",
                ),
            }

        if not entry.get("is_in_approval") or not position:
            return {
                "previous_step": self._register_status_step_display(
                    status,
                    amount=self._register_entry_amount_for_status(entry, status),
                ),
                "your_step": self._register_step_display(
                    "Не в маршруте",
                    "default",
                    "Строка ещё не передана в маршрут согласования",
                ),
            }

        step = steps.get(cfo_position_current_step_id(self.repo, position))
        step_user = users.get(step.get("user_id"), {}) if step else {}
        step_role = step_user.get("role")
        is_my_step = step and step.get("user_id") == user.get("id")

        if role == "economist":
            if cfo_decision:
                previous = self._register_decision_step_display(cfo_decision, status)
            elif status == ItemStatus.on_review:
                previous = self._register_step_display(
                    "Не проверено ЦФО",
                    "warning",
                    "Ответственный ЦФО ещё не принял решение по строке",
                    item_status=ItemStatus.on_review,
                )
            else:
                previous = self._register_status_step_display(
                    status,
                    "ЦФО",
                    amount=self._register_entry_amount_for_status(entry, status),
                )

            pending_amount = float(entry.get("requested_sum") or 0)
            if cfo_decision and cfo_decision.get("amount") is not None:
                pending_amount = float(cfo_decision["amount"])

            if step_role != "economist":
                your = self._register_step_display(
                    "Не ваш этап",
                    "default",
                    entry.get("approval_stage") or "Ожидает другого этапа маршрута",
                )
            elif entry.get("is_approval_actionable"):
                your = self._register_step_display(
                    "Ваше решение",
                    "action",
                    "Согласуйте, скорректируйте сумму или верните на доработку",
                    ready=True,
                    amount=pending_amount,
                    item_status=ItemStatus.on_review,
                )
            elif item_id in economist_decided_by_position.get(position["id"], set()):
                your = (
                    self._register_decision_step_display(economist_decision, status)
                    if economist_decision
                    else self._register_status_step_display(
                        status,
                        "Вы",
                        amount=self._register_entry_amount_for_status(entry, status),
                    )
                )
            elif entry.get("frozen"):
                your = self._register_step_display(
                    "Передано дальше",
                    "info",
                    "Строка проверена и передана на следующий этап",
                    amount=self._register_entry_amount_for_status(entry, status),
                    item_status=status,
                )
            else:
                your = self._register_status_step_display(
                    status,
                    amount=self._register_entry_amount_for_status(entry, status),
                )

            return {"previous_step": previous, "your_step": your}

        if role in {"approver", "zgd"}:
            if economist_decision:
                previous = self._register_decision_step_display(economist_decision, status)
            elif entry.get("frozen") or status in APPROVED_ITEM_STATUSES:
                previous = self._register_status_step_display(
                    status,
                    "Экономист",
                    amount=self._register_entry_amount_for_status(entry, status),
                )
            else:
                previous = self._register_step_display(
                    "Не проверено",
                    "warning",
                    "Экономист ЦФО ещё не проверил строку",
                    item_status=ItemStatus.on_review,
                )

            if step_role != role:
                your = self._register_step_display(
                    "Не ваш этап",
                    "default",
                    entry.get("approval_stage") or "Строка на другом этапе маршрута",
                )
            elif not entry.get("frozen") and status == ItemStatus.on_review:
                your = self._register_step_display(
                    "Ожидает экономиста",
                    "warning",
                    "Сначала экономист должен проверить и передать строку в маршрут",
                )
            elif entry.get("frozen") and is_my_step and not entry.get("fixed"):
                your = self._register_step_display(
                    "Можно согласовать",
                    "action",
                    "Строка готова — согласуйте блок или верните выбранные строки на доработку",
                    ready=True,
                    amount=self._register_entry_amount_for_status(entry, status),
                    item_status=status,
                )
            elif entry.get("fixed"):
                your = self._register_step_display(
                    "Согласовано",
                    "success",
                    "Строка согласована на вашем этапе",
                    amount=self._register_entry_amount_for_status(entry, status),
                    item_status=status,
                )
            else:
                your = self._register_step_display(
                    "Ожидает",
                    "default",
                    entry.get("approval_stage") or "Строка в процессе согласования",
                )

            return {"previous_step": previous, "your_step": your}

        return {}

    def _register_current_owner(
        self,
        *,
        users: dict[str, dict],
        profiles: dict[str, dict],
        steps: dict[str, dict],
        position: dict | None,
        cfo_id: str | None,
        entry: dict,
    ) -> dict | None:
        if entry.get("fixed"):
            return None
        if entry.get("is_module_revision"):
            responsible_id = request_author_id(self.repo, entry["request_id"])
            return {
                "by_id": responsible_id,
                "by_name": self._register_user_display_name(users, profiles, responsible_id),
                "role_label": "Ответственный модуля",
            }
        if entry.get("is_cfo_review") and entry.get("status") == ItemStatus.on_review:
            responsible_id = self.permissions.cfo_responsible_id(cfo_id) if cfo_id else None
            return {
                "by_id": responsible_id,
                "by_name": self._register_user_display_name(users, profiles, responsible_id),
                "role_label": "Ответственный ЦФО",
            }
        if position and entry.get("is_in_approval"):
            step = steps.get(cfo_position_current_step_id(self.repo, position))
            if not step:
                return None
            if step.get("unit_id"):
                responsible_id = self.permissions.cfo_responsible_id(step["unit_id"])
                return {
                    "by_id": responsible_id,
                    "by_name": self._register_user_display_name(users, profiles, responsible_id),
                    "role_label": "Ответственный ЦФО",
                }
            assignee_id = step.get("user_id")
            actor = users.get(assignee_id) or {}
            if actor.get("role") == "economist":
                return {
                    "by_id": assignee_id,
                    "by_name": self._register_user_display_name(users, profiles, assignee_id),
                    "role_label": "Экономист ЦФО",
                }
            role_label = "ЗГД" if actor.get("role") == "zgd" else "Согласующий"
            return {
                "by_id": assignee_id,
                "by_name": self._register_user_display_name(users, profiles, assignee_id),
                "role_label": role_label,
            }
        return None

    def _register_editability(
        self,
        *,
        entry: dict,
        last_decision: dict | None,
        current_owner: dict | None,
    ) -> dict:
        can_edit_analytics = (
            entry.get("status") != ItemStatus.deleted
            and not entry.get("frozen")
            and not entry.get("fixed")
            and (
                bool(entry.get("is_revision_actionable"))
                or bool(entry.get("is_cfo_module_revision_actionable"))
                or bool(entry.get("is_cfo_review_actionable"))
                or bool(entry.get("is_approval_actionable"))
            )
        )
        can_decide = bool(entry.get("is_approval_actionable")) or bool(
            entry.get("is_cfo_review_actionable")
            and entry.get("status") == ItemStatus.on_review
        )
        if can_decide:
            return {
                "can_decide": True,
                "can_edit_amount": True,
                "can_edit_analytics": can_edit_analytics,
                "mode": "editable",
                "summary": "Можно изменить",
                "detail": "Вы можете согласовать строку, скорректировать сумму, заполнить аналитику или вернуть на доработку",
            }
        if entry.get("fixed"):
            detail = "Строка зафиксирована после финального согласования. Изменения недоступны."
            if last_decision and last_decision.get("by_name"):
                detail = f"{detail} Зафиксировал: {last_decision['by_name']}."
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": False,
                "mode": "locked",
                "summary": "Зафиксировано",
                "detail": detail,
            }
        if entry.get("frozen"):
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": False,
                "mode": "locked",
                "summary": "Заморожено",
                "detail": "Строка заморожена. Для изменения требуется явная разморозка.",
            }
        if entry.get("is_module_revision"):
            can_edit = bool(entry.get("is_revision_actionable"))
            return {
                "can_decide": False,
                "can_edit_amount": can_edit,
                "can_edit_analytics": can_edit,
                "mode": "editable" if can_edit else "readonly",
                "summary": "На доработке",
                "detail": (
                    "Исправьте возвращённую строку и повторно отправьте заявку"
                    if can_edit else "Строка возвращена ответственному модуля на доработку"
                ),
            }
        if entry.get("is_revision"):
            module_revision_editable = bool(entry.get("is_revision_actionable"))
            cfo_revision_editable = bool(entry.get("is_cfo_module_revision_actionable"))
            can_edit = module_revision_editable or cfo_revision_editable
            if can_edit:
                return {
                    "can_decide": False,
                    "can_edit_amount": True,
                    "can_edit_analytics": module_revision_editable,
                    "mode": "editable",
                    "summary": "На доработке",
                    "detail": "Исправьте возвращённую строку и повторно передайте позицию экономисту.",
                }
            owner_name = (current_owner or {}).get("by_name") or "не назначен"
            role_label = (current_owner or {}).get("role_label") or "ответственный"
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": False,
                "mode": "readonly",
                "summary": "На доработке",
                "detail": f"Строка возвращена на текущий этап. Сейчас ждёт {role_label}: {owner_name}.",
            }
        if entry.get("status") in APPROVED_ITEM_STATUSES or entry.get("status") == ItemStatus.rejected:
            parts: list[str] = []
            if last_decision and last_decision.get("by_name"):
                parts.append(f"Решение принял: {last_decision['by_name']}")
            if last_decision and last_decision.get("stage"):
                parts.append(f"Этап: {last_decision['stage']}")
            detail = ". ".join(parts) + "." if parts else "Решение уже принято. Изменения недоступны."
            if can_edit_analytics:
                detail = f"{detail} Поля аналитики можно заполнять."
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": can_edit_analytics,
                "mode": "readonly",
                "summary": "Решение принято",
                "detail": detail,
            }
        if entry.get("is_collecting") or entry.get("request_status") == "draft":
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": can_edit_analytics,
                "mode": "readonly",
                "summary": "Черновик",
                "detail": "Заявка не отправлена на проверку. Согласование станет доступно после отправки",
            }
        owner_name = (current_owner or {}).get("by_name") or "не назначен"
        role_label = (current_owner or {}).get("role_label") or "Ответственный"
        if entry.get("is_cfo_review"):
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": can_edit_analytics,
                "mode": "readonly",
                "summary": f"Ждёт: {owner_name}",
                "detail": f"Решение принимает {role_label}: {owner_name}. Поля аналитики можно заполнять",
            }
        if entry.get("is_in_approval"):
            stage = entry.get("approval_stage") or "согласование"
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": can_edit_analytics,
                "mode": "readonly",
                "summary": f"Ждёт: {owner_name}",
                "detail": (
                    f"Сейчас этап «{stage}». Решение у {role_label}: {owner_name}. "
                    "Поля аналитики можно заполнять"
                ),
            }
        return {
            "can_decide": False,
            "can_edit_amount": False,
            "can_edit_analytics": can_edit_analytics,
            "mode": "readonly",
            "summary": "Только просмотр",
            "detail": "Изменения для этой строки сейчас недоступны. Поля аналитики можно заполнять"
            if can_edit_analytics else "Изменения для этой строки сейчас недоступны",
        }

    def _register_status_context(
        self,
        *,
        user: dict,
        users: dict[str, dict],
        profiles: dict[str, dict],
        steps: dict[str, dict],
        position: dict | None,
        cfo_id: str | None,
        entry: dict,
        item_decisions: dict[str, dict],
        item_step_decisions: dict[str, dict[str, dict]],
        economist_decided_by_position: dict[str, set[str]],
    ) -> dict:
        last_decision = item_decisions.get(entry["id"])
        current_owner = self._register_current_owner(
            users=users,
            profiles=profiles,
            steps=steps,
            position=position,
            cfo_id=cfo_id,
            entry=entry,
        )
        editability = self._register_editability(
            entry=entry,
            last_decision=last_decision,
            current_owner=current_owner,
        )
        workflow_steps = self._register_workflow_step_displays(
            user=user,
            users=users,
            steps=steps,
            position=position,
            entry=entry,
            item_step_decisions=item_step_decisions,
            economist_decided_by_position=economist_decided_by_position,
        )
        return {
            "last_decision": last_decision,
            "current_owner": current_owner,
            "editability": editability,
            **workflow_steps,
        }

    # The register intentionally works from request lines, rather than CFO
    # positions.  Positions only exist after the CFO review, while authors
    # must also be able to see their draft and in-review lines.
    def _register_entries(
        self,
        user: dict,
        *,
        budget_year: int | None = None,
        cfo_id: str | None = None,
        category_id: str | None = None,
        article_id: str | None = None,
        module_id: str | None = None,
        request_id: str | None = None,
        status: str | None = None,
        request_status: str | None = None,
        frozen: str | None = None,
        search: str | None = None,
        mine_only: bool = False,
        analytics_1: str | None = None,
        analytics_2: str | None = None,
        analytics_3: str | None = None,
        analytics_4: str | None = None,
        analytics_5: str | None = None,
        item_ids: set[str] | list[str] | None = None,
        is_income: bool | None = None,
        positioned_only: bool = False,
        fixed_only: bool = False,
        module_ids: set[str] | None = None,
    ) -> list[dict]:
        allowed_item_ids = set(item_ids) if item_ids is not None else None
        request_statuses = (
            {part.strip() for part in str(request_status).split(",") if part.strip()}
            if request_status
            else None
        )
        analytics_filters = {
            field: "" if value == EMPTY_ANALYTICS_GROUP_VALUE else str(value or "").strip()
            for field, value in zip(
                ANALYTICS_FIELDS,
                (analytics_1, analytics_2, analytics_3, analytics_4, analytics_5),
            )
            if value == EMPTY_ANALYTICS_GROUP_VALUE or str(value or "").strip()
        }
        visible = self.permissions.visible_request_ids(user)
        requests = {item["id"]: item for item in self.repo.load_all("requests")}
        units = {item["id"]: item for item in self.repo.load_all("units")}
        users = {item["id"]: item for item in self.repo.load_all("users")}
        profiles = {item["user_id"]: item for item in self.repo.load_all("profiles")}
        positions = {item["id"]: item for item in self.repo.load_all("cfo_positions")}
        steps = {item["id"]: item for item in self.repo.load_all("steps")}
        item_decisions = self._build_register_item_decisions(users, profiles)
        item_step_decisions = self._build_register_item_step_decisions(users, profiles)
        economist_cfo_ids = (
            self.permissions.economist_cfo_ids(user["id"])
            if user.get("role") == "economist"
            else set()
        )
        employee_cfo_ids = (
            self.permissions.employee_cfo_ids(user["id"])
            if user.get("role") == "employee"
            else set()
        )
        request_pending_items: dict[str, int] = {}
        request_active_items: dict[str, int] = {}
        cfo_decisions_by_request: dict[str, dict[str, str]] = {}
        returned_by_request: dict[str, set[str]] = {}
        cfo_completed_requests: set[str] = set()
        for request_key in requests:
            cfo_decisions_by_request[request_key] = self._latest_cfo_decisions(request_key)
            returned_by_request[request_key] = self.returned_item_ids(request_key)
            if self.cfo_review_completed(request_key):
                cfo_completed_requests.add(request_key)
        for row in self.repo.load_all("req_items"):
            if row.get("status") == ItemStatus.deleted:
                continue
            request_key = row["request_id"]
            request_active_items[request_key] = request_active_items.get(request_key, 0) + 1
            if row["id"] not in cfo_decisions_by_request.get(request_key, {}):
                request_pending_items[request_key] = request_pending_items.get(request_key, 0) + 1
        completable_cfo_review_requests: set[str] = set()
        if user.get("role") == "employee" and employee_cfo_ids:
            for request in requests.values():
                if request.get("status") != RequestStatus.on_review:
                    continue
                if request["id"] in cfo_completed_requests or returned_by_request.get(request["id"]):
                    continue
                cfo_for_request = self.permissions.cfo_for_module(request["unit_id"])
                if cfo_for_request not in employee_cfo_ids:
                    continue
                request_key = request["id"]
                if request_active_items.get(request_key, 0) and request_pending_items.get(request_key, 0) == 0:
                    completable_cfo_review_requests.add(request_key)
        catalogs = {
            "dds": {item["id"]: item for item in self.repo.load_all("dds_catalog")},
            "invest": {item["id"]: item for item in self.repo.load_all("invests_catalog")},
        }
        file_counts: dict[str, int] = {}
        for link in self.repo.load_all("req_item_files"):
            file_counts[link.get("req_item_id")] = file_counts.get(link.get("req_item_id"), 0) + 1
        economist_decided_by_position: dict[str, set[str]] = {}
        latest_position_return: dict[str, tuple[tuple[str, int], set[str]]] = {}
        for row in self.repo.load_all("cfo_position_logs"):
            log = row.get("log") or {}
            position_id = row.get("cfo_position_id")
            if not position_id:
                continue
            if log.get("action") == "economist_item_decided":
                item_id = log.get("req_item_id")
                if item_id:
                    economist_decided_by_position.setdefault(position_id, set()).add(item_id)
                continue
            if log.get("action") == "position_returned":
                key = (str(row.get("created_at") or ""), int(row.get("id") or 0))
                previous = latest_position_return.get(position_id)
                if previous is None or key > previous[0]:
                    latest_position_return[position_id] = (
                        key,
                        {str(item_id) for item_id in log.get("item_ids") or []},
                    )
        revision_items_by_position = {
            position_id: item_ids
            for position_id, (_, item_ids) in latest_position_return.items()
            if positions.get(position_id, {}).get("status") == CfoPositionStatus.on_revision
        }
        position_items_cache: dict[str, list[dict]] = {}

        def position_items(position_id: str) -> list[dict]:
            if position_id not in position_items_cache:
                position_items_cache[position_id] = self._items_for_position(
                    self.repo, position_id
                )
            return position_items_cache[position_id]

        def can_act_on_position(position: dict | None, item: dict) -> bool:
            if not position or item.get("fixed"):
                return False
            step = steps.get(cfo_position_current_step_id(self.repo, position))
            if not step or step.get("unit_id"):
                return False
            actor = users.get(step.get("user_id"), {})
            if actor.get("role") == "economist":
                if item.get("frozen") or user.get("role") != "economist":
                    return False
                if position.get("cfo_unit_id") not in economist_cfo_ids or step.get("user_id") != user.get("id"):
                    return False
                returned_items = revision_items_by_position.get(position["id"], set())
                return (
                    item["id"] in returned_items
                    and position.get("status") == CfoPositionStatus.on_revision
                ) or item["id"] not in economist_decided_by_position.get(position["id"], set())
            # At the final step a ZGD can fix any frozen line separately.
            # The position itself remains at that step until all lines are fixed.
            return (
                actor.get("role") == "zgd"
                and user.get("role") == "zgd"
                and step.get("user_id") == user.get("id")
                and bool(item.get("frozen"))
            )

        def can_act_on_position_block(position: dict | None, item: dict | None = None) -> bool:
            if not position:
                return False
            # A shared CFO position may contain lines from several modules.
            # Once this particular line is fixed, it must not keep its module
            # aggregate in «Ваше решение» while sibling-module lines remain open.
            if item and item.get("fixed"):
                return False
            step = steps.get(cfo_position_current_step_id(self.repo, position))
            if not step or step.get("unit_id"):
                return False
            actor = users.get(step.get("user_id"), {})
            if step.get("user_id") != user.get("id"):
                return False
            items = position_items(position["id"])
            if not items or all(row.get("fixed") for row in items):
                return False
            if actor.get("role") == "economist":
                return (
                    user.get("role") == "economist"
                    and position.get("cfo_unit_id") in economist_cfo_ids
                )
            if actor.get("role") in {"approver", "zgd"}:
                if user.get("role") != actor.get("role"):
                    return False
                # After a higher step returns a position, the direct lower
                # reviewer receives its selected rows unfrozen.  They must be
                # able to pass that revision one more direct step down even
                # though approval itself remains unavailable until the rows
                # are frozen again.
                if position.get("status") == CfoPositionStatus.on_revision:
                    return any(not row.get("fixed") for row in items)
                return all(row.get("frozen") or row.get("fixed") for row in items)
            return False

        def can_submit_position(position: dict | None, item: dict | None = None) -> bool:
            if item and item.get("fixed"):
                return False
            step = steps.get(cfo_position_current_step_id(self.repo, position)) if position else None
            return bool(
                position
                and not all(row.get("fixed") for row in self._items_for_position(self.repo, position["id"]))
                and user.get("role") == "employee"
                and position.get("cfo_unit_id") in employee_cfo_ids
                and step
                and step.get("unit_id") == position.get("cfo_unit_id")
                and position.get("status") in {"waiting", "on_review", "on_revision"}
            )

        def can_complete_economist_position(position: dict | None) -> bool:
            if not position or user.get("role") != "economist":
                return False
            step = steps.get(cfo_position_current_step_id(self.repo, position))
            if not step or step.get("unit_id") or step.get("user_id") != user.get("id"):
                return False
            actor = users.get(step.get("user_id"), {})
            if actor.get("role") != "economist" or position.get("cfo_unit_id") not in economist_cfo_ids:
                return False
            items = position_items(position["id"])
            decided = economist_decided_by_position.get(position["id"], set())
            return bool(items) and all(
                item["id"] in decided and item.get("status") != ItemStatus.on_review
                for item in items
            )

        def approval_stage(position: dict | None, item: dict) -> str | None:
            if not position:
                return None
            step = steps.get(cfo_position_current_step_id(self.repo, position))
            if not step or item.get("fixed"):
                return None
            actor = users.get(step.get("user_id"), {})
            if actor.get("role") == "economist":
                return "Проверка экономистом ЦФО"
            if actor.get("role") == "zgd":
                return "Финальное согласование ЗГД"
            if step.get("unit_id"):
                return "Проверка ответственным ЦФО"
            return "Согласование проверяющим"

        needle = (search or "").strip().casefold()
        entries: list[dict] = []
        for item in self.repo.load_all("req_items"):
            if item.get("status") == ItemStatus.deleted:
                continue
            # Dashboard drill-downs are based on CFO-position lines only and
            # use the same non-rejected planned amount as the dashboard.
            if positioned_only and (
                not positions.get(item.get("cfo_position_id"))
                or item.get("status") == ItemStatus.rejected
            ):
                continue
            if is_income is not None and bool(item.get("is_income", False)) != is_income:
                continue
            if fixed_only and not item.get("fixed"):
                continue
            if allowed_item_ids is not None and item["id"] not in allowed_item_ids:
                continue
            request = requests.get(item.get("request_id"))
            if not request or (visible is not None and request["id"] not in visible):
                continue
            if request.get("status") == RequestStatus.cancelled:
                continue
            if mine_only and request_author_id(self.repo, request["id"]) != user.get("id"):
                continue
            module = units.get(request.get("unit_id"), {})
            current_cfo_id = self.permissions.cfo_for_module(request["unit_id"])
            cfo = units.get(current_cfo_id, {})
            kind = "dds" if item.get("dds_id") else "invest"
            category = catalogs[kind].get(item.get(f"{kind}_id"), {})
            article = catalogs[kind].get(category.get("parent_id"), {})
            position = positions.get(item.get("cfo_position_id"))
            position_step_id = (
                cfo_position_current_step_id(self.repo, position) if position else None
            )
            returned_item_ids = returned_by_request.get(request["id"], set())
            position_revision_item_ids = revision_items_by_position.get(
                position.get("id") if position else "", set()
            )
            is_module_revision = item["id"] in returned_item_ids
            is_revision = (
                is_module_revision
                or item["id"] in position_revision_item_ids
            )
            is_cfo_review = (
                request.get("status") == RequestStatus.on_review
                and request["id"] not in cfo_completed_requests
                and not returned_item_ids
            )
            entry = {
                "id": item["id"],
                "request_id": request["id"],
                "request_status": str(request.get("status") or "draft"),
                "budget_year": int(request.get("budget_year") or 0),
                "module_id": request["unit_id"],
                "module_name": module.get("name", "Модуль"),
                "cfo_id": current_cfo_id or "unassigned",
                "cfo_name": cfo.get("name", "ЦФО не указан"),
                "category_id": category.get("id") or item.get(f"{kind}_id") or "uncategorized",
                "category_name": category.get("name", "Без категории"),
                "article_id": article.get("id") or item.get(f"{kind}_id") or "uncategorized",
                "article_name": article.get("name", category.get("name", "Статья не указана")),
                "kind": kind,
                "name": item.get("name") or "Без наименования",
                "justification": item.get("justification") or "",
                "comment": item.get("comment") or "",
                **{field: str(item.get(field) or "").strip() for field in ANALYTICS_FIELDS},
                "files_count": file_counts.get(item["id"], 0),
                "requested_sum": float(item.get("sum_plan") or 0),
                # `sum_fact` is the amount selected at the current review
                # step.  CFO decisions intentionally keep the item status at
                # `on_review` until the economist acts, but the selected fact
                # (and its difference from the plan) must remain visible in
                # the register during that intermediate state.
                "approved_sum": float(item.get("sum_fact") or 0),
                "status": str(item.get("status") or ItemStatus.on_review),
                "updated_at": str(item.get("updated_at") or request.get("updated_at") or request.get("created_at") or ""),
                "is_collecting": request.get("status") == RequestStatus.draft,
                "is_cfo_review": is_cfo_review,
                "is_cfo_review_actionable": (
                    is_cfo_review
                    and item["id"] not in cfo_decisions_by_request.get(request["id"], {})
                    and user.get("role") == "employee"
                    and current_cfo_id in employee_cfo_ids
                ),
                "is_revision": is_revision,
                "is_module_revision": is_module_revision,
                "is_revision_actionable": (
                    item["id"] in returned_item_ids
                    and user.get("role") == "employee"
                    and request["unit_id"] in self.permissions.employee_module_ids(user["id"])
                    and not item.get("frozen")
                    and not item.get("fixed")
                ),
                "is_cfo_module_revision_actionable": (
                    item["id"] in position_revision_item_ids
                    and bool(position)
                    and position.get("status") == CfoPositionStatus.on_revision
                    and bool(position_step_id)
                    and steps.get(position_step_id, {}).get("unit_id") == current_cfo_id
                    and user.get("role") == "employee"
                    and current_cfo_id in employee_cfo_ids
                    and not item.get("frozen")
                    and not item.get("fixed")
                ),
                "is_cfo_review_completable": request["id"] in completable_cfo_review_requests,
                "position_id": position.get("id") if position else None,
                "current_step_id": position_step_id,
                "is_in_approval": bool(position and position_step_id and not item.get("fixed")),
                "is_approval_actionable": can_act_on_position(position, item),
                "is_final_approval_actionable": (
                    user.get("role") == "zgd" and can_act_on_position(position, item)
                ),
                "is_position_submission_actionable": can_submit_position(position, item),
                "is_economist_completion_actionable": can_complete_economist_position(position),
                "is_position_actionable": (
                    can_act_on_position(position, item)
                    or can_submit_position(position, item)
                    or can_act_on_position_block(position, item)
                ),
                "approval_stage": approval_stage(position, item),
                "frozen": bool(item.get("frozen")),
                "fixed": bool(item.get("fixed")),
            }
            entry["status_context"] = self._register_status_context(
                user=user,
                users=users,
                profiles=profiles,
                steps=steps,
                position=position,
                cfo_id=current_cfo_id,
                entry=entry,
                item_decisions=item_decisions,
                item_step_decisions=item_step_decisions,
                economist_decided_by_position=economist_decided_by_position,
            )
            if budget_year and entry["budget_year"] != budget_year:
                continue
            if cfo_id and entry["cfo_id"] != cfo_id:
                continue
            if category_id and entry["category_id"] != category_id:
                continue
            # Accept parent article id or leaf/category id from older dashboard links.
            if article_id and entry["article_id"] != article_id and entry["category_id"] != article_id:
                continue
            if module_id and entry["module_id"] != module_id:
                continue
            if module_ids is not None and entry["module_id"] not in module_ids:
                continue
            if request_id and entry["request_id"] != request_id:
                continue
            if status and entry["status"] != status:
                continue
            if request_statuses and entry["request_status"] not in request_statuses:
                continue
            if frozen == "frozen" and not entry["frozen"]:
                continue
            if frozen == "fixed" and not entry["fixed"]:
                continue
            if any((entry.get(field) or "").strip() != expected for field, expected in analytics_filters.items()):
                continue
            if needle and needle not in " ".join(str(entry[key]) for key in (
                "name", "article_name", "category_name", "module_name", "request_id",
                *ANALYTICS_FIELDS,
            )).casefold():
                continue
            entries.append(entry)
        return entries

    @staticmethod
    def _sort_register_entries(entries: list[dict]) -> list[dict]:
        return sorted(entries, key=lambda item: (item["updated_at"], item["id"]), reverse=True)

    @staticmethod
    def _register_pagination(total_items: int, page: int, page_size: int) -> dict:
        total_pages = max(1, (total_items + page_size - 1) // page_size)
        normalized_page = min(max(page, 1), total_pages)
        return {
            "page": normalized_page,
            "page_size": page_size,
            "total_items": total_items,
            "total_pages": total_pages,
            "has_next": normalized_page < total_pages,
            "has_previous": normalized_page > 1,
        }

    @staticmethod
    def _slice_register_page(entries: list[dict], page: int, page_size: int) -> list[dict]:
        start = (page - 1) * page_size
        return entries[start:start + page_size]

    @staticmethod
    def _register_aggregates(
        entries: list[dict],
        *,
        include_interim_facts: bool = True,
    ) -> dict:
        approved = sum(entry["status"] in {ItemStatus.approved, ItemStatus.approved_with_changes} for entry in entries)
        rejected = sum(entry["status"] == ItemStatus.rejected for entry in entries)
        revision = sum(bool(entry.get("is_revision")) for entry in entries)
        pending = len(entries) - approved - rejected
        if not entries:
            aggregate_status = "no_data"
        elif approved == len(entries):
            aggregate_status = "approved"
        elif rejected == len(entries):
            aggregate_status = "rejected"
        elif not pending:
            aggregate_status = "partially_approved"
        elif not approved and not rejected:
            aggregate_status = "on_review"
        else:
            aggregate_status = "in_progress"
        requested = sum(entry["requested_sum"] for entry in entries)
        approved_sum = sum(
            entry["approved_sum"]
            for entry in entries
            if include_interim_facts
            or entry["status"] in {ItemStatus.approved, ItemStatus.approved_with_changes}
        )
        rejected_sum = sum(
            entry["requested_sum"] for entry in entries
            if entry["status"] == ItemStatus.rejected
        )
        pending_sum = sum(
            entry["requested_sum"] for entry in entries
            if entry["status"] not in {ItemStatus.approved, ItemStatus.approved_with_changes, ItemStatus.rejected}
        )
        collecting_requests = {
            entry["request_id"] for entry in entries if entry.get("is_collecting")
        }
        cfo_review_requests = {
            entry["request_id"] for entry in entries if entry.get("is_cfo_review")
        }
        cfo_review_actionable_requests = {
            entry["request_id"]
            for entry in entries
            if entry.get("is_cfo_review_actionable")
        }
        cfo_review_completable_requests = {
            entry["request_id"]
            for entry in entries
            if entry.get("is_cfo_review_completable")
        }
        positions_in_approval = {
            entry["position_id"]
            for entry in entries
            if entry.get("is_in_approval") and entry.get("position_id")
        }
        actionable_positions = {
            entry["position_id"]
            for entry in entries
            if entry.get("is_position_actionable") and entry.get("position_id")
        }
        submission_positions = {
            entry["position_id"]
            for entry in entries
            if entry.get("is_position_submission_actionable") and entry.get("position_id")
        }
        economist_completion_positions = {
            entry["position_id"]
            for entry in entries
            if entry.get("is_economist_completion_actionable") and entry.get("position_id")
        }
        return {
            "requested_sum": requested,
            "approved_sum": approved_sum,
            "rejected_sum": rejected_sum,
            "pending_sum": pending_sum,
            "difference": approved_sum - requested,
            "total_rows": len(entries),
            "approved_rows": approved,
            "rejected_rows": rejected,
            "revision_rows": revision,
            "pending_rows": pending,
            "requests_count": len({entry["request_id"] for entry in entries}),
            "modules_count": len({entry["module_id"] for entry in entries}),
            "aggregate_status": aggregate_status,
            "collecting_requests": len(collecting_requests),
            "cfo_review_requests": len(cfo_review_requests),
            "cfo_review_actionable_requests": len(cfo_review_actionable_requests),
            "cfo_review_completable_requests": len(cfo_review_completable_requests),
            "in_approval_positions": len(positions_in_approval),
            "actionable_positions": len(actionable_positions),
            "submission_positions": len(submission_positions),
            "economist_completion_positions": len(economist_completion_positions),
        }

    def _register_analytics_summary(
        self,
        entries: list[dict],
        *,
        include_interim_facts: bool = True,
    ) -> list[dict]:
        """Aggregate populated analytics after all register filters are applied."""
        result: list[dict] = []
        for field in ANALYTICS_FIELDS:
            values: dict[str, list[dict]] = {}
            for entry in entries:
                value = str(entry.get(field) or "").strip()
                if value:
                    values.setdefault(value, []).append(entry)
            if not values:
                continue

            rows = []
            for value, value_entries in values.items():
                cfo_loads: dict[str, dict] = {}
                for entry in value_entries:
                    cfo_id = entry["cfo_id"]
                    load = cfo_loads.setdefault(cfo_id, {
                        "cfo_id": cfo_id,
                        "cfo_name": entry["cfo_name"],
                        "requested_sum": 0.0,
                        "total_rows": 0,
                    })
                    load["requested_sum"] += entry["requested_sum"]
                    load["total_rows"] += 1
                top_cfo = max(
                    cfo_loads.values(),
                    key=lambda item: (item["requested_sum"], item["total_rows"], item["cfo_name"].casefold()),
                )
                rows.append({
                    "value": value,
                    "aggregates": self._register_aggregates(
                        value_entries,
                        include_interim_facts=include_interim_facts,
                    ),
                    "top_cfo": top_cfo,
                })
            result.append({
                "field": field,
                "label": f"Аналитика {field[-1]}",
                "values": sorted(
                    rows,
                    key=lambda item: (-item["aggregates"]["requested_sum"], item["value"].casefold()),
                ),
            })
        return result

    def approval_register(self, user: dict, view: str = "cfo", group_by: list[str] | None = None, **filters) -> dict:
        if view not in DEFAULT_REGISTER_GROUPS:
            raise HTTPException(status_code=422, detail="Неизвестное представление реестра")
        levels = tuple(group_by or DEFAULT_REGISTER_GROUPS[view])
        if not levels or len(levels) != len(set(levels)) or any(level not in REGISTER_GROUP_LEVELS for level in levels):
            raise HTTPException(status_code=422, detail="Укажите уникальные допустимые уровни группировки")

        entries = self._sort_register_entries(self._register_entries(user, **filters))
        include_interim_facts = not bool(filters.get("positioned_only"))
        labels = {
            "cfo": "ЦФО", "category": "Категория", "article": "Статья / инвестпроект",
            "module": "Модуль", "request": "Заявка",
            **{field: f"Аналитика {field[-1]}" for field in ANALYTICS_FIELDS},
        }
        roots: dict[str, dict] = {}
        for entry in entries:
            branch = roots
            parent_key = ""
            parent_scope: dict[str, str] = {}
            for level in levels:
                is_analytics = level in ANALYTICS_FIELDS
                value = (
                    str(entry.get(level) or "").strip()
                    if is_analytics
                    else entry["request_id"] if level == "request" else entry[f"{level}_id"]
                )
                key = f"{parent_key}/{level}:{quote(value or '__empty__', safe='')}"
                scope_key = (
                    level if is_analytics
                    else "request_id" if level == "request"
                    else f"{level}_id"
                )
                scope = {**parent_scope, scope_key: value}
                node = branch.setdefault(key, {
                    "id": key,
                    "type": level,
                    "group_value": value if is_analytics else None,
                    "name": (
                        "Не заполнено" if is_analytics and not value
                        else value if is_analytics
                        else f"Заявка №{entry['request_id'][:8]}" if level == "request"
                        else entry[f"{level}_name"]
                    ),
                    "module_id": entry["module_id"],
                    "article_id": entry["article_id"],
                    "category_id": entry["category_id"],
                    "scope": scope,
                    "request_ids": set(),
                    "entries": [],
                    "children": {},
                })
                node["entries"].append(entry)
                node["request_ids"].add(entry["request_id"])
                branch = node["children"]
                parent_key = key
                parent_scope = scope

        def serialize(nodes: dict[str, dict]) -> list[dict]:
            result = []
            for node in sorted(nodes.values(), key=lambda item: (item["name"].casefold(), item["id"])):
                children = serialize(node["children"])
                can_load_rows = node["type"] == "category" if levels == DEFAULT_REGISTER_GROUPS["cfo"] else not children
                payload = {
                    "id": node["id"], "type": node["type"], "name": node["name"],
                    "group_value": node["group_value"],
                    "module_id": node["module_id"], "article_id": node["article_id"],
                    "category_id": node["category_id"], "scope": node["scope"],
                    "request_ids": sorted(node["request_ids"]),
                    "aggregates": self._register_aggregates(
                        node["entries"],
                        include_interim_facts=include_interim_facts,
                    ),
                    "children": children,
                    "can_load_rows": can_load_rows,
                    "label": labels[node["type"]],
                }
                if node["type"] in {"article", "category"}:
                    payload["analytics"] = self._register_group_analytics(node["entries"])
                result.append(payload)
            return result

        return {
            "view": view,
            "group_by": list(levels),
            "groups": serialize(roots),
            "aggregates": self._register_aggregates(
                entries,
                include_interim_facts=include_interim_facts,
            ),
            "analytics_summary": self._register_analytics_summary(
                entries,
                include_interim_facts=include_interim_facts,
            ),
            "summary_items": entries,
        }

    @staticmethod
    def _register_group_analytics(entries: list[dict]) -> dict:
        fields: dict[str, dict] = {}
        for field in ANALYTICS_FIELDS:
            values = {str(entry.get(field) or "").strip() for entry in entries}
            values.discard("")
            if not values:
                fields[field] = {"value": "", "mixed": False}
            elif len(values) == 1:
                fields[field] = {"value": next(iter(values)), "mixed": False}
            else:
                fields[field] = {"value": "", "mixed": True}
        return {
            "can_edit": any(
                entry.get("status") != ItemStatus.deleted and not entry.get("fixed")
                for entry in entries
            ),
            "fields": fields,
        }

    def approval_register_group_analytics_item_ids(
        self,
        user: dict,
        group_type: str,
        group_id: str,
        **filters,
    ) -> list[str]:
        if group_type not in {"article", "category"}:
            raise HTTPException(
                status_code=422,
                detail="Групповая аналитика доступна только для статьи и категории",
            )
        field = f"{group_type}_id"
        item_ids = [
            entry["id"]
            for entry in self._register_entries(user, **filters)
            if entry[field] == group_id
            and entry.get("status") != ItemStatus.deleted
            and not entry.get("fixed")
        ]
        if not item_ids:
            raise HTTPException(status_code=409, detail="Нет строк для обновления аналитики")
        return item_ids

    def approval_register_group_item_ids(
        self,
        user: dict,
        group_type: str,
        group_id: str,
        **filters,
    ) -> list[str]:
        field_by_group_type = {
            "cfo": "cfo_id",
            "article": "article_id",
            "category": "category_id",
            "module": "module_id",
            "request": "request_id",
        }
        field = field_by_group_type.get(group_type)
        if not field:
            raise HTTPException(status_code=422, detail="Неизвестный уровень реестра")
        item_ids = [
            entry["id"]
            for entry in self._register_entries(user, **filters)
            if entry[field] == group_id and entry["is_cfo_review_actionable"]
        ]
        if not item_ids:
            raise HTTPException(status_code=409, detail="В выбранной группе нет строк, доступных для решения")
        return item_ids

    def approval_register_group_cfo_revision_item_ids(
        self,
        user: dict,
        group_type: str,
        group_id: str,
        **filters,
    ) -> list[str]:
        """Return visible lines that may be selected for a CFO review return.

        A return may intentionally invalidate a decision already made in the
        current, not-yet-completed CFO cycle, so this scope is wider than the
        set of undecided/actionable lines used by bulk decisions.
        """
        field_by_group_type = {
            "cfo": "cfo_id",
            "article": "article_id",
            "category": "category_id",
            "module": "module_id",
            "request": "request_id",
        }
        field = field_by_group_type.get(group_type)
        if not field:
            raise HTTPException(status_code=422, detail="Неизвестный уровень реестра")
        item_ids = [
            entry["id"]
            for entry in self._register_entries(user, **filters)
            if entry[field] == group_id
            and (
                entry.get("is_cfo_review")
                or entry.get("is_cfo_module_revision_actionable")
            )
            and not entry.get("frozen")
            and not entry.get("fixed")
            and entry.get("status") != ItemStatus.deleted
        ]
        if not item_ids:
            raise HTTPException(
                status_code=409,
                detail="В выбранной группе нет строк, доступных для возврата на доработку",
            )
        return item_ids

    def approval_register_group_position_ids(
        self,
        user: dict,
        group_type: str,
        group_id: str,
        **filters,
    ) -> list[str]:
        """Return the actionable article positions represented by a register group.

        The register is line based, whereas the route is position based.  This
        bridge deliberately derives positions from the same visible entries as
        the UI, so a reviewer cannot act on a hidden CFO/article.
        """
        field_by_group_type = {
            "cfo": "cfo_id",
            "article": "article_id",
            "category": "category_id",
            "module": "module_id",
            "request": "request_id",
        }
        field = field_by_group_type.get(group_type)
        if not field:
            raise HTTPException(
                status_code=422,
                detail="Неизвестный уровень реестра для группового согласования",
            )
        position_ids = {
            entry["position_id"]
            for entry in self._register_entries(user, **filters)
            if entry[field] == group_id
            and entry.get("position_id")
            and entry.get("is_position_actionable")
        }
        if not position_ids:
            raise HTTPException(
                status_code=409,
                detail="В выбранной группе нет позиций, доступных для согласования",
            )
        return sorted(position_ids)

    def approval_register_group_actionable_rows(
        self,
        user: dict,
        group_type: str,
        group_id: str,
        **filters,
    ) -> dict:
        field_by_group_type = {
            "cfo": "cfo_id",
            "article": "article_id",
            "category": "category_id",
            "module": "module_id",
            "request": "request_id",
        }
        field = field_by_group_type.get(group_type)
        if not field:
            raise HTTPException(status_code=422, detail="Неизвестный уровень реестра")
        lines = [
            entry for entry in self._sort_register_entries(self._register_entries(user, **filters))
            if entry[field] == group_id
            and (entry.get("is_cfo_review_actionable") or entry.get("is_approval_actionable"))
        ]
        return {"lines": lines}

    def approval_register_group_revision_lines(
        self,
        user: dict,
        group_type: str,
        group_id: str,
        *,
        mode: str | None = None,
        **filters,
    ) -> dict:
        """Return lines available for partial revision in a register group."""
        field_by_group_type = {
            "cfo": "cfo_id",
            "article": "article_id",
            "category": "category_id",
            "module": "module_id",
            "request": "request_id",
        }
        field = field_by_group_type.get(group_type)
        if not field:
            raise HTTPException(status_code=422, detail="Неизвестный уровень реестра")
        entries = [
            entry for entry in self._sort_register_entries(self._register_entries(user, **filters))
            if entry[field] == group_id
        ]
        cfo_lines = [
            entry for entry in entries
            if (
                entry.get("is_cfo_review")
                or entry.get("is_cfo_module_revision_actionable")
            )
            and not entry.get("frozen")
            and not entry.get("fixed")
            and entry.get("status") != ItemStatus.deleted
        ]
        workflow_lines = [
            entry for entry in entries
            # Approvers and ZGD act on a position as a block, so their
            # individual rows deliberately do not carry
            # ``is_approval_actionable``.  They still must be able to select
            # the frozen, non-final rows which are to be returned for
            # revision from that actionable position.
            if entry.get("is_position_actionable")
            and not entry.get("fixed")
            and entry.get("status") != ItemStatus.deleted
            and (entry.get("frozen") or entry.get("is_revision"))
        ]
        if mode == "cfo":
            lines = cfo_lines
        elif mode == "workflow":
            lines = workflow_lines
        else:
            lines = cfo_lines or workflow_lines
        resolved_mode = "cfo" if mode == "cfo" or (not mode and cfo_lines and not workflow_lines) else (
            "workflow" if workflow_lines else "cfo"
        )
        if mode == "cfo" and not lines:
            raise HTTPException(status_code=409, detail="В выбранной группе нет строк, доступных для возврата на доработку")
        if mode == "workflow" and not lines:
            raise HTTPException(status_code=409, detail="В выбранной группе нет строк, доступных для возврата на доработку")
        group_name = next(
            (
                entry["article_name"] if group_type == "article"
                else entry["category_name"] if group_type == "category"
                else entry["module_name"] if group_type == "module"
                else entry["cfo_name"]
                for entry in entries
            ),
            group_id,
        )
        return {
            "group_type": group_type,
            "group_id": group_id,
            "group_name": group_name,
            "mode": resolved_mode,
            "lines": lines,
        }

    def approval_register_analytics_filters(self, user: dict, **filters) -> dict[str, list[str]]:
        scoped_filters = {
            key: value
            for key, value in filters.items()
            if key not in ANALYTICS_FIELDS
        }
        entries = self._register_entries(user, **scoped_filters)
        result: dict[str, list[str]] = {}
        for field in ANALYTICS_FIELDS:
            values = sorted(
                {
                    str(entry.get(field) or "").strip()
                    for entry in entries
                    if str(entry.get(field) or "").strip()
                },
                key=str.casefold,
            )
            if values:
                result[field] = values
        return result

    def approval_register_rows(
        self,
        user: dict,
        page: int = 1,
        page_size: int = 50,
        *,
        request_id: str | None = None,
        **filters,
    ) -> dict:
        if page < 1:
            raise HTTPException(status_code=422, detail="Номер страницы должен быть не меньше 1")
        if page_size not in {1, 10, 25, 50, 100, 200}:
            raise HTTPException(
                status_code=422,
                detail="Допустимый размер страницы: 1, 10, 25, 50, 100 или 200",
            )
        scope_keys = ("module_id", "article_id", "category_id", "cfo_id", "request_id", *ANALYTICS_FIELDS)
        if request_id:
            filters = {**filters, "request_id": request_id}
        if not any(filters.get(key) for key in scope_keys):
            raise HTTPException(
                status_code=422,
                detail="Укажите область строк: module_id, article_id, category_id, cfo_id или request_id",
            )
        entries = self._sort_register_entries(self._register_entries(user, **filters))
        include_interim_facts = not bool(filters.get("positioned_only"))
        total_items = len(entries)
        pagination = self._register_pagination(total_items, page, page_size)
        items = self._slice_register_page(entries, pagination["page"], page_size)
        group_meta = {
            key: filters.get(key)
            for key in ("module_id", "article_id", "category_id", "cfo_id", "request_id", *ANALYTICS_FIELDS)
            if filters.get(key)
        }
        return {
            "items": items,
            "group": {
                **group_meta,
                "aggregates": self._register_aggregates(
                    entries,
                    include_interim_facts=include_interim_facts,
                ),
            },
            "pagination": pagination,
        }

    # Removed request-level workflow endpoints.
    def _gone(self, *_args, **_kwargs):
        raise HTTPException(
            status_code=410,
            detail="Дальнейшее согласование выполняется через позиции ЦФО",
        )

    withdraw = _gone
    start_review = _gone
    finalize = _gone
    fix = _gone
    reopen = _gone
    unfreeze = _gone
    freeze_budget = _gone
    unfreeze_budget = _gone
    approve_all_items = _gone
