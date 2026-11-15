/**
 * FNXC:ProjectAnalysis 2026-11-15-10:14:
 * Operators need to bring an existing project under Fusion's mission tracking without re-planning it by hand.
 * "Analyze project" (Missions view) runs a read-only agent over the repository (docs, code, tests, board tasks) that detects the project's goals, missions, milestones, slices and features, with a detected status and evidence per feature.
 * The operator reviews and edits the proposal, then applies it: goals and missions are created (autopilot stays off, nothing starts), features get their detected status.
 * Re-analysis is part of v1: the agent receives the existing goals and mission hierarchy with their ids and must reuse them, so applying again updates statuses/evidence and adds what is new instead of duplicating.
 * Default model requested by the operator: ollama-cloud / deepseek-v4.1-flash (chosen in the dialog; the server falls back to the planning model when none is sent).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createResolvedAgentSession, promptWithFallback as enginePromptWithFallback } from "@fusion/engine";
import type { TaskStore } from "@fusion/core";
import { createPlanningBoardTools } from "./planning-board-tools.js";
import { extractJsonCandidate, repairJson } from "./mission-interview.js";

// ── Plan shape (agent output, review payload) ────────────────────────────────

/** Detected implementation state of a feature. `todo` maps to the mission feature status `defined`. */
export type AnalysisFeatureStatus = "done" | "in-progress" | "todo" | "blocked";
export const ANALYSIS_FEATURE_STATUSES: readonly AnalysisFeatureStatus[] = ["done", "in-progress", "todo", "blocked"];

export interface AnalysisFeature {
  existingFeatureId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status: AnalysisFeatureStatus;
  /** Files, tests or tasks that justify the status. */
  evidence?: string;
  /** Review checkbox; false entries are ignored on apply. */
  selected?: boolean;
}

export interface AnalysisSlice {
  existingSliceId?: string;
  title: string;
  description?: string;
  verification?: string;
  features: AnalysisFeature[];
  selected?: boolean;
}

export interface AnalysisMilestone {
  existingMilestoneId?: string;
  title: string;
  description?: string;
  verification?: string;
  slices: AnalysisSlice[];
  selected?: boolean;
}

export interface AnalysisMission {
  existingMissionId?: string;
  title: string;
  description?: string;
  /** `ref` values of the goals this mission serves. */
  goalRefs?: string[];
  milestones: AnalysisMilestone[];
  selected?: boolean;
}

export interface AnalysisGoal {
  ref: string;
  existingGoalId?: string;
  title: string;
  description?: string;
  selected?: boolean;
}

export interface ProjectAnalysisPlan {
  summary?: string;
  goals: AnalysisGoal[];
  missions: AnalysisMission[];
}

export interface ProjectAnalysisApplyReport {
  goalsCreated: number;
  goalsLinked: number;
  goalsSkipped: Array<{ title: string; reason: string }>;
  missionsCreated: number;
  milestonesCreated: number;
  slicesCreated: number;
  featuresCreated: number;
  featuresUpdated: number;
  /** Features linked to a task keep the status driven by that task. */
  featureStatusKeptForLinkedTask: number;
}

export type ProjectAnalysisStatus = "running" | "complete" | "applying" | "error" | "applied" | "cancelled";

export interface ProjectAnalysisJob {
  id: string;
  status: ProjectAnalysisStatus;
  startedAt: string;
  finishedAt?: string;
  modelProvider?: string;
  modelId?: string;
  /** Tail of the agent's streamed text, for the progress view. */
  progress: string;
  plan?: ProjectAnalysisPlan;
  error?: string;
  applyReport?: ProjectAnalysisApplyReport;
}

// ── Store seams (structural, so tests can pass in-memory fakes) ──────────────

