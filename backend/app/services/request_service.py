from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from app.models import APPROVED_ITEM_STATUSES, ItemStatus, RequestStatus
from app.repositories.base import Repository
from app.services.common import get_required
from app.services.permission_service import PermissionService


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
        storage = repo or self.repo
        items = self._items(request_id, repo=storage)
        expenses = [item for item in items if not item.get("is_income", False)]
        return storage.update(
            "requests",
            request_id,
            {
                "sum_plan": sum(
                    (Decimal(str(item.get("sum_plan") or 0)) for item in expenses),
                    Decimal("0"),
                ),
                "sum_fact": sum(
                    (
                        Decimal(str(item.get("sum_fact") or 0))
                        for item in expenses
                        if item.get("status") in APPROVED_ITEM_STATUSES
                    ),
                    Decimal("0"),
                ),
            },
        )

    def public_request(self, request: dict, summary: dict | None = None) -> dict:
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
            "sum": request.get("sum_plan", 0),
            "cfo_unit_id": cfo_id,
            "cfo_responsible_id": (
                self.permissions.cfo_responsible_id(cfo_id) if cfo_id else None
            ),
            "total_approved_sum": request.get("sum_fact", 0),
            "summary": summary or self.summary(request["id"]),
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
                "created_by_id": user["id"],
                "budget_year": budget_year,
                "sum_plan": 0,
                "sum_fact": 0,
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
            bool(item.get("is_income", False)),
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
                    bool(item.get("is_income", False)),
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
                if position and (position.get("frozen") or position.get("fixed")):
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
                            "is_income": bool(item.get("is_income", False)),
                            "status": "waiting",
                            "current_step_id": None,
                            "frozen": False,
                            "fixed": False,
                        },
                    )
                    by_key[key] = position
                elif position.get("current_step_id") and not position.get("frozen"):
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
                        "step_id": position.get("current_step_id"),
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
                                "step_id": position.get("current_step_id"),
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
            expenses = [item for item in items if not item.get("is_income", False)]
            updated = repo.update(
                "requests",
                request_id,
                {
                    "status": next_status,
                    "sum_plan": sum(Decimal(str(item.get("sum_plan") or 0)) for item in expenses),
                    "sum_fact": sum(
                        Decimal(str(item.get("sum_fact") or 0))
                        for item in accepted
                        if not item.get("is_income", False)
                    ),
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
            if self.notifications:
                self.notifications.create(
                    request["created_by_id"],
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
            "notification_user_ids": list(
                {
                    request["created_by_id"],
                    *(
                        [self.permissions.cfo_economist_id(cfo_id)]
                        if late_position_ids and self.permissions.cfo_economist_id(cfo_id)
                        else []
                    ),
                }
            ),
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
                target_id = request.get("created_by_id")
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
        return [
            item
            for item in self.repo.load_all("cfo_positions")
            if (visible is None or item["id"] in visible)
            and (is_income is None or bool(item.get("is_income")) == is_income)
        ]

    def _position_sum(self, position_id: str) -> tuple[float, float, int]:
        items = [
            item
            for item in self.repo.load_all("req_items")
            if item.get("cfo_position_id") == position_id
            and item.get("status") in APPROVED_ITEM_STATUSES
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
            planned, approved, count = self._position_sum(position["id"])
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
                    item["approved"]
                    for item, position in zip(rows, positions, strict=False)
                    if position.get("frozen")
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
                "frozen_requests_count": sum(bool(item.get("frozen")) for item in positions),
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
            planned, approved, count = self._position_sum(position["id"])
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
                    "fixed": bool(position.get("fixed")),
                }
            )
        return rows

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
