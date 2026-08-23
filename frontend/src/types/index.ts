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
  updatedAt: number;
  createdAt: number;
  version: number;
  preview?: string | null;
  accessLevel?: "none" | "view" | "comment" | "edit" | "owner";
  creatorName?: string | null;
  /** Who has a standing claim on this board. Capped; totalCount may be larger. */
  members?: { totalCount: number; items: DrawingMember[] };
}
export interface Drawing extends DrawingSummary {
  elements: any[];
  appState: any;
  files: Record<string, any> | null;
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
