#!/usr/bin/env bash
# Seed test data to demonstrate the dashboard
set -euo pipefail

API="http://localhost:8400/api/events"
SID="demo-$(date +%s)"

post() { curl -s -X POST "$API" -H "Content-Type: application/json" -d "$1" > /dev/null; }

echo "Seeding session: $SID"

# Session start
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"orch-1\",
  \"event_type\": \"session_start\",
  \"data\": {
    \"session_name\": \"Plan-Build-Review Demo\",
    \"team_config\": \"full-sdlc\",
    \"task_prompt\": \"Add input validation to the auth middleware\"
  }
}"

# Orchestrator spawn
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"orch-1\",
  \"event_type\": \"agent_spawn\",
  \"data\": {
    \"agent_name\": \"Orchestrator\",
    \"agent_role\": \"orchestrator\",
    \"model\": \"litellm/opus-nocache\",
    \"team_name\": \"Orchestration\",
    \"team_color\": \"#36f9f6\"
  }
}"

sleep 0.3

# Orchestrator message
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"orch-1\",
  \"event_type\": \"message\",
  \"data\": {
    \"from\": \"orch-1\",
    \"to\": \"planning-lead\",
    \"content\": \"@Planning Lead: Analyze the auth middleware in src/middleware/auth.ts. Produce an implementation plan for adding input validation. Document: 1) Current validation gaps, 2) Attack vectors, 3) Implementation steps with file paths. Write plan to session dir.\"
  }
}"

# Planning lead spawn
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"planning-lead\",
  \"parent_id\": \"orch-1\",
  \"event_type\": \"agent_spawn\",
  \"data\": {
    \"agent_name\": \"Planning Lead\",
    \"agent_role\": \"lead\",
    \"model\": \"litellm/opus-nocache\",
    \"team_name\": \"Planning\",
    \"team_color\": \"#ffd93d\"
  }
}"

sleep 0.2

# Planning lead spawns scout
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"scout-1\",
  \"parent_id\": \"planning-lead\",
  \"event_type\": \"agent_spawn\",
  \"data\": {
    \"agent_name\": \"Scout\",
    \"agent_role\": \"worker\",
    \"model\": \"litellm/haiku-nocache\",
    \"team_name\": \"Planning\",
    \"team_color\": \"#ffd93d\"
  }
}"

# Scout tool calls
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"scout-1\",
  \"event_type\": \"tool_call\",
  \"data\": {
    \"tool\": \"read\",
    \"file_path\": \"src/middleware/auth.ts\",
    \"tool_status\": \"success\"
  }
}"

post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"scout-1\",
  \"event_type\": \"tool_call\",
  \"data\": {
    \"tool\": \"grep\",
    \"tool_args\": \"validate|sanitize|escape\",
    \"file_path\": \"src/\",
    \"tool_status\": \"success\"
  }
}"

# Scout cost update
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"scout-1\",
  \"event_type\": \"cost_update\",
  \"tokens_used\": 12500,
  \"cost_usd\": 0.031,
  \"context_tokens\": 45000
}"

sleep 0.2

# Scout done
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"scout-1\",
  \"event_type\": \"agent_done\",
  \"data\": { \"status\": \"done\" }
}"

# Planning lead message
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"planning-lead\",
  \"event_type\": \"message\",
  \"data\": {
    \"from\": \"planning-lead\",
    \"to\": \"orch-1\",
    \"content\": \"Plan complete. Found 3 validation gaps in auth middleware: 1) No email format check, 2) Password length unchecked, 3) JWT payload not sanitized. Implementation: 4 files, ~80 lines.\"
  }
}"

# Planning lead cost
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"planning-lead\",
  \"event_type\": \"cost_update\",
  \"tokens_used\": 28000,
  \"cost_usd\": 0.437,
  \"context_tokens\": 981000
}"

# Engineering lead spawn
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"eng-lead\",
  \"parent_id\": \"orch-1\",
  \"event_type\": \"agent_spawn\",
  \"data\": {
    \"agent_name\": \"Engineering Lead\",
    \"agent_role\": \"lead\",
    \"model\": \"litellm/opus-nocache\",
    \"team_name\": \"Engineering\",
    \"team_color\": \"#00d4ff\"
  }
}"

# Builder spawn
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"builder-1\",
  \"parent_id\": \"eng-lead\",
  \"event_type\": \"agent_spawn\",
  \"data\": {
    \"agent_name\": \"Builder\",
    \"agent_role\": \"worker\",
    \"model\": \"litellm/sonnet-nocache\",
    \"team_name\": \"Engineering\",
    \"team_color\": \"#00d4ff\"
  }
}"

