interface BrandProps {
  className?: string;
}

export function Brand({ className = '' }: BrandProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-linear-to-br from-primary to-tertiary text-sm font-bold tracking-tight text-on-primary shadow-lg shadow-primary/25"
      >
        SW
      </span>
      <span className="font-display text-xl font-bold tracking-tight text-on-surface">
        Skill<span className="text-primary">Wharf</span>
      </span>
    </div>
  );
}
