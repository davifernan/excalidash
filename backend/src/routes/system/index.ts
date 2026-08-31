import express from "express";
import { registerUpdateRoutes } from "./update";
import { registerFeatureRoutes } from "./features";

export type SystemRouteDeps = {
  asyncHandler: <T = void>(
    fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<T>,
  ) => express.RequestHandler;
  getBackendVersion: () => string;
};

export const registerSystemRoutes = (app: express.Express, deps: SystemRouteDeps) => {
  registerUpdateRoutes(app, deps);
  registerFeatureRoutes(app, deps);
};
