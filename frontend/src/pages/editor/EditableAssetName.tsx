import { useEffect, useRef, useState, type FormEvent } from "react";
import { notify } from "../../notifications";
import "./EditableAssetName.css";

type Props = {
  name: string;
  canEdit: boolean;
  onRename: (name: string) => Promise<void>;
};

export const EditableAssetName = ({ name, canEdit, onRename }: Props) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const committingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [editing, name]);

  const commit = async () => {
    if (committingRef.current) return;
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      setEditing(false);
      return;
    }
    committingRef.current = true;
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch {
      notify("error", "Couldn't rename the document. Please try again.");
    } finally {
      committingRef.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <form
        className="editable-asset-name"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void commit();
        }}
      >
        <input
          autoFocus
          className="editable-asset-name__input"
          aria-label="Document filename"
          value={draft}
          maxLength={255}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setDraft(name);
            setEditing(false);
          }}
        />
      </form>
    );
  }

  if (!canEdit) {
    return (
      <span className="editable-asset-name__label" title={name}>
        {name}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="editable-asset-name__button"
      aria-label={`Rename ${name}`}
      title={`${name} — click to rename`}
      onClick={() => setEditing(true)}
    >
      {name}
    </button>
  );
};
