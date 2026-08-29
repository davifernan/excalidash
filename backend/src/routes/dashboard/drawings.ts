import express from "express";
import { DashboardRouteDeps } from "./types";
import { createDrawingRouteContext } from "./drawingRouteContext";
import { registerDrawingListRoutes } from "./drawingListRoutes";
import { registerDrawingReadRoutes } from "./drawingReadRoutes";
import { registerDrawingCreateUpdateRoutes } from "./drawingCreateUpdateRoutes";
import { registerDrawingDeleteDuplicateRoutes } from "./drawingDeleteDuplicateRoutes";
import { registerDrawingSharingRoutes } from "./drawingSharingRoutes";
import { registerGuestCapabilityRoutes } from "./guestCapabilityRoutes";
import { registerDrawingHistoryRoutes } from "./drawingHistoryRoutes";
import { registerDrawingAgentRoutes } from "./drawingAgentRoutes";
import { registerCommentRoutes } from "./commentRoutes";
import { registerInboxRoutes } from "./inboxRoutes";
import { registerActivityRoutes } from "./activityRoutes";
import { registerSearchRoutes } from "./searchRoutes";
import { registerArchiveRoutes } from "./archiveRoutes";
import { registerFavoriteRoutes } from "./favoriteRoutes";

export const registerDrawingRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  const context = createDrawingRouteContext(deps);

  registerDrawingListRoutes(app, context);
  registerDrawingReadRoutes(app, context);
  registerDrawingCreateUpdateRoutes(app, context);
  registerDrawingDeleteDuplicateRoutes(app, context);
  registerDrawingSharingRoutes(app, context);
  registerGuestCapabilityRoutes(app, context);
  registerDrawingHistoryRoutes(app, context);
  registerDrawingAgentRoutes(app, context);
  registerCommentRoutes(app, context);
  registerInboxRoutes(app, context);
  registerActivityRoutes(app, context);
  registerSearchRoutes(app, context);
  registerArchiveRoutes(app, context);
  registerFavoriteRoutes(app, context);
};
