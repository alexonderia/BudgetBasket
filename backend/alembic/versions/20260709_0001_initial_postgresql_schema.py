"""initial postgresql schema

Revision ID: 20260709_0001
Revises:
Create Date: 2026-07-09
"""

from alembic import op

from app.database import metadata

revision = "20260709_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    metadata.create_all(op.get_bind())


def downgrade() -> None:
    metadata.drop_all(op.get_bind())
