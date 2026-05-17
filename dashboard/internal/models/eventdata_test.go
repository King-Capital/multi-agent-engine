package models

import (
	"encoding/json"
	"testing"
)

func TestEventDataPreservesUnknownFields(t *testing.T) {
	input := []byte(`{"grade":"VERIFIED","task_report":"s/RALPH/a.md","future_field":{"nested":true}}`)
	var data EventData
	if err := json.Unmarshal(input, &data); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if data.Grade != "VERIFIED" {
		t.Fatalf("grade = %q", data.Grade)
	}
	if len(data.Extra["future_field"]) == 0 {
		t.Fatalf("future_field was not preserved")
	}

	out, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var roundTrip map[string]json.RawMessage
	if err := json.Unmarshal(out, &roundTrip); err != nil {
		t.Fatalf("round trip unmarshal: %v", err)
	}
	if _, ok := roundTrip["future_field"]; !ok {
		t.Fatalf("future_field missing from marshaled payload: %s", string(out))
	}
	if _, ok := roundTrip["grade"]; !ok {
		t.Fatalf("known field missing from marshaled payload: %s", string(out))
	}
}