interface GoalLike { id: string; title: string; description?: string; status: string }
interface FeatureLike { id: string; title: string; description?: string; acceptanceCriteria?: string; status: string; taskId?: string }
interface SliceLike { id: string; title: string; features: FeatureLike[] }
interface MilestoneLike { id: string; title: string; slices: SliceLike[] }
interface MissionHierarchyLike { id: string; title: string; description?: string; status?: string; milestones: MilestoneLike[] }

export interface AnalysisMissionStore {
  listMissions(): Promise<Array<{ id: string }>> | Array<{ id: string }>;
  getMissionWithHierarchy(id: string): Promise<MissionHierarchyLike | undefined> | MissionHierarchyLike | undefined;
  createMission(input: { title: string; description?: string }): Promise<{ id: string }> | { id: string };
  addMilestone(missionId: string, input: { title: string; description?: string; verification?: string }): Promise<{ id: string }> | { id: string };
  addSlice(milestoneId: string, input: { title: string; description?: string; verification?: string }): Promise<{ id: string }> | { id: string };
  addFeature(sliceId: string, input: { title: string; description?: string; acceptanceCriteria?: string }): Promise<{ id: string }> | { id: string };
  updateFeature(id: string, updates: Record<string, unknown>, options?: { actor?: string; reason?: string }): Promise<unknown> | unknown;
  addContractAssertion(milestoneId: string, input: { title: string; assertion: string; status: "pending" }): Promise<unknown> | unknown;
  applyDerivedMilestoneAcceptanceCriteria(milestoneId: string): Promise<unknown> | unknown;
  linkGoal(missionId: string, goalId: string): Promise<unknown> | unknown;
  listGoalIdsForMission(missionId: string): Promise<string[]> | string[];
}

export interface AnalysisGoalStore {
  listGoals(filter?: { status?: "active" | "archived" }): Promise<GoalLike[]> | GoalLike[];
  createGoal(input: { title: string; description?: string }): Promise<GoalLike> | GoalLike;
}

// ── Existing state given to the agent ────────────────────────────────────────

export interface ExistingProjectState {
  goals: Array<{ id: string; title: string; description?: string; status: string }>;
  activeGoalLimit: number;
  missions: Array<{
    id: string;
    title: string;
    description?: string;
    milestones: Array<{ id: string; title: string; slices: Array<{ id: string; title: string; features: Array<{ id: string; title: string; status: string; taskId?: string }> }> }>;
  }>;
}

