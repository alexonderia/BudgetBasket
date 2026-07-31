from __future__ import annotations

from uuid import uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from app.models import APPROVED_ITEM_STATUSES, CfoPositionStatus, ItemStatus, RequestStatus, StepStatus
from app.repositories.base import Repository
from app.services.budget_item_service import BudgetItemService
from app.services.budget_totals import sync_annual_budgets
from app.services.common import get_required, now_iso, public_user
from app.services.permission_service import PermissionService


class ApprovalService:
    def __init__(self, repo: Repository, permissions: PermissionService, chat_service=None):
        self.repo = repo
        self.permissions = permissions
        self.chat_service = chat_service
        self.notifications = None

    @staticmethod
    def _event_id() -> str:
        return str(uuid4())

    @staticmethod
    def _steps(repo: Repository) -> dict[str, dict]:
        return {row["id"]: row for row in repo.load_all("steps")}

    @staticmethod
    def _edges(repo: Repository) -> list[dict]:
        return repo.load_all("step_edges")

    @staticmethod
    def _parents(step_id: str, edges: list[dict]) -> list[str]:
        return [row["parent_step_id"] for row in edges if row["child_step_id"] == step_id]

    @staticmethod
    def _children(step_id: str, edges: list[dict]) -> list[str]:
        return [row["child_step_id"] for row in edges if row["parent_step_id"] == step_id]

    def _root_ids(self, repo: Repository) -> list[str]:
        steps = self._steps(repo)
        children = {row["child_step_id"] for row in self._edges(repo)}
        return [step_id for step_id in steps if step_id not in children]

    @staticmethod
    def _system_actor(repo: Repository) -> dict | None:
        """Use an administrator as the auditable actor for system bootstrap."""
        admins = [row for row in repo.load_all("users") if row.get("role") == "admin"]
        return min(admins, key=lambda row: (row.get("login", ""), row["id"])) if admins else None

    def sync_automatic_steps(self, user: dict | None = None) -> dict:
        """Synchronise system-owned CFO, economist and ZGD route anchors.

        A single economist step may have several CFO anchors as children.  The
        CFO-to-economist links are derived from ``units_responsibles``; further
        reviewer links remain administrator-configured.
        """
        actor = user or self._system_actor(self.repo)
        if not actor:
            return {"created": [], "skipped": [{"reason": "no_admin_for_audit_log"}]}

        created: list[dict] = []
        skipped: list[dict] = []
        with self.repo.transaction() as repo:
            existing = repo.load_all("steps")
            existing_zgd_ids = {
                row.get("user_id")
                for row in existing
                if row.get("user_id")
                and repo.get_by_id("users", row["user_id"])
                and repo.get_by_id("users", row["user_id"]).get("role") == "zgd"
            }
            cfo_units = sorted(
                (
                    row
                    for row in repo.load_all("units")
                    if row.get("is_active") and self.permissions.unit_level(row["id"]) == 2
                ),
                key=lambda row: (row.get("name", ""), row["id"]),
            )

            def user_role(step: dict) -> str | None:
                account = repo.get_by_id("users", step.get("user_id")) if step.get("user_id") else None
                return account.get("role") if account else None

            # Preserve one existing automatic-like step per economist and merge
            # the former per-CFO duplicates into it.
            economist_steps: dict[str, dict] = {}
            candidates = sorted(
                (step for step in existing if step.get("unit_id") is None and user_role(step) == "economist"),
                key=lambda step: step["id"],
            )
            for step in candidates:
                economist_steps.setdefault(step["user_id"], step)

            for cfo in cfo_units:
                cfo_step = next((row for row in existing if row.get("unit_id") == cfo["id"]), None)
                if not cfo_step:
                    cfo_step = repo.create(
                        "steps",
                        {"unit_id": cfo["id"], "user_id": None, "status": StepStatus.waiting},
                    )
                    existing.append(cfo_step)
                    self._step_log(
                        repo, actor, cfo_step, "automatic_cfo_step_created",
                        event_id=self._event_id(), changes=self._changes({}, cfo_step), source="system",
                    )
                    created.append({"step_id": cfo_step["id"], "kind": "cfo", "unit_id": cfo["id"]})

                economist_id = self.permissions.cfo_economist_id(cfo["id"])
                if not economist_id:
                    skipped.append({"unit_id": cfo["id"], "reason": "no_cfo_economist"})
                    continue
                economist_step = economist_steps.get(economist_id)
                if not economist_step:
                    economist_step = repo.create(
                        "steps",
                        {"unit_id": None, "user_id": economist_id, "status": StepStatus.waiting},
                    )
                    existing.append(economist_step)
                    economist_steps[economist_id] = economist_step
                    self._step_log(
                        repo, actor, economist_step, "automatic_economist_step_created",
                        event_id=self._event_id(), changes=self._changes({}, economist_step),
                        source="system", cfo_unit_id=cfo["id"],
                    )
                    created.append({"step_id": economist_step["id"], "kind": "economist", "unit_id": cfo["id"]})

                parent_ids = self._parents(cfo_step["id"], self._edges(repo))
                for parent_id in list(parent_ids):
                    if parent_id == economist_step["id"]:
                        continue
                    parent = get_required(repo, "steps", parent_id)
                    # If this is a duplicate economist step, it was previously
                    # dedicated to this CFO. Move the CFO to the shared step,
                    # while retaining any downstream reviewer links.
                    if user_role(parent) == "economist":
                        repo.delete_where(
                            "step_edges",
                            {"parent_step_id": parent_id, "child_step_id": cfo_step["id"]},
                        )
                        for grandparent_id in self._parents(parent_id, self._edges(repo)):
                            if grandparent_id == economist_step["id"]:
                                continue
                            if not any(
                                edge.get("parent_step_id") == grandparent_id
                                and edge.get("child_step_id") == economist_step["id"]
                                for edge in self._edges(repo)
                            ):
                                repo.create(
                                    "step_edges",
                                    {"parent_step_id": grandparent_id, "child_step_id": economist_step["id"]},
                                )
                        for position in repo.load_all("cfo_positions"):
                            if (
                                position.get("current_step_id") == parent_id
                                and position.get("cfo_unit_id") == cfo["id"]
                            ):
                                before = dict(position)
                                after = repo.update(
                                    "cfo_positions", position["id"],
                                    {"current_step_id": economist_step["id"]},
                                )
                                self._position_log(
                                    repo, actor, after, "position_moved_to_shared_economist_step",
                                    before=before, after=after, step_id=economist_step["id"], source="system",
                                )
                    else:
                        # Legacy direct reviewer -> CFO link: insert the shared
                        # economist step between them.
                        repo.delete_where(
                            "step_edges",
                            {"parent_step_id": parent_id, "child_step_id": cfo_step["id"]},
                        )
                        if not any(
                            edge.get("parent_step_id") == parent_id
                            and edge.get("child_step_id") == economist_step["id"]
                            for edge in self._edges(repo)
                        ):
                            repo.create(
                                "step_edges",
                                {"parent_step_id": parent_id, "child_step_id": economist_step["id"]},
                            )
                if not any(
                    edge.get("parent_step_id") == economist_step["id"]
                    and edge.get("child_step_id") == cfo_step["id"]
                    for edge in self._edges(repo)
                ):
                    repo.create(
                        "step_edges",
                        {"parent_step_id": economist_step["id"], "child_step_id": cfo_step["id"]},
                    )
                    self._step_log(
                        repo, actor, economist_step, "automatic_economist_link_created",
                        event_id=self._event_id(), source="system", cfo_unit_id=cfo["id"],
                        parent_step_id=economist_step["id"], child_step_id=cfo_step["id"],
                    )
                for position in repo.load_all("cfo_positions"):
                    if position.get("current_step_id") != cfo_step["id"]:
                        continue
                    before = dict(position)
                    after = repo.update(
                        "cfo_positions", position["id"], {"current_step_id": economist_step["id"]}
                    )
                    self._position_log(
                        repo, actor, after, "position_moved_to_economist_step",
                        before=before, after=after, step_id=economist_step["id"], source="system",
                    )

            shared_ids = {step["id"] for step in economist_steps.values()}
            for step in list(existing):
                if (
                    step.get("id") in shared_ids
                    or step.get("unit_id") is not None
                    or user_role(step) != "economist"
                    or self._children(step["id"], self._edges(repo))
                    or any(position.get("current_step_id") == step["id"] for position in repo.load_all("cfo_positions"))
                ):
                    continue
                repo.delete_where("step_edges", {"parent_step_id": step["id"]})
                repo.delete_where("step_edges", {"child_step_id": step["id"]})
                self._step_log(
                    repo, actor, step, "automatic_duplicate_economist_step_removed",
                    event_id=self._event_id(), source="system",
                )
                repo.delete("steps", step["id"])

            zgd_users = sorted(
                (row for row in repo.load_all("users") if row.get("role") == "zgd"),
                key=lambda row: (row.get("login", ""), row["id"]),
            )
            for zgd in zgd_users:
                if zgd["id"] in existing_zgd_ids:
                    continue
                step = repo.create(
                    "steps",
                    {"unit_id": None, "user_id": zgd["id"], "status": StepStatus.waiting},
                )
                self._step_log(
                    repo, actor, step, "automatic_zgd_step_created",
                    event_id=self._event_id(), changes=self._changes({}, step), source="system",
                )
                created.append({"step_id": step["id"], "kind": "zgd", "user_id": zgd["id"]})
        return {"created": created, "skipped": skipped}

    def _leaf_for_cfo(self, repo: Repository, cfo_id: str) -> dict:
        step = next(
            (row for row in repo.load_all("steps") if row.get("unit_id") == cfo_id),
            None,
        )
        if not step:
            raise HTTPException(status_code=409, detail="Для ЦФО не настроен листовой шаг")
        if self._children(step["id"], self._edges(repo)):
            raise HTTPException(status_code=409, detail="Шаг ЦФО должен быть листовым")
        return step

    def _economist_step_for_cfo(self, repo: Repository, cfo_id: str) -> dict:
        leaf = self._leaf_for_cfo(repo, cfo_id)
        economist_id = self.permissions.cfo_economist_id(cfo_id)
        step = next(
            (
                get_required(repo, "steps", parent_id)
                for parent_id in self._parents(leaf["id"], self._edges(repo))
                if get_required(repo, "steps", parent_id).get("user_id") == economist_id
                and get_required(repo, "steps", parent_id).get("unit_id") is None
            ),
            None,
        )
        if not step:
            raise HTTPException(status_code=409, detail="Для ЦФО не настроен шаг экономиста")
        return step

    def _economist_cfo_ids(self, repo: Repository, step: dict) -> set[str]:
        if step.get("unit_id") or not step.get("user_id"):
            return set()
        return {
            child["unit_id"]
            for child_id in self._children(step["id"], self._edges(repo))
            if (child := repo.get_by_id("steps", child_id))
            and child.get("unit_id")
            and self.permissions.cfo_economist_id(child["unit_id"]) == step["user_id"]
        }

    def _economist_cfo_id(self, repo: Repository, step: dict) -> str | None:
        return next(iter(sorted(self._economist_cfo_ids(repo, step))), None)

    def _step_actor(self, repo: Repository, step: dict) -> dict | None:
        user_id = None if step.get("unit_id") else step.get("user_id")
        return repo.get_by_id("users", user_id) if user_id else None

    @staticmethod
    def _changes(before: dict, after: dict) -> dict:
        return {
            key: {"from": before.get(key), "to": after.get(key)}
            for key in set(before) | set(after)
            if before.get(key) != after.get(key)
        }

    def _position_log(
        self,
        repo: Repository,
        user: dict,
        position: dict,
        action: str,
        *,
        before: dict | None = None,
        after: dict | None = None,
        comment: str | None = None,
        event_id: str | None = None,
        step_id: str | None = None,
        req_item_id: str | None = None,
        request_id: str | None = None,
        **extra,
    ) -> dict:
        event_id = event_id or self._event_id()
        return repo.create(
            "cfo_position_logs",
            {
                "cfo_position_id": position["id"],
                "user_id": user["id"],
                "step_id": step_id if step_id is not None else position.get("current_step_id"),
                "log": jsonable_encoder(
                    {
                        "event_id": event_id,
                        "action": action,
                        "stage": "cfo_position",
                        "entity": "req_item" if req_item_id else "cfo_position",
                        "entity_id": req_item_id or position["id"],
                        "request_id": request_id,
                        "req_item_id": req_item_id,
                        "cfo_position_id": position["id"],
                        "step_id": step_id if step_id is not None else position.get("current_step_id"),
                        "changes": self._changes(before or {}, after or {}),
                        "comment": comment,
                        **extra,
                    }
                ),
                "created_at": now_iso(),
            },
        )

    @staticmethod
    def _step_log(
        repo: Repository,
        user: dict,
        step: dict,
        action: str,
        *,
        event_id: str,
        changes: dict | None = None,
        comment: str | None = None,
        **extra,
    ) -> dict:
        return repo.create(
            "step_logs",
            {
                "step_id": step["id"],
                "user_id": user["id"],
                "log": jsonable_encoder(
                    {
                        "event_id": event_id,
                        "action": action,
                        "stage": "approval_graph",
                        "entity": "step",
                        "entity_id": step["id"],
                        "step_id": step["id"],
                        "changes": changes or {},
                        "comment": comment,
                        **extra,
                    }
                ),
                "created_at": now_iso(),
            },
        )

    def _public_steps(self, repo: Repository, steps: list[dict]) -> list[dict]:
        edges = self._edges(repo)
        units = {row["id"]: row for row in repo.load_all("units")}
        users = {row["id"]: row for row in repo.load_all("users")}
        profiles = {row["user_id"]: row for row in repo.load_all("profiles")}
        positions = repo.load_all("cfo_positions")
        assignments = repo.load_all("units_responsibles")
        requests = repo.load_all("requests")

        def enrich_user(user_id: str | None) -> dict | None:
            account = users.get(user_id) if user_id else None
            if not account:
                return None
            return {**public_user(account), "profile": profiles.get(account["id"])}

        def employee_for(unit_id: str) -> dict | None:
            return enrich_user(next((
                assignment["user_id"]
                for assignment in assignments
                if assignment.get("unit_id") == unit_id
                and assignment.get("is_active")
                and users.get(assignment.get("user_id"), {}).get("role") == "employee"
            ), None))

        def modules_for(cfo_id: str) -> list[dict]:
            modules = [
                row for row in units.values()
                if row.get("parent_id") == cfo_id
                and not any(child.get("parent_id") == row["id"] for child in units.values())
            ]
            result = []
            for module in sorted(modules, key=lambda row: (row.get("name", ""), row["id"])):
                counts: dict[str, int] = {}
                for request in requests:
                    if request.get("unit_id") == module["id"]:
                        status = str(request.get("status"))
                        counts[status] = counts.get(status, 0) + 1
                result.append(
                    {
                        "id": module["id"],
                        "name": module["name"],
                        "responsible": employee_for(module["id"]),
                        "request_statuses": [
                            {"status": status.value, "count": counts[status.value]}
                            for status in RequestStatus
                            if counts.get(status.value)
                        ],
                    }
                )
            return result
        result = []
        for step in steps:
            actor = self._step_actor(repo, step)
            active = [row for row in positions if row.get("current_step_id") == step["id"]]
            economist_cfo_ids = sorted(self._economist_cfo_ids(repo, step))
            economist_cfo_id = economist_cfo_ids[0] if economist_cfo_ids else None
            cfo = units.get(step.get("unit_id") or economist_cfo_id)
            department = units.get(cfo.get("parent_id")) if cfo else None
            result.append(
                {
                    **step,
                    "unit": cfo,
                    "cfo": cfo,
                    "department": department,
                    "unit_path": [row["name"] for row in (department, cfo) if row],
                    "responsible": employee_for(cfo["id"]) if cfo else None,
                    "modules": modules_for(cfo["id"]) if step.get("unit_id") and cfo else [],
                    "user": enrich_user(actor["id"] if actor else None),
                    "is_economist_step": bool(economist_cfo_id),
                    "cfo_unit_id": economist_cfo_id,
                    "cfo_unit_ids": economist_cfo_ids,
                    "cfo_names": [units[cfo_id]["name"] for cfo_id in economist_cfo_ids if cfo_id in units],
                    "parent_step_ids": self._parents(step["id"], edges),
                    "child_step_ids": self._children(step["id"], edges),
                    "active_positions_count": len(active),
                }
            )
        return result

    def _validate_step_shape(
        self,
        repo: Repository,
        user_id: str | None,
        unit_id: str | None,
        *,
        exclude_step_id: str | None = None,
    ) -> None:
        if unit_id:
            get_required(repo, "units", unit_id)
            if self.permissions.unit_level(unit_id) != 2:
                raise HTTPException(status_code=422, detail="Листовой шаг относится к ЦФО")
            if user_id is not None:
                raise HTTPException(status_code=422, detail="Экономист листового шага определяется назначением ЦФО")
            if not self.permissions.cfo_economist_id(unit_id):
                raise HTTPException(status_code=409, detail="У ЦФО нет активного экономиста")
            if any(
                row["id"] != exclude_step_id and row.get("unit_id") == unit_id
                for row in repo.load_all("steps")
            ):
                raise HTTPException(status_code=409, detail="Для ЦФО уже существует листовой шаг")
            return
        if not user_id:
            raise HTTPException(status_code=422, detail="Для проверяющего укажите пользователя")
        actor = get_required(repo, "users", user_id)
        if actor.get("role") not in {"approver", "zgd"}:
            raise HTTPException(status_code=422, detail="Шаг назначается проверяющему или ЗГД")

    def list_steps(self, user: dict) -> list[dict]:
        if user.get("role") == "admin":
            self.sync_automatic_steps(user)
        steps = self.repo.load_all("steps")
        if user.get("role") == "admin":
            return self._public_steps(self.repo, steps)
        allowed: set[str] = set()
        for step in steps:
            actor = self._step_actor(self.repo, step)
            if actor and actor["id"] == user["id"]:
                allowed.add(step["id"])
        return self._public_steps(self.repo, [row for row in steps if row["id"] in allowed])

    def my_steps(self, user: dict) -> list[dict]:
        result = self.list_steps(user)
        if not result and user.get("role") not in {"admin", "economist", "approver", "zgd"}:
            raise HTTPException(status_code=403, detail="У пользователя нет шагов согласования")
        return result

    def get_step(self, user: dict, step_id: str) -> dict:
        step = get_required(self.repo, "steps", step_id)
        if user.get("role") != "admin":
            self.permissions.require_step_assignee(user, step)
        return self._public_steps(self.repo, [step])[0]

    def create_step(self, user: dict, payload: dict) -> dict:
        self.permissions.require_admin(user)
        if str(payload.get("status", StepStatus.waiting)) != StepStatus.waiting:
            raise HTTPException(status_code=422, detail="Новый шаг создаётся в статусе waiting")
        with self.repo.transaction() as repo:
            self._validate_step_shape(repo, payload.get("user_id"), payload.get("unit_id"))
            step = repo.create(
                "steps",
                {
                    "user_id": payload.get("user_id"),
                    "unit_id": payload.get("unit_id"),
                    "status": StepStatus.waiting,
                },
            )
            event_id = self._event_id()
            self._step_log(
                repo, user, step, "step_created", event_id=event_id,
                changes=self._changes({}, step),
            )
            child_id = payload.get("child_step_id")
            if child_id:
                self._create_edge(repo, user, step["id"], child_id, event_id)
        return self._public_steps(self.repo, [step])[0]

    def update_step(self, user: dict, step_id: str, patch: dict) -> dict:
        self.permissions.require_admin(user)
        with self.repo.transaction() as repo:
            before = repo.lock_by_id("steps", step_id)
            if not before:
                raise HTTPException(status_code=404, detail="Шаг не найден")
            if "status" in patch and patch["status"] != before.get("status"):
                raise HTTPException(status_code=403, detail="Статус шага не редактируется напрямую")
            automatic_actor = self._step_actor(repo, before)
            if (
                before.get("unit_id")
                or self._economist_cfo_id(repo, before)
                or automatic_actor and automatic_actor.get("role") == "zgd"
            ):
                raise HTTPException(status_code=403, detail="Automatic route anchors cannot be reassigned")
            candidate_user = patch.get("user_id", before.get("user_id"))
            candidate_unit = patch.get("unit_id", before.get("unit_id"))
            self._validate_step_shape(
                repo, candidate_user, candidate_unit, exclude_step_id=step_id
            )
            effective = {key: value for key, value in patch.items() if key != "status"}
            after = repo.update("steps", step_id, effective)
            self._step_log(
                repo, user, after, "step_updated", event_id=self._event_id(),
                changes=self._changes(before, after),
            )
        return self._public_steps(self.repo, [after])[0]

    def delete_step(self, user: dict, step_id: str) -> None:
        self.permissions.require_admin(user)
        if any(row.get("current_step_id") == step_id for row in self.repo.load_all("cfo_positions")):
            raise HTTPException(status_code=409, detail="На шаге есть активные позиции")
        with self.repo.transaction() as repo:
            step = get_required(repo, "steps", step_id)
            actor = self._step_actor(repo, step)
            if (
                step.get("unit_id")
                or self._economist_cfo_id(repo, step)
                or actor and actor.get("role") == "zgd"
            ):
                raise HTTPException(status_code=403, detail="Automatic route anchors cannot be deleted")
            self._step_log(repo, user, step, "step_deleted", event_id=self._event_id())
            repo.delete("steps", step_id)

    def _assert_graph(self, repo: Repository, *, require_complete: bool = False) -> None:
        steps = self._steps(repo)
        edges = self._edges(repo)
        for step in steps.values():
            parents = self._parents(step["id"], edges)
            children = self._children(step["id"], edges)
            actor = self._step_actor(repo, step)
            if step.get("unit_id") and children:
                raise HTTPException(status_code=409, detail="Шаг ЦФО должен быть листовым")
            if actor and actor.get("role") == "zgd" and parents:
                raise HTTPException(status_code=409, detail="Шаг ЗГД должен быть корневым")
            if require_complete and actor and actor.get("role") != "zgd" and not parents:
                raise HTTPException(status_code=409, detail="Маршрут должен завершаться шагом ЗГД")
        state: dict[str, int] = {}

        def visit(step_id: str) -> None:
            if state.get(step_id) == 1:
                raise HTTPException(status_code=409, detail="В графе согласования обнаружен цикл")
            if state.get(step_id) == 2:
                return
            state[step_id] = 1
            for child_id in self._children(step_id, edges):
                visit(child_id)
            state[step_id] = 2

        for step_id in steps:
            visit(step_id)

    def _create_edge(
        self,
        repo: Repository,
        user: dict,
        parent_id: str,
        child_id: str,
        event_id: str,
    ) -> dict:
        parent = get_required(repo, "steps", parent_id)
        child = get_required(repo, "steps", child_id)
        if parent_id == child_id:
            raise HTTPException(status_code=422, detail="Шаг нельзя связать с самим собой")
        edge = repo.create(
            "step_edges", {"parent_step_id": parent_id, "child_step_id": child_id}
        )
        try:
            self._assert_graph(repo)
        except Exception:
            repo.delete_where("step_edges", edge)
            raise
        self._step_log(
            repo, user, parent, "step_edge_created", event_id=event_id,
            parent_step_id=parent_id, child_step_id=child_id,
        )
        return edge

    def create_edge(self, user: dict, payload: dict) -> dict:
        self.permissions.require_admin(user)
        with self.repo.transaction() as repo:
            return self._create_edge(
                repo, user, payload["parent_step_id"], payload["child_step_id"], self._event_id()
            )

    def preview_delete_edge(self, user: dict, payload: dict) -> dict:
        self.permissions.require_admin(user)
        edges = self.repo.load_all("step_edges")
        exists = any(
            row.get("parent_step_id") == payload["parent_step_id"]
            and row.get("child_step_id") == payload["child_step_id"]
            for row in edges
        )
        parent = self.repo.get_by_id("steps", payload["parent_step_id"])
        child = self.repo.get_by_id("steps", payload["child_step_id"])
        removes_economist_assignment = bool(
            parent
            and child
            and child.get("unit_id")
            and child["unit_id"] in self._economist_cfo_ids(self.repo, parent)
        )

        units = {row["id"]: row for row in self.repo.load_all("units")}
        users = {row["id"]: row for row in self.repo.load_all("users")}
        profiles = {row["user_id"]: row for row in self.repo.load_all("profiles")}

        def graph_node(step: dict) -> dict:
            account = users.get(step.get("user_id"))
            if step.get("unit_id"):
                return {
                    "id": step["id"],
                    "label": units.get(step["unit_id"], {}).get("name", "ЦФО"),
                    "kind": "leaf",
                }
            role = account.get("role") if account else None
            profile = profiles.get(account["id"]) if account else None
            full_name = " ".join(
                part for part in (
                    profile.get("last_name") if profile else None,
                    profile.get("name") if profile else None,
                    profile.get("second_name") if profile else None,
                ) if part
            )
            label = full_name or (account.get("login") if account else "Не назначен")
            return {
                "id": step["id"],
                "label": ("ЗГД · " if role == "zgd" else "") + label,
                "kind": "zgd" if role == "zgd" else "review",
            }

        steps = self.repo.load_all("steps")
        before_edges = [
            {"parent_step_id": row["parent_step_id"], "child_step_id": row["child_step_id"]}
            for row in edges
        ]
        after_edges = [
            row for row in before_edges
            if not (
                row["parent_step_id"] == payload["parent_step_id"]
                and row["child_step_id"] == payload["child_step_id"]
            )
        ]
        leaf_ids: set[str] = set()
        children_by_parent: dict[str, list[str]] = {}
        for edge in before_edges:
            children_by_parent.setdefault(edge["parent_step_id"], []).append(edge["child_step_id"])
        pending = [payload["child_step_id"]]
        while pending:
            step_id = pending.pop()
            if step_id in leaf_ids:
                continue
            leaf_ids.add(step_id)
            pending.extend(children_by_parent.get(step_id, []))
        affected_leaf_count = sum(
            1 for step in steps if step["id"] in leaf_ids and step.get("unit_id")
        )
        impacted = [
            row["id"]
            for row in self.repo.load_all("cfo_positions")
            if (
                row.get("cfo_unit_id") == child.get("unit_id")
                if removes_economist_assignment and child else row.get("current_step_id") in set(payload.values())
            )
            and row.get("current_step_id") in set(payload.values())
        ]
        return {
            "exists": exists,
            "impacted_position_ids": impacted,
            "removed_edge": payload,
            "before_graph": {"nodes": [graph_node(step) for step in steps], "edges": before_edges},
            "after_graph": {"nodes": [graph_node(step) for step in steps], "edges": after_edges},
            "affected_leaf_count": affected_leaf_count,
            "has_approved_past": False,
            "approved_past_count": 0,
            "removes_economist_assignment": removes_economist_assignment,
            "assignment_removal_reason": "Удаление связи снимет назначение этого экономиста с данного ЦФО. Остальные ЦФО экономиста не изменятся.",
        }

    def delete_edge(self, user: dict, payload: dict) -> None:
        self.permissions.require_admin(user)
        preview = self.preview_delete_edge(user, payload)
        if preview["impacted_position_ids"]:
            raise HTTPException(status_code=409, detail="Связь используется активными позициями")
        with self.repo.transaction() as repo:
            parent = get_required(repo, "steps", payload["parent_step_id"])
            child = get_required(repo, "steps", payload["child_step_id"])
            if not repo.delete_where("step_edges", payload):
                raise HTTPException(status_code=404, detail="Связь шагов не найдена")
            if preview["removes_economist_assignment"]:
                repo.update_where(
                    "units_responsibles",
                    {
                        "unit_id": child["unit_id"],
                        "user_id": parent["user_id"],
                        "is_active": True,
                    },
                    {"is_active": False},
                )
            self._step_log(
                repo, user, parent, "step_edge_deleted", event_id=self._event_id(), **payload
            )
            if preview["removes_economist_assignment"]:
                self._step_log(
                    repo, user, parent, "economist_unassigned_from_cfo_by_route",
                    event_id=self._event_id(), cfo_unit_id=child["unit_id"],
                )

    def validate_graph(self, user: dict) -> dict:
        self.permissions.require_admin(user)
        self._assert_graph(self.repo, require_complete=True)
        return {
            "valid": True,
            "steps_count": len(self.repo.load_all("steps")),
            "edges_count": len(self.repo.load_all("step_edges")),
            "root_step_ids": self._root_ids(self.repo),
        }

    def bootstrap_reviewed_leaf_steps(self, user: dict) -> dict:
        self.permissions.require_admin(user)
        return self.sync_automatic_steps(user)

    def _position_items(self, repo: Repository, position_id: str) -> list[dict]:
        return [
            row for row in repo.load_all("req_items")
            if row.get("cfo_position_id") == position_id
            and row.get("status") != ItemStatus.deleted
        ]

    def public_position(self, position: dict, *, repo: Repository | None = None) -> dict:
        storage = repo or self.repo
        units = {row["id"]: row for row in storage.load_all("units")}
        requests = {row["id"]: row for row in storage.load_all("requests")}
        users = {row["id"]: row for row in storage.load_all("users")}
        items = self._position_items(storage, position["id"])
        accepted = [row for row in items if row.get("status") in APPROVED_ITEM_STATUSES]
        contributions = []
        for item in items:
            request = requests.get(item["request_id"], {})
            contributions.append(
                {
                    **item,
                    "request": request,
                    "module": units.get(request.get("unit_id")),
                    "author": (
                        public_user(users[request["created_by_id"]])
                        if request.get("created_by_id") in users
                        else None
                    ),
                }
            )
        article = storage.get_by_id(
            "dds_catalog" if position.get("dds_id") else "invests_catalog",
            position.get("dds_id") or position.get("invest_id"),
        )
        return {
            **position,
            "cfo": units.get(position["cfo_unit_id"]),
            "article": article,
            "sum_plan": sum(float(row.get("sum_plan") or 0) for row in accepted),
            "sum_fact": sum(float(row.get("sum_fact") or 0) for row in accepted),
            "items_count": len(items),
            "contributions": contributions,
            "current_step": (
                self._public_steps(storage, [get_required(storage, "steps", position["current_step_id"])])[0]
                if position.get("current_step_id")
                else None
            ),
        }

    def list_positions(
        self,
        user: dict,
        *,
        budget_year: int | None = None,
        cfo_unit_id: str | None = None,
        status: str | None = None,
    ) -> list[dict]:
        visible = self.permissions.visible_position_ids(user)
        rows = [
            row for row in self.repo.load_all("cfo_positions")
            if (visible is None or row["id"] in visible)
            and (budget_year is None or int(row["budget_year"]) == budget_year)
            and (cfo_unit_id is None or row["cfo_unit_id"] == cfo_unit_id)
            and (status is None or row["status"] == status)
        ]
        return [self.public_position(row) for row in rows]

    def get_position(self, user: dict, position_id: str) -> dict:
        position = get_required(self.repo, "cfo_positions", position_id)
        self.permissions.require_view_position(user, position)
        return self.public_position(position)

    def _notify(
        self,
        repo: Repository,
        user_id: str | None,
        notification_type: str,
        payload: dict,
    ) -> None:
        if user_id and self.notifications:
            self.notifications.create(user_id, notification_type, payload, repo=repo)

    def submit_to_economist(self, user: dict, position_id: str, comment: str = "") -> dict:
        self.sync_automatic_steps(user)
        with self.repo.transaction() as repo:
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position:
                raise HTTPException(status_code=404, detail="Позиция не найдена")
            if (
                user.get("role") != "employee"
                or position["cfo_unit_id"] not in self.permissions.employee_cfo_ids(user["id"])
            ):
                raise HTTPException(status_code=403, detail="Позиция относится к другому ЦФО")
            if position.get("frozen") or position.get("fixed"):
                raise HTTPException(status_code=409, detail="Позиция заморожена")
            if position.get("status") not in {CfoPositionStatus.waiting, CfoPositionStatus.on_revision}:
                raise HTTPException(status_code=409, detail="Позицию нельзя передать на этом этапе")
            economist_step = self._economist_step_for_cfo(repo, position["cfo_unit_id"])
            before = dict(position)
            after = repo.update(
                "cfo_positions", position_id,
                {"status": CfoPositionStatus.on_approval, "current_step_id": economist_step["id"]},
            )
            event_id = self._event_id()
            self._position_log(
                repo, user, after, "position_sent_to_economist", before=before,
                after=after, comment=comment, event_id=event_id, step_id=economist_step["id"],
            )
            self._step_log(
                repo, user, economist_step, "position_received", event_id=event_id,
                comment=comment, cfo_position_id=position_id,
            )
            economist_id = self.permissions.cfo_economist_id(position["cfo_unit_id"])
            self._notify(
                repo, economist_id, "cfo_position.assigned",
                {"cfo_position_id": position_id, "reload_required": True},
            )
        result = self.public_position(after)
        result["notification_user_ids"] = [economist_id] if economist_id else []
        return result

    def _require_economist_work(self, user: dict, position: dict) -> dict:
        self.permissions.require_economist_position_access(user, position)
        step = get_required(self.repo, "steps", position.get("current_step_id"))
        if self._economist_cfo_id(self.repo, step) != position["cfo_unit_id"]:
            raise HTTPException(status_code=409, detail="Позиция не находится на шаге экономиста")
        if position.get("frozen") or position.get("fixed"):
            raise HTTPException(status_code=409, detail="Позиция заморожена")
        return step

    def _decide_item_economist(
        self,
        repo: Repository,
        user: dict,
        position: dict,
        item_id: str,
        payload: dict,
    ) -> dict:
        item = get_required(repo, "req_items", item_id)
        if item.get("cfo_position_id") != position["id"]:
            raise HTTPException(status_code=409, detail="Строка не относится к позиции")
        decision_payload = dict(payload)
        month_plans = decision_payload.pop("month_plans", None)
        normalized_plans = None
        if month_plans is not None:
            if not item.get("is_income"):
                raise HTTPException(
                    status_code=422,
                    detail="Помесячный план доступен только для доходной строки",
                )
            normalized_plans, approved_total = BudgetItemService._validate_month_plans(
                month_plans
            )
            decision_payload["sum_fact"] = approved_total
        elif (
            item.get("is_income")
            and decision_payload.get("sum_fact") is not None
            and BudgetItemService._decimal(decision_payload["sum_fact"])
            != BudgetItemService._decimal(item["sum_plan"])
        ):
            raise HTTPException(
                status_code=422,
                detail="Изменённую сумму дохода распределите по месяцам",
            )
        before = dict(item)
        after = repo.update(
            "req_items",
            item_id,
            BudgetItemService.normalize_decision(item, decision_payload),
        )
        if normalized_plans is not None:
            BudgetItemService._replace_month_plans(repo, item_id, normalized_plans)
        self._position_log(
            repo, user, position, "economist_item_decided",
            before=before, after=after, comment=payload.get("comment"),
            req_item_id=item_id, request_id=item["request_id"],
        )
        return after

    def decide_item_economist(
        self, user: dict, position_id: str, item_id: str, payload: dict
    ) -> dict:
        with self.repo.transaction() as repo:
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position:
                raise HTTPException(status_code=404, detail="Позиция не найдена")
            self._require_economist_work(user, position)
            after = self._decide_item_economist(
                repo, user, position, item_id, payload
            )
        return after

    def bulk_decide_economist(self, user: dict, position_id: str, payload: dict) -> list[dict]:
        with self.repo.transaction() as repo:
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position:
                raise HTTPException(status_code=404, detail="Позиция не найдена")
            self._require_economist_work(user, position)
            return [
                self._decide_item_economist(
                    repo,
                    user,
                    position,
                    item_id,
                    {
                        "decision": payload["decision"],
                        "comment": payload.get("comment", ""),
                    },
                )
                for item_id in payload["item_ids"]
            ]

    def _economist_decided_item_ids(self, repo: Repository, position_id: str) -> set[str]:
        return {
            (row.get("log") or {}).get("req_item_id")
            for row in repo.load_all("cfo_position_logs")
            if row.get("cfo_position_id") == position_id
            and (row.get("log") or {}).get("action") == "economist_item_decided"
        }

    def complete_economist_review(self, user: dict, position_id: str, comment: str = "") -> dict:
        with self.repo.transaction() as repo:
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position:
                raise HTTPException(status_code=404, detail="Позиция не найдена")
            self._require_economist_work(user, position)
            items = self._position_items(repo, position_id)
            decided = self._economist_decided_item_ids(repo, position_id)
            pending = [
                row["id"] for row in items
                if row["id"] not in decided or row.get("status") == ItemStatus.on_review
            ]
            if not items or pending:
                raise HTTPException(
                    status_code=409,
                    detail={"message": "Не все строки рассмотрены экономистом", "item_ids": pending},
                )
            before = dict(position)
            after = repo.update(
                "cfo_positions", position_id, {"status": CfoPositionStatus.approved}
            )
            self._position_log(
                repo, user, after, "economist_review_completed",
                before=before, after=after, comment=comment,
            )
        return self.public_position(after)

    def freeze_position(self, user: dict, position_id: str, comment: str = "") -> dict:
        with self.repo.transaction() as repo:
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position:
                raise HTTPException(status_code=404, detail="Позиция не найдена")
            leaf = self._require_economist_work(user, position)
            if position.get("status") != CfoPositionStatus.approved:
                raise HTTPException(status_code=409, detail="Сначала завершите проверку строк")
            parents = self._parents(leaf["id"], self._edges(repo))
            if len(parents) != 1:
                raise HTTPException(status_code=409, detail="У листового шага должен быть один родитель")
            next_step = get_required(repo, "steps", parents[0])
            before = dict(position)
            after = repo.update(
                "cfo_positions", position_id,
                {
                    "frozen": True,
                    "status": CfoPositionStatus.on_approval,
                    "current_step_id": next_step["id"],
                },
            )
            event_id = self._event_id()
            self._position_log(
                repo, user, after, "position_frozen_and_forwarded",
                before=before, after=after, comment=comment, event_id=event_id,
                step_id=next_step["id"],
            )
            self._step_log(
                repo, user, next_step, "position_received", event_id=event_id,
                comment=comment, cfo_position_id=position_id,
            )
            self._notify(
                repo, next_step.get("user_id"), "cfo_position.assigned",
                {"cfo_position_id": position_id, "step_id": next_step["id"]},
            )
        result = self.public_position(after)
        result["notification_user_ids"] = [next_step["user_id"]] if next_step.get("user_id") else []
        return result

    def unfreeze_position(self, user: dict, position_id: str, comment: str = "") -> dict:
        with self.repo.transaction() as repo:
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position:
                raise HTTPException(status_code=404, detail="Позиция не найдена")
            self.permissions.require_economist_position_access(user, position)
            if position.get("fixed"):
                raise HTTPException(status_code=409, detail="Зафиксированную позицию нельзя разморозить")
            current = get_required(repo, "steps", position.get("current_step_id"))
            if self._economist_cfo_id(repo, current) != position["cfo_unit_id"]:
                raise HTTPException(status_code=409, detail="Позицию ещё не вернули экономисту")
            before = dict(position)
            after = repo.update(
                "cfo_positions", position_id,
                {
                    "frozen": False,
                    "status": CfoPositionStatus.on_approval,
                },
            )
            self._position_log(
                repo, user, after, "position_unfrozen",
                before=before, after=after, comment=comment,
            )
        return self.public_position(after)

    def list_step_positions(self, user: dict, step_id: str) -> list[dict]:
        step = get_required(self.repo, "steps", step_id)
        if user.get("role") != "admin":
            self.permissions.require_step_assignee(user, step)
        return [
            self.public_position(row)
            for row in self.repo.load_all("cfo_positions")
            if row.get("current_step_id") == step_id
        ]

    def step_dashboard(self, user: dict, step_id: str) -> dict:
        positions = self.list_step_positions(user, step_id)
        return {
            "step": self.get_step(user, step_id),
            "positions": positions,
            "totals": {
                "positions_count": len(positions),
                "sum_plan": sum(row["sum_plan"] for row in positions),
                "sum_fact": sum(row["sum_fact"] for row in positions),
            },
        }

    def approve_position_at_step(
        self, user: dict, step_id: str, position_id: str, comment: str = ""
    ) -> dict:
        with self.repo.transaction() as repo:
            step = get_required(repo, "steps", step_id)
            self.permissions.require_step_assignee(user, step)
            if step.get("unit_id") or self._economist_cfo_id(repo, step):
                raise HTTPException(status_code=409, detail="Используйте команды экономиста")
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position or position.get("current_step_id") != step_id:
                raise HTTPException(status_code=409, detail="Позиция не находится на этом шаге")
            if not position.get("frozen"):
                raise HTTPException(status_code=409, detail="Позиция должна быть заморожена")
            parents = self._parents(step_id, self._edges(repo))
            actor = get_required(repo, "users", step["user_id"])
            before = dict(position)
            if actor.get("role") == "zgd":
                if parents:
                    raise HTTPException(status_code=409, detail="Шаг ЗГД должен завершать маршрут")
                patch = {
                    "fixed": True,
                    "status": CfoPositionStatus.approved,
                    "current_step_id": None,
                }
                action = "position_fixed"
                next_step = None
            else:
                if len(parents) != 1:
                    raise HTTPException(status_code=409, detail="У шага должен быть один родитель")
                next_step = get_required(repo, "steps", parents[0])
                patch = {
                    "status": CfoPositionStatus.on_approval,
                    "current_step_id": next_step["id"],
                }
                action = "position_approved_at_step"
            after = repo.update("cfo_positions", position_id, patch)
            if patch.get("fixed"):
                sync_annual_budgets(repo)
            event_id = self._event_id()
            self._position_log(
                repo, user, after, action, before=before, after=after,
                comment=comment, event_id=event_id, step_id=step_id,
            )
            self._step_log(
                repo, user, step, action, event_id=event_id, comment=comment,
                cfo_position_id=position_id,
            )
            notify_id = next_step.get("user_id") if next_step else None
            self._notify(
                repo, notify_id, "cfo_position.assigned",
                {"cfo_position_id": position_id, "step_id": next_step["id"] if next_step else None},
            )
        result = self.public_position(after)
        result["notification_user_ids"] = [notify_id] if notify_id else []
        return result

    def approve_step(self, user: dict, step_id: str, position_ids: list[str]) -> dict:
        available = self.list_step_positions(user, step_id)
        selected = position_ids or [row["id"] for row in available]
        return {
            "positions": [
                self.approve_position_at_step(user, step_id, position_id)
                for position_id in selected
            ]
        }

    def return_position(
        self,
        user: dict,
        step_id: str,
        position_id: str,
        target_step_id: str,
        comment: str,
    ) -> dict:
        with self.repo.transaction() as repo:
            step = get_required(repo, "steps", step_id)
            self.permissions.require_step_assignee(user, step)
            position = repo.lock_by_id("cfo_positions", position_id)
            if not position or position.get("current_step_id") != step_id:
                raise HTTPException(status_code=409, detail="Позиция не находится на этом шаге")
            children = self._children(step_id, self._edges(repo))
            if target_step_id not in children:
                raise HTTPException(status_code=422, detail="Возврат возможен на непосредственный дочерний шаг")
            target = get_required(repo, "steps", target_step_id)
            before = dict(position)
            after = repo.update(
                "cfo_positions", position_id,
                {"status": CfoPositionStatus.on_revision, "current_step_id": target_step_id},
            )
            event_id = self._event_id()
            self._position_log(
                repo, user, after, "position_returned", before=before, after=after,
                comment=comment, event_id=event_id, step_id=step_id,
                target_step_id=target_step_id,
            )
            self._step_log(
                repo, user, step, "position_returned", event_id=event_id,
                comment=comment, cfo_position_id=position_id, target_step_id=target_step_id,
            )
            notify_id = (
                self.permissions.cfo_economist_id(target["unit_id"])
                if target.get("unit_id")
                else target.get("user_id")
            )
            self._notify(
                repo, notify_id, "cfo_position.returned",
                {"cfo_position_id": position_id, "step_id": target_step_id, "comment": comment},
            )
        result = self.public_position(after)
        result["notification_user_ids"] = [notify_id] if notify_id else []
        return result

    def position_logs(self, user: dict, position_id: str) -> list[dict]:
        position = get_required(self.repo, "cfo_positions", position_id)
        self.permissions.require_view_position(user, position)
        return sorted(
            [
                row for row in self.repo.load_all("cfo_position_logs")
                if row.get("cfo_position_id") == position_id
            ],
            key=lambda row: str(row.get("created_at") or ""),
            reverse=True,
        )

    def request_history(self, user: dict, request_id: str) -> list[dict]:
        request = get_required(self.repo, "requests", request_id)
        self.permissions.require_view_request(user, request)
        item_ids = {
            row["id"] for row in self.repo.load_all("req_items")
            if row.get("request_id") == request_id
        }
        logs = [
            {**row, "source": "request"}
            for row in self.repo.load_all("req_logs")
            if row.get("req_id") == request_id
        ]
        logs += [
            {**row, "source": "cfo_position"}
            for row in self.repo.load_all("cfo_position_logs")
            if (row.get("log") or {}).get("request_id") == request_id
            or (row.get("log") or {}).get("req_item_id") in item_ids
        ]
        return sorted(logs, key=lambda row: str(row.get("created_at") or ""), reverse=True)

    def step_logs(self, user: dict, step_id: str, **filters) -> list[dict]:
        step = get_required(self.repo, "steps", step_id)
        self.permissions.require_step_log_access(user, step)
        return sorted(
            [row for row in self.repo.load_all("step_logs") if row.get("step_id") == step_id],
            key=lambda row: str(row.get("created_at") or ""),
            reverse=True,
        )

    def all_step_logs(self, user: dict, **filters) -> list[dict]:
        self.permissions.require_admin(user)
        rows = self.repo.load_all("step_logs")
        if filters.get("step_id"):
            rows = [row for row in rows if row.get("step_id") == filters["step_id"]]
        return sorted(rows, key=lambda row: str(row.get("created_at") or ""), reverse=True)

    # Explicit failures for removed request-based downstream operations.
    def request_approval_step(self, user: dict, request_id: str):
        raise HTTPException(status_code=410, detail="Согласование выполняется по позициям ЦФО")

    request_approval_route = request_approval_step

    def list_step_requests(self, user: dict, step_id: str):
        raise HTTPException(status_code=410, detail="Используйте /steps/{id}/positions")

    def approve_request_at_step(self, *args, **kwargs):
        raise HTTPException(status_code=410, detail="Согласование выполняется по позициям ЦФО")

    def return_requests(self, *args, **kwargs):
        raise HTTPException(status_code=410, detail="Возврат выполняется по позиции ЦФО")

    def revoke_final_approval(self, *args, **kwargs):
        raise HTTPException(status_code=410, detail="Фиксация относится к позиции ЦФО")

    def resume_economist_review(self, *args, **kwargs):
        raise HTTPException(status_code=410, detail="Используйте разморозку позиции ЦФО")
