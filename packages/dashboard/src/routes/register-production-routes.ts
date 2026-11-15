/**
 * FNXC:ProductionOps 2026-11-15-12:00:
 * Routes of the per-project "Production" panel (merge integration → production, deploy, restart, update Fusion).
 * Logic and safety rules live in ../production-ops.ts; this registrar only maps HTTP to it.
 */
import { badRequest, conflict, notFound, ApiError } from "../api-error.js";
import {
  ProductionError,
  defaultDeps,
  findOpsProject,
  getProductionStatus,
  mergeIntegration,
  readRunLog,
  startAction,
  type ProductionAction,
  type ProductionDeps,
} from "../production-ops.js";
import type { ApiRoutesContext } from "./types.js";

function toApiError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof ProductionError) {
    if (error.status === 400) throw badRequest(error.message);
    if (error.status === 404) throw notFound(error.message);
    throw conflict(error.message);
  }
  throw error;
}

export function registerProductionRoutes(ctx: ApiRoutesContext, deps: ProductionDeps = defaultDeps): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  router.get("/production/status", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const settings = await store.getSettings();
      res.json(await getProductionStatus(store.getRootDir(), (settings as { integrationBranch?: string }).integrationBranch, deps));
    } catch (error) {
      if (error instanceof ApiError || error instanceof ProductionError) toApiError(error);
      rethrowAsApiError(error);
    }
  });

  router.post("/production/merge", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const rootDir = store.getRootDir();
      const status = await getProductionStatus(rootDir, (await store.getSettings() as { integrationBranch?: string }).integrationBranch, deps);
      res.json(await mergeIntegration(rootDir, status.merge.productionBranch, status.merge.integrationBranch, deps));
    } catch (error) {
      if (error instanceof ApiError || error instanceof ProductionError) toApiError(error);
      rethrowAsApiError(error);
    }
  });

  router.post("/production/actions", async (req, res) => {
    try {
      const { action, service } = (req.body ?? {}) as { action?: unknown; service?: unknown };
      if (action !== "deploy" && action !== "restart" && action !== "update") throw badRequest("action must be deploy, restart or update");
      if (service !== undefined && (typeof service !== "string" || !/^[a-z0-9]+$/.test(service))) throw badRequest("invalid service");
      const { store } = await getProjectContext(req);
      res.status(202).json(await startAction(store.getRootDir(), action as ProductionAction, service as string | undefined, deps));
    } catch (error) {
      if (error instanceof ApiError || error instanceof ProductionError) toApiError(error);
      rethrowAsApiError(error);
    }
  });

  router.get("/production/runs/:instance/log", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const found = await findOpsProject(store.getRootDir(), deps);
      if (!found) throw notFound("no production config for this project");
      res.json({ log: await readRunLog(found.id, req.params.instance, deps) });
    } catch (error) {
      if (error instanceof ApiError || error instanceof ProductionError) toApiError(error);
      rethrowAsApiError(error);
    }
  });
}
