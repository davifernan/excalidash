import { describe, expect, it } from "vitest";
import { SOCKET_LIMITS } from "../../../../backend/src/limits";
import {
  LIVE_UPDATE_MAX_BYTES,
  LIVE_UPDATE_MAX_FILE_DATA_URL_LENGTH,
} from "./elementUpdateDelivery";

describe("element-update client/server limit contract", () => {
  it("uses the server client-batch target in production delivery", () => {
    expect(LIVE_UPDATE_MAX_BYTES).toBe(SOCKET_LIMITS.clientElementUpdateBytes);
  });

  it("uses the server file data URL ceiling in production delivery", () => {
    expect(LIVE_UPDATE_MAX_FILE_DATA_URL_LENGTH).toBe(SOCKET_LIMITS.fileDataUrlLength);
  });
});
