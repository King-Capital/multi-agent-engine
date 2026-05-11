/**
 * Sandbox Pool Manager
 * 
 * Manages pre-warmed LXC sandboxes for agent isolation.
 * Sandboxes run warm at 512MB RAM and scale to 4GB when assigned to an agent.
 */

import { createLogger } from "./logger";

const log = createLogger("sandbox-pool");

export interface SandboxInfo {
  id: number;       // 1-4
  vmid: number;     // 801-804
  ip: string;
  hostname: string; // mae-sandbox-1 through 4
  assignedTo?: string; // agent ID
  active: boolean;  // true = 4GB, false = 512MB
}

export class SandboxPool {
  private sandboxes: Map<number, SandboxInfo> = new Map();
  private pveApi: string;
  private pveToken: string;

  constructor(opts?: { pveApi?: string; pveToken?: string; poolSize?: number }) {
    this.pveApi = opts?.pveApi ?? process.env.PVE_API ?? "";
    this.pveToken = opts?.pveToken ?? process.env.PVE_TOKEN ?? "";

    if (this.pveApi && !this.pveApi.startsWith("https://")) {
      log.warn("PVE_API is not HTTPS — credentials may be transmitted in cleartext");
    }

    const poolSize = opts?.poolSize ?? 4;

    const rawSubnet = process.env.MAE_SANDBOX_SUBNET ?? "10.0.0";
    const sandboxSubnet = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawSubnet) ? rawSubnet : (() => {
      log.error(`Invalid MAE_SANDBOX_SUBNET "${rawSubnet}", using default "10.0.0"`);
      return "10.0.0";
    })();

    const rawOffset = process.env.MAE_SANDBOX_HOST_OFFSET ?? "81";
    const sandboxHostOffset = /^\d+$/.test(rawOffset) ? parseInt(rawOffset) : (() => {
      log.error(`Invalid MAE_SANDBOX_HOST_OFFSET "${rawOffset}", using default 81`);
      return 81;
    })();

    for (let i = 1; i <= poolSize; i++) {
      this.sandboxes.set(i, {
        id: i,
        vmid: 800 + i,
        ip: `${sandboxSubnet}.${sandboxHostOffset + i - 1}`,
        hostname: `mae-sandbox-${i}`,
        active: false,
      });
    }
  }

  /**
   * Assign a free sandbox to an agent. Activates RAM to 4GB.
   * Returns null if no sandboxes are available.
   */
  async assign(agentId: string): Promise<SandboxInfo | null> {
    // Find first unassigned sandbox
    for (const [, sb] of this.sandboxes) {
      if (!sb.assignedTo) {
        sb.assignedTo = agentId;
        sb.active = true;
        
        // Scale up RAM
        await this.setMemory(sb, 4096);
        
        log.info(`Assigned sandbox ${sb.id} (${sb.ip}) to ${agentId}`);
        return { ...sb };
      }
    }

    log.warn(`No free sandboxes available for ${agentId}`);
    return null;
  }

  /**
   * Release a sandbox back to the pool. Deactivates RAM to 512MB.
   */
  async release(agentId: string): Promise<void> {
    for (const [, sb] of this.sandboxes) {
      if (sb.assignedTo === agentId) {
        sb.assignedTo = undefined;
        sb.active = false;

        // Scale down RAM
        await this.setMemory(sb, 512);

        log.info(`Released sandbox ${sb.id} (${sb.ip}) from ${agentId}`);
        return;
      }
    }
  }

  /**
   * Get the sandbox assigned to an agent.
   */
  getAssigned(agentId: string): SandboxInfo | undefined {
    for (const [, sb] of this.sandboxes) {
      if (sb.assignedTo === agentId) return { ...sb };
    }
    return undefined;
  }

  /**
   * Get pool status.
   */
  status(): { total: number; available: number; active: number; sandboxes: SandboxInfo[] } {
    const all = Array.from(this.sandboxes.values());
    return {
      total: all.length,
      available: all.filter(s => !s.assignedTo).length,
      active: all.filter(s => s.active).length,
      sandboxes: all.map(s => ({ ...s })),
    };
  }

  private async setMemory(sb: SandboxInfo, memoryMb: number): Promise<void> {
    if (!this.pveToken) {
      log.info(`No PVE token -- skipping memory change for ${sb.hostname}`);
      return;
    }

    try {
      const node = process.env.PVE_NODE ?? "proxmox05";
      const res = await fetch(`${this.pveApi}/nodes/${node}/lxc/${sb.vmid}/config`, {
        method: "PUT",
        headers: {
          "Authorization": `PVEAPIToken=${this.pveToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `memory=${memoryMb}`,
      });
      if (!res.ok) {
        log.error(`Failed to set memory on ${sb.hostname}: ${res.status}`);
      }
    } catch (err) {
      log.error(`Error setting memory on ${sb.hostname}`, { error: String(err) });
    }
  }
}
