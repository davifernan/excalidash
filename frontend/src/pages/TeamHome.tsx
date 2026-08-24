import React from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, PenTool, Users } from "lucide-react";
import * as api from "../api";
import type { TeamMember } from "../api";
import { Layout } from "../components/Layout";
import { DataFailureNotice } from "../components/DataFailureNotice";
import { MemberAvatar } from "../components/MemberAvatar";
import type { DrawingSummary } from "../types";
import { displayFontFamily } from "../utils/displayFont";
import { useTeamHomeData } from "./team/useTeamHomeData";
import { RecentBoardCard } from "./team/RecentBoardCard";
import {
  presenceKeysFor,
  type TeamPresenceByMember,
  useDashboardPresence,
  useTeamPresence,
} from "./dashboard/useDashboardPresence";

const resolveMemberBoard = (
  member: TeamMember,
  teamPresence: TeamPresenceByMember | null,
  recentBoards: readonly DrawingSummary[],
) => {
  const boardId = teamPresence?.get(member.subjectKey);
  return boardId ? recentBoards.find((drawing) => drawing.id === boardId) : undefined;
};

export const TeamHome: React.FC = () => {
  const navigate = useNavigate();
  const {
    recentBoards,
    collections,
    team,
    isLoading,
    recentBoardsError,
    collectionsError,
    teamError,
    retryRecentBoards,
    retryTeam,
  } = useTeamHomeData();

  const presence = useDashboardPresence(recentBoards.map((drawing) => drawing.id));
  const teamPresence = useTeamPresence(recentBoards.map((drawing) => drawing.id));

  /**
   * One line for the Sidebar's "Team Home" entry (NIL-294), e.g. "Davi is
   * currently in Roadmap Q4". Picks the first teammate (not self) with a
   * known location; self is excluded because "you are currently in X" is
   * not useful ambient info about your own sidebar entry. `null` while
   * nobody's location is known, same as no team member being online.
   */
  const teamHomeStatus = React.useMemo(() => {
    if (!team || !teamPresence) return null;
    for (const member of team.members) {
      if (member.isSelf) continue;
      const board = resolveMemberBoard(member, teamPresence, recentBoards);
      if (!board) continue;
      return `${member.name} is currently in ${board.name}`;
    }
    return null;
  }, [team, teamPresence, recentBoards]);

  const handleCreateCollection = async (name: string) => {
    await api.createCollection(name);
  };
  const handleEditCollection = async (id: string, name: string) => {
    await api.updateCollection(id, name);
  };
  const handleDeleteCollection = async (id: string) => {
    await api.deleteCollection(id);
  };
  const handleSelectCollection = (id: string | null | undefined) => {
    if (id === undefined) navigate("/collections");
    else if (id === null) navigate("/collections?id=unorganized");
    else navigate(`/collections?id=${id}`);
  };
  const handleOpenBoard = (id: string) => navigate(`/editor/${id}`);

  return (
    <Layout
      collections={collections}
      selectedCollectionId="TEAM_HOME"
      onSelectCollection={handleSelectCollection}
      onCreateCollection={handleCreateCollection}
      onEditCollection={handleEditCollection}
      onDeleteCollection={handleDeleteCollection}
      teamHomeStatus={teamHomeStatus}
    >
      <div className="flex items-center justify-between mb-6 lg:mb-8">
        <h1
          className="text-3xl sm:text-4xl lg:text-5xl text-slate-900 dark:text-white pl-1"
          style={{ fontFamily: displayFontFamily }}
        >
          Team Home
        </h1>
      </div>

      {collectionsError && <DataFailureNotice message={collectionsError} compact />}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-6 lg:gap-8">
        <section aria-labelledby="team-home-recent-heading">
          <h2
            id="team-home-recent-heading"
            className="text-sm font-black uppercase tracking-wider text-slate-400 dark:text-neutral-500 mb-3"
          >
            Recent boards
          </h2>

          {recentBoardsError ? (
            <DataFailureNotice message={recentBoardsError} onRetry={retryRecentBoards} />
          ) : isLoading ? (
            <div
              role="status"
              aria-label="Loading recent boards"
              className="flex items-center justify-center py-16"
            >
              <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" aria-hidden="true" />
            </div>
          ) : recentBoards.length === 0 ? (
            <div className="border-2 border-dashed border-slate-300 dark:border-neutral-700 rounded-2xl p-10 sm:p-14 text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-white dark:bg-neutral-900 border-2 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] flex items-center justify-center mb-4">
                <PenTool size={22} className="text-indigo-500" aria-hidden="true" />
              </div>
              <h3 className="text-lg font-black text-slate-900 dark:text-white mb-1">
                No boards yet
              </h3>
              <p className="text-sm font-bold text-slate-500 dark:text-neutral-400 mb-5">
                Create the first board to get your team started.
              </p>
              <button
                type="button"
                onClick={() => navigate("/collections")}
                className="inline-flex items-center gap-2 rounded-lg border-2 border-black dark:border-neutral-700 bg-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] hover:-translate-y-0.5 transition-all"
              >
                <PenTool size={16} aria-hidden="true" /> New Drawing
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recentBoards.map((drawing) => (
                <RecentBoardCard
                  key={drawing.id}
                  drawing={drawing}
                  onlineKeys={presenceKeysFor(presence, drawing.id)}
                  onOpen={handleOpenBoard}
                />
              ))}
            </div>
          )}

          {recentBoards.length > 0 && (
            <button
              type="button"
              onClick={() => navigate("/collections")}
              className="mt-4 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              See all boards →
            </button>
          )}
        </section>

        <aside aria-labelledby="team-home-roster-heading">
          <h2
            id="team-home-roster-heading"
            className="flex items-center gap-1.5 text-sm font-black uppercase tracking-wider text-slate-400 dark:text-neutral-500 mb-3"
          >
            <Users size={14} aria-hidden="true" /> Team
          </h2>
          {teamError ? (
            <DataFailureNotice message={teamError} onRetry={retryTeam} compact />
          ) : isLoading ? (
            <div role="status" aria-label="Loading team" className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" aria-hidden="true" />
            </div>
          ) : (
            <ul className="space-y-2">
              {team?.members.map((member) => {
                const currentBoard = resolveMemberBoard(member, teamPresence, recentBoards);
                return (
                  <li
                    key={member.subjectKey}
                    className="flex items-center gap-2.5 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]"
                  >
                    <MemberAvatar
                      name={member.name}
                      initials={member.initials}
                      color={member.color}
                      size={28}
                      online={!!currentBoard}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-sm text-slate-900 dark:text-white truncate">
                        {member.name}
                        {member.isSelf && (
                          <span className="ml-1 text-[10px] font-black text-slate-400 dark:text-neutral-500">
                            (you)
                          </span>
                        )}
                      </p>
                      {currentBoard && (
                        <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 truncate">
                          Currently in {currentBoard.name}
                        </p>
                      )}
                    </div>
                    {member.role === "owner" && (
                      <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border bg-slate-100 dark:bg-neutral-800 text-slate-400 dark:text-neutral-500 border-slate-200 dark:border-neutral-700">
                        Owner
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </Layout>
  );
};
