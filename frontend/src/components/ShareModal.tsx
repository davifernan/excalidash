import React, { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { X, Link as LinkIcon, AlertTriangle, Check, RefreshCw } from "lucide-react";
import * as api from "../api";
import { useAuth } from "../context/AuthContext";
import { GeneralAccessSection } from "./share-modal/GeneralAccessSection";
import { GuestCapabilitiesSection } from "./share-modal/GuestCapabilitiesSection";
import { SharePeopleSection } from "./share-modal/SharePeopleSection";
import {
  calculateExpiresAt,
  DEFAULT_EDIT_EXPIRY_OPTION,
  toDatetimeLocalFromIso,
} from "./share-modal/shareUtils";

type Props = {
  drawingId: string;
  drawingName: string;
  isOpen: boolean;
  onClose: () => void;
};

export const ShareModal: React.FC<Props> = ({ drawingId, drawingName, isOpen, onClose }) => {
  const { user } = useAuth();
  const currentUserId = user?.id || null;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<{
    permissions: api.DrawingPermissionRow[];
    linkShares: api.DrawingLinkShareRow[];
    roster: api.DrawingRosterRow[];
  } | null>(null);
  const [guestCapabilities, setGuestCapabilities] = useState<api.GuestCapabilitySettings | null>(
    null,
  );

  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<api.ShareResolvedUser[]>([]);
  const [userPermission, setUserPermission] = useState<"view" | "comment" | "edit">("view");
  const [linkPermission, setLinkPermission] = useState<"view" | "comment" | "edit">("view");
  const [expiryOption, setExpiryOption] = useState("1d");
  const [customExpiry, setCustomExpiry] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [currentLinkToken, setCurrentLinkToken] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const activeLink = useMemo(() => {
    const now = Date.now();
    return (
      (sharing?.linkShares || []).find((s) => {
        if (s.revokedAt) return false;
        if (!s.expiresAt) return true;
        const ts = Date.parse(String(s.expiresAt));
        if (!Number.isFinite(ts)) return false;
        return ts > now;
      }) || null
    );
  }, [sharing]);

  useEffect(() => {
    if (!isOpen) return;
    if (!activeLink) return;
    setLinkPermission(activeLink.permission);
    if (activeLink.expiresAt) {
      setExpiryOption("custom");
      setCustomExpiry(toDatetimeLocalFromIso(activeLink.expiresAt));
    } else {
      setExpiryOption("never");
      setCustomExpiry("");
    }
  }, [activeLink, isOpen]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [data, capabilities] = await Promise.all([
        api.getDrawingSharing(drawingId),
        api.getGuestCapabilities(drawingId),
      ]);
      setSharing(data);
      setGuestCapabilities(capabilities);
    } catch (err: unknown) {
      let message = "Failed to load sharing settings";
      if (api.isAxiosError(err)) {
        const serverMessage =
          typeof err.response?.data?.message === "string" ? err.response.data.message : null;
        if (serverMessage) message = serverMessage;
      }
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [drawingId]);

  useEffect(() => {
    if (!isOpen) return;
    setUserQuery("");
    setUserResults([]);
    setUserPermission("view");
    setLinkPermission("view");
    setExpiryOption("1d");
    setCustomExpiry("");
    setIsCopied(false);
    setCurrentLinkToken(null);
    setGuestCapabilities(null);
    void refresh();
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen) return;
    const q = userQuery.trim();
    if (q.length < 3) {
      setUserResults([]);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const users = await api.resolveShareUsers(drawingId, q);
        const filtered = currentUserId ? users.filter((u) => u.id !== currentUserId) : users;
        if (!cancelled) setUserResults(filtered);
      } catch {
        if (!cancelled) setUserResults([]);
      }
    };
    const t = window.setTimeout(run, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [currentUserId, drawingId, isOpen, userQuery]);

  const handleCopy = async (text: string): Promise<boolean> => {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setIsCopied(true);
      setCopyFailed(false);
      setTimeout(() => setIsCopied(false), 2000);
      return true;
    } catch {
      // A refused clipboard write used to be swallowed here, on the assumption
      // that the link was visible as text anyway. It was not: the URL only ever
      // reached the clipboard, so a refusal left the button looking dead and
      // whatever was copied earlier still in the clipboard -- which is exactly
      // how a stale link gets pasted to somebody.
      //
      // Browsers require a fresh user gesture for `writeText`, and the copy that
      // follows link creation happens several awaits after the click, so this
      // path is reached in normal use rather than only when permission is
      // denied outright. Say so, and show the URL to copy by hand.
      setCopyFailed(true);
      return false;
    }
  };

  const handleAddUser = async (uId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await api.upsertDrawingPermission(drawingId, {
        granteeUserId: uId,
        permission: userPermission,
      });
      await refresh();
      setUserQuery("");
      setUserResults([]);
    } catch (err: unknown) {
      let message = "Failed to share with user";
      if (api.isAxiosError(err)) {
        const serverMessage =
          typeof err.response?.data?.message === "string" ? err.response.data.message : null;
        if (serverMessage) message = serverMessage;
      }
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevokeUser = async (permissionId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await api.revokeDrawingPermission(drawingId, permissionId);
      await refresh();
    } catch {
      setError("Failed to revoke access");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateUserPermission = async (
    granteeUserId: string,
    permission: "view" | "comment" | "edit",
  ) => {
    setIsLoading(true);
    setError(null);
    try {
      await api.upsertDrawingPermission(drawingId, {
        granteeUserId,
        permission,
      });
      await refresh();
    } catch (err: unknown) {
      let message = "Failed to update access";
      if (api.isAxiosError(err)) {
        const serverMessage =
          typeof err.response?.data?.message === "string" ? err.response.data.message : null;
        if (serverMessage) message = serverMessage;
      }
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Mints a NEW link, invalidating the one already out there.
   *
   * Needed because the token only exists in the browser that created it -- the
   * server keeps a hash, by design. Before v0.20.0 every settings change
   * rotated the secret, so a token happened to be in hand whenever the dialog
   * was open. Keeping the address stable (the right fix, #310) removed that
   * side effect, and reopening the dialog on an existing link left "Copy Link"
   * with nothing to copy and no way to say so: it read "Replace & Copy Link",
   * replaced nothing, and copied nothing.
   *
   * Rotating is therefore an explicit, separately labelled action rather than
   * something a copy button does behind your back.
   */
  const handleCreateNewLink = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const perm = linkPermission;
      let expiresAt = calculateExpiresAt(expiryOption, customExpiry);
      if (perm === "edit" && expiresAt === null) {
        expiresAt = calculateExpiresAt(DEFAULT_EDIT_EXPIRY_OPTION);
        setExpiryOption(DEFAULT_EDIT_EXPIRY_OPTION);
      }
      const created = await api.createLinkShare(drawingId, { permission: perm, expiresAt });
      setCurrentLinkToken(created.token);
      await refresh();
      await handleCopy(api.buildShareLinkUrl(origin, drawingId, created.token));
    } catch (err: unknown) {
      const serverMessage =
        api.isAxiosError(err) && typeof err.response?.data?.message === "string"
          ? err.response.data.message
          : null;
      setError(serverMessage || "Failed to create a new link");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateLink = async (
    newPermission?: "view" | "comment" | "edit",
    newExpiry?: string | null,
  ) => {
    setIsLoading(true);
    setError(null);
    try {
      const perm = newPermission ?? linkPermission;
      setLinkPermission(perm);
      let expiresAt =
        newExpiry !== undefined ? newExpiry : calculateExpiresAt(expiryOption, customExpiry);
      if (perm === "edit" && expiresAt === null) {
        expiresAt = calculateExpiresAt(DEFAULT_EDIT_EXPIRY_OPTION);
        setExpiryOption(DEFAULT_EDIT_EXPIRY_OPTION);
      }
      if (activeLink) {
        // A link already exists, so this is a settings change, not an
        // activation. Changing the terms of an address must not change the
        // address: routing this through createLinkShare rotated the secret and
        // silently invalidated every URL already shared.
        await api.updateLinkShare(drawingId, activeLink.id, { permission: perm, expiresAt });
        await refresh();
        // Only copy when this session actually holds the token. Reopening the
        // dialog cannot recover it -- the server stores a hash -- and the link
        // out there keeps working either way.
        if (currentLinkToken) {
          await handleCopy(api.buildShareLinkUrl(origin, drawingId, currentLinkToken));
        }
      } else {
        const created = await api.createLinkShare(drawingId, { permission: perm, expiresAt });
        setCurrentLinkToken(created.token);
        await refresh();
        await handleCopy(api.buildShareLinkUrl(origin, drawingId, created.token));
      }
    } catch (err: unknown) {
      let message = "Failed to update link";
      if (api.isAxiosError(err)) {
        const serverMessage =
          typeof err.response?.data?.message === "string" ? err.response.data.message : null;
        if (serverMessage) message = serverMessage;
      }
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleGuestCapability = async (
    key: "uploadFiles" | "viewComments" | "agentContextContribute",
  ) => {
    if (!guestCapabilities) return;
    setIsLoading(true);
    setError(null);
    try {
      const updated = await api.updateGuestCapabilities(drawingId, {
        [key]: !guestCapabilities.board[key],
      });
      setGuestCapabilities(updated);
    } catch (err: unknown) {
      let message = "Failed to update guest capability";
      if (api.isAxiosError(err)) {
        const serverMessage =
          typeof err.response?.data?.message === "string" ? err.response.data.message : null;
        if (serverMessage) message = serverMessage;
      }
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevokeLink = async () => {
    if (!activeLink) return;
    setIsLoading(true);
    setError(null);
    try {
      await api.revokeLinkShare(drawingId, activeLink.id);
      setCurrentLinkToken(null);
      await refresh();
    } catch {
      setError("Failed to revoke link");
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;
  // Prefer the token this session minted, then the one the server can read back
  // for us. Before the server could do that, reopening the dialog on an existing
  // link left nothing to copy and no way to say so.
  const usableToken = currentLinkToken || activeLink?.token || null;
  const currentLinkUrl =
    activeLink && usableToken ? api.buildShareLinkUrl(origin, drawingId, usableToken) : "";

  return (
    <div className="excalidash-z-modal fixed inset-0 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-neutral-900/20 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-[420px] [@media(max-height:720px)]:max-w-[560px] max-h-[calc(100dvh-2rem)] bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.08)] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="shrink-0 px-6 py-4 flex items-center justify-between border-b-2 border-black dark:border-neutral-700">
          <h2
            className="text-base font-bold text-slate-800 dark:text-neutral-100 truncate pr-4"
            title={drawingName}
          >
            Share "{drawingName}"
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-neutral-400 hover:text-neutral-950 dark:hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 px-6 py-5 space-y-5 overflow-y-auto overscroll-contain">
          {error && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-xs font-semibold text-rose-600 dark:text-rose-400 flex items-center gap-3">
              <AlertTriangle size={16} strokeWidth={2} />
              {error}
            </div>
          )}

          <SharePeopleSection
            user={user}
            currentUserId={currentUserId}
            sharing={sharing}
            userQuery={userQuery}
            userResults={userResults}
            setUserQuery={setUserQuery}
            handleAddUser={handleAddUser}
            handleRevokeUser={handleRevokeUser}
            handleUpdateUserPermission={handleUpdateUserPermission}
          />

          <GeneralAccessSection
            activeLink={activeLink}
            linkPermission={linkPermission}
            expiryOption={expiryOption}
            customExpiry={customExpiry}
            setLinkPermission={setLinkPermission}
            setExpiryOption={setExpiryOption}
            setCustomExpiry={setCustomExpiry}
            handleUpdateLink={handleUpdateLink}
            handleRevokeLink={handleRevokeLink}
          />

          {activeLink && !currentLinkUrl && (
            <section className="space-y-2">
              <h3 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-neutral-500 px-1">
                Link
              </h3>
              {/* The token lives only in the browser that created the link --
                  the server stores a hash. Saying so beats a copy button that
                  silently has nothing to copy. */}
              <p className="px-1 text-[10px] font-bold text-slate-500 dark:text-neutral-400">
                A link is active, but its address was only shown when it was created and this
                browser does not have it. Anyone already holding it can still open the board. "New
                Link & Copy" issues a fresh address and stops the old one working.
              </p>
            </section>
          )}

          {currentLinkUrl && (
            <section className="space-y-2">
              <h3 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-neutral-500 px-1">
                Link
              </h3>
              {/* Shown and copyable right here. The URL used to exist only
                  inside the clipboard call, so a refused write left nothing
                  behind -- and the copy button sat in the footer, away from the
                  thing it copies. */}
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={currentLinkUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                  aria-label="Share link"
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl border-2 border-black dark:border-neutral-700 bg-slate-50 dark:bg-neutral-800 text-[11px] font-mono text-slate-700 dark:text-neutral-200 select-all"
                />
                <button
                  type="button"
                  onClick={() => void handleCopy(currentLinkUrl)}
                  aria-label="Copy share link"
                  className={clsx(
                    "shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 font-bold text-xs transition-all active:translate-x-[1px] active:translate-y-[1px]",
                    isCopied
                      ? "bg-emerald-500 text-white border-black shadow-none translate-x-[1px] translate-y-[1px]"
                      : "bg-white dark:bg-neutral-900 border-black dark:border-neutral-600 text-indigo-600 dark:text-indigo-400 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.05)] hover:-translate-y-0.5",
                  )}
                >
                  {isCopied ? (
                    <Check size={14} strokeWidth={2.5} />
                  ) : (
                    <LinkIcon size={14} strokeWidth={2.5} />
                  )}
                  {isCopied ? "Copied" : "Copy"}
                </button>
              </div>
              {copyFailed && (
                <p className="px-1 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                  Your browser blocked the automatic copy. The link is right there -- select it and
                  copy it, or press Copy again.
                </p>
              )}
            </section>
          )}

          <GuestCapabilitiesSection
            settings={guestCapabilities}
            onToggleUploadFiles={() => toggleGuestCapability("uploadFiles")}
            onToggleViewComments={() => toggleGuestCapability("viewComments")}
            onToggleAgentContextContribute={() => toggleGuestCapability("agentContextContribute")}
          />
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-4 flex items-center justify-end gap-3 border-t-2 border-black dark:border-neutral-700 bg-slate-50 dark:bg-neutral-800/50 rounded-b-[14px]">
          {/* Only the case the Link section cannot serve: a link is active but
              its address cannot be read back, so the way forward is a new one.
              Copying a link you can see belongs next to the link, not down
              here -- two buttons doing the same thing is clutter. */}
          {activeLink && !currentLinkUrl && (
            <button
              onClick={() => void handleCreateNewLink()}
              className="mr-auto flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-black dark:border-neutral-600 bg-white dark:bg-neutral-900 font-bold text-xs text-indigo-600 dark:text-indigo-400 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.05)] hover:-translate-y-0.5 transition-all active:translate-x-[1px] active:translate-y-[1px]"
            >
              <LinkIcon size={14} strokeWidth={2.5} />
              New Link &amp; Copy
            </button>
          )}

          <button
            onClick={onClose}
            className="px-6 py-2 rounded-xl bg-indigo-600 dark:bg-indigo-500 text-white border-2 border-black font-bold text-xs hover:-translate-y-0.5 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-none transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
          >
            Done
          </button>
        </div>

        {isLoading && (
          <div className="excalidash-z-popup absolute inset-0 bg-white/20 dark:bg-black/10 backdrop-blur-[1px] flex items-center justify-center pointer-events-none rounded-[14px]">
            <div className="bg-white dark:bg-neutral-900 border-2 border-black dark:border-neutral-700 p-4 rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
              <RefreshCw
                size={24}
                strokeWidth={2.5}
                className="animate-spin text-indigo-600 dark:text-indigo-400"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
