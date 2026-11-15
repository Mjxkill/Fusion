import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import {
  fetchProductionRunLog,
  fetchProductionStatus,
  mergeIntegrationToProduction,
  startProductionAction,
  type ProductionRun,
  type ProductionStatus,
} from "../api";
import "./ProductionModal.css";

/**
 * FNXC:ProductionOps 2026-11-15-12:00:
 * Operator requirement: buttons, per project and for any future web project, to merge integration into the production branch, deploy, restart each service, and update or restart Fusion itself (pause engines, wait for running agents, restart, resume).
 * The panel only calls the dashboard API; privileged work runs in the root unit described by /etc/fusion/ops.json. Every action asks for confirmation, and buttons are disabled while an action runs (the server also refuses duplicates).
 * While Fusion restarts the API is briefly unreachable: polling keeps going and reports the restart instead of an error.
 */
const POLL_MS = 3000;
const SHOWN_COMMITS = 30;

export interface ProductionModalProps {
  projectId?: string;
  onClose: () => void;
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "—";
}

export function ProductionModal({ projectId, onClose }: ProductionModalProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<ProductionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Action just started: the root unit writes its run file a moment later, so keep polling until that run appears (or 60 s). */
  const [awaiting, setAwaiting] = useState<{ instance: string; since: number } | null>(null);
  const requestRef = useRef(0);

  const runningRun = status?.runs.find((run) => run.status === "running") ?? null;

  useEffect(() => {
    if (!awaiting || !status) return;
    const started = status.runs.find((run) => run.instance === awaiting.instance && Date.parse(run.startedAt) >= awaiting.since - 5000);
    if (started || Date.now() - awaiting.since > 60_000) setAwaiting(null);
  }, [awaiting, status]);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await fetchProductionStatus(projectId);
      if (request !== requestRef.current) return;
      setStatus(next);
      setUnreachable(false);
      setError(null);
    } catch (cause) {
      if (request !== requestRef.current) return;
      // During a Fusion restart the API disappears for a while: keep polling instead of failing.
      setUnreachable(true);
      if (!status) setError(getErrorMessage(cause) || "Could not read production status");
    }
  }, [projectId, status]);

  useEffect(() => {
    void refresh();
  }, [projectId]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (runningRun || unreachable || awaiting) timerRef.current = setTimeout(() => void refresh(), POLL_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runningRun, unreachable, awaiting, refresh, status]);

  useEffect(() => {
    if (!selectedRun) return;
    let cancelled = false;
    void fetchProductionRunLog(selectedRun, projectId).then((text) => {
      if (!cancelled) setLog(text);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedRun, projectId, status]);

  const merge = useCallback(async () => {
    if (!status) return;
    const { commits, integrationBranch, productionBranch } = status.merge;
    if (!window.confirm(t("production.confirmMerge", "Merge {{count}} commits from {{from}} into {{to}}?", { count: commits.length, from: integrationBranch, to: productionBranch }))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await mergeIntegrationToProduction(projectId);
      setNotice(t("production.merged", "{{count}} commits merged into {{to}} ({{sha}}).", { count: result.merged, to: productionBranch, sha: short(result.head) }));
      await refresh();
    } catch (cause) {
      setError(getErrorMessage(cause) || "Merge failed");
    } finally {
      setBusy(false);
    }
  }, [projectId, refresh, status, t]);

  const act = useCallback(async (action: "deploy" | "restart" | "update", service: string | undefined, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const since = Date.now();
      const { instance } = await startProductionAction(action, service, projectId);
      setAwaiting({ instance, since });
      setSelectedRun(instance);
      await refresh();
    } catch (cause) {
      setError(getErrorMessage(cause) || "Action failed");
    } finally {
      setBusy(false);
    }
  }, [projectId, refresh]);

  const disabled = busy || Boolean(runningRun) || Boolean(awaiting);
  const mergeInfo = status?.merge;

  return (
    <div className="modal-overlay open" role="presentation">
      <div className="modal production-modal" role="dialog" aria-modal="true" aria-labelledby="production-title" data-testid="production-modal">
        <div className="modal-header">
          <h3 id="production-title">{t("production.title", "Production")}{status?.ops ? ` — ${status.ops.label}` : ""}</h3>
        </div>
        <div className="modal-body production-modal__body">
          {!status && !error && <p>{t("production.loading", "Loading…")}</p>}
          {unreachable && status && <p className="production-modal__notice" role="status">{t("production.unreachable", "Fusion is not answering (restart in progress?). Retrying…")}</p>}
          {error && <p className="production-modal__error" role="alert">{error}</p>}
          {notice && <p className="production-modal__notice" role="status">{notice}</p>}

          {mergeInfo && (
            <section className="production-modal__section" data-testid="production-merge">
              <h4>{t("production.mergeTitle", "{{from}} → {{to}}", { from: mergeInfo.integrationBranch, to: mergeInfo.productionBranch })}</h4>
              {mergeInfo.commits.length > 0 && (
                <>
                  <p>{t("production.mergeSummary", "{{count}} commits, {{files}} files.", { count: mergeInfo.commits.length, files: mergeInfo.filesChanged.length })}</p>
                  <ul className="production-modal__commits">
                    {mergeInfo.commits.slice(0, SHOWN_COMMITS).map((commit) => (
                      <li key={commit.sha}><code>{short(commit.sha)}</code> {commit.subject}</li>
                    ))}
                  </ul>
                  {mergeInfo.commits.length > SHOWN_COMMITS && <p>{t("production.moreCommits", "… and {{count}} more", { count: mergeInfo.commits.length - SHOWN_COMMITS })}</p>}
                </>
              )}
              {mergeInfo.productionOnlyCommits > 0 && mergeInfo.commits.length > 0 && (
                <p className="production-modal__hint">{t("production.mergeCommitNote", "{{to}} has {{count}} commits that {{from}} does not: a merge commit will be created.", { to: mergeInfo.productionBranch, from: mergeInfo.integrationBranch, count: mergeInfo.productionOnlyCommits })}</p>
              )}
              {mergeInfo.localChanges.length > 0 && mergeInfo.localChangesTouched.length === 0 && (
                <p className="production-modal__hint">{t("production.localChangesKept", "Uncommitted local changes are not touched by the merge and stay as they are: {{files}}", { files: mergeInfo.localChanges.join(", ") })}</p>
              )}
              {mergeInfo.blockedReason && <p className="production-modal__blocked" data-testid="production-merge-blocked">{mergeInfo.blockedReason}</p>}
              <button type="button" className="btn btn-primary" disabled={disabled || Boolean(mergeInfo.blockedReason)} data-testid="production-merge-button" onClick={() => void merge()}>
                {t("production.mergeButton", "Merge into {{to}}", { to: mergeInfo.productionBranch })}
              </button>
            </section>
          )}

          {status && !status.ops && (
            <p className="production-modal__hint">{t("production.noOps", "No deploy or restart action is configured for this project. Declare it in /etc/fusion/ops.json to get those buttons.")}</p>
          )}

          {status?.ops?.kind === "web" && (
            <section className="production-modal__section" data-testid="production-deploy">
              <h4>{t("production.deployTitle", "Deployment")}</h4>
              {status.deploy && (
                <p>
                  {status.deploy.deployedSha
                    ? t("production.deployedState", "Deployed: {{deployed}} — branch: {{head}} ({{count}} commits to deploy)", { deployed: short(status.deploy.deployedSha), head: short(status.deploy.head), count: status.deploy.pendingCommits ?? 0 })
                    : t("production.neverDeployed", "No deployment recorded yet: the first deploy rebuilds and restarts every service.")}
                </p>
              )}
              <ul className="production-modal__services">
                {status.ops.services.map((service) => (
                  <li key={service.id}>
                    <span className={`production-modal__dot ${service.active ? "production-modal__dot--up" : "production-modal__dot--down"}`} aria-hidden="true" />
                    <span className="production-modal__service-label">{service.label}</span>
                    <code>{service.unit}</code>
                    <span>{service.active ? t("production.active", "running") : t("production.inactive", "stopped")}</span>
                    <button type="button" className="btn btn-sm" disabled={disabled} data-testid={`production-restart-${service.id}`}
                      onClick={() => void act("restart", service.id, t("production.confirmRestart", "Restart {{unit}}?", { unit: service.unit }))}>
                      {t("production.restart", "Restart")}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-primary" disabled={disabled} data-testid="production-deploy-button"
                onClick={() => void act("deploy", undefined, t("production.confirmDeploy", "Deploy {{branch}}? Changed services are rebuilt and restarted.", { branch: status.merge.productionBranch }))}>
                {t("production.deploy", "Deploy")}
              </button>
            </section>
          )}

          {status?.ops?.kind === "fusion-self" && (
            <section className="production-modal__section" data-testid="production-fusion">
              <h4>{t("production.fusionTitle", "Fusion")}</h4>
              <p className="production-modal__hint">{t("production.fusionHint", "Engines are paused, running agents are allowed to finish, then Fusion restarts and engines resume. Update also builds and installs branch {{branch}} first; if the new version does not start, the previous one is restored.", { branch: status.merge.productionBranch })}</p>
              <div className="production-modal__actions">
                <button type="button" className="btn btn-primary" disabled={disabled} data-testid="production-fusion-update"
                  onClick={() => void act("update", undefined, t("production.confirmUpdate", "Build and install Fusion from {{branch}}, then restart it?", { branch: status.merge.productionBranch }))}>
                  {t("production.update", "Update Fusion")}
                </button>
                <button type="button" className="btn" disabled={disabled} data-testid="production-fusion-restart"
                  onClick={() => void act("restart", undefined, t("production.confirmRestartFusion", "Restart Fusion once running agents have finished?"))}>
                  {t("production.restartFusion", "Restart Fusion")}
                </button>
              </div>
            </section>
          )}

          {status && status.runs.length > 0 && (
            <section className="production-modal__section" data-testid="production-runs">
              <h4>{t("production.runsTitle", "Recent actions")}</h4>
              <ul className="production-modal__runs">
                {status.runs.slice(0, 8).map((run: ProductionRun) => (
                  <li key={run.instance}>
                    <button type="button" className="btn btn-sm" onClick={() => setSelectedRun(run.instance)} aria-pressed={selectedRun === run.instance}>
                      {run.instance}
                    </button>
                    <span className={`production-modal__run production-modal__run--${run.status}`}>{t(`production.runStatus.${run.status}`, run.status)}</span>
                    <span>{run.status === "running" ? run.step : (run.error ?? (run.finishedAt ?? "").slice(11, 19))}</span>
                  </li>
                ))}
              </ul>
              {selectedRun && <pre className="production-modal__log" data-testid="production-log">{log || "…"}</pre>}
            </section>
          )}
        </div>
        <div className="modal-actions">
          <div className="modal-actions-left">
            <button type="button" className="btn" onClick={onClose}>{t("production.close", "Close")}</button>
          </div>
          <div className="modal-actions-right">
            <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>{t("production.refresh", "Refresh")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
