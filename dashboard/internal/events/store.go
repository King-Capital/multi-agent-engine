package events

import (
	"bufio"
	"sort"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"mae.local/dashboard/internal/models"
)

var validSessionID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)

func ValidateSessionID(id string) error {
	if len(id) == 0 || len(id) > 128 || !validSessionID.MatchString(id) {
		return fmt.Errorf("invalid session ID: %q", id)
	}
	return nil
}

type Store struct {
	dir           string
	mu            sync.RWMutex
	sessions      map[string]*models.Session
	listeners     map[string][]chan models.Event
	droppedCounts map[string]int64
}

// sanitizeID strips path traversal components from session IDs.
// filepath.Base removes directory components (../ etc).
func sanitizeID(id string) string {
	safe := filepath.Base(id)
	if safe == "." || safe == "" {
		return "invalid"
	}
	return safe
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create store dir: %w", err)
	}
	s := &Store{
		dir:           dir,
		sessions:      make(map[string]*models.Session),
		listeners:     make(map[string][]chan models.Event),
		droppedCounts: make(map[string]int64),
	}
	if err := s.loadExisting(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) loadExisting() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		sessionID := e.Name()[:len(e.Name())-6]
		if err := s.loadSession(sessionID); err != nil {
			fmt.Fprintf(os.Stderr, "warn: failed to load session %s: %v\n", sessionID, err)
		}
	}
	return nil
}

func (s *Store) loadSession(id string) error {
	f, err := os.Open(filepath.Join(s.dir, sanitizeID(id)+".jsonl"))
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var evt models.Event
		if err := json.Unmarshal(scanner.Bytes(), &evt); err != nil {
			continue
		}
		s.applyEvent(evt)
	}
	return scanner.Err()
}

func (s *Store) Append(evt models.Event) error {
	if evt.Timestamp.IsZero() {
		evt.Timestamp = time.Now()
	}

	data, err := json.Marshal(evt)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	fpath := filepath.Join(s.dir, sanitizeID(evt.SessionID)+".jsonl")
	f, err := os.OpenFile(fpath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open event file: %w", err)
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		f.Close()
		return fmt.Errorf("write event: %w", err)
	}
	f.Close()

	s.mu.Lock()
	s.applyEvent(evt)
	s.notifyListeners(evt)
	s.mu.Unlock()

	return nil
}

func (s *Store) applyEvent(evt models.Event) {
	sess, ok := s.sessions[evt.SessionID]
	if !ok {
		sess = &models.Session{
			ID:        evt.SessionID,
			Status:    "active",
			StartedAt: evt.Timestamp,
			Agents:    make(map[string]*models.Agent),
		}
		s.sessions[evt.SessionID] = sess
	}

	sess.Events = append(sess.Events, evt)
	sess.ElapsedMs = time.Since(sess.StartedAt).Milliseconds()

	switch evt.EventType {
	case models.EventSessionStart:
		sess.Name = evt.Data.SessionName
		sess.TeamConfig = evt.Data.TeamConfig
		sess.ChainType = evt.Data.TeamConfig
		sess.TaskPrompt = evt.Data.TaskPrompt

	case models.EventSessionEnd:
		sess.Status = "completed"

	case models.EventPause:
		sess.Status = "paused"

	case models.EventResume:
		sess.Status = "active"

	case models.EventWaiting:
		sess.Status = "waiting"

	case models.EventAgentSpawn:
		agent := &models.Agent{
			ID:        evt.AgentID,
			Name:      evt.Data.AgentName,
			Role:      evt.Data.AgentRole,
			Model:     evt.Data.Model,
			TeamName:  evt.Data.TeamName,
			TeamColor: evt.Data.TeamColor,
			ParentID:  evt.ParentID,
			Status:    models.StatusRunning,
			PersonaPath: evt.Data.PersonaPath,
			StartedAt: evt.Timestamp,
		}
		sess.Agents[evt.AgentID] = agent

	case models.EventAgentDone:
		if a, ok := sess.Agents[evt.AgentID]; ok {
			a.Status = models.StatusDone
			a.ElapsedMs = time.Since(a.StartedAt).Milliseconds()
		}

	case models.EventCostUpdate:
		if a, ok := sess.Agents[evt.AgentID]; ok {
			a.CostUSD = evt.CostUSD
			a.TokensUsed = evt.TokensUsed
			a.ContextTokens = evt.ContextTokens
		}
		sess.TotalCost = 0
		sess.TotalTokens = 0
		for _, a := range sess.Agents {
			sess.TotalCost += a.CostUSD
			sess.TotalTokens += a.TokensUsed
		}

	case models.EventTillDone:
		sess.TillDone = evt.Data.TillDone

	case models.EventError:
		if evt.AgentID != "" {
			if a, ok := sess.Agents[evt.AgentID]; ok {
				a.Status = models.StatusError
			}
		} else {
			sess.Status = "error"
		}
	}
}

func (s *Store) GetSession(id string) *models.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[id]
}

func (s *Store) ListSessions() []*models.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*models.Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		result = append(result, sess)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].StartedAt.After(result[j].StartedAt)
	})
	return result
}

func (s *Store) CloseStale() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	closed := 0
	for _, sess := range s.sessions {
		if sess.Status == "active" || sess.Status == "waiting" || sess.Status == "paused" {
			sess.Status = "error"
			sess.ElapsedMs = time.Since(sess.StartedAt).Milliseconds()
			for _, a := range sess.Agents {
				if a.Status == models.StatusRunning || a.Status == models.StatusIdle {
					a.Status = models.StatusError
					a.ElapsedMs = time.Since(a.StartedAt).Milliseconds()
				}
			}
			closed++
		}
	}
	return closed
}

