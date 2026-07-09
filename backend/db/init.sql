-- =========================================================
-- BudgetBasket DB initialization
-- PostgreSQL
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- USERS / PROFILES / UNITS
-- =========================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    login TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,

    -- Можно заменить на FK roles, если роли будут отдельной таблицей
    role TEXT NOT NULL,

    CONSTRAINT users_role_chk CHECK (
        role IN ('admin', 'economist', 'employee')
    )
);

CREATE TABLE profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    second_name TEXT,
    last_name TEXT NOT NULL,
    phone TEXT,
    email TEXT NOT NULL UNIQUE,
    max_link TEXT
);

CREATE TABLE units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    parent_id UUID REFERENCES units(id) ON DELETE SET NULL,

    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT units_name_unique_per_parent UNIQUE (parent_id, name)
);

CREATE TABLE units_responsibles (
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (unit_id, user_id)
);

-- =========================================================
-- STORAGE / FILES
-- =========================================================

CREATE TABLE storage_objects (
    id BIGSERIAL PRIMARY KEY,

    storage_bucket TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,

    content_sha256 TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,

    CONSTRAINT storage_objects_size_chk CHECK (size_bytes >= 0)
);

CREATE TABLE files (
    id BIGSERIAL PRIMARY KEY,

    id_storage_object BIGINT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
    original_name TEXT NOT NULL
);

-- =========================================================
-- CATALOGS
-- =========================================================

CREATE TABLE dds_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    parent_id UUID REFERENCES dds_catalog(id) ON DELETE SET NULL,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT dds_catalog_name_unique_per_unit_parent UNIQUE (unit_id, parent_id, name)
);

CREATE TABLE invests_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    parent_id UUID REFERENCES invests_catalog(id) ON DELETE SET NULL,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT invests_catalog_name_unique_per_unit_parent UNIQUE (unit_id, parent_id, name)
);

-- =========================================================
-- REQUESTS
-- =========================================================

CREATE TABLE requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    economist_id UUID REFERENCES users(id) ON DELETE SET NULL,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,

    sum NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    budget_frozen BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT requests_sum_chk CHECK (sum >= 0),

    CONSTRAINT requests_status_chk CHECK (
        status IN (
            'draft',
            'on_review',
            'approved',
            'approved_with_changes',
            'partially_approved',
            'rejected',
            'cancelled'
        )
    )
);

-- =========================================================
-- DDS ITEMS
-- =========================================================

CREATE TABLE dds_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,

    dds_id UUID NOT NULL REFERENCES dds_catalog(id) ON DELETE RESTRICT,
    category_id UUID REFERENCES dds_catalog(id) ON DELETE RESTRICT,

    sum_plan NUMERIC(14, 2) NOT NULL DEFAULT 0,
    sum_fact NUMERIC(14, 2),

    status TEXT NOT NULL DEFAULT 'on_review',
    comment TEXT,

    CONSTRAINT dds_items_sum_plan_chk CHECK (sum_plan >= 0),
    CONSTRAINT dds_items_sum_fact_chk CHECK (sum_fact IS NULL OR sum_fact >= 0),

    CONSTRAINT dds_items_status_chk CHECK (
        status IN (
            'on_review',
            'rejected',
            'approved_with_changes',
            'approved'
        )
    )
);

CREATE TABLE dds_item_files (
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    dds_item_id UUID NOT NULL REFERENCES dds_items(id) ON DELETE CASCADE,

    PRIMARY KEY (file_id, dds_item_id)
);

-- =========================================================
-- INVEST ITEMS
-- =========================================================

CREATE TABLE invest_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,

    invest_id UUID NOT NULL REFERENCES invests_catalog(id) ON DELETE RESTRICT,
    category_id UUID REFERENCES invests_catalog(id) ON DELETE RESTRICT,

    sum_plan NUMERIC(14, 2) NOT NULL DEFAULT 0,
    sum_fact NUMERIC(14, 2),

    status TEXT NOT NULL DEFAULT 'on_review',
    comment TEXT,

    CONSTRAINT invest_items_sum_plan_chk CHECK (sum_plan >= 0),
    CONSTRAINT invest_items_sum_fact_chk CHECK (sum_fact IS NULL OR sum_fact >= 0),

    CONSTRAINT invest_items_status_chk CHECK (
        status IN (
            'on_review',
            'rejected',
            'approved_with_changes',
            'approved'
        )
    )
);

CREATE TABLE invest_item_files (
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    invest_item_id UUID NOT NULL REFERENCES invest_items(id) ON DELETE CASCADE,

    PRIMARY KEY (file_id, invest_item_id)
);

-- =========================================================
-- INDEXES
-- =========================================================

CREATE INDEX idx_users_role ON users(role);

CREATE INDEX idx_units_parent_id ON units(parent_id);
CREATE INDEX idx_units_is_active ON units(is_active);

CREATE INDEX idx_units_responsibles_user_id ON units_responsibles(user_id);
CREATE INDEX idx_units_responsibles_active ON units_responsibles(is_active);

CREATE INDEX idx_requests_unit_id ON requests(unit_id);
CREATE INDEX idx_requests_economist_id ON requests(economist_id);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_dds_catalog_unit_id ON dds_catalog(unit_id);
CREATE INDEX idx_dds_catalog_parent_id ON dds_catalog(parent_id);
CREATE INDEX idx_dds_catalog_active ON dds_catalog(is_active);

CREATE INDEX idx_invests_catalog_unit_id ON invests_catalog(unit_id);
CREATE INDEX idx_invests_catalog_parent_id ON invests_catalog(parent_id);
CREATE INDEX idx_invests_catalog_active ON invests_catalog(is_active);

CREATE INDEX idx_dds_items_request_id ON dds_items(request_id);
CREATE INDEX idx_dds_items_dds_id ON dds_items(dds_id);
CREATE INDEX idx_dds_items_category_id ON dds_items(category_id);
CREATE INDEX idx_dds_items_status ON dds_items(status);

CREATE INDEX idx_invest_items_request_id ON invest_items(request_id);
CREATE INDEX idx_invest_items_invest_id ON invest_items(invest_id);
CREATE INDEX idx_invest_items_category_id ON invest_items(category_id);
CREATE INDEX idx_invest_items_status ON invest_items(status);

CREATE INDEX idx_files_storage_object ON files(id_storage_object);
CREATE INDEX idx_storage_objects_storage_key ON storage_objects(storage_key);
CREATE INDEX idx_storage_objects_content_sha256 ON storage_objects(content_sha256);

-- =========================================================
-- UPDATED_AT TRIGGER
-- =========================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_requests_updated_at
BEFORE UPDATE ON requests
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
