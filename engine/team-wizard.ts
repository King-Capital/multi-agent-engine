import * as p from "@clack/prompts";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { loadTemplate, listTemplates, loadTeams, writeTeams, loadChains, writeChains, BASE_DIR } from "./config";
import { slugify } from "./cli-utils";
import type { TeamTemplate, TeamConfig, TeamMember, Chain } from "./types";

const COLOR_PALETTE = [
  { value: "#00ff88", label: "Green",   hint: "#00ff88" },
  { value: "#ff6b9d", label: "Pink",    hint: "#ff6b9d" },
  { value: "#00d4ff", label: "Cyan",    hint: "#00d4ff" },
  { value: "#ffd93d", label: "Yellow",  hint: "#ffd93d" },
  { value: "#c084fc", label: "Purple",  hint: "#c084fc" },
  { value: "#fb923c", label: "Orange",  hint: "#fb923c" },
  { value: "#34d399", label: "Emerald", hint: "#34d399" },
  { value: "#f472b6", label: "Rose",    hint: "#f472b6" },
];

const MODEL_TIERS = [
  { value: "quality", label: "quality", hint: "Opus-class — deep reasoning" },
  { value: "main",    label: "main",    hint: "Sonnet-class — balanced" },
  { value: "fast",    label: "fast",    hint: "Haiku-class — speed" },
  { value: "pro",     label: "pro",     hint: "Gemini Pro — cross-model" },
];

const ROLE_OPTIONS = [
  { value: "lead",   label: "Lead",   hint: "Coordinates team, delegates work" },
  { value: "worker", label: "Worker", hint: "Executes tasks directly" },
];

interface WizardMember {
  name: string;
  role: "lead" | "worker";
  model: string;
  specialization: string;
}

// ---------------------------------------------------------------------------
// Scaffold helpers
// ---------------------------------------------------------------------------

function buildPersonaContent(member: WizardMember, teamName: string): string {
  const slug = slugify(member.name);
  const skills = member.role === "lead"
    ? [
        "agents/skills/zero-micromanagement.md",
        "agents/skills/active-listener.md",
        "agents/skills/conversational-response.md",
        "agents/skills/till-done.md",
        "agents/skills/mental-model.md",
      ]
    : ["agents/skills/active-listener.md", "agents/skills/mental-model.md"];

  const tools = member.role === "lead"
    ? ["delegate", "read", "grep", "find", "glob"]
    : ["read", "write", "edit", "bash", "grep", "find", "glob"];

  return `---
name: ${member.name}
model: ${member.model}
expertise: agents/expertise/${slug}.md
max_expertise_lines: 7000
skills:
${skills.map((s) => `  - ${s}`).join("\n")}
tools:
${tools.map((t) => `  - ${t}`).join("\n")}
domain:
  read: ["**/*"]
  write: ["agents/expertise/${slug}.md"]
  update: ["agents/expertise/${slug}.md"]
---

# Purpose

You are ${member.name} — a ${member.role} agent on the ${teamName} team.

## Specialization

${member.specialization || "[Describe this agent's specific purpose and responsibilities]"}

## Rules

1. ${member.role === "lead" ? "Delegate work to your team. Think, plan, coordinate." : "Execute tasks as briefed. Be verbose."}
2. Load your expertise file at session start.
3. Update your mental model after every session.
`;
}

function buildExpertiseContent(name: string): string {
  return `# ${name} Expertise

## Domain Rules (always apply)
- [Add domain-specific rules]

## Terminology
- **[Term]**: [Definition]

## Patterns (reference implementations)
- **[Pattern]**: [Description]

## Anti-patterns (things to avoid)
- [What not to do]

## Verification Checklist
- [ ] [Check item]
`;
}

