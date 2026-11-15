// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPS_CONFIG_PATH,
  OPS_START,
  ProductionError,
  __resetProductionLocksForTests,
  defaultRunner,
  getProductionStatus,
  instanceFor,
  mergeIntegration,
  previewMerge,
  readRunLog,
  startAction,
  type ProductionDeps,
} from "../production-ops.js";

/*
FNXC:ProductionOps 2026-11-15-12:00:
The Production panel merges integration into production only when it is safe, never twice, and never leaves a half-merged tree; privileged actions go through the single sudo launcher with an exact instance name.
Git runs for real in throwaway repositories; only sudo, systemctl and the root-owned files are faked.
*/

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  g(cwd, "add", file);
  g(cwd, "commit", "-q", "-m", message);
}

let repo: string;
const files = new Map<string, string>();
const dirs = new Map<string, string[]>();
const privileged: Array<{ file: string; args: string[] }> = [];

const deps: ProductionDeps = {
  run: async (file, args, options) => {
    if (file === "sudo" || file === "systemctl") {
      privileged.push({ file, args });
      return { stdout: "", stderr: "" };
    }
    return defaultRunner(file, args, options);
  },
  readText: async (path) => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  },
  listDir: async (path) => {
    const list = dirs.get(path);
    if (!list) throw new Error(`ENOENT ${path}`);
    return list;
  },
  resolvePath: async (path) => path,
};

function configure(project: Record<string, unknown>): void {
  files.set(OPS_CONFIG_PATH, JSON.stringify({ projects: { demo: { root: repo, productionBranch: "main", integrationBranch: "integration", ...project } } }));
}

