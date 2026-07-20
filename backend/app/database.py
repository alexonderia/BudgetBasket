from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    Numeric,
    PrimaryKeyConstraint,
    Table,
    Text,
    create_engine,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PgUUID
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker


metadata = MetaData()


def uuid_pk() -> Column:
    return Column("id", PgUUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))


users = Table(
    "users", metadata, uuid_pk(),
    Column("login", Text, nullable=False, unique=True),
    Column("password", Text, nullable=False),
    Column("role", Text, nullable=False),
    CheckConstraint("role IN ('admin', 'economist', 'employee')", name="users_role_chk"),
    Index("idx_users_role", "role"),
)

profiles = Table(
    "profiles", metadata,
    Column("user_id", PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("name", Text, nullable=False), Column("second_name", Text), Column("last_name", Text, nullable=False),
    Column("phone", Text), Column("email", Text), Column("max_link", Text),
)

units = Table(
    "units", metadata, uuid_pk(),
    Column("parent_id", PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="SET NULL")),
    Column("name", Text, nullable=False),
    Column("is_active", Boolean, nullable=False, server_default=text("true")),
    Column("uses_invest_projects", Boolean, nullable=False, server_default=text("false")),
    Column("annual_budget", Numeric(14, 2), nullable=False, server_default=text("0")),
    CheckConstraint("annual_budget >= 0", name="units_annual_budget_chk"),
    Index("idx_units_parent_id", "parent_id"), Index("idx_units_is_active", "is_active"),
)

units_responsibles = Table(
    "units_responsibles", metadata,
    Column("unit_id", PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="CASCADE"), nullable=False),
    Column("user_id", PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("is_active", Boolean, nullable=False, server_default=text("true")),
    PrimaryKeyConstraint("unit_id", "user_id"),
    Index("idx_units_responsibles_user_id", "user_id"), Index("idx_units_responsibles_active", "is_active"),
)

requests = Table(
    "requests", metadata, uuid_pk(),
    Column("economist_id", PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")),
    Column("unit_id", PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False),
    Column("status", Text, nullable=False, server_default=text("'draft'")),
    Column("sum_plan", Numeric(14, 2), nullable=False, server_default=text("0")),
    Column("sum_fact", Numeric(14, 2), nullable=False, server_default=text("0")),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()),
    Column("frozen", Boolean, nullable=False, server_default=text("false")),
    CheckConstraint("sum_plan >= 0", name="requests_sum_plan_chk"),
    CheckConstraint("sum_fact >= 0", name="requests_sum_fact_chk"),
    CheckConstraint("status IN ('draft', 'on_review', 'approved', 'approved_with_changes', 'partially_approved', 'rejected', 'cancelled')", name="requests_status_chk"),
    Index("idx_requests_unit_id", "unit_id"), Index("idx_requests_economist_id", "economist_id"), Index("idx_requests_status", "status"),
)

dds_catalog = Table(
    "dds_catalog", metadata, uuid_pk(),
    Column("parent_id", PgUUID(as_uuid=True), ForeignKey("dds_catalog.id", ondelete="SET NULL")),
    Column("unit_id", PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="SET NULL")),
    Column("name", Text, nullable=False), Column("is_active", Boolean, nullable=False, server_default=text("true")),
    Index("idx_dds_catalog_unit_id", "unit_id"), Index("idx_dds_catalog_parent_id", "parent_id"), Index("idx_dds_catalog_active", "is_active"),
)

invests_catalog = Table(
    "invests_catalog", metadata, uuid_pk(),
    Column("parent_id", PgUUID(as_uuid=True), ForeignKey("invests_catalog.id", ondelete="SET NULL")),
    Column("unit_id", PgUUID(as_uuid=True), ForeignKey("units.id", ondelete="SET NULL")),
    Column("name", Text, nullable=False), Column("is_active", Boolean, nullable=False, server_default=text("true")),
    Index("idx_invests_catalog_unit_id", "unit_id"), Index("idx_invests_catalog_parent_id", "parent_id"), Index("idx_invests_catalog_active", "is_active"),
)

