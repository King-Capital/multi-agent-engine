/**
 * Health Check Module
 *
 * Probes engine subsystems and returns structured health status.
 * Used by `mae health` CLI command.
 *
 * Probes:
 *   - adapters    — isAvailable() on each registered adapter
 *   - traces      — TRACE_DIR exists and is writable
 *   - dashboard   — HTTP health endpoint
 *   - langfuse    — API connectivity (if configured)
 */

import { existsSync, accessSync, constants } from "fs";
import { TRACE_DIR } from "./trace-recorder";
import type { PlatformAdapter } from "./types";

export type ProbeStatus = "healthy" | "degraded" | "unhealthy";

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  status: ProbeStatus;
  timestamp: string;
  version: string;
  probes: ProbeResult[];
}

/**
 * Determine overall status from individual probes.
 * unhealthy if any probe is unhealthy, degraded if any degraded, else healthy.
 */
function overallStatus(probes: ProbeResult[]): ProbeStatus {
  if (probes.some((p) => p.status === "unhealthy")) return "unhealthy";
  if (probes.some((p) => p.status === "degraded")) return "degraded";
  return "healthy";
}

/**
 * Probe: Adapter availability
 */
export async function probeAdapters(
  adapters: PlatformAdapter[]
): Promise<ProbeResult> {
  const start = performance.now();
  const results: Record<string, boolean> = {};
  let available = 0;

  for (const adapter of adapters) {
    try {
      const ok = await adapter.isAvailable();
      results[adapter.name] = ok;
      if (ok) available++;
    } catch {
      results[adapter.name] = false;
    }
  }

  const latencyMs = Math.round(performance.now() - start);
  const total = adapters.length;

  if (total === 0) {
    return {
      name: "adapters",
      status: "unhealthy",
      message: "No adapters registered",
      latencyMs,
      details: results,
    };
  }

  if (available === 0) {
    return {
      name: "adapters",
      status: "unhealthy",
      message: `0/${total} adapters available`,
      latencyMs,
      details: results,
    };
  }

  const status: ProbeStatus = available === total ? "healthy" : "degraded";
  return {
    name: "adapters",
    status,
    message: `${available}/${total} adapters available`,
    latencyMs,
    details: results,
  };
}

/**
 * Probe: Trace recording (TRACE_DIR exists and is writable)
 */
export function probeTraces(): ProbeResult {
  const start = performance.now();
  try {
    if (!existsSync(TRACE_DIR)) {
      return {
        name: "traces",
        status: "unhealthy",
        message: `Trace directory does not exist: ${TRACE_DIR}`,
        latencyMs: Math.round(performance.now() - start),
        details: { path: TRACE_DIR },
      };
    }
    accessSync(TRACE_DIR, constants.W_OK);
    const latencyMs = Math.round(performance.now() - start);
    return {
      name: "traces",
      status: "healthy",
      message: `Trace directory writable: ${TRACE_DIR}`,
      latencyMs,
      details: { path: TRACE_DIR },
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      name: "traces",
      status: "unhealthy",
      message: `Trace directory not writable: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs,
      details: { path: TRACE_DIR },
    };
  }
}

/**
 * Probe: Dashboard connectivity
 */
export async function probeDashboard(dashboardUrl: string): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const resp = await fetch(`${dashboardUrl}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Math.round(performance.now() - start);

    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      const details: Record<string, unknown> = { url: dashboardUrl };
      if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (d.version) details.version = d.version;
        if (d.uptime) details.uptime = d.uptime;
      }
      return {
        name: "dashboard",
        status: "healthy",
        message: `Dashboard reachable at ${dashboardUrl}`,
        latencyMs,
        details,
      };
    }

    return {
      name: "dashboard",
      status: "degraded",
      message: `Dashboard responded with HTTP ${resp.status}`,
      latencyMs,
      details: { url: dashboardUrl, httpStatus: resp.status },
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      name: "dashboard",
      status: "degraded",
      message: `Dashboard unreachable: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs,
      details: { url: dashboardUrl },
    };
  }
}

/**
 * Probe: Langfuse connectivity
 */
export async function probeLangfuse(): Promise<ProbeResult> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const host = process.env.LANGFUSE_HOST ?? "http://10.71.20.73:3000";

  if (!publicKey || !secretKey) {
    return {
      name: "langfuse",
      status: "degraded",
      message: "Langfuse not configured (missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY)",
      details: { configured: false },
    };
  }

  const start = performance.now();
  try {
    const auth = btoa(`${publicKey}:${secretKey}`);
    const resp = await fetch(`${host}/api/public/health`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Math.round(performance.now() - start);

    if (resp.ok) {
      return {
        name: "langfuse",
        status: "healthy",
        message: `Langfuse connected at ${host}`,
        latencyMs,
        details: { host, configured: true },
      };
    }

    return {
      name: "langfuse",
      status: "degraded",
      message: `Langfuse responded with HTTP ${resp.status}`,
      latencyMs,
      details: { host, configured: true, httpStatus: resp.status },
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      name: "langfuse",
      status: "degraded",
      message: `Langfuse unreachable: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs,
      details: { host, configured: true },
    };
  }
}

/**
 * Run all health probes and return a unified report.
 */
export async function runHealthCheck(
  adapters: PlatformAdapter[],
  dashboardUrl: string,
  version: string
): Promise<HealthReport> {
  const [adapterProbe, dashboardProbe, langfuseProbe] = await Promise.all([
    probeAdapters(adapters),
    probeDashboard(dashboardUrl),
    probeLangfuse(),
  ]);

  const traceProbe = probeTraces();

  const probes = [adapterProbe, traceProbe, dashboardProbe, langfuseProbe];

  return {
    status: overallStatus(probes),
    timestamp: new Date().toISOString(),
    version,
    probes,
  };
}

/**
 * Format a health report for human-readable terminal output.
 */
export function formatHealthReport(report: HealthReport): string {
  const statusIcon = (s: ProbeStatus) =>
    s === "healthy" ? "✓" : s === "degraded" ? "⚠" : "✗";
  const statusColor = (s: ProbeStatus) =>
    s === "healthy" ? "\x1b[32m" : s === "degraded" ? "\x1b[33m" : "\x1b[31m";
  const reset = "\x1b[0m";

  const lines: string[] = [];
  lines.push("");
  lines.push("═".repeat(50));
  lines.push(`  MAE Health Check — v${report.version}`);
  lines.push("═".repeat(50));
  lines.push(`  Overall: ${statusColor(report.status)}${statusIcon(report.status)} ${report.status.toUpperCase()}${reset}`);
  lines.push(`  Time:    ${report.timestamp}`);
  lines.push("");

  for (const probe of report.probes) {
    const icon = statusColor(probe.status) + statusIcon(probe.status) + reset;
    const latency = probe.latencyMs !== undefined ? ` (${probe.latencyMs}ms)` : "";
    lines.push(`  ${icon} ${probe.name.padEnd(12)} ${probe.message}${latency}`);
  }

  lines.push("");
  lines.push("═".repeat(50));
  lines.push("");
  return lines.join("\n");
}
