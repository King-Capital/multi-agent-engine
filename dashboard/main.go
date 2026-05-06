package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/King-Capital/multi-agent-engine/dashboard/internal/events"
	"github.com/King-Capital/multi-agent-engine/dashboard/internal/models"
	"github.com/King-Capital/multi-agent-engine/dashboard/templates"
)

var store *events.Store
var dbEnabled bool

func main() {
	dataDir := os.Getenv("DASHBOARD_DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(".", "data", "sessions")
	}

	var err error
	store, err = events.NewStore(dataDir)
	if err != nil {
		log.Fatalf("failed to create store: %v", err)
	}

	// Initialize PostgreSQL (optional -- dashboard works without it)
	if err := InitDB(); err != nil {
		log.Printf("WARNING: PostgreSQL unavailable, running without persistence: %v", err)
		dbEnabled = false
	} else {
		dbEnabled = true
	}

	port := os.Getenv("DASHBOARD_PORT")
	if port == "" {
		port = "8400"
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)
	r.Use(maxBodySize)

	r.Get("/", handleDashboard)
	r.Get("/session/{sessionID}", handleSession)
	r.Get("/agents", handleAgentsList)
	r.Get("/agents/{slug}", handleAgentDetail)

	r.Route("/api/agents", func(r chi.Router) {
		r.Get("/{slug}/prompt", handleGetAgentPrompt)
		r.Put("/{slug}", handleSaveAgent)
		r.Post("/{slug}/ai-assist", handleAIAssist)
	})

	r.Route("/api", func(r chi.Router) {
		r.Post("/events", handlePostEvent)
		r.Get("/sessions", handleListSessions)
		r.Get("/sessions/{sessionID}", handleGetSession)
		r.Get("/sessions/{sessionID}/stream", handleSSE)
		r.Get("/stream", handleSSEAll)
		r.Delete("/sessions/completed", handleClearCompleted)
		r.Delete("/sessions/stale", handleClearStale)
		r.Delete("/sessions/all", handleClearAll)
		r.Post("/sessions/{sessionID}/message", handleUserMessage)

		// PG-backed user and session management endpoints
		r.Get("/users", handleAPIGetUsers)
		r.Route("/pg/sessions", func(r chi.Router) {
			r.Get("/", handleAPIGetSessions)
			r.Post("/", handleAPICreateSession)
			r.Patch("/{id}", handleAPIPatchSession)
			r.Get("/{id}/agents", handleAPIGetAgents)
			r.Post("/{id}/agents", handleAPICreateAgent)
		})
		r.Patch("/pg/agents/{id}", handleAPIPatchAgent)
	})

	r.Get("/htmx/sessions", handleHTMXSessions)
	r.Get("/htmx/session/{sessionID}/agents", handleHTMXAgentTree)
	r.Get("/htmx/session/{sessionID}/conversation", handleHTMXConversation)
	r.Get("/htmx/session/{sessionID}/tilldone", handleHTMXTillDone)
	r.Get("/htmx/session/{sessionID}/costs", handleHTMXCosts)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	log.Printf("Dashboard running at http://localhost:%s", port)
	log.Fatal(srv.ListenAndServe())
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func maxBodySize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB
		next.ServeHTTP(w, r)
	})
}

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
	if evt.SessionID == "" {
		http.Error(w, "session_id required", http.StatusBadRequest)
		return
	}
	if err := store.Append(evt); err != nil {
		http.Error(w, "store error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Persist to PG in background (best-effort, don't block SSE)
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

func handleAgentsList(w http.ResponseWriter, r *http.Request) {
	agents := loadAllAgents()
	templates.AgentsPage(agents, nil).Render(r.Context(), w)
}

func handleAgentDetail(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	agents := loadAllAgents()
	var selected *templates.AgentInfo
	for i := range agents {
		if agents[i].Slug == slug {
			selected = &agents[i]
			break
		}
	}
	if selected == nil {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}
	templates.AgentsPage(agents, selected).Render(r.Context(), w)
}

func loadAllAgents() []templates.AgentInfo {
	baseDir := filepath.Join("..", "agents", "personas")
	entries, err := os.ReadDir(baseDir)
	if err != nil {
		log.Printf("failed to read personas dir: %v", err)
		return nil
	}

	var agents []templates.AgentInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		agent := parsePersona(filepath.Join(baseDir, e.Name()))
		if agent != nil {
			agents = append(agents, *agent)
		}
	}
	return agents
}

func parsePersona(path string) *templates.AgentInfo {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	content := string(data)

	fmMatch := regexp.MustCompile(`(?s)^---\n(.*?)\n---`).FindStringSubmatch(content)
	if fmMatch == nil {
		return nil
	}
	fm := fmMatch[1]

	getName := func(key string) string {
		re := regexp.MustCompile(`(?m)^` + key + `:\s*(.+)$`)
		m := re.FindStringSubmatch(fm)
		if m != nil {
			return strings.TrimSpace(m[1])
		}
		return ""
	}

	slug := strings.TrimSuffix(filepath.Base(path), ".md")
	name := getName("name")
	model := getName("model")

	var role string
	tools := parseYAMLList(fm, "tools")
	for _, t := range tools {
		if t == "delegate" && len(tools) == 1 {
			role = "orchestrator"
		}
	}
	if role == "" {
		hasDelegate := false
		hasWrite := false
		for _, t := range tools {
			if t == "delegate" { hasDelegate = true }
			if t == "write" || t == "edit" { hasWrite = true }
		}
		if hasDelegate { role = "lead" } else if hasWrite { role = "worker" } else { role = "worker" }
	}

	skills := parseSkillsWithUseWhen(fm)
	for i := range skills {
		skillPath := filepath.Join("..", skills[i].Path)
		skillData, err := os.ReadFile(skillPath)
		if err == nil {
			skills[i].Content = string(skillData)
		}
		parts := strings.Split(skills[i].Path, "/")
		sName := strings.TrimSuffix(parts[len(parts)-1], ".md")
		skills[i].Name = strings.ReplaceAll(sName, "-", " ")
		skills[i].Name = strings.Title(skills[i].Name)
	}

	expertisePath := getName("expertise")
	var expertise string
	if expertisePath != "" {
		ep := filepath.Join("..", expertisePath)
		d, err := os.ReadFile(ep)
		if err == nil {
			expertise = string(d)
		}
	}

	domainRead := parseNestedYAMLList(fm, "read")
	domainWrite := parseNestedYAMLList(fm, "write")

	return &templates.AgentInfo{
		Name:      name,
		Slug:      slug,
		Role:      role,
		Model:     model,
		Tools:     tools,
		Skills:    skills,
		Domain:    templates.DomainInfo{Read: domainRead, Write: domainWrite},
		Expertise: expertise,
	}
}

func parseYAMLList(fm, key string) []string {
	re := regexp.MustCompile(`(?m)^` + key + `:\s*\n((?:\s+-\s+.+\n?)*)`)
	m := re.FindStringSubmatch(fm)
	if m == nil { return nil }
	var items []string
	scanner := bufio.NewScanner(strings.NewReader(m[1]))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "- ") {
			val := strings.TrimPrefix(line, "- ")
			if !strings.Contains(val, ":") {
				items = append(items, strings.TrimSpace(val))
			}
		}
	}
	return items
}

