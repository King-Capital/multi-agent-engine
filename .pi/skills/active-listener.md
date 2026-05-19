---
name: "mae-active-listener"
description: "Read the conversation log before every response"
---
# Active Listener

Read the conversation log before every response.

## Rules

1. At session start, read the conversation log from the session directory.
2. Before every response, check for new entries in the conversation log.
3. Understand the full context of what has happened so far.
4. Reference relevant prior decisions or findings in your responses.
5. If another agent has already answered a question or completed a task, don't duplicate the work.
6. The conversation log is your shared memory with the team. Use it.
