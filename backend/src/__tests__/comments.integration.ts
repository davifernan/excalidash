import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("Comments, mentions, activity and inbox", () => {
  let prisma: PrismaClient;
  let app: any;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const makeUser = async (email: string, name: string) => {
    const passwordHash = await bcrypt.hash("password123", 10);
    return prisma.user.create({
      data: { email, passwordHash, name, role: "USER", isActive: true },
      select: { id: true, email: true, name: true },
    });
  };

  const tokenFor = (user: { id: string; email: string }) => {
    const signOptions: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );
  };

  /**
   * A small authed HTTP client for one user: a cookie-jar agent carrying a
   * real CSRF token (state-changing routes 403 without one -- see
   * collection-sharing.integration.ts for the same pattern) plus the bearer
   * token on every call.
   */
  const clientFor = async (user: { id: string; email: string }) => {
    const agent = request.agent(app);
    const csrfRes = await agent.get("/csrf-token");
    const csrfHeaderName = csrfRes.body.header;
    const csrfToken = csrfRes.body.token;
    const auth = `Bearer ${tokenFor(user)}`;
    const withCsrf = (req: request.Test) =>
      req.set("Authorization", auth).set(csrfHeaderName, csrfToken);
    return {
      get: (url: string, query?: Record<string, string>) =>
        query
          ? agent.get(url).query(query).set("Authorization", auth)
          : agent.get(url).set("Authorization", auth),
      post: (url: string, body?: object) => withCsrf(agent.post(url)).send(body ?? {}),
      patch: (url: string, body?: object) => withCsrf(agent.patch(url)).send(body ?? {}),
      delete: (url: string) => withCsrf(agent.delete(url)),
    };
  };

  const makeDrawing = async (ownerId: string, name: string) =>
    prisma.drawing.create({
      data: { name, elements: "[]", appState: "{}", files: "{}", userId: ownerId, version: 1 },
      select: { id: true },
    });

  const grant = (
    drawingId: string,
    granteeUserId: string,
    permission: "view" | "comment" | "edit",
    grantedByUserId: string,
  ) =>
    prisma.drawingPermission.create({
      data: { drawingId, granteeUserId, permission, createdByUserId: grantedByUserId },
    });

  it("lets an owner and a comment-level grantee create a threaded comment, denies a view-only grantee, and denies a stranger with a 404 (no existence leak)", async () => {
    const owner = await makeUser("owner-1@test.local", "Owner One");
    const commenter = await makeUser("commenter-1@test.local", "Commenter One");
    const viewer = await makeUser("viewer-1@test.local", "Viewer One");
    const stranger = await makeUser("stranger-1@test.local", "Stranger One");
    const drawing = await makeDrawing(owner.id, "Board 1");
    await grant(drawing.id, commenter.id, "comment", owner.id);
    await grant(drawing.id, viewer.id, "view", owner.id);

    const ownerClient = await clientFor(owner);
    const commenterClient = await clientFor(commenter);
    const viewerClient = await clientFor(viewer);
    const strangerClient = await clientFor(stranger);

    // RED PROBE evidence (see PR HANDOFF): before commentRoutes/canCommentDrawing
    // were wired in, this route did not exist at all (404). Now a
    // comment-level grantee gets 201, a view-only grantee gets 403, and a
    // stranger with no access still gets 404 -- no existence leak.
    const created = await commenterClient.post(`/drawings/${drawing.id}/comments`, {
      body: "Looks good to me",
      anchorX: 10,
      anchorY: 20,
    });
    expect(created.status).toBe(201);
    expect(created.body.comment.authorUserId).toBe(commenter.id);
    expect(created.body.comment.authorName).toBe("Commenter One");
    expect(created.body.comment.anchorX).toBe(10);
    expect(created.body.comment.rootId).toBeNull();

    const viewerDenied = await viewerClient.post(`/drawings/${drawing.id}/comments`, {
      body: "I wish I could comment",
    });
    expect(viewerDenied.status).toBe(403);

    const strangerDenied = await strangerClient.post(`/drawings/${drawing.id}/comments`, {
      body: "Sneaking in",
    });
    expect(strangerDenied.status).toBe(404);

    // Owner replies in the thread.
    const reply = await ownerClient.post(`/drawings/${drawing.id}/comments`, {
      body: "Thanks!",
      rootId: created.body.comment.id,
    });
    expect(reply.status).toBe(201);
    expect(reply.body.comment.rootId).toBe(created.body.comment.id);

    // A reply's activity event carries the THREAD's root id for deep-linking,
    // not the reply's own id -- CommentMarkers/useComments key a thread by
    // its root, so a mention-in-a-reply notification has to resolve there.
    const activity = await ownerClient.get(`/drawings/${drawing.id}/activity`);
    expect(activity.status).toBe(200);
    const rootEvent = activity.body.events.find(
      (e: any) => e.commentId === created.body.comment.id,
    );
    const replyEvent = activity.body.events.find((e: any) => e.commentId === reply.body.comment.id);
    expect(rootEvent.threadRootId).toBe(created.body.comment.id);
    expect(replyEvent.threadRootId).toBe(created.body.comment.id);

    // A reply must target an actual root, not another reply.
    const badNesting = await ownerClient.post(`/drawings/${drawing.id}/comments`, {
      body: "Nested reply",
      rootId: reply.body.comment.id,
    });
    expect(badNesting.status).toBe(400);
    expect(badNesting.body.error).toBe("not-a-root");

    // The viewer can still READ the thread (view-only implies read access to comments).
    const listAsViewer = await viewerClient.get(`/drawings/${drawing.id}/comments`);
    expect(listAsViewer.status).toBe(200);
    expect(listAsViewer.body.canComment).toBe(false);
    expect(listAsViewer.body.comments).toHaveLength(2);

    // A stranger cannot even read the thread -- 404, not 403.
    const listAsStranger = await strangerClient.get(`/drawings/${drawing.id}/comments`);
    expect(listAsStranger.status).toBe(404);
  });

  it("only notifies a mention target who is actually a board member, never a stranger id the client supplied", async () => {
    const owner = await makeUser("owner-2@test.local", "Owner Two");
    const member = await makeUser("member-2@test.local", "Member Two");
    const outsider = await makeUser("outsider-2@test.local", "Outsider Two");
    const drawing = await makeDrawing(owner.id, "Board 2");
    await grant(drawing.id, member.id, "comment", owner.id);

    const ownerClient = await clientFor(owner);
    const memberClient = await clientFor(member);
    const outsiderClient = await clientFor(outsider);

    const body = `Hey @[Member Two](${member.id}) and @[Outsider](${outsider.id}), check this out`;
    const created = await ownerClient.post(`/drawings/${drawing.id}/comments`, { body });
    expect(created.status).toBe(201);
    // The DTO only reports mentions that actually resolved (roster members).
    expect(created.body.comment.mentionedUserIds).toEqual([member.id]);

    const memberInbox = await memberClient.get("/inbox");
    expect(memberInbox.status).toBe(200);
    expect(memberInbox.body.unreadCount).toBe(1);
    expect(memberInbox.body.notifications[0].kind).toBe("mention");

    // The outsider was never a board member: no notification, and the
    // Mention row itself was never created for them (RED PROBE: without the
    // roster re-validation in createComment, this count would be 1).
    const outsiderMentionRows = await prisma.mention.count({
      where: { mentionedUserId: outsider.id },
    });
    expect(outsiderMentionRows).toBe(0);
    const outsiderInbox = await outsiderClient.get("/inbox");
    expect(outsiderInbox.body.unreadCount).toBe(0);
  });

  it("marks a notification read, and a second person cannot mark someone else's notification read", async () => {
    const owner = await makeUser("owner-3@test.local", "Owner Three");
    const member = await makeUser("member-3@test.local", "Member Three");
    const other = await makeUser("other-3@test.local", "Other Three");
    const drawing = await makeDrawing(owner.id, "Board 3");
    await grant(drawing.id, member.id, "comment", owner.id);

    const ownerClient = await clientFor(owner);
    const memberClient = await clientFor(member);
    const otherClient = await clientFor(other);

    const body = `cc @[Member Three](${member.id})`;
    const created = await ownerClient.post(`/drawings/${drawing.id}/comments`, { body });
    expect(created.status).toBe(201);

    const inboxBefore = await memberClient.get("/inbox");
    expect(inboxBefore.body.unreadCount).toBe(1);
    const notificationId = inboxBefore.body.notifications[0].id;

    const markRead = await memberClient.post(`/inbox/${notificationId}/read`);
    expect(markRead.status).toBe(200);

    const inboxAfter = await memberClient.get("/inbox", { unreadOnly: "true" });
    expect(inboxAfter.body.unreadCount).toBe(0);
    expect(inboxAfter.body.notifications).toHaveLength(0);

    // Another account cannot mark someone else's notification read -- a 404,
    // not a 403, so it does not confirm the notification id even exists.
    const stealRead = await otherClient.post(`/inbox/${notificationId}/read`);
    expect(stealRead.status).toBe(404);
  });

  it("resolves and reopens a thread idempotently -- resolving an already-resolved thread creates no duplicate activity event", async () => {
    const owner = await makeUser("owner-4@test.local", "Owner Four");
    const commenter = await makeUser("commenter-4@test.local", "Commenter Four");
    const drawing = await makeDrawing(owner.id, "Board 4");
    await grant(drawing.id, commenter.id, "comment", owner.id);

    const ownerClient = await clientFor(owner);
    const commenterClient = await clientFor(commenter);

    const created = await commenterClient.post(`/drawings/${drawing.id}/comments`, {
      body: "Needs a decision",
    });
    const rootId = created.body.comment.id;

    const resolve1 = await ownerClient.post(`/drawings/${drawing.id}/comments/${rootId}/resolve`);
    expect(resolve1.status).toBe(200);
    expect(resolve1.body.comment.resolvedAt).not.toBeNull();

    const eventsAfterFirstResolve = await prisma.activityEvent.count({
      where: { commentId: rootId, verb: "comment.resolved" },
    });
    expect(eventsAfterFirstResolve).toBe(1);

    // RED PROBE: resolving twice must stay idempotent. Before the
    // already-in-requested-state short-circuit, this second call created a
    // second "comment.resolved" event and a second notification.
    const resolve2 = await ownerClient.post(`/drawings/${drawing.id}/comments/${rootId}/resolve`);
    expect(resolve2.status).toBe(200);
    const eventsAfterSecondResolve = await prisma.activityEvent.count({
      where: { commentId: rootId, verb: "comment.resolved" },
    });
    expect(eventsAfterSecondResolve).toBe(1);

    const reopen = await ownerClient.post(`/drawings/${drawing.id}/comments/${rootId}/reopen`);
    expect(reopen.status).toBe(200);
    expect(reopen.body.comment.resolvedAt).toBeNull();

    // A reply cannot itself be resolved -- only its root.
    const reply = await ownerClient.post(`/drawings/${drawing.id}/comments`, {
      body: "reply",
      rootId,
    });
    const resolveReply = await ownerClient.post(
      `/drawings/${drawing.id}/comments/${reply.body.comment.id}/resolve`,
    );
    expect(resolveReply.status).toBe(400);
    expect(resolveReply.body.error).toBe("not-a-root");
  });

  it("lets only the author edit a comment, lets the author or an editor delete it (moderation), and tombstones the body", async () => {
    const owner = await makeUser("owner-5@test.local", "Owner Five");
    const commenter = await makeUser("commenter-5@test.local", "Commenter Five");
    const otherCommenter = await makeUser("other-5@test.local", "Other Five");
    const drawing = await makeDrawing(owner.id, "Board 5");
    await grant(drawing.id, commenter.id, "comment", owner.id);
    await grant(drawing.id, otherCommenter.id, "comment", owner.id);

    const ownerClient = await clientFor(owner);
    const commenterClient = await clientFor(commenter);
    const otherClient = await clientFor(otherCommenter);

    const created = await commenterClient.post(`/drawings/${drawing.id}/comments`, {
      body: "original text",
    });
    const commentId = created.body.comment.id;

    const editByOther = await otherClient.patch(`/drawings/${drawing.id}/comments/${commentId}`, {
      body: "hijacked",
    });
    expect(editByOther.status).toBe(403);

    const editByAuthor = await commenterClient.patch(
      `/drawings/${drawing.id}/comments/${commentId}`,
      {
        body: "edited text",
      },
    );
    expect(editByAuthor.status).toBe(200);
    expect(editByAuthor.body.comment.body).toBe("edited text");
    expect(editByAuthor.body.comment.editedAt).not.toBeNull();

    // A comment-level (non-editor) peer may not delete someone else's comment.
    const deleteByPeerDenied = await otherClient.delete(
      `/drawings/${drawing.id}/comments/${commentId}`,
    );
    expect(deleteByPeerDenied.status).toBe(403);

    // The board owner (edit-level) may delete it for moderation.
    const deleteByOwner = await ownerClient.delete(`/drawings/${drawing.id}/comments/${commentId}`);
    expect(deleteByOwner.status).toBe(200);

    const afterDelete = await ownerClient.get(`/drawings/${drawing.id}/comments`, {
      includeResolved: "true",
    });
    const tombstone = afterDelete.body.comments.find((c: any) => c.id === commentId);
    expect(tombstone.deletedAt).not.toBeNull();
    // Body is redacted, but authorship stays visible -- that is the point of
    // a tombstone rather than a hard delete.
    expect(tombstone.body).toBeNull();
    expect(tombstone.authorName).toBe("Commenter Five");
  });

  it("stops an author from editing or deleting their own comment once their board access is revoked", async () => {
    const owner = await makeUser("owner-5b@test.local", "Owner Five B");
    const commenter = await makeUser("commenter-5b@test.local", "Commenter Five B");
    const drawing = await makeDrawing(owner.id, "Board 5b");
    const grantRow = await grant(drawing.id, commenter.id, "comment", owner.id);

    const commenterClient = await clientFor(commenter);
    const created = await commenterClient.post(`/drawings/${drawing.id}/comments`, {
      body: "before revoke",
    });
    const commentId = created.body.comment.id;

    // Authorship alone must not stay a standing right after the grant is gone
    // -- otherwise an offboarded or downgraded account keeps a write path into
    // a board it can no longer even open.
    await prisma.drawingPermission.delete({ where: { id: grantRow.id } });

    const editAfterRevoke = await commenterClient.patch(
      `/drawings/${drawing.id}/comments/${commentId}`,
      {
        body: "still editable?",
      },
    );
    expect(editAfterRevoke.status).toBe(404);

    const deleteAfterRevoke = await commenterClient.delete(
      `/drawings/${drawing.id}/comments/${commentId}`,
    );
    expect(deleteAfterRevoke.status).toBe(404);

    const stillThere = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(stillThere.body).toBe("before revoke");
    expect(stillThere.deletedAt).toBeNull();
  });

  it("shows team activity only for boards the viewer actually belongs to", async () => {
    const owner = await makeUser("owner-6@test.local", "Owner Six");
    const member = await makeUser("member-6@test.local", "Member Six");
    const outsider = await makeUser("outsider-6@test.local", "Outsider Six");
    const memberBoard = await makeDrawing(owner.id, "Member Board");
    const privateBoard = await makeDrawing(owner.id, "Private Board");
    await grant(memberBoard.id, member.id, "comment", owner.id);

    const ownerClient = await clientFor(owner);
    const memberClient = await clientFor(member);
    const outsiderClient = await clientFor(outsider);

    await ownerClient.post(`/drawings/${memberBoard.id}/comments`, {
      body: "activity on the shared board",
    });
    await ownerClient.post(`/drawings/${privateBoard.id}/comments`, {
      body: "activity on the private board",
    });

    const memberFeed = await memberClient.get("/activity");
    expect(memberFeed.status).toBe(200);
    const memberDrawingIds = memberFeed.body.events.map((e: any) => e.drawingId);
    expect(memberDrawingIds).toContain(memberBoard.id);
    expect(memberDrawingIds).not.toContain(privateBoard.id);

    const outsiderFeed = await outsiderClient.get("/activity");
    const outsiderDrawingIds = outsiderFeed.body.events.map((e: any) => e.drawingId);
    expect(outsiderDrawingIds).not.toContain(memberBoard.id);
    expect(outsiderDrawingIds).not.toContain(privateBoard.id);
  });

  it("rejects an unauthenticated request to comment even when the board has a public edit link (no anonymous authorship)", async () => {
    const owner = await makeUser("owner-7@test.local", "Owner Seven");
    const drawing = await makeDrawing(owner.id, "Board 7");
    await prisma.drawingLinkShare.create({
      data: {
        drawingId: drawing.id,
        permission: "edit",
        tokenHash: "0".repeat(64),
        expiresAt: null,
        createdByUserId: owner.id,
      },
    });

    // RED PROBE: without requireAuth on the write route, an anonymous
    // request carrying a valid edit-link token would have been accepted
    // (canCommentDrawing("edit") is true) and produced an unattributed
    // comment. requireAuth alone must reject it before that check ever runs.
    // A CSRF token is fetched (anonymously) so this probes the auth
    // boundary specifically, not the separate CSRF boundary in front of it.
    const anonymousAgent = request.agent(app);
    const csrfRes = await anonymousAgent.get("/csrf-token");
    const anonymous = await anonymousAgent
      .post(`/drawings/${drawing.id}/comments`)
      .set(csrfRes.body.header, csrfRes.body.token)
      .send({ body: "anonymous edit-link guest" });
    expect(anonymous.status).toBe(401);
  });

  it("lets the no-auth bootstrap identity comment, edit, resolve and visit on its own board", async () => {
    // This instance's auth-enabled flag is cached in-process for up to 5s
    // (authMode.ts authEnabledTtlMs) -- flipping the DB row alone is not
    // enough to prove the route saw it. Waiting out the TTL is the only way
    // to observe a real, uncached read for a route under test, not a
    // deliberately-shortened one that would not exist in production.
    await prisma.systemConfig.update({
      where: { id: "default" },
      data: { authEnabled: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 5200));

    try {
      const BOOTSTRAP_USER_ID = "bootstrap-admin";
      // Same upsert authModeService.getBootstrapActingUser() performs --
      // isActive: false is the point, see commentRoutes.ts's top-of-file
      // comment on why a hand-built principal misreads this as "none" access.
      await prisma.user.upsert({
        where: { id: BOOTSTRAP_USER_ID },
        update: {},
        create: {
          id: BOOTSTRAP_USER_ID,
          email: "bootstrap@excalidash.local",
          username: null,
          passwordHash: "",
          name: "Bootstrap Admin",
          role: "ADMIN",
          mustResetPassword: true,
          isActive: false,
        },
      });
      const drawing = await makeDrawing(BOOTSTRAP_USER_ID, "Bootstrap Board");

      // No Authorization header at all -- requireAuth's no-auth branch is
      // what is meant to populate req.user here, exactly like a real
      // self-hosted instance that never turned auth on.
      const bootstrapAgent = request.agent(app);
      const csrfRes = await bootstrapAgent.get("/csrf-token");
      const withCsrf = (req: request.Test) => req.set(csrfRes.body.header, csrfRes.body.token);

      const created = await withCsrf(bootstrapAgent.post(`/drawings/${drawing.id}/comments`)).send({
        body: "bootstrap identity can comment on its own board",
      });
      expect(created.status).toBe(201);
      expect(created.body.comment.authorUserId).toBe(BOOTSTRAP_USER_ID);

      const commentId = created.body.comment.id;
      const resolved = await withCsrf(
        bootstrapAgent.post(`/drawings/${drawing.id}/comments/${commentId}/resolve`),
      ).send({});
      expect(resolved.status).toBe(200);

      const visited = await withCsrf(bootstrapAgent.post(`/drawings/${drawing.id}/visit`)).send({});
      expect(visited.status).toBe(200);
    } finally {
      await prisma.systemConfig.update({
        where: { id: "default" },
        data: { authEnabled: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 5200));
    }
  });
});
