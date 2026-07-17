from fastapi import HTTPException

from app.models import RequestStatus
from app.repositories.base import Repository


class PermissionService:
    def __init__(self, repo: Repository):
        self.repo = repo

    def _child_modules(self, unit_id: str) -> set[str]:
        units = {item["id"]: item for item in self.repo.load_all("units")}
        child_ids = {item["id"] for item in self.repo.load_all("units") if item.get("parent_id") == unit_id}
        result = set(child_ids)
        stack = list(child_ids)
        while stack:
            current_id = stack.pop()
            for item in units.values():
                if item.get("parent_id") == current_id and item["id"] not in result:
                    result.add(item["id"])
                    stack.append(item["id"])
        return {item_id for item_id in result if units.get(item_id, {}).get("parent_id")}

    def employee_module_ids(self, user_id: str) -> set[str]:
        assigned_units = {
            item["unit_id"]
            for item in self.repo.load_all("units_responsibles")
            if item.get("user_id") == user_id and item.get("is_active")
        }
        module_ids = set(assigned_units)
        for unit_id in assigned_units:
            unit = self.repo.get_by_id("units", unit_id)
            if not unit:
                continue
            if not unit.get("parent_id"):
                module_ids.update(self._child_modules(unit_id))
        return module_ids

    def economist_module_ids(self, user_id: str) -> set[str]:
        assigned_units = {
            item["unit_id"]
            for item in self.repo.load_all("units_responsibles")
            if item.get("user_id") == user_id and item.get("is_active")
        }
        request_units = {request["unit_id"] for request in self.repo.load_all("requests") if request.get("economist_id") == user_id}
        return assigned_units | request_units

    def visible_request_ids(self, user: dict) -> set[str] | None:
        if user["role"] == "admin":
            return None
        if user["role"] == "employee":
            module_ids = self.employee_module_ids(user["id"])
            return {request["id"] for request in self.repo.load_all("requests") if request.get("unit_id") in module_ids}

        module_ids = self.economist_module_ids(user["id"])
        return {
            request["id"]
            for request in self.repo.load_all("requests")
            if request.get("status") != RequestStatus.draft and request.get("unit_id") in module_ids
        }

    def can_view_request(self, user: dict, request: dict) -> bool:
        if user["role"] == "admin":
            return True
        if user["role"] == "employee":
            return request.get("unit_id") in self.employee_module_ids(user["id"])
        if user["role"] == "economist":
            return request.get("status") != RequestStatus.draft and request.get("unit_id") in self.economist_module_ids(user["id"])
        return False

    def require_view_request(self, user: dict, request: dict) -> None:
        if not self.can_view_request(user, request):
            raise HTTPException(status_code=403, detail="Нет доступа к заявке")

    @staticmethod
    def require_request_unfrozen(request: dict) -> None:
        if request.get("frozen"):
            raise HTTPException(status_code=400, detail="Бюджет заявки зафиксирован")

    def require_employee_edit_request(self, user: dict, request: dict) -> None:
        self.require_request_unfrozen(request)
        if user["role"] != "employee" or request.get("unit_id") not in self.employee_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Изменять заявку может только ответственный сотрудник")
        if request.get("status") != RequestStatus.draft:
            raise HTTPException(status_code=400, detail="Заявка недоступна для редактирования")

    def require_request_delete_request(self, user: dict, request: dict) -> None:
        self.require_request_unfrozen(request)
        if request.get("status") != RequestStatus.draft:
            raise HTTPException(status_code=400, detail="Заявку можно удалить только в статусе черновика")
        if user["role"] != "employee" or request.get("unit_id") not in self.employee_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Удалить заявку может только ответственный сотрудник")

    def require_employee_cancel_request(self, user: dict, request: dict) -> None:
        self.require_request_unfrozen(request)
        if user["role"] != "employee" or request.get("unit_id") not in self.employee_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Отменить заявку может только ответственный сотрудник")
        if request.get("status") not in {RequestStatus.draft, RequestStatus.on_review}:
            raise HTTPException(status_code=400, detail="Заявку можно отменить только в черновике или на рассмотрении")

    def require_employee_withdraw_request(self, user: dict, request: dict) -> None:
        self.require_request_unfrozen(request)
        if user["role"] != "employee" or request.get("unit_id") not in self.employee_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Отозвать заявку может только ответственный сотрудник")
        if request.get("status") != RequestStatus.on_review:
            raise HTTPException(status_code=400, detail="Отозвать можно только заявку на рассмотрении")

    def require_employee_upload_file(self, user: dict, request: dict) -> None:
        self.require_request_unfrozen(request)
        if user["role"] != "employee" or request.get("unit_id") not in self.employee_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Загружать файлы может только ответственный сотрудник")
        if request.get("status") != RequestStatus.draft:
            raise HTTPException(status_code=400, detail="Файлы можно загружать только в черновик заявки")

    def require_economist_edit_request(self, user: dict, request: dict) -> None:
        self.require_request_unfrozen(request)
        self.require_economist_review_request(user, request)

    def require_budget_control_access(self, user: dict, request: dict) -> None:
        self.require_economist_review_request(user, request)

    def require_economist_review_request(self, user: dict, request: dict) -> None:
        if user["role"] != "economist":
            raise HTTPException(status_code=403, detail="Рассматривать заявку может только экономист")
        if request.get("unit_id") not in self.economist_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Рассматривать заявку может только назначенный экономист")
