// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_EVIDENCE_MARKER,
  ProjectAnalysisNotApplicableError,
  applyProjectAnalysisJob,
  __resetProjectAnalysisJobsForTests,
  applyProjectAnalysisPlan,
  buildProjectAnalysisUserMessage,
  composeFeatureDescription,
  getProjectAnalysisJob,
  parseProjectAnalysisResponse,
  readExistingProjectState,
  startProjectAnalysis,
  type AnalysisGoalStore,
  type AnalysisMissionStore,
  type ProjectAnalysisPlan,
} from "../project-analysis.js";

/*
FNXC:ProjectAnalysis 2026-11-15-10:14:
Project analysis must turn an existing project into goals/missions/features with detected status, and a re-analysis must update what exists instead of duplicating it.
*/

interface Feature { id: string; title: string; description?: string; acceptanceCriteria?: string; status: string; taskId?: string }
interface Slice { id: string; title: string; features: Feature[] }
interface Milestone { id: string; title: string; slices: Slice[] }
interface Mission { id: string; title: string; description?: string; milestones: Milestone[]; goals: string[] }

function fakeStores(options: { goalLimit?: number } = {}) {
  let seq = 0;
  const next = (prefix: string) => `${prefix}-${++seq}`;
  const missions: Mission[] = [];
  const goals: Array<{ id: string; title: string; description?: string; status: string }> = [];
  const assertions: string[] = [];
  const findSlice = (id: string) => missions.flatMap((m) => m.milestones).flatMap((ms) => ms.slices).find((s) => s.id === id)!;
  const findFeature = (id: string) => missions.flatMap((m) => m.milestones).flatMap((ms) => ms.slices).flatMap((s) => s.features).find((f) => f.id === id)!;
  const missionStore: AnalysisMissionStore = {
    listMissions: () => missions.map((m) => ({ id: m.id })),
    getMissionWithHierarchy: (id) => missions.find((m) => m.id === id),
    createMission: (input) => { const m = { id: next("M"), title: input.title, description: input.description, milestones: [], goals: [] }; missions.push(m); return m; },
    addMilestone: (missionId, input) => { const ms = { id: next("MS"), title: input.title, slices: [] }; missions.find((m) => m.id === missionId)!.milestones.push(ms); return ms; },
    addSlice: (milestoneId, input) => { const s = { id: next("S"), title: input.title, features: [] }; missions.flatMap((m) => m.milestones).find((ms) => ms.id === milestoneId)!.slices.push(s); return s; },
    addFeature: (sliceId, input) => { const f = { id: next("F"), title: input.title, description: input.description, acceptanceCriteria: input.acceptanceCriteria, status: "defined" }; findSlice(sliceId).features.push(f); return f; },
    updateFeature: (id, updates) => { Object.assign(findFeature(id), updates); return findFeature(id); },
    addContractAssertion: (_milestoneId, input) => { assertions.push(input.title); },
    applyDerivedMilestoneAcceptanceCriteria: () => undefined,
    linkGoal: (missionId, goalId) => { missions.find((m) => m.id === missionId)!.goals.push(goalId); },
    listGoalIdsForMission: (missionId) => missions.find((m) => m.id === missionId)!.goals,
  };
  const goalStore: AnalysisGoalStore = {
    listGoals: () => goals,
    createGoal: (input) => {
      if (goals.filter((g) => g.status === "active").length >= (options.goalLimit ?? 5)) {
        throw Object.assign(new Error("limit"), { code: "ACTIVE_GOAL_LIMIT_EXCEEDED" });
      }
      const goal = { id: next("G"), title: input.title, description: input.description, status: "active" };
      goals.push(goal);
      return goal;
    },
  };
  return { missionStore, goalStore, missions, goals, assertions };
}

const firstPlan: ProjectAnalysisPlan = {
  summary: "Video studio.",
  goals: [{ ref: "g1", title: "Publier des vidéos", description: "Studio complet" }],
  missions: [{
    title: "Génération",
    goalRefs: ["g1"],
    milestones: [{
      title: "Générateurs image",
      verification: "Chaque générateur répond",
      slices: [{
        title: "ComfyUI",
        features: [
          { title: "flux2_image", status: "done", evidence: "api/studio/generators/_image.py" },
          { title: "qwen_image", status: "todo", evidence: "absent du code" },
        ],
      }],
    }],
  }],
};

