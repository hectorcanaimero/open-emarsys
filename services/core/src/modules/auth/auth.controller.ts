import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { CurrentPrincipal, type Principal, Public } from '@oe/ts-common/auth';
import { z } from 'zod';
import { AccountLockedException, AUTH_OPTIONS, type AuthOptions, AuthService } from './auth.service.js';

const totpCode = z.string().regex(/^\d{6}$/);
const loginBody = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1024) });
// A TOTP code, or a recovery code (`xxxxx-xxxxx`).
const mfaBody = z.object({ mfa_token: z.string().min(1), code: z.string().regex(/^(\d{6}|[a-z0-9]{5}-?[a-z0-9]{5})$/i) });
const refreshBody = z.object({ refresh_token: z.string().min(1).max(200) });
const codeBody = z.object({ code: totpCode });
const meBody = z.object({ locale: z.enum(['es', 'pt', 'en']) });

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  throw new BadRequestException({
    title: 'Bad Request',
    errors: r.error.issues.map((i) => ({ pointer: `/${i.path.join('/')}`, detail: i.message })),
  });
}

/** `/me` routes are for users only, never API clients or services. */
function userId(p: Principal | undefined): string {
  if (p?.typ !== 'user') throw new ForbiddenException('User token required');
  return p.sub;
}

interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/** Adds `Retry-After` to a 423 before it propagates to the problem+json filter. */
async function withRetryAfter<T>(res: HeaderSink, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AccountLockedException) res.setHeader('Retry-After', String(e.retryAfter));
    throw e;
  }
}

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions
  ) {}

  @Public()
  @Get('.well-known/jwks.json')
  jwks() {
    return this.options.signer.jwks;
  }

  @Public()
  @Post('admin/v1/auth/login')
  @HttpCode(200)
  login(@Body() body: unknown, @Res({ passthrough: true }) res: HeaderSink) {
    const { email, password } = parse(loginBody, body);
    return withRetryAfter(res, () => this.auth.login(email, password));
  }

  @Public()
  @Post('admin/v1/auth/mfa/verify')
  @HttpCode(200)
  verifyMfa(@Body() body: unknown, @Res({ passthrough: true }) res: HeaderSink) {
    const { mfa_token, code } = parse(mfaBody, body);
    return withRetryAfter(res, () => this.auth.verifyMfa(mfa_token, code));
  }

  @Public()
  @Post('admin/v1/auth/refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    return this.auth.refresh(parse(refreshBody, body).refresh_token);
  }

  @Post('admin/v1/auth/logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() p: Principal | undefined, @Body() body: unknown): Promise<void> {
    await this.auth.logout(userId(p), parse(refreshBody, body).refresh_token);
  }

  @Patch('admin/v1/me')
  updateMe(@CurrentPrincipal() p: Principal | undefined, @Body() body: unknown) {
    return this.auth.updateMe(userId(p), parse(meBody, body));
  }

  @Post('admin/v1/me/mfa/enroll')
  @HttpCode(200)
  enrollMfa(@CurrentPrincipal() p: Principal | undefined) {
    return this.auth.enrollMfa(userId(p));
  }

  // The contract (identity.yaml) says 204; the spec (F0.6.T4) returns the recovery codes here,
  // which is the only moment they can be shown.
  @Post('admin/v1/me/mfa/confirm')
  @HttpCode(200)
  confirmMfa(@CurrentPrincipal() p: Principal | undefined, @Body() body: unknown) {
    return this.auth.confirmMfa(userId(p), parse(codeBody, body).code);
  }

  @Delete('admin/v1/me/mfa')
  @HttpCode(204)
  async disableMfa(@CurrentPrincipal() p: Principal | undefined, @Body() body: unknown): Promise<void> {
    await this.auth.disableMfa(userId(p), parse(codeBody, body).code);
  }
}
