package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
)

const sessionCookieName = "mae_session"

type DBUserWithPassword struct {
	DBUser
	PasswordHash *string
}

type DBAPIToken struct {
	ID         int        `json:"id"`
	UserID     int        `json:"user_id"`
	Username   string     `json:"username"`
	Name       string     `json:"name"`
	Prefix     string     `json:"token_prefix"`
	Last4      string     `json:"last4"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

type authResponse struct {
	User DBUser `json:"user"`
}

type createTokenResponse struct {
	Token string     `json:"token"`
	Meta  DBAPIToken `json:"meta"`
}

func hashSecret(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func randomToken(prefix string, bytesLen int) (string, error) {
	b := make([]byte, bytesLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}

func EnsureAuthSchema(ctx context.Context) error {
	statements := []string{
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
		`CREATE TABLE IF NOT EXISTS auth_sessions (
			id BIGSERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			token_hash TEXT UNIQUE NOT NULL,
			user_agent TEXT,
			ip TEXT,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			expires_at TIMESTAMPTZ NOT NULL,
			revoked_at TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash)`,
		`CREATE TABLE IF NOT EXISTS api_tokens (
			id BIGSERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			token_hash TEXT UNIQUE NOT NULL,
			token_prefix TEXT NOT NULL,
			last4 TEXT NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			last_used_at TIMESTAMPTZ,
			expires_at TIMESTAMPTZ,
			revoked_at TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`,
	}
	for _, stmt := range statements {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func GetUserByUsernameWithPassword(ctx context.Context, username string) (*DBUserWithPassword, error) {
	var u DBUserWithPassword
	err := db.QueryRowContext(ctx,
		`SELECT id, username, display_name, uid, gid, role, created_at, password_hash FROM users WHERE username = $1`,
		username,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.UID, &u.GID, &u.Role, &u.CreatedAt, &u.PasswordHash)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func SetUserPassword(ctx context.Context, username string, password string) error {
	if strings.TrimSpace(username) == "" || password == "" {
		return errors.New("username and password are required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	res, err := db.ExecContext(ctx, `UPDATE users SET password_hash = $1 WHERE username = $2`, string(hash), username)
	if err != nil {
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("user %q not found", username)
	}
	return nil
}

func EnsureBootstrapPassword(ctx context.Context) error {
	username := strings.TrimSpace(os.Getenv("MAE_BOOTSTRAP_USERNAME"))
	password := os.Getenv("MAE_BOOTSTRAP_PASSWORD")
	if username == "" || password == "" {
		return nil
	}
	u, err := GetUserByUsernameWithPassword(ctx, username)
	if err != nil {
		return err
	}
	if u == nil {
		return fmt.Errorf("bootstrap user %q not found", username)
	}
	if u.PasswordHash != nil && *u.PasswordHash != "" {
		return nil
	}
	return SetUserPassword(ctx, username, password)
}

func CreateAuthSession(ctx context.Context, userID int, raw string, userAgent string, ip string, expiresAt time.Time) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO auth_sessions (user_id, token_hash, user_agent, ip, expires_at) VALUES ($1, $2, $3, $4, $5)`,
		userID, hashSecret(raw), userAgent, ip, expiresAt,
	)
	return err
}

