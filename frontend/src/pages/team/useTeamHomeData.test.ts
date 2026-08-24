import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTeamHomeData } from "./useTeamHomeData";
import * as api from "../../api";

vi.mock("../../api");

describe("useTeamHomeData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads recent boards, collections, and the team roster in parallel", async () => {
    vi.mocked(api.getDrawings).mockResolvedValue({
      drawings: [
        {
          id: "d1",
          name: "Board",
          collectionId: null,
          updatedAt: 1,
          createdAt: 1,
          version: 1,
        } as any,
      ],
      totalCount: 1,
    });
    vi.mocked(api.getCollections).mockResolvedValue([]);
    vi.mocked(api.getTeam).mockResolvedValue({ name: "Team", members: [] });

    const { result } = renderHook(() => useTeamHomeData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.recentBoards).toHaveLength(1);
    expect(result.current.team).toEqual({ name: "Team", members: [] });
    expect(vi.mocked(api.getDrawings)).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({ sortField: "updatedAt", sortDirection: "desc" }),
    );
  });

  it("keeps each source's error independent -- a failed team fetch does not clear loaded boards", async () => {
    vi.mocked(api.getDrawings).mockResolvedValue({
      drawings: [
        {
          id: "d1",
          name: "Board",
          collectionId: null,
          updatedAt: 1,
          createdAt: 1,
          version: 1,
        } as any,
      ],
      totalCount: 1,
    });
    vi.mocked(api.getCollections).mockResolvedValue([]);
    vi.mocked(api.getTeam).mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useTeamHomeData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.recentBoards).toHaveLength(1);
    expect(result.current.recentBoardsError).toBeNull();
    expect(result.current.teamError).not.toBeNull();
    expect(result.current.team).toBeNull();
  });

  it("retryTeam re-fetches only the team roster", async () => {
    vi.mocked(api.getDrawings).mockResolvedValue({ drawings: [], totalCount: 0 });
    vi.mocked(api.getCollections).mockResolvedValue([]);
    vi.mocked(api.getTeam)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ name: "Team", members: [] });

    const { result } = renderHook(() => useTeamHomeData());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.teamError).not.toBeNull();

    result.current.retryTeam();

    await waitFor(() => expect(result.current.team).toEqual({ name: "Team", members: [] }));
    expect(result.current.teamError).toBeNull();
    expect(vi.mocked(api.getDrawings)).toHaveBeenCalledTimes(1);
  });
});
