/**
 * Pipeline State Tracker
 * 
 * Wraps the orchestrator's chain execution with persistent state,
 * so pipelines can be inspected, resumed after crashes, and 
 * visualized in the dashboard.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PipelineStage {
  name: string;
  type: "team" | "agent" | "parallel";
  status: StageStatus;
  team?: string;
  agent?: string;
  parallelTeams?: string[];
  startedAt?: string;
  completedAt?: string;
  grade?: string;
  cost: number;
  tokens: number;
  retries: number;
  maxRetries: number;
  output?: string;
  error?: string;
}

export interface PipelineState {
  id: string;
  name: string;
  chain: string;
  task: string;
  status: "running" | "completed" | "failed" | "paused";
  currentStage: number;
  stages: PipelineStage[];
  totalCost: number;
  totalTokens: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

const STATE_DIR = join(process.env.MAE_ROOT ?? join(import.meta.dir, ".."), "data", "pipelines");

export class PipelineTracker {
  private state: PipelineState;
  private statePath: string;

  constructor(sessionId: string, name: string, chain: string, task: string) {
    mkdirSync(STATE_DIR, { recursive: true });
    this.statePath = join(STATE_DIR, `${sessionId}.json`);

    this.state = {
      id: sessionId,
      name,
      chain,
      task,
      status: "running",
      currentStage: 0,
      stages: [],
      totalCost: 0,
      totalTokens: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  static resume(sessionId: string): PipelineTracker | null {
    const path = join(STATE_DIR, `${sessionId}.json`);
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as PipelineState;
      const tracker = new PipelineTracker(data.id, data.name, data.chain, data.task);
      tracker.state = data;
      return tracker;
    } catch {
      return null;
    }
  }

  addStage(stage: Omit<PipelineStage, "status" | "cost" | "tokens" | "retries" | "maxRetries">): number {
    const idx = this.state.stages.length;
    this.state.stages.push({
      ...stage,
      status: "pending",
      cost: 0,
      tokens: 0,
      retries: 0,
      maxRetries: 3,
    });
    this.save();
    return idx;
  }

  startStage(idx: number): void {
    const stage = this.state.stages[idx];
    if (!stage) return;
    stage.status = "running";
    stage.startedAt = new Date().toISOString();
    this.state.currentStage = idx;
    this.save();
  }

  completeStage(idx: number, result: { grade?: string; cost: number; tokens: number; output?: string }): void {
    const stage = this.state.stages[idx];
    if (!stage) return;
    stage.status = "completed";
    stage.completedAt = new Date().toISOString();
    stage.grade = result.grade;
    stage.cost = result.cost;
    stage.tokens = result.tokens;
    stage.output = result.output?.slice(0, 500);
    this.state.totalCost += result.cost;
    this.state.totalTokens += result.tokens;
    this.save();
  }

  failStage(idx: number, error: string): void {
    const stage = this.state.stages[idx];
    if (!stage) return;
    stage.status = "failed";
    stage.completedAt = new Date().toISOString();
    stage.error = error;
    this.save();
  }

  retryStage(idx: number): boolean {
    const stage = this.state.stages[idx];
    if (!stage) return false;
    if (stage.retries >= stage.maxRetries) return false;
    stage.retries++;
    stage.status = "running";
    stage.startedAt = new Date().toISOString();
    this.save();
    return true;
  }

  complete(): void {
    this.state.status = "completed";
    this.state.completedAt = new Date().toISOString();
    this.save();
  }

  fail(error?: string): void {
    this.state.status = "failed";
    this.state.completedAt = new Date().toISOString();
    this.save();
  }

  getState(): PipelineState {
    return { ...this.state };
  }

  getNextPendingStage(): number {
    return this.state.stages.findIndex(s => s.status === "pending");
  }

  toJSON(): string {
    return JSON.stringify(this.state, null, 2);
  }

  private save(): void {
    this.state.updatedAt = new Date().toISOString();
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[pipeline] Failed to save state: ${err}`);
    }
  }
}