function scaffoldMember(member: WizardMember, teamName: string): void {
  const slug = slugify(member.name);
  const personaPath = join(BASE_DIR, `agents/personas/${slug}.md`);
  const expertisePath = join(BASE_DIR, `agents/expertise/${slug}.md`);

  if (existsSync(personaPath)) {
    p.log.warn(`Persona already exists, skipping: agents/personas/${slug}.md`);
    return;
  }

  mkdirSync(dirname(personaPath), { recursive: true });
  mkdirSync(dirname(expertisePath), { recursive: true });
  writeFileSync(personaPath, buildPersonaContent(member, teamName));
  writeFileSync(expertisePath, buildExpertiseContent(member.name));
  p.log.step(`Created agents/personas/${slug}.md + agents/expertise/${slug}.md`);
}

function buildTeamEntry(teamName: string, color: string, description: string, members: WizardMember[]): TeamConfig {
  if (members.length === 0) throw new Error("Team must have at least one member");
  const lead = members.find((m) => m.role === "lead") ?? members[0]!;
  const workers = members.filter((m) => m !== lead);

  const toMember = (m: WizardMember): TeamMember => ({
    name: m.name,
    path: `agents/personas/${slugify(m.name)}.md`,
    model: m.model,
    color,
    ...(m.specialization ? { "consult-when": m.specialization } : {}),
  });

  return {
    "team-name": teamName,
    "team-color": color,
    "consult-when": description,
    lead: toMember(lead),
    members: workers.map(toMember),
  };
}

function buildChain(teamName: string): Chain {
  return {
    description: `Default workflow for ${teamName}`,
    steps: [
      {
        team: teamName,
        till_done: [
          "Requirements gathered and understood",
          "Implementation plan produced",
        ],
      },
      {
        team: teamName,
        till_done: [
          "All changes implemented per plan",
          "Results verified",
        ],
      },
    ],
  };
}

function appendTeam(entry: TeamConfig): void {
  const teamsFile = loadTeams();
  teamsFile.teams.push(entry);
  writeTeams(teamsFile);
}

function appendChain(teamName: string, chain: Chain): void {
  const chainsFile = loadChains();
  const slug = slugify(teamName);
  chainsFile.chains[slug] = chain;
  writeChains(chainsFile);
}

// ---------------------------------------------------------------------------
// Template mode
// ---------------------------------------------------------------------------

async function templateMode(templateName: string): Promise<void> {
  let template: TeamTemplate;
  try {
    template = loadTemplate(templateName);
  } catch {
    p.log.error(`Template not found: ${templateName}`);
    const available = listTemplates();
    if (available.length > 0) p.log.info(`Available: ${available.join(", ")}`);
    process.exit(1);
  }

  p.intro(`New team from template: ${template.name}`);

  const memberLines = [
    `  Lead: ${template.lead.name} (${template.lead.model})`,
    ...template.members.map((m) => `  ${m.name} (${m.model})`),
  ].join("\n");

  p.note(
    `Team: ${template.name}\nColor: ${template.color}\n\n${template.description}\n\nMembers:\n${memberLines}`,
    "Template Preview",
  );

  const ok = await p.confirm({ message: "Scaffold this team?" });
  if (p.isCancel(ok) || !ok) { p.outro("Cancelled."); return; }

  const allMembers: WizardMember[] = [
    { name: template.lead.name, role: "lead", model: template.lead.model, specialization: template.lead.specialization ?? "" },
    ...template.members.map((m) => ({ name: m.name, role: "worker" as const, model: m.model, specialization: m.specialization })),
  ];

  for (const member of allMembers) scaffoldMember(member, template.name);

  const teamEntry = buildTeamEntry(template.name, template.color, template.description, allMembers);
  appendTeam(teamEntry);
  p.log.success(`Added "${template.name}" to teams.yaml`);

  if (template.chain) {
    appendChain(template.name, { description: template.chain.description, steps: template.chain.steps });
    p.log.success(`Added "${slugify(template.name)}" chain to chains.yaml`);
  }

  p.outro(`Team "${template.name}" scaffolded. Edit persona files to customize.`);
}

// ---------------------------------------------------------------------------
// Interactive wizard mode
// ---------------------------------------------------------------------------

