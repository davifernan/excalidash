import { api } from "./client";

export type TeamMember = {
  subjectKey: string;
  name: string;
  initials: string;
  color: string;
  role: "owner" | "member";
  isSelf: boolean;
};

export type Team = {
  name: string;
  members: TeamMember[];
};

/** The team roster: who is on it, and their role. Read-only (see backend/src/authz/team.ts). */
export const getTeam = async (): Promise<Team> => {
  const response = await api.get<Team>("/team");
  return response.data;
};
