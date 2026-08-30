import { expect, it } from "vitest";
import { PrismaClient } from "../generated/client";

// The NIL-703 counterprobe imports this file after replacing the generated
// package.json by a copied invalid fixture. A collect-time failure exercises
// the same runner path as the real zero-test suite failures.
it("loads the generated Prisma client", () => {
  expect(PrismaClient).toBeTypeOf("function");
});
