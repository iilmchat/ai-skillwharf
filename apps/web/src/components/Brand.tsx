export function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-linear-to-br from-cyan-400 to-sky-600 text-sm font-bold tracking-tight text-slate-950 shadow-lg shadow-cyan-500/20"
      >
        SW
      </span>
      <span className="text-lg font-semibold tracking-tight text-white">
        Skill<span className="text-cyan-400">Wharf</span>
      </span>
    </div>
  )
}
