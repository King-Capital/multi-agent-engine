package events

import (
	"testing"
	"time"

	"mae.local/dashboard/internal/models"
)

func TestCloseStaleMarksOpenSessionsCompleted(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	startedAt := time.Now().Add(-5 * time.Minute)
	if err := store.Append(models.Event{
		SessionID: "stale-session",
		EventType: models.EventSessionStart,
		Timestamp: startedAt,
		Data: models.EventData{
			SessionName: "Stale session",
		},
	}); err != nil {
		t.Fatalf("Append(session_start) error = %v", err)
	}
	if err := store.Append(models.Event{
		SessionID: "stale-session",
		AgentID:   "worker-1",
		EventType: models.EventAgentSpawn,
		Timestamp: startedAt.Add(time.Second),
		Data: models.EventData{
			AgentName: "Worker",
			AgentRole: models.RoleWorker,
		},
	}); err != nil {
		t.Fatalf("Append(agent_spawn) error = %v", err)
	}

	if got := store.CloseStale(); got != 1 {
		t.Fatalf("CloseStale() = %d, want 1", got)
	}

	session := store.GetSession("stale-session")
	if session == nil {
		t.Fatal("session not found")
	}
	if session.Status != "completed" {
		t.Fatalf("session status = %q, want completed", session.Status)
	}
	if session.Agents["worker-1"].Status != models.StatusDone {
		t.Fatalf("worker status = %q, want done", session.Agents["worker-1"].Status)
	}
}

func TestReapInactiveSessionsEmitsSessionEnd(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	startedAt := time.Now().Add(-20 * time.Minute)
	if err := store.Append(models.Event{
		SessionID: "inactive-session",
		EventType: models.EventSessionStart,
		Timestamp: startedAt,
		Data: models.EventData{
			SessionName: "Inactive session",
		},
	}); err != nil {
		t.Fatalf("Append(session_start) error = %v", err)
	}

	if got := store.ReapInactiveSessions(10 * time.Minute); got != 1 {
		t.Fatalf("ReapInactiveSessions() = %d, want 1", got)
	}

	session := store.GetSession("inactive-session")
	if session == nil {
		t.Fatal("session not found")
	}
	if session.Status != "completed" {
		t.Fatalf("session status = %q, want completed", session.Status)
	}
	last := session.Events[len(session.Events)-1]
	if last.EventType != models.EventSessionEnd {
		t.Fatalf("last event type = %q, want session_end", last.EventType)
	}
	if string(last.Data.Status) != "completed" {
		t.Fatalf("session_end status = %q, want completed", last.Data.Status)
	}
}
