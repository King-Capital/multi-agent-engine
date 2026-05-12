package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var db *sql.DB

// DB model types for PG-backed storage (separate from in-memory models)

type DBUser struct {
	ID          int       `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	UID         int       `json:"uid"`
	GID         int       `json:"gid"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"created_at"`
}

type DBSession struct {
	ID          string          `json:"id"`
	UserID      *int            `json:"user_id,omitempty"`
	Name        string          `json:"name"`
	Platform    string          `json:"platform"`
	Team        *string         `json:"team,omitempty"`
	Chain       *string         `json:"chain,omitempty"`
	Status      string          `json:"status"`
	Config      json.RawMessage `json:"config,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
}

type DBAgent struct {
	ID          int             `json:"id"`
	SessionID   string          `json:"session_id"`
	AgentID     string          `json:"agent_id"`
	Role        string          `json:"role"`
	Persona     *string         `json:"persona,omitempty"`
	Adapter     *string         `json:"adapter,omitempty"`
	Status      string          `json:"status"`
	Prompt      *string         `json:"prompt,omitempty"`
	Config      json.RawMessage `json:"config,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	CostUSD     float64         `json:"cost_usd"`
	StartedAt   *time.Time      `json:"started_at,omitempty"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

type DBEvent struct {
	ID        int64           `json:"id"`
	SessionID string          `json:"session_id"`
	AgentID   *string         `json:"agent_id,omitempty"`
	EventType string          `json:"event_type"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

// InitDB opens a connection to PostgreSQL and verifies it.
func InitDB() error {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://mae:mae@localhost:5432/mae?sslmode=disable"
	}

	var err error
	db, err = sql.Open("pgx", dsn)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping db: %w", err)
	}

	log.Println("PostgreSQL connected")
	return nil
}

// --- Users ---

func GetUsers(ctx context.Context) ([]DBUser, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, username, display_name, uid, gid, role, created_at FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []DBUser
	for rows.Next() {
		var u DBUser
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.UID, &u.GID, &u.Role, &u.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func GetUserByUsername(ctx context.Context, username string) (*DBUser, error) {
	var u DBUser
	err := db.QueryRowContext(ctx,
		`SELECT id, username, display_name, uid, gid, role, created_at FROM users WHERE username = $1`,
		username).Scan(&u.ID, &u.Username, &u.DisplayName, &u.UID, &u.GID, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// --- Sessions ---

func CreateSession(ctx context.Context, s *DBSession) error {
	return db.QueryRowContext(ctx,
		`INSERT INTO sessions (id, user_id, name, platform, team, chain, status, config)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING created_at, updated_at`,
		s.ID, s.UserID, s.Name, s.Platform, s.Team, s.Chain, s.Status, s.Config,
	).Scan(&s.CreatedAt, &s.UpdatedAt)
}

func UpdateSession(ctx context.Context, id string, name *string, status *string) error {
	if name == nil && status == nil {
		return nil
	}

	query := `UPDATE sessions SET updated_at = NOW()`
	args := []interface{}{}
	argIdx := 1

	if name != nil {
		query += fmt.Sprintf(`, name = $%d`, argIdx)
		args = append(args, *name)
		argIdx++
	}
	if status != nil {
		query += fmt.Sprintf(`, status = $%d`, argIdx)
		args = append(args, *status)
		argIdx++
		if *status == "completed" || *status == "failed" || *status == "cancelled" {
			query += `, completed_at = NOW()`
		}
	}

	query += fmt.Sprintf(` WHERE id = $%d`, argIdx)
	args = append(args, id)

	_, err := db.ExecContext(ctx, query, args...)
	return err
}

func GetSessions(ctx context.Context) ([]DBSession, error) {
	return querySessions(ctx,
		`SELECT id, user_id, name, platform, team, chain, status, COALESCE(config, 'null'::jsonb), created_at, updated_at, completed_at
		 FROM sessions ORDER BY created_at DESC`)
}

func GetSessionsByUser(ctx context.Context, username string) ([]DBSession, error) {
	return querySessions(ctx,
		`SELECT s.id, s.user_id, s.name, s.platform, s.team, s.chain, s.status, COALESCE(s.config, 'null'::jsonb), s.created_at, s.updated_at, s.completed_at
		 FROM sessions s JOIN users u ON s.user_id = u.id
		 WHERE u.username = $1 ORDER BY s.created_at DESC`, username)
}

func querySessions(ctx context.Context, query string, args ...interface{}) ([]DBSession, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []DBSession
	for rows.Next() {
		var s DBSession
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Platform, &s.Team, &s.Chain,
			&s.Status, &s.Config, &s.CreatedAt, &s.UpdatedAt, &s.CompletedAt); err != nil {
			return nil, err
		}
		sessions = append(sessions, s)
	}
	return sessions, rows.Err()
}

func GetDBSession(ctx context.Context, id string) (*DBSession, error) {
	var s DBSession
	err := db.QueryRowContext(ctx,
		`SELECT id, user_id, name, platform, team, chain, status, COALESCE(config, 'null'::jsonb), created_at, updated_at, completed_at
		 FROM sessions WHERE id = $1`, id,
	).Scan(&s.ID, &s.UserID, &s.Name, &s.Platform, &s.Team, &s.Chain,
		&s.Status, &s.Config, &s.CreatedAt, &s.UpdatedAt, &s.CompletedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// --- Agents ---

func CreateAgent(ctx context.Context, a *DBAgent) error {
	return db.QueryRowContext(ctx,
		`INSERT INTO agents (session_id, agent_id, role, persona, adapter, status, prompt, config)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id, created_at, updated_at`,
		a.SessionID, a.AgentID, a.Role, a.Persona, a.Adapter, a.Status, a.Prompt, a.Config,
	).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt)
}

func UpdateAgent(ctx context.Context, id int, status *string, config json.RawMessage, result json.RawMessage, costUSD *float64) error {
	query := `UPDATE agents SET updated_at = NOW()`
	args := []interface{}{}
	argIdx := 1

	if status != nil {
		query += fmt.Sprintf(`, status = $%d`, argIdx)
		args = append(args, *status)
		argIdx++
		if *status == "running" {
			query += `, started_at = COALESCE(started_at, NOW())`
		}
		if *status == "completed" || *status == "failed" {
			query += `, completed_at = NOW()`
		}
	}
	if config != nil {
		query += fmt.Sprintf(`, config = $%d`, argIdx)
		args = append(args, config)
		argIdx++
	}
	if result != nil {
		query += fmt.Sprintf(`, result = $%d`, argIdx)
		args = append(args, result)
		argIdx++
	}
	if costUSD != nil {
		query += fmt.Sprintf(`, cost_usd = $%d`, argIdx)
		args = append(args, *costUSD)
		argIdx++
	}

	query += fmt.Sprintf(` WHERE id = $%d`, argIdx)
	args = append(args, id)

	_, err := db.ExecContext(ctx, query, args...)
	return err
}

func GetAgentsBySession(ctx context.Context, sessionID string) ([]DBAgent, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, session_id, agent_id, role, persona, adapter, status, prompt,
		        COALESCE(config, 'null'::jsonb), COALESCE(result, 'null'::jsonb), cost_usd,
		        started_at, completed_at, created_at, updated_at
		 FROM agents WHERE session_id = $1 ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var agents []DBAgent
	for rows.Next() {
		var a DBAgent
		if err := rows.Scan(&a.ID, &a.SessionID, &a.AgentID, &a.Role, &a.Persona, &a.Adapter,
			&a.Status, &a.Prompt, &a.Config, &a.Result, &a.CostUSD,
			&a.StartedAt, &a.CompletedAt, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		agents = append(agents, a)
	}
	return agents, rows.Err()
}

func GetDBAgent(ctx context.Context, id int) (*DBAgent, error) {
	var a DBAgent
	err := db.QueryRowContext(ctx,
		`SELECT id, session_id, agent_id, role, persona, adapter, status, prompt,
		        COALESCE(config, 'null'::jsonb), COALESCE(result, 'null'::jsonb), cost_usd,
		        started_at, completed_at, created_at, updated_at
		 FROM agents WHERE id = $1`, id,
	).Scan(&a.ID, &a.SessionID, &a.AgentID, &a.Role, &a.Persona, &a.Adapter,
		&a.Status, &a.Prompt, &a.Config, &a.Result, &a.CostUSD,
		&a.StartedAt, &a.CompletedAt, &a.CreatedAt, &a.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// --- Events ---

func RecordEvent(ctx context.Context, e *DBEvent) error {
	return db.QueryRowContext(ctx,
		`INSERT INTO events (session_id, agent_id, event_type, payload)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, created_at`,
		e.SessionID, e.AgentID, e.EventType, e.Payload,
	).Scan(&e.ID, &e.CreatedAt)
}

// --- Hydration ---

func HydrateRecentSessions(ctx context.Context, limit int) ([]DBSession, map[string][]DBEvent, error) {
	sessions, err := querySessions(ctx,
		`SELECT id, user_id, name, platform, team, chain, status, COALESCE(config, 'null'::jsonb), created_at, updated_at, completed_at
		 FROM sessions ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, nil, fmt.Errorf("load sessions: %w", err)
	}

	eventsBySession := make(map[string][]DBEvent)
	for _, s := range sessions {
		events, err := GetEventsBySession(ctx, s.ID)
		if err != nil {
			log.Printf("WARNING: failed to load events for session %s: %v", s.ID, err)
			continue
		}
		eventsBySession[s.ID] = events
	}

	return sessions, eventsBySession, nil
}