func parseSkillsWithUseWhen(fm string) []templates.SkillInfo {
	var skills []templates.SkillInfo
	re := regexp.MustCompile(`(?m)^\s+-\s+path:\s+(.+)\n\s+use-when:\s+(.+)`)
	matches := re.FindAllStringSubmatch(fm, -1)
	for _, m := range matches {
		skills = append(skills, templates.SkillInfo{
			Path:    strings.TrimSpace(m[1]),
			UseWhen: strings.TrimSpace(m[2]),
		})
	}
	if len(skills) == 0 {
		re2 := regexp.MustCompile(`(?m)^\s+-\s+(agents/skills/.+\.md)`)
		matches2 := re2.FindAllStringSubmatch(fm, -1)
		for _, m := range matches2 {
			skills = append(skills, templates.SkillInfo{Path: strings.TrimSpace(m[1])})
		}
	}
	return skills
}

func parseNestedYAMLList(fm, key string) []string {
	re := regexp.MustCompile(`(?m)` + key + `:\s*\[(.+?)\]`)
	m := re.FindStringSubmatch(fm)
	if m == nil { return nil }
	parts := strings.Split(m[1], ",")
	var items []string
	for _, p := range parts {
		items = append(items, strings.Trim(strings.TrimSpace(p), `"`))
	}
	return items
}

