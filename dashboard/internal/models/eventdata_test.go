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

func TestEventDataRecognizesParticipantPresenceFields(t *testing.T) {
	input := []byte(`{
		"participant_id":"worker-1",
		"name":"Scout",
		"kind":"worker",
		"role":"worker",
		"team":"Research",
		"current_task":"waiting_for_review",
		"current_tool":"Read",
		"last_event":"idle_heartbeat",
		"last_heartbeat_ts":"2026-05-28T00:00:00Z",
		"reason":"no activity for 60s"
	}`)

	var data EventData
	if err := json.Unmarshal(input, &data); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if data.ParticipantID != "worker-1" {
		t.Fatalf("participant_id = %q, want worker-1", data.ParticipantID)
	}
	if data.Name != "Scout" || data.Role != "worker" || data.Team != "Research" {
		t.Fatalf("unexpected participant identity fields: %+v", data)
	}
	if data.CurrentTask != "waiting_for_review" || data.CurrentTool != "Read" {
		t.Fatalf("unexpected participant activity fields: %+v", data)
	}
	if data.LastEvent != "idle_heartbeat" || data.LastHeartbeatTS != "2026-05-28T00:00:00Z" || data.Reason != "no activity for 60s" {
		t.Fatalf("unexpected participant heartbeat fields: %+v", data)
	}
	if len(data.Extra) != 0 {
		t.Fatalf("participant presence fields should not be preserved as Extra: %+v", data.Extra)
	}
}
