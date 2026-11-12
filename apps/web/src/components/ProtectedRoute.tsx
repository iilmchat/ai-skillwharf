import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/auth.store'

interface ProtectedRouteProps {
  children: ReactNode
}

/** Пропускает дальше только при наличии access-токена в auth-сторе. */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const accessToken = useAuthStore((state) => state.accessToken)
  const location = useLocation()

  if (accessToken === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return children
}
