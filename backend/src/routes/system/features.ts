import express from "express";
import type { SystemRouteDeps } from "./index";
import { config } from "../../config";

export type FeaturesResponse = {
  agents: boolean;
};

/**
 * Unauthenticated on purpose: the answer is a property of the deployment, not
 * of the viewer, and the frontend needs it before it knows who is looking --
 * a share-link guest reaches the board without a session and must not see
 * agent surfaces this instance cannot serve either.
 */
export const registerFeatureRoutes = (app: express.Express, deps: SystemRouteDeps) => {
  app.get(
    "/system/features",
    deps.asyncHandler(async (_req, res) => {
      const payload: FeaturesResponse = { agents: config.features.agents };
      res.status(200).json(payload);
    }),
  );
};