// MarkStaleSessions marks open sessions with no recent events as completed.
func MarkStaleSessions(ctx context.Context, maxIdleMinutes int) (int, error) {
	// Mark open sessions as completed if no events received within the idle window.
	// Uses COALESCE: last event time → session updated_at → session created_at.
	var n int
	err := db.QueryRowContext(ctx, `
		WITH stale AS (
			UPDATE sessions s
			SET status = 'completed',
				updated_at = NOW(),
				completed_at = COALESCE(completed_at, NOW())
			WHERE s.status IN ('active', 'waiting', 'paused')
			  AND COALESCE(
				(SELECT MAX(e.created_at) FROM events e WHERE e.session_id = s.id),
				s.updated_at,
				s.created_at
			  ) < NOW() - make_interval(mins := $1)
			RETURNING s.id
		), updated_agents AS (
			UPDATE agents a
			SET status = 'completed',
				updated_at = NOW(),
				completed_at = COALESCE(completed_at, NOW())
			FROM stale
			WHERE a.session_id = stale.id
			  AND a.status IN ('running', 'idle')
			RETURNING a.id
		)
		SELECT COUNT(*) FROM stale
	`, maxIdleMinutes).Scan(&n)
	return n, err
}

// --- Auth Tokens ---

func EnsureAuthTokens(ctx context.Context) error {
	_, err := db.ExecContext(ctx, `ALTER TABLE users ADD COLUMN IF NOT EXISTS api_token TEXT UNIQUE`)
	if err != nil {
		return fmt.Errorf("add api_token column: %w", err)
	}

	rows, err := db.QueryContext(ctx, `SELECT id, username FROM users WHERE api_token IS NULL`)
	if err != nil {
		return fmt.Errorf("query users without tokens: %w", err)
	}
	defer rows.Close()

	type userRow struct {
		id       int
		username string
	}
	var needTokens []userRow
	for rows.Next() {
		var u userRow
		rows.Scan(&u.id, &u.username)
		needTokens = append(needTokens, u)
	}
	rows.Close()

	for _, u := range needTokens {
		b := make([]byte, 20)
		if _, err := rand.Read(b); err != nil {
			return fmt.Errorf("generate token: %w", err)
		}
		token := "mae_" + hex.EncodeToString(b)
		if _, err := db.ExecContext(ctx, `UPDATE users SET api_token = $1 WHERE id = $2`, token, u.id); err != nil {
			return fmt.Errorf("set token for %s: %w", u.username, err)
		}
		log.Printf("Generated API token for %s: %s...%s", u.username, token[:8], token[len(token)-4:])
	}

	return nil
}

