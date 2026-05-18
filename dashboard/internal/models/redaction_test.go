package models

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRedactEventRedactsKnownAndExtraFields(t *testing.T) {
	rawExtra, err := json.Marshal(map[string]any{
		"api_key": "super-secret-value",
		"note":    "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
	})
	if err != nil {
		t.Fatal(err)
	}

	evt := Event{
		SessionID: "sess-1",
		AgentID:   "agent-1",
		EventType: EventToolResult,
		Timestamp: time.Now(),
		Data: EventData{
			TaskPrompt: "token sk-ant-api03-" + strings.Repeat("a", 80),
			ToolArgs:   "password=hunter2",
			ToolResult: "mae_" + strings.Repeat("a", 30),
			ErrorMsg:   "api_key=abc123",
			TillDone: &TillDoneState{
				Title: "deploy with token=title-secret",
				Items: []TillDoneItem{{Description: "verify password=item-secret"}},
			},
			Extra: map[string]json.RawMessage{"payload": rawExtra, "access_token": json.RawMessage(`"abc123"`)},
		},
	}

	originalExtra := string(evt.Data.Extra["payload"])
	redacted := RedactEvent(evt)
	if string(evt.Data.Extra["payload"]) != originalExtra {
		t.Fatalf("RedactEvent mutated original Extra map: got %s want %s", string(evt.Data.Extra["payload"]), originalExtra)
	}
	encoded, err := json.Marshal(redacted)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{"sk-ant-api03-", "hunter2", "mae_", "abc123", "super-secret-value", "ghp_", "title-secret", "item-secret"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("redacted event still contains %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, redactedSecret) {
		t.Fatalf("redacted event missing marker: %s", text)
	}
}
