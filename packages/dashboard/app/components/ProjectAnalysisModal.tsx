import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import {
  applyProjectAnalysis,
  cancelProjectAnalysis,
  fetchLatestProjectAnalysis,
  fetchModels,
  startProjectAnalysis,
  type AnalysisFeatureStatus,
  type ProjectAnalysisApplyReport,
  type ProjectAnalysisJob,
  type ProjectAnalysisPlan,
} from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import "./ProjectAnalysisModal.css";

/**
 * FNXC:ProjectAnalysis 2026-11-15-10:14:
 * Operator requirement: an "Analyze project" button that detects an existing project's content and configures goals, missions and features, so they can check what is built and what remains per feature.
 * The dialog picks the model (default ollama-cloud / deepseek-v4.1-flash, the operator's choice), follows the running analysis (it keeps running server-side if the dialog closes), lets the operator review the proposal (uncheck entries, correct each feature's detected status, read its evidence) and applies it.
 * Entries tagged "existing" come from a previous analysis or manual planning and are updated in place (re-analysis), never duplicated.
 */
export const DEFAULT_PROJECT_ANALYSIS_MODEL = { provider: "ollama-cloud", modelId: "deepseek-v4.1-flash" } as const;
const POLL_MS = 3000;
const STATUSES: AnalysisFeatureStatus[] = ["done", "in-progress", "todo", "blocked"];

export interface ProjectAnalysisModalProps {
  projectId?: string;
  onClose: () => void;
  /** Called after a plan was applied so the mission list can reload. */
  onApplied: () => void;
}

type ModelOption = Parameters<typeof CustomModelDropdown>[0]["models"][number];

function countFeatures(plan: ProjectAnalysisPlan, status?: AnalysisFeatureStatus): number {
  let count = 0;
  for (const mission of plan.missions) for (const milestone of mission.milestones) for (const slice of milestone.slices) for (const feature of slice.features) {
    if (!status || feature.status === status) count += 1;
  }
  return count;
}