func LoadTokenMap(ctx context.Context) (map[string]*DBUser, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, username, display_name, uid, gid, role, created_at, api_token
		 FROM users WHERE api_token IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	m := make(map[string]*DBUser)
	for rows.Next() {
		var u DBUser
		var token string
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.UID, &u.GID, &u.Role, &u.CreatedAt, &token); err != nil {
			return nil, err
		}
		m[token] = &u
	}
	return m, rows.Err()
}

// --- Agent Traces ---

type DBTrace struct {
	ID        int64           `json:"id"`
	SessionID string          `json:"session_id"`
	AgentID   string          `json:"agent_id"`
	Direction string          `json:"direction"`
	Content   string          `json:"content"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

func RecordTrace(ctx context.Context, t *DBTrace) error {
	return db.QueryRowContext(ctx,
		`INSERT INTO agent_traces (session_id, agent_id, direction, content, metadata)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, created_at`,
		t.SessionID, t.AgentID, t.Direction, t.Content, t.Metadata,
	).Scan(&t.ID, &t.CreatedAt)
}

func SearchTraces(ctx context.Context, query string, sessionID string) ([]DBTrace, error) {
	var rows *sql.Rows
	var err error
	if sessionID != "" {
		rows, err = db.QueryContext(ctx,
			`SELECT id, session_id, agent_id, direction,
			        ts_headline('english', content, q, 'MaxFragments=3,MaxWords=50') as content,
			        metadata, created_at
			 FROM agent_traces, plainto_tsquery('english', $1) q
			 WHERE content_tsv @@ q AND session_id = $2
			 ORDER BY ts_rank(content_tsv, q) DESC LIMIT 50`,
			query, sessionID)
	} else {
		rows, err = db.QueryContext(ctx,
			`SELECT id, session_id, agent_id, direction,
			        ts_headline('english', content, q, 'MaxFragments=3,MaxWords=50') as content,
			        metadata, created_at
			 FROM agent_traces, plainto_tsquery('english', $1) q
			 WHERE content_tsv @@ q
			 ORDER BY ts_rank(content_tsv, q) DESC LIMIT 50`,
			query)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var traces []DBTrace
	for rows.Next() {
		var t DBTrace
		if err := rows.Scan(&t.ID, &t.SessionID, &t.AgentID, &t.Direction, &t.Content, &t.Metadata, &t.CreatedAt); err != nil {
			return nil, err
		}
		traces = append(traces, t)
	}
	return traces, rows.Err()
}

func GetEventsBySession(ctx context.Context, sessionID string) ([]DBEvent, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, session_id, agent_id, event_type, payload, created_at
		 FROM events WHERE session_id = $1 ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []DBEvent
	for rows.Next() {
		var e DBEvent
		if err := rows.Scan(&e.ID, &e.SessionID, &e.AgentID, &e.EventType, &e.Payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}
