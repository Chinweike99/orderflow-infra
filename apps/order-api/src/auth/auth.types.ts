import type { UserRole } from '../users/user.entity.js';

/** Claims stored in the access token. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

/** The authenticated user, attached to the request by JwtAuthGuard. */
export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}
