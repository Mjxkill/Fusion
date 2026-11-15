/**
 * FNXC:ProjectAnalysis 2026-11-15-10:14:
 * Client for "Analyze project": start a read-only repository analysis, poll the latest job, cancel it, and apply the reviewed plan.
 * Types mirror `packages/dashboard/src/project-analysis.ts`.
 */
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

export type AnalysisFeatureStatus = "done" | "in-progress" | "todo" | "blocked";

export interface AnalysisFeature { existingFeatureId?: string; title: string; description?: string; acceptanceCriteria?: string; status: AnalysisFeatureStatus; evidence?: string; selected?: boolean }
export interface AnalysisSlice { existingSliceId?: string; title: string; description?: string; verification?: string; features: AnalysisFeature[]; selected?: boolean }
export interface AnalysisMilestone { existingMilestoneId?: string; title: string; description?: string; verification?: string; slices: AnalysisSlice[]; selected?: boolean }
export interface AnalysisMission { existingMissionId?: string; title: string; description?: string; goalRefs?: string[]; milestones: AnalysisMilestone[]; selected?: boolean }
export interface AnalysisGoal { ref: string; existingGoalId?: string; title: string; description?: string; selected?: boolean }
export interface ProjectAnalysisPlan { summary?: string; goals: AnalysisGoal[]; missions: AnalysisMission[] }

export interface ProjectAnalysisApplyReport {
  goalsCreated: number;
  goalsLinked: number;
  goalsSkipped: Array<{ title: string; reason: string }>;
  missionsCreated: number;
  milestonesCreated: number;
  slicesCreated: number;
  featuresCreated: number;
  featuresUpdated: number;
  featureStatusKeptForLinkedTask: number;
}

export interface ProjectAnalysisJob {
  id: string;
  status: "running" | "complete" | "applying" | "error" | "applied" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  modelProvider?: string;
  modelId?: string;
  progress: string;
  plan?: ProjectAnalysisPlan;
  error?: string;
  applyReport?: ProjectAnalysisApplyReport;
}

export function startProjectAnalysis(projectId?: string, model?: { modelProvider?: string; modelId?: string }): Promise<ProjectAnalysisJob> {
  return api<ProjectAnalysisJob>(withProjectId("/missions/analysis/start", projectId), {
    method: "POST",
    body: JSON.stringify({ modelProvider: model?.modelProvider, modelId: model?.modelId }),
  });
}

export function fetchLatestProjectAnalysis(projectId?: string): Promise<{ job: ProjectAnalysisJob | null }> {
  return api<{ job: ProjectAnalysisJob | null }>(withProjectId("/missions/analysis/latest", projectId));
}

export function cancelProjectAnalysis(analysisId: string, projectId?: string): Promise<{ cancelled: boolean }> {
  return api<{ cancelled: boolean }>(withProjectId(`/missions/analysis/${encodeURIComponent(analysisId)}/cancel`, projectId), { method: "POST", body: JSON.stringify({}) });
}

export function applyProjectAnalysis(analysisId: string, plan: ProjectAnalysisPlan, projectId?: string): Promise<{ report: ProjectAnalysisApplyReport }> {
  return api<{ report: ProjectAnalysisApplyReport }>(withProjectId(`/missions/analysis/${encodeURIComponent(analysisId)}/apply`, projectId), {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
}
