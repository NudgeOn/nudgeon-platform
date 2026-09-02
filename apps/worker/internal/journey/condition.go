package journey

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/segment"
)

type conditionSnapshot struct {
	Attributes  map[string]any `json:"attributes"`
	EvaluatedAt time.Time      `json:"evaluated_at"`
	ReceiptSeq  int64          `json:"receipt_seq,string"`
}

type eventQuery struct {
	TenantID, AppID, UserID, Event string
	Since, Until                   time.Time
	BoundaryIDs                    []string
}

var stdAttributeKeys = map[string]bool{
	"external_id": true, "first_name": true, "last_name": true, "email": true,
	"phone": true, "language": true, "country": true, "timezone": true,
	"created_at": true, "last_seen_at": true,
}

func validateCondition(dsl *segment.DSL) error {
	if dsl == nil || dsl.Version != 1 || !logicalOperator(dsl.Operator) || len(dsl.Groups) == 0 || len(dsl.Groups) > 20 {
		return fmt.Errorf("invalid branch condition")
	}
	for _, g := range dsl.Groups {
		if !logicalOperator(g.Operator) || len(g.Conditions) == 0 || len(g.Conditions) > 50 {
			return fmt.Errorf("invalid condition group")
		}
		for _, c := range g.Conditions {
			switch c.Type {
			case "event":
				if strings.TrimSpace(c.Event) == "" || (c.Op != "performed" && c.Op != "not_performed") {
					return fmt.Errorf("unsupported event condition")
				}
				if c.WindowDays != nil && (*c.WindowDays < 1 || *c.WindowDays > 180) {
					return fmt.Errorf("event lookback must be 1..180 days")
				}
			case "attribute":
				if strings.TrimSpace(c.Key) == "" {
					return fmt.Errorf("attribute key is required")
				}
				if _, err := evaluateAttribute(c, nil, false, time.Time{}); err != nil {
					return err
				}
			default:
				return fmt.Errorf("unsupported branch condition type %q", c.Type)
			}
		}
	}
	return nil
}

func logicalOperator(op string) bool { return op == "AND" || op == "OR" }

func (s *Scheduler) captureCondition(ctx context.Context, tx pgx.Tx, c *claimedState, now time.Time, sequence int64) (*conditionSnapshot, error) {
	var stdRaw, customRaw []byte
	err := tx.QueryRow(ctx, `SELECT std_attrs, custom_attrs
		FROM users WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND status='active'`,
		c.tenantID, c.appID, c.userID).Scan(&stdRaw, &customRaw)
	if err != nil {
		return nil, fmt.Errorf("condition profile snapshot: %w", err)
	}
	var std, custom map[string]any
	if err := json.Unmarshal(stdRaw, &std); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(customRaw, &custom); err != nil {
		return nil, err
	}
	attrs := map[string]any{}
	for key, value := range custom {
		if !stdAttributeKeys[key] {
			attrs[key] = value
		}
	}
	for key, value := range std {
		if stdAttributeKeys[key] {
			attrs[key] = value
		}
	}
	// Use the same JSON attribute namespace as Segment DSL. In particular,
	// created_at is the customer's signup date, not NudgeOn's profile-row timestamp.
	return &conditionSnapshot{Attributes: attrs, EvaluatedAt: now, ReceiptSeq: sequence}, nil
}

// No logical short circuit hides an evaluation error. An unavailable dependency
// leaves the node retrying; it must never manufacture a false branch.
func (s *Scheduler) evaluateCondition(ctx context.Context, tx pgx.Tx, c *claimedState, dsl *segment.DSL, snapshot *conditionSnapshot) (bool, error) {
	groups := make([]bool, 0, len(dsl.Groups))
	for _, group := range dsl.Groups {
		conditions := make([]bool, 0, len(group.Conditions))
		for _, condition := range group.Conditions {
			var matched bool
			var err error
			if condition.Type == "attribute" {
				value, exists := snapshot.Attributes[condition.Key]
				matched, err = evaluateAttribute(condition, value, exists, snapshot.EvaluatedAt)
			} else {
				matched, err = s.evaluateEvent(ctx, tx, c, condition, snapshot)
			}
			if err != nil {
				return false, err
			}
			conditions = append(conditions, matched)
		}
		groups = append(groups, combine(group.Operator, conditions))
	}
	return combine(dsl.Operator, groups), nil
}

