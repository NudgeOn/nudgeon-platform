# Supple server integration handshake

`GET /v1/integrations/connection` is a new read-only endpoint. Upgrade the installed NudgeOn API before configuring Supple. It requires a Server Key (`Authorization: Bearer sk_…`), including `ingest_only`; SDK keys and console cookies do not authorize this endpoint. Tenant/app scope comes only from the authenticated key. See `packages/openapi/openapi.yaml` for the response contract.

The response exposes the authenticated app identity and whether verified FCM/APNs credentials currently exist. It does not expose provider secrets, create events, or send a push. The response does not guarantee device registration, opt-in, active journeys, or delivery.

Supple stores the key encrypted and checks the returned app ID against the operator-specified app. Configure its trusted API origins and encryption key before using the handshake. Existing deployments without this endpoint return 404 and must not be reported as connected.

The existing Server Key event route is `POST /v1/track`; `insert_id` must remain stable across retries. Event acceptance is not push delivery. Console `test-push` uses session authentication and must not be used as a server integration endpoint. Supple currently keeps real event dispatch disabled and tests this contract with synthetic requests.
