"""add budget frozen flag to requests

Revision ID: 20260709_0003
Revises: 20260709_0002
Create Date: 2026-07-09
"""

from alembic import op
import sqlalchemy as sa

revision = "20260709_0003"
down_revision = "20260709_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "requests",
        sa.Column("budget_frozen", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("requests", "budget_frozen")
