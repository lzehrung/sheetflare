import type { ProjectSummary } from '@sheetflare/contracts';

type ProjectCardsProps = {
  projects: ProjectSummary[];
  selectedProjectSlug: string | null;
  onSelect: (projectSlug: string) => void;
};

export function ProjectCards({ projects, selectedProjectSlug, onSelect }: ProjectCardsProps) {
  return (
    <div className="projectList">
      {projects.map((project) => (
        <button
          key={project.slug}
          type="button"
          className={`projectListItem${selectedProjectSlug === project.slug ? ' projectListItemSelected' : ''}`}
          data-testid={`project-card-${project.slug}`}
          onClick={() => onSelect(project.slug)}
          aria-pressed={selectedProjectSlug === project.slug}
        >
          <div className="projectListTop">
            <div>
              <p className="slug">{project.slug}</p>
              <h3>{project.name}</h3>
            </div>
            <span className="badge">{project.tableCount} tables</span>
          </div>
          <dl className="facts compactFacts">
            <div>
              <dt>Spreadsheet</dt>
              <dd>{project.spreadsheetId}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </button>
      ))}
    </div>
  );
}
