#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.MAE_SKIP_INSTALL_VERSION_SYNC === "1") {
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const versionFile = join(repoRoot, "VERSION");
const home = process.env.HOME;
const installHome = process.env.MAE_HOME ?? (home ? join(home, ".mae") : "");

if (!installHome || (!process.env.MAE_HOME && !existsSync(installHome))) {
  process.exit(0);
}

const version = readFileSync(versionFile, "utf8").trim();
mkdirSync(installHome, { recursive: true });
writeFileSync(join(installHome, "VERSION"), `${version}\n`);
