import express from "express";
import { registerCollectionRoutes } from "./collections";
import { registerCollectionMemberRoutes } from "./collectionMemberRoutes";
import { registerPresenceRoutes } from "./presenceRoutes";
import { registerDrawingRoutes } from "./drawings";
import { registerLibraryRoutes } from "./library";
import { registerTeamRoutes } from "./team";
import { DashboardRouteDeps } from "./types";

export const registerDashboardRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  registerDrawingRoutes(app, deps);
  registerCollectionRoutes(app, deps);
  registerCollectionMemberRoutes(app, deps);
  registerPresenceRoutes(app, deps);
  registerLibraryRoutes(app, deps);
  registerTeamRoutes(app, deps);
};

export type { DashboardRouteDeps } from "./types";
