import type { ProjectSummary } from '@sheetflare/contracts';

type ProjectCardsProps = {
  projects: ProjectSummary[];
  selectedProjectSlug: string | null;
  onSelect: (projectSlug: string) => void;
};

export function ProjectCards({ projects, selectedProjectSlug, onSelect }: ProjectCardsProps) {
  return (
    <div className="cards">
      {projects.map((project) => (
        <article
          key={project.slug}
          className={`card selectableCard${selectedProjectSlug === project.slug ? ' selectedCard' : ''}`}
          data-testid={`project-card-${project.slug}`}
          onClick={() => onSelect(project.slug)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(project.slug);
            }
          }}
          role="button"
          tabIndex={0}
          aria-pressed={selectedProjectSlug === project.slug}
        >
          <div className="cardTop">
            <div>
              <p className="slug">{project.slug}</p>
              <h3>{project.name}</h3>
            </div>
            <span className="badge">{project.tableCount} tables</span>
          </div>
          <dl className="facts">
            <div>
              <dt>Spreadsheet</dt>
              <dd>{project.spreadsheetId}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
