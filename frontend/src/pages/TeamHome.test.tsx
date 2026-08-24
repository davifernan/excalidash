import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TeamHome } from "./TeamHome";

const mockUseTeamHomeData = vi.fn();
const mockUseDashboardPresence = vi.fn();
const mockUseTeamPresence = vi.fn();
const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("./team/useTeamHomeData", () => ({
  useTeamHomeData: () => mockUseTeamHomeData(),
}));

vi.mock("./dashboard/useDashboardPresence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard/useDashboardPresence")>();
  return {
    ...actual,
    useDashboardPresence: (...args: unknown[]) => mockUseDashboardPresence(...args),
    useTeamPresence: (...args: unknown[]) => mockUseTeamPresence(...args),
  };
});

vi.mock("../components/Layout", () => ({
  // Renders teamHomeStatus too (not just children) so tests can assert on
  // exactly what TeamHome computes and hands to the Sidebar (NIL-294) --
  // Sidebar.test.tsx separately proves that value actually renders there.
  Layout: ({
    children,
    teamHomeStatus,
  }: {
    children: React.ReactNode;
    teamHomeStatus?: string | null;
  }) => (
    <div>
      <div data-testid="team-home-status">{teamHomeStatus ?? ""}</div>
      {children}
    </div>
  ),
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
    mockUseTeamPresence.mockReturnValue(null);
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

  it("says which board a team member is currently on, but only for a member with a known location", () => {
    mockUseTeamHomeData.mockReturnValue({
      ...baseData,
      recentBoards: [
        {
          id: "d1",
          name: "Roadmap Q4",
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
            name: "Davi",
            initials: "D",
            color: "#6366f1",
            role: "owner",
            isSelf: false,
          },
          {
            subjectKey: "k2",
            name: "Someone Else",
            initials: "SE",
            color: "#f59e0b",
            role: "member",
            isSelf: true,
          },
        ],
      },
    });
    mockUseTeamPresence.mockReturnValue(new Map([["k1", "d1"]]));

    renderTeamHome();

    expect(screen.getByText("Currently in Roadmap Q4")).toBeInTheDocument();
    expect(screen.getAllByText("Currently in Roadmap Q4")).toHaveLength(1);

    // NIL-294: the same fact, handed to the Sidebar's Team Home entry as one line.
    expect(screen.getByTestId("team-home-status")).toHaveTextContent(
      "Davi is currently in Roadmap Q4",
    );
  });

  it("does not report your own location as the sidebar's team status (NIL-294)", () => {
    mockUseTeamHomeData.mockReturnValue({
      ...baseData,
      recentBoards: [
        {
          id: "d1",
          name: "Roadmap Q4",
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
            name: "Member Max",
            initials: "MM",
            color: "#f59e0b",
            role: "member",
            isSelf: true,
          },
        ],
      },
    });
    // Only the self member is on a board; nobody else's location is known.
    mockUseTeamPresence.mockReturnValue(new Map([["k1", "d1"]]));

    renderTeamHome();

    expect(screen.getByTestId("team-home-status")).toHaveTextContent("");
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
