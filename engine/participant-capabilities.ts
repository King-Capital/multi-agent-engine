import type { DomainConfig, ParticipantCapabilities } from "./types";

export interface ParticipantCapabilityOpts {
  tools: string[];
  domain: DomainConfig;
  model?: string;
  canDelegate?: boolean;
  canSteer?: boolean;
  canSpawnWorkers?: boolean;
  canReviewWorkers?: boolean;
  canWriteFiles?: boolean;
  authority?: number;
}

export function buildParticipantCapabilities(opts: ParticipantCapabilityOpts): ParticipantCapabilities {
  const domain = opts.domain;
  return {
    model: opts.model,
    toolCount: opts.tools.length,
    readScopeCount: domain.read.length,
    writeScopeCount: domain.write.length + domain.update.length,
    canDelegate: opts.canDelegate ?? false,
    canSteer: opts.canSteer,
    canSpawnWorkers: opts.canSpawnWorkers ?? false,
    canReviewWorkers: opts.canReviewWorkers ?? false,
    canWriteFiles: opts.canWriteFiles ?? (domain.write.length > 0 || domain.update.length > 0),
    authority: opts.authority ?? 40,
  };
}
