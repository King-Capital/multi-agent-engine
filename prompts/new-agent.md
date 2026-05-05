---
description: Scaffold a new agent persona with expertise file
argument-hint: <name> <role> <team> <model> <domain-template>
---

# Purpose

Create a new agent persona, register it in the team config, and initialize its expertise file.

## Variables

NAME: $1
ROLE: $2
TEAM: $3
MODEL: $4
DOMAIN: $5

## Instructions

- Create the persona .md file from template
- Create empty expertise file
- Register in teams.yaml under the specified team
- Use the domain template from damage-control-rules.yaml if $DOMAIN matches a template name

## Workflow

1. Create `agents/personas/$NAME.md`:
   - Copy structure from the closest existing persona for the role
   - Set name, model, expertise path, domain from arguments
   - Assign standard skills for the role:
     - orchestrator/lead: zero-micromanagement, active-listener, conversational-response, till-done, mental-model
     - worker: active-listener, mental-model
   - Set tools for the role:
     - orchestrator: delegate only
     - lead: delegate + read tools
     - worker: full tools, domain-locked

2. Create `agents/expertise/$NAME.md`:
   - Empty file with header: "# $NAME Expertise"
   - Agent will populate this automatically during sessions

3. Update `agents/teams/teams.yaml`:
   - Add the new agent under the $TEAM team's members list
   - Set consult-when based on the agent's purpose

## Report

- Created: agents/personas/$NAME.md
- Created: agents/expertise/$NAME.md
- Updated: agents/teams/teams.yaml
- Agent ready to use in team: $TEAM
