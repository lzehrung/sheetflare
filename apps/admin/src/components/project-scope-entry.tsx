import { useState, type FormEvent } from 'react';
import { projectSlugSchema } from '@sheetflare/contracts';

export type ProjectScopeEntryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string };

type ProjectScopeEntryProps = {
  message: string;
  entryState: ProjectScopeEntryState;
  onSubmit: (projectSlug: string) => void;
  disabled: boolean;
};

const invalidSlugMessage = 'Use lowercase letters, numbers, and single hyphens.';

export function ProjectScopeEntry({ message, entryState, onSubmit, disabled }: ProjectScopeEntryProps) {
  const [slug, setSlug] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const loading = entryState.status === 'loading';

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = projectSlugSchema.safeParse(slug.trim());
    if (!parsed.success) {
      setValidationError(invalidSlugMessage);
      return;
    }

    setValidationError(null);
    onSubmit(parsed.data);
  }

  const errorMessage = validationError ?? (entryState.status === 'error' ? entryState.message : null);

  return (
    <form className="stack compactStack" onSubmit={handleSubmit}>
      <p className="muted">{message}</p>
      <label className="field">
        <span>Project slug</span>
        <input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          aria-invalid={errorMessage ? 'true' : 'false'}
          aria-describedby={errorMessage ? 'project-scope-entry-error' : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {errorMessage ? (
        <p id="project-scope-entry-error" className="fieldMessage error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" disabled={disabled || loading || slug.trim().length === 0}>
          {loading ? 'Loading project...' : 'Load project'}
        </button>
      </div>
    </form>
  );
}
