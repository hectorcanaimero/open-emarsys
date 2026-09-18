import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Principal } from '@oe/ts-common/auth';

/** `x-operator-only: true` (identity.yaml): the caller must have `tenant_id = null`. */
@Injectable()
export class OperatorOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
    if (req.principal?.tenant_id !== null) {
      throw new ForbiddenException('Operator principal required');
    }
    return true;
  }
}
