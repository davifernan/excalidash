import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MentionTextarea } from "./MentionTextarea";
import type { MentionCandidate } from "../../../api/comments";

const CANDIDATES: MentionCandidate[] = [
  { userId: "u-anna", name: "Anna" },
  { userId: "u-anton", name: "Anton" },
  { userId: "u-beth", name: "Beth" },
];

/** A controlled wrapper: the real component is fully controlled, and the
 * keyboard behaviour under test depends on onChange actually round-tripping
 * back into `value`, the same way CommentPanel's own usage does. */
const Harness: React.FC<{ candidates?: MentionCandidate[] }> = ({ candidates = CANDIDATES }) => {
  const [value, setValue] = useState("");
  return (
    <MentionTextarea value={value} onChange={setValue} candidates={candidates} data-testid="mt" />
  );
};

describe("MentionTextarea", () => {
  it("opens the suggestion list on @ and filters by the typed query", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("mt");
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    expect(screen.getByTestId("mention-suggestions")).toBeInTheDocument();
    expect(screen.getByText("Anna")).toBeInTheDocument();
    expect(screen.getByText("Anton")).toBeInTheDocument();
    expect(screen.queryByText("Beth")).not.toBeInTheDocument();
  });

  it("closes the suggestion list on Escape without changing the text", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    expect(screen.getByTestId("mention-suggestions")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByTestId("mention-suggestions")).not.toBeInTheDocument();
    expect(textarea.value).toBe("hey @an");
  });

  it("Enter with no arrow keys inserts the first match, structured token and all", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("hey @[Anna](u-anna) ");
  });

  /**
   * RED PROBE evidence (see PR HANDOFF): before ArrowDown/ArrowUp tracked an
   * active index, Enter always inserted matches[0] regardless of how far a
   * keyboard-only user had navigated -- there was no way to reach "Anton"
   * through the keyboard at all when "Anna" sorted first. This is the test
   * that would have caught it.
   */
  it("ArrowDown moves the active suggestion, and Enter inserts that one instead of the first", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("hey @[Anton](u-anton) ");
  });

  it("ArrowDown wraps from the last match back to the first", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    fireEvent.keyDown(textarea, { key: "ArrowDown" }); // Anton
    fireEvent.keyDown(textarea, { key: "ArrowDown" }); // wraps to Anna
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("hey @[Anna](u-anna) ");
  });

  it("ArrowUp from the first match wraps to the last", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    fireEvent.keyDown(textarea, { key: "ArrowUp" }); // wraps to Anton (last of 2 matches)
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("hey @[Anton](u-anton) ");
  });

  it("exposes the active option through aria-activedescendant, not only visually", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    const annaOption = screen.getByText("Anna").closest('[role="option"]') as HTMLElement;
    expect(textarea.getAttribute("aria-activedescendant")).toBe(annaOption.id);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    const antonOption = screen.getByText("Anton").closest('[role="option"]') as HTMLElement;
    expect(textarea.getAttribute("aria-activedescendant")).toBe(antonOption.id);
  });

  it("Ctrl/Cmd+Enter submits when no suggestion list is open", () => {
    let submitted = 0;
    const Controlled: React.FC = () => {
      const [value, setValue] = useState("hello");
      return (
        <MentionTextarea
          value={value}
          onChange={setValue}
          candidates={CANDIDATES}
          onSubmit={() => {
            submitted += 1;
          }}
          data-testid="mt"
        />
      );
    };
    render(<Controlled />);
    const textarea = screen.getByTestId("mt");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(submitted).toBe(1);
  });

  it("plain Enter does NOT submit unless submitOnEnter is set (the compose box's own default)", () => {
    let submitted = 0;
    const Controlled: React.FC = () => {
      const [value, setValue] = useState("hello");
      return (
        <MentionTextarea
          value={value}
          onChange={setValue}
          candidates={CANDIDATES}
          onSubmit={() => {
            submitted += 1;
          }}
          data-testid="mt"
        />
      );
    };
    render(<Controlled />);
    fireEvent.keyDown(screen.getByTestId("mt"), { key: "Enter" });
    expect(submitted).toBe(0);
  });

  /**
   * RED PROBE evidence (see PR HANDOFF): submitOnEnter is what a reply row
   * (CommentPanel's ThreadCard) opts into to keep its pre-mention-picker
   * "type and hit Enter" behavior once it started reusing this component
   * instead of a plain <input>. Without it, replies would have silently
   * required Ctrl/Cmd+Enter like the top-level compose box, an unannounced
   * behavior change for existing users of a feature already in main.
   */
  it("submitOnEnter: plain Enter submits, Shift+Enter still inserts a newline instead", () => {
    let submitted = 0;
    const Controlled: React.FC = () => {
      const [value, setValue] = useState("hello");
      return (
        <MentionTextarea
          value={value}
          onChange={setValue}
          candidates={CANDIDATES}
          submitOnEnter
          onSubmit={() => {
            submitted += 1;
          }}
          data-testid="mt"
        />
      );
    };
    render(<Controlled />);
    const textarea = screen.getByTestId("mt");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(submitted).toBe(0);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(submitted).toBe(1);
  });

  it("submitOnEnter still lets Enter accept a mention suggestion instead of submitting while one is open", () => {
    let submitted = 0;
    const Controlled: React.FC = () => {
      const [value, setValue] = useState("");
      return (
        <MentionTextarea
          value={value}
          onChange={setValue}
          candidates={CANDIDATES}
          submitOnEnter
          onSubmit={() => {
            submitted += 1;
          }}
          data-testid="mt"
        />
      );
    };
    render(<Controlled />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    // The trigger only arms on an actual change event, same as every other
    // test here -- setting an initial `value` prop is not one.
    fireEvent.change(textarea, { target: { value: "hey @an" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(submitted).toBe(0);
    expect(textarea.value).toBe("hey @[Anna](u-anna) ");
  });

  /**
   * RED PROBE evidence (see PR HANDOFF): an active "@" trigger with zero
   * matching candidates (a typo, an email address typed into the body) used
   * to fall between the two Enter-handling branches -- the suggestion branch
   * required `matches.length > 0`, the submit branch required
   * `triggerStart === null` -- so Enter did nothing at all: no insert, no
   * submit, just a swallowed keystroke (a stray newline in the plain-Enter
   * case).
   */
  it("Enter still submits when an @ trigger is open but nothing matches it", () => {
    let submitted = 0;
    const Controlled: React.FC = () => {
      const [value, setValue] = useState("");
      return (
        <MentionTextarea
          value={value}
          onChange={setValue}
          candidates={CANDIDATES}
          submitOnEnter
          onSubmit={() => {
            submitted += 1;
          }}
          data-testid="mt"
        />
      );
    };
    render(<Controlled />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @zzz-no-match" } });
    expect(screen.queryByTestId("mention-suggestions")).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(submitted).toBe(1);
  });

  it("Ctrl+Enter still submits when an @ trigger is open but nothing matches it (compose box, no submitOnEnter)", () => {
    let submitted = 0;
    const Controlled: React.FC = () => {
      const [value, setValue] = useState("");
      return (
        <MentionTextarea
          value={value}
          onChange={setValue}
          candidates={CANDIDATES}
          onSubmit={() => {
            submitted += 1;
          }}
          data-testid="mt"
        />
      );
    };
    render(<Controlled />);
    const textarea = screen.getByTestId("mt") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @zzz-no-match" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(submitted).toBe(1);
  });
});
