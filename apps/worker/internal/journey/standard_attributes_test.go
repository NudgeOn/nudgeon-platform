package journey

import (
	"reflect"
	"testing"
)

func TestConditionAttributesKeepsLegacyProfileValues(t *testing.T) {
	got := conditionAttributes(map[string]any{"gender": "", "email": "new@example.com"},
		map[string]any{"dob": "1995-03-15", "gender": "F", "home_city": "Seoul", "email": "old@example.com", "tier": "gold"})
	want := map[string]any{"dob": "1995-03-15", "gender": "", "home_city": "Seoul", "email": "new@example.com", "tier": "gold"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("attributes = %#v, want %#v", got, want)
	}
	if _, ok := conditionAttributes(nil, map[string]any{"email": "legacy"})["email"]; ok {
		t.Fatal("unrelated standard keys must not fall back to custom attributes")
	}
}

func TestStandardProfileValuesTakePrecedenceInMessageRendering(t *testing.T) {
	got := mergeAttrs([]byte(`{"home_city":"", "gender":"F"}`), []byte(`{"home_city":"legacy", "gender":"M", "tier":"gold"}`))
	want := map[string]string{"home_city": "", "gender": "F", "tier": "gold"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rendered attributes: %#v", got)
	}
}
