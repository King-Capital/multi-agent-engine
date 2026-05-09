package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"mae.local/dashboard/templates"
)

// sanitizeSlug strips path traversal components from agent slugs.
func sanitizeSlug(slug string) string {
	safe := filepath.Base(slug)
	if safe == "." || safe == "" || strings.ContainsAny(safe, `/\`) {
		return "invalid"
	}
	return safe
}

func handleAgentsList(w http.ResponseWriter, r *http.Request) {
	agents := loadAllAgents()
	templates.AgentsPage(agents, nil).Render(r.Context(), w)
}

func handleAgentDetail(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if sanitizeSlug(slug) != slug {
		http.Error(w, "invalid slug", http.StatusBadRequest)
		return
	}
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

func handleGetAgentPrompt(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if sanitizeSlug(slug) != slug {
		http.Error(w, "invalid slug", http.StatusBadRequest)
		return
	}
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
	// Admin-only: check user role
	user, _ := r.Context().Value(userContextKey).(*DBUser)
	if user == nil || user.Role != "admin" {
		http.Error(w, "admin access required", http.StatusForbidden)
		return
	}

	slug := chi.URLParam(r, "slug")
	if sanitizeSlug(slug) != slug {
		http.Error(w, "invalid slug", http.StatusBadRequest)
		return
	}
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
	if sanitizeSlug(slug) != slug {
		http.Error(w, "invalid slug", http.StatusBadRequest)
		return
	}

	var req struct {
		Prompt string   `json:"prompt"`
		Model  string   `json:"model"`
		Tools  []string `json:"tools"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	llmGatewayURL := os.Getenv("MAE_LLM_GATEWAY_URL")
	if llmGatewayURL == "" {
		llmGatewayURL = os.Getenv("LITELLM_URL")
	}
	if llmGatewayURL == "" {
		http.Error(w, `{"error":"MAE_LLM_GATEWAY_URL not configured"}`, http.StatusServiceUnavailable)
		return
	}
	llmGatewayKey := os.Getenv("MAE_LLM_GATEWAY_KEY")
	if llmGatewayKey == "" {
		llmGatewayKey = os.Getenv("LITELLM_KEY")
	}
	if llmGatewayKey == "" {
		llmGatewayKey = os.Getenv("ANTHROPIC_API_KEY")
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

	httpReq, _ := http.NewRequest("POST", llmGatewayURL+"/v1/chat/completions", strings.NewReader(string(body)))
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+llmGatewayKey)

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
