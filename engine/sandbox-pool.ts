/**
 * Sandbox Pool Manager
 * 
 * Manages pre-warmed LXC sandboxes for agent isolation.
 * Sandboxes run warm at 512MB RAM and scale to 4GB when assigned to an agent.
 */

import type { DelegateOptions } from "./types";

export interface SandboxInfo {
  id: number;       // 1-4
  vmid: number;     // 801-804
  ip: string;       // 10.71.20.81-84
  hostname: string; // mae-sandbox-1 through 4
  assignedTo?: string; // agent ID
  active: boolean;  // true = 4GB, false = 512MB
}

export class SandboxPool {
  private sandboxes: Map<number, SandboxInfo> = new Map();
  private pveApi: string;
  private pveToken: string;

  constructor(opts?: { pveApi?: string; pveToken?: string; poolSize?: number }) {
    this.pveApi = opts?.pveApi ?? process.env.PVE_API ?? "https://10.71.1.9:8006/api2/json";
    this.pveToken = opts?.pveToken ?? process.env.PVE_TOKEN ?? "";
    const poolSize = opts?.poolSize ?? 4;

    for (let i = 1; i <= poolSize; i++) {
      this.sandboxes.set(i, {
        id: i,
        vmid: 800 + i,
        ip: `10.71.20.${80 + i}`,
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
        
        console.log(`[sandbox-pool] Assigned sandbox ${sb.id} (${sb.ip}) to ${agentId}`);
        return { ...sb };
      }
    }

    console.warn(`[sandbox-pool] No free sandboxes available for ${agentId}`);
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

        console.log(`[sandbox-pool] Released sandbox ${sb.id} (${sb.ip}) from ${agentId}`);
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
      console.log(`[sandbox-pool] No PVE token -- skipping memory change for ${sb.hostname}`);
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
        console.error(`[sandbox-pool] Failed to set memory on ${sb.hostname}: ${res.status}`);
      }
    } catch (err) {
      console.error(`[sandbox-pool] Error setting memory on ${sb.hostname}:`, err);
    }
  }
}
