import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadProjectSkills } from "./config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project skill loading", () => {
  test("loads sorted explicit project skills with frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "mae-project-skills-"));
    roots.push(root);
    mkdirSync(join(root, ".mae", "skills"), { recursive: true });
    writeFileSync(join(root, ".mae", "skills", "b.md"), "---\nname: beta\nscope: worker\n---\nUse beta.");
    writeFileSync(join(root, ".mae", "skills", "a.md"), "Plain alpha.");

    const skills = loadProjectSkills(root);
    expect(skills.map((skill) => skill.name)).toEqual(["a", "beta"]);
    expect(skills[0]?.scope).toBe("all");
    expect(skills[1]?.content).toContain("Use beta");
  });
});