describe("project analysis", () => {
  afterEach(() => __resetProjectAnalysisJobsForTests());

  it("parses agent JSON wrapped in prose and drops untitled entries", () => {
    const plan = parseProjectAnalysisResponse(`Voici le plan :\n${JSON.stringify({
      goals: [{ ref: "g1", title: "But" }, { ref: "g2" }],
      missions: [{ title: "M", milestones: [{ title: "J", slices: [{ title: "T", features: [{ title: "F", status: "weird" }, { status: "done" }] }] }] }],
    })}\nFin.`);
    expect(plan.goals).toHaveLength(1);
    expect(plan.missions[0]!.milestones[0]!.slices[0]!.features).toEqual([expect.objectContaining({ title: "F", status: "todo", selected: true })]);
    expect(() => parseProjectAnalysisResponse("{\"missions\": []}")).toThrow("no mission");
  });

  /*
  FNXC:ProjectAnalysis 2026-11-15-11:40:
  Real failure on videasy: a long plan came back but parsing reported "no mission". A broken outer object must not let a valid nested feature win, and the error must name the JSON problem.
  */
  it("does not mistake a valid nested feature for the plan when the outer JSON is broken", () => {
    const plan = JSON.stringify(firstPlan);
    const broken = plan.replace('"summary":"Video studio."', '"summary":"Video "studio"."');
    expect(() => parseProjectAnalysisResponse(`Voici le plan :\n${broken}`)).toThrow(/not valid JSON/);
    expect(() => parseProjectAnalysisResponse(`Voici le plan :\n${broken}`)).not.toThrow(/^The analysis returned no mission$/);
  });

  it("repairs a trailing comma in an otherwise complete plan", () => {
    const withTrailingComma = JSON.stringify(firstPlan).replace(/\]\}\]\}\]\}\]\}$/, "],}]}]}]}");
    expect(withTrailingComma).not.toBe(JSON.stringify(firstPlan));
    expect(parseProjectAnalysisResponse(withTrailingComma).missions[0]!.title).toBe("Génération");
  });

  it("creates goals, missions and features with their detected status on a first analysis", async () => {
    const stores = fakeStores();
    const report = await applyProjectAnalysisPlan(firstPlan, stores, new Date("2026-11-15T10:00:00Z"));

    expect(report).toMatchObject({ goalsCreated: 1, goalsLinked: 1, missionsCreated: 1, milestonesCreated: 1, slicesCreated: 1, featuresCreated: 2, featuresUpdated: 0 });
    const features = stores.missions[0]!.milestones[0]!.slices[0]!.features;
    expect(features.map((f) => [f.title, f.status])).toEqual([["flux2_image", "done"], ["qwen_image", "defined"]]);
    expect(features[0]!.description).toBe("---\nAnalyse du projet (2026-11-15) : api/studio/generators/_image.py");
    expect(stores.missions[0]!.goals).toEqual([stores.goals[0]!.id]);
    expect(stores.assertions).toEqual(["Milestone: Générateurs image", "Slice: ComfyUI"]);
  });

  it("re-analysis reuses existing ids: updates status and evidence, adds only what is new", async () => {
    const stores = fakeStores();
    await applyProjectAnalysisPlan(firstPlan, stores, new Date("2026-11-15T10:00:00Z"));
    const existing = await readExistingProjectState(stores.missionStore, stores.goalStore, 5);
    const [mission] = existing.missions;
    const [milestone] = mission!.milestones;
    const [slice] = milestone!.slices;
    expect(buildProjectAnalysisUserMessage(existing)).toContain(slice!.features[1]!.id);

    const report = await applyProjectAnalysisPlan({
      goals: [{ ref: "g1", existingGoalId: existing.goals[0]!.id, title: "Publier des vidéos" }],
      missions: [{
        existingMissionId: mission!.id,
        title: "Génération (renommée par l'agent)",
        goalRefs: ["g1"],
        milestones: [{
          existingMilestoneId: milestone!.id,
          title: "Générateurs image",
          slices: [{
            existingSliceId: slice!.id,
            title: "ComfyUI",
            features: [
              { existingFeatureId: slice!.features[1]!.id, title: "qwen_image", status: "done", evidence: "api/studio/generators/_qwen.py" },
              { title: "zimage_image", status: "in-progress", evidence: "stub" },
              { title: "ignored", status: "todo", selected: false },
            ],
          }],
        }],
      }],
    }, stores, new Date("2026-11-16T10:00:00Z"));

    expect(report).toMatchObject({ goalsCreated: 0, goalsLinked: 0, missionsCreated: 0, milestonesCreated: 0, slicesCreated: 0, featuresCreated: 1, featuresUpdated: 1 });
    expect(stores.missions).toHaveLength(1);
    expect(stores.missions[0]!.title).toBe("Génération");
    const features = stores.missions[0]!.milestones[0]!.slices[0]!.features;
    expect(features.map((f) => [f.title, f.status])).toEqual([["flux2_image", "done"], ["qwen_image", "done"], ["zimage_image", "in-progress"]]);
    expect(features[1]!.description).toBe("---\nAnalyse du projet (2026-11-16) : api/studio/generators/_qwen.py");
  });

  it("keeps the task-driven status of a linked feature and reports skipped goals at the active limit", async () => {
    const stores = fakeStores({ goalLimit: 0 });
    await applyProjectAnalysisPlan({ ...firstPlan, goals: [] }, stores);
    const feature = stores.missions[0]!.milestones[0]!.slices[0]!.features[1]!;
    feature.taskId = "VIDE-9";
    const ids = { mission: stores.missions[0]!, milestone: stores.missions[0]!.milestones[0]!, slice: stores.missions[0]!.milestones[0]!.slices[0]! };

    const report = await applyProjectAnalysisPlan({
      goals: [{ ref: "g1", title: "Trop d'objectifs" }],
      missions: [{ existingMissionId: ids.mission.id, title: "x", goalRefs: ["g1"], milestones: [{ existingMilestoneId: ids.milestone.id, title: "x", slices: [{ existingSliceId: ids.slice.id, title: "x", features: [{ existingFeatureId: feature.id, title: "qwen_image", status: "done" }] }] }] }],
    }, stores);

    expect(report.goalsSkipped).toEqual([{ title: "Trop d'objectifs", reason: "active-goal-limit" }]);
    expect(report.featureStatusKeptForLinkedTask).toBe(1);
    expect(feature.status).toBe("defined");
  });

  it("strips a previous evidence block when composing a description", () => {
    const first = composeFeatureDescription("Base", "old", "2026-11-15");
    expect(composeFeatureDescription(first, "new", "2026-11-16")).toBe(`Base${ANALYSIS_EVIDENCE_MARKER} (2026-11-16) : new`);
    expect(composeFeatureDescription(first, undefined, "2026-11-16")).toBe("Base");
  });

  it("runs one job per project at a time and stores the parsed plan", async () => {
    const stores = fakeStores();
    const existing = await readExistingProjectState(stores.missionStore, stores.goalStore, 5);
    let release!: (text: string) => void;
    const runAgent = () => new Promise<string>((resolve) => { release = resolve; });
    const root = "/tmp/fusion-project-analysis-test-does-not-exist";
    const job = startProjectAnalysis({ rootDir: root, store: {} as never, existing, runAgent });
    expect(startProjectAnalysis({ rootDir: root, store: {} as never, existing, runAgent }).id).toBe(job.id);
    expect(getProjectAnalysisJob(job.id, "/other/project")).toBeUndefined();

    release(JSON.stringify(firstPlan));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getProjectAnalysisJob(job.id, root)).toMatchObject({ status: "complete", plan: { missions: [expect.objectContaining({ title: "Génération" })] } });
  });

  /*
  FNXC:ProjectAnalysis 2026-11-15-11:16:
  An analysis applies at most once: a concurrent second apply is refused, and a failure midway never returns the job to "complete".
  */
  it("refuses a concurrent second apply instead of creating everything twice", async () => {
    const stores = fakeStores();
    const root = "/tmp/fusion-project-analysis-apply-lock-test";
    const job = { id: "job-1", status: "complete" as const, startedAt: "2026-11-15T10:00:00Z", progress: "", plan: firstPlan };
    const [first, second] = await Promise.allSettled([
      applyProjectAnalysisJob(root, job as never, firstPlan, stores),
      applyProjectAnalysisJob(root, job as never, firstPlan, stores),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: expect.any(ProjectAnalysisNotApplicableError) });
    expect(stores.missions).toHaveLength(1);
    expect(job.status).toBe("applied");
  });

  it("marks a partially applied analysis as failed so the same plan cannot be re-applied", async () => {
    const stores = fakeStores();
    let calls = 0;
    const addFeature = stores.missionStore.addFeature;
    stores.missionStore.addFeature = (sliceId, input) => {
      calls += 1;
      if (calls === 2) throw new Error("database down");
      return addFeature(sliceId, input);
    };
    const job = { id: "job-2", status: "complete" as const, startedAt: "2026-11-15T10:00:00Z", progress: "", plan: firstPlan };
    await expect(applyProjectAnalysisJob("/tmp/fusion-project-analysis-partial-test", job as never, firstPlan, stores)).rejects.toThrow("database down");
    expect(job.status).toBe("error");
    expect((job as { error?: string }).error).toContain("Run a new analysis");
    await expect(applyProjectAnalysisJob("/tmp/fusion-project-analysis-partial-test", job as never, firstPlan, stores)).rejects.toBeInstanceOf(ProjectAnalysisNotApplicableError);
    expect(stores.missions).toHaveLength(1);
  });
});
