import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createAuthRouter } from "./auth";

/**
 * NIL-693: `ensureLoginAttemptLimiter`'s in-flight coalescing, migrated onto
 * the shared `createInFlightCoalescer`. The coalescing lives entirely inside
 * `createAuthRouter`'s closure and is not separately exported, so this pulls
 * the real `loginAttemptRateLimiter` middleware straight off the built
 * router's `/login` route (Express routers expose `.stack` for exactly this
 * kind of introspection) and calls it directly with two overlapping fake
 * requests -- not through HTTP/supertest, whose connection handling turned
 * out to serialize the two calls enough to hide the race this is checking.
 */
const findLoginRateLimiter = (router: express.Router): express.RequestHandler => {
  const layer = (router as any).stack.find(
    (candidate: any) => candidate.route?.path === "/login" && candidate.route.methods.post,
  );
  if (!layer) throw new Error("POST /login route not found on the auth router");
  // router.post("/login", loginAttemptRateLimiter, async (req, res) => {...})
  const [rateLimiter] = layer.route.stack;
  return rateLimiter.handle;
};

describe("login-attempt-limiter init coalescing", () => {
  it("shares one system-config read across concurrent requests initializing the limiter", async () => {
    let releaseConfig: (() => void) | undefined;
    const configHeld = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    const ensureSystemConfig = vi.fn().mockImplementation(async () => {
      await configHeld;
      return {
        id: "default",
        authEnabled: true,
        authLoginRateLimitEnabled: true,
        authLoginRateLimitWindowMs: 900_000,
        authLoginRateLimitMax: 20,
      };
    });

    const router = createAuthRouter({
      prisma: {} as any,
      requireAuth: ((_req: any, _res: any, next: any) => next()) as any,
      optionalAuth: ((_req: any, _res: any, next: any) => next()) as any,
      authModeService: {
        ensureSystemConfig,
        getAuthEnabled: vi.fn(),
        clearAuthEnabledCache: vi.fn(),
        getBootstrapActingUser: vi.fn(),
      } as any,
    });
    const rateLimiter = findLoginRateLimiter(router);

    const fakeRequest = () => ({ ip: "127.0.0.1", connection: {}, body: {} }) as any;
    const fakeResponse = () => {
      const res: any = {
        headers: {} as Record<string, unknown>,
        statusCode: 200,
        setHeader(name: string, value: unknown) {
          res.headers[name] = value;
          return res;
        },
        getHeader(name: string) {
          return res.headers[name];
        },
        removeHeader(name: string) {
          delete res.headers[name];
        },
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        json() {
          return res;
        },
        send() {
          return res;
        },
        end() {
          return res;
        },
      };
      return res;
    };
    const run = () =>
      new Promise<void>((resolve, reject) => {
        void Promise.resolve(
          rateLimiter(fakeRequest(), fakeResponse(), (err?: unknown) => {
            if (err) reject(err);
            else resolve();
          }),
        );
      });

    const first = run();
    const second = run();
    // Both calls above are synchronous up to their first `await`
    // (ensureLoginAttemptLimiter -> ... -> ensureSystemConfig), so by this
    // point both have already made their decision on whether to start fresh
    // work or join existing in-flight work -- no timing race to win.
    releaseConfig?.();
    await Promise.all([first, second]);

    // With coalescing intact, both calls share the one in-flight
    // ensureSystemConfig read. Without it (reverted to two independent
    // initLoginAttemptLimiter() calls), this would be 2.
    expect(ensureSystemConfig).toHaveBeenCalledTimes(1);
  });
});
