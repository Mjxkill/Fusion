import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAnalysisModal } from "../ProjectAnalysisModal";

vi.mock("../../api", () => ({
  applyProjectAnalysis: vi.fn(),
  cancelProjectAnalysis: vi.fn(),
  fetchLatestProjectAnalysis: vi.fn(),
  fetchModels: vi.fn(),
  startProjectAnalysis: vi.fn(),
}));

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value }: { value: string }) => <div data-testid="model-dropdown">{value}</div>,
}));

import { applyProjectAnalysis, fetchLatestProjectAnalysis, fetchModels, startProjectAnalysis } from "../../api";

const mockLatest = vi.mocked(fetchLatestProjectAnalysis);
const mockStart = vi.mocked(startProjectAnalysis);
const mockApply = vi.mocked(applyProjectAnalysis);

const plan = {
  summary: "Studio vidéo.",
  goals: [{ ref: "g1", title: "Publier", selected: true }],
  missions: [{
    title: "Génération",
    selected: true,
    milestones: [{ title: "Image", selected: true, slices: [{ title: "ComfyUI", selected: true, features: [
      { title: "flux2_image", status: "done" as const, evidence: "api/studio/generators/_image.py", selected: true },
      { title: "qwen_image", status: "todo" as const, existingFeatureId: "F-1", selected: true },
    ] }] }],
  }],
};

/*
FNXC:ProjectAnalysis 2026-11-15-10:14:
The dialog starts the analysis with the operator's default model (ollama-cloud / deepseek-v4.1-flash), shows the detected tree for review, and applies the reviewed (edited) plan.
*/
describe("ProjectAnalysisModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchModels).mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] } as never);
  });

  it("starts an analysis with deepseek-v4.1-flash by default", async () => {
    mockLatest.mockResolvedValue({ job: null });
    mockStart.mockResolvedValue({ id: "a1", status: "running", startedAt: "2026-11-15T10:00:00Z", progress: "", modelId: "deepseek-v4.1-flash" } as never);

    render(<ProjectAnalysisModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
    expect((await screen.findByTestId("model-dropdown")).textContent).toBe("ollama-cloud/deepseek-v4.1-flash");
    const start = await screen.findByTestId("project-analysis-start");
    await act(async () => {
      fireEvent.click(start);
    });

    expect(mockStart).toHaveBeenCalledWith("p1", { modelProvider: "ollama-cloud", modelId: "deepseek-v4.1-flash" });
    await screen.findByTestId("project-analysis-running");
  });

  it("reviews the detected tree and applies the edited plan", async () => {
    mockLatest.mockResolvedValue({ job: { id: "a1", status: "complete", startedAt: "2026-11-15T10:00:00Z", progress: "", plan } as never });
    mockApply.mockResolvedValue({ report: { goalsCreated: 1, goalsLinked: 1, goalsSkipped: [], missionsCreated: 1, milestonesCreated: 1, slicesCreated: 1, featuresCreated: 1, featuresUpdated: 1, featureStatusKeptForLinkedTask: 0 } });
    const onApplied = vi.fn();

    render(<ProjectAnalysisModal projectId="p1" onClose={vi.fn()} onApplied={onApplied} />);
    await screen.findByTestId("project-analysis-review");
    expect(screen.getByText("api/studio/generators/_image.py")).toBeDefined();
    expect(screen.getAllByText("existing")).toHaveLength(1);

    const statusSelects = screen.getAllByLabelText("Status") as HTMLSelectElement[];
    fireEvent.change(statusSelects[1]!, { target: { value: "in-progress" } });
    fireEvent.click(screen.getByLabelText("flux2_image"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-analysis-apply"));
    });

    await screen.findByTestId("project-analysis-report");
    const sentPlan = mockApply.mock.calls[0]![1];
    const features = sentPlan.missions[0]!.milestones[0]!.slices[0]!.features;
    expect(features[0]).toMatchObject({ title: "flux2_image", selected: false });
    expect(features[1]).toMatchObject({ title: "qwen_image", status: "in-progress" });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it("reports a failed analysis and offers to start again", async () => {
    mockLatest.mockResolvedValue({ job: { id: "a1", status: "error", startedAt: "2026-11-15T10:00:00Z", progress: "", error: "The analysis returned no mission" } as never });

    render(<ProjectAnalysisModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);

    await screen.findByText(/The analysis returned no mission/);
    expect(screen.getByTestId("project-analysis-start")).toBeDefined();
  });
});