export function ProjectAnalysisModal({ projectId, onClose, onApplied }: ProjectAnalysisModalProps) {
  const { t } = useTranslation("app");
  const [job, setJob] = useState<ProjectAnalysisJob | null>(null);
  const [plan, setPlan] = useState<ProjectAnalysisPlan | null>(null);
  const [report, setReport] = useState<ProjectAnalysisApplyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelValue, setModelValue] = useState(`${DEFAULT_PROJECT_ANALYSIS_MODEL.provider}/${DEFAULT_PROJECT_ANALYSIS_MODEL.modelId}`);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adoptJob = useCallback((next: ProjectAnalysisJob | null) => {
    setJob(next);
    if (next?.status === "complete" && next.plan) setPlan(next.plan);
  }, []);

  const poll = useCallback(async () => {
    try {
      const { job: latest } = await fetchLatestProjectAnalysis(projectId);
      adoptJob(latest);
      if (latest?.status === "running") pollRef.current = setTimeout(() => void poll(), POLL_MS);
    } catch (cause) {
      setError(getErrorMessage(cause) || "Could not read the analysis");
    } finally {
      setLoaded(true);
    }
  }, [adoptJob, projectId]);

  useEffect(() => {
    void poll();
    fetchModels().then((response) => setModels(response.models)).catch(() => undefined);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [poll]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    setPlan(null);
    try {
      const slash = modelValue.indexOf("/");
      const model = slash > 0 ? { modelProvider: modelValue.slice(0, slash), modelId: modelValue.slice(slash + 1) } : undefined;
      adoptJob(await startProjectAnalysis(projectId, model));
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = setTimeout(() => void poll(), POLL_MS);
    } catch (cause) {
      setError(getErrorMessage(cause) || "Could not start the analysis");
    } finally {
      setBusy(false);
    }
  }, [adoptJob, modelValue, poll, projectId]);

  const cancel = useCallback(async () => {
    if (!job) return;
    try {
      await cancelProjectAnalysis(job.id, projectId);
      await poll();
    } catch (cause) {
      setError(getErrorMessage(cause) || "Could not cancel the analysis");
    }
  }, [job, poll, projectId]);

  const apply = useCallback(async () => {
    if (!job || !plan) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyProjectAnalysis(job.id, plan, projectId);
      setReport(result.report);
      setJob({ ...job, status: "applied", applyReport: result.report });
      onApplied();
    } catch (cause) {
      setError(getErrorMessage(cause) || "Could not apply the analysis");
    } finally {
      setBusy(false);
    }
  }, [job, onApplied, plan, projectId]);

  /** Immutable edit of the reviewed plan. */
  const edit = useCallback((mutate: (draft: ProjectAnalysisPlan) => void) => {
    setPlan((current) => {
      if (!current) return current;
      const draft = structuredClone(current);
      mutate(draft);
      return draft;
    });
  }, []);

  const running = job?.status === "running";
  const reviewing = job?.status === "complete" && plan !== null && !report;

  return (
    <div className="modal-overlay open" role="presentation">
      <div className="modal project-analysis-modal" role="dialog" aria-modal="true" aria-labelledby="project-analysis-title" data-testid="project-analysis-modal">
        <div className="modal-header">
          <h3 id="project-analysis-title">{t("projectAnalysis.title", "Analyze project")}</h3>
        </div>
        <div className="modal-body project-analysis-modal__body">
          {!loaded && <p>{t("projectAnalysis.loading", "Loading…")}</p>}

          {loaded && !running && !reviewing && !report && (
            <div className="project-analysis-modal__start">
              <p>{t("projectAnalysis.intro", "An agent reads the repository (docs, code, tests, board tasks) without changing anything, then proposes goals, missions and features with their detected status. You review the proposal before anything is created. Existing missions are updated, not duplicated.")}</p>
              <CustomModelDropdown id="project-analysis-model" label={t("projectAnalysis.model", "Analysis model")} value={modelValue} onChange={setModelValue} models={models} />
              {job?.status === "error" && <p className="project-analysis-modal__error" role="status">{t("projectAnalysis.failed", "The last analysis failed: {{error}}", { error: job.error ?? "" })}</p>}
              {job?.status === "cancelled" && <p role="status">{t("projectAnalysis.cancelled", "The last analysis was cancelled.")}</p>}
              {job?.status === "applied" && job.applyReport && <p role="status">{t("projectAnalysis.lastApplied", "The last analysis was applied on {{date}}.", { date: (job.finishedAt ?? job.startedAt).slice(0, 10) })}</p>}
            </div>
          )}

          {running && job && (
            <div className="project-analysis-modal__running" data-testid="project-analysis-running">
              <p>{t("projectAnalysis.running", "Analysis in progress with {{model}} since {{time}}. You can close this window: it keeps running.", { model: job.modelId ?? "", time: job.startedAt.slice(11, 16) })}</p>
              <pre className="project-analysis-modal__progress">{job.progress || "…"}</pre>
            </div>
          )}

          {reviewing && plan && (
            <div className="project-analysis-modal__review" data-testid="project-analysis-review">
              {plan.summary && <p>{plan.summary}</p>}
              <p className="project-analysis-modal__counts">
                {t("projectAnalysis.counts", "{{missions}} missions, {{features}} features: {{done}} done, {{inProgress}} in progress, {{todo}} to do, {{blocked}} blocked", {
                  missions: plan.missions.length,
                  features: countFeatures(plan),
                  done: countFeatures(plan, "done"),
                  inProgress: countFeatures(plan, "in-progress"),
                  todo: countFeatures(plan, "todo"),
                  blocked: countFeatures(plan, "blocked"),
                })}
              </p>

              {plan.goals.length > 0 && (
                <section>
                  <h4>{t("projectAnalysis.goals", "Goals")}</h4>
                  {plan.goals.map((goal, goalIndex) => (
                    <label className="project-analysis-modal__row" key={goal.ref}>
                      <input type="checkbox" checked={goal.selected !== false} onChange={(event) => edit((draft) => { draft.goals[goalIndex]!.selected = event.target.checked; })} />
                      <span>{goal.title}</span>
                      {goal.existingGoalId && <span className="card-workflow-badge">{t("projectAnalysis.existing", "existing")}</span>}
                    </label>
                  ))}
                </section>
              )}

              {plan.missions.map((mission, missionIndex) => (
                <details className="project-analysis-modal__mission" key={`${missionIndex}-${mission.title}`} open={missionIndex === 0}>
                  <summary>
                    <input type="checkbox" checked={mission.selected !== false} onChange={(event) => edit((draft) => { draft.missions[missionIndex]!.selected = event.target.checked; })} onClick={(event) => event.stopPropagation()} aria-label={mission.title} />
                    <strong>{mission.title}</strong>
                    {mission.existingMissionId && <span className="card-workflow-badge">{t("projectAnalysis.existing", "existing")}</span>}
                  </summary>
                  {mission.milestones.map((milestone, milestoneIndex) => (
                    <div className="project-analysis-modal__milestone" key={`${milestoneIndex}-${milestone.title}`}>
                      <label className="project-analysis-modal__row">
                        <input type="checkbox" checked={milestone.selected !== false} onChange={(event) => edit((draft) => { draft.missions[missionIndex]!.milestones[milestoneIndex]!.selected = event.target.checked; })} />
                        <span className="project-analysis-modal__milestone-title">{milestone.title}</span>
                        {milestone.existingMilestoneId && <span className="card-workflow-badge">{t("projectAnalysis.existing", "existing")}</span>}
                      </label>
                      {milestone.slices.map((slice, sliceIndex) => (
                        <div className="project-analysis-modal__slice" key={`${sliceIndex}-${slice.title}`}>
                          <label className="project-analysis-modal__row">
                            <input type="checkbox" checked={slice.selected !== false} onChange={(event) => edit((draft) => { draft.missions[missionIndex]!.milestones[milestoneIndex]!.slices[sliceIndex]!.selected = event.target.checked; })} />
                            <span>{slice.title}</span>
                            {slice.existingSliceId && <span className="card-workflow-badge">{t("projectAnalysis.existing", "existing")}</span>}
                          </label>
                          {slice.features.map((feature, featureIndex) => (
                            <div className="project-analysis-modal__feature" key={`${featureIndex}-${feature.title}`}>
                              <div className="project-analysis-modal__row">
                                <input
                                  type="checkbox"
                                  checked={feature.selected !== false}
                                  aria-label={feature.title}
                                  onChange={(event) => edit((draft) => { draft.missions[missionIndex]!.milestones[milestoneIndex]!.slices[sliceIndex]!.features[featureIndex]!.selected = event.target.checked; })}
                                />
                                <span className="card-title">{feature.title}</span>
                                {feature.existingFeatureId && <span className="card-workflow-badge">{t("projectAnalysis.existing", "existing")}</span>}
                                <select
                                  className="select project-analysis-modal__status"
                                  value={feature.status}
                                  aria-label={t("projectAnalysis.status", "Status")}
                                  onChange={(event) => edit((draft) => { draft.missions[missionIndex]!.milestones[milestoneIndex]!.slices[sliceIndex]!.features[featureIndex]!.status = event.target.value as AnalysisFeatureStatus; })}
                                >
                                  {STATUSES.map((status) => (
                                    <option key={status} value={status}>{t(`projectAnalysis.statuses.${status}`, status)}</option>
                                  ))}
                                </select>
                              </div>
                              {feature.evidence && <div className="card-meta project-analysis-modal__evidence">{feature.evidence}</div>}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </details>
              ))}
            </div>
          )}

          {report && (
            <div className="project-analysis-modal__report" role="status" data-testid="project-analysis-report">
              <p>{t("projectAnalysis.applied", "Applied: {{missions}} missions, {{milestones}} milestones, {{slices}} slices and {{features}} features created; {{updated}} features updated; {{goals}} goals created.", {
                missions: report.missionsCreated,
                milestones: report.milestonesCreated,
                slices: report.slicesCreated,
                features: report.featuresCreated,
                updated: report.featuresUpdated,
                goals: report.goalsCreated,
              })}</p>
              {report.goalsSkipped.length > 0 && <p>{t("projectAnalysis.goalsSkipped", "Goals not created (active goal limit reached): {{titles}}", { titles: report.goalsSkipped.map((goal) => goal.title).join(", ") })}</p>}
              {report.featureStatusKeptForLinkedTask > 0 && <p>{t("projectAnalysis.linkedKept", "{{count}} features linked to a task kept the status set by their task.", { count: report.featureStatusKeptForLinkedTask })}</p>}
            </div>
          )}

          {error && <p className="project-analysis-modal__error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <div className="modal-actions-left">
            <button className="btn" type="button" onClick={onClose}>{t("projectAnalysis.close", "Close")}</button>
          </div>
          <div className="modal-actions-right">
            {running && <button className="btn" type="button" onClick={() => void cancel()}>{t("projectAnalysis.cancel", "Cancel analysis")}</button>}
            {reviewing && <button className="btn" type="button" disabled={busy} onClick={() => void start()}>{t("projectAnalysis.restart", "Analyze again")}</button>}
            {reviewing && <button className="btn btn-primary" type="button" disabled={busy} data-testid="project-analysis-apply" onClick={() => void apply()}>{busy ? t("projectAnalysis.applying", "Applying…") : t("projectAnalysis.apply", "Apply")}</button>}
            {loaded && !running && !reviewing && (
              <button className="btn btn-primary" type="button" disabled={busy} data-testid="project-analysis-start" onClick={() => void start()}>{t("projectAnalysis.start", "Start analysis")}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