req_items = Table(
    "req_items", metadata, uuid_pk(),
    Column("request_id", PgUUID(as_uuid=True), ForeignKey("requests.id", ondelete="CASCADE"), nullable=False),
    Column("dds_id", PgUUID(as_uuid=True), ForeignKey("dds_catalog.id", ondelete="RESTRICT")),
    Column("invest_id", PgUUID(as_uuid=True), ForeignKey("invests_catalog.id", ondelete="RESTRICT")),
    Column("is_income", Boolean, nullable=False, server_default=text("false")),
    Column("name", Text, nullable=False),
    Column("sum_plan", Numeric(14, 2), nullable=False, server_default=text("0")),
    Column("sum_fact", Numeric(14, 2), nullable=False, server_default=text("0")),
    Column("justification", Text, nullable=False, server_default=text("''")),
    Column("status", Text, nullable=False, server_default=text("'on_review'")),
    Column("comment", Text, nullable=False, server_default=text("''")),
    CheckConstraint("sum_plan >= 0", name="req_items_sum_plan_chk"),
    CheckConstraint("sum_fact >= 0", name="req_items_sum_fact_chk"),
    CheckConstraint("status IN ('on_review', 'rejected', 'approved_with_changes', 'approved', 'deleted')", name="req_items_status_chk"),
    CheckConstraint("(dds_id IS NULL) <> (invest_id IS NULL)", name="req_items_article_chk"),
    Index("idx_req_items_request_id", "request_id"), Index("idx_req_items_dds_id", "dds_id"), Index("idx_req_items_invest_id", "invest_id"), Index("idx_req_items_status", "status"), Index("idx_req_items_is_income", "is_income"),
)

storage_objects = Table(
    "storage_objects", metadata,
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column("storage_bucket", Text, nullable=False), Column("storage_key", Text, nullable=False, unique=True),
    Column("content_sha256", Text, nullable=False), Column("mime_type", Text, nullable=False), Column("size_bytes", BigInteger, nullable=False),
    CheckConstraint("size_bytes >= 0", name="storage_objects_size_chk"),
    Index("idx_storage_objects_storage_key", "storage_key"), Index("idx_storage_objects_content_sha256", "content_sha256"),
)

files = Table(
    "files", metadata, Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column("id_storage_object", BigInteger, ForeignKey("storage_objects.id", ondelete="RESTRICT"), nullable=False),
    Column("original_name", Text, nullable=False), Index("idx_files_storage_object", "id_storage_object"),
)

req_item_files = Table(
    "req_item_files", metadata,
    Column("file_id", BigInteger, ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
    Column("req_item_id", PgUUID(as_uuid=True), ForeignKey("req_items.id", ondelete="CASCADE"), nullable=False),
    PrimaryKeyConstraint("file_id", "req_item_id"), Index("idx_req_item_files_req_item_id", "req_item_id"),
)

req_chats = Table(
    "req_chats", metadata, uuid_pk(),
    Column("req_id", PgUUID(as_uuid=True), ForeignKey("requests.id", ondelete="CASCADE"), nullable=False, unique=True),
)

chat_messages = Table(
    "chat_messages", metadata, uuid_pk(),
    Column("chat_id", PgUUID(as_uuid=True), ForeignKey("req_chats.id", ondelete="CASCADE"), nullable=False),
    Column("reply_to", PgUUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="SET NULL")),
    Column("sender_id", PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
    Column("text", Text, nullable=False), Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("idx_chat_messages_chat_id_created_at", "chat_id", "created_at"), Index("idx_chat_messages_reply_to", "reply_to"),
)

chats_participants = Table(
    "chats_participants", metadata,
    Column("chat_id", PgUUID(as_uuid=True), ForeignKey("req_chats.id", ondelete="CASCADE"), nullable=False),
    Column("user_id", PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("last_read_message_id", PgUUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="SET NULL")),
    PrimaryKeyConstraint("chat_id", "user_id"), Index("idx_chats_participants_user_id", "user_id"),
)

req_logs = Table(
    "req_logs", metadata,
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column("req_id", PgUUID(as_uuid=True), ForeignKey("requests.id", ondelete="CASCADE"), nullable=False),
    Column("user_id", PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
    Column("log", JSONB, nullable=False), Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("idx_req_logs_req_id_created_at", "req_id", "created_at"), Index("idx_req_logs_user_id", "user_id"),
)

TABLES = {table.name: table for table in metadata.sorted_tables}


def sqlalchemy_url(database_url: str) -> str:
    return database_url.replace("postgresql://", "postgresql+psycopg://", 1) if database_url.startswith("postgresql://") else database_url


def create_engine_from_url(database_url: str) -> Engine:
    return create_engine(sqlalchemy_url(database_url), pool_pre_ping=True)


def create_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, expire_on_commit=False)


def to_public_value(value):
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    return value
