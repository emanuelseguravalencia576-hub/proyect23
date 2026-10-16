CREATE TABLE IF NOT EXISTS purchase_requests (
    id TEXT PRIMARY KEY,
    client VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    total BIGINT NOT NULL CHECK (total >= 0),
    status VARCHAR(10) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    payment_id TEXT,
    payment_preference_id TEXT
);

ALTER TABLE purchase_requests
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS payment_id TEXT,
    ADD COLUMN IF NOT EXISTS payment_preference_id TEXT,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS purchase_request_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
    unit_price BIGINT NOT NULL CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS purchase_requests_created_at_idx
    ON purchase_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS purchase_request_items_request_id_idx
    ON purchase_request_items (request_id);

CREATE TABLE IF NOT EXISTS product_inventory (
    product_id TEXT PRIMARY KEY,
    stock INTEGER NOT NULL CHECK (stock >= 0)
);
