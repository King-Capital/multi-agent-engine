package models

import (
	"encoding/json"
	"time"
)

type AgentRole string

const (
	RoleOrchestrator AgentRole = "orchestrator"
	RoleLead         AgentRole = "lead"
	RoleWorker       AgentRole = "worker"
)

type AgentStatus string

const (
	StatusIdle    AgentStatus = "idle"
	StatusRunning AgentStatus = "running"
	StatusStale   AgentStatus = "stale"
	StatusDone    AgentStatus = "done"
	StatusError   AgentStatus = "error"
	StatusBlocked AgentStatus = "blocked"
)

type EventType string

const (
	EventSessionStart         EventType = "session_start"
	EventSessionEnd           EventType = "session_end"
	EventAgentSpawn           EventType = "agent_spawn"
	EventAgentDone            EventType = "agent_done"
	EventParticipantStart     EventType = "participant_start"
	EventParticipantActivity  EventType = "participant_activity"
	EventParticipantHeartbeat EventType = "participant_heartbeat"
	EventParticipantStale     EventType = "participant_stale"
	EventParticipantEnd       EventType = "participant_end"
	EventMessage              EventType = "message"
	EventToolCall             EventType = "tool_call"
	EventToolResult           EventType = "tool_result"
	EventTillDone             EventType = "tilldone"
	EventCostUpdate           EventType = "cost_update"
	EventDomainBlock          EventType = "domain_block"
	EventSelfHeal             EventType = "self_heal"
	EventError                EventType = "error"
	EventPause                EventType = "pause"
	EventResume               EventType = "resume"
	EventWaiting              EventType = "waiting"
	EventSteerAction          EventType = "steer_action"
)

type Agent struct {
	ID              string      `json:"id"`
	Name            string      `json:"name"`
	Role            AgentRole   `json:"role"`
	Model           string      `json:"model"`
	TeamName        string      `json:"team_name"`
	TeamColor       string      `json:"team_color"`
	ParentID        string      `json:"parent_id,omitempty"`
	Status          AgentStatus `json:"status"`
	PersonaPath     string      `json:"persona_path,omitempty"`
	CostUSD         float64     `json:"cost_usd"`
	TokensUsed      int64       `json:"tokens_used"`
	ContextTokens   int64       `json:"context_tokens"`
	ContextMax      int64       `json:"context_max"`
	StartedAt       time.Time   `json:"started_at"`
	ElapsedMs       int64       `json:"elapsed_ms"`
	LastActivityAt  time.Time   `json:"last_activity_at,omitempty"`
	CurrentActivity string      `json:"current_activity,omitempty"`
	CurrentTool     string      `json:"current_tool,omitempty"`
}

type TillDoneItem struct {
	Description string `json:"description"`
	Completed   bool   `json:"completed"`
	Active      bool   `json:"active"`
}

type TillDoneState struct {
	Title     string         `json:"title"`
	Items     []TillDoneItem `json:"items"`
	Completed int            `json:"completed"`
	Total     int            `json:"total"`
}

type Event struct {
	SSEID         int64     `json:"sse_id,omitempty"`
	SessionID     string    `json:"session_id"`
	AgentID       string    `json:"agent_id"`
	ParentID      string    `json:"parent_id,omitempty"`
	EventType     EventType `json:"event_type"`
	Timestamp     time.Time `json:"timestamp"`
	TokensUsed    int64     `json:"tokens_used,omitempty"`
	CostUSD       float64   `json:"cost_usd,omitempty"`
	ContextTokens int64     `json:"context_tokens,omitempty"`
	Data          EventData `json:"data"`
}

