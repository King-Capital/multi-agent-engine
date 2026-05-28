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

func TestParticipantEventsUpdateAgentPresence(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	startedAt := time.Now().Add(-2 * time.Minute).UTC()
	heartbeatAt := startedAt.Add(45 * time.Second)
	staleAt := heartbeatAt.Add(30 * time.Second)

	events := []models.Event{
		{
			SessionID: "presence-session",
			EventType: models.EventSessionStart,
			Timestamp: startedAt,
			Data:      models.EventData{SessionName: "Presence session"},
		},
		{
			SessionID: "presence-session",
			AgentID:   "worker-1",
			EventType: models.EventParticipantStart,
			Timestamp: startedAt,
			Data: models.EventData{
				ParticipantID:   "worker-1",
				Name:            "Scout",
				Role:            "worker",
				Team:            "Research",
				Model:           "sonnet",
				Status:          models.AgentStatus("starting"),
				LastHeartbeatTS: startedAt.Format(time.RFC3339Nano),
				LastEvent:       "participant_start",
			},
		},
		{
			SessionID: "presence-session",
			AgentID:   "worker-1",
			EventType: models.EventParticipantHeartbeat,
			Timestamp: heartbeatAt,
			Data: models.EventData{
				ParticipantID:   "worker-1",
				Status:          models.StatusIdle,
				CurrentTask:     "waiting_for_review",
				CurrentTool:     "Read",
				LastHeartbeatTS: heartbeatAt.Format(time.RFC3339Nano),
				LastEvent:       "idle_heartbeat",
			},
		},
		{
			SessionID: "presence-session",
			AgentID:   "worker-1",
			EventType: models.EventParticipantStale,
			Timestamp: staleAt,
			Data: models.EventData{
				ParticipantID:   "worker-1",
				Status:          models.StatusStale,
				Reason:          "no activity for 60s",
				LastHeartbeatTS: staleAt.Format(time.RFC3339Nano),
				LastEvent:       "stale",
			},
		},
	}

	for _, evt := range events {
		if err := store.Append(evt); err != nil {
			t.Fatalf("Append(%s) error = %v", evt.EventType, err)
		}
	}

	session := store.GetSession("presence-session")
	if session == nil {
		t.Fatal("session not found")
	}
	agent := session.Agents["worker-1"]
	if agent == nil {
		t.Fatal("agent not found")
	}
	if agent.Name != "Scout" {
		t.Fatalf("agent name = %q, want Scout", agent.Name)
	}
	if agent.Role != models.RoleWorker {
		t.Fatalf("agent role = %q, want %q", agent.Role, models.RoleWorker)
	}
	if agent.TeamName != "Research" {
		t.Fatalf("agent team = %q, want Research", agent.TeamName)
	}
	if agent.Model != "sonnet" {
		t.Fatalf("agent model = %q, want sonnet", agent.Model)
	}
	if agent.Status != models.StatusStale {
		t.Fatalf("agent status = %q, want stale", agent.Status)
	}
	if agent.CurrentActivity != "stale" {
		t.Fatalf("agent current activity = %q, want stale", agent.CurrentActivity)
	}
	if agent.CurrentTool != "Read" {
		t.Fatalf("agent current tool = %q, want Read", agent.CurrentTool)
	}
	if !agent.StartedAt.Equal(startedAt) {
		t.Fatalf("agent started_at = %s, want %s", agent.StartedAt.Format(time.RFC3339Nano), startedAt.Format(time.RFC3339Nano))
	}
	if !agent.LastActivityAt.Equal(staleAt) {
		t.Fatalf("agent last_activity_at = %s, want %s", agent.LastActivityAt.Format(time.RFC3339Nano), staleAt.Format(time.RFC3339Nano))
	}
	if got := len(session.Events); got != len(events) {
		t.Fatalf("session event count = %d, want %d", got, len(events))
	}
}

func TestCloseStaleMarksStaleParticipantsDone(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	startedAt := time.Now().Add(-10 * time.Minute).UTC()
	staleAt := startedAt.Add(2 * time.Minute)

	if err := store.Append(models.Event{
		SessionID: "stale-participant-session",
		EventType: models.EventSessionStart,
		Timestamp: startedAt,
		Data:      models.EventData{SessionName: "Stale participant session"},
	}); err != nil {
		t.Fatalf("Append(session_start) error = %v", err)
	}
	if err := store.Append(models.Event{
		SessionID: "stale-participant-session",
		AgentID:   "worker-1",
		EventType: models.EventParticipantStale,
		Timestamp: staleAt,
		Data: models.EventData{
			ParticipantID:   "worker-1",
			Name:            "Worker",
			Role:            "worker",
			Status:          models.StatusStale,
			Reason:          "no activity for 60s",
			LastHeartbeatTS: staleAt.Format(time.RFC3339Nano),
			LastEvent:       "stale",
		},
	}); err != nil {
		t.Fatalf("Append(participant_stale) error = %v", err)
	}

	if got := store.CloseStale(); got != 1 {
		t.Fatalf("CloseStale() = %d, want 1", got)
	}

	session := store.GetSession("stale-participant-session")
	if session == nil {
		t.Fatal("session not found")
	}
	agent := session.Agents["worker-1"]
	if agent == nil {
		t.Fatal("agent not found")
	}
	if agent.Status != models.StatusDone {
		t.Fatalf("worker status = %q, want done", agent.Status)
	}
}
