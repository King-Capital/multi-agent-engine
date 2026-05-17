package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"mae.local/dashboard/internal/events"
	"mae.local/dashboard/internal/models"
)

var store *events.Store
var dbEnabled bool
var startTime time.Time
var tokenMap map[string]*DBUser

type contextKey string

const userContextKey contextKey = "user"

func initLogger() {
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})
	logger := slog.New(handler)
	slog.SetDefault(logger)
	log.SetOutput(&slogWriter{logger: logger})
}

type slogWriter struct {
	logger *slog.Logger
}

func (w *slogWriter) Write(p []byte) (int, error) {
	w.logger.Info(strings.TrimSpace(string(p)))
	return len(p), nil
}

func structuredLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)

		if strings.HasSuffix(r.URL.Path, "/stream") {
			return
		}

		slog.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"bytes", ww.BytesWritten(),
			"duration_ms", fmt.Sprintf("%.1f", float64(time.Since(start).Microseconds())/1000),
			"remote", r.RemoteAddr,
		)
	})
}

func main() {
	initLogger()

	dataDir := os.Getenv("DASHBOARD_DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(".", "data", "sessions")
	}

	var err error
	store, err = events.NewStore(dataDir)
	if err != nil {
		log.Fatalf("failed to create store: %v", err)
	}

	startTime = time.Now()

	if n := store.ReapInactiveSessions(10 * time.Minute); n > 0 {
		log.Printf("Reaped %d stale sessions on startup", n)
	}
	store.StartReaper(1*time.Minute, 10*time.Minute)

	if err := InitDB(); err != nil {
		log.Printf("WARNING: PostgreSQL unavailable, running without persistence: %v", err)
		dbEnabled = false
	} else {
		dbEnabled = true
		ctx := context.Background()
		if err := EnsureAuthSchema(ctx); err != nil {
			log.Printf("WARNING: failed to set up auth schema: %v", err)
		}
		if err := EnsureBootstrapPassword(ctx); err != nil {
			log.Printf("WARNING: failed to apply bootstrap auth password: %v", err)
		}
		if err := EnsureAuthTokens(ctx); err != nil {
			log.Printf("WARNING: failed to set up legacy auth tokens: %v", err)
		}
		if m, err := LoadTokenMap(ctx); err != nil {
			log.Printf("WARNING: failed to load token map: %v", err)
		} else {
			tokenMap = m
			log.Printf("Loaded %d API tokens", len(tokenMap))
		}

		if n, err := MarkStaleSessions(ctx, 30); err != nil {
			log.Printf("WARNING: failed to mark stale sessions: %v", err)
		} else if n > 0 {
			log.Printf("Marked %d stale sessions as completed", n)
		}

		// Periodic stale session reaper — every 5 minutes, mark open sessions
		// with no events in the last 30 minutes as completed.
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				bgCtx := context.Background()
				if n, err := MarkStaleSessions(bgCtx, 30); err != nil {
					log.Printf("stale reaper error: %v", err)
				} else if n > 0 {
					log.Printf("Stale reaper: marked %d sessions as completed", n)
				}
			}
		}()

		if sessions, eventsBySession, err := HydrateRecentSessions(ctx, 50); err != nil {
			log.Printf("WARNING: failed to hydrate sessions: %v", err)
		} else {
			for _, s := range sessions {
				chainStr := ""
				if s.Chain != nil {
					chainStr = *s.Chain
				}
				sess := &models.Session{
					ID:         s.ID,
					Name:       s.Name,
					TeamConfig: chainStr,
					ChainType:  chainStr,
					Status:     s.Status,
					StartedAt:  s.CreatedAt,
				}
				if s.Status == "active" {
					sess.Status = "error"
				}
				sess.Agents = make(map[string]*models.Agent)

				// Track timestamps for elapsed calculation
				var firstEvent, lastEvent time.Time

				for _, evt := range eventsBySession[s.ID] {
					// Track event time range
					if firstEvent.IsZero() || evt.CreatedAt.Before(firstEvent) {
						firstEvent = evt.CreatedAt
					}
					if evt.CreatedAt.After(lastEvent) {
						lastEvent = evt.CreatedAt
					}

					var payload map[string]interface{}
					json.Unmarshal(evt.Payload, &payload)
					data, _ := payload["data"].(map[string]interface{})
					if data == nil {
						data = payload
					}

					switch evt.EventType {
					case "session_start":
						if name, ok := data["session_name"].(string); ok && name != "" {
							sess.Name = name
						}
						if task, ok := data["task_prompt"].(string); ok {
							sess.TaskPrompt = task
						}
						if chain, ok := data["team_config"].(string); ok {
							sess.TeamConfig = chain
							sess.ChainType = chain
						}

					case "agent_spawn":
						agentID := ""
						if evt.AgentID != nil {
							agentID = *evt.AgentID
						}
						if agentID == "" {
							if aid, ok := payload["agent_id"].(string); ok {
								agentID = aid
							}
						}
						if agentID == "" {
							continue
						}
						name, _ := data["agent_name"].(string)
						role, _ := data["agent_role"].(string)
						model, _ := data["model"].(string)
						teamName, _ := data["team_name"].(string)
						teamColor, _ := data["team_color"].(string)
						parentID, _ := payload["parent_id"].(string)
						sess.Agents[agentID] = &models.Agent{
							ID: agentID, Name: name, Role: models.AgentRole(role),
							Model: model, TeamName: teamName, TeamColor: teamColor,
							ParentID:  parentID,
							Status:    models.StatusRunning,
							StartedAt: evt.CreatedAt,
						}

					case "agent_done":
						agentID := ""
						if evt.AgentID != nil {
							agentID = *evt.AgentID
						}
						if agentID == "" {
							if aid, ok := payload["agent_id"].(string); ok {
								agentID = aid
							}
						}
						if a, ok := sess.Agents[agentID]; ok {
							a.Status = models.StatusDone
						}

					case "error":
						agentID := ""
						if evt.AgentID != nil {
							agentID = *evt.AgentID
						}
						if agentID == "" {
							if aid, ok := payload["agent_id"].(string); ok {
								agentID = aid
							}
						}
						if a, ok := sess.Agents[agentID]; ok {
							a.Status = models.StatusError
						}

					case "cost_update":
						agentID := ""
						if evt.AgentID != nil {
							agentID = *evt.AgentID
						}
						if a, ok := sess.Agents[agentID]; ok {
							if cost, ok := payload["cost_usd"].(float64); ok && cost > a.CostUSD {
								a.CostUSD = cost
							}
							if tokens, ok := payload["tokens_used"].(float64); ok && int64(tokens) > a.TokensUsed {
								a.TokensUsed = int64(tokens)
							}
							if ctxTok, ok := payload["context_tokens"].(float64); ok && int64(ctxTok) > a.ContextTokens {
								a.ContextTokens = int64(ctxTok)
							}
							if cost, ok := data["cost_usd"].(float64); ok && cost > a.CostUSD {
								a.CostUSD = cost
							}
							if tokens, ok := data["tokens_used"].(float64); ok && int64(tokens) > a.TokensUsed {
								a.TokensUsed = int64(tokens)
							}
						}
					}
				}

				// Fall back to PG agents table for cost data
				if pgAgents, err := GetAgentsBySession(ctx, s.ID); err == nil {
					for _, pa := range pgAgents {
						if a, ok := sess.Agents[pa.AgentID]; ok {
							if pa.CostUSD > a.CostUSD {
								a.CostUSD = pa.CostUSD
							}
						} else {
							sess.Agents[pa.AgentID] = &models.Agent{
								ID:      pa.AgentID,
								Name:    pa.AgentID,
								Role:    models.AgentRole(pa.Role),
								Status:  models.AgentStatus(pa.Status),
								CostUSD: pa.CostUSD,
							}
							if pa.StartedAt != nil {
								sess.Agents[pa.AgentID].StartedAt = *pa.StartedAt
							}
						}
					}
				}

				// Calculate elapsed time from events
				if !firstEvent.IsZero() && !lastEvent.IsZero() {
					sess.ElapsedMs = lastEvent.Sub(firstEvent).Milliseconds()
				} else if s.CompletedAt != nil {
					sess.ElapsedMs = s.CompletedAt.Sub(s.CreatedAt).Milliseconds()
				}

				// Aggregate costs
				sess.TotalCost = 0
				sess.TotalTokens = 0
				for _, a := range sess.Agents {
					sess.TotalCost += a.CostUSD
					sess.TotalTokens += a.TokensUsed
				}

				store.InjectSession(sess)
			}
			log.Printf("Hydrated %d sessions from PG", len(sessions))
		}

	}

	port := os.Getenv("DASHBOARD_PORT")
	if port == "" {
		port = "8400"
	}

	r := chi.NewRouter()
	r.Use(structuredLogger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)
	r.Use(authMiddleware)
	r.Use(maxBodySize)
	r.Use(rateLimitMiddleware)

	// Legacy templ page routes removed -- React SPA serves all UI

	// Static files (favicon, etc.)
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))

	// Dashboard Next SPA (React) -- serves from dashboard-next-dist/
	spaDir := filepath.Join(filepath.Dir(os.Args[0]), "..", "dashboard-next-dist")
	if info, err := os.Stat(spaDir); err == nil && info.IsDir() {
		slog.Info("spa_enabled", "dir", spaDir)
		spaFS := http.FileServer(http.Dir(spaDir))
		// Serve SPA assets (hashed filenames)
		r.Handle("/assets/*", spaFS)
		// Serve favicon from SPA dist
		r.Get("/favicon.svg", func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, filepath.Join(spaDir, "favicon.svg"))
		})
		// SPA catch-all: any non-API, non-HTMX route falls through to index.html
		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			// Don't serve SPA for API or HTMX routes
			if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/htmx/") {
				http.NotFound(w, r)
				return
			}
			http.ServeFile(w, r, filepath.Join(spaDir, "index.html"))
		})
	} else {
		slog.Warn("spa_disabled", "dir", spaDir, "reason", "directory not found — UI routes will return 404. Run: cd dashboard-next && bun run build && cp -r dist ../dashboard-next-dist")
	}

	// Prometheus metrics (public, no auth needed - handled by authMiddleware allowing GET on non-API paths)
	r.Get("/metrics", handleMetrics)

	// Agent persona API
	r.Route("/api/agents", func(r chi.Router) {
		r.Get("/{slug}/prompt", handleGetAgentPrompt)
		r.Put("/{slug}", handleSaveAgent)
		r.Post("/{slug}/ai-assist", handleAIAssist)
	})

	// Core API
	r.Route("/api", func(r chi.Router) {
		r.Get("/health", handleHealth)
		r.Post("/events", handlePostEvent)
		r.Get("/sessions", handleListSessions)
		r.Get("/sessions/{sessionID}", handleGetSession)
		r.Get("/sessions/{sessionID}/stream", handleSSE)
		r.Get("/stream", handleSSEAll)
		r.Delete("/sessions/{sessionID}", handleDeleteSession)
		r.Post("/sessions/close-stale", handleCloseStale)
		r.Delete("/sessions/stale", handleClearStale)
		r.Delete("/sessions/all", handleClearAll)
		r.Patch("/sessions/{sessionID}/status", handleSetSessionStatus)
		r.Post("/sessions/{sessionID}/message", handleUserMessage)

		// PG-backed endpoints
		r.Get("/users", handleAPIGetUsers)
		r.Get("/pg/history", handleAPISessionHistory)
		r.Get("/pg/stats", handleAPIStats)
		r.Post("/auth/login", handleAuthLogin)
		r.Post("/auth/logout", handleAuthLogout)
		r.Get("/auth/me", handleAuthMe)
		r.Get("/admin/tokens", handleAdminListTokens)
		r.Post("/admin/tokens", handleAdminCreateToken)
		r.Delete("/admin/tokens/{id}", handleAdminRevokeToken)

		r.Route("/pg/sessions", func(r chi.Router) {
			r.Get("/", handleAPIGetSessions)
			r.Post("/", handleAPICreateSession)
			r.Get("/{id}", handleAPIGetSession)
			r.Patch("/{id}", handleAPIPatchSession)
			r.Get("/{id}/agents", handleAPIGetAgents)
			r.Get("/{id}/events", handleAPIGetSessionEvents)
			r.Get("/{id}/diff", handleAPIGetSessionDiff)
			r.Post("/{id}/agents", handleAPICreateAgent)
		})
		r.Patch("/pg/agents/{id}", handleAPIPatchAgent)

		r.Post("/traces", handleCreateTrace)
		r.Get("/traces/search", handleSearchTraces)
	})

	// HTMX partials + SSE
	r.Get("/htmx/sessions", handleHTMXSessions)
	r.Get("/htmx/session/{sessionID}/agents", handleHTMXAgentTree)
	r.Get("/htmx/session/{sessionID}/conversation", handleHTMXConversation)
	r.Get("/htmx/session/{sessionID}/tilldone", handleHTMXTillDone)
	r.Get("/htmx/session/{sessionID}/costs", handleHTMXCosts)
	r.Get("/htmx/session/{sessionID}/graph", handleHTMXAgentGraph)
	r.Get("/htmx/session/{sessionID}/stream", handleHTMXSSE)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
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

	slog.Info("dashboard_start", "port", port, "addr", "http://localhost:"+port)
	log.Fatal(srv.ListenAndServe())
}

