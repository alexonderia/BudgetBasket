from app.models import CfoPositionStatus, ItemStatus, RequestStatus
from app.services.common import derived_request_status_with_positions


def _approved_item(item_id: str = "item-1") -> dict:
    return {
        "id": item_id,
        "status": ItemStatus.approved_with_changes,
        "frozen": True,
        "fixed": True,
    }


def test_request_stays_on_review_while_position_is_on_revision() -> None:
    items = [_approved_item()]
    positions = [{"id": "position-1", "status": CfoPositionStatus.on_revision}]

    assert derived_request_status_with_positions(items, positions) == RequestStatus.on_review


def test_request_is_approved_when_all_positions_are_closed() -> None:
    items = [_approved_item()]
    positions = [{"id": "position-1", "status": CfoPositionStatus.approved}]

    assert derived_request_status_with_positions(items, positions) == RequestStatus.approved


def test_rejected_request_is_not_reopened_by_a_stale_position() -> None:
    items = [{"id": "item-1", "status": ItemStatus.rejected}]
    positions = [{"id": "position-1", "status": CfoPositionStatus.on_revision}]

    assert derived_request_status_with_positions(items, positions) == RequestStatus.rejected
