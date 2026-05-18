package models

import (
	"encoding/json"
	"regexp"
	"strings"
)

const redactedSecret = "[REDACTED_SECRET]"

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`(?i)((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*)[^\s'"` + "`" + `;,}]+`),
	regexp.MustCompile(`(?i)("(?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"\\]*(?:\\.[^"\\]*)*"`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9]{16,}\b`),
	regexp.MustCompile(`\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-ant-[A-Za-z0-9-_]{16,}|mae_[A-Za-z0-9._-]{20,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b`),
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
}

func redactString(input string) string {
	out := input
	out = secretPatterns[0].ReplaceAllString(out, `${1}`+redactedSecret)
	out = secretPatterns[1].ReplaceAllString(out, `${1}`+redactedSecret)
	out = secretPatterns[2].ReplaceAllString(out, `${1}`+redactedSecret+`"`)
	for _, pattern := range secretPatterns[3:] {
		out = pattern.ReplaceAllString(out, redactedSecret)
	}
	return out
}

func isSecretKey(key string) bool {
	k := strings.ToLower(key)
	return strings.Contains(k, "secret") || strings.Contains(k, "token") || strings.Contains(k, "password") || strings.Contains(k, "api_key") || strings.Contains(k, "apikey") || strings.Contains(k, "authorization") || strings.Contains(k, "credential")
}

func redactRawJSON(key string, raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	if isSecretKey(key) {
		b, _ := json.Marshal(redactedSecret)
		return b
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		b, _ := json.Marshal(redactString(string(raw)))
		return b
	}
	redacted := redactAny(value)
	b, err := json.Marshal(redacted)
	if err != nil {
		return raw
	}
	return b
}

func redactAny(value any) any {
	switch v := value.(type) {
	case string:
		return redactString(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = redactAny(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			if isSecretKey(key) {
				out[key] = redactedSecret
			} else {
				out[key] = redactAny(item)
			}
		}
		return out
	default:
		return value
	}
}

func redactTillDone(state *TillDoneState) *TillDoneState {
	if state == nil {
		return nil
	}
	redacted := *state
	redacted.Title = redactString(redacted.Title)
	if state.Items != nil {
		redacted.Items = make([]TillDoneItem, len(state.Items))
		for i, item := range state.Items {
			redacted.Items[i] = item
			redacted.Items[i].Description = redactString(item.Description)
		}
	}
	return &redacted
}

func RedactEvent(evt Event) Event {
	evt.SessionID = redactString(evt.SessionID)
	evt.AgentID = redactString(evt.AgentID)
	evt.ParentID = redactString(evt.ParentID)
	evt.Data.SessionName = redactString(evt.Data.SessionName)
	evt.Data.TeamConfig = redactString(evt.Data.TeamConfig)
	evt.Data.TaskPrompt = redactString(evt.Data.TaskPrompt)
	evt.Data.AgentName = redactString(evt.Data.AgentName)
	evt.Data.Model = redactString(evt.Data.Model)
	evt.Data.TeamName = redactString(evt.Data.TeamName)
	evt.Data.TeamColor = redactString(evt.Data.TeamColor)
	evt.Data.PersonaPath = redactString(evt.Data.PersonaPath)
	evt.Data.From = redactString(evt.Data.From)
	evt.Data.To = redactString(evt.Data.To)
	evt.Data.Content = redactString(evt.Data.Content)
	evt.Data.MessageID = redactString(evt.Data.MessageID)
	evt.Data.AckFor = redactString(evt.Data.AckFor)
	evt.Data.Tool = redactString(evt.Data.Tool)
	evt.Data.ToolArgs = redactString(evt.Data.ToolArgs)
	evt.Data.ToolResult = redactString(evt.Data.ToolResult)
	evt.Data.ToolStatus = redactString(evt.Data.ToolStatus)
	evt.Data.FilePath = redactString(evt.Data.FilePath)
	evt.Data.TillDone = redactTillDone(evt.Data.TillDone)
	evt.Data.BlockedPath = redactString(evt.Data.BlockedPath)
	evt.Data.BlockedAction = redactString(evt.Data.BlockedAction)
	evt.Data.BlockReason = redactString(evt.Data.BlockReason)
	evt.Data.Grade = redactString(evt.Data.Grade)
	evt.Data.OutputArtifact = redactString(evt.Data.OutputArtifact)
	evt.Data.TaskReport = redactString(evt.Data.TaskReport)
	evt.Data.FailedWorker = redactString(evt.Data.FailedWorker)
	evt.Data.HealAction = redactString(evt.Data.HealAction)
	evt.Data.ErrorMsg = redactString(evt.Data.ErrorMsg)
	for key, raw := range evt.Data.Extra {
		evt.Data.Extra[key] = redactRawJSON(key, raw)
	}
	return evt
}
