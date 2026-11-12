import { useNavigate } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { useAuthStore } from '../store/auth.store'

const LOGOUT_BUTTON_CLASSES =
  'rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 transition hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400'

function getInitial(email: string): string {
  return email.trim().charAt(0).toUpperCase()
}

export function ChatPage() {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-svh overflow-hidden bg-slate-950 text-slate-100">
      <aside
        aria-label="Боковая панель"
        className="hidden w-72 shrink-0 flex-col border-r border-white/10 bg-slate-900/50 md:flex"
      >
        <div className="flex h-16 items-center border-b border-white/10 px-5">
          <Brand />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <h2 className="px-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
            Чаты
          </h2>
          <p className="mt-6 rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
            Пока нет чатов
          </p>
        </div>

        <div className="border-t border-white/10 p-4">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-cyan-400/10 text-sm font-semibold text-cyan-300"
            >
              {user === null ? '?' : getInitial(user.email)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-200">
                {user?.email ?? 'Гость'}
              </p>
              <p className="text-xs text-slate-500">{user?.role ?? '—'}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className={`mt-4 w-full ${LOGOUT_BUTTON_CLASSES}`}
          >
            Выйти
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="md:hidden">
              <Brand />
            </div>
            <h1 className="hidden text-sm font-medium text-slate-300 md:block">
              Новый чат
            </h1>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className={`md:hidden ${LOGOUT_BUTTON_CLASSES}`}
          >
            Выйти
          </button>
        </header>

        <section
          aria-labelledby="chat-welcome-title"
          className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-12 text-center"
        >
          <div
            aria-hidden="true"
            className="grid size-14 place-items-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-7 text-cyan-300"
            >
              <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4Z" />
              <path d="M8 11h8M8 15h5" />
            </svg>
          </div>
          <h2
            id="chat-welcome-title"
            className="text-2xl font-semibold tracking-tight text-white sm:text-3xl"
          >
            Добро пожаловать в SkillWharf
          </h2>
          <p className="max-w-md text-sm leading-relaxed text-slate-400">
            Это начало вашего рабочего пространства. Слева появятся чаты с
            агентами, а здесь — диалог и результаты работы.
          </p>
        </section>
      </main>
    </div>
  )
}
