import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import type { Collection, DrawingSummary } from "../../types";
import type { Team } from "../../api";
import { log } from "../../logging";

/** Enough to fill a card row without turning Team Home into the Dashboard. */
export const RECENT_BOARDS_LIMIT = 8;

export type TeamHomeData = {
  recentBoards: DrawingSummary[];
  collections: Collection[];
  team: Team | null;
  isLoading: boolean;
  recentBoardsError: string | null;
  collectionsError: string | null;
  teamError: string | null;
  retryRecentBoards: () => void;
  retryTeam: () => void;
};

const FAILURE_MESSAGE =
  "We couldn't load this. The server may be restarting or your connection may be offline. Check your connection and try again.";

export const useTeamHomeData = (): TeamHomeData => {
  const [recentBoards, setRecentBoards] = useState<DrawingSummary[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [team, setTeam] = useState<Team | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [recentBoardsError, setRecentBoardsError] = useState<string | null>(null);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const loadRecentBoards = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setRecentBoardsError(null);
    try {
      const result = await api.getDrawings(undefined, undefined, {
        includePreview: true,
        limit: RECENT_BOARDS_LIMIT,
        offset: 0,
        sortField: "updatedAt",
        sortDirection: "desc",
      });
      if (requestVersion !== requestVersionRef.current) return;
      setRecentBoards(result.drawings);
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return;
      log.error("Failed to fetch recent boards", { error }, { notify: false });
      setRecentBoardsError(FAILURE_MESSAGE);
    }
  }, []);

  const loadTeam = useCallback(async () => {
    setTeamError(null);
    try {
      const result = await api.getTeam();
      setTeam(result);
    } catch (error) {
      log.error("Failed to fetch team roster", { error }, { notify: false });
      setTeamError(FAILURE_MESSAGE);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadCollections = async () => {
      try {
        const result = await api.getCollections();
        if (!cancelled) setCollections(result);
      } catch (error) {
        if (!cancelled) {
          log.error("Failed to fetch collections", { error }, { notify: false });
          setCollectionsError(FAILURE_MESSAGE);
        }
      }
    };

    setIsLoading(true);
    Promise.allSettled([loadRecentBoards(), loadTeam(), loadCollections()]).finally(() => {
      if (!cancelled) setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time initial load; loadRecentBoards/loadTeam are also exposed as manual retries below
  }, []);

  return {
    recentBoards,
    collections,
    team,
    isLoading,
    recentBoardsError,
    collectionsError,
    teamError,
    retryRecentBoards: () => void loadRecentBoards(),
    retryTeam: () => void loadTeam(),
  };
};
