import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'linkederp:isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * The guard is applied globally, so authentication is the default and a new
 * endpoint is protected unless someone deliberately opts out here. The inverse
 * arrangement - opt in to protection - leaves an endpoint open whenever the
 * decorator is forgotten.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
