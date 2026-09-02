// Package metrics — Prometheus 지표 (PRD-08 §5, 네이밍 nudgeon_<comp>_<metric>).
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// IngestProcessed — ingest-consumer 처리 이벤트 수
	IngestProcessed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nudgeon_ingest_events_processed_total",
		Help: "ingest-consumer가 처리한 이벤트 수",
	}, []string{"tenant"})

	// SendsPublished — 발송 잡 발행 수 (outbox 릴레이)
	SendsPublished = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nudgeon_scheduler_sends_published_total",
		Help: "outbox 릴레이가 발행한 send.push 수",
	}, []string{"tenant"})

	// JourneyStatesEntered — 저니 진입 상태 수
	JourneyStatesEntered = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nudgeon_scheduler_journey_entered_total",
		Help: "생성된 journey_states 수",
	}, []string{"tenant"})

	// ChannelSends — 채널 전송 결과 (status 라벨)
	ChannelSends = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nudgeon_channel_sends_total",
		Help: "채널 워커 발송 결과",
	}, []string{"status"})

	// LifecycleEvents — message.lifecycle 소비 결과 (status 라벨 = 수명주기 상태 | invalid=불량 payload)
	LifecycleEvents = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nudgeon_lifecycle_events_total",
		Help: "lifecycle 소비자가 message_lifecycle에 적재한 이벤트 수 (status별, invalid=스킵)",
	}, []string{"status"})

	// BatchErrors — 배치 처리 실패 (재시도)
	BatchErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nudgeon_worker_batch_errors_total",
		Help: "배치 처리 실패 수 (역할별)",
	}, []string{"role"})
)
