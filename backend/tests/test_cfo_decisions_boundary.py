"""The CFO decision boundary must be scoped to the lines that were returned.

A revision return for one CFO position used to invalidate earlier decisions of
every other line in the same request.  The register kept showing those lines as
approved, while ``submit_to_economist`` counted them as undecided and blocked
the economist.
"""

from app.services.approval_service import ApprovalService


class LogRepo:
    def __init__(self, rows):
        self.rows = rows

    def load_all(self, collection):
        return self.rows if collection == "req_logs" else []


def _log(req_id: str, row_id: int, created_at: str, action: str, **fields) -> dict:
    return {
        "req_id": req_id,
        "id": row_id,
        "created_at": created_at,
        "log": {"action": action, **fields},
    }


def _decision(req_id: str, row_id: int, created_at: str, item_id: str, decision: str) -> dict:
    return _log(
        req_id,
        row_id,
        created_at,
        "cfo_item_decided",
        entity="req_item",
        entity_id=item_id,
        decision=decision,
    )


def test_boundary_keeps_decision_of_a_line_that_was_not_returned() -> None:
    repo = LogRepo([
        _decision("request-1", 1, "2026-10-26T07:06:54", "income", "approved"),
        _log(
            "request-1",
            2,
            "2026-10-26T11:49:19",
            "cfo_items_returned_for_revision",
            item_ids=["other"],
        ),
        _log(
            "request-1",
            3,
            "2026-10-26T11:49:58",
            "request_revision_resubmitted_to_cfo",
            item_ids=["other"],
        ),
    ])

    assert ApprovalService._cfo_decisions_after_boundary(repo, "request-1") == {
        "income": "approved",
    }


def test_boundary_drops_old_decision_of_a_returned_line() -> None:
    repo = LogRepo([
        _decision("request-1", 1, "2026-10-26T07:00:00", "other", "approved"),
        _log(
            "request-1",
            2,
            "2026-10-26T11:49:19",
            "cfo_items_returned_for_revision",
            item_ids=["other"],
        ),
    ])

    assert ApprovalService._cfo_decisions_after_boundary(repo, "request-1") == {}


def test_boundary_accepts_a_new_decision_for_a_returned_line() -> None:
    repo = LogRepo([
        _decision("request-1", 1, "2026-10-26T07:00:00", "other", "approved"),
        _log(
            "request-1",
            2,
            "2026-10-26T11:49:19",
            "cfo_items_returned_for_revision",
            item_ids=["other"],
        ),
        _decision("request-1", 3, "2026-10-26T11:50:00", "other", "rejected"),
    ])

    assert ApprovalService._cfo_decisions_after_boundary(repo, "request-1") == {
        "other": "rejected",
    }


def test_request_restored_still_clears_every_decision() -> None:
    repo = LogRepo([
        _decision("request-1", 1, "2026-10-26T07:00:00", "income", "approved"),
        _log("request-1", 2, "2026-10-26T08:00:00", "request_restored"),
    ])

    assert ApprovalService._cfo_decisions_after_boundary(repo, "request-1") == {}


def test_legacy_boundary_without_item_ids_still_resets_the_request() -> None:
    repo = LogRepo([
        _decision("request-1", 1, "2026-10-26T07:00:00", "income", "approved"),
        _log("request-1", 2, "2026-10-26T11:49:19", "cfo_items_returned_for_revision"),
    ])

    assert ApprovalService._cfo_decisions_after_boundary(repo, "request-1") == {}
