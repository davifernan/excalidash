import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SharePeopleSection } from "./SharePeopleSection";

const baseProps = {
  user: { name: "Owner", email: "owner@test.com" },
  currentUserId: "owner-id",
  userQuery: "",
  userResults: [],
  setUserQuery: vi.fn(),
  handleAddUser: vi.fn(),
  handleRevokeUser: vi.fn(),
  handleUpdateUserPermission: vi.fn(),
};

describe("SharePeopleSection (NIL-291: inherited access)", () => {
  it("shows a read-only 'Access via collection' section for a roster member with no direct grant", () => {
    render(
      <SharePeopleSection
        {...baseProps}
        sharing={{
          permissions: [],
          roster: [
            { userId: "owner-id", name: "Owner", level: "owner", via: "drawing" },
            { userId: "carol-id", name: "Carol", level: "edit", via: "collection" },
          ],
        }}
      />,
    );

    expect(screen.getByText("Access via collection")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
    expect(screen.getByText("Editor")).toBeInTheDocument();
  });

  it("does not duplicate a person who already has a direct grant", () => {
    render(
      <SharePeopleSection
        {...baseProps}
        sharing={{
          permissions: [
            {
              id: "perm-1",
              granteeUserId: "carol-id",
              permission: "view",
              createdAt: 0,
              updatedAt: 0,
              granteeUser: { id: "carol-id", name: "Carol", email: "carol@test.com" },
            },
          ],
          roster: [
            { userId: "owner-id", name: "Owner", level: "owner", via: "drawing" },
            // Same person the direct grant above already lists, also holding
            // a (weaker, in this case) collection-inherited claim.
            { userId: "carol-id", name: "Carol", level: "edit", via: "collection" },
          ],
        }}
      />,
    );

    expect(screen.queryByText("Access via collection")).not.toBeInTheDocument();
  });

  it("does not list the current viewer in the inherited section -- already shown as (you)", () => {
    render(
      <SharePeopleSection
        {...baseProps}
        sharing={{
          permissions: [],
          roster: [{ userId: "owner-id", name: "Owner", level: "owner", via: "collection" }],
        }}
      />,
    );

    expect(screen.queryByText("Access via collection")).not.toBeInTheDocument();
  });

  it("omits the section entirely when nobody has inherited access", () => {
    render(<SharePeopleSection {...baseProps} sharing={{ permissions: [], roster: [] }} />);
    expect(screen.queryByText("Access via collection")).not.toBeInTheDocument();
  });
});
