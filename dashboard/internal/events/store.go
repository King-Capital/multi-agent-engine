package events

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/King-Capital/multi-agent-engine/dashboard/internal/models"
)

type Store struct {
	dir       string
	mu        sync.RWMutex
	sessions  map[string]*models.Session
	listeners map[string][]chan models.Event
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create store dir: %w", err)
	}
	s := &Store{
		dir:       dir,
		sessions:  make(map[string]*models.Session),
		listeners: make(map[string][]chan models.Event),
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
	f, err := os.Open(filepath.Join(s.dir, id+".jsonl"))
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
	s.mu.Lock()
	defer s.mu.Unlock()

	if evt.Timestamp.IsZero() {
		evt.Timestamp = time.Now()
	}

	data, err := json.Marshal(evt)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	fpath := filepath.Join(s.dir, evt.SessionID+".jsonl")
	f, err := os.OpenFile(fpath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open event file: %w", err)
	}
	defer f.Close()

	if _, err := f.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("write event: %w", err)
	}

	s.applyEvent(evt)
	s.notifyListeners(evt)
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
		if a, ok := sess.Agents[evt.AgentID]; ok {
			a.Status = models.StatusError
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
	return result
}

func (s *Store) ClearCompleted() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, sess := range s.sessions {
		if sess.Status == "completed" {
			delete(s.sessions, id)
			fpath := filepath.Join(s.dir, id+".jsonl")
			os.Remove(fpath)
		}
	}
}

func (s *Store) ClearStale(maxAge time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-maxAge)
	for id, sess := range s.sessions {
		if sess.Status == "active" && len(sess.Agents) == 0 && sess.StartedAt.Before(cutoff) {
			delete(s.sessions, id)
			fpath := filepath.Join(s.dir, id+".jsonl")
			os.Remove(fpath)
		}
	}
}

func (s *Store) ClearAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.sessions {
		delete(s.sessions, id)
		fpath := filepath.Join(s.dir, id+".jsonl")
		os.Remove(fpath)
	}
}

func (s *Store) Subscribe(sessionID string) chan models.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan models.Event, 64)
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
		}
	}
	for _, ch := range s.listeners["*"] {
		select {
		case ch <- evt:
		default:
		}
	}
}
