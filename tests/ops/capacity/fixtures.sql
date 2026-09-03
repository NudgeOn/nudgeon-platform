-- Fresh isolated database, synthetic identities only.
CREATE USER ops_observer LOGIN PASSWORD 'local-observer-only';
GRANT CONNECT ON DATABASE nudgeon TO ops_observer;
GRANT USAGE ON SCHEMA public TO ops_observer;
GRANT SELECT ON event_receipts, journey_outbox TO ops_observer;
INSERT INTO tenants(id,name) VALUES ('00000000-0000-4000-8000-000000000001','OPS LOCAL QA');
INSERT INTO apps(id,tenant_id,name) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','OPS LOCAL QA');
INSERT INTO users(id,tenant_id,app_id) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002');
INSERT INTO event_receipts(tenant_id,app_id,user_id,insert_id,event_name,received_at,receipt_seq,projected_at)
SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
 '00000000-0000-4000-8000-000000000003',gen_random_uuid(),'ops_qa',now()-interval '60 seconds',i,
 CASE WHEN i=3 THEN now() ELSE NULL END FROM generate_series(1,3) AS i;
INSERT INTO journey_outbox(tenant_id,app_id,stream,idempotency_key,payload,created_at,published_at)
SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
 'stream:ingest','ops-fixture-'||i,'{}',now()-interval '60 seconds',
 CASE WHEN i=3 THEN now() ELSE NULL END FROM generate_series(1,3) AS i;
