package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"mae.local/dashboard/templates"
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

	limit := 500
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 2000 {
			limit = n
		}
	}

	rows, err := db.QueryContext(r.Context(), `
		SELECT
			s.id, s.name, s.chain, s.status, s.created_at, s.completed_at,
			CASE
				WHEN COALESCE((SELECT SUM(max_cost) FROM (SELECT MAX((e.payload->>'cost_usd')::numeric) as max_cost FROM events e WHERE e.session_id = s.id AND e.event_type = 'cost_update' AND e.payload->>'cost_usd' IS NOT NULL GROUP BY e.agent_id) sub), 0) > 0
					THEN COALESCE((SELECT SUM(max_cost) FROM (SELECT MAX((e.payload->>'cost_usd')::numeric) as max_cost FROM events e WHERE e.session_id = s.id AND e.event_type = 'cost_update' AND e.payload->>'cost_usd' IS NOT NULL GROUP BY e.agent_id) sub), 0)
				ELSE COALESCE(SUM(a.cost_usd), 0)
			END as total_cost,
			COALESCE((SELECT SUM(max_tokens) FROM (SELECT MAX((e.payload->>'tokens_used')::bigint) as max_tokens FROM events e WHERE e.session_id = s.id AND e.event_type = 'cost_update' AND e.payload->>'tokens_used' IS NOT NULL GROUP BY e.agent_id) sub), COALESCE(SUM(a.tokens_used), 0), 0) as total_tokens,
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
		TotalTokens int64      `json:"total_tokens"`
		AgentCount  int        `json:"agent_count"`
		DurationSec float64    `json:"duration_secs"`
	}

	var history []HistoryEntry
	for rows.Next() {
		var h HistoryEntry
		if err := rows.Scan(&h.ID, &h.Name, &h.Chain, &h.Status, &h.CreatedAt, &h.CompletedAt,
			&h.TotalCost, &h.TotalTokens, &h.AgentCount, &h.DurationSec); err != nil {
			continue
		}
		history = append(history, h)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}

// GET /history -- render history page
func handleHistoryPage(w http.ResponseWriter, r *http.Request) {
	var entries []templates.HistoryEntry

	if db != nil {
		rows, err := db.QueryContext(r.Context(), `
			SELECT 
				s.id, s.name, COALESCE(s.chain, ''), s.status, 
				s.created_at, s.completed_at,
				COALESCE(SUM(a.cost_usd), 0) as total_cost,
				COUNT(DISTINCT a.id) as agent_count,
				EXTRACT(EPOCH FROM COALESCE(s.completed_at, NOW()) - s.created_at) as duration_secs
			FROM sessions s
			LEFT JOIN agents a ON a.session_id = s.id
			GROUP BY s.id
			ORDER BY s.created_at DESC
			LIMIT 100`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var e templates.HistoryEntry
				var createdAt, completedAt sql.NullTime
				var cost float64
				var agents int
				var duration float64
				if err := rows.Scan(&e.ID, &e.Name, &e.Chain, &e.Status,
					&createdAt, &completedAt, &cost, &agents, &duration); err != nil {
					continue
				}
				e.TotalCost = cost
				e.AgentCount = agents
				e.DurationSec = duration
				if createdAt.Valid {
					e.CreatedAt = createdAt.Time.Format("Jan 2 15:04")
				}
				if completedAt.Valid {
					e.CompletedAt = completedAt.Time.Format("Jan 2 15:04")
				}
				entries = append(entries, e)
			}
		}
	}

	templates.HistoryPage(entries).Render(r.Context(), w)
}

// GET /metrics -- Prometheus-compatible metrics endpoint
func handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")

	// Dashboard uptime (always available)
	uptimeSecs := int64(time.Since(startTime).Seconds())
	fmt.Fprintf(w, "# HELP mae_dashboard_uptime_seconds Dashboard uptime in seconds\n")
	fmt.Fprintf(w, "# TYPE mae_dashboard_uptime_seconds gauge\n")
	fmt.Fprintf(w, "mae_dashboard_uptime_seconds %d\n\n", uptimeSecs)

	if !dbEnabled || db == nil {
		// Without DB, emit only uptime and zeros
		fmt.Fprintf(w, "# HELP mae_sessions_total Total sessions by status\n")
		fmt.Fprintf(w, "# TYPE mae_sessions_total gauge\n")
		fmt.Fprintf(w, "mae_sessions_total{status=\"active\"} 0\n")
		fmt.Fprintf(w, "mae_sessions_total{status=\"completed\"} 0\n")
		fmt.Fprintf(w, "mae_sessions_total{status=\"failed\"} 0\n")
		fmt.Fprintf(w, "mae_sessions_total{status=\"cancelled\"} 0\n\n")

		fmt.Fprintf(w, "# HELP mae_agents_total Total agents by status\n")
		fmt.Fprintf(w, "# TYPE mae_agents_total gauge\n")
		fmt.Fprintf(w, "mae_agents_total{status=\"running\"} 0\n")
		fmt.Fprintf(w, "mae_agents_total{status=\"completed\"} 0\n")
		fmt.Fprintf(w, "mae_agents_total{status=\"failed\"} 0\n\n")

		fmt.Fprintf(w, "# HELP mae_total_cost_usd Total cost in USD across all agents\n")
		fmt.Fprintf(w, "# TYPE mae_total_cost_usd gauge\n")
		fmt.Fprintf(w, "mae_total_cost_usd 0\n\n")

		fmt.Fprintf(w, "# HELP mae_events_total Total event count\n")
		fmt.Fprintf(w, "# TYPE mae_events_total gauge\n")
		fmt.Fprintf(w, "mae_events_total 0\n")
		return
	}

	ctx := r.Context()

	// Sessions by status
	fmt.Fprintf(w, "# HELP mae_sessions_total Total sessions by status\n")
	fmt.Fprintf(w, "# TYPE mae_sessions_total gauge\n")
	sessionCounts := map[string]int64{"active": 0, "completed": 0, "failed": 0, "cancelled": 0}
	rows, err := db.QueryContext(ctx, `SELECT status, COUNT(*) FROM sessions GROUP BY status`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var status string
			var count int64
			if err := rows.Scan(&status, &count); err == nil {
				sessionCounts[status] = count
			}
		}
		rows.Close()
	}
	for _, s := range []string{"active", "completed", "failed", "cancelled"} {
		fmt.Fprintf(w, "mae_sessions_total{status=\"%s\"} %d\n", s, sessionCounts[s])
	}
	fmt.Fprintln(w)

	// Agents by status
	fmt.Fprintf(w, "# HELP mae_agents_total Total agents by status\n")
	fmt.Fprintf(w, "# TYPE mae_agents_total gauge\n")
	agentCounts := map[string]int64{"running": 0, "completed": 0, "failed": 0}
	rows2, err := db.QueryContext(ctx, `SELECT status, COUNT(*) FROM agents GROUP BY status`)
	if err == nil {
		defer rows2.Close()
		for rows2.Next() {
			var status string
			var count int64
			if err := rows2.Scan(&status, &count); err == nil {
				agentCounts[status] = count
			}
		}
		rows2.Close()
	}
	for _, s := range []string{"running", "completed", "failed"} {
		fmt.Fprintf(w, "mae_agents_total{status=\"%s\"} %d\n", s, agentCounts[s])
	}
	fmt.Fprintln(w)

	// Total cost
	fmt.Fprintf(w, "# HELP mae_total_cost_usd Total cost in USD across all agents\n")
	fmt.Fprintf(w, "# TYPE mae_total_cost_usd gauge\n")
	var totalCost float64
	if err := db.QueryRowContext(ctx, `SELECT CASE WHEN COALESCE(SUM(cost_usd), 0) > 0 THEN SUM(cost_usd) ELSE COALESCE((SELECT SUM(max_cost) FROM (SELECT MAX((payload->>'cost_usd')::numeric) as max_cost FROM events WHERE event_type = 'cost_update' AND payload->>'cost_usd' IS NOT NULL GROUP BY agent_id, session_id) sub), 0) END FROM agents`).Scan(&totalCost); err != nil {
		totalCost = 0
	}
	fmt.Fprintf(w, "mae_total_cost_usd %.6f\n\n", totalCost)

	// Total events
	fmt.Fprintf(w, "# HELP mae_events_total Total event count\n")
	fmt.Fprintf(w, "# TYPE mae_events_total gauge\n")
	var eventCount int64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&eventCount); err != nil {
		eventCount = 0
	}
	fmt.Fprintf(w, "mae_events_total %d\n", eventCount)
}

// GET /api/pg/stats -- aggregated stats for dashboard history page
func handleAPIStats(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}

	ctx := r.Context()

	type DayCost struct {
		Day  string  `json:"day"`
		Cost float64 `json:"cost"`
	}
	type ChainCost struct {
		Chain    string  `json:"chain"`
		Cost     float64 `json:"cost"`
		Sessions int     `json:"sessions"`
	}
	type StatsResponse struct {
		TotalSessions int         `json:"total_sessions"`
		TotalAgents   int         `json:"total_agents"`
		TotalCost     float64     `json:"total_cost"`
		TotalEvents   int64       `json:"total_events"`
		CostPerDay    []DayCost   `json:"cost_per_day"`
		TopChains     []ChainCost `json:"top_chains"`
	}

	var resp StatsResponse

	// Total sessions
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&resp.TotalSessions); err != nil {
		resp.TotalSessions = 0
	}

	// Total agents
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM agents`).Scan(&resp.TotalAgents); err != nil {
		resp.TotalAgents = 0
	}

	// Total cost — prefer agents sum; fall back to MAX per-agent from events for old sessions
	if err := db.QueryRowContext(ctx, `SELECT CASE
		WHEN COALESCE((SELECT SUM(cost_usd) FROM agents), 0) > 0 THEN (SELECT SUM(cost_usd) FROM agents)
		ELSE COALESCE((SELECT SUM(max_cost) FROM (SELECT MAX((payload->>'cost_usd')::numeric) as max_cost FROM events WHERE event_type = 'cost_update' AND payload->>'cost_usd' IS NOT NULL GROUP BY agent_id, session_id) sub), 0)
	END`).Scan(&resp.TotalCost); err != nil {
		resp.TotalCost = 0
	}

	// Total events
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&resp.TotalEvents); err != nil {
		resp.TotalEvents = 0
	}

	// Cost per day (last 30 days) — use MAX per agent per session to avoid double-counting incremental updates
	rows, err := db.QueryContext(ctx, `
		SELECT day, SUM(max_cost) as cost FROM (
			SELECT DATE(e.created_at) as day, e.session_id, e.agent_id, MAX((e.payload->>'cost_usd')::numeric) as max_cost
			FROM events e
			WHERE e.event_type = 'cost_update' AND e.payload->>'cost_usd' IS NOT NULL
			AND e.created_at > NOW() - INTERVAL '30 days'
			GROUP BY day, e.session_id, e.agent_id
		) sub
		GROUP BY day
		ORDER BY day`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var d DayCost
			var dayTime time.Time
			if err := rows.Scan(&dayTime, &d.Cost); err == nil {
				d.Day = dayTime.Format("2006-01-02")
				resp.CostPerDay = append(resp.CostPerDay, d)
			}
		}
		rows.Close()
	}
	if resp.CostPerDay == nil {
		resp.CostPerDay = []DayCost{}
	}

	// Top 5 chains by cost
	rows2, err := db.QueryContext(ctx, `
		SELECT s.chain, COALESCE(SUM(a.cost_usd), 0) as cost, COUNT(DISTINCT s.id) as sessions
		FROM sessions s
		JOIN agents a ON a.session_id = s.id
		WHERE s.chain IS NOT NULL
		GROUP BY s.chain
		ORDER BY cost DESC
		LIMIT 5`)
	if err == nil {
		defer rows2.Close()
		for rows2.Next() {
			var c ChainCost
			if err := rows2.Scan(&c.Chain, &c.Cost, &c.Sessions); err == nil {
				resp.TopChains = append(resp.TopChains, c)
			}
		}
		rows2.Close()
	}
	if resp.TopChains == nil {
		resp.TopChains = []ChainCost{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// GET /api/pg/sessions/:id/diff -- files touched during a session
func handleAPIGetSessionDiff(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	sessionID := chi.URLParam(r, "id")
	if sessionID == "" {
		http.Error(w, "session id required", http.StatusBadRequest)
		return
	}

	rows, err := db.QueryContext(r.Context(),
		`SELECT payload
		 FROM events
		 WHERE session_id = $1
		   AND event_type IN ('tool_call', 'tool_result')
		 ORDER BY created_at ASC`,
		sessionID)
	if err != nil {
		dbError(w, "query diff events", err)
		return
	}
	defer rows.Close()

	seen := make(map[string]bool)
	var files []string

	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			continue
		}

		// Extract file paths from payload JSON recursively
		extractPaths(raw, seen, &files)
	}

	type DiffResponse struct {
		Files []string `json:"files"`
		Count int      `json:"count"`
	}

	resp := DiffResponse{
		Files: files,
		Count: len(files),
	}
	if resp.Files == nil {
		resp.Files = []string{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// extractPaths walks a JSON value looking for file path fields.
func extractPaths(raw json.RawMessage, seen map[string]bool, files *[]string) {
	var obj map[string]interface{}
	if err := json.Unmarshal(raw, &obj); err == nil {
		extractPathsFromMap(obj, seen, files)
		return
	}

	var arr []interface{}
	if err := json.Unmarshal(raw, &arr); err == nil {
		for _, item := range arr {
			if m, ok := item.(map[string]interface{}); ok {
				extractPathsFromMap(m, seen, files)
			}
		}
	}
}

func extractPathsFromMap(obj map[string]interface{}, seen map[string]bool, files *[]string) {
	pathKeys := []string{"path", "file", "filename", "file_path", "filePath", "filepath"}
	for _, key := range pathKeys {
		if val, ok := obj[key]; ok {
			if s, ok := val.(string); ok && s != "" && !seen[s] && looksLikeFilePath(s) {
				seen[s] = true
				*files = append(*files, s)
			}
		}
	}

	// Recurse into nested objects
	for _, val := range obj {
		switch v := val.(type) {
		case map[string]interface{}:
			extractPathsFromMap(v, seen, files)
		case []interface{}:
			for _, item := range v {
				if m, ok := item.(map[string]interface{}); ok {
					extractPathsFromMap(m, seen, files)
				}
			}
		}
	}
}

// looksLikeFilePath returns true if the string looks like a file path
// (has an extension or starts with /, ./, or contains a path separator).
func looksLikeFilePath(s string) bool {
	if len(s) > 500 || len(s) < 2 {
		return false
	}
	// Must contain a dot (extension) or a slash (path separator)
	hasDot := false
	hasSlash := false
	for _, c := range s {
		if c == '.' {
			hasDot = true
		}
		if c == '/' {
			hasSlash = true
		}
		// Reject if it contains newlines or looks like prose
		if c == '\n' || c == '\r' {
			return false
		}
	}
	return hasDot || hasSlash
}

// GET /compare -- render model comparison page
func handleComparePage(w http.ResponseWriter, r *http.Request) {
	sessionA := r.URL.Query().Get("a")
	sessionB := r.URL.Query().Get("b")
	templates.ComparePage(sessionA, sessionB).Render(r.Context(), w)
}
