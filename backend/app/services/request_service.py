from __future__ import annotations

from datetime import date
from uuid import uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from app.models import APPROVED_ITEM_STATUSES, ItemStatus, RequestStatus
from app.repositories.base import Repository
from app.services.common import cfo_position_current_step_id, get_required, request_author_id
from app.services.permission_service import PermissionService


ANALYTICS_FIELDS = tuple(f"analytics_{index}" for index in range(1, 6))


class RequestService:
    def __init__(self, repo: Repository, permissions: PermissionService):
        self.repo = repo
        self.permissions = permissions
        self.notifications = None

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

    def public_request(self, request: dict, summary: dict | None = None) -> dict:
        summary = summary or self.summary(request["id"])
        cfo_id = self.permissions.cfo_for_module(request["unit_id"])
        actions: list[str] = []
        if request.get("status") == RequestStatus.draft:
            actions.extend(["edit", "submit", "cancel"])
        elif request.get("status") == RequestStatus.cancelled:
            actions.append("restore")
        elif request.get("status") == RequestStatus.on_review:
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
            result.append(self.public_request(request))
        return sorted(result, key=lambda item: str(item.get("created_at") or ""), reverse=True)

    def get_request(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_view_request(user, request)
        return self.public_request(request)

    def list_cfo_incoming(self, user: dict) -> list[dict]:
        cfo_ids = self.permissions.employee_cfo_ids(user["id"])
        if user.get("role") != "employee" or not cfo_ids:
            return []
        module_ids = self.permissions.modules_for_cfos(cfo_ids)
        return [
            self.public_request(request)
            for request in self.repo.load_all("requests")
            if request.get("unit_id") in module_ids
            and request.get("status") == RequestStatus.on_review
        ]

    @staticmethod
    def _items_for_position(repo: Repository, position_id: str) -> list[dict]:
        return [
            row for row in repo.load_all("req_items")
            if row.get("cfo_position_id") == position_id and row.get("status") != ItemStatus.deleted
        ]

    def create_request(self, user: dict, payload: dict) -> dict:
        unit_id = payload["unit_id"]
        self.permissions.require_employee_unit_access(user, unit_id)
        budget_year = date.today().year
        existing = next(
            (
                request
                for request in self.repo.load_all("requests")
                if request.get("unit_id") == unit_id
                and int(request.get("budget_year") or 0) == budget_year
            ),
            None,
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "Для модуля уже существует заявка текущего года",
                    "request_id": existing["id"],
                },
            )
        created = self.repo.create(
            "requests",
            {
                "unit_id": unit_id,
                "budget_year": budget_year,
                "status": RequestStatus.draft,
            },
        )
        self.log(user, created["id"], "request_created", after=created)
        return self.public_request(created)

    def delete_request(self, user: dict, request_id: str) -> None:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_request_delete_request(user, request)
        self.repo.delete("requests", request_id)

    def patch_request(self, user: dict, request_id: str, patch: dict) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_employee_edit_request(user, request)
        if patch:
            raise HTTPException(status_code=400, detail="У заявки нет свободно редактируемых полей")
        return self.public_request(request)

    def submit(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
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
        event_id = str(uuid4())
        with self.repo.transaction() as repo:
            locked = repo.lock_by_id("requests", request_id)
            if not locked or locked.get("status") != RequestStatus.draft:
                raise HTTPException(status_code=409, detail="Заявка уже была отправлена")
            updated = repo.update("requests", request_id, {"status": RequestStatus.on_review})
            self.log(
                user,
                request_id,
                "request_submitted_to_cfo",
                before=locked,
                after=updated,
                event_id=event_id,
                stage="cfo_review",
                cfo_unit_id=cfo_id,
                repo=repo,
            )
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
        result = self.public_request(updated)
        result["notification_user_ids"] = [responsible_id]
        return result

    def cancel(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_employee_cancel_request(user, request)
        updated = self.repo.update("requests", request_id, {"status": RequestStatus.cancelled})
        self.log(user, request_id, "request_cancelled", before=request, after=updated)
        return self.public_request(updated)

    def restore(self, user: dict, request_id: str) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_employee_unit_access(user, request["unit_id"])
        if request.get("status") != RequestStatus.cancelled:
            raise HTTPException(status_code=409, detail="Восстановить можно только отмененную заявку")
        updated = self.repo.update("requests", request_id, {"status": RequestStatus.draft})
        self.log(user, request_id, "request_restored", before=request, after=updated)
        return self.public_request(updated)

    @staticmethod
    def _position_key(cfo_id: str, request: dict, item: dict) -> tuple:
        return (
            int(request["budget_year"]),
            cfo_id,
            item.get("dds_id"),
            item.get("invest_id"),
        )

    def complete_cfo_review(self, user: dict, request_id: str) -> dict:
        with self.repo.transaction() as repo:
            request = repo.lock_by_id("requests", request_id)
            if not request:
                raise HTTPException(status_code=404, detail="Заявка не найдена")
            self.permissions.require_cfo_request_access(user, request)
            if request.get("status") != RequestStatus.on_review:
                raise HTTPException(status_code=409, detail="Заявка не находится на проверке ЦФО")
            items = self._items(request_id, repo=repo)
            if not items:
                raise HTTPException(status_code=409, detail="У заявки нет активных строк")
            pending = [item["id"] for item in items if item.get("status") == ItemStatus.on_review]
            if pending:
                raise HTTPException(
                    status_code=409,
                    detail={"message": "Не все строки рассмотрены", "item_ids": pending},
                )
            accepted = [item for item in items if item.get("status") in APPROVED_ITEM_STATUSES]
            cfo_id = self.permissions.cfo_for_module(request["unit_id"])
            if not cfo_id:
                raise HTTPException(status_code=409, detail="Для модуля не определен ЦФО")
            event_id = str(uuid4())
            positions = repo.load_all("cfo_positions")
            by_key = {
                (
                    int(item["budget_year"]),
                    item["cfo_unit_id"],
                    item.get("dds_id"),
                    item.get("invest_id"),
                ): item
                for item in positions
            }
            affected: list[str] = []
            late_position_ids: list[str] = []
            for item in accepted:
                key = self._position_key(cfo_id, request, item)
                position = by_key.get(key)
                position_items = self._items_for_position(repo, position["id"]) if position else []
                if position and any(row.get("frozen") or row.get("fixed") for row in position_items):
                    raise HTTPException(
                        status_code=409,
                        detail="Нельзя дополнить замороженную или зафиксированную позицию",
                    )
                if not position:
                    position = repo.create(
                        "cfo_positions",
                        {
                            "budget_year": request["budget_year"],
                            "cfo_unit_id": cfo_id,
                            "dds_id": item.get("dds_id"),
                            "invest_id": item.get("invest_id"),
                            "status": "waiting",
                            "current_step_id": None,
                        },
                    )
                    by_key[key] = position
                elif cfo_position_current_step_id(repo, position) and not all(row.get("frozen") for row in position_items):
                    late_position_ids.append(position["id"])
                    if position.get("status") == "approved":
                        position = repo.update(
                            "cfo_positions",
                            position["id"],
                            {"status": "on_approval"},
                        )
                        by_key[key] = position
                linked = repo.update(
                    "req_items",
                    item["id"],
                    {"cfo_position_id": position["id"]},
                )
                repo.create(
                    "cfo_position_logs",
                    {
                        "cfo_position_id": position["id"],
                        "user_id": user["id"],
                        "step_id": cfo_position_current_step_id(repo, position),
                        "log": jsonable_encoder(
                            {
                                "event_id": event_id,
                                "action": "position_item_linked",
                                "stage": "cfo_review",
                                "entity": "req_item",
                                "entity_id": item["id"],
                                "request_id": request_id,
                                "req_item_id": item["id"],
                                "cfo_position_id": position["id"],
                                "step_id": cfo_position_current_step_id(repo, position),
                                "changes": {
                                    "cfo_position_id": {
                                        "from": item.get("cfo_position_id"),
                                        "to": linked.get("cfo_position_id"),
                                    }
                                },
                                "comment": None,
                            }
                        ),
                    },
                )
                affected.append(position["id"])
            next_status = RequestStatus.approved if accepted else RequestStatus.rejected
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
                cfo_position_ids=sorted(set(affected)),
                accepted_item_ids=[item["id"] for item in accepted],
                rejected_item_ids=[
                    item["id"] for item in items if item.get("status") == ItemStatus.rejected
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
                economist_id = self.permissions.cfo_economist_id(cfo_id)
                if economist_id:
                    for position_id in sorted(set(late_position_ids)):
                        self.notifications.create(
                            economist_id,
                            "cfo_position.items_changed",
                            {
                                "cfo_position_id": position_id,
                                "request_id": request_id,
                                "reload_required": True,
                            },
                            repo=repo,
                        )
        return {
            **self.public_request(updated),
            "affected_cfo_position_ids": sorted(set(affected)),
            "notification_user_ids": [
                user_id
                for user_id in {
                    author_id,
                    *(
                        [self.permissions.cfo_economist_id(cfo_id)]
                        if late_position_ids and self.permissions.cfo_economist_id(cfo_id)
                        else []
                    ),
                }
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
            and item.get("status") in APPROVED_ITEM_STATUSES
            and (is_income is None or bool(item.get("is_income", False)) == is_income)
        ]
        return (
            sum(float(item.get("sum_plan") or 0) for item in items),
            sum(float(item.get("sum_fact") or 0) for item in items),
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
                    "name": units.get(position["cfo_unit_id"], {}).get("name", "ЦФО"),
                    "kind": "cfo",
                    "planned": planned,
                    "approved": approved,
                    "items_count": count,
                }
            )
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
                "requests_count": len(
                    {
                        item["request_id"]
                        for item in self.repo.load_all("req_items")
                        if item.get("cfo_position_id") in {position["id"] for position in positions}
                    }
                ),
                "approved_requests_count": 0,
                "review_requests_count": 0,
                "frozen_requests_count": len({
                    item.get("request_id") for item in self.repo.load_all("req_items")
                    if item.get("cfo_position_id") in {position["id"] for position in positions} and item.get("frozen")
                }),
            },
            "by_unit": rows,
            "by_category": [],
            "by_article": [],
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
        if not separator:
            return []
        result: list[dict] = []
        units = {item["id"]: item for item in self.repo.load_all("units")}
        for position in self._visible_positions(user, is_income=is_income):
            if unit_id and position.get("cfo_unit_id") != unit_id:
                continue
            if position.get(f"{kind}_id") != article_id:
                continue
            planned, approved, count = self._position_sum(position["id"], is_income=is_income)
            result.append(
                {
                    "id": position["cfo_unit_id"],
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
            article_id = position.get("dds_id") or position.get("invest_id")
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
                    "name": catalogs[kind].get(article_id, {}).get("name", article_id),
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
                economist_id = self.permissions.cfo_economist_id(step["unit_id"])
                return {
                    "by_id": economist_id,
                    "by_name": self._register_user_display_name(users, profiles, economist_id),
                    "role_label": "Экономист ЦФО",
                }
            assignee_id = step.get("user_id")
            actor = users.get(assignee_id) or {}
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
            and not entry.get("fixed")
        )
        can_decide = bool(
            entry.get("status") == ItemStatus.on_review
            and (entry.get("is_cfo_review_actionable") or entry.get("is_approval_actionable"))
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
        if entry.get("frozen") and entry.get("status") == ItemStatus.rejected:
            return {
                "can_decide": False,
                "can_edit_amount": False,
                "can_edit_analytics": can_edit_analytics,
                "mode": "readonly",
                "summary": "На доработке у автора",
                "detail": "Строка возвращена на доработку и заморожена до исправлений автором заявки. Поля аналитики можно заполнять",
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
        users: dict[str, dict],
        profiles: dict[str, dict],
        steps: dict[str, dict],
        position: dict | None,
        cfo_id: str | None,
        entry: dict,
        item_decisions: dict[str, dict],
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
        return {
            "last_decision": last_decision,
            "current_owner": current_owner,
            "editability": editability,
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
        search: str | None = None,
        mine_only: bool = False,
        analytics_1: str | None = None,
        analytics_2: str | None = None,
        analytics_3: str | None = None,
        analytics_4: str | None = None,
        analytics_5: str | None = None,
    ) -> list[dict]:
        analytics_filters = {
            field: str(value or "").strip()
            for field, value in zip(
                ANALYTICS_FIELDS,
                (analytics_1, analytics_2, analytics_3, analytics_4, analytics_5),
            )
            if str(value or "").strip()
        }
        visible = self.permissions.visible_request_ids(user)
        requests = {item["id"]: item for item in self.repo.load_all("requests")}
        units = {item["id"]: item for item in self.repo.load_all("units")}
        users = {item["id"]: item for item in self.repo.load_all("users")}
        profiles = {item["user_id"]: item for item in self.repo.load_all("profiles")}
        positions = {item["id"]: item for item in self.repo.load_all("cfo_positions")}
        steps = {item["id"]: item for item in self.repo.load_all("steps")}
        item_decisions = self._build_register_item_decisions(users, profiles)
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
        catalogs = {
            "dds": {item["id"]: item for item in self.repo.load_all("dds_catalog")},
            "invest": {item["id"]: item for item in self.repo.load_all("invests_catalog")},
        }
        file_counts: dict[str, int] = {}
        for link in self.repo.load_all("req_item_files"):
            file_counts[link.get("req_item_id")] = file_counts.get(link.get("req_item_id"), 0) + 1

        def can_act_on_position(position: dict | None, item: dict) -> bool:
            if not position or item.get("fixed"):
                return False
            if item.get("status") != ItemStatus.on_review:
                return False
            step = steps.get(cfo_position_current_step_id(self.repo, position))
            if not step:
                return False
            if step.get("unit_id"):
                return (
                    user.get("role") == "economist"
                    and step["unit_id"] in economist_cfo_ids
                )
            return step.get("user_id") == user.get("id")

        def can_submit_position(position: dict | None) -> bool:
            return bool(
                position
                and not all(row.get("fixed") for row in self._items_for_position(self.repo, position["id"]))
                and user.get("role") == "employee"
                and position.get("cfo_unit_id") in employee_cfo_ids
                and position.get("status") in {"waiting", "on_revision"}
            )

        def approval_stage(position: dict | None, item: dict) -> str | None:
            if not position:
                return None
            step = steps.get(cfo_position_current_step_id(self.repo, position))
            if not step or item.get("fixed"):
                return None
            if step.get("unit_id"):
                return "Проверка экономистом ЦФО"
            actor = users.get(step.get("user_id"), {})
            if actor.get("role") == "zgd":
                return "Финальное согласование ЗГД"
            return "Согласование проверяющим"

        needle = (search or "").strip().casefold()
        entries: list[dict] = []
        for item in self.repo.load_all("req_items"):
            if item.get("status") == ItemStatus.deleted:
                continue
            request = requests.get(item.get("request_id"))
            if not request or (visible is not None and request["id"] not in visible):
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
            is_cfo_review = request.get("status") == RequestStatus.on_review
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
                "approved_sum": float(item.get("sum_fact") or 0) if item.get("status") in APPROVED_ITEM_STATUSES else 0,
                "status": str(item.get("status") or ItemStatus.on_review),
                "updated_at": str(item.get("updated_at") or request.get("updated_at") or request.get("created_at") or ""),
                "is_collecting": request.get("status") == RequestStatus.draft,
                "is_cfo_review": is_cfo_review,
                "is_cfo_review_actionable": (
                    is_cfo_review
                    and item.get("status") == ItemStatus.on_review
                    and user.get("role") == "employee"
                    and current_cfo_id in employee_cfo_ids
                ),
                "position_id": position.get("id") if position else None,
                "is_in_approval": bool(position and position_step_id and not item.get("fixed")),
                "is_approval_actionable": can_act_on_position(position, item),
                "is_position_submission_actionable": can_submit_position(position),
                "is_position_actionable": (
                    can_act_on_position(position, item) or can_submit_position(position)
                ),
                "approval_stage": approval_stage(position, item),
                "frozen": bool(item.get("frozen")),
                "fixed": bool(item.get("fixed")),
            }
            entry["status_context"] = self._register_status_context(
                users=users,
                profiles=profiles,
                steps=steps,
                position=position,
                cfo_id=current_cfo_id,
                entry=entry,
                item_decisions=item_decisions,
            )
            if budget_year and entry["budget_year"] != budget_year:
                continue
            if cfo_id and entry["cfo_id"] != cfo_id:
                continue
            if category_id and entry["category_id"] != category_id:
                continue
            if article_id and entry["article_id"] != article_id:
                continue
            if module_id and entry["module_id"] != module_id:
                continue
            if request_id and entry["request_id"] != request_id:
                continue
            if status and entry["status"] != status:
                continue
            if request_status and entry["request_status"] != request_status:
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
    def _register_aggregates(entries: list[dict]) -> dict:
        approved = sum(entry["status"] in {ItemStatus.approved, ItemStatus.approved_with_changes} for entry in entries)
        rejected = sum(entry["status"] == ItemStatus.rejected for entry in entries)
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
        approved_sum = sum(entry["approved_sum"] for entry in entries)
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
        return {
            "requested_sum": requested,
            "approved_sum": approved_sum,
            "rejected_sum": rejected_sum,
            "pending_sum": pending_sum,
            "difference": approved_sum - requested,
            "total_rows": len(entries),
            "approved_rows": approved,
            "rejected_rows": rejected,
            "pending_rows": pending,
            "requests_count": len({entry["request_id"] for entry in entries}),
            "modules_count": len({entry["module_id"] for entry in entries}),
            "aggregate_status": aggregate_status,
            "collecting_requests": len(collecting_requests),
            "cfo_review_requests": len(cfo_review_requests),
            "cfo_review_actionable_requests": len(cfo_review_actionable_requests),
            "in_approval_positions": len(positions_in_approval),
            "actionable_positions": len(actionable_positions),
        }

    def approval_register(self, user: dict, view: str = "cfo", **filters) -> dict:
        levels_by_view = {
            "cfo": ("cfo", "article", "category", "module"),
            "category": ("category", "module"),
            "article": ("article", "category", "module"),
            "module": ("module", "article", "category"),
            "request": ("request",),
        }
        if view not in levels_by_view:
            raise HTTPException(status_code=422, detail="Неизвестное представление реестра")
        entries = self._sort_register_entries(self._register_entries(user, **filters))
        labels = {"cfo": "ЦФО", "category": "Категория", "article": "Статья / инвестпроект", "module": "Модуль", "request": "Заявка"}
        roots: dict[str, dict] = {}
        for entry in entries:
            branch = roots
            parent_key = ""
            for level in levels_by_view[view]:
                value_id = entry["request_id"] if level == "request" else entry[f"{level}_id"]
                key = f"{parent_key}/{level}:{value_id}"
                node = branch.setdefault(key, {
                    "id": key,
                    "type": level,
                    "name": f"Заявка №{entry['request_id'][:8]}" if level == "request" else entry[f"{level}_name"],
                    "module_id": entry["module_id"],
                    "article_id": entry["article_id"],
                    "category_id": entry["category_id"],
                    "request_ids": set(),
                    "entries": [],
                    "children": {},
                })
                node["entries"].append(entry)
                node["request_ids"].add(entry["request_id"])
                branch = node["children"]
                parent_key = key

        def serialize(nodes: dict[str, dict]) -> list[dict]:
            result = []
            for node in sorted(nodes.values(), key=lambda item: (item["name"].casefold(), item["id"])):
                children = serialize(node["children"])
                payload = {
                    "id": node["id"], "type": node["type"], "name": node["name"],
                    "module_id": node["module_id"], "article_id": node["article_id"],
                    "category_id": node["category_id"], "request_ids": sorted(node["request_ids"]),
                    "aggregates": self._register_aggregates(node["entries"]),
                    "children": children,
                    "can_load_rows": not children,
                    "label": labels[node["type"]],
                }
                if node["type"] in {"article", "category"}:
                    payload["analytics"] = self._register_group_analytics(node["entries"])
                result.append(payload)
            return result

        return {"view": view, "groups": serialize(roots), "aggregates": self._register_aggregates(entries)}

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
        field_by_group_type = {"cfo": "cfo_id", "article": "article_id", "category": "category_id", "module": "module_id"}
        field = field_by_group_type.get(group_type)
        if not field:
            raise HTTPException(
                status_code=422,
                detail="Групповое согласование доступно только для ЦФО, статьи, категории или модуля",
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
            if entry.get("is_cfo_review_actionable") and entry.get("status") == ItemStatus.on_review
        ]
        workflow_lines = [
            entry for entry in entries
            if entry.get("is_approval_actionable") and not entry.get("fixed")
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
        module_id: str,
        page: int = 1,
        page_size: int = 50,
        request_id: str | None = None,
        **filters,
    ) -> dict:
        if page < 1:
            raise HTTPException(status_code=422, detail="Номер страницы должен быть не меньше 1")
        if page_size not in {25, 50, 100, 200}:
            raise HTTPException(status_code=422, detail="Допустимый размер страницы: 25, 50, 100 или 200")
        entries = [
            entry for entry in self._sort_register_entries(self._register_entries(user, **filters))
            if entry["module_id"] == module_id and (request_id is None or entry["request_id"] == request_id)
        ]
        total_items = len(entries)
        pagination = self._register_pagination(total_items, page, page_size)
        items = self._slice_register_page(entries, pagination["page"], page_size)
        return {
            "items": items,
            "group": {"module_id": module_id, "aggregates": self._register_aggregates(entries)},
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