export async function readExistingProjectState(missionStore: AnalysisMissionStore, goalStore: AnalysisGoalStore, activeGoalLimit: number): Promise<ExistingProjectState> {
  const goals = await goalStore.listGoals();
  const missions: ExistingProjectState["missions"] = [];
  for (const { id } of await missionStore.listMissions()) {
    const mission = await missionStore.getMissionWithHierarchy(id);
    if (!mission) continue;
    missions.push({
      id: mission.id,
      title: mission.title,
      description: mission.description,
      milestones: mission.milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        slices: milestone.slices.map((slice) => ({
          id: slice.id,
          title: slice.title,
          features: slice.features.map((feature) => ({ id: feature.id, title: feature.title, status: feature.status, ...(feature.taskId ? { taskId: feature.taskId } : {}) })),
        })),
      })),
    });
  }
  return { goals: goals.map((goal) => ({ id: goal.id, title: goal.title, description: goal.description, status: goal.status })), activeGoalLimit, missions };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export const PROJECT_ANALYSIS_SYSTEM_PROMPT = `You analyze an EXISTING software project to build its delivery map in Fusion.

Fusion tracks work as: Goal (why) → Mission → Milestone → Slice → Feature. A feature is one concrete user-visible or technical capability, small enough to become one task.

Your job:
1. Explore the repository read-only: README and docs (plans, architecture, decision and status documents), source layout, routes/pages/APIs, tests, migrations, and the Fusion board (fn_task_list / fn_task_show) for work already done or in flight.
2. Detect the project's goals and its functional scope, and organise it into missions → milestones → slices → features.
3. For EVERY feature, decide its implementation status from evidence in the code, never from plans alone:
   - "done": implemented and wired (code path exists; tests or usage confirm it),
   - "in-progress": partially implemented, stubbed, behind a TODO, or not wired end to end,
   - "todo": planned in the docs but absent from the code,
   - "blocked": the docs or code state an explicit blocker (missing credential, hardware, decision).
   Give short evidence: file paths (with symbol or line when useful), test files, task ids, doc sections.
4. Write acceptance criteria per feature and verification per milestone/slice.

Re-analysis rule: the user message lists the goals and missions that ALREADY exist, with their ids. Reuse them: put the id in existingGoalId / existingMissionId / existingMilestoneId / existingSliceId / existingFeatureId whenever an entry is the same thing (even if you would word it differently). Only omit the id for genuinely new entries. Never invent ids.
Goals: at most the active goal limit given in the user message, counting existing active goals you reuse.

Write titles, descriptions, criteria and evidence in the language of the project's documentation.
Granularity: prefer 3–8 missions for a large project, 2–5 milestones each, 1–4 slices per milestone, 2–8 features per slice. Group by functional domain, not by file.

Respond with ONLY one JSON object, no prose, in this shape:
{"summary": "2-4 sentences on what the project is and its overall progress",
 "goals": [{"ref": "g1", "existingGoalId": "optional", "title": "...", "description": "..."}],
 "missions": [{"existingMissionId": "optional", "title": "...", "description": "...", "goalRefs": ["g1"],
   "milestones": [{"existingMilestoneId": "optional", "title": "...", "description": "...", "verification": "...",
     "slices": [{"existingSliceId": "optional", "title": "...", "description": "...", "verification": "...",
       "features": [{"existingFeatureId": "optional", "title": "...", "description": "...", "acceptanceCriteria": "...", "status": "done|in-progress|todo|blocked", "evidence": "..."}]}]}]}]}`;

export function buildProjectAnalysisUserMessage(existing: ExistingProjectState): string {
  const activeGoals = existing.goals.filter((goal) => goal.status === "active").length;
  return [
    "Analyze this project (your working directory is the repository root) and return the JSON delivery map.",
    `Active goal limit: ${existing.activeGoalLimit} (currently ${activeGoals} active).`,
    existing.goals.length === 0 && existing.missions.length === 0
      ? "Nothing exists yet in Fusion for this project: this is a first analysis."
      : "Existing Fusion state to reuse (re-analysis):",
    existing.goals.length > 0 || existing.missions.length > 0 ? JSON.stringify({ goals: existing.goals, missions: existing.missions }) : "",
  ].filter(Boolean).join("\n\n");
}

// ── Plan parsing / normalisation ─────────────────────────────────────────────