type EventData struct {
	// session_start
	SessionName string `json:"session_name,omitempty"`
	TeamConfig  string `json:"team_config,omitempty"`
	TaskPrompt  string `json:"task_prompt,omitempty"`

	// agent_spawn
	AgentName   string    `json:"agent_name,omitempty"`
	AgentRole   AgentRole `json:"agent_role,omitempty"`
	Model       string    `json:"model,omitempty"`
	TeamName    string    `json:"team_name,omitempty"`
	TeamColor   string    `json:"team_color,omitempty"`
	PersonaPath string    `json:"persona_path,omitempty"`

	// participant_*
	ParticipantID   string `json:"participant_id,omitempty"`
	Name            string `json:"name,omitempty"`
	Kind            string `json:"kind,omitempty"`
	Role            string `json:"role,omitempty"`
	Team            string `json:"team,omitempty"`
	CurrentTask     string `json:"current_task,omitempty"`
	CurrentTool     string `json:"current_tool,omitempty"`
	LastEvent       string `json:"last_event,omitempty"`
	LastHeartbeatTS string `json:"last_heartbeat_ts,omitempty"`
	Reason          string `json:"reason,omitempty"`

	// message
	From        string `json:"from,omitempty"`
	To          string `json:"to,omitempty"`
	Content     string `json:"content,omitempty"`
	MessageID   string `json:"message_id,omitempty"`
	AckFor      string `json:"ack_for,omitempty"`
	SteerSource string `json:"steer_source,omitempty"`

	// tool_call
	Tool       string `json:"tool,omitempty"`
	ToolArgs   string `json:"tool_args,omitempty"`
	ToolResult string `json:"tool_result,omitempty"`
	ToolStatus string `json:"tool_status,omitempty"`
	FilePath   string `json:"file_path,omitempty"`

	// tilldone
	TillDone *TillDoneState `json:"tilldone,omitempty"`

	// domain_block
	BlockedPath   string `json:"blocked_path,omitempty"`
	BlockedAction string `json:"blocked_action,omitempty"`
	BlockReason   string `json:"block_reason,omitempty"`

	// agent_done
	Grade          string `json:"grade,omitempty"`
	OutputArtifact string `json:"output_artifact,omitempty"`
	TaskReport     string `json:"task_report,omitempty"`

	// self_heal
	FailedWorker string `json:"failed_worker,omitempty"`
	HealAction   string `json:"heal_action,omitempty"`

	// error
	ErrorMsg string `json:"error_msg,omitempty"`

	// agent status
	Status AgentStatus `json:"status,omitempty"`

	Extra map[string]json.RawMessage `json:"-"`
}

func (d *EventData) UnmarshalJSON(data []byte) error {
	type alias EventData
	var known alias
	if err := json.Unmarshal(data, &known); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	knownKeys := map[string]bool{
		"session_name": true, "team_config": true, "task_prompt": true,
		"agent_name": true, "agent_role": true, "model": true, "team_name": true, "team_color": true, "persona_path": true,
		"participant_id": true, "name": true, "kind": true, "role": true, "team": true, "current_task": true, "current_tool": true, "last_event": true, "last_heartbeat_ts": true, "reason": true,
		"from": true, "to": true, "content": true, "message_id": true, "ack_for": true, "steer_source": true,
		"tool": true, "tool_args": true, "tool_result": true, "tool_status": true, "file_path": true,
		"tilldone":     true,
		"blocked_path": true, "blocked_action": true, "block_reason": true,
		"grade": true, "output_artifact": true, "task_report": true,
		"failed_worker": true, "heal_action": true,
		"error_msg": true, "status": true,
	}
	known.Extra = map[string]json.RawMessage{}
	for key, value := range raw {
		if !knownKeys[key] {
			known.Extra[key] = value
		}
	}
	*d = EventData(known)
	return nil
}

func (d EventData) MarshalJSON() ([]byte, error) {
	type alias EventData
	base, err := json.Marshal(alias(d))
	if err != nil {
		return nil, err
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(base, &merged); err != nil {
		return nil, err
	}
	delete(merged, "Extra")
	for key, value := range d.Extra {
		if _, exists := merged[key]; !exists {
			merged[key] = value
		}
	}
	return json.Marshal(merged)
}

type Session struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	TeamConfig  string            `json:"team_config"`
	TaskPrompt  string            `json:"task_prompt"`
	ChainType   string            `json:"chain_type"`
	Tags        []string          `json:"tags,omitempty"`
	Status      string            `json:"status"`
	StartedAt   time.Time         `json:"started_at"`
	ElapsedMs   int64             `json:"elapsed_ms"`
	TotalCost   float64           `json:"total_cost"`
	TotalTokens int64             `json:"total_tokens"`
	Agents      map[string]*Agent `json:"agents"`
	TillDone    *TillDoneState    `json:"tilldone,omitempty"`
	Events      []Event           `json:"events"`
}