beforeEach(() => {
  __resetProductionLocksForTests();
  files.clear();
  dirs.clear();
  privileged.length = 0;
  repo = mkdtempSync(join(tmpdir(), "fusion-production-ops-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.name", "Test");
  g(repo, "config", "user.email", "test@example.invalid");
  commit(repo, "app.py", "v1\n", "init");
  g(repo, "branch", "integration");
  g(repo, "checkout", "-q", "integration");
  commit(repo, "app.py", "v2\n", "VIDE-1: change app");
  commit(repo, "web.ts", "x\n", "VIDE-2: add web");
  g(repo, "checkout", "-q", "main");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("merge integration → production", () => {
  it("previews the commits and files that will be merged", async () => {
    const preview = await previewMerge(repo, "main", "integration", deps);
    expect(preview.blockedReason).toBeNull();
    expect(preview.commits.map((c) => c.subject)).toEqual(["VIDE-2: add web", "VIDE-1: change app"]);
    expect(preview.filesChanged.sort()).toEqual(["app.py", "web.ts"]);
  });

  it("refuses when the production branch is not checked out, when nothing is pending, on conflict, and on local edits of merged files", async () => {
    g(repo, "checkout", "-q", "integration");
    expect((await previewMerge(repo, "main", "integration", deps)).blockedReason).toMatch(/pas sur main/);
    g(repo, "checkout", "-q", "main");

    writeFileSync(join(repo, "app.py"), "local edit\n");
    expect((await previewMerge(repo, "main", "integration", deps)).blockedReason).toMatch(/app\.py/);
    g(repo, "checkout", "--", "app.py");

    // An unrelated local file does not block.
    writeFileSync(join(repo, "notes.txt"), "wip\n");
    expect((await previewMerge(repo, "main", "integration", deps)).blockedReason).toBeNull();

    commit(repo, "app.py", "main side\n", "hotfix on main");
    expect((await previewMerge(repo, "main", "integration", deps))).toMatchObject({ conflict: true, blockedReason: expect.stringMatching(/conflits/) });
  });

  it("merges once with a merge commit; a concurrent second click is refused", async () => {
    const results = await Promise.allSettled([
      mergeIntegration(repo, "main", "integration", deps),
      mergeIntegration(repo, "main", "integration", deps),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(ProductionError) });
    expect(g(repo, "log", "--merges", "--format=%s")).toMatch(/Fusion de integration dans main \(2 commits/);
    expect((await previewMerge(repo, "main", "integration", deps)).blockedReason).toMatch(/rien à fusionner/);
  });

  it("aborts a merge refused by the project's commit hook and leaves the tree clean", async () => {
    commit(repo, "other.md", "m\n", "main-only change");
    const hook = join(repo, ".git", "hooks", "commit-msg");
    writeFileSync(hook, "#!/bin/sh\necho 'garde: refus' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    await expect(mergeIntegration(repo, "main", "integration", deps)).rejects.toThrow(/fusion refusée et annulée/);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(g(repo, "log", "-1", "--format=%s")).toBe("main-only change");
  });
});

describe("production actions", () => {
  it("maps actions to the exact launcher instance and refuses what the config does not declare", () => {
    const web = { root: repo, productionBranch: "main", services: [{ id: "api", label: "API", unit: "demo-api" }] };
    const self = { root: repo, productionBranch: "production", kind: "fusion-self" as const };
    expect(instanceFor("demo", web, "deploy")).toBe("demo--deploy");
    expect(instanceFor("demo", web, "restart", "api")).toBe("demo--restart--api");
    expect(instanceFor("fusion", self, "update")).toBe("fusion--update");
    expect(instanceFor("fusion", self, "restart")).toBe("fusion--restart");
    expect(() => instanceFor("demo", web, "restart", "db")).toThrow(ProductionError);
    expect(() => instanceFor("demo", web, "update")).toThrow(ProductionError);
    expect(() => instanceFor("fusion", self, "deploy")).toThrow(ProductionError);
  });

  it("starts an action only through the sudo launcher, and refuses while another run is in progress", async () => {
    configure({ services: [{ id: "api", label: "API", unit: "demo-api" }] });
    await expect(startAction(repo, "restart", "api", deps)).resolves.toEqual({ instance: "demo--restart--api" });
    expect(privileged).toEqual([{ file: "sudo", args: ["-n", OPS_START, "demo--restart--api"] }]);

    dirs.set("/var/lib/fusion-ops/runs", ["demo--deploy.json"]);
    files.set("/var/lib/fusion-ops/runs/demo--deploy.json", JSON.stringify({ instance: "demo--deploy", status: "running", step: "build servi", startedAt: "2026-11-15T12:00:00Z", finishedAt: null, error: null, result: null }));
    await expect(startAction(repo, "deploy", undefined, deps)).rejects.toThrow(/action en cours : demo--deploy/);
    expect(privileged).toHaveLength(1);
  });

  it("refuses actions for a project without production config", async () => {
    await expect(startAction(repo, "deploy", undefined, deps)).rejects.toMatchObject({ status: 404 });
    expect(privileged).toHaveLength(0);
  });

  it("only serves logs of the current project's runs", async () => {
    files.set("/var/log/fusion-ops/demo--deploy.log", "== build\nok\n");
    await expect(readRunLog("demo", "demo--deploy", deps)).resolves.toContain("ok");
    await expect(readRunLog("demo", "other--deploy", deps)).rejects.toMatchObject({ status: 404 });
    await expect(readRunLog("demo", "../../etc/passwd", deps)).rejects.toMatchObject({ status: 404 });
  });

  it("reports services, deployed revision and pending commits in the status", async () => {
    configure({ services: [{ id: "api", label: "API", unit: "demo-api" }] });
    const deployed = g(repo, "rev-parse", "HEAD");
    files.set("/var/lib/fusion-ops/deployed-demo.json", JSON.stringify({ sha: deployed }));
    await mergeIntegration(repo, "main", "integration", deps);
    const status = await getProductionStatus(repo, "integration", deps);
    expect(status.ops).toMatchObject({ id: "demo", kind: "web", services: [{ id: "api", active: true }] });
    expect(status.deploy).toMatchObject({ deployedSha: deployed, pendingCommits: 3 });
    expect(privileged).toContainEqual({ file: "systemctl", args: ["is-active", "--quiet", "demo-api"] });
  });
});

vi.setConfig({ testTimeout: 20_000 });
