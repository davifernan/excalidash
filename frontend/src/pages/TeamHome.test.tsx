import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TeamHome } from "./TeamHome";

const mockUseTeamHomeData = vi.fn();
const mockUseDashboardPresence = vi.fn();
const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("./team/useTeamHomeData", () => ({
  useTeamHomeData: () => mockUseTeamHomeData(),
}));

vi.mock("./dashboard/useDashboardPresence", () => ({
  useDashboardPresence: (...args: unknown[]) => mockUseDashboardPresence(...args),
}));

vi.mock("../components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const baseData = {
  recentBoards: [],
  collections: [],
  team: { name: "Team", members: [] },
  isLoading: false,
  recentBoardsError: null,
  collectionsError: null,
  teamError: null,
  retryRecentBoards: vi.fn(),
  retryTeam: vi.fn(),
};

const renderTeamHome = () =>
  render(
    <MemoryRouter>
      <TeamHome />
    </MemoryRouter>,
  );

describe("TeamHome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDashboardPresence.mockReturnValue(null);
    mockUseTeamHomeData.mockReturnValue(baseData);
  });

  it("shows a loading indicator while data is loading", () => {
    mockUseTeamHomeData.mockReturnValue({ ...baseData, isLoading: true });
    renderTeamHome();
    expect(screen.getByRole("status", { name: /loading recent boards/i })).toBeInTheDocument();
  });

  it("shows a create-first-board prompt when the team has no boards yet, not the generic empty state", () => {
    renderTeamHome();
    expect(screen.getByText("No boards yet")).toBeInTheDocument();
    expect(screen.queryByText(/no drawings found/i)).not.toBeInTheDocument();
  });

  it("renders recent boards and the team roster once data has loaded", () => {
    mockUseTeamHomeData.mockReturnValue({
      ...baseData,
      recentBoards: [
        {
          id: "d1",
          name: "Roadmap Sketch",
          collectionId: null,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          version: 1,
          preview: null,
        },
      ],
      team: {
        name: "Team",
        members: [
          {
            subjectKey: "k1",
            name: "Owner Olga",
            initials: "OO",
            color: "#6366f1",
            role: "owner",
            isSelf: false,
          },
          {
            subjectKey: "k2",
            name: "Member Max",
            initials: "MM",
            color: "#f59e0b",
            role: "member",
            isSelf: true,
          },
        ],
      },
    });

    renderTeamHome();

    expect(screen.getByText("Roadmap Sketch")).toBeInTheDocument();
    expect(screen.getByText("Owner Olga")).toBeInTheDocument();
    expect(screen.getByText("Member Max")).toBeInTheDocument();
    expect(screen.getByText("(you)")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("shows a per-section error with retry when recent boards fail to load, without blanking the roster", () => {
    mockUseTeamHomeData.mockReturnValue({
      ...baseData,
      recentBoardsError: "We couldn't load this.",
      team: {
        name: "Team",
        members: [
          {
            subjectKey: "k1",
            name: "Owner Olga",
            initials: "OO",
            color: "#6366f1",
            role: "owner",
            isSelf: false,
          },
        ],
      },
    });

    renderTeamHome();

    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't load this.");
    expect(screen.getByText("Owner Olga")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(baseData.retryRecentBoards).toHaveBeenCalled();
  });

  it("navigates to the board when a recent board card is clicked", () => {
    mockUseTeamHomeData.mockReturnValue({
      ...baseData,
      recentBoards: [
        {
          id: "d1",
          name: "Roadmap Sketch",
          collectionId: null,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          version: 1,
          preview: null,
        },
      ],
    });

    renderTeamHome();
    fireEvent.click(screen.getByRole("button", { name: "Open Roadmap Sketch" }));
    expect(mockNavigate).toHaveBeenCalledWith("/editor/d1");
  });
});
