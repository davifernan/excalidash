import type { DrawingAccess } from "@excalidash/domain/authz";

export interface DrawingMember {
  subjectKey: string;
  name: string;
  initials: string;
  color: string;
  kind: "owner" | "member";
  isSelf: boolean;
}

export interface DrawingSummary {
  id: string;
  name: string;
  collectionId: string | null;
  /** Only sent by the single-drawing fetch (GET /drawings/:id), same gate as collectionId (NIL-344). */
  collectionName?: string | null;
  updatedAt: number;
  createdAt: number;
  version: number;
  preview?: string | null;
  accessLevel?: DrawingAccess;
  creatorName?: string | null;
  /** Who has a standing claim on this board. Capped; totalCount may be larger. */
  members?: { totalCount: number; items: DrawingMember[] };
  /**
   * How the viewer reaches a board they don't own (NIL-290): "collection" on
   * every board in a collection someone else shares with you (board
   * ownership always equals the collection owner's), "direct" on every
   * board from the "Shared with me" list (a grant on the board itself).
   * Undefined for a board you own -- see `linkShared` instead.
   */
  accessVia?: "collection" | "direct";
  /**
   * Owner-only exposure signal (NIL-290): whether this board currently has
   * an active (not revoked, not expired) link share. Undefined for a board
   * you don't own.
   */
  linkShared?: boolean;
  /** Whether the viewer has starred this board (NIL-292). Absent for an API key. */
  isFavorite?: boolean;
}
export interface Drawing extends DrawingSummary {
  elements: any[];
  appState: any;
  files: Record<string, any> | null;
  capabilities: {
    uploadFiles: boolean;
    viewComments: boolean;
  };
}
export interface Collection {
  id: string;
  name: string;
  createdAt: number;
  sharedRole?: "view" | "edit" | null;
  /** Whether this account owns the collection. The backend sets this on every entry it returns -- never absent, never ambiguous. */
  isOwner: boolean;
  isShared?: boolean;
  /** Only sent for collections someone else shared with you. */
  ownerName?: string | null;
}

export type CollectionShareRole = "view" | "edit";

export interface CollectionShareUser {
  id: string;
  name: string;
  email: string;
}

export interface CollectionShareRow {
  id: string;
  collectionId: string;
  granteeUserId: string;
  granteeUser: CollectionShareUser;
  role: CollectionShareRole;
  createdAt: string;
  updatedAt: string;
}

export type CollectionMemberRole = "owner" | "editor" | "viewer";

/**
 * A person to show, not a person to act on: the server sends an opaque key
 * scoped to the collection instead of an account id.
 */
export interface CollectionMember {
  subjectKey: string;
  name: string;
  initials: string;
  color: string;
  role: CollectionMemberRole;
  isSelf: boolean;
}
