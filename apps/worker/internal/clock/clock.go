// Package clock은 시간 주입 인터페이스다.
// CLAUDE.md 규칙 3: time.Now() 직접 호출 금지 — 시간 가속 테스트 하네스(O-8)의 전제.
package clock

import "time"

type Clock interface {
	Now() time.Time
}

// Real은 벽시계. 프로덕션 조립 지점(main)에서만 생성한다.
type Real struct{}

func (Real) Now() time.Time { return time.Now() }

// Fake는 테스트용 고정/전진 시계.
type Fake struct {
	Current time.Time
}

func (f *Fake) Now() time.Time { return f.Current }

func (f *Fake) Advance(d time.Duration) { f.Current = f.Current.Add(d) }
