package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
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
		if err := EnsureAuthTokens(ctx); err != nil {
			log.Printf("WARNING: failed to set up auth tokens: %v", err)
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
			log.Printf("Marked %d stale sessions as error", n)
		}

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
					Status:     s.Status,
					StartedAt:  s.CreatedAt,
				}
				if s.Status == "active" {
					sess.Status = "error"
				}
				sess.Agents = make(map[string]*models.Agent)
				for _, evt := range eventsBySession[s.ID] {
					if evt.EventType == "agent_spawn" {
						var data map[string]interface{}
						json.Unmarshal(evt.Payload, &data)
						agentID := ""
						if evt.AgentID != nil {
							agentID = *evt.AgentID
						}
						name, _ := data["agent_name"].(string)
						role, _ := data["agent_role"].(string)
						model, _ := data["model"].(string)
						teamName, _ := data["team_name"].(string)
						teamColor, _ := data["team_color"].(string)
						sess.Agents[agentID] = &models.Agent{
							ID: agentID, Name: name, Role: models.AgentRole(role),
							Model: model, TeamName: teamName, TeamColor: teamColor,
							Status: models.StatusDone,
						}
					}
				}
				sess.TotalCost = 0
				for _, a := range sess.Agents {
					sess.TotalCost += a.CostUSD
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
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)
	r.Use(rateLimitMiddleware)
	r.Use(authMiddleware)
	r.Use(maxBodySize)

	// Page routes
	r.Get("/", handleDashboard)
	r.Get("/session/{sessionID}", handleSession)
	r.Get("/agents", handleAgentsList)
	r.Get("/agents/{slug}", handleAgentDetail)

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
		r.Route("/pg/sessions", func(r chi.Router) {
			r.Get("/", handleAPIGetSessions)
			r.Post("/", handleAPICreateSession)
			r.Patch("/{id}", handleAPIPatchSession)
			r.Get("/{id}/agents", handleAPIGetAgents)
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

	log.Printf("Dashboard running at http://localhost:%s", port)
	log.Fatal(srv.ListenAndServe())
}

// --- Middleware ---

func corsMiddleware(next http.Handler) http.Handler {
	allowedOrigin := os.Getenv("CORS_ALLOWED_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "http://localhost:8400"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == allowedOrigin || origin == "" {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
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

		path := r.URL.Path
		isAPI := strings.HasPrefix(path, "/api/")
		isPublicAPI := path == "/api/health" || strings.HasSuffix(path, "/stream")
		isUIPage := !isAPI

		// Allow unauthenticated GET/HEAD for UI pages and public API endpoints
		if (r.Method == "GET" || r.Method == "HEAD") && (isUIPage || isPublicAPI) {
			next.ServeHTTP(w, r)
			return
		}

		// Fail closed: if no tokens loaded (DB offline), reject auth-required requests
		if len(tokenMap) == 0 {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"auth unavailable - database offline"}`, http.StatusServiceUnavailable)
			return
		}

		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"authorization required"}`, http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(auth, "Bearer ")

		user, ok := tokenMap[token]
		if !ok {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
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
