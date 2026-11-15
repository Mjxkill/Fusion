import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionModal } from "../ProductionModal";

vi.mock("../../api", () => ({
  fetchProductionStatus: vi.fn(),
  fetchProductionRunLog: vi.fn(),
  mergeIntegrationToProduction: vi.fn(),
  startProductionAction: vi.fn(),
}));

import { fetchProductionRunLog, fetchProductionStatus, mergeIntegrationToProduction, startProductionAction } from "../../api";

const mockStatus = vi.mocked(fetchProductionStatus);
const mockMerge = vi.mocked(mergeIntegrationToProduction);
const mockStart = vi.mocked(startProductionAction);

function merge(overrides: Record<string, unknown> = {}) {
  return {
    productionBranch: "main",
    integrationBranch: "integration",
    currentBranch: "main",
    commits: [{ sha: "a".repeat(40), subject: "VIDE-1: change" }],
    filesChanged: ["api/app.py"],
    productionOnlyCommits: 0,
    conflict: false,
    localChanges: [],
    localChangesTouched: [],
    blockedReason: null,
    ...overrides,
  };
}

const webOps = { id: "videasy", label: "Videasy", kind: "web" as const, services: [{ id: "api", label: "API", unit: "videasy-api", active: true }, { id: "web", label: "Web", unit: "videasy-web", active: false }] };

/*
FNXC:ProductionOps 2026-11-15-12:00:
The Production panel shows what will be merged and why a merge is blocked, confirms every action, and disables its buttons while an action runs.
*/
describe("ProductionModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchProductionRunLog).mockResolvedValue("");
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows why the merge is blocked and keeps the button disabled", async () => {
    mockStatus.mockResolvedValue({ ops: null, merge: merge({ blockedReason: "modifications locales non commitées sur des fichiers fusionnés : api/app.py" }), deploy: null, runs: [] });

    render(<ProductionModal projectId="p1" onClose={vi.fn()} />);

    expect((await screen.findByTestId("production-merge-blocked")).textContent).toContain("api/app.py");
    expect((screen.getByTestId("production-merge-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Declare it in \/etc\/fusion\/ops.json/)).toBeDefined();
  });

  it("merges after confirmation and reports the result", async () => {
    mockStatus.mockResolvedValue({ ops: null, merge: merge(), deploy: null, runs: [] });
    mockMerge.mockResolvedValue({ head: "b".repeat(40), merged: 1 });

    render(<ProductionModal projectId="p1" onClose={vi.fn()} />);
    const button = await screen.findByTestId("production-merge-button");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Merge 1 commits from integration into main"));
    expect(mockMerge).toHaveBeenCalledWith("p1");
    expect(await screen.findByText(/1 commits merged into main \(bbbbbbbb\)/)).toBeDefined();
  });

  it("does nothing when the operator cancels the confirmation", async () => {
    mockStatus.mockResolvedValue({ ops: webOps, merge: merge(), deploy: { deployedSha: null, head: "c".repeat(40), pendingCommits: null }, runs: [] });
    vi.mocked(window.confirm).mockReturnValue(false);

    render(<ProductionModal projectId="p1" onClose={vi.fn()} />);
    const deploy = await screen.findByTestId("production-deploy-button");
    await act(async () => {
      fireEvent.click(deploy);
    });

    expect(mockStart).not.toHaveBeenCalled();
  });

  it("restarts one service and disables every action until its run appears", async () => {
    mockStatus.mockResolvedValue({ ops: webOps, merge: merge({ commits: [], blockedReason: "rien à fusionner" }), deploy: { deployedSha: "d".repeat(40), head: "d".repeat(40), pendingCommits: 0 }, runs: [] });
    mockStart.mockResolvedValue({ instance: "videasy--restart--web" });

    render(<ProductionModal projectId="p1" onClose={vi.fn()} />);
    const restart = await screen.findByTestId("production-restart-web");
    await act(async () => {
      fireEvent.click(restart);
    });

    expect(mockStart).toHaveBeenCalledWith("restart", "web", "p1");
    expect((screen.getByTestId("production-deploy-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("production-restart-api") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers update and restart for the Fusion project", async () => {
    mockStatus.mockResolvedValue({ ops: { id: "fusion", label: "Fusion", kind: "fusion-self", services: [] }, merge: merge({ productionBranch: "production" }), deploy: null, runs: [] });
    mockStart.mockResolvedValue({ instance: "fusion--update" });

    render(<ProductionModal projectId="p2" onClose={vi.fn()} />);
    const update = await screen.findByTestId("production-fusion-update");
    expect(screen.getByTestId("production-fusion-restart")).toBeDefined();
    await act(async () => {
      fireEvent.click(update);
    });

    expect(mockStart).toHaveBeenCalledWith("update", undefined, "p2");
  });
});