func combine(op string, values []bool) bool {
	result := op == "AND"
	for _, value := range values {
		if op == "AND" {
			result = result && value
		} else {
			result = result || value
		}
	}
	return result
}

func (s *Scheduler) evaluateEvent(ctx context.Context, tx pgx.Tx, c *claimedState, condition segment.Condition, snapshot *conditionSnapshot) (bool, error) {
	days := 30
	if condition.WindowDays != nil {
		days = *condition.WindowDays
	}
	since := snapshot.EvaluatedAt.Add(-time.Duration(days) * 24 * time.Hour)
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM event_receipts
		WHERE tenant_id=$1 AND app_id=$2 AND user_id=$3 AND event_name=$4
		AND receipt_seq <= $5 AND received_at >= $6 AND received_at <= $7 AND projected_at IS NULL)`,
		c.tenantID, c.appID, c.userID, condition.Event, snapshot.ReceiptSeq, since, snapshot.EvaluatedAt).Scan(&pending); err != nil {
		return false, err
	}
	if pending {
		return false, fmt.Errorf("condition event projection is pending")
	}
	// CH stores millisecond timestamps. Only the captured receipts may match in
	// the boundary millisecond, even when later receipts are projected on retry.
	boundary := snapshot.EvaluatedAt.Truncate(time.Millisecond)
	rows, err := tx.Query(ctx, `SELECT insert_id::text FROM event_receipts
		WHERE tenant_id=$1 AND app_id=$2 AND user_id=$3 AND event_name=$4
		AND receipt_seq <= $5 AND received_at >= $6 AND received_at <= $7`,
		c.tenantID, c.appID, c.userID, condition.Event, snapshot.ReceiptSeq, boundary, snapshot.EvaluatedAt)
	if err != nil {
		return false, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return false, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()
	query := eventQuery{TenantID: c.tenantID, AppID: c.appID, UserID: c.userID, Event: condition.Event, Since: since, Until: boundary, BoundaryIDs: ids}
	lookup := s.eventLookup
	if lookup == nil {
		lookup = s.lookupEvent
	}
	performed, err := lookup(ctx, query)
	if err != nil {
		return false, fmt.Errorf("condition event history: %w", err)
	}
	if condition.Op == "not_performed" {
		return !performed, nil
	}
	return performed, nil
}

func (s *Scheduler) lookupEvent(ctx context.Context, q eventQuery) (bool, error) {
	if s.ch == nil {
		return false, fmt.Errorf("ClickHouse is unavailable")
	}
	var count uint64
	err := s.ch.QueryRow(ctx, `SELECT count() FROM events
		WHERE tenant_id=toUUID(?) AND app_id=toUUID(?) AND user_id=toUUID(?) AND event_name=?
		AND server_ts >= ? AND (server_ts < ? OR has(?, toString(insert_id)))`,
		q.TenantID, q.AppID, q.UserID, q.Event, q.Since, q.Until, q.BoundaryIDs).Scan(&count)
	return count > 0, err
}

func evaluateAttribute(c segment.Condition, actual any, exists bool, now time.Time) (bool, error) {
	var expected any
	if len(c.Value) > 0 {
		if err := json.Unmarshal(c.Value, &expected); err != nil {
			return false, fmt.Errorf("invalid attribute value: %w", err)
		}
	}
	switch c.Op {
	case "exists":
		return exists, nil
	case "not_exists":
		return !exists, nil
	case "in":
		values, ok := expected.([]any)
		if !ok || len(values) == 0 {
			return false, fmt.Errorf("attribute in requires a nonempty array")
		}
		for _, value := range values {
			if !isScalar(value) {
				return false, fmt.Errorf("attribute in requires scalar elements")
			}
		}
		if !exists {
			return false, nil
		}
		for _, value := range values {
			if reflect.DeepEqual(actual, value) {
				return true, nil
			}
		}
		return false, nil
	case "contains":
		if _, ok := expected.(string); !ok {
			return false, fmt.Errorf("attribute contains requires a string")
		}
		if !exists {
			return false, nil
		}
		if values, ok := actual.([]any); ok {
			for _, value := range values {
				if reflect.DeepEqual(value, expected) {
					return true, nil
				}
			}
		}
		return false, nil
	case "in_last_days", "not_in_last_days":
		days, ok := expected.(float64)
		if !ok || days < 1 || days > 106751 || math.Trunc(days) != days {
			return false, fmt.Errorf("attribute date window requires 1..106751 days")
		}
		if !exists {
			return false, nil
		}
		at, ok := parseDate(actual)
		if !ok {
			return false, nil
		}
		if c.Op == "not_in_last_days" {
			return at.Before(now.Add(-time.Duration(days) * 24 * time.Hour)), nil
		}
		return !at.Before(now.Add(-time.Duration(days)*24*time.Hour)) && !at.After(now), nil
	case "before", "after":
		boundary, ok := parseDate(expected)
		if !ok {
			return false, fmt.Errorf("attribute before/after requires an ISO date")
		}
		if !exists {
			return false, nil
		}
		at, ok := parseDate(actual)
		if !ok {
			return false, nil
		}
		if c.Op == "after" {
			return at.After(boundary), nil
		}
		return at.Before(boundary), nil
	case "eq", "neq", "gt", "gte", "lt", "lte":
		if !isScalar(expected) {
			return false, fmt.Errorf("attribute comparison requires a scalar")
		}
		if c.Op != "eq" && c.Op != "neq" {
			if _, ok := expected.(float64); !ok {
				return false, fmt.Errorf("attribute ordering requires a finite number")
			}
		}
		if !exists {
			return false, nil
		}
		cmp, comparable := compareScalars(actual, expected)
		if !comparable {
			return false, nil
		}
		switch c.Op {
		case "eq":
			return cmp == 0, nil
		case "neq":
			return cmp != 0, nil
		case "gt":
			return cmp > 0, nil
		case "gte":
			return cmp >= 0, nil
		case "lt":
			return cmp < 0, nil
		default:
			return cmp <= 0, nil
		}
	default:
		return false, fmt.Errorf("unsupported attribute operator %q", c.Op)
	}
}

func isScalar(value any) bool {
	switch value.(type) {
	case string, bool, float64:
		return true
	default:
		return false
	}
}

func compareScalars(actual, expected any) (int, bool) {
	switch b := expected.(type) {
	case float64:
		a, ok := actual.(float64)
		if !ok {
			if str, isString := actual.(string); isString {
				var err error
				a, err = strconv.ParseFloat(str, 64)
				ok = err == nil && !math.IsNaN(a) && !math.IsInf(a, 0)
			}
		}
		if !ok {
			return 0, false
		}
		if a < b {
			return -1, true
		}
		if a > b {
			return 1, true
		}
		return 0, true
	case string:
		a, ok := actual.(string)
		if !ok {
			return 0, false
		}
		if a < b {
			return -1, true
		}
		if a > b {
			return 1, true
		}
		return 0, true
	case bool:
		a, ok := actual.(bool)
		if !ok {
			return 0, false
		}
		if a == b {
			return 0, true
		}
		if a {
			return 1, true
		}
		return -1, true
	default:
		return 0, false
	}
}

func parseDate(value any) (time.Time, bool) {
	s, ok := value.(string)
	if !ok {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
