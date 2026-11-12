/** Роли, которым доступен Control Plane. */
export const ADMIN_ROLES = ['admin', 'owner'] as const;

export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'owner';
}
