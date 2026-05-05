import { describe, test, expect } from "bun:test";
import { Orchestrator } from "./orchestrator";
import { EchoAdapter } from "./adapters/echo";
import { loadTeams, loadChains, loadPersona, buildSystemPrompt, getTeam, getChain, loadPrompt } from "./config";

describe("config loading", () => {
  test("loads teams.yaml", () => {
    const teams = loadTeams();
    expect(teams.orchestrator.name).toBe("Orchestrator");
    expect(teams.teams.length).toBeGreaterThan(0);
  });

  test("loads chains.yaml", () => {
    const chains = loadChains();
    expect(chains.chains["plan-build-review"]).toBeDefined();
    expect(chains.chains["plan-build-review"]!.steps.length).toBe(3);
  });

  test("loads all personas", () => {
    const personas = ["orchestrator", "planner", "builder", "scout", "reviewer", "red-team", "validator"];
    for (const name of personas) {
      const persona = loadPersona(`agents/personas/${name}.md`);
      expect(persona.name).toBeTruthy();
      expect(persona.model).toBeTruthy();
      expect(persona.skills.length).toBeGreaterThan(0);
      expect(persona.tools.length).toBeGreaterThan(0);
    }
  });

  test("builds system prompts with skills", () => {
    const persona = loadPersona("agents/personas/orchestrator.md");
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("Zero Micromanagement");
    expect(prompt).toContain("Active Listener");
    expect(prompt).toContain("Prompt Engineering");
  });

  test("gets specific team", () => {
    const team = getTeam("Planning");
    expect(team.lead.name).toBe("Planning Lead");
    expect(team.members.length).toBeGreaterThan(0);
  });

  test("gets specific chain", () => {
    const chain = getChain("build-verify");
    expect(chain.steps.length).toBe(2);
    expect(chain.steps[1]!.on_feedback).toBeDefined();
    expect(chain.steps[1]!.on_feedback!.max_attempts).toBe(3);
  });

  test("loads prompts", () => {
    const { config, body } = loadPrompt("plan-build-review");
    expect(config.description).toContain("Full SDLC");
    expect(config.chain).toBe("plan-build-review");
    expect(body).toContain("Workflow");
  });
});

describe("orchestrator with echo adapter", () => {
  test("runs plan-build-review chain", async () => {
    const orch = new Orchestrator("http://localhost:8400");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Test task",
      chain: "plan-build-review",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
    expect(session.totalCost).toBeGreaterThan(0);
  });

  test("runs scout-then-plan chain", async () => {
    const orch = new Orchestrator("http://localhost:8400");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Explore the auth module",
      chain: "scout-then-plan",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
  });

  test("runs review-only chain", async () => {
    const orch = new Orchestrator("http://localhost:8400");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Review git diff HEAD~1",
      chain: "review-only",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
  });

  test("runs prompt-based workflow", async () => {
    const orch = new Orchestrator("http://localhost:8400");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      prompt: "review",
      task: "git diff HEAD",
      args: ["git diff HEAD"],
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
  });
});

describe("adapter detection", () => {
  test("echo adapter is always available", async () => {
    const echo = new EchoAdapter();
    expect(await echo.isAvailable()).toBe(true);
  });
});

describe("team configs", () => {
  test("has cross-model teams", () => {
    const teams = loadTeams();
    const engA = teams.teams.find((t) => t["team-name"] === "Engineering");
    const engB = teams.teams.find((t) => t["team-name"] === "Engineering B");
    expect(engA).toBeDefined();
    expect(engB).toBeDefined();
    expect(engA!.lead.model).not.toBe(engB!.lead.model);
  });

  test("validation teams use different models", () => {
    const teams = loadTeams();
    const valA = teams.teams.find((t) => t["team-name"] === "Validation");
    const valB = teams.teams.find((t) => t["team-name"] === "Validation B");
    expect(valA).toBeDefined();
    expect(valB).toBeDefined();
    expect(valA!.lead.model).not.toBe(valB!.lead.model);
  });
});
