import { describe, expect, it } from "vitest";
import { config } from "../config";
import { ELEMENT_UPDATE_TRAFFIC_LIMITS, SOCKET_LIMITS } from "./socketProtocol";
import { DEFAULT_SOCKET_MAX_HTTP_BUFFER_BYTES, assertSocketLimitContract } from "../limits";

describe("socket limit contract", () => {
  it("keeps payload ceilings below transport and every board budget", () => {
    expect(SOCKET_LIMITS.fileBytes).toBeLessThan(SOCKET_LIMITS.elementUpdateBytes);
    expect(SOCKET_LIMITS.elementUpdateBytes).toBeLessThan(config.socketMaxHttpBufferBytes);
    expect(config.socketMaxHttpBufferBytes).toBeLessThan(
      ELEMENT_UPDATE_TRAFFIC_LIMITS.anonymousBytesPerWindow,
    );
    expect(config.socketMaxHttpBufferBytes).toBeLessThan(
      ELEMENT_UPDATE_TRAFFIC_LIMITS.accountBytesPerWindow,
    );
  });

  it("keeps the client target between one file and every event ceiling", () => {
    expect(SOCKET_LIMITS.fileBytes).toBeLessThan(SOCKET_LIMITS.clientElementUpdateBytes);
    expect(SOCKET_LIMITS.clientElementUpdateBytes).toBeLessThan(
      SOCKET_LIMITS.anonymousElementUpdateBytes,
    );
    expect(SOCKET_LIMITS.anonymousElementUpdateBytes).toBeLessThan(
      SOCKET_LIMITS.elementUpdateBytes,
    );
  });

  it("rejects transport overrides that bypass either adjacent application limit", () => {
    expect(() => assertSocketLimitContract(SOCKET_LIMITS.elementUpdateBytes)).toThrow(
      /event parser.*must be below Socket\.IO transport/,
    );
    expect(() =>
      assertSocketLimitContract(ELEMENT_UPDATE_TRAFFIC_LIMITS.anonymousBytesPerWindow),
    ).toThrow(/Socket\.IO transport.*must be below anonymous board budget/);
    expect(() => assertSocketLimitContract(DEFAULT_SOCKET_MAX_HTTP_BUFFER_BYTES)).not.toThrow();
  });
});
