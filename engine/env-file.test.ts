import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadEnvFile } from "./env-file";

describe("loadEnvFile", () => {
  test("loads key/value pairs without overwriting existing env", () => {
    const dir = mkdtempSync(join(tmpdir(), "mae-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, [
      "# comment",
      "MAE_API_TOKEN=from-file",
      "MAE_DASHBOARD_URL=\"http://localhost:8400\"",
      "export MAE_LLM_GATEWAY_URL='http://localhost:4000'",
      "EXISTING=from-file",
      "bad line",
      "",
    ].join("\n"));

    const env: Record<string, string | undefined> = {
      EXISTING: "already-set",
      MAE_DASHBOARD_URL: "http://your-dashboard-host:8400",
    };
    loadEnvFile(path, env);

    expect(env.MAE_API_TOKEN).toBe("from-file");
    expect(env.MAE_DASHBOARD_URL).toBe("http://your-dashboard-host:8400");
    expect(env.MAE_LLM_GATEWAY_URL).toBe("http://localhost:4000");
    expect(env.EXISTING).toBe("already-set");

    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores missing files", () => {
    const env: Record<string, string | undefined> = {};
    loadEnvFile("/tmp/mae-missing-env-file", env);
    expect(env).toEqual({});
  });

  test("ignores unreadable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mae-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, "MAE_DASHBOARD_URL=http://localhost:8400\n");
    chmodSync(path, 0o000);

    const env: Record<string, string | undefined> = {
      MAE_DASHBOARD_URL: "http://your-dashboard-host:8400",
    };
    loadEnvFile(path, env);

    expect(env.MAE_DASHBOARD_URL).toBe("http://your-dashboard-host:8400");

    chmodSync(path, 0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