func RevokeAuthSession(ctx context.Context, raw string) error {
	_, err := db.ExecContext(ctx,
		`UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
		hashSecret(raw),
	)
	return err
}

func GetUserBySessionToken(ctx context.Context, raw string) (*DBUser, error) {
	var u DBUser
	err := db.QueryRowContext(ctx,
		`SELECT u.id, u.username, u.display_name, u.uid, u.gid, u.role, u.created_at
		 FROM auth_sessions s JOIN users u ON u.id = s.user_id
		 WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
		hashSecret(raw),
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.UID, &u.GID, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func CreateAPIToken(ctx context.Context, userID int, name string, expiresAt *time.Time) (string, DBAPIToken, error) {
	raw, err := randomToken("mae_", 32)
	if err != nil {
		return "", DBAPIToken{}, err
	}
	prefix := raw[:8]
	last4 := raw[len(raw)-4:]
	var t DBAPIToken
	err = db.QueryRowContext(ctx,
		`INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, last4, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, user_id, name, token_prefix, last4, created_at, last_used_at, expires_at, revoked_at`,
		userID, name, hashSecret(raw), prefix, last4, expiresAt,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Prefix, &t.Last4, &t.CreatedAt, &t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt)
	if err != nil {
		return "", DBAPIToken{}, err
	}
	if u, err := GetUserByID(ctx, userID); err == nil && u != nil {
		t.Username = u.Username
	}
	return raw, t, nil
}

func GetUserByID(ctx context.Context, id int) (*DBUser, error) {
	var u DBUser
	err := db.QueryRowContext(ctx,
		`SELECT id, username, display_name, uid, gid, role, created_at FROM users WHERE id = $1`, id,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.UID, &u.GID, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func ListAPITokens(ctx context.Context) ([]DBAPIToken, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT t.id, t.user_id, u.username, t.name, t.token_prefix, t.last4, t.created_at, t.last_used_at, t.expires_at, t.revoked_at
		 FROM api_tokens t JOIN users u ON u.id = t.user_id
		 ORDER BY t.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tokens []DBAPIToken
	for rows.Next() {
		var t DBAPIToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Username, &t.Name, &t.Prefix, &t.Last4, &t.CreatedAt, &t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt); err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

func RevokeAPIToken(ctx context.Context, id int) error {
	_, err := db.ExecContext(ctx, `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1`, id)
	return err
}

func GetUserByAPIToken(ctx context.Context, raw string) (*DBUser, error) {
	var u DBUser
	err := db.QueryRowContext(ctx,
		`UPDATE api_tokens t
		 SET last_used_at = NOW()
		 FROM users u
		 WHERE u.id = t.user_id
		   AND t.token_hash = $1
		   AND t.revoked_at IS NULL
		   AND (t.expires_at IS NULL OR t.expires_at > NOW())
		 RETURNING u.id, u.username, u.display_name, u.uid, u.gid, u.role, u.created_at`,
		hashSecret(raw),
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.UID, &u.GID, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func requireAdmin(w http.ResponseWriter, r *http.Request) (*DBUser, bool) {
	u := getAuthUser(r)
	if u == nil {
		http.Error(w, `{"error":"authorization required"}`, http.StatusUnauthorized)
		return nil, false
	}
	if u.Role != "admin" {
		http.Error(w, `{"error":"admin required"}`, http.StatusForbidden)
		return nil, false
	}
	return u, true
}

func handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		http.Error(w, `{"error":"username and password required"}`, http.StatusBadRequest)
		return
	}
	u, err := GetUserByUsernameWithPassword(r.Context(), req.Username)
	if err != nil {
		http.Error(w, `{"error":"login failed"}`, http.StatusInternalServerError)
		return
	}
	if u == nil || u.PasswordHash == nil || bcrypt.CompareHashAndPassword([]byte(*u.PasswordHash), []byte(req.Password)) != nil {
		http.Error(w, `{"error":"invalid username or password"}`, http.StatusUnauthorized)
		return
	}
	raw, err := randomToken("ms_", 32)
	if err != nil {
		http.Error(w, `{"error":"session failed"}`, http.StatusInternalServerError)
		return
	}
	expires := time.Now().Add(14 * 24 * time.Hour)
	if err := CreateAuthSession(r.Context(), u.ID, raw, r.UserAgent(), r.RemoteAddr, expires); err != nil {
		http.Error(w, `{"error":"session failed"}`, http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: raw, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", Expires: expires})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(authResponse{User: u.DBUser})
}

func handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" {
		_ = RevokeAuthSession(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleAuthMe(w http.ResponseWriter, r *http.Request) {
	u := getAuthUser(r)
	if u == nil {
		http.Error(w, `{"error":"authorization required"}`, http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(authResponse{User: *u})
}

func handleAdminListTokens(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	tokens, err := ListAPITokens(r.Context())
	if err != nil {
		http.Error(w, `{"error":"list tokens failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tokens)
}

func handleAdminCreateToken(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	var req struct {
		UserID int    `json:"user_id"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.UserID == 0 || strings.TrimSpace(req.Name) == "" {
		http.Error(w, `{"error":"user_id and name required"}`, http.StatusBadRequest)
		return
	}
	raw, meta, err := CreateAPIToken(r.Context(), req.UserID, strings.TrimSpace(req.Name), nil)
	if err != nil {
		http.Error(w, `{"error":"create token failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(createTokenResponse{Token: raw, Meta: meta})
}

func handleAdminRevokeToken(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	idParam := chi.URLParam(r, "id")
	var id int
	if _, err := fmt.Sscanf(idParam, "%d", &id); err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid token id"}`, http.StatusBadRequest)
		return
	}
	if err := RevokeAPIToken(r.Context(), id); err != nil {
		http.Error(w, `{"error":"revoke token failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
}

func authenticateRequest(r *http.Request) (*DBUser, error) {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		if token != "" {
			if dbEnabled {
				u, err := GetUserByAPIToken(r.Context(), token)
				if err != nil {
					return nil, err
				}
				if u != nil {
					return u, nil
				}
			}
			if u, ok := tokenMap[token]; ok {
				return u, nil
			}
		}
	}
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" && dbEnabled {
		return GetUserBySessionToken(r.Context(), c.Value)
	}
	return nil, nil
}

func isPublicPath(r *http.Request) bool {
	path := r.URL.Path
	if r.Method == "OPTIONS" || path == "/api/health" || path == "/api/auth/login" {
		return true
	}
	if strings.HasPrefix(path, "/assets/") || path == "/favicon.svg" || strings.HasPrefix(path, "/static/") {
		return true
	}
	if !strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/htmx/") && path != "/metrics" {
		return true
	}
	return false
}

var errUnauthenticated = errors.New("unauthenticated")
