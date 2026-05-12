package main

const sessionAgentCostRollupSQL = `
	WITH event_points AS (
		SELECT
			e.session_id,
			COALESCE(
				NULLIF(e.agent_id, ''),
				NULLIF(e.payload->>'agent_id', ''),
				NULLIF(e.payload->'data'->>'agent_id', ''),
				'__session__'
			) AS agent_key,
			e.created_at,
			COALESCE(e.payload->>'cost_usd', e.payload->'data'->>'cost_usd') AS cost_text,
			COALESCE(e.payload->>'tokens_used', e.payload->'data'->>'tokens_used') AS tokens_text
		FROM events e
		WHERE e.event_type = 'cost_update'
	),
	event_costs AS (
		SELECT
			session_id,
			agent_key,
			MAX(CASE WHEN cost_text ~ '^[0-9]+(\.[0-9]+)?$' THEN cost_text::numeric ELSE NULL END) AS cost_usd,
			MAX(CASE WHEN tokens_text ~ '^[0-9]+$' THEN tokens_text::bigint ELSE NULL END) AS tokens_used,
			MAX(created_at) AS last_cost_at
		FROM event_points
		GROUP BY session_id, agent_key
	),
	agent_costs AS (
		SELECT
			session_id,
			agent_id AS agent_key,
			cost_usd::numeric AS cost_usd,
			NULL::bigint AS tokens_used,
			updated_at AS last_cost_at
		FROM agents
		WHERE cost_usd > 0
	),
	session_agent_costs AS (
		SELECT
			COALESCE(e.session_id, a.session_id) AS session_id,
			COALESCE(e.agent_key, a.agent_key) AS agent_key,
			COALESCE(e.cost_usd, a.cost_usd, 0) AS cost_usd,
			COALESCE(e.tokens_used, a.tokens_used, 0) AS tokens_used,
			COALESCE(e.last_cost_at, a.last_cost_at) AS last_cost_at
		FROM event_costs e
		FULL JOIN agent_costs a
			ON a.session_id = e.session_id
			AND a.agent_key = e.agent_key
	)
`
