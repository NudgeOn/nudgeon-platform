package channel

import "testing"

// 무음(silent) 푸시 페이로드: FCM data-only에 silent=1, APNs는 alert 없이 content-available만.
func TestSilentPushPayloads(t *testing.T) {
	// FCM
	data := fcmData(&PushContent{MessageID: "m1", Title: "t", Body: "b", Silent: true})
	if data["silent"] != "1" {
		t.Errorf("FCM silent marker 누락: %v", data)
	}
	normal := fcmData(&PushContent{MessageID: "m1", Title: "t", Body: "b"})
	if _, ok := normal["silent"]; ok {
		t.Errorf("일반 FCM에 silent 마커가 있으면 안 됨: %v", normal)
	}

	// APNs silent
	p := apnsPayload(&PushContent{MessageID: "m1", Silent: true})
	aps, _ := p["aps"].(map[string]any)
	if aps["content-available"] != 1 {
		t.Errorf("APNs silent은 content-available=1 필요: %v", aps)
	}
	if _, hasAlert := aps["alert"]; hasAlert {
		t.Errorf("APNs silent은 alert가 없어야 함: %v", aps)
	}
	// APNs 일반
	pn := apnsPayload(&PushContent{MessageID: "m1", Title: "t", Body: "b"})
	apsn, _ := pn["aps"].(map[string]any)
	if _, hasAlert := apsn["alert"]; !hasAlert {
		t.Errorf("일반 APNs는 alert 필요: %v", apsn)
	}
}
