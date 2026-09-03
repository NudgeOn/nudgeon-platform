-- Synthetic identities in a fresh, isolated database only.
CREATE USER dlq_observer LOGIN PASSWORD 'local-dlq-observer-only';
GRANT CONNECT ON DATABASE nudgeon TO dlq_observer;
GRANT USAGE ON SCHEMA public TO dlq_observer;
GRANT SELECT ON send_dlq TO dlq_observer;
INSERT INTO tenants(id,name) VALUES ('00000000-0000-4000-8000-000000000001','DLQ LOCAL QA');
INSERT INTO apps(id,tenant_id,name) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','DLQ LOCAL QA');