func (s *Store) ClearStale(maxAge time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-maxAge)
	for _, sess := range s.sessions {
		if sess.Status == "active" && len(sess.Agents) == 0 && sess.StartedAt.Before(cutoff) {
			sess.Status = "error"
		}
	}
}

func (s *Store) ReapInactiveSessions(timeout time.Duration) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-timeout)
	reaped := 0
	for _, sess := range s.sessions {
		if sess.Status != "active" && sess.Status != "waiting" && sess.Status != "paused" {
			continue
		}
		lastActivity := sess.StartedAt
		for _, evt := range sess.Events {
			if evt.Timestamp.After(lastActivity) {
				lastActivity = evt.Timestamp
			}
		}
		if lastActivity.Before(cutoff) {
			sess.Status = "error"
			sess.ElapsedMs = time.Since(sess.StartedAt).Milliseconds()
			for _, a := range sess.Agents {
				if a.Status == models.StatusRunning || a.Status == models.StatusIdle {
					a.Status = models.StatusError
					a.ElapsedMs = time.Since(a.StartedAt).Milliseconds()
				}
			}
			evt := models.Event{
				SessionID: sess.ID,
				EventType: models.EventError,
				Timestamp: time.Now(),
				Data: models.EventData{
					ErrorMsg: fmt.Sprintf("Session timed out after %v of inactivity", timeout),
				},
			}
			sess.Events = append(sess.Events, evt)
			s.notifyListeners(evt)

			data, err := json.Marshal(evt)
			if err == nil {
				fpath := filepath.Join(s.dir, sanitizeID(sess.ID)+".jsonl")
				if f, err := os.OpenFile(fpath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
					f.Write(append(data, '\n'))
					f.Close()
				}
			}
			reaped++
		}
	}
	return reaped
}

func (s *Store) StartReaper(interval, timeout time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			if n := s.ReapInactiveSessions(timeout); n > 0 {
				fmt.Fprintf(os.Stderr, "[reaper] Marked %d stale sessions as error\n", n)
			}
		}
	}()
}

func (s *Store) ClearAll() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.sessions)
	for id := range s.sessions {
		fpath := filepath.Join(s.dir, sanitizeID(id)+".jsonl")
		os.Remove(fpath)
	}
	s.sessions = make(map[string]*models.Session)
	s.listeners = make(map[string][]chan models.Event)
	return n
}

func (s *Store) SetSessionStatus(id, status string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return false
	}
	sess.Status = status
	sess.ElapsedMs = time.Since(sess.StartedAt).Milliseconds()
	for _, a := range sess.Agents {
		if a.Status == models.StatusRunning || a.Status == models.StatusIdle {
			if status == "error" {
				a.Status = models.StatusError
			} else {
				a.Status = models.StatusDone
			}
			a.ElapsedMs = time.Since(a.StartedAt).Milliseconds()
		}
	}
	evt := models.Event{
		SessionID: id,
		EventType: models.EventSessionEnd,
		Timestamp: time.Now(),
		Data: models.EventData{
			Content: fmt.Sprintf("Session manually marked as %s", status),
		},
	}
	sess.Events = append(sess.Events, evt)
	s.notifyListeners(evt)

	data, err := json.Marshal(evt)
	if err == nil {
		fpath := filepath.Join(s.dir, sanitizeID(id)+".jsonl")
		if f, err := os.OpenFile(fpath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
			f.Write(append(data, '\n'))
			f.Close()
		}
	}
	return true
}

func (s *Store) DeleteSession(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
	fpath := filepath.Join(s.dir, sanitizeID(id)+".jsonl")
	os.Remove(fpath)
}

func (s *Store) InjectSession(sess *models.Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.sessions[sess.ID]; !exists {
		s.sessions[sess.ID] = sess
	}
}

func (s *Store) Subscribe(sessionID string) chan models.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan models.Event, 256)
	s.listeners[sessionID] = append(s.listeners[sessionID], ch)
	return ch
}

func (s *Store) Unsubscribe(sessionID string, ch chan models.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	listeners := s.listeners[sessionID]
	for i, l := range listeners {
		if l == ch {
			s.listeners[sessionID] = append(listeners[:i], listeners[i+1:]...)
			close(ch)
			return
		}
	}
}

func (s *Store) notifyListeners(evt models.Event) {
	for _, ch := range s.listeners[evt.SessionID] {
		select {
		case ch <- evt:
		default:
			s.droppedCounts[evt.SessionID]++
			if s.droppedCounts[evt.SessionID]%10 == 1 {
				fmt.Fprintf(os.Stderr, "warn: dropped SSE event for session %s (type=%s, total dropped=%d)\n",
					evt.SessionID, string(evt.EventType), s.droppedCounts[evt.SessionID])
			}
		}
	}
	for _, ch := range s.listeners["*"] {
		select {
		case ch <- evt:
		default:
			s.droppedCounts[evt.SessionID]++
			if s.droppedCounts[evt.SessionID]%10 == 1 {
				fmt.Fprintf(os.Stderr, "warn: dropped SSE event for session %s (type=%s, total dropped=%d)\n",
					evt.SessionID, string(evt.EventType), s.droppedCounts[evt.SessionID])
			}
		}
	}
}
