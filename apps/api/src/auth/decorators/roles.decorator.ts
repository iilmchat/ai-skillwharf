import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Ограничивает доступ к эндпоинту ролями пользователя.
 *
 * ```ts
 * @UseGuards(JwtAuthGuard, RolesGuard)
 * @Roles('admin')
 * @Get('admin-only')
 * ```
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
