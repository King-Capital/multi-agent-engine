import { test, expect, describe } from "bun:test";
import { getFlag, stripFlags, slugify } from "./cli-utils";

describe("getFlag", () => {
  test("returns value following a named flag", () => {
    expect(getFlag(["--name", "alice"], "--name")).toBe("alice");
  });

  test("returns undefined when flag is absent", () => {
    expect(getFlag(["--other", "val"], "--name")).toBeUndefined();
  });

  test("returns undefined when flag is the last arg (no value)", () => {
    expect(getFlag(["--name"], "--name")).toBeUndefined();
  });

  test("returns first occurrence when flag appears multiple times", () => {
    expect(getFlag(["--name", "first", "--name", "second"], "--name")).toBe("first");
  });

  test("returns undefined for empty args", () => {
    expect(getFlag([], "--name")).toBeUndefined();
  });

  test("does not match partial flag names", () => {
    expect(getFlag(["--namespace", "val"], "--name")).toBeUndefined();
  });

  test("returns the next arg even if it looks like a flag", () => {
    expect(getFlag(["--name", "--value"], "--name")).toBe("--value");
  });
});

describe("stripFlags", () => {
  test("returns only positional args", () => {
    expect(stripFlags(["pos1", "--flag", "val", "pos2"])).toEqual(["pos1", "pos2"]);
  });

  test("handles --key=value form", () => {
    expect(stripFlags(["pos", "--key=value", "pos2"])).toEqual(["pos", "pos2"]);
  });

  test("returns all args when no flags present", () => {
    expect(stripFlags(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("returns empty array for empty input", () => {
    expect(stripFlags([])).toEqual([]);
  });

  test("strips multiple flag pairs", () => {
    expect(stripFlags(["--a", "1", "--b", "2", "pos"])).toEqual(["pos"]);
  });

  test("handles flag at end without value (skips 2)", () => {
    expect(stripFlags(["pos", "--flag", "eaten"])).toEqual(["pos"]);
  });

  test("handles mixed --key=value and --key value", () => {
    expect(stripFlags(["--a=1", "--b", "2", "pos"])).toEqual(["pos"]);
  });
});

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Frontend Designer")).toBe("frontend-designer");
  });

  test("collapses multiple hyphens", () => {
    expect(slugify("a--b---c")).toBe("a-b-c");
  });

  test("strips leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  test("replaces special characters", () => {
    expect(slugify("C++ Expert (Sr.)")).toBe("c-expert-sr");
  });

  test("handles unicode by stripping non-ascii", () => {
    expect(slugify("café")).toBe("caf");
  });

  test("throws on empty string", () => {
    expect(() => slugify("")).toThrow("empty slug");
  });

  test("throws when input produces empty slug", () => {
    expect(() => slugify("!!!")).toThrow("empty slug");
  });

  test("handles single character", () => {
    expect(slugify("a")).toBe("a");
  });

  test("handles numbers", () => {
    expect(slugify("Agent 007")).toBe("agent-007");
  });
});
