import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { Collection } from "../types";

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "me", name: "Me" },
    logout: vi.fn(),
    authEnabled: true,
  }),
}));

vi.mock("./ShareCollectionModal", () => ({
  ShareCollectionModal: () => null,
}));

const baseProps = {
  selectedCollectionId: undefined,
  onSelectCollection: vi.fn(),
  onCreateCollection: vi.fn(),
  onEditCollection: vi.fn(),
  onDeleteCollection: vi.fn(),
};

const collections: Collection[] = [
  { id: "owned", name: "My Folder", createdAt: 1, isOwner: true, isShared: false },
  { id: "owned-shared", name: "My Shared Folder", createdAt: 2, isOwner: true, isShared: true },
  {
    id: "shared-with-me-view",
    name: "Their Folder",
    createdAt: 3,
    isOwner: false,
    isShared: true,
    sharedRole: "view",
    ownerName: "Someone",
  },
  {
    id: "shared-with-me-edit",
    name: "Their Editable Folder",
    createdAt: 4,
    isOwner: false,
    isShared: true,
    sharedRole: "edit",
    ownerName: "Someone Else",
  },
];

const renderSidebar = (collections: Collection[]) =>
  render(
    <MemoryRouter>
      <Sidebar {...baseProps} collections={collections} />
    </MemoryRouter>,
  );

describe("Sidebar collection ownership", () => {
  it("puts every non-owned or shared collection under Team, and everything else under personal", () => {
    renderSidebar(collections);

    // Order in the document is the only signal that a name landed in the
    // right group: both groups render collections the same way, so a
    // presence-only assertion here would not catch a broken split.
    const [myFolder, teamHeader, mySharedFolder, theirFolder, theirEditableFolder] = [
      "My Folder",
      "Team",
      "My Shared Folder",
      "Their Folder",
      "Their Editable Folder",
    ].map((text) => screen.getByText(text));
    // My Folder (owned, not shared) is personal: before the Team header.
    expect(
      myFolder.compareDocumentPosition(teamHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Everything shared or not-owned is under Team: after the Team header.
    for (const teamMember of [mySharedFolder, theirFolder, theirEditableFolder]) {
      expect(
        teamHeader.compareDocumentPosition(teamMember) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("labels a collection shared with this account by the granted role", () => {
    renderSidebar(collections);
    expect(screen.getByText("Viewer")).toBeTruthy();
    expect(screen.getByText("Editor")).toBeTruthy();
  });

  it("shows the Shared badge only on an owned collection that has been shared out", () => {
    renderSidebar(collections);
    expect(screen.getAllByText("Shared")).toHaveLength(1);
  });

  it("blocks the context menu on a collection this account does not own", () => {
    renderSidebar(collections);
    const item = screen.getByText("Their Folder");
    fireEvent.contextMenu(item);
    expect(screen.queryByText("Rename Collection")).toBeNull();
  });

  it("allows the context menu on a collection this account owns", () => {
    renderSidebar(collections);
    const item = screen.getByText("My Folder");
    fireEvent.contextMenu(item);
    expect(screen.getByText("Rename Collection")).toBeTruthy();
  });
});

describe("Sidebar Team Home entry", () => {
  it("navigates to /team when clicked", () => {
    render(
      <MemoryRouter initialEntries={["/collections"]}>
        <Sidebar {...baseProps} collections={[]} />
      </MemoryRouter>,
    );
    const teamHomeButton = screen.getByRole("button", { name: "Team Home" });
    expect(teamHomeButton).not.toHaveClass("bg-indigo-50");

    fireEvent.click(teamHomeButton);

    // The button re-renders as active once the route actually changed to
    // /team -- a real navigation assertion, not a click-happened one.
    expect(screen.getByRole("button", { name: "Team Home" })).toHaveClass("bg-indigo-50");
  });

  it("highlights Team Home only while on /team, not on other pages", () => {
    const onTeamHome = render(
      <MemoryRouter initialEntries={["/team"]}>
        <Sidebar {...baseProps} collections={[]} />
      </MemoryRouter>,
    );
    expect(onTeamHome.getByRole("button", { name: "Team Home" })).toHaveClass("bg-indigo-50");
    onTeamHome.unmount();

    // Fresh MemoryRouter, not a rerender: `initialEntries` only applies on
    // first mount, so reusing the same router instance would leave the
    // location at /team and let this assertion pass for the wrong reason.
    const onCollections = render(
      <MemoryRouter initialEntries={["/collections"]}>
        <Sidebar {...baseProps} collections={[]} />
      </MemoryRouter>,
    );
    expect(onCollections.getByRole("button", { name: "Team Home" })).not.toHaveClass(
      "bg-indigo-50",
    );
  });
});