func handleUserMessage(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	r.ParseForm()
	content := r.FormValue("content")
	if content == "" {
		http.Error(w, "empty message", http.StatusBadRequest)
		return
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

func handleGetAgentPrompt(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	path := filepath.Join("..", "agents", "personas", slug+".md")
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	content := string(data)
	re := regexp.MustCompile(`(?s)^---\n.*?\n---\n(.*)$`)
	m := re.FindStringSubmatch(content)
	if m != nil {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(strings.TrimSpace(m[1])))
	} else {
		w.Write(data)
	}
}

func handleSaveAgent(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	path := filepath.Join("..", "agents", "personas", slug+".md")

	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	var form struct {
		Model        string   `json:"model"`
		Tools        []string `json:"tools"`
		DomainRead   string   `json:"domainRead"`
		DomainWrite  string   `json:"domainWrite"`
		SystemPrompt string   `json:"systemPrompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&form); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	content := string(data)
	re := regexp.MustCompile(`(?s)^(---\n)(.*?)(\n---)\n.*$`)
	m := re.FindStringSubmatch(content)
	if m == nil {
		http.Error(w, "bad persona format", http.StatusInternalServerError)
		return
	}

	fm := m[2]
	fm = regexp.MustCompile(`(?m)^model:\s+.+$`).ReplaceAllString(fm, "model: "+form.Model)

	toolsYaml := "tools:\n"
	for _, t := range form.Tools {
		toolsYaml += "  - " + t + "\n"
	}
	fm = regexp.MustCompile(`(?s)tools:\n(?:\s+-\s+.+\n?)*`).ReplaceAllString(fm, toolsYaml)

	if form.DomainRead != "" || form.DomainWrite != "" {
		domainYaml := "domain:\n"
		domainYaml += fmt.Sprintf("  read: [\"%s\"]\n", form.DomainRead)
		domainYaml += fmt.Sprintf("  write: [\"%s\"]\n", form.DomainWrite)
		fm = regexp.MustCompile(`(?s)domain:\n(?:\s+.+\n?)*`).ReplaceAllString(fm, domainYaml)
	}

	newContent := "---\n" + fm + "\n---\n\n" + form.SystemPrompt + "\n"
	if err := os.WriteFile(path, []byte(newContent), 0644); err != nil {
		http.Error(w, "write failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
}

func handleAIAssist(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req struct {
		Prompt string   `json:"prompt"`
		Model  string   `json:"model"`
		Tools  []string `json:"tools"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	litellmURL := os.Getenv("LITELLM_URL")
	if litellmURL == "" {
		litellmURL = "http://10.71.1.33:4000"
	}
	litellmKey := os.Getenv("LITELLM_KEY")
	if litellmKey == "" {
		litellmKey = os.Getenv("ANTHROPIC_API_KEY")
	}

	aiPrompt := fmt.Sprintf(`You are an expert at building multi-agent system personas.

Review this agent persona for "%s" and suggest improvements. The agent has tools: %s.

Current system prompt:
---
%s
---

Provide an improved version of the system prompt that:
1. Is more specific about the agent's responsibilities
2. Has clearer rules for when to delegate vs execute
3. Includes better output format specifications
4. Addresses edge cases

Return ONLY the improved system prompt markdown, no explanation.`, slug, strings.Join(req.Tools, ", "), req.Prompt)

	body, _ := json.Marshal(map[string]interface{}{
		"model": "sonnet",
		"messages": []map[string]string{
			{"role": "user", "content": aiPrompt},
		},
		"max_tokens": 2000,
	})

	httpReq, _ := http.NewRequest("POST", litellmURL+"/v1/chat/completions", strings.NewReader(string(body)))
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+litellmKey)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		http.Error(w, "LiteLLM error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		http.Error(w, "parse error: "+err.Error(), http.StatusBadGateway)
		return
	}

	if len(result.Choices) > 0 {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(result.Choices[0].Message.Content))
	} else {
		http.Error(w, "no response from LiteLLM", http.StatusBadGateway)
	}
}

func handleClearCompleted(w http.ResponseWriter, r *http.Request) {
	store.ClearCompleted()
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "cleared"})
}

func handleClearStale(w http.ResponseWriter, r *http.Request) {
	store.ClearStale(10 * time.Minute)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "cleared"})
}

func handleClearAll(w http.ResponseWriter, r *http.Request) {
	store.ClearAll()
	if r.Header.Get("HX-Request") == "true" {
		sessions := store.ListSessions()
		templates.SessionListItems(sessions).Render(r.Context(), w)
		return
	}
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "cleared"})
}

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

// --- PG-backed API handlers ---

func requireDB(w http.ResponseWriter) bool {
	if !dbEnabled {
		http.Error(w, "database not available", http.StatusServiceUnavailable)
		return false
	}
	return true
}

func handleAPIGetUsers(w http.ResponseWriter, r *http.Request) {
	if !requireDB(w) {
		return
	}
	users, err := GetUsers(r.Context())
	if err != nil {
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
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
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
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
			http.Error(w, "user lookup: "+err.Error(), http.StatusInternalServerError)
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
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
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
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	sess, err := GetDBSession(r.Context(), id)
	if err != nil {
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
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
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
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
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
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
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	agent, err := GetDBAgent(r.Context(), id)
	if err != nil {
		http.Error(w, "db error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(agent)
}
