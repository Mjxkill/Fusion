/**
 * FNXC:ProductionOps 2026-11-15-12:00:
 * Operator requirement: one "Production" panel per project with buttons to merge integration → main, deploy, restart services, and update/restart Fusion itself, for any web project (not only videasy).
 * Privileged work never runs in Fusion's process (user michael): Fusion calls `sudo -n /opt/fusion/ops/fusion-ops-start <instance>`, the ONLY sudo command granted for this, which starts the root unit `fusion-ops@<instance>.service`.
 * What may run is defined in the root-owned `/etc/fusion/ops.json` (services, builds, health checks per project root); Fusion can read it but never write it, so an agent cannot grant itself root actions. A project absent from it gets the merge button only.
 * Merging integration → production runs here as michael (the project tree is ACL-shared), with the project's own commit hooks, and only when: the production branch is checked out, nothing conflicts, and no uncommitted local change touches a merged file. A failed merge is aborted so the tree is never left mid-merge.
 * Double clicks and concurrent requests are refused per project (409) instead of running twice.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const OPS_CONFIG_PATH = "/etc/fusion/ops.json";
export const OPS_STATE_DIR = "/var/lib/fusion-ops";
export const OPS_LOG_DIR = "/var/log/fusion-ops";
export const OPS_START = "/opt/fusion/ops/fusion-ops-start";
const INSTANCE_RE = /^([a-z0-9]+)--(deploy|update|restart)(?:--([a-z0-9]+))?$/;
const LOG_TAIL_BYTES = 64 * 1024;

export interface OpsService { id: string; label: string; unit: string; paths?: string[] }
export interface OpsProject {
  label?: string;
  kind?: "fusion-self";
  root: string;
  productionBranch: string;
  integrationBranch?: string;
  services?: OpsService[];
}
export interface OpsRun {
  instance: string;
  status: "running" | "success" | "failed";
  step: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: unknown;
}

export type ProductionAction = "deploy" | "restart" | "update";

/** Command runner seam (tests inject a fake). Arguments are always passed as an array, never through a shell. */
export type Runner = (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: Runner = async (file, args, options) => {
  const result = await execFileAsync(file, args, { cwd: options?.cwd, timeout: options?.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export interface ProductionDeps {
  run: Runner;
  readText: (path: string) => Promise<string>;
  listDir: (path: string) => Promise<string[]>;
  resolvePath: (path: string) => Promise<string>;
}

export const defaultDeps: ProductionDeps = {
  run: defaultRunner,
  readText: (path) => readFile(path, "utf8"),
  listDir: (path) => readdir(path),
  resolvePath: (path) => realpath(path),
};

export class ProductionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 409) {
    super(message);
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

export async function findOpsProject(rootDir: string, deps: ProductionDeps): Promise<{ id: string; project: OpsProject } | null> {
  let raw: string;
  try {
    raw = await deps.readText(OPS_CONFIG_PATH);
  } catch {
    return null;
  }
  const config = JSON.parse(raw) as { projects?: Record<string, OpsProject> };
  const wanted = await deps.resolvePath(rootDir).catch(() => rootDir);
  for (const [id, project] of Object.entries(config.projects ?? {})) {
    const root = await deps.resolvePath(project.root).catch(() => project.root);
    if (root === wanted) return { id, project };
  }
  return null;
}

// ── Git state ───────────────────────────────────────────────────────────────

async function git(deps: ProductionDeps, rootDir: string, args: string[], timeout?: number): Promise<string> {
  return (await deps.run("git", ["-C", rootDir, ...args], { timeout })).stdout.trim();
}

async function gitOk(deps: ProductionDeps, rootDir: string, args: string[]): Promise<boolean> {
  try {
    await deps.run("git", ["-C", rootDir, ...args]);
    return true;
  } catch {
    return false;
  }
}

export interface MergePreview {
  productionBranch: string;
  integrationBranch: string;
  currentBranch: string;
  commits: Array<{ sha: string; subject: string }>;
  filesChanged: string[];
  /** Commits on production that integration does not have (a merge commit will be created). */
  productionOnlyCommits: number;
  conflict: boolean;
  localChanges: string[];
  localChangesTouched: string[];
  /** Why the merge button is disabled, or null when the merge can run. */
  blockedReason: string | null;
}

export async function previewMerge(rootDir: string, productionBranch: string, integrationBranch: string, deps: ProductionDeps): Promise<MergePreview> {
  const currentBranch = await git(deps, rootDir, ["symbolic-ref", "--short", "HEAD"]).catch(() => "");
  const integrationExists = await gitOk(deps, rootDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${integrationBranch}`]);
  const base: MergePreview = {
    productionBranch, integrationBranch, currentBranch, commits: [], filesChanged: [], productionOnlyCommits: 0,
    conflict: false, localChanges: [], localChangesTouched: [], blockedReason: null,
  };
  if (!integrationExists) return { ...base, blockedReason: `la branche ${integrationBranch} n'existe pas` };
  const log = await git(deps, rootDir, ["log", "--format=%H%x09%s", `${productionBranch}..${integrationBranch}`]);
  const commits = log ? log.split("\n").map((line) => {
    const [sha, ...subject] = line.split("\t");
    return { sha: sha!, subject: subject.join("\t") };
  }) : [];
  const filesRaw = commits.length ? await git(deps, rootDir, ["diff", "--name-only", `${productionBranch}...${integrationBranch}`]) : "";
  const filesChanged = filesRaw ? filesRaw.split("\n") : [];
  const productionOnlyCommits = Number(await git(deps, rootDir, ["rev-list", "--count", `${integrationBranch}..${productionBranch}`]) || 0);
  const conflict = commits.length > 0 && !(await gitOk(deps, rootDir, ["merge-tree", "--write-tree", productionBranch, integrationBranch]));
  // Porcelain lines are "XY path": the leading status column may be a space, so the output must not be trimmed before slicing.
  const status = (await deps.run("git", ["-C", rootDir, "status", "--porcelain"])).stdout;
  const localChanges = status.split("\n").filter((line) => line.length > 3).map((line) => {
    const path = line.slice(3);
    const renamed = path.split(" -> ");
    return renamed[renamed.length - 1]!.replace(/^"|"$/g, "");
  });
  const touched = new Set(filesChanged);
  const localChangesTouched = localChanges.filter((file) => touched.has(file));
  let blockedReason: string | null = null;
  if (currentBranch !== productionBranch) blockedReason = `le dépôt est sur ${currentBranch || "(HEAD détaché)"}, pas sur ${productionBranch}`;
  else if (commits.length === 0) blockedReason = `rien à fusionner : ${integrationBranch} n'a aucun commit absent de ${productionBranch}`;
  else if (conflict) blockedReason = "la fusion produirait des conflits : à résoudre à la main";
  else if (localChangesTouched.length > 0) blockedReason = `modifications locales non commitées sur des fichiers fusionnés : ${localChangesTouched.join(", ")}`;
  return { ...base, commits, filesChanged, productionOnlyCommits, conflict, localChanges, localChangesTouched, blockedReason };
}

const mergingRoots = new Set<string>();

/** Merges integration into production after re-checking every precondition; aborts the merge on any failure. */
export async function mergeIntegration(rootDir: string, productionBranch: string, integrationBranch: string, deps: ProductionDeps): Promise<{ head: string; merged: number }> {
  if (mergingRoots.has(rootDir)) throw new ProductionError("une fusion est déjà en cours pour ce projet");
  mergingRoots.add(rootDir);
  try {
    const preview = await previewMerge(rootDir, productionBranch, integrationBranch, deps);
    if (preview.blockedReason) throw new ProductionError(preview.blockedReason);
    try {
      await deps.run("git", ["-C", rootDir, "merge", "--no-ff", "--no-edit", "-m", `Fusion de ${integrationBranch} dans ${productionBranch} (${preview.commits.length} commits, bouton Production de Fusion)`, integrationBranch], { timeout: 10 * 60_000 });
    } catch (error) {
      await deps.run("git", ["-C", rootDir, "merge", "--abort"]).catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      throw new ProductionError(`fusion refusée et annulée : ${detail.slice(0, 2000)}`);
    }
    return { head: await git(deps, rootDir, ["rev-parse", "HEAD"]), merged: preview.commits.length };
  } finally {
    mergingRoots.delete(rootDir);
  }
}

// ── Ops runs ────────────────────────────────────────────────────────────────

export async function readRuns(projectId: string, deps: ProductionDeps): Promise<OpsRun[]> {
  let names: string[] = [];
  try {
    names = await deps.listDir(join(OPS_STATE_DIR, "runs"));
  } catch {
    return [];
  }
  const runs: OpsRun[] = [];
  for (const name of names) {
    if (!name.startsWith(`${projectId}--`) || !name.endsWith(".json")) continue;
    try {
      runs.push(JSON.parse(await deps.readText(join(OPS_STATE_DIR, "runs", name))) as OpsRun);
    } catch {
      // A run file being rewritten is skipped this poll.
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function readDeployedSha(projectId: string, deps: ProductionDeps): Promise<string | null> {
  try {
    return (JSON.parse(await deps.readText(join(OPS_STATE_DIR, `deployed-${projectId}.json`))) as { sha?: string }).sha ?? null;
  } catch {
    return null;
  }
}

export function instanceFor(projectId: string, project: OpsProject, action: ProductionAction, serviceId?: string): string {
  const self = project.kind === "fusion-self";
  if (action === "deploy" && !self && !serviceId) return `${projectId}--deploy`;
  if (action === "update" && self && !serviceId) return `${projectId}--update`;
  if (action === "restart" && self && !serviceId) return `${projectId}--restart`;
  if (action === "restart" && !self && serviceId && project.services?.some((service) => service.id === serviceId)) return `${projectId}--restart--${serviceId}`;
  throw new ProductionError("action non prévue pour ce projet", 400);
}

const startingProjects = new Set<string>();

export async function startAction(rootDir: string, action: ProductionAction, serviceId: string | undefined, deps: ProductionDeps): Promise<{ instance: string }> {
  const found = await findOpsProject(rootDir, deps);
  if (!found) throw new ProductionError("aucune action de production configurée pour ce projet (/etc/fusion/ops.json)", 404);
  const instance = instanceFor(found.id, found.project, action, serviceId);
  if (startingProjects.has(found.id)) throw new ProductionError("une action est déjà en cours de lancement");
  startingProjects.add(found.id);
  try {
    const running = (await readRuns(found.id, deps)).find((run) => run.status === "running");
    if (running) throw new ProductionError(`action en cours : ${running.instance} (${running.step})`);
    try {
      await deps.run("sudo", ["-n", OPS_START, instance], { timeout: 30_000 });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new ProductionError(stderr || (error instanceof Error ? error.message : String(error)));
    }
    return { instance };
  } finally {
    startingProjects.delete(found.id);
  }
}

export async function readRunLog(projectId: string, instance: string, deps: ProductionDeps): Promise<string> {
  const match = INSTANCE_RE.exec(instance);
  if (!match || match[1] !== projectId) throw new ProductionError("journal inconnu", 404);
  try {
    const text = await deps.readText(join(OPS_LOG_DIR, `${instance}.log`));
    return text.length > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text;
  } catch {
    return "";
  }
}

export interface ProductionStatus {
  ops: null | {
    id: string;
    label: string;
    kind: "web" | "fusion-self";
    services: Array<{ id: string; label: string; unit: string; active: boolean }>;
  };
  merge: MergePreview;
  deploy: null | { deployedSha: string | null; head: string; pendingCommits: number | null };
  runs: OpsRun[];
}

export async function getProductionStatus(rootDir: string, integrationBranchSetting: string | undefined, deps: ProductionDeps): Promise<ProductionStatus> {
  const found = await findOpsProject(rootDir, deps);
  const currentBranch = await git(deps, rootDir, ["symbolic-ref", "--short", "HEAD"]).catch(() => "main");
  const productionBranch = found?.project.productionBranch ?? currentBranch;
  const integrationBranch = found?.project.integrationBranch ?? integrationBranchSetting ?? "integration";
  const merge = await previewMerge(rootDir, productionBranch, integrationBranch, deps);
  if (!found) return { ops: null, merge, deploy: null, runs: [] };
  const services = await Promise.all((found.project.services ?? []).map(async (service) => ({
    id: service.id,
    label: service.label,
    unit: service.unit,
    active: await deps.run("systemctl", ["is-active", "--quiet", service.unit]).then(() => true, () => false),
  })));
  const head = await git(deps, rootDir, ["rev-parse", productionBranch]).catch(() => "");
  const deployedSha = found.project.kind === "fusion-self" ? null : await readDeployedSha(found.id, deps);
  let pendingCommits: number | null = null;
  if (deployedSha && head) {
    pendingCommits = Number(await git(deps, rootDir, ["rev-list", "--count", `${deployedSha}..${head}`]).catch(() => "")) || 0;
  }
  return {
    ops: { id: found.id, label: found.project.label ?? found.id, kind: found.project.kind === "fusion-self" ? "fusion-self" : "web", services },
    merge,
    deploy: found.project.kind === "fusion-self" ? null : { deployedSha, head, pendingCommits },
    runs: await readRuns(found.id, deps),
  };
}

/** @internal test reset */
export function __resetProductionLocksForTests(): void {
  mergingRoots.clear();
  startingProjects.clear();
}