async function interactiveMode(): Promise<void> {
  p.intro("New Team Wizard");

  const teamName = await p.text({
    message: "Team name",
    placeholder: "e.g. Data Science",
    validate: (v) => { if (!v?.trim()) return "Required"; },
  });
  if (p.isCancel(teamName)) { p.outro("Cancelled."); return; }

  const color = await p.select({
    message: "Team color",
    options: COLOR_PALETTE,
  });
  if (p.isCancel(color)) { p.outro("Cancelled."); return; }

  const description = await p.text({
    message: "When should this team be consulted?",
    placeholder: "e.g. ML model training, data pipelines, feature engineering",
    validate: (v) => { if (!v?.trim()) return "Required"; },
  });
  if (p.isCancel(description)) { p.outro("Cancelled."); return; }

  const memberCountStr = await p.text({
    message: "Number of team members (1-6)",
    defaultValue: "3",
    validate: (v) => {
      const n = parseInt(v ?? "", 10);
      if (isNaN(n) || n < 1 || n > 6) return "Must be 1-6";
    },
  });
  if (p.isCancel(memberCountStr)) { p.outro("Cancelled."); return; }
  const memberCount = parseInt(memberCountStr, 10);

  const members: WizardMember[] = [];

  for (let i = 0; i < memberCount; i++) {
    p.log.info(`--- Member ${i + 1} of ${memberCount} ---`);

    const name = await p.text({
      message: `Member ${i + 1} name`,
      placeholder: i === 0 ? "e.g. Team Lead" : "e.g. Data Engineer",
      validate: (v) => { if (!v?.trim()) return "Required"; },
    });
    if (p.isCancel(name)) { p.outro("Cancelled."); return; }

    const role = await p.select({ message: `Role for ${name}`, options: ROLE_OPTIONS });
    if (p.isCancel(role)) { p.outro("Cancelled."); return; }

    const model = await p.select({ message: `Model tier for ${name}`, options: MODEL_TIERS });
    if (p.isCancel(model)) { p.outro("Cancelled."); return; }

    const specialization = await p.text({
      message: `Specialization for ${name}`,
      placeholder: "What does this agent do?",
      validate: (v) => { if (!v?.trim()) return "Required"; },
    });
    if (p.isCancel(specialization)) { p.outro("Cancelled."); return; }

    members.push({ name, role: role as "lead" | "worker", model, specialization });
  }

  // Auto-promote first member to lead if none selected
  if (!members.some((m) => m.role === "lead")) {
    members[0]!.role = "lead";
    p.log.warn(`No lead selected — auto-promoted "${members[0]!.name}" to lead.`);
  }

  const wantChain = await p.confirm({ message: "Generate a starter chain for this team?" });
  if (p.isCancel(wantChain)) { p.outro("Cancelled."); return; }

  // Scaffold
  const s = p.spinner();
  s.start("Scaffolding team...");

  for (const member of members) scaffoldMember(member, teamName);

  const teamEntry = buildTeamEntry(teamName, color, description, members);
  appendTeam(teamEntry);

  if (wantChain) {
    appendChain(teamName, buildChain(teamName));
  }

  s.stop("Scaffolding complete.");

  const summary = members.map((m) => `  ${m.role === "lead" ? "★" : "•"} ${m.name} (${m.model})`).join("\n");
  p.note(`Team: ${teamName}\nColor: ${color}\n\n${summary}`, "Created");

  p.outro(`Team "${teamName}" is ready. Edit persona files in agents/personas/ to customize.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function teamWizard(args: string[]): Promise<void> {
  const templateIdx = args.indexOf("--template");
  if (templateIdx !== -1 && args[templateIdx + 1]) {
    const templateName = args[templateIdx + 1]!;
    if (templateName.startsWith("--")) {
      p.log.error("Missing template name after --template");
      return;
    }
    await templateMode(templateName);
  } else if (args.includes("--list-templates")) {
    const templates = listTemplates();
    if (templates.length === 0) { console.log("No templates found."); return; }
    console.log("Available templates:");
    for (const t of templates) console.log(`  ${t}`);
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: mae new-team [options]

Options:
  --template <name>   Create team from template (${listTemplates().join(", ") || "none available"})
  --list-templates    List available templates
  -h, --help          Show this help

Without options, starts the interactive team wizard.
`);
  } else {
    await interactiveMode();
  }
}