function str(value: unknown, max = 4000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normaliseStatus(value: unknown): AnalysisFeatureStatus {
  if (value === "done" || value === "in-progress" || value === "blocked" || value === "todo") return value;
  if (value === "defined" || value === "triaged") return "todo";
  return "todo";
}

/** Coerces untrusted agent JSON (or an edited review payload) into a well-formed plan; entries without a title are dropped. */
export function normaliseProjectAnalysisPlan(raw: unknown): ProjectAnalysisPlan {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const goals: AnalysisGoal[] = [];
  arr(source.goals).forEach((entry, index) => {
    const goal = (entry ?? {}) as Record<string, unknown>;
    const title = str(goal.title, 200);
    if (!title) return;
    goals.push({ ref: str(goal.ref, 50) ?? `g${index + 1}`, existingGoalId: str(goal.existingGoalId, 100), title, description: str(goal.description), selected: goal.selected !== false });
  });
  const missions: AnalysisMission[] = [];
  for (const entry of arr(source.missions)) {
    const mission = (entry ?? {}) as Record<string, unknown>;
    const title = str(mission.title, 200);
    if (!title) continue;
    const milestones: AnalysisMilestone[] = [];
    for (const milestoneEntry of arr(mission.milestones)) {
      const milestone = (milestoneEntry ?? {}) as Record<string, unknown>;
      const milestoneTitle = str(milestone.title, 200);
      if (!milestoneTitle) continue;
      const slices: AnalysisSlice[] = [];
      for (const sliceEntry of arr(milestone.slices)) {
        const slice = (sliceEntry ?? {}) as Record<string, unknown>;
        const sliceTitle = str(slice.title, 200);
        if (!sliceTitle) continue;
        const features: AnalysisFeature[] = [];
        for (const featureEntry of arr(slice.features)) {
          const feature = (featureEntry ?? {}) as Record<string, unknown>;
          const featureTitle = str(feature.title, 200);
          if (!featureTitle) continue;
          features.push({
            existingFeatureId: str(feature.existingFeatureId, 100),
            title: featureTitle,
            description: str(feature.description),
            acceptanceCriteria: str(feature.acceptanceCriteria),
            status: normaliseStatus(feature.status),
            evidence: str(feature.evidence, 2000),
            selected: feature.selected !== false,
          });
        }
        slices.push({ existingSliceId: str(slice.existingSliceId, 100), title: sliceTitle, description: str(slice.description), verification: str(slice.verification), features, selected: slice.selected !== false });
      }
      milestones.push({ existingMilestoneId: str(milestone.existingMilestoneId, 100), title: milestoneTitle, description: str(milestone.description), verification: str(milestone.verification), slices, selected: milestone.selected !== false });
    }
    missions.push({
      existingMissionId: str(mission.existingMissionId, 100),
      title,
      description: str(mission.description),
      goalRefs: arr(mission.goalRefs).map((ref) => str(ref, 50)).filter((ref): ref is string => Boolean(ref)),
      milestones,
      selected: mission.selected !== false,
    });
  }
  return { summary: str(source.summary), goals, missions };
}

/**
 * FNXC:ProjectAnalysis 2026-11-15-11:40:
 * First real run (videasy, deepseek-v4.1-flash) failed with "no mission" although the streamed tail was a mission JSON.
 * The generic extractor keeps the LARGEST VALID object, so one syntax slip in a long plan (or a plan split across messages) let a single nested feature win.
 * Parse the whole span first (first "{" to last "}", then with repairJson), fall back to the extractor, and report the real JSON error instead of "no mission".
 */
export function parseProjectAnalysisResponse(text: string): ProjectAnalysisPlan {
  const attempts: string[] = [];
  const fromPlan = (raw: unknown): ProjectAnalysisPlan | null => {
    const plan = normaliseProjectAnalysisPlan(raw);
    return plan.missions.length > 0 ? plan : null;
  };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const span = text.slice(start, end + 1);
    for (const candidate of [span, repairJson(span)]) {
      try {
        const plan = fromPlan(JSON.parse(candidate));
        if (plan) return plan;
        attempts.push("whole response parsed but contains no mission");
      } catch (error) {
        attempts.push(`whole response is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  const extracted = extractJsonCandidate(text);
  if (extracted) {
    try {
      const plan = fromPlan(JSON.parse(extracted));
      if (plan) return plan;
      attempts.push("largest valid JSON fragment contains no mission");
    } catch (error) {
      attempts.push(`extracted fragment invalid (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  throw new Error(`The analysis returned no usable plan: ${attempts.join("; ") || "no JSON object in the response"}`);
}

function tryParsePlan(text: string): { ok: true } | { ok: false; error: string } {
  try {
    parseProjectAnalysisResponse(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Raw agent output of the last failed parse, kept for diagnosis (never shown in the UI). */
async function saveRawResponse(rootDir: string, text: string): Promise<void> {
  try {
    await mkdir(join(rootDir, ".fusion", "project-analysis"), { recursive: true });
    await writeFile(join(rootDir, ".fusion", "project-analysis", "last-failed-response.txt"), text, "utf8");
  } catch {
    // Diagnosis aid only.
  }
}

// ── Apply ────────────────────────────────────────────────────────────────────

/** Marker separating the operator-facing description from the latest analysis evidence; re-analysis replaces everything after it. */
export const ANALYSIS_EVIDENCE_MARKER = "\n\n---\nAnalyse du projet";

const EVIDENCE_BLOCK_START = /(^|\n)---\nAnalyse du projet/;

export function composeFeatureDescription(base: string | undefined, evidence: string | undefined, date: string): string | undefined {
  const text = base ?? "";
  const blockAt = text.search(EVIDENCE_BLOCK_START);
  const cleanBase = (blockAt >= 0 ? text.slice(0, blockAt) : text).trim();
  if (!evidence) return cleanBase || undefined;
  const block = `---\nAnalyse du projet (${date}) : ${evidence}`;
  return cleanBase ? `${cleanBase}\n\n${block}` : block;
}

function toMissionFeatureStatus(status: AnalysisFeatureStatus): string {
  return status === "todo" ? "defined" : status;
}

function isActiveGoalLimitError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ACTIVE_GOAL_LIMIT_EXCEEDED");
}

/**
 * Applies a reviewed plan. Existing missions/milestones/slices keep their operator-authored text; only new children are added under them.
 * Existing features get the detected status (unless a task drives them) and refreshed evidence; ids that no longer exist are treated as new entries.
 */
export async function applyProjectAnalysisPlan(
  plan: ProjectAnalysisPlan,
  stores: { missionStore: AnalysisMissionStore; goalStore: AnalysisGoalStore },
  now: Date = new Date(),
): Promise<ProjectAnalysisApplyReport> {
  const { missionStore, goalStore } = stores;
  const date = now.toISOString().slice(0, 10);
  const report: ProjectAnalysisApplyReport = { goalsCreated: 0, goalsLinked: 0, goalsSkipped: [], missionsCreated: 0, milestonesCreated: 0, slicesCreated: 0, featuresCreated: 0, featuresUpdated: 0, featureStatusKeptForLinkedTask: 0 };

  const existingGoals = new Map((await goalStore.listGoals()).map((goal) => [goal.id, goal]));
  const goalIdByRef = new Map<string, string>();
  for (const goal of plan.goals) {
    if (goal.selected === false) continue;
    if (goal.existingGoalId && existingGoals.has(goal.existingGoalId)) {
      goalIdByRef.set(goal.ref, goal.existingGoalId);
      continue;
    }
    try {
      const created = await goalStore.createGoal({ title: goal.title, ...(goal.description ? { description: goal.description } : {}) });
      goalIdByRef.set(goal.ref, created.id);
      report.goalsCreated += 1;
    } catch (error) {
      report.goalsSkipped.push({ title: goal.title, reason: isActiveGoalLimitError(error) ? "active-goal-limit" : (error instanceof Error ? error.message : String(error)) });
    }
  }

  for (const mission of plan.missions) {
    if (mission.selected === false) continue;
    const existingMission = mission.existingMissionId ? await missionStore.getMissionWithHierarchy(mission.existingMissionId) : undefined;
    let missionId: string;
    if (existingMission) {
      missionId = existingMission.id;
    } else {
      missionId = (await missionStore.createMission({ title: mission.title, ...(mission.description ? { description: mission.description } : {}) })).id;
      report.missionsCreated += 1;
    }
    const linkedGoalIds = new Set(await missionStore.listGoalIdsForMission(missionId));
    for (const ref of mission.goalRefs ?? []) {
      const goalId = goalIdByRef.get(ref);
      if (!goalId || linkedGoalIds.has(goalId)) continue;
      await missionStore.linkGoal(missionId, goalId);
      linkedGoalIds.add(goalId);
      report.goalsLinked += 1;
    }

    for (const milestone of mission.milestones) {
      if (milestone.selected === false) continue;
      const existingMilestone = existingMission?.milestones.find((item) => item.id === milestone.existingMilestoneId);
      let milestoneId: string;
      const createdMilestone = !existingMilestone;
      if (existingMilestone) {
        milestoneId = existingMilestone.id;
      } else {
        milestoneId = (await missionStore.addMilestone(missionId, { title: milestone.title, description: milestone.description, verification: milestone.verification })).id;
        await missionStore.addContractAssertion(milestoneId, { title: `Milestone: ${milestone.title}`, assertion: milestone.verification || milestone.description || `Verify milestone completion: ${milestone.title}`, status: "pending" });
        report.milestonesCreated += 1;
      }

      for (const slice of milestone.slices) {
        if (slice.selected === false) continue;
        const existingSlice = existingMilestone?.slices.find((item) => item.id === slice.existingSliceId);
        let sliceId: string;
        if (existingSlice) {
          sliceId = existingSlice.id;
        } else {
          sliceId = (await missionStore.addSlice(milestoneId, { title: slice.title, description: slice.description, verification: slice.verification })).id;
          await missionStore.addContractAssertion(milestoneId, { title: `Slice: ${slice.title}`, assertion: slice.verification || slice.description || `Verify slice completion: ${slice.title}`, status: "pending" });
          report.slicesCreated += 1;
        }

        for (const feature of slice.features) {
          if (feature.selected === false) continue;
          const existingFeature = existingSlice?.features.find((item) => item.id === feature.existingFeatureId);
          const status = toMissionFeatureStatus(feature.status);
          if (existingFeature) {
            const updates: Record<string, unknown> = {
              description: composeFeatureDescription(feature.description ?? existingFeature.description, feature.evidence, date),
            };
            if (feature.acceptanceCriteria) updates.acceptanceCriteria = feature.acceptanceCriteria;
            if (existingFeature.taskId) report.featureStatusKeptForLinkedTask += 1;
            else if (existingFeature.status !== status) updates.status = status;
            await missionStore.updateFeature(existingFeature.id, updates, { actor: "project-analysis", reason: "Project analysis" });
            report.featuresUpdated += 1;
            continue;
          }
          const created = await missionStore.addFeature(sliceId, {
            title: feature.title,
            description: composeFeatureDescription(feature.description, feature.evidence, date),
            acceptanceCriteria: feature.acceptanceCriteria,
          });
          if (status !== "defined") {
            await missionStore.updateFeature(created.id, { status }, { actor: "project-analysis", reason: "Project analysis" });
          }
          report.featuresCreated += 1;
        }
      }
      if (createdMilestone) await missionStore.applyDerivedMilestoneAcceptanceCriteria(milestoneId);
    }
  }
  return report;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const PROGRESS_TAIL = 4000;
const jobs = new Map<string, ProjectAnalysisJob>();
const latestByRoot = new Map<string, string>();
const abortByJob = new Map<string, AbortController>();
/** Project root of each job, so a job id from one project can never be applied to another. */
const rootByJob = new Map<string, string>();

function latestFile(rootDir: string): string {
  return join(rootDir, ".fusion", "project-analysis", "latest.json");
}

async function persistLatest(rootDir: string, job: ProjectAnalysisJob): Promise<void> {
  try {
    await mkdir(join(rootDir, ".fusion", "project-analysis"), { recursive: true });
    await writeFile(latestFile(rootDir), JSON.stringify(job, null, 2), "utf8");
  } catch {
    // The in-memory job stays authoritative for this process; persistence only serves restarts.
  }
}

export function getProjectAnalysisJob(id: string, rootDir: string): ProjectAnalysisJob | undefined {
  return rootByJob.get(id) === rootDir ? jobs.get(id) : undefined;
}

/** Latest analysis of this project: the in-memory job, else the persisted one (a job still "running" at restart is reported as interrupted). */
export async function getLatestProjectAnalysis(rootDir: string): Promise<ProjectAnalysisJob | undefined> {
  const id = latestByRoot.get(rootDir);
  if (id && jobs.has(id)) return jobs.get(id);
  try {
    const job = JSON.parse(await readFile(latestFile(rootDir), "utf8")) as ProjectAnalysisJob;
    if (job.status === "running") return { ...job, status: "error", error: "Analysis interrupted by a Fusion restart" };
    jobs.set(job.id, job);
    latestByRoot.set(rootDir, job.id);
    rootByJob.set(job.id, rootDir);
    return job;
  } catch {
    return undefined;
  }
}

export interface StartProjectAnalysisOptions {
  rootDir: string;
  store: TaskStore;
  existing: ExistingProjectState;
  modelProvider?: string;
  modelId?: string;
  pluginRunner?: unknown;
  /** Test seam: replaces the real agent run. */
  runAgent?: (input: { systemPrompt: string; userMessage: string; onText: (delta: string) => void; signal: AbortSignal }) => Promise<string>;
}

export function startProjectAnalysis(options: StartProjectAnalysisOptions): ProjectAnalysisJob {
  const runningId = latestByRoot.get(options.rootDir);
  const running = runningId ? jobs.get(runningId) : undefined;
  if (running?.status === "running") return running;
  if (running?.status === "applying") throw new Error("An analysis is being applied; start a new one when it finishes");

  const job: ProjectAnalysisJob = { id: randomUUID(), status: "running", startedAt: new Date().toISOString(), modelProvider: options.modelProvider, modelId: options.modelId, progress: "" };
  jobs.set(job.id, job);
  latestByRoot.set(options.rootDir, job.id);
  rootByJob.set(job.id, options.rootDir);
  const controller = new AbortController();
  abortByJob.set(job.id, controller);

  const onText = (delta: string) => {
    job.progress = (job.progress + delta).slice(-PROGRESS_TAIL);
  };
  const userMessage = buildProjectAnalysisUserMessage(options.existing);
  const run = options.runAgent ?? ((input) => runAnalysisAgent(options, input));

  void (async () => {
    try {
      const text = await run({ systemPrompt: PROJECT_ANALYSIS_SYSTEM_PROMPT, userMessage, onText, signal: controller.signal });
      if (controller.signal.aborted) return;
      job.plan = parseProjectAnalysisResponse(text);
      job.status = "complete";
    } catch (error) {
      if (controller.signal.aborted) return;
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = new Date().toISOString();
      abortByJob.delete(job.id);
      await persistLatest(options.rootDir, job);
    }
  })();
  return job;
}

export function cancelProjectAnalysis(id: string, rootDir: string): boolean {
  const job = getProjectAnalysisJob(id, rootDir);
  const controller = abortByJob.get(id);
  if (!job || job.status !== "running" || !controller) return false;
  controller.abort();
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  return true;
}

export class ProjectAnalysisNotApplicableError extends Error {}

/**
 * FNXC:ProjectAnalysis 2026-11-15-11:16:
 * Applying creates missions, so it must run at most once per analysis.
 * The job moves to "applying" synchronously, before the first await, so a second concurrent request (double click, second tab) is refused instead of creating everything twice.
 * If applying fails midway, some entries already exist: the job becomes "error" (never back to "complete"), so the same plan cannot be re-applied and duplicate them.
 * A new analysis sees what was created and reuses it.
 */
export async function applyProjectAnalysisJob(
  rootDir: string,
  job: ProjectAnalysisJob,
  plan: ProjectAnalysisPlan,
  stores: { missionStore: AnalysisMissionStore; goalStore: AnalysisGoalStore },
): Promise<ProjectAnalysisApplyReport> {
  if (job.status !== "complete") throw new ProjectAnalysisNotApplicableError(`Analysis is ${job.status}, not ready to apply`);
  job.status = "applying";
  try {
    const report = await applyProjectAnalysisPlan(plan, stores);
    job.plan = plan;
    job.status = "applied";
    job.applyReport = report;
    job.finishedAt = new Date().toISOString();
    await persistLatest(rootDir, job);
    return report;
  } catch (error) {
    job.status = "error";
    job.error = `Application interrupted after a partial write (${error instanceof Error ? error.message : String(error)}). Run a new analysis: it reuses what was already created.`;
    await persistLatest(rootDir, job);
    throw error;
  }
}

async function runAnalysisAgent(
  options: StartProjectAnalysisOptions,
  input: { systemPrompt: string; userMessage: string; onText: (delta: string) => void; signal: AbortSignal },
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent: any = await createResolvedAgentSession({
    sessionPurpose: "executor",
    cwd: options.rootDir,
    systemPrompt: input.systemPrompt,
    tools: "readonly",
    customTools: [...createPlanningBoardTools(options.store)],
    ...(options.pluginRunner ? { pluginRunner: options.pluginRunner } : {}),
    ...(options.modelProvider && options.modelId ? { defaultProvider: options.modelProvider, defaultModelId: options.modelId } : {}),
    onText: input.onText,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const dispose = () => {
    try { agent.session.dispose?.(); } catch { /* best effort */ }
  };
  input.signal.addEventListener("abort", dispose, { once: true });
  try {
    const lastAssistantText = (): string => {
      const messages = (agent.session.state?.messages ?? []) as Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>;
      const last = messages.filter((message) => message.role === "assistant").pop();
      if (!last?.content) return "";
      return typeof last.content === "string" ? last.content : last.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    };
    /** All assistant text since the given message index, in order: recovers a plan split across messages by an output limit. */
    const assistantTextSince = (from: number): string => {
      const messages = (agent.session.state?.messages ?? []) as Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>;
      return messages.slice(from).filter((message) => message.role === "assistant").map((message) => {
        if (!message.content) return "";
        return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
      }).join("");
    };
    const messageCount = (): number => (agent.session.state?.messages ?? []).length;
    /** Last message first, then the trailing assistant messages joined (split output). */
    const pickParsable = (since: number): { text?: string; error: string } => {
      const last = lastAssistantText();
      const lastTry = tryParsePlan(last);
      if (lastTry.ok) return { text: last, error: "" };
      const messages = (agent.session.state?.messages ?? []) as Array<{ role: string }>;
      let tailStart = messages.length;
      while (tailStart > since && messages[tailStart - 1]?.role === "assistant") tailStart -= 1;
      const joined = assistantTextSince(tailStart);
      const joinedTry = tryParsePlan(joined);
      if (joinedTry.ok) return { text: joined, error: "" };
      return { error: lastTry.error };
    };

    const promptStart = messageCount();
    await enginePromptWithFallback(agent.session, input.userMessage, { signal: input.signal });
    let picked = pickParsable(promptStart);
    if (picked.text) return picked.text;

    const correctionStart = messageCount();
    await enginePromptWithFallback(
      agent.session,
      `Your final answer could not be used: ${picked.error}. Reply with ONLY the complete, corrected JSON object (no prose, no code fence).`,
      { signal: input.signal },
    );
    picked = pickParsable(correctionStart);
    if (picked.text) return picked.text;

    await saveRawResponse(options.rootDir, assistantTextSince(promptStart));
    throw new Error(`${picked.error} (raw response saved to .fusion/project-analysis/last-failed-response.txt)`);
  } finally {
    input.signal.removeEventListener("abort", dispose);
    dispose();
  }
}

/** @internal test reset */
export function __resetProjectAnalysisJobsForTests(): void {
  jobs.clear();
  latestByRoot.clear();
  abortByJob.clear();
  rootByJob.clear();
}
