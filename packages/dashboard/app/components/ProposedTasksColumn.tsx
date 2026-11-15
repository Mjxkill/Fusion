import { useTranslation } from "react-i18next";
import { useTaskRecommendations } from "../hooks/useTaskRecommendations";
import "./ProposedTasksColumn.css";

/** How often the Proposed column re-reads pending proposals so newly completed tasks surface without a reload. */
export const PROPOSED_TASKS_REFRESH_MS = 30_000;

export interface ProposedTasksColumnProps {
  projectId?: string;
}

/**
 * FNXC:ProposedTasks 2026-11-15-09:18:
 * Completed tasks propose follow-up tasks, but those proposals were scattered across mailbox notices and per-task detail tabs, so operators had to scan every message.
 * The board now opens with a "Proposed" column, placed before planning, that gathers every pending proposal of the project.
 * Each card offers "Create task" (normal guarded intake, the new task enters planning like any other) and "Dismiss" (the proposal leaves the pending views and stays on its source task).
 * The column holds proposals, not tasks: no drag and drop, no task context menu.
 */
export function ProposedTasksColumn({ projectId }: ProposedTasksColumnProps) {
  const { t } = useTranslation("app");
  const proposals = useTaskRecommendations(projectId, { pendingOnly: true, refreshIntervalMs: PROPOSED_TASKS_REFRESH_MS });

  return (
    <div className="column proposed-tasks-column" data-column="proposed" data-testid="proposed-tasks-column">
      <div className="column-header">
        <div className="column-dot dot-triage" />
        <h2>{t("proposedTasks.title", "Proposed")}</h2>
        <span className="column-count" data-testid="proposed-tasks-count">{proposals.items.length}{proposals.hasMore ? "+" : ""}</span>
      </div>
      <div className="column-body">
        {proposals.loading && proposals.items.length === 0 && (
          <div className="empty-column">{t("proposedTasks.loading", "Loading proposals…")}</div>
        )}
        {!proposals.loading && proposals.items.length === 0 && !proposals.error && (
          <div className="empty-column" data-testid="proposed-tasks-empty">{t("proposedTasks.empty", "No pending proposals")}</div>
        )}
        {proposals.error && proposals.items.length === 0 && (
          <div className="empty-column proposed-task-card__error" role="status">
            <span>{t("proposedTasks.loadFailed", "Could not load proposals.")}</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void proposals.refresh()}>{t("actions.retry", "Retry")}</button>
          </div>
        )}
        {proposals.items.map((item) => {
          const key = `${item.taskId}:${item.recommendation.id}`;
          const action = proposals.createStates.get(key);
          return (
            <div className="card proposed-task-card" key={key} data-testid={`proposed-task-${key}`}>
              <div className="card-header">
                <span className="card-id" title={t("proposedTasks.source", "From {{taskId}}", { taskId: item.taskId })}>{item.taskId}</span>
                <span className="card-workflow-badge">{item.recommendation.category}</span>
              </div>
              <div className="card-title">{item.recommendation.title}</div>
              <div className="card-meta">
                <span className="proposed-task-card__description">{item.recommendation.description}</span>
              </div>
              <div className="card-footer-row">
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  disabled={action?.running}
                  data-testid={`proposed-task-create-${key}`}
                  onClick={() => void proposals.createTask(item.taskId, item.recommendation.id)}
                >
                  {action?.running ? t("taskDetail.recommendations.creating", "Creating…") : t("taskDetail.recommendations.create", "Create task")}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={action?.running}
                  data-testid={`proposed-task-dismiss-${key}`}
                  onClick={() => void proposals.dismiss(item.taskId, item.recommendation.id)}
                >
                  {t("proposedTasks.dismiss", "Dismiss")}
                </button>
              </div>
              {action?.error && <div className="proposed-task-card__error" role="status">{action.error}</div>}
            </div>
          );
        })}
        {proposals.hasMore && (
          <button className="btn btn-secondary btn-sm" type="button" disabled={proposals.loadingMore} onClick={() => void proposals.loadMore()}>
            {proposals.loadingMore ? t("insights.recommendations.loadingMore", "Loading more…") : t("insights.recommendations.loadMore", "Load more")}
          </button>
        )}
      </div>
    </div>
  );
}
