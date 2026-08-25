import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";

// NIL-591: the badge itself, not just the status computation -- proves the
// dot's data-status (and therefore its colour, driven by CSS selectors on
// that attribute) actually reflects each of the three states, and that
// nothing is announced as a toast/message.
describe("connection status badge", () => {
  it("renders nothing without a container, the same as the other overlay widgets", () => {
    const { container } = render(<ConnectionStatusBadge container={null} status="connected" />);
    expect(container.querySelector("[data-testid='connection-status-badge']")).toBeNull();
  });

  it.each([
    ["connected", "Connected"],
    ["reconnecting", "Reconnecting"],
    ["offline", "Offline"],
  ] as const)("shows %s as its own data-status with a matching label", (status, label) => {
    const host = document.createElement("div");
    document.body.append(host);

    render(<ConnectionStatusBadge container={host} status={status} />);

    const badge = host.querySelector<HTMLElement>("[data-testid='connection-status-badge']");
    expect(badge?.dataset.status).toBe(status);
    expect(badge?.textContent).toContain(label);

    host.remove();
  });

  it("is not a toast -- no [data-sonner-toast] anywhere near it", () => {
    const host = document.createElement("div");
    document.body.append(host);

    render(<ConnectionStatusBadge container={host} status="reconnecting" />);

    expect(host.querySelector("[data-sonner-toast]")).toBeNull();
    host.remove();
  });
});
