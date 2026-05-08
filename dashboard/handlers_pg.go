package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

func requireDB(w http.ResponseWriter) bool {
	if !dbEnabled {
		http.Error(w, "database not available", http.StatusServiceUnavailable)
		return false
	}
	return true
}

func dbError(w http.ResponseWriter, context string, err error) {
	log.Printf("db error [%s]: %v", context, err)
	http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
}

func handleAPIGetUsers(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	users, err := GetUsers(r.Context())
	if err != nil {
		dbError(w, "get users", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(users)
}

func handleAPIGetSessions(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	username := r.URL.Query().Get("user")
	var sessions []DBSession
	var err error
	if username != "" {
		sessions, err = GetSessionsByUser(r.Context(), username)
	} else {
		sessions, err = GetSessions(r.Context())
	}
	if err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

func handleAPICreateSession(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	var req struct {
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Platform string          `json:"platform"`
		User     string          `json:"user"`
		UserID   *int            `json:"user_id,omitempty"`
		Team     *string         `json:"team,omitempty"`
		Chain    *string         `json:"chain,omitempty"`
		Config   json.RawMessage `json:"config,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	if req.Platform == "" {
		req.Platform = "multi-agent-engine"
	}

	if req.UserID == nil && req.User != "" {
		u, err := GetUserByUsername(r.Context(), req.User)
		if err != nil {
			dbError(w, "user lookup", err)
			return
		}
		if u != nil {
			req.UserID = &u.ID
		}
	}

	sess := &DBSession{
		ID:       req.ID,
		UserID:   req.UserID,
		Name:     req.Name,
		Platform: req.Platform,
		Team:     req.Team,
		Chain:    req.Chain,
		Status:   "active",
		Config:   req.Config,
	}
	if sess.ID == "" {
		b := make([]byte, 16)
		rand.Read(b)
		b[6] = (b[6] & 0x0f) | 0x40
		b[8] = (b[8] & 0x3f) | 0x80
		sess.ID = fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	}

	if err := CreateSession(r.Context(), sess); err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(sess)
}

func handleAPIPatchSession(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	id := chi.URLParam(r, "id")
	var req struct {
		Name   *string `json:"name,omitempty"`
		Status *string `json:"status,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := UpdateSession(r.Context(), id, req.Name, req.Status); err != nil {
		dbError(w, "query", err)
		return
	}
	sess, err := GetDBSession(r.Context(), id)
	if err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sess)
}

func handleAPIGetAgents(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	sessionID := chi.URLParam(r, "id")
	agents, err := GetAgentsBySession(r.Context(), sessionID)
	if err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(agents)
}

func handleAPICreateAgent(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	sessionID := chi.URLParam(r, "id")
	var req struct {
		AgentID string          `json:"agent_id"`
		Role    string          `json:"role"`
		Persona *string         `json:"persona,omitempty"`
		Adapter *string         `json:"adapter,omitempty"`
		Status  string          `json:"status"`
		Prompt  *string         `json:"prompt,omitempty"`
		Config  json.RawMessage `json:"config,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.AgentID == "" || req.Role == "" {
		http.Error(w, "agent_id and role are required", http.StatusBadRequest)
		return
	}
	if req.Status == "" {
		req.Status = "pending"
	}

	agent := &DBAgent{
		SessionID: sessionID,
		AgentID:   req.AgentID,
		Role:      req.Role,
		Persona:   req.Persona,
		Adapter:   req.Adapter,
		Status:    req.Status,
		Prompt:    req.Prompt,
		Config:    req.Config,
	}
	if err := CreateAgent(r.Context(), agent); err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(agent)
}

func handleAPIPatchAgent(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid agent id", http.StatusBadRequest)
		return
	}
	var req struct {
		Status  *string         `json:"status,omitempty"`
		Config  json.RawMessage `json:"config,omitempty"`
		Result  json.RawMessage `json:"result,omitempty"`
		CostUSD *float64        `json:"cost_usd,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := UpdateAgent(r.Context(), id, req.Status, req.Config, req.Result, req.CostUSD); err != nil {
		dbError(w, "query", err)
		return
	}
	agent, err := GetDBAgent(r.Context(), id)
	if err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(agent)
}

// --- Agent Traces ---

func handleCreateTrace(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	var req struct {
		SessionID string          `json:"session_id"`
		AgentID   string          `json:"agent_id"`
		Direction string          `json:"direction"`
		Content   string          `json:"content"`
		Metadata  json.RawMessage `json:"metadata,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.SessionID == "" || req.AgentID == "" || req.Direction == "" || req.Content == "" {
		http.Error(w, "session_id, agent_id, direction, and content are required", http.StatusBadRequest)
		return
	}
	if req.Direction != "input" && req.Direction != "output" {
		http.Error(w, "direction must be 'input' or 'output'", http.StatusBadRequest)
		return
	}

	trace := &DBTrace{
		SessionID: req.SessionID,
		AgentID:   req.AgentID,
		Direction: req.Direction,
		Content:   req.Content,
		Metadata:  req.Metadata,
	}
	if err := RecordTrace(r.Context(), trace); err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(trace)
}

func handleSearchTraces(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	query := r.URL.Query().Get("q")
	if query == "" {
		http.Error(w, "q parameter required", http.StatusBadRequest)
		return
	}
	sessionID := r.URL.Query().Get("session_id")
	traces, err := SearchTraces(r.Context(), query, sessionID)
	if err != nil {
		dbError(w, "query", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(traces)
}

// GET /api/pg/sessions/:id/events -- all events for a session (replay)
func handleAPIGetSessionEvents(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	sessionID := chi.URLParam(r, "id")
	if sessionID == "" {
		http.Error(w, "session id required", http.StatusBadRequest)
		return
	}

	rows, err := db.QueryContext(r.Context(),
		`SELECT id, session_id, agent_id, event_type, payload, created_at 
		 FROM events 
		 WHERE session_id = $1 
		 ORDER BY created_at ASC, id ASC`,
		sessionID)
	if err != nil {
		dbError(w, "query events", err)
		return
	}
	defer rows.Close()

	type Event struct {
		ID        int64           `json:"id"`
		SessionID string          `json:"session_id"`
		AgentID   string          `json:"agent_id"`
		EventType string          `json:"event_type"`
		Payload   json.RawMessage `json:"payload"`
		CreatedAt time.Time       `json:"created_at"`
	}

	var events []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.SessionID, &e.AgentID, &e.EventType, &e.Payload, &e.CreatedAt); err != nil {
			continue
		}
		events = append(events, e)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(events)
}

// GET /api/pg/sessions/history -- sessions with aggregated cost/tokens
func handleAPISessionHistory(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	rows, err := db.QueryContext(r.Context(), `
		SELECT 
			s.id, s.name, s.chain, s.status, s.created_at, s.completed_at,
			COALESCE(SUM(a.cost_usd), 0) as total_cost,
			COUNT(DISTINCT a.id) as agent_count,
			EXTRACT(EPOCH FROM COALESCE(s.completed_at, NOW()) - s.created_at) as duration_secs
		FROM sessions s
		LEFT JOIN agents a ON a.session_id = s.id
		GROUP BY s.id
		ORDER BY s.created_at DESC
		LIMIT $1`, limit)
	if err != nil {
		dbError(w, "query history", err)
		return
	}
	defer rows.Close()

	type HistoryEntry struct {
		ID          string     `json:"id"`
		Name        string     `json:"name"`
		Chain       *string    `json:"chain"`
		Status      string     `json:"status"`
		CreatedAt   time.Time  `json:"created_at"`
		CompletedAt *time.Time `json:"completed_at"`
		TotalCost   float64    `json:"total_cost"`
		AgentCount  int        `json:"agent_count"`
		DurationSec float64    `json:"duration_secs"`
	}

	var history []HistoryEntry
	for rows.Next() {
		var h HistoryEntry
		if err := rows.Scan(&h.ID, &h.Name, &h.Chain, &h.Status, &h.CreatedAt, &h.CompletedAt,
			&h.TotalCost, &h.AgentCount, &h.DurationSec); err != nil {
			continue
		}
		history = append(history, h)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}
