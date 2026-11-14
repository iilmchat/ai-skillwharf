import type { ResumeCandidate } from '../lib/resume';

/** Подписи карточек; передаются страницей, чтобы компонент оставался чистым. */
export interface ResumeLabels {
  resume: string;
  summary: string;
  skills: string;
  experience: string;
  education: string;
  verdict: string;
  match: string;
  years: string;
  score: string;
}

function MetaBadge({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-outline-variant bg-surface-container px-2.5 py-1 text-[11px] font-medium text-on-surface-variant">
      {children}
    </span>
  );
}

/**
 * Карточки кандидата из `resume-screener`: навыки, опыт и образование
 * вместо сырого JSON в пузыре чата.
 */
export function ResumeCards({
  resume,
  labels,
}: {
  resume: ResumeCandidate;
  labels: ResumeLabels;
}) {
  const hasHeader =
    resume.name !== null ||
    resume.title !== null ||
    resume.score !== null ||
    resume.verdict !== null;

  return (
    <section
      aria-label={labels.resume}
      className="space-y-4 rounded-2xl border border-primary/25 bg-surface p-4"
    >
      {hasHeader && (
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {resume.name !== null && (
              <p className="font-display text-base font-bold text-on-surface">
                {resume.name}
              </p>
            )}
            {resume.title !== null && (
              <p className="text-xs text-on-surface-variant">{resume.title}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {resume.score !== null && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-2.5 py-1 text-[11px] font-semibold text-on-primary-container">
                {labels.match}: {resume.score}
                <span className="sr-only">{labels.score}</span>
              </span>
            )}
            {resume.verdict !== null && (
              <span className="inline-flex items-center rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
                {labels.verdict}: {resume.verdict}
              </span>
            )}
          </div>
        </header>
      )}

      {resume.summary !== null && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            {labels.summary}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-on-surface">
            {resume.summary}
          </p>
        </div>
      )}

      {resume.skills.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            {labels.skills}
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {resume.skills.map((skill) => (
              <li
                key={skill.name}
                className="inline-flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container px-2.5 py-1 text-xs font-medium text-on-surface"
              >
                {skill.name}
                {skill.years !== null && (
                  <span className="text-[11px] text-on-surface-variant">
                    · {skill.years} {labels.years}
                  </span>
                )}
                {skill.level !== null && (
                  <span className="text-[11px] text-on-surface-variant">
                    · {labels.score} {skill.level}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {resume.experience.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            {labels.experience}
          </p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {resume.experience.map((item, index) => (
              <li
                key={`${item.company}-${index}`}
                className="rounded-xl border border-outline-variant bg-surface-container/60 p-3"
              >
                <p className="text-sm font-semibold text-on-surface">
                  {item.company}
                </p>
                {(item.position !== null || item.period !== null) && (
                  <p className="mt-0.5 text-[11px] text-on-surface-variant">
                    {[item.position, item.period]
                      .filter((value): value is string => value !== null)
                      .join(' · ')}
                  </p>
                )}
                {item.description !== null && (
                  <p className="mt-2 text-xs leading-relaxed text-on-surface">
                    {item.description}
                  </p>
                )}
                {item.skills.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {item.skills.map((skill) => (
                      <li key={skill}>
                        <MetaBadge>{skill}</MetaBadge>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {resume.education.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            {labels.education}
          </p>
          <ul className="mt-2 space-y-1.5">
            {resume.education.map((item, index) => (
              <li
                key={`${item.institution}-${index}`}
                className="text-xs text-on-surface"
              >
                <span className="font-semibold">{item.institution}</span>
                {item.degree !== null && ` — ${item.degree}`}
                {item.period !== null && (
                  <span className="text-on-surface-variant">
                    {' '}
                    · {item.period}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
