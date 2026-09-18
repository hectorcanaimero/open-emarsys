import {
  type CanActivate,
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { grantsOf, type Principal, TokenVerifier } from './verifier.js';

const PUBLIC = 'oe:auth:public';
const PERMISSIONS = 'oe:auth:permissions';
const INTERNAL = 'oe:auth:internal';

/** Route needs no token. */
export const Public = (): CustomDecorator => SetMetadata(PUBLIC, true);

/** Caller must hold every listed `module:action` (user `perms` or client/service `scopes`). */
export const RequirePermission = (...perms: string[]): CustomDecorator =>
  SetMetadata(PERMISSIONS, perms);

/** Only `typ=service` tokens (C4 `/internal/v1`). */
export const InternalOnly = (): CustomDecorator => SetMetadata(INTERNAL, true);

/** Injects the authenticated `Principal`. */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<{ principal?: Principal }>().principal
);

/**
 * Global guard: 401 without a valid token, 403 without permission.
 * Service tokens are only accepted on `@InternalOnly()` routes, and only they are.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; principal?: Principal }>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }
    let principal: Principal;
    try {
      principal = await this.verifier.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    req.principal = principal;

    const internal = this.reflector.getAllAndOverride<boolean>(INTERNAL, targets) ?? false;
    if (internal !== (principal.typ === 'service')) {
      throw new ForbiddenException(
        internal ? 'Service token required' : 'Service tokens are only valid on internal routes'
      );
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, targets) ?? [];
    const grants = grantsOf(principal);
    const missing = required.filter((p) => !grants.includes(p));
    if (missing.length) throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    return true;
  }
}
