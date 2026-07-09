"""remove extra timestamp columns

Revision ID: 20260709_0002
Revises: 20260709_0001
Create Date: 2026-07-09
"""

from alembic import op

revision = "20260709_0002"
down_revision = "20260709_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in (
        "users",
        "profiles",
        "units",
        "dds_catalog",
        "invests_catalog",
        "dds_items",
        "invest_items",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_updated_at ON {table}")
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS updated_at")
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS created_at")

    for table in (
        "units_responsibles",
        "storage_objects",
        "files",
        "dds_item_files",
        "invest_item_files",
    ):
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS created_at")

    op.execute("DROP INDEX IF EXISTS idx_requests_created_at")


def downgrade() -> None:
    for table in (
        "users",
        "profiles",
        "units",
        "dds_catalog",
        "invests_catalog",
        "dds_items",
        "invest_items",
    ):
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()")
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()")

    for table in (
        "units_responsibles",
        "storage_objects",
        "files",
        "dds_item_files",
        "invest_item_files",
    ):
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()")

    for table in (
        "users",
        "profiles",
        "units",
        "dds_catalog",
        "invests_catalog",
        "dds_items",
        "invest_items",
    ):
        op.execute(
            f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_{table}_updated_at'
                ) THEN
                    CREATE TRIGGER trg_{table}_updated_at
                    BEFORE UPDATE ON {table}
                    FOR EACH ROW
                    EXECUTE FUNCTION set_updated_at();
                END IF;
            END $$;
            """
        )

    op.execute("CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at DESC)")
