// Package dlq defines durable unresolved/replaying/operator-resolved semantics.
package dlq

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var Streams = []string{"stream:send.push", "stream:send.message", "stream:send.email", "unknown"}
var Classes = []string{"retryable", "rate_limited", "permanent_content", "invalid_target", "credential_auth", "unknown"}

func Label(value string, allowed []string) string {
	for _, candidate := range allowed {
		if value == candidate {
			return value
		}
	}
	return "unknown"
}

type Bucket struct {
	Stream, FailureClass  string
	Unresolved, Replaying int64
	Oldest                time.Time
}

type Queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}
type Execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// SQL normalizes dimensions BEFORE aggregation, keeping rows and metric labels
// bounded even when an old/broken writer stored arbitrary failure text.
const SnapshotSQL = `SELECT
 CASE WHEN envelope->>'type' IN ('send.push','send.push.v1') THEN 'stream:send.push'
      WHEN envelope->>'type' IN ('send.message','send.message.v1') THEN 'stream:send.message'
      WHEN envelope->>'type' IN ('send.email','send.email.v1') THEN 'stream:send.email'
      ELSE 'unknown' END AS stream,
 CASE WHEN failure_class IN ('retryable','rate_limited','permanent_content','invalid_target','credential_auth')
      THEN failure_class ELSE 'unknown' END AS class,
 count(*), count(*) FILTER (WHERE replayed_at IS NOT NULL), min(created_at)
 FROM send_dlq WHERE resolved_at IS NULL GROUP BY 1,2`

func Snapshot(ctx context.Context, pg Queryer) ([]Bucket, error) {
	rows, err := pg.Query(ctx, SnapshotSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var buckets []Bucket
	for rows.Next() {
		var b Bucket
		if err := rows.Scan(&b.Stream, &b.FailureClass, &b.Unresolved, &b.Replaying, &b.Oldest); err != nil {
			return nil, err
		}
		buckets = append(buckets, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return buckets, nil
}

type Entry struct {
	TenantID, AppID, IdempotencyKey string
	FailureID                       string // Stable across retries of one exhausted send.
	MessageID                       any
	FailureClass, FailureDetail     string
	Attempts                        int
	Envelope                        []byte
}

// The existing row reopens on every new exhausted failure. Replaying or a
// previous operator resolution must never hide a new failure with the same key.
func Insert(ctx context.Context, pg Execer, e Entry) error {
	if e.FailureID == "" {
		e.FailureID = uuid.NewString()
	}
	_, err := Persist(ctx, pg, e)
	return err
}

// Persist distinguishes a new failure cycle from an ambiguous database reply.
// Retrying the same cycle must not reset created_at or an operator resolution.
// No Redis/provider call is made while this single statement holds a row lock.
func Persist(ctx context.Context, pg Execer, e Entry) (bool, error) {
	if _, err := uuid.Parse(e.FailureID); err != nil {
		return false, errors.New("valid stable DLQ failure cycle ID required")
	}
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tag, err := pg.Exec(queryCtx, `INSERT INTO send_dlq
 (tenant_id,app_id,idempotency_key,message_id,failure_class,failure_detail,attempts,envelope,failure_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
 ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET
 failure_class=EXCLUDED.failure_class,failure_detail=EXCLUDED.failure_detail,
 attempts=EXCLUDED.attempts,envelope=EXCLUDED.envelope,
 failure_id=EXCLUDED.failure_id,
 created_at=clock_timestamp(),replayed_at=NULL,resolved_at=NULL,resolution_note=NULL
 WHERE send_dlq.failure_id IS DISTINCT FROM EXCLUDED.failure_id`,
		e.TenantID, e.AppID, e.IdempotencyKey, e.MessageID, e.FailureClass, e.FailureDetail, e.Attempts, e.Envelope, e.FailureID)
	return tag.RowsAffected() == 1, err
}

var ErrChanged = errors.New("DLQ item missing, already resolved, or changed since inspection; inspect it again")

// Resolve records an operator's verified disposition, NOT provider delivery.
// Match tenant, primary key and observed failure timestamp to reject stale or
// cross-tenant approvals. A later Insert atomically clears the resolution.
func Resolve(ctx context.Context, pg Execer, tenant, id string, observed time.Time, note string) error {
	if _, err := uuid.Parse(tenant); err != nil {
		return errors.New("valid tenant UUID required")
	}
	if _, err := uuid.Parse(id); err != nil {
		return errors.New("valid DLQ item UUID required")
	}
	note = strings.TrimSpace(note)
	if observed.IsZero() || note == "" || len(note) > 1000 {
		return errors.New("observed created_at and a 1-1000 byte resolution note required")
	}
	tag, err := pg.Exec(ctx, `UPDATE send_dlq SET resolved_at=clock_timestamp(), resolution_note=$4
 WHERE tenant_id=$1 AND id=$2 AND created_at=$3 AND resolved_at IS NULL`, tenant, id, observed, note)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrChanged
	}
	return nil
}
