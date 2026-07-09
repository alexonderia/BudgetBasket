from fastapi import HTTPException

from app.models import RequestStatus
from app.repositories.json_repository import JsonRepository


class PermissionService:
    def __init__(self, repo: JsonRepository):
        self.repo = repo

    def employee_module_ids(self, user_id: str) -> set[str]:
        return {
            item["unit_id"]
            for item in self.repo.load_all("units_responsibles")
            if item.get("user_id") == user_id and item.get("is_active")
        }

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

        economist_units = self.economist_module_ids(user["id"])
        result = set()
        for request in self.repo.load_all("requests"):
            if request.get("economist_id") == user["id"]:
                result.add(request["id"])
            elif request.get("unit_id") in economist_units:
                result.add(request["id"])
            elif request.get("economist_id") is None and request.get("status") == RequestStatus.on_review:
                result.add(request["id"])
        return result

    def can_view_request(self, user: dict, request: dict) -> bool:
        if user["role"] == "admin":
            return True
        if user["role"] == "employee":
            return request.get("unit_id") in self.employee_module_ids(user["id"])
        if user["role"] == "economist":
            if request.get("economist_id") == user["id"]:
                return True
            if request.get("unit_id") in self.economist_module_ids(user["id"]):
                return True
            if request.get("economist_id") is None and request.get("status") == RequestStatus.on_review:
                return True
        return False

    def require_view_request(self, user: dict, request: dict) -> None:
        if not self.can_view_request(user, request):
            raise HTTPException(status_code=403, detail="No access to request")

    def require_employee_edit_request(self, user: dict, request: dict) -> None:
        if user["role"] != "employee" or request.get("unit_id") not in self.employee_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Only responsible employee can edit request")
        if request.get("status") != RequestStatus.draft:
            raise HTTPException(status_code=400, detail="Request is not editable")

    def require_employee_upload_file(self, user: dict, request: dict) -> None:
        if user["role"] == "admin":
            return
        if user["role"] != "employee" or request.get("unit_id") not in self.employee_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Only responsible employee can upload files")
        if request.get("status") not in {RequestStatus.draft, RequestStatus.on_review}:
            raise HTTPException(status_code=400, detail="Files can be uploaded only for draft or on_review requests")

    def require_economist_review_request(self, user: dict, request: dict) -> None:
        if user["role"] != "economist":
            raise HTTPException(status_code=403, detail="Only economist can review request")
        economist_id = request.get("economist_id")
        if economist_id not in (None, user["id"]) and request.get("unit_id") not in self.economist_module_ids(user["id"]):
            raise HTTPException(status_code=403, detail="Only assigned economist can review request")
