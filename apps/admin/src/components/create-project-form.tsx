import type { CreateProjectDraft } from '../admin-drafts';

type CreateProjectFormProps = {
  draft: CreateProjectDraft;
  fieldErrors: Partial<Record<keyof CreateProjectDraft | 'form', string>>;
  onChange: (next: CreateProjectDraft) => void;
  onSubmit: () => void;
  submitDisabled: boolean;
};

function renderFieldError(message: string | undefined) {
  return message ? <p className="fieldMessage error">{message}</p> : null;
}

export function CreateProjectForm({
  draft,
  fieldErrors,
  onChange,
  onSubmit,
  submitDisabled
}: CreateProjectFormProps) {
  return (
    <div className="stack compactStack">
      {fieldErrors.form ? <p className="error">{fieldErrors.form}</p> : null}
      <div className="formGrid twoColumnForm">
        <label className="field">
          <span>Slug</span>
          <input
            value={draft.slug}
            onChange={(event) => onChange({ ...draft, slug: event.target.value })}
            aria-invalid={fieldErrors.slug ? 'true' : 'false'}
          />
          {renderFieldError(fieldErrors.slug)}
        </label>
        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            aria-invalid={fieldErrors.name ? 'true' : 'false'}
          />
          {renderFieldError(fieldErrors.name)}
        </label>
        <label className="field fieldSpanFull">
          <span>Spreadsheet ID</span>
          <input
            value={draft.spreadsheetId}
            onChange={(event) => onChange({ ...draft, spreadsheetId: event.target.value })}
            aria-invalid={fieldErrors.spreadsheetId ? 'true' : 'false'}
          />
          {renderFieldError(fieldErrors.spreadsheetId)}
        </label>
        <label className="field">
          <span>Google Credential Ref</span>
          <input
            value={draft.googleCredentialRef}
            onChange={(event) => onChange({ ...draft, googleCredentialRef: event.target.value })}
            placeholder="default or named credential ref"
            aria-invalid={fieldErrors.googleCredentialRef ? 'true' : 'false'}
          />
          {renderFieldError(fieldErrors.googleCredentialRef)}
        </label>
        <label className="field">
          <span>Default Auth Mode</span>
          <select
            value={draft.defaultAuthMode}
            onChange={(event) =>
              onChange({
                ...draft,
                defaultAuthMode: event.target.value as 'private' | 'public-read'
              })
            }
          >
            <option value="private">private</option>
            <option value="public-read">public-read</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button type="button" onClick={onSubmit} disabled={submitDisabled}>
          Save project
        </button>
      </div>
    </div>
  );
}
