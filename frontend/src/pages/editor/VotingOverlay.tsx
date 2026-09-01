import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BarChart3, CheckSquare, Square, Vote, X } from "lucide-react";
import type { VotingSnapshot } from "./votingMode";
import "./VotingOverlay.css";

export type VotingUiState = {
  readonly snapshot: VotingSnapshot;
  readonly canModerate: boolean;
  readonly isComposing: boolean;
  readonly openCompose: () => void;
  readonly closeCompose: () => void;
  readonly open: (
    prompt: string,
    options: readonly string[],
    maxSelections: number,
  ) => Promise<{ readonly ok: boolean }>;
  readonly reveal: () => Promise<{ readonly ok: boolean }>;
  readonly close: () => Promise<{ readonly ok: boolean }>;
  readonly cast: (
    roundId: string,
    optionIds: readonly string[],
  ) => Promise<{ readonly ok: boolean }>;
};

const ComposeForm = ({ voting }: { voting: VotingUiState }) => {
  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [maxSelections, setMaxSelections] = useState(1);
  const setOption = (index: number, value: string) =>
    setOptions((current) => current.map((entry, i) => (i === index ? value : entry)));
  const canSubmit = prompt.trim().length > 0 && options.filter((o) => o.trim()).length >= 2;

  const submit = async () => {
    const labels = options.map((o) => o.trim()).filter(Boolean);
    const result = await voting.open(prompt.trim(), labels, Math.min(maxSelections, labels.length));
    if (result.ok) {
      setPrompt("");
      setOptions(["", ""]);
      setMaxSelections(1);
    }
  };

  return (
    <div className="voting-overlay__compose">
      <div className="voting-overlay__title-row">
        <Vote size={16} />
        <span>Start a vote</span>
        <button type="button" onClick={voting.closeCompose} aria-label="Cancel">
          <X size={14} />
        </button>
      </div>
      <input
        type="text"
        placeholder="What are you voting on?"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        data-testid="voting-prompt-input"
      />
      {options.map((option, index) => (
        <input
          key={index}
          type="text"
          placeholder={`Option ${index + 1}`}
          value={option}
          onChange={(event) => setOption(index, event.target.value)}
          data-testid="voting-option-input"
        />
      ))}
      <button
        type="button"
        className="voting-overlay__link-button"
        onClick={() => setOptions((current) => [...current, ""])}
        disabled={options.length >= 12}
      >
        + Add option
      </button>
      <label className="voting-overlay__multi">
        <input
          type="checkbox"
          checked={maxSelections > 1}
          onChange={(event) => setMaxSelections(event.target.checked ? 2 : 1)}
        />
        Allow more than one selection
      </label>
      <button
        type="button"
        className="voting-overlay__primary"
        onClick={submit}
        disabled={!canSubmit}
        data-testid="voting-open-submit"
      >
        Open vote (hidden until revealed)
      </button>
    </div>
  );
};

const Ballot = ({ voting }: { voting: VotingUiState }) => {
  const { snapshot } = voting;
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    setSelected([]);
    setSubmitted(false);
  }, [snapshot.roundId]);
  if (!snapshot.options || !snapshot.roundId || snapshot.maxSelections === null) return null;
  const multi = snapshot.maxSelections > 1;

  const toggle = (optionId: string) => {
    setSelected((current) => {
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);
      if (!multi) return [optionId];
      if (current.length >= snapshot.maxSelections!) return current;
      return [...current, optionId];
    });
  };

  const submit = async () => {
    if (selected.length === 0 || !snapshot.roundId) return;
    const result = await voting.cast(snapshot.roundId, selected);
    if (result.ok) setSubmitted(true);
  };

  return (
    <div className="voting-overlay__ballot">
      <p className="voting-overlay__prompt">{snapshot.prompt}</p>
      <ul>
        {snapshot.options.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              className={selected.includes(option.id) ? "voting-overlay__option--selected" : ""}
              onClick={() => toggle(option.id)}
              data-testid="voting-option"
            >
              {selected.includes(option.id) ? <CheckSquare size={14} /> : <Square size={14} />}
              {option.label}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="voting-overlay__primary"
        onClick={submit}
        disabled={selected.length === 0}
        data-testid="voting-cast-submit"
      >
        {submitted ? "Ballot recorded — change it?" : "Cast ballot"}
      </button>
      {typeof snapshot.participantCount === "number" && snapshot.participantCount > 0 ? (
        // How far along the room is -- never how it is leaning. Deliberately an
        // absolute number and not a ratio: "7 of 9" plus a visible participant
        // list lets anyone work out who has not voted yet, which puts pressure
        // on individuals. Suppressed at zero so an untouched round does not
        // announce its own emptiness.
        <p className="voting-overlay__cast-count" data-testid="voting-cast-count">
          {snapshot.participantCount === 1
            ? "1 vote cast"
            : `${snapshot.participantCount} votes cast`}
        </p>
      ) : null}
      {voting.canModerate ? (
        <button type="button" onClick={voting.reveal} data-testid="voting-reveal">
          <BarChart3 size={14} /> Reveal results
        </button>
      ) : null}
    </div>
  );
};

const Results = ({ voting }: { voting: VotingUiState }) => {
  const { snapshot } = voting;
  if (!snapshot.options || !snapshot.tally) return null;
  const total = Math.max(1, ...Object.values(snapshot.tally));
  return (
    <div className="voting-overlay__results">
      <p className="voting-overlay__prompt">{snapshot.prompt}</p>
      <ul>
        {snapshot.options.map((option) => {
          const count = snapshot.tally?.[option.id] ?? 0;
          return (
            <li key={option.id}>
              <div className="voting-overlay__result-label">
                <span>{option.label}</span>
                <span>{count}</span>
              </div>
              <div className="voting-overlay__result-bar">
                <div style={{ width: `${(count / total) * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="voting-overlay__participants">
        {snapshot.participantCount ?? 0} {snapshot.participantCount === 1 ? "person" : "people"}{" "}
        voted
      </p>
      {voting.canModerate ? (
        <button type="button" onClick={voting.close} data-testid="voting-close">
          Close
        </button>
      ) : null}
    </div>
  );
};

/**
 * Independent of presenting: any editor may open, reveal or close a round
 * (the same authority bar as the shared workshop timer), so this mounts
 * whenever there is something to show rather than only while presenting.
 */
export const VotingOverlay = ({
  container,
  voting,
}: {
  container: HTMLElement | null;
  voting: VotingUiState;
}) => {
  if (!container) return null;
  const showComposeForm = voting.isComposing && voting.snapshot.status === "idle";
  if (!showComposeForm && voting.snapshot.status === "idle") return null;

  return createPortal(
    <div className="voting-overlay" data-testid="voting-overlay">
      {showComposeForm ? <ComposeForm voting={voting} /> : null}
      {voting.snapshot.status === "open" ? <Ballot voting={voting} /> : null}
      {voting.snapshot.status === "revealed" ? <Results voting={voting} /> : null}
    </div>,
    container,
  );
};