# Builder tool calls
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"builder-1\",
  \"event_type\": \"tool_call\",
  \"data\": {
    \"tool\": \"edit\",
    \"file_path\": \"src/middleware/auth.ts\",
    \"tool_status\": \"success\"
  }
}"

# Domain block example
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"builder-1\",
  \"event_type\": \"domain_block\",
  \"data\": {
    \"blocked_path\": \"src/config/database.ts\",
    \"blocked_action\": \"write\",
    \"block_reason\": \"Builder domain restricted to src/middleware/\"
  }
}"

# Builder cost
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"builder-1\",
  \"event_type\": \"cost_update\",
  \"tokens_used\": 45000,
  \"cost_usd\": 0.876,
  \"context_tokens\": 943000
}"

# Validation lead spawn
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"val-lead\",
  \"parent_id\": \"orch-1\",
  \"event_type\": \"agent_spawn\",
  \"data\": {
    \"agent_name\": \"Validation Lead\",
    \"agent_role\": \"lead\",
    \"model\": \"litellm/opus-nocache\",
    \"team_name\": \"Validation\",
    \"team_color\": \"#ff6b9d\"
  }
}"

# Reviewer spawn
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"reviewer-1\",
  \"parent_id\": \"val-lead\",
  \"event_type\": \"agent_spawn\",
  \"data\": {
    \"agent_name\": \"Code Reviewer\",
    \"agent_role\": \"worker\",
    \"model\": \"openai/gpt-5.5\",
    \"team_name\": \"Validation\",
    \"team_color\": \"#ff6b9d\"
  }
}"

# Self-heal example
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"val-lead\",
  \"event_type\": \"self_heal\",
  \"data\": {
    \"failed_worker\": \"Security Reviewer\",
    \"heal_action\": \"Worker returned empty. I'll proceed with my own security analysis as the lead.\"
  }
}"

# Validation lead message
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"val-lead\",
  \"event_type\": \"message\",
  \"data\": {
    \"from\": \"val-lead\",
    \"to\": \"orch-1\",
    \"content\": \"Validation complete. Found 1 issue: email regex allows unicode bypass. Delegating fix back to engineering.\"
  }
}"

# Validation costs
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"val-lead\",
  \"event_type\": \"cost_update\",
  \"tokens_used\": 52000,
  \"cost_usd\": 2.376,
  \"context_tokens\": 953000
}"

post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"reviewer-1\",
  \"event_type\": \"cost_update\",
  \"tokens_used\": 18000,
  \"cost_usd\": 0.807,
  \"context_tokens\": 932000
}"

# Orchestrator cost
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"orch-1\",
  \"event_type\": \"cost_update\",
  \"tokens_used\": 35000,
  \"cost_usd\": 7.114,
  \"context_tokens\": 982000
}"

# TillDone update
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"orch-1\",
  \"event_type\": \"tilldone\",
  \"data\": {
    \"tilldone\": {
      \"title\": \"Auth Middleware Validation\",
      \"completed\": 5,
      \"total\": 7,
      \"items\": [
        {\"description\": \"Scout auth middleware for validation gaps\", \"completed\": true, \"active\": false},
        {\"description\": \"Create implementation plan with file paths\", \"completed\": true, \"active\": false},
        {\"description\": \"Add email format validation\", \"completed\": true, \"active\": false},
        {\"description\": \"Add password length check\", \"completed\": true, \"active\": false},
        {\"description\": \"Add JWT payload sanitization\", \"completed\": true, \"active\": false},
        {\"description\": \"Fix unicode bypass in email regex\", \"completed\": false, \"active\": true},
        {\"description\": \"Final validation pass\", \"completed\": false, \"active\": false}
      ]
    }
  }
}"

# Orchestrator delegates fix
post "{
  \"session_id\": \"$SID\",
  \"agent_id\": \"orch-1\",
  \"event_type\": \"message\",
  \"data\": {
    \"from\": \"orch-1\",
    \"to\": \"eng-lead\",
    \"content\": \"@Engineering Lead: Validation found a unicode bypass in the email regex. Fix the pattern in src/middleware/auth.ts to reject non-ASCII characters in the local part. Re-run validation after fix.\"
  }
}"

echo ""
echo "Done! Open http://localhost:8400/session/$SID"
