package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"mae.local/dashboard/internal/events"
	"mae.local/dashboard/internal/models"
	"mae.local/dashboard/templates"
)

func handleDashboard(w http.ResponseWriter, r *http.Request) {
	sessions := store.ListSessions()
	templates.DashboardPage(sessions).Render(r.Context(), w)
}

func handleSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	sess := store.GetSession(sessionID)
	if sess == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	templates.SessionPage(sess).Render(r.Context(), w)
}

func handlePostEvent(w http.ResponseWriter, r *http.Request) {
	var evt models.Event
	if err := json.NewDecoder(r.Body).Decode(&evt); err != nil {
		http.Error(w, "invalid event: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := events.ValidateSessionID(evt.SessionID); err != nil {
		http.Error(w, "invalid session_id", http.StatusBadRequest)
		return
	}
	if err := store.Append(evt); err != nil {
		log.Printf("store error: %v", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	if dbEnabled {
		go func() {
			payload, _ := json.Marshal(evt)
			agentID := evt.AgentID
			dbEvt := &DBEvent{
				SessionID: evt.SessionID,
				AgentID:   &agentID,
				EventType: string(evt.EventType),
				Payload:   payload,
			}
			if err := RecordEvent(context.Background(), dbEvt); err != nil {
				log.Printf("pg event persist error: %v", err)
			}
		}()
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleListSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(store.ListSessions())
}

func handleGetSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	sess := store.GetSession(sessionID)
	if sess == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sess)
}

func handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	store.DeleteSession(sessionID)
	if dbEnabled {
		status := "deleted"
		if err := UpdateSession(r.Context(), sessionID, nil, &status); err != nil {
			log.Printf("pg session delete sync error: %v", err)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted", "session_id": sessionID})
}

func handleCloseStale(w http.ResponseWriter, r *http.Request) {
	n := store.CloseStale()
	if dbEnabled && n > 0 {
		if _, err := MarkStaleSessions(r.Context(), 0); err != nil {
			log.Printf("pg stale session sync error: %v", err)
		}
	}
	if r.Header.Get("HX-Request") == "true" {
		sessions := store.ListSessions()
		templates.SessionListItems(sessions).Render(r.Context(), w)
		return
	}
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "closed", "count": n})
}

func handleClearStale(w http.ResponseWriter, r *http.Request) {
	store.ClearStale(10 * time.Minute)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "cleared"})
}

func handleClearAll(w http.ResponseWriter, r *http.Request) {
	n := store.ClearAll()
	if dbEnabled && n > 0 {
		if _, err := MarkStaleSessions(r.Context(), 0); err != nil {
			log.Printf("pg clear-all sync error: %v", err)
		}
	}
	if r.Header.Get("HX-Request") == "true" {
		sessions := store.ListSessions()
		templates.SessionListItems(sessions).Render(r.Context(), w)
		return
	}
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "cleared", "count": n})
}

func handleSetSessionStatus(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	switch body.Status {
	case "completed", "error":
	default:
		http.Error(w, "status must be completed or error", http.StatusBadRequest)
		return
	}
	if !store.SetSessionStatus(sessionID, body.Status) {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if dbEnabled {
		if err := UpdateSession(r.Context(), sessionID, nil, &body.Status); err != nil {
			log.Printf("pg session status sync error: %v", err)
		}
	}
	if r.Header.Get("HX-Request") == "true" {
		sessions := store.ListSessions()
		templates.SessionListItems(sessions).Render(r.Context(), w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": body.Status, "session_id": sessionID})
}

func handleUserMessage(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	r.ParseForm()
	content := r.FormValue("content")
	if content == "" {
		http.Error(w, "empty message", http.StatusBadRequest)
		return
	}

	// Sanitize: strip control characters (keep newline, carriage return, tab)
	content = strings.Map(func(r rune) rune {
		if r < 32 && r != '\n' && r != '\r' && r != '\t' {
			return -1
		}
		return r
	}, content)
	// Enforce max message length
	if len(content) > 10000 {
		content = content[:10000]
	}
	evt := models.Event{
		SessionID: sessionID,
		AgentID:   "user",
		EventType: models.EventMessage,
		Data: models.EventData{
			From:    "user",
			To:      "orchestrator",
			Content: content,
		},
	}
	store.Append(evt)
	w.WriteHeader(http.StatusCreated)
}

// --- SSE Streaming ---

func handleSSE(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	streamEvents(w, r, sessionID)
}

func handleSSEAll(w http.ResponseWriter, r *http.Request) {
	streamEvents(w, r, "*")
}

func streamEvents(w http.ResponseWriter, r *http.Request, sessionID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := store.Subscribe(sessionID)
	defer store.Unsubscribe(sessionID, ch)

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case evt, ok := <-ch:
			if !ok {
				return
			}
			data, _ := json.Marshal(evt)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.EventType, data)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func handleHTMXSSE(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	sess := store.GetSession(sessionID)
	if sess == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := store.Subscribe(sessionID)
	defer store.Unsubscribe(sessionID, ch)

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case evt, ok := <-ch:
			if !ok {
				return
			}
			switch evt.EventType {
			case models.EventMessage, models.EventToolCall, models.EventDomainBlock, models.EventSelfHeal, models.EventError:
				var buf bytes.Buffer
				switch evt.EventType {
				case models.EventMessage:
					templates.MessageBubble(evt, sess).Render(r.Context(), &buf)
				case models.EventToolCall:
					templates.ToolCallEntry(evt, sess).Render(r.Context(), &buf)
				case models.EventDomainBlock:
					templates.DomainBlockEntry(evt).Render(r.Context(), &buf)
				case models.EventSelfHeal:
					templates.SelfHealEntry(evt, sess).Render(r.Context(), &buf)
				case models.EventError:
					templates.ErrorEntry(evt, sess).Render(r.Context(), &buf)
				}
				sseType := string(evt.EventType)
				if sseType == "error" {
					sseType = "agent_error"
				}
				writeSSEHTML(w, sseType, buf.String())
			default:
				data, _ := json.Marshal(evt)
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.EventType, data)
			}
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func writeSSEHTML(w io.Writer, eventType, html string) {
	fmt.Fprintf(w, "event: %s\n", eventType)
	for _, line := range strings.Split(html, "\n") {
		fmt.Fprintf(w, "data: %s\n", line)
	}
	fmt.Fprintf(w, "\n")
}

// --- HTMX Partials ---

func handleHTMXSessions(w http.ResponseWriter, r *http.Request) {
	sessions := store.ListSessions()
	templates.SessionListItems(sessions).Render(r.Context(), w)
}

func handleHTMXAgentTree(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	sess := store.GetSession(sessionID)
	if sess == nil {
		return
	}
	templates.AgentTree(sess).Render(r.Context(), w)
}

func handleHTMXConversation(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	sess := store.GetSession(sessionID)
	if sess == nil {
		return
	}
	templates.ConversationStream(sess).Render(r.Context(), w)
}

func handleHTMXTillDone(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	sess := store.GetSession(sessionID)
	if sess == nil {
		return
	}
	if sess.TillDone != nil {
		templates.TillDonePanel(sess.TillDone).Render(r.Context(), w)
	}
}

func handleHTMXCosts(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	sess := store.GetSession(sessionID)
	if sess == nil {
		return
	}
	templates.CostTracker(sess).Render(r.Context(), w)
}
