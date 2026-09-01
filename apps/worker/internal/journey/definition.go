// Package journey — 오케스트레이션 엔진 (PRD-03, DEV-sub-03).
// 상태머신·스케줄러·outbox 릴레이. 단발 캠페인 = 1노드 blast 저니.
package journey

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/ondahq/onda/apps/worker/internal/segment"
)

// Definition — packages/journey-model과 동형 구조 (불변 버전 스냅샷의 파싱 대상).
type Definition struct {
	SchemaVersion int      `json:"schema_version,omitempty"`
	StartNodeID   *string  `json:"start_node_id,omitempty"`
	Edges         []Edge   `json:"edges,omitempty"`
	Entry         Entry    `json:"entry"`
	Nodes         []Node   `json:"nodes"`
	Exit          Exit     `json:"exit"`
	Settings      Settings `json:"settings"`
	start         int
	next          map[int]map[string]int
}

type Edge struct {
	ID         string  `json:"id"`
	Source     string  `json:"source"`
	SourcePort string  `json:"source_port"`
	Target     *string `json:"target"`
}

type Entry struct {
	Type         string `json:"type"` // blast | trigger
	SegmentID    string `json:"segment_id,omitempty"`
	TriggerEvent string `json:"trigger_event,omitempty"`
}

type Node struct {
	ID   string `json:"id,omitempty"`
	Type string `json:"type"` // message | delay
	// message
	Push *PushContent `json:"push,omitempty"`
	// delay
	DurationSeconds int64        `json:"duration_seconds,omitempty"`
	Condition       *segment.DSL `json:"condition,omitempty"`
	EventName       string       `json:"event_name,omitempty"`
	TimeoutSeconds  int64        `json:"timeout_seconds,omitempty"`
	Variants        []Variant    `json:"variants,omitempty"`
}

type Variant struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Weight int    `json:"weight"`
}

type PushContent struct {
	Title    string `json:"title"`
	Body     string `json:"body"`
	ImageURL string `json:"image_url,omitempty"`
	DeepLink string `json:"deep_link,omitempty"`
}

type Exit struct {
	ConversionEvent string `json:"conversion_event,omitempty"`
}

type Settings struct {
	Category string          `json:"category"` // marketing | transactional
	Reentry  json.RawMessage `json:"reentry,omitempty"`
}

func ParseDefinition(raw []byte) (*Definition, error) {
	var d Definition
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	if d.SchemaVersion != 0 && d.SchemaVersion != 1 && d.SchemaVersion != 2 {
		return nil, fmt.Errorf("unsupported journey schema_version: %d", d.SchemaVersion)
	}
	if d.SchemaVersion == 2 {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&d); err != nil {
			return nil, err
		}
		if err := d.compile(); err != nil {
			return nil, err
		}
	}
	return &d, nil
}

// Array indices belong to an immutable version. Never reorder nodes when compiling.
func (d *Definition) compile() error {
	if len(d.Nodes) > 65535 {
		return fmt.Errorf("journey has more than 65535 nodes")
	}
	if err := validateReentry(d.Settings.Reentry); err != nil {
		return err
	}
	indices := make(map[string]int, len(d.Nodes))
	d.next = make(map[int]map[string]int, len(d.Nodes))
	for i, n := range d.Nodes {
		if strings.TrimSpace(n.ID) == "" || len(n.ID) > 128 {
			return fmt.Errorf("node %d has invalid id", i)
		}
		if _, exists := indices[n.ID]; exists {
			return fmt.Errorf("duplicate node id %q", n.ID)
		}
		indices[n.ID] = i
		if err := validateNode(n); err != nil {
			return fmt.Errorf("node %s: %w", n.ID, err)
		}
		d.next[i] = map[string]int{}
	}
	d.start = len(d.Nodes)
	if d.StartNodeID != nil {
		index, ok := indices[*d.StartNodeID]
		if !ok {
			return fmt.Errorf("unknown start node %q", *d.StartNodeID)
		}
		d.start = index
	} else if len(d.Nodes) != 0 {
		return fmt.Errorf("start_node_id is required")
	}
	edgeIDs := map[string]bool{}
	for _, edge := range d.Edges {
		if edge.ID == "" || edgeIDs[edge.ID] {
			return fmt.Errorf("missing or duplicate edge id %q", edge.ID)
		}
		edgeIDs[edge.ID] = true
		source, ok := indices[edge.Source]
		if !ok {
			return fmt.Errorf("unknown edge source %q", edge.Source)
		}
		ports := nodePorts(d.Nodes[source])
		if !ports[edge.SourcePort] {
			return fmt.Errorf("unknown port %s.%s", edge.Source, edge.SourcePort)
		}
		if _, exists := d.next[source][edge.SourcePort]; exists {
			return fmt.Errorf("multiple edges for %s.%s", edge.Source, edge.SourcePort)
		}
		target := len(d.Nodes)
		if edge.Target != nil {
			var exists bool
			target, exists = indices[*edge.Target]
			if !exists {
				return fmt.Errorf("unknown edge target %q", *edge.Target)
			}
		}
		d.next[source][edge.SourcePort] = target
	}
	for i, n := range d.Nodes {
		for port := range nodePorts(n) {
			if _, exists := d.next[i][port]; !exists {
				return fmt.Errorf("missing edge %s.%s", n.ID, port)
			}
		}
	}
	color := make([]byte, len(d.Nodes))
	var visit func(int) error
	visit = func(i int) error {
		if i == len(d.Nodes) {
			return nil
		}
		if color[i] == 1 {
			return fmt.Errorf("journey contains a cycle at %s", d.Nodes[i].ID)
		}
		if color[i] == 2 {
			return nil
		}
		color[i] = 1
		for _, next := range d.next[i] {
			if err := visit(next); err != nil {
				return err
			}
		}
		color[i] = 2
		return nil
	}
	if err := visit(d.start); err != nil {
		return err
	}
	for i, c := range color {
		if c != 2 {
			return fmt.Errorf("unreachable node %s", d.Nodes[i].ID)
		}
	}
	return nil
}

