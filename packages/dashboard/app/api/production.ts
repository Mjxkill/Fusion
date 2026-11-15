/**
 * FNXC:ProductionOps 2026-11-15-12:00:
 * Client for the per-project Production panel. Types mirror packages/dashboard/src/production-ops.ts.
 */
import { api } from "./client/client.js";
import { withProjectId } from "./client/health.js";

export interface ProductionRun {
  instance: string;
  status: "running" | "success" | "failed";
  step: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: unknown;
}

export interface ProductionStatus {
  ops: null | {
    id: string;
    label: string;
    kind: "web" | "fusion-self";
    services: Array<{ id: string; label: string; unit: string; active: boolean }>;
  };
  merge: {
    productionBranch: string;
    integrationBranch: string;
    currentBranch: string;
    commits: Array<{ sha: string; subject: string }>;
    filesChanged: string[];
    productionOnlyCommits: number;
    conflict: boolean;
    localChanges: string[];
    localChangesTouched: string[];
    blockedReason: string | null;
  };
  deploy: null | { deployedSha: string | null; head: string; pendingCommits: number | null };
  runs: ProductionRun[];
}

export function fetchProductionStatus(projectId?: string): Promise<ProductionStatus> {
  return api<ProductionStatus>(withProjectId("/production/status", projectId));
}

export function mergeIntegrationToProduction(projectId?: string): Promise<{ head: string; merged: number }> {
  return api<{ head: string; merged: number }>(withProjectId("/production/merge", projectId), { method: "POST", body: JSON.stringify({}) });
}

export function startProductionAction(action: "deploy" | "restart" | "update", service?: string, projectId?: string): Promise<{ instance: string }> {
  return api<{ instance: string }>(withProjectId("/production/actions", projectId), { method: "POST", body: JSON.stringify({ action, ...(service ? { service } : {}) }) });
}

export async function fetchProductionRunLog(instance: string, projectId?: string): Promise<string> {
  return (await api<{ log: string }>(withProjectId(`/production/runs/${encodeURIComponent(instance)}/log`, projectId))).log;
}
