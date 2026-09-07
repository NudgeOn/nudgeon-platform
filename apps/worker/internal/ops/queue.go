package ops

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

// QueueStat — 스트림과 그 소비 그룹 하나의 관측값.
//
// 목적은 "지연"이 아니라 "유실"이다. Redis Streams는 MAXLEN 상한에 닿으면 배압을
// 걸지 않고 가장 오래된 엔트리를 잘라낸다. 생산자는 성공했다고 믿고 그 메시지는
// 사라진다. 이 구조체는 그 사건을 관측 가능하게 만든다.
type QueueStat struct {
	Stream string
	Group  string

	Length       int64 // 현재 남아 있는 엔트리 수
	EntriesAdded int64 // 스트림에 추가된 누적 수 (트림돼도 줄지 않음)
	EntriesRead  int64 // 그룹이 읽은 누적 수
	Pending      int64 // 전달됐으나 ACK되지 않은 수

	// TrimLoss — 소비되지 않은 엔트리가 잘려나갔다는 확정 신호.
	//
	// 그룹의 last-delivered-id가 스트림에 남은 첫 엔트리(recorded-first-entry-id)보다
	// 앞서면, 그 사이 구간은 이 그룹에 전달되지 않은 채 사라진 것이다.
	//
	// XINFO GROUPS의 lag은 쓰지 않는다. Redis는 정확한 계산이 불가능할 때 lag을 nil로
	// 돌려주지만 go-redis의 XInfoGroup.Lag은 int64라 nil이 0으로 뭉개져,
	// "밀린 것 없음"과 구분되지 않는다.
	TrimLoss bool

	// UnreadTrimmed — 잘려나간 미소비 엔트리 수의 하한 추정.
	// entries_added - entries_read 중 스트림에 남아 있지 않은 몫이다.
	// EntriesRead를 못 읽는 구형 그룹에서는 과대 계상될 수 있으므로
	// TrimLoss가 참일 때만 의미 있는 값으로 읽는다.
	UnreadTrimmed int64

	// FillRatio — 현재 길이 / MAXLEN. 트림 임계에 얼마나 가까운지.
	// 유실 전에 개입할 수 있는 유일한 지표다.
	FillRatio float64
}

// observed — 관측 대상 스트림과 그 1차 소비 그룹.
// 유실이 곧 데이터 손실로 이어지는 경로만 담는다.
var observed = []struct{ stream, group string }{
	{libqueue.StreamIngest, libqueue.GroupIngest},
	{libqueue.StreamEvents, libqueue.GroupTriggerMatcher},
	{libqueue.StreamJourneyEntry, libqueue.GroupScheduler},
	{libqueue.StreamSendPush, libqueue.GroupChannel},
	{libqueue.StreamSendMessage, libqueue.GroupChannelMessage},
	{libqueue.StreamLifecycle, libqueue.GroupLifecycle},
}

// QueueSnapshot — 관측 대상 전체를 읽는다. 스트림이나 그룹이 아직 없으면 건너뛴다.
// 부분 실패는 오류로 올린다 — 일부만 읽은 결과를 "이상 없음"으로 보고하지 않는다.
func QueueSnapshot(ctx context.Context, rdb redis.Cmdable, maxLen int64) ([]QueueStat, error) {
	out := make([]QueueStat, 0, len(observed))
	for _, o := range observed {
		info, err := rdb.XInfoStream(ctx, o.stream).Result()
		if err != nil {
			if isMissingStream(err) {
				continue // 아직 한 번도 쓰이지 않은 스트림
			}
			return nil, fmt.Errorf("XINFO STREAM %s: %w", o.stream, err)
		}
		groups, err := rdb.XInfoGroups(ctx, o.stream).Result()
		if err != nil {
			if isMissingStream(err) {
				continue
			}
			return nil, fmt.Errorf("XINFO GROUPS %s: %w", o.stream, err)
		}
		for _, g := range groups {
			if g.Name != o.group {
				continue
			}
			out = append(out, buildStat(o.stream, o.group, info, g, maxLen))
		}
	}
	return out, nil
}

func buildStat(stream, group string, info *redis.XInfoStream, g redis.XInfoGroup, maxLen int64) QueueStat {
	s := QueueStat{
		Stream: stream, Group: group,
		Length: info.Length, EntriesAdded: info.EntriesAdded,
		EntriesRead: g.EntriesRead, Pending: g.Pending,
	}
	if maxLen > 0 {
		s.FillRatio = float64(info.Length) / float64(maxLen)
	}

	// 빈 스트림에는 판단할 구간이 없다.
	if info.Length == 0 || info.RecordedFirstEntryID == "" || info.RecordedFirstEntryID == "0-0" {
		return s
	}
	// 그룹이 아직 아무것도 읽지 않았고 스트림도 잘린 적이 없으면 유실이 아니다.
	if g.LastDeliveredID == "" {
		return s
	}
	if compareStreamID(g.LastDeliveredID, info.RecordedFirstEntryID) < 0 {
		s.TrimLoss = true
		if unread := s.EntriesAdded - s.EntriesRead - s.Length; unread > 0 {
			s.UnreadTrimmed = unread
		}
	}
	return s
}

// compareStreamID — Redis 스트림 ID(ms-seq)를 수치로 비교한다.
// 문자열 비교는 "10-0" < "9-0"이 되어 틀린다.
func compareStreamID(a, b string) int {
	ams, aseq := splitStreamID(a)
	bms, bseq := splitStreamID(b)
	switch {
	case ams != bms:
		if ams < bms {
			return -1
		}
		return 1
	case aseq != bseq:
		if aseq < bseq {
			return -1
		}
		return 1
	}
	return 0
}

func splitStreamID(id string) (uint64, uint64) {
	ms, seq, found := strings.Cut(id, "-")
	m, _ := strconv.ParseUint(ms, 10, 64)
	if !found {
		return m, 0
	}
	s, _ := strconv.ParseUint(seq, 10, 64)
	return m, s
}

// isMissingStream — 아직 생성되지 않은 스트림/그룹. 오류가 아니라 관측 대상 없음이다.
func isMissingStream(err error) bool {
	if err == redis.Nil {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "no such key") || strings.Contains(msg, "NOGROUP")
}
