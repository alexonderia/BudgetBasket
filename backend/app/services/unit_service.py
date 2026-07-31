from __future__ import annotations

from fastapi import HTTPException

from app.repositories.base import Repository
from app.services.common import require_role


class UnitService:
    def __init__(self, repo: Repository):
        self.repo = repo

    def unit_level(self, unit_id: str) -> int:
        units = {item["id"]: item for item in self.repo.load_all("units")}
        level = 1
        current = units.get(unit_id)
        visited: set[str] = set()
        while current and current.get("parent_id") and current["id"] not in visited:
            visited.add(current["id"])
            level += 1
            current = units.get(current["parent_id"])
        return level

    def enrich_unit(self, unit: dict) -> dict:
        level = self.unit_level(unit["id"])
        return {
            **unit,
            "type": "department" if level == 1 else "cfo" if level == 2 else "module",
        }

    def list_units(self) -> list[dict]:
        return [self.enrich_unit(item) for item in self.repo.load_all("units")]

    def create_unit(self, user: dict, payload: dict) -> dict:
        require_role(user, "admin")
        requested_type = payload.pop("type", None)
        parent_id = payload.get("parent_id")
        expected_level = 1 if not parent_id else self.unit_level(parent_id) + 1
        expected_type = "department" if expected_level == 1 else "cfo" if expected_level == 2 else "module"
        if expected_level > 3 or requested_type not in {None, expected_type}:
            raise HTTPException(status_code=400, detail="Допустима иерархия: департамент → ЦФО → модуль")
        payload["annual_budget"] = 0
        return self.enrich_unit(self.repo.create("units", payload))

    def update_unit(self, user: dict, unit_id: str, patch: dict) -> dict:
        require_role(user, "admin")
        patch.pop("type", None)
        unit = self.repo.get_by_id("units", unit_id)
        if not unit:
            raise HTTPException(status_code=404, detail="Подразделение не найдено")
        if "parent_id" in patch and patch["parent_id"] != unit.get("parent_id"):
            parent_id = patch["parent_id"]
            new_level = 1 if not parent_id else self.unit_level(parent_id) + 1
            if new_level > 3:
                raise HTTPException(status_code=400, detail="Глубина оргструктуры не может превышать три уровня")
            if any(item.get("parent_id") == unit_id for item in self.repo.load_all("units")):
                raise HTTPException(status_code=409, detail="Нельзя перемещать подразделение с дочерними узлами")
        if (
            "uses_invest_projects" in patch
            and patch["uses_invest_projects"] != unit.get("uses_invest_projects", False)
        ):
            new_kind = "invest" if patch["uses_invest_projects"] else "dds"
            request_ids = {
                request["id"]
                for request in self.repo.load_all("requests")
                if request.get("unit_id") == unit_id
            }
            if any(
                item.get("request_id") in request_ids
                and item.get("status") != "deleted"
                and ("invest" if item.get("invest_id") else "dds") != new_kind
                for item in self.repo.load_all("req_items")
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Нельзя изменить тип строк, пока существуют активные строки другого типа",
                )
        return self.enrich_unit(self.repo.update("units", unit_id, patch))

    def delete_unit(self, user: dict, unit_id: str) -> None:
        require_role(user, "admin")
        if not self.repo.get_by_id("units", unit_id):
            raise HTTPException(status_code=404, detail="Подразделение не найдено")
        if any(item.get("parent_id") == unit_id for item in self.repo.load_all("units")):
            raise HTTPException(status_code=409, detail="Сначала удалите дочерние подразделения")
        if any(request.get("unit_id") == unit_id for request in self.repo.load_all("requests")):
            raise HTTPException(status_code=409, detail="У подразделения есть заявки")
        if any(
            item.get("cfo_unit_id") == unit_id
            for item in self.repo.load_all("cfo_positions")
        ):
            raise HTTPException(status_code=409, detail="У ЦФО есть бюджетные позиции")
        self.repo.delete_where("units_responsibles", {"unit_id": unit_id})
        self.repo.delete("units", unit_id)

    def tree(self) -> list[dict]:
        units = [dict(self.enrich_unit(item), children=[]) for item in self.repo.load_all("units")]
        by_id = {item["id"]: item for item in units}
        roots: list[dict] = []
        for item in units:
            parent = by_id.get(item.get("parent_id"))
            if parent:
                parent["children"].append(item)
            else:
                roots.append(item)
        return roots

    def _active_assignments(self, unit_id: str, role: str) -> list[dict]:
        users = {item["id"]: item for item in self.repo.load_all("users")}
        return [
            item
            for item in self.repo.load_all("units_responsibles")
            if item.get("unit_id") == unit_id
            and item.get("is_active")
            and users.get(item.get("user_id"), {}).get("role") == role
        ]

    def _set_assignment(self, unit_id: str, user_id: str, role: str) -> dict:
        for item in self._active_assignments(unit_id, role):
            if item["user_id"] == user_id:
                return item
            self.repo.update_where(
                "units_responsibles",
                {"unit_id": unit_id, "user_id": item["user_id"]},
                {"is_active": False},
            )
        existing = next(
            (
                item
                for item in self.repo.load_all("units_responsibles")
                if item.get("unit_id") == unit_id and item.get("user_id") == user_id
            ),
            None,
        )
        if existing:
            self.repo.update_where(
                "units_responsibles",
                {"unit_id": unit_id, "user_id": user_id},
                {"is_active": True},
            )
            return {**existing, "is_active": True}
        return self.repo.insert(
            "units_responsibles",
            {"unit_id": unit_id, "user_id": user_id, "is_active": True},
        )

    def set_responsible(self, user: dict, unit_id: str, employee_id: str) -> dict:
        require_role(user, "admin")
        level = self.unit_level(unit_id)
        if level not in {2, 3}:
            raise HTTPException(status_code=400, detail="Ответственного назначают на ЦФО или модуль")
        target = self.repo.get_by_id("users", employee_id)
        if not target or target.get("role") != "employee":
            raise HTTPException(status_code=400, detail="Ответственным может быть только сотрудник")
        return self._set_assignment(unit_id, employee_id, "employee")

    def get_responsible(self, unit_id: str) -> dict | None:
        matches = self._active_assignments(unit_id, "employee")
        if len(matches) > 1:
            raise HTTPException(status_code=409, detail="Назначено несколько ответственных")
        return matches[0] if matches else None

    def clear_responsible(self, user: dict, unit_id: str) -> dict:
        require_role(user, "admin")
        for item in self._active_assignments(unit_id, "employee"):
            self.repo.update_where(
                "units_responsibles",
                {"unit_id": unit_id, "user_id": item["user_id"]},
                {"is_active": False},
            )
        return {"ok": True}

    def list_assignments(self, user: dict) -> list[dict]:
        require_role(user, "admin")
        return [
            {
                "id": f"{item['user_id']}:{item['unit_id']}",
                "economist_id": item["user_id"],
                "unit_id": item["unit_id"],
                "assignment_type": "cfo",
                "is_active": True,
            }
            for unit in self.repo.load_all("units")
            if self.unit_level(unit["id"]) == 2
            for item in self._active_assignments(unit["id"], "economist")
        ]

    def create_assignment(self, user: dict, payload: dict) -> dict:
        require_role(user, "admin")
        target = self.repo.get_by_id("users", payload["economist_id"])
        if not target or target.get("role") != "economist":
            raise HTTPException(status_code=400, detail="Назначить можно только экономиста")
        if self.unit_level(payload["unit_id"]) != 2:
            raise HTTPException(status_code=400, detail="Экономиста назначают только на ЦФО")
        if payload.get("assignment_type") != "cfo":
            raise HTTPException(status_code=400, detail="Тип назначения должен быть cfo")
        self._set_assignment(payload["unit_id"], payload["economist_id"], "economist")
        return {
            "id": f"{payload['economist_id']}:{payload['unit_id']}",
            "economist_id": payload["economist_id"],
            "unit_id": payload["unit_id"],
            "assignment_type": "cfo",
            "is_active": True,
        }

    def deactivate_assignment(self, user: dict, assignment_id: str) -> dict:
        require_role(user, "admin")
        economist_id, separator, cfo_id = assignment_id.partition(":")
        if not separator or self.unit_level(cfo_id) != 2:
            raise HTTPException(status_code=400, detail="Некорректное назначение")
        if any(
            item.get("cfo_unit_id") == cfo_id
            and item.get("status") in {"on_approval", "on_revision"}
            and not item.get("fixed")
            for item in self.repo.load_all("cfo_positions")
        ):
            raise HTTPException(status_code=409, detail="У экономиста есть активные позиции")
        updated = self.repo.update_where(
            "units_responsibles",
            {"unit_id": cfo_id, "user_id": economist_id},
            {"is_active": False},
        )
        if not updated:
            raise HTTPException(status_code=404, detail="Назначение не найдено")
        return {"id": assignment_id, "is_active": False}
