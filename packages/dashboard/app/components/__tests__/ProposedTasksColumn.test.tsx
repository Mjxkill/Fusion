import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposedTasksColumn } from "../ProposedTasksColumn";

vi.mock("../../api", () => ({
  fetchTaskRecommendations: vi.fn(),
  createTaskFromRecommendation: vi.fn(),
  dismissTaskRecommendation: vi.fn(),
}));

import { createTaskFromRecommendation, dismissTaskRecommendation, fetchTaskRecommendations } from "../../api";

const mockFetch = vi.mocked(fetchTaskRecommendations);
const mockCreate = vi.mocked(createTaskFromRecommendation);
const mockDismiss = vi.mocked(dismissTaskRecommendation);

function proposal(taskId: string, id: string) {
  return {
    taskId,
    taskTitle: `Source ${taskId}`,
    taskColumn: "done",
    updatedAt: "2026-11-15T09:00:00.000Z",
    recommendation: { id, title: `Proposal ${id}`, description: `Do ${id} as a follow-up.`, category: "feature" as const },
  };
}

function page(items: ReturnType<typeof proposal>[]) {
  return { items, rowOffset: 0, rowLimit: 50, returnedRowCount: items.length, totalRowCount: items.length, hasMore: false };
}

/*
FNXC:ProposedTasks 2026-11-15-09:18:
The Proposed column lists only pending proposals (server `pending=true`), and a proposal leaves it as soon as it is created or dismissed.
*/
describe("ProposedTasksColumn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the server for pending proposals only and shows them as cards", async () => {
    mockFetch.mockResolvedValue(page([proposal("VIDE-1", "rec-a"), proposal("VIDE-2", "rec-b")]) as never);

    render(<ProposedTasksColumn projectId="proj-1" />);

    await screen.findByText("Proposal rec-a");
    expect(screen.getByText("Proposal rec-b")).toBeDefined();
    expect(screen.getByTestId("proposed-tasks-count").textContent).toBe("2");
    expect(mockFetch).toHaveBeenCalledWith("proj-1", expect.objectContaining({ pendingOnly: true }));
  });

  it("removes a proposal once it is turned into a task", async () => {
    mockFetch.mockResolvedValue(page([proposal("VIDE-1", "rec-a"), proposal("VIDE-2", "rec-b")]) as never);
    mockCreate.mockResolvedValue({ task: { id: "VIDE-9" }, parent: { id: "VIDE-1" } } as never);

    render(<ProposedTasksColumn projectId="proj-1" />);
    const create = await screen.findByTestId("proposed-task-create-VIDE-1:rec-a");
    await act(async () => {
      fireEvent.click(create);
    });

    await waitFor(() => expect(screen.queryByText("Proposal rec-a")).toBeNull());
    expect(mockCreate).toHaveBeenCalledWith("VIDE-1", "rec-a", "proj-1");
    expect(screen.getByText("Proposal rec-b")).toBeDefined();
  });

  it("does not bring back a created proposal when an older refresh resolves afterwards", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch.mockResolvedValue(page([proposal("VIDE-1", "rec-a"), proposal("VIDE-2", "rec-b")]) as never);
      mockCreate.mockResolvedValue({ task: { id: "VIDE-9" }, parent: { id: "VIDE-1" } } as never);

      render(<ProposedTasksColumn projectId="proj-1" />);
      const create = await screen.findByTestId("proposed-task-create-VIDE-1:rec-a");
      await act(async () => {
        fireEvent.click(create);
      });
      await waitFor(() => expect(screen.queryByText("Proposal rec-a")).toBeNull());

      // The server-side link may lag: the periodic refresh still lists the created proposal.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.queryByText("Proposal rec-a")).toBeNull();
      expect(screen.getByText("Proposal rec-b")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a proposal once it is dismissed", async () => {
    mockFetch.mockResolvedValue(page([proposal("VIDE-1", "rec-a")]) as never);
    mockDismiss.mockResolvedValue({ parent: { id: "VIDE-1" } } as never);

    render(<ProposedTasksColumn projectId="proj-1" />);
    const dismiss = await screen.findByTestId("proposed-task-dismiss-VIDE-1:rec-a");
    await act(async () => {
      fireEvent.click(dismiss);
    });

    await screen.findByTestId("proposed-tasks-empty");
    expect(mockDismiss).toHaveBeenCalledWith("VIDE-1", "rec-a", "proj-1", true);
  });

  it("keeps the proposal and shows the error when dismissal fails", async () => {
    mockFetch.mockResolvedValue(page([proposal("VIDE-1", "rec-a")]) as never);
    mockDismiss.mockRejectedValue(new Error("Recommendation is already linked to a task"));

    render(<ProposedTasksColumn projectId="proj-1" />);
    const dismiss = await screen.findByTestId("proposed-task-dismiss-VIDE-1:rec-a");
    await act(async () => {
      fireEvent.click(dismiss);
    });

    await screen.findByText("Recommendation is already linked to a task");
    expect(screen.getByText("Proposal rec-a")).toBeDefined();
  });

  it("says when nothing is pending", async () => {
    mockFetch.mockResolvedValue(page([]) as never);

    render(<ProposedTasksColumn projectId="proj-1" />);

    await screen.findByTestId("proposed-tasks-empty");
    expect(screen.getByTestId("proposed-tasks-count").textContent).toBe("0");
  });
});
