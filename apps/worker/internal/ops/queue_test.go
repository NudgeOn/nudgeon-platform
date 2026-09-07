package ops

import (
	"testing"

	"github.com/redis/go-redis/v9"
)

func TestCompareStreamIDIsNumericNotLexical(t *testing.T) {
	// 문자열 비교면 "10-0" < "9-0"이 되어 트림 판정이 뒤집힌다.
	cases := []struct {
		a, b string
		want int
	}{
		{"10-0", "9-0", 1},
		{"9-0", "10-0", -1},
		{"5-2", "5-10", -1},
		{"5-10", "5-2", 1},
		{"7-3", "7-3", 0},
		{"0-0", "1-0", -1},
		{"1700000000000-0", "1700000000000-1", -1},
	}
	for _, c := range cases {
		if got := compareStreamID(c.a, c.b); got != c.want {
			t.Errorf("compareStreamID(%q,%q)=%d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestBuildStatDetectsTrimLoss(t *testing.T) {
	// 그룹이 마지막으로 받은 ID가 스트림에 남은 첫 엔트리보다 앞서면,
	// 그 사이 구간은 전달되지 않은 채 사라졌다.
	info := &redis.XInfoStream{
		Length: 100, EntriesAdded: 1000, RecordedFirstEntryID: "500-0",
	}
	g := redis.XInfoGroup{Name: "cg:x", LastDeliveredID: "400-0", EntriesRead: 400, Pending: 0}

	s := buildStat("stream:x", "cg:x", info, g, 1000)
	if !s.TrimLoss {
		t.Fatal("소비 전 트림을 탐지하지 못했다")
	}
	// 1000 추가 - 400 읽음 - 100 잔존 = 500건이 미소비 상태로 사라졌다.
	if s.UnreadTrimmed != 500 {
		t.Fatalf("UnreadTrimmed=%d, want 500", s.UnreadTrimmed)
	}
	if s.FillRatio != 0.1 {
		t.Fatalf("FillRatio=%v, want 0.1", s.FillRatio)
	}
}

func TestBuildStatNoLossWhenGroupIsAhead(t *testing.T) {
	// 그룹이 남아 있는 첫 엔트리보다 뒤에 있으면 유실이 아니라 단순 밀림이다.
	info := &redis.XInfoStream{Length: 100, EntriesAdded: 1000, RecordedFirstEntryID: "500-0"}
	g := redis.XInfoGroup{Name: "cg:x", LastDeliveredID: "600-0", EntriesRead: 600}

	s := buildStat("stream:x", "cg:x", info, g, 1000)
	if s.TrimLoss {
		t.Fatal("밀림을 유실로 잘못 판정했다")
	}
	if s.UnreadTrimmed != 0 {
		t.Fatalf("UnreadTrimmed=%d, want 0", s.UnreadTrimmed)
	}
}

func TestBuildStatEmptyStreamIsNotLoss(t *testing.T) {
	// 빈 스트림에는 판단할 구간이 없다. 0-0을 유실로 읽으면 상시 오탐이 된다.
	info := &redis.XInfoStream{Length: 0, EntriesAdded: 0, RecordedFirstEntryID: "0-0"}
	g := redis.XInfoGroup{Name: "cg:x", LastDeliveredID: "0-0"}

	if s := buildStat("stream:x", "cg:x", info, g, 1000); s.TrimLoss {
		t.Fatal("빈 스트림을 유실로 판정했다")
	}
}

func TestBuildStatFillRatioWithoutMaxLen(t *testing.T) {
	// MAXLEN을 모르면 비율을 지어내지 않는다.
	info := &redis.XInfoStream{Length: 50, EntriesAdded: 50, RecordedFirstEntryID: "1-0"}
	g := redis.XInfoGroup{Name: "cg:x", LastDeliveredID: "50-0"}

	if s := buildStat("stream:x", "cg:x", info, g, 0); s.FillRatio != 0 {
		t.Fatalf("FillRatio=%v, want 0", s.FillRatio)
	}
}