// --- Middleware ---

var allowedOrigins []string

func init() {
	origins := os.Getenv("CORS_ORIGINS")
	if origins != "" {
		for _, o := range strings.Split(origins, ",") {
			allowedOrigins = append(allowedOrigins, strings.TrimSpace(o))
		}
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if len(allowedOrigins) > 0 {
			for _, allowed := range allowedOrigins {
				if origin == allowed {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					break
				}
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Add("Vary", "Origin")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func maxBodySize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		next.ServeHTTP(w, r)
	})
}

func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Always allow CORS preflight
		if r.Method == "OPTIONS" {
			next.ServeHTTP(w, r)
			return
		}

		if isPublicPath(r) {
			next.ServeHTTP(w, r)
			return
		}

		user, err := authenticateRequest(r)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"auth failed"}`, http.StatusInternalServerError)
			return
		}
		if user == nil {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"authorization required"}`, http.StatusUnauthorized)
			return
		}
		if requiresCSRFCheck(r) && !hasValidRequestOrigin(r) {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"valid origin required"}`, http.StatusForbidden)
			return
		}

		ctx := context.WithValue(r.Context(), userContextKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func getAuthUser(r *http.Request) *DBUser {
	u, _ := r.Context().Value(userContextKey).(*DBUser)
	return u
}

func requiresCSRFCheck(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return false
	}
	return !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func hasValidRequestOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" {
		return originAllowedForRequest(r, origin)
	}
	referer := r.Header.Get("Referer")
	if referer == "" {
		return false
	}
	return originAllowedForRequest(r, referer)
}

func originAllowedForRequest(r *http.Request, raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return false
	}
	if strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	for _, allowed := range allowedOrigins {
		allowedURL, err := url.Parse(allowed)
		if err == nil && strings.EqualFold(allowedURL.Scheme, parsed.Scheme) && strings.EqualFold(allowedURL.Host, parsed.Host) {
			return true
		}
	}
	return false
}

// --- Rate Limiting ---

var (
	rateMu  sync.Mutex
	rateMap = make(map[string]*rateLimiter)
)

type rateLimiter struct {
	tokens     float64
	lastTime   time.Time
	maxTokens  float64
	refillRate float64
}

func rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only rate-limit mutating requests
		if r.Method == "GET" || r.Method == "HEAD" || r.Method == "OPTIONS" {
			next.ServeHTTP(w, r)
			return
		}
		// Exempt authenticated API clients (engine → dashboard)
		if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			next.ServeHTTP(w, r)
			return
		}
		ip := strings.Split(r.RemoteAddr, ":")[0]
		rateMu.Lock()
		rl, ok := rateMap[ip]
		if !ok {
			rl = &rateLimiter{tokens: 60, lastTime: time.Now(), maxTokens: 60, refillRate: 10}
			rateMap[ip] = rl
		}
		now := time.Now()
		elapsed := now.Sub(rl.lastTime).Seconds()
		rl.tokens = min(rl.maxTokens, rl.tokens+elapsed*rl.refillRate)
		rl.lastTime = now
		if rl.tokens < 1 {
			rateMu.Unlock()
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		rl.tokens--
		rateMu.Unlock()
		next.ServeHTTP(w, r)
	})
}

// --- Health ---

func getVersion() string {
	data, err := os.ReadFile("../VERSION")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(data))
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	dbStatus := "disabled"
	if dbEnabled {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			dbStatus = "disconnected"
		} else {
			dbStatus = "connected"
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "ok",
		"version":        getVersion(),
		"db":             dbStatus,
		"uptime_seconds": int(time.Since(startTime).Seconds()),
	})
}
