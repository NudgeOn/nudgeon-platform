package policy

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func kst() *time.Location {
	loc, _ := time.LoadLocation("Asia/Seoul")
	return loc
}

// O-9: quiet hours 경계 (20:59 발송 / 21:01 차단), 야간창 21:00~08:00
func TestQuietHoursBoundary(t *testing.T) {
	tz := kst()
	qh := QuietHours{Enabled: true, Start: "21:00", End: "08:00", Policy: "delay_until_open"}

	// 20:59 KST → 발송
	at2059 := time.Date(2026, 8, 30, 20, 59, 0, 0, tz)
	d, err := EvaluateQuietHours(Marketing, qh, tz, at2059)
	if err != nil || d.Action != ActionSend {
		t.Errorf("20:59는 Send 기대: %v, %v", d.Action, err)
	}

	// 21:01 KST → 지연
	at2101 := time.Date(2026, 8, 30, 21, 1, 0, 0, tz)
	d, _ = EvaluateQuietHours(Marketing, qh, tz, at2101)
	if d.Action != ActionDelay {
		t.Fatalf("21:01는 Delay 기대: %v", d.Action)
	}
	// 다음 open은 익일 08:00 KST
	openLocal := d.DelayUntil.In(tz)
	if openLocal.Hour() != 8 || openLocal.Day() != 31 {
		t.Errorf("다음 open 08:00 익일 기대: %v", openLocal)
	}

	// 07:59 → 아직 조용시간(지연), 08:01 → 발송
	at0759 := time.Date(2026, 8, 31, 7, 59, 0, 0, tz)
	if d, _ := EvaluateQuietHours(Marketing, qh, tz, at0759); d.Action != ActionDelay {
		t.Errorf("07:59는 Delay 기대: %v", d.Action)
	}
	at0801 := time.Date(2026, 8, 31, 8, 1, 0, 0, tz)
	if d, _ := EvaluateQuietHours(Marketing, qh, tz, at0801); d.Action != ActionSend {
		t.Errorf("08:01는 Send 기대: %v", d.Action)
	}
}

// O-11: transactional은 quiet hours 우회
func TestQuietHoursTransactionalBypass(t *testing.T) {
	tz := kst()
	qh := QuietHours{Enabled: true, Start: "21:00", End: "08:00", Policy: "skip"}
	at2300 := time.Date(2026, 8, 30, 23, 0, 0, 0, tz)
	d, _ := EvaluateQuietHours(Transactional, qh, tz, at2300)
	if d.Action != ActionSend {
		t.Errorf("transactional은 조용시간에도 Send: %v", d.Action)
	}
}

func TestQuietHoursSkipPolicy(t *testing.T) {
	tz := kst()
	qh := QuietHours{Enabled: true, Start: "21:00", End: "08:00", Policy: "skip"}
	at2300 := time.Date(2026, 8, 30, 23, 0, 0, 0, tz)
	if d, _ := EvaluateQuietHours(Marketing, qh, tz, at2300); d.Action != ActionSkip {
		t.Errorf("skip 정책은 조용시간에 Skip: %v", d.Action)
	}
}

func TestInQuietWindow(t *testing.T) {
	// 야간창 21:00(1260)~08:00(480)
	cases := []struct {
		now  int
		want bool
	}{
		{1260, true},  // 21:00
		{1259, false}, // 20:59
		{0, true},     // 00:00
		{479, true},   // 07:59
		{480, false},  // 08:00
		{720, false},  // 12:00
	}
	for _, c := range cases {
		if got := inQuietWindow(c.now, 1260, 480); got != c.want {
			t.Errorf("inQuietWindow(%d) = %v, want %v", c.now, got, c.want)
		}
	}
	// 주간창 01:00(60)~06:00(360)
	if !inQuietWindow(120, 60, 360) {
		t.Error("02:00은 01-06 창 안")
	}
	if inQuietWindow(400, 60, 360) {
		t.Error("06:40은 01-06 창 밖")
	}
}

// O-10: frequency cap — 3건 설정 후 5회 시도 → 2건 거부
func TestFrequencyCap(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	c := NewFreqCapChecker(rdb)
	ctx := context.Background()
	fc := FrequencyCap{Enabled: true, MaxPer24h: 3}

	allowed := 0
	for i := 0; i < 5; i++ {
		ok, err := c.Allow(ctx, Marketing, fc, "app1", "user1")
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			allowed++
		}
	}
	if allowed != 3 {
		t.Errorf("3건 허용 기대, %d건", allowed)
	}

	// transactional은 cap 무시
	for i := 0; i < 5; i++ {
		if ok, _ := c.Allow(ctx, Transactional, fc, "app1", "user1"); !ok {
			t.Error("transactional은 cap 초과에도 허용")
		}
	}

	// 다른 유저는 독립
	if ok, _ := c.Allow(ctx, Marketing, fc, "app1", "user2"); !ok {
		t.Error("다른 유저는 독립 카운터")
	}

	// 비활성이면 무제한
	off := FrequencyCap{Enabled: false, MaxPer24h: 1}
	for i := 0; i < 10; i++ {
		if ok, _ := c.Allow(ctx, Marketing, off, "app1", "user3"); !ok {
			t.Error("비활성 cap은 무제한")
		}
	}
}
