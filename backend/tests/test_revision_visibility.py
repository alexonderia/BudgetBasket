from app.services.common import request_returned_item_ids


class LogRepo:
    def __init__(self, rows):
        self.rows = rows

    def load_all(self, collection):
        return self.rows if collection == "req_logs" else []


def test_position_returned_marks_lines_as_revision() -> None:
    repo = LogRepo([
        {
            "req_id": "request-1",
            "id": 1,
            "created_at": "2026-10-23T10:00:00",
            "log": {"action": "position_returned", "item_ids": ["item-1", "item-2"]},
        },
    ])

    assert request_returned_item_ids(repo, "request-1") == {"item-1", "item-2"}


def test_resubmission_clears_previous_revision() -> None:
    repo = LogRepo([
        {
            "req_id": "request-1",
            "id": 1,
            "created_at": "2026-10-23T10:00:00",
            "log": {"action": "position_returned", "item_ids": ["item-1"]},
        },
        {
            "req_id": "request-1",
            "id": 2,
            "created_at": "2026-10-23T11:00:00",
            "log": {"action": "request_revision_resubmitted_to_cfo", "item_ids": ["item-1"]},
        },
    ])

    assert request_returned_item_ids(repo, "request-1") == set()
