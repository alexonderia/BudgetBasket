from decimal import Decimal

from fastapi import HTTPException

from app.models import ItemStatus, RequestStatus
from app.repositories.base import Repository
from app.services.common import clean_request_item_name, get_required
from app.services.permission_service import PermissionService
from app.services.request_service import RequestService


class BudgetItemService:
    def __init__(self, repo: Repository, permissions: PermissionService, requests: RequestService):
        self.repo = repo
        self.permissions = permissions
        self.requests = requests

    @staticmethod
    def _decimal(value: object) -> Decimal:
        return value if isinstance(value, Decimal) else Decimal(str(value))

    @staticmethod
    def _public_item(item: dict, month_plans: list[dict] | None = None) -> dict:
        return {
            **item,
            "name": clean_request_item_name(item.get("name")),
            "month_plans": month_plans or [] if item.get("is_income", False) else [],
        }

    @staticmethod
    def _zero_month_plans() -> list[dict]:
        return [{"month": month, "sum_plan": Decimal("0")} for month in range(1, 13)]

    def _month_plans_by_item(self, item_ids: set[str] | None = None) -> dict[str, list[dict]]:
        plans: dict[str, dict[int, Decimal]] = {}
        for row in self.repo.load_all("req_item_month_plans"):
            item_id = row["req_item_id"]
            if item_ids is None or item_id in item_ids:
                plans.setdefault(item_id, {})[int(row["month"])] = self._decimal(row["sum_plan"])
        return {
            item_id: [
                {"month": month, "sum_plan": values.get(month, Decimal("0"))}
                for month in range(1, 13)
            ]
            for item_id, values in plans.items()
        }

    def _month_plans_for_item(self, item: dict) -> list[dict]:
        if not item.get("is_income", False):
            return []
        return self._month_plans_by_item({item["id"]}).get(item["id"], self._zero_month_plans())

    @classmethod
    def _validate_month_plans(cls, month_plans: list[dict]) -> tuple[list[dict], Decimal]:
        by_month: dict[int, Decimal] = {}
        for plan in month_plans:
            month = int(plan["month"])
            if month in by_month:
                raise HTTPException(status_code=422, detail="Месяцы в помесячном плане не должны повторяться")
            amount = cls._decimal(plan["sum_plan"])
            if not 1 <= month <= 12 or amount < 0:
                raise HTTPException(status_code=422, detail="Проверьте месяц и сумму помесячного плана")
            if amount.as_tuple().exponent < -2 or amount >= Decimal("1000000000000"):
                raise HTTPException(status_code=422, detail="Сумма должна соответствовать формату NUMERIC(14,2)")
            by_month[month] = amount
        normalized = [
            {"month": month, "sum_plan": by_month.get(month, Decimal("0"))}
            for month in range(1, 13)
        ]
        return normalized, sum((row["sum_plan"] for row in normalized), Decimal("0"))

    @staticmethod
    def _replace_month_plans(repo: Repository, item_id: str, month_plans: list[dict]) -> None:
        repo.delete_where("req_item_month_plans", {"req_item_id": item_id})
        for plan in month_plans:
            repo.create("req_item_month_plans", {"req_item_id": item_id, **plan})

    @staticmethod
    def catalog_collection(kind: str) -> str:
        return "dds_catalog" if kind == "dds" else "invests_catalog"

    def list_items(self, user: dict, request_id: str, *, include_deleted: bool = True) -> list[dict]:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_view_request(user, request)
        items = [row for row in self.repo.load_all("req_items") if row["request_id"] == request_id]
        if not include_deleted:
            items = [row for row in items if row.get("status") != ItemStatus.deleted]
        plans = self._month_plans_by_item({row["id"] for row in items})
        return [self._public_item(row, plans.get(row["id"], self._zero_month_plans())) for row in items]

    def _kind_for_request(self, request: dict) -> str:
        return "invest" if get_required(self.repo, "units", request["unit_id"]).get("uses_invest_projects") else "dds"

    def _department_id_for_request(self, request: dict) -> str:
        units = {row["id"]: row for row in self.repo.load_all("units")}
        current = get_required(self.repo, "units", request["unit_id"])
        while current.get("parent_id") in units:
            current = units[current["parent_id"]]
        return current["id"]

    def _validate_article(self, request: dict, payload: dict) -> tuple[str, str]:
        kind = self._kind_for_request(request)
        field = "invest_id" if kind == "invest" else "dds_id"
        forbidden = "dds_id" if kind == "invest" else "invest_id"
        article_id = payload.get(field)
        if not article_id or payload.get(forbidden):
            raise HTTPException(status_code=400, detail="Строка должна ссылаться на допустимую статью")
        article = get_required(self.repo, self.catalog_collection(kind), article_id)
        if not article.get("is_active", True):
            raise HTTPException(status_code=400, detail="Нельзя использовать неактивную запись НСИ")
        if article.get("unit_id") != self._department_id_for_request(request):
            raise HTTPException(status_code=400, detail="Запись НСИ относится к другому подразделению")
        return kind, article_id

    def create_item(self, user: dict, request_id: str, payload: dict) -> dict:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_employee_edit_request(user, request)
        kind, article_id = self._validate_article(request, payload)
        name = payload["name"].strip()
        if not name:
            raise HTTPException(status_code=400, detail="Укажите наименование строки")
        is_income = payload.get("is_income", False)
        raw_plans = []
        if is_income:
            raw_plans = (
                payload.get("month_plans") or []
                if "month_plans" in payload
                else [{"month": 1, "sum_plan": payload.get("sum_plan", 0)}]
            )
        if not is_income and raw_plans:
            raise HTTPException(status_code=422, detail="Помесячный план доступен только для доходной строки")
        plans, total = (
            self._validate_month_plans(raw_plans)
            if is_income
            else ([], self._decimal(payload["sum_plan"]))
        )
        item = {
            "request_id": request_id,
            "cfo_position_id": None,
            "dds_id": article_id if kind == "dds" else None,
            "invest_id": article_id if kind == "invest" else None,
            "is_income": is_income,
            "name": name,
            "sum_plan": total,
            "sum_fact": Decimal("0"),
            "justification": payload.get("justification", "").strip(),
            "status": ItemStatus.on_review,
            "comment": "",
        }
        with self.repo.transaction() as repo:
            created = repo.create("req_items", item)
            if is_income:
                self._replace_month_plans(repo, created["id"], plans)
            self.requests.recalculate_total(request_id, repo=repo)
            public = self._public_item(created, plans)
            self.requests.log(
                user, request_id, "line_created", entity="req_item",
                entity_id=created["id"], after=public, repo=repo,
            )
        return public

    @staticmethod
    def _employee_patch(patch: dict) -> dict:
        fields = {
            "dds_id", "invest_id", "name", "sum_plan", "justification",
            "is_income", "month_plans", "clear_month_plans",
        }
        if set(patch) - fields:
            raise HTTPException(status_code=403, detail="Поля рассмотрения изменяются только командами решения")
        return dict(patch)

    def patch_item(self, user: dict, item_id: str, patch: dict) -> dict:
        item = get_required(self.repo, "req_items", item_id)
        request = get_required(self.repo, "requests", item["request_id"])
        self.permissions.require_employee_edit_request(user, request)
        if item.get("status") == ItemStatus.deleted:
            raise HTTPException(status_code=400, detail="Удалённую строку нельзя изменить")
        normalized = self._employee_patch(patch)
        if "dds_id" in normalized or "invest_id" in normalized:
            kind, article_id = self._validate_article(request, {**item, **normalized})
            normalized["dds_id"] = article_id if kind == "dds" else None
            normalized["invest_id"] = article_id if kind == "invest" else None
        for field in ("name", "justification"):
            if field in normalized:
                normalized[field] = normalized[field].strip()
        if "name" in normalized and not normalized["name"]:
            raise HTTPException(status_code=400, detail="Укажите наименование строки")

        is_income = normalized.get("is_income", item.get("is_income", False))
        raw_plans = normalized.pop("month_plans", None)
        clear_plans = normalized.pop("clear_month_plans", False)
        if not is_income and raw_plans:
            raise HTTPException(status_code=422, detail="Помесячный план доступен только для доходной строки")
        if item.get("is_income") and not is_income and not clear_plans:
            raise HTTPException(status_code=422, detail="Подтвердите очистку помесячного плана")
        plans: list[dict] | None = None
        if is_income and raw_plans is not None:
            plans, normalized["sum_plan"] = self._validate_month_plans(raw_plans)
        elif is_income and not item.get("is_income"):
            plans, normalized["sum_plan"] = self._validate_month_plans([])
        elif not is_income and item.get("is_income"):
            plans = []

        before = self._public_item(item, self._month_plans_for_item(item))
        effective = {key: value for key, value in normalized.items() if item.get(key) != value}
        if not effective and plans is None:
            return before
        with self.repo.transaction() as repo:
            updated = repo.update("req_items", item_id, effective) if effective else item
            if plans is not None:
                self._replace_month_plans(repo, item_id, plans)
            self.requests.recalculate_total(item["request_id"], repo=repo)
            after = self._public_item(
                updated,
                plans if plans is not None else before["month_plans"],
            )
            self.requests.log(
                user, item["request_id"], "line_updated", entity="req_item",
                entity_id=item_id, before=before, after=after, repo=repo,
            )
        return after

    @staticmethod
    def normalize_decision(item: dict, payload: dict) -> dict:
        decision = payload["decision"]
        if decision not in {
            ItemStatus.approved, ItemStatus.approved_with_changes, ItemStatus.rejected
        }:
            raise HTTPException(status_code=422, detail="Недопустимое решение по строке")
        comment = (payload.get("comment") or "").strip()
        patch = {"status": decision, "comment": comment}
        if decision == ItemStatus.approved:
            patch["sum_fact"] = item["sum_plan"]
        elif decision == ItemStatus.rejected:
            if not comment:
                raise HTTPException(status_code=422, detail="Для отклонения нужен комментарий")
            patch["sum_fact"] = Decimal("0")
        else:
            changed_plan = payload.get("sum_plan")
            fact = payload.get("sum_fact")
            if changed_plan is not None:
                patch["sum_plan"] = changed_plan
            patch["sum_fact"] = fact if fact is not None else patch.get("sum_plan", item["sum_plan"])
            for field in ("name", "justification"):
                if payload.get(field) is not None:
                    patch[field] = payload[field].strip()
            if not comment:
                raise HTTPException(status_code=422, detail="Для одобрения с изменениями нужен комментарий")
            if all(item.get(key) == value for key, value in patch.items() if key not in {"status", "comment"}):
                raise HTTPException(status_code=422, detail="Укажите изменённые значения")
        return patch

    def _decide_cfo(self, repo: Repository, user: dict, item: dict, payload: dict) -> dict:
        request = get_required(repo, "requests", item["request_id"])
        self.permissions.require_cfo_request_access(user, request)
        if request.get("status") != RequestStatus.on_review:
            raise HTTPException(status_code=409, detail="Заявка не находится на проверке ЦФО")
        if item.get("status") == ItemStatus.deleted:
            raise HTTPException(status_code=409, detail="Удалённая строка не рассматривается")
        before = dict(item)
        after = repo.update("req_items", item["id"], self.normalize_decision(item, payload))
        self.requests.recalculate_total(request["id"], repo=repo)
        self.requests.log(
            user, request["id"], "cfo_item_decided", stage="cfo_review",
            entity="req_item", entity_id=item["id"], before=before, after=after,
            comment=payload.get("comment"), repo=repo,
        )
        return after

    def decide_cfo(self, user: dict, item_id: str, payload: dict) -> dict:
        with self.repo.transaction() as repo:
            item = get_required(repo, "req_items", item_id)
            result = self._decide_cfo(repo, user, item, payload)
        return self._public_item(result, self._month_plans_for_item(result))

    def bulk_decide_cfo(self, user: dict, payload: dict) -> list[dict]:
        with self.repo.transaction() as repo:
            result = [
                self._decide_cfo(
                    repo, user, get_required(repo, "req_items", item_id), payload
                )
                for item_id in payload["item_ids"]
            ]
        return [self._public_item(row, self._month_plans_for_item(row)) for row in result]

    def delete_item(self, user: dict, item_id: str) -> dict:
        item = get_required(self.repo, "req_items", item_id)
        request = get_required(self.repo, "requests", item["request_id"])
        self.permissions.require_employee_edit_request(user, request)
        if item.get("status") == ItemStatus.deleted:
            return self._public_item(item)
        with self.repo.transaction() as repo:
            updated = repo.update(
                "req_items", item_id,
                {"status": ItemStatus.deleted, "sum_plan": Decimal("0"), "sum_fact": Decimal("0")},
            )
            self.requests.recalculate_total(item["request_id"], repo=repo)
            self.requests.log(
                user, item["request_id"], "line_deleted", entity="req_item",
                entity_id=item_id, before=item, after=updated, repo=repo,
            )
        return self._public_item(updated)
