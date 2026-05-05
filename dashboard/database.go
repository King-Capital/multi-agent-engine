package main

import (
	"context"
	"database/sql"
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
