import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRecommendationListItem } from "@fusion/core";
import { createTaskFromRecommendation, dismissTaskRecommendation, fetchTaskRecommendations } from "../api";

export const MAX_RECOMMENDATION_PAGES = 20;
const PAGE_SIZE = 50;
export interface RecommendationActionState { running: boolean; error: string | null; }

/**
 * FNXC:TaskRecommendations 2026-08-13-04:41:
 * Insights owns user-driven row-page accumulation so project-wide advisory triage stays bounded
 * while Load more remains reachable. Offset movement uses returned source rows, not flattened item
 * count; concurrent completions may shift this advisory list, but linking a recommendation preserves
 * its parent row and never invalidates this surface's own offset.
 */
/**
 * FNXC:ProposedTasks 2026-11-15-09:18:
 * `pendingOnly` lists only proposals awaiting a decision (board Proposed column, Insights "To triage").
 * In that mode a created or dismissed proposal leaves the list immediately.
 * `refreshIntervalMs` re-reads the first window periodically so proposals from newly completed tasks appear without a reload.
 */
export interface UseTaskRecommendationsOptions {
  pendingOnly?: boolean;
  refreshIntervalMs?: number;
}

export function useTaskRecommendations(projectId?: string, options?: UseTaskRecommendationsOptions) {
  const pendingOnly = options?.pendingOnly === true;
  const refreshIntervalMs = options?.refreshIntervalMs;
  const [items, setItems] = useState<TaskRecommendationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalRowCount, setTotalRowCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [createStates, setCreateStates] = useState<Map<string, RecommendationActionState>>(new Map());
  const offsetRef = useRef(0);
  const pagesRef = useRef(0);
  const fetchingRef = useRef(false);
  const creatingRef = useRef(new Set<string>());
  const epochRef = useRef(0);
  const projectRef = useRef(projectId);

  const fetchPage = useCallback(async (reset: boolean) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    const epoch = epochRef.current;
    const offset = reset ? 0 : offsetRef.current;
    if (reset) { setLoading(true); } else { setLoadingMore(true); }
    setError(null);
    try {
      const page = await fetchTaskRecommendations(projectId, { limit: PAGE_SIZE, offset, ...(pendingOnly ? { pendingOnly: true } : {}) });
      if (epoch !== epochRef.current) return;
      const merge = (current: TaskRecommendationListItem[]) => {
        const next = reset ? [] : current;
        const seen = new Set(next.map((item) => `${item.taskId}:${item.recommendation.id}`));
        return [...next, ...page.items.filter((item) => {
          const key = `${item.taskId}:${item.recommendation.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })];
      };
      setItems(merge);
      offsetRef.current = page.rowOffset + page.returnedRowCount;
      pagesRef.current = reset ? 1 : pagesRef.current + 1;
      setTotalRowCount(page.totalRowCount);
      const capped = pagesRef.current >= MAX_RECOMMENDATION_PAGES && page.hasMore;
      setTruncated(capped);
      setHasMore(capped ? false : page.hasMore);
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : "Failed to fetch task recommendations");
    } finally {
      if (epoch === epochRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
      fetchingRef.current = false;
    }
  }, [projectId, pendingOnly]);

  const refresh = useCallback(async () => {
    offsetRef.current = 0;
    pagesRef.current = 0;
    setTruncated(false);
    await fetchPage(true);
  }, [fetchPage]);

  useEffect(() => {
    projectRef.current = projectId;
    epochRef.current += 1;
    fetchingRef.current = false;
    creatingRef.current.clear();
    offsetRef.current = 0;
    pagesRef.current = 0;
    setItems([]); setHasMore(false); setTotalRowCount(0); setTruncated(false); setCreateStates(new Map());
    void fetchPage(true);
  }, [fetchPage, projectId]);

  const loadMore = useCallback(async () => {
    if (!hasMore || truncated || fetchingRef.current) return;
    await fetchPage(false);
  }, [fetchPage, hasMore, truncated]);

  const createTask = useCallback(async (taskId: string, recommendationId: string) => {
    const key = `${taskId}:${recommendationId}`;
    if (creatingRef.current.has(key)) return;
    creatingRef.current.add(key);
    const epoch = epochRef.current;
    setCreateStates((current) => new Map(current).set(key, { running: true, error: null }));
    try {
      const response = await createTaskFromRecommendation(taskId, recommendationId, projectRef.current);
      if (epoch !== epochRef.current) return;
      setItems((current) => pendingOnly
        ? current.filter((item) => !(item.taskId === taskId && item.recommendation.id === recommendationId))
        : current.map((item) => item.taskId === taskId && item.recommendation.id === recommendationId
          ? { ...item, recommendation: { ...item.recommendation, createdTaskId: response.task.id } }
          : item));
      setCreateStates((current) => new Map(current).set(key, { running: false, error: null }));
    } catch (cause) {
      if (epoch === epochRef.current) setCreateStates((current) => new Map(current).set(key, { running: false, error: cause instanceof Error ? cause.message : "Could not create task" }));
    } finally {
      // FNXC:TaskRecommendations 2026-08-13-04:41: An old project's completion must not
      // clear the same composite key after a project switch has started a new create request.
      if (epoch === epochRef.current) creatingRef.current.delete(key);
    }
  }, [pendingOnly]);

  const dismiss = useCallback(async (taskId: string, recommendationId: string, dismissed = true) => {
    const key = `${taskId}:${recommendationId}`;
    if (creatingRef.current.has(key)) return;
    creatingRef.current.add(key);
    const epoch = epochRef.current;
    setCreateStates((current) => new Map(current).set(key, { running: true, error: null }));
    try {
      await dismissTaskRecommendation(taskId, recommendationId, projectRef.current, dismissed);
      if (epoch !== epochRef.current) return;
      const dismissedAt = dismissed ? new Date().toISOString() : undefined;
      setItems((current) => pendingOnly && dismissed
        ? current.filter((item) => !(item.taskId === taskId && item.recommendation.id === recommendationId))
        : current.map((item) => item.taskId === taskId && item.recommendation.id === recommendationId
          ? { ...item, recommendation: { ...item.recommendation, dismissedAt } }
          : item));
      setCreateStates((current) => new Map(current).set(key, { running: false, error: null }));
    } catch (cause) {
      if (epoch === epochRef.current) setCreateStates((current) => new Map(current).set(key, { running: false, error: cause instanceof Error ? cause.message : "Could not dismiss proposal" }));
    } finally {
      if (epoch === epochRef.current) creatingRef.current.delete(key);
    }
  }, [pendingOnly]);

  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) return;
    const timer = setInterval(() => {
      if (pagesRef.current <= 1 && !fetchingRef.current) void fetchPage(true);
    }, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [fetchPage, refreshIntervalMs]);

  return { items, loading, loadingMore, error, hasMore, totalRowCount, truncated, refresh, loadMore, createTask, dismiss, createStates };
}