func (d *Definition) startIndex() int {
	if d.SchemaVersion == 2 {
		return d.start
	}
	return 0
}

func (d *Definition) nextIndex(index int, port string) (int, error) {
	if d.SchemaVersion != 2 {
		return index + 1, nil
	}
	next, ok := d.next[index][port]
	if !ok {
		return 0, fmt.Errorf("missing compiled port %d.%s", index, port)
	}
	return next, nil
}

func nodePorts(n Node) map[string]bool {
	switch n.Type {
	case "branch":
		return map[string]bool{"true": true, "false": true}
	case "event_wait":
		return map[string]bool{"matched": true, "timeout": true}
	case "ab_split":
		ports := map[string]bool{}
		for _, variant := range n.Variants {
			ports[variant.ID] = true
		}
		return ports
	default:
		return map[string]bool{"next": true}
	}
}

const maxDurationSeconds int64 = 9223372036
const maxReentryDays = 106751

func validateReentry(raw json.RawMessage) error {
	var mode string
	if json.Unmarshal(raw, &mode) == nil && (mode == "never" || mode == "always") {
		return nil
	}
	var policy struct {
		AfterDays int `json:"after_days"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil || policy.AfterDays < 1 || policy.AfterDays > maxReentryDays {
		return fmt.Errorf("reentry must be never, always, or after_days in 1..%d", maxReentryDays)
	}
	return nil
}

func validateNode(n Node) error {
	switch n.Type {
	case "message":
		if n.Push == nil || strings.TrimSpace(n.Push.Title) == "" || strings.TrimSpace(n.Push.Body) == "" {
			return fmt.Errorf("push title and body are required")
		}
	case "delay":
		if n.DurationSeconds <= 0 || n.DurationSeconds > maxDurationSeconds {
			return fmt.Errorf("invalid duration_seconds")
		}
	case "event_wait":
		if strings.TrimSpace(n.EventName) == "" || n.TimeoutSeconds <= 0 || n.TimeoutSeconds > maxDurationSeconds {
			return fmt.Errorf("event_name and a finite positive timeout are required")
		}
	case "branch":
		return validateCondition(n.Condition)
	case "ab_split":
		if len(n.Variants) < 2 || len(n.Variants) > 4 {
			return fmt.Errorf("A/B split requires 2..4 variants")
		}
		ids, total := map[string]bool{}, 0
		for _, v := range n.Variants {
			if v.ID == "" || ids[v.ID] || v.Label == "" || v.Weight <= 0 || v.Weight > 100 {
				return fmt.Errorf("invalid A/B variant")
			}
			ids[v.ID], total = true, total+v.Weight
		}
		if total != 100 {
			return fmt.Errorf("A/B weights must total 100")
		}
	default:
		return fmt.Errorf("unsupported node type %q", n.Type)
	}
	return nil
}

func sortedVariants(variants []Variant) []Variant {
	result := append([]Variant(nil), variants...)
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
