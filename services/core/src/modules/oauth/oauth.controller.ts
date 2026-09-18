import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import { InternalOnly, Public } from '@oe/ts-common/auth';
import { z } from 'zod';
import { OAuthError, OAuthService } from './oauth.service.js';

const credential = z.string().min(1).max(200);
// Extended urlencoded parsing can yield arrays/objects; only plain strings are accepted.
const tokenBody = z.object({
  grant_type: z.string().max(100).optional(),
  client_id: credential.optional(),
  client_secret: credential.optional(),
  scope: z.string().max(2000).optional(),
});
const serviceBody = z.object({ client_id: credential, client_secret: credential });

interface RawResponse {
  status(code: number): RawResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** RFC 6749 §2.3.1: `Basic base64(urlencode(id):urlencode(secret))`. */
function basicCredentials(header: string): [string, string] | undefined {
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !value) return undefined;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return undefined;
  try {
    const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    return [dec(decoded.slice(0, i)), dec(decoded.slice(i + 1))];
  } catch {
    return undefined;
  }
}

@Controller()
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  /** C2 token endpoint. Writes RFC 6749 JSON itself instead of problem+json. */
  @Post('api/v3/oauth/token')
  @Public()
  async token(
    @Headers('content-type') contentType: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Res() res: RawResponse
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      const form = tokenBody.safeParse(body ?? {});
      if (!contentType?.startsWith('application/x-www-form-urlencoded') || !form.success) {
        throw new OAuthError(400, 'invalid_request', 'Expected an application/x-www-form-urlencoded body');
      }
      const { grant_type, client_id, client_secret, scope } = form.data;
      if (!grant_type) throw new OAuthError(400, 'invalid_request', 'grant_type is required');
      if (grant_type !== 'client_credentials') {
        throw new OAuthError(400, 'unsupported_grant_type', 'Only client_credentials is supported');
      }
      const basic = authorization ? basicCredentials(authorization) : undefined;
      if (authorization && !basic) throw new OAuthError(401, 'invalid_client', 'Malformed Basic credentials');
      if (basic && (client_id || client_secret)) {
        throw new OAuthError(400, 'invalid_request', 'Send client credentials either via Basic or in the body, not both');
      }
      const [id, secret] = basic ?? [client_id, client_secret];
      if (!id || !secret || id.length > 200 || secret.length > 200) {
        throw new OAuthError(401, 'invalid_client', 'Client credentials are required');
      }
      res.status(200).json(await this.oauth.clientToken(id, secret, scope));
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (e.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="open-emarsys"');
      if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
      res.status(e.status).json({ error: e.error, error_description: e.description });
    }
  }

  /** C4: issues `typ=service` tokens (never exposed by the gateway). */
  @Post('internal/v1/service-token')
  @Public()
  @HttpCode(200)
  async serviceToken(@Body() body: unknown) {
    const parsed = serviceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('client_id and client_secret are required');
    const token = await this.oauth.serviceToken(parsed.data.client_id, parsed.data.client_secret);
    if (!token) throw new UnauthorizedException('Invalid service credentials');
    return token;
  }

  /** C4: recently revoked API clients, for verifiers outside core. */
  @Get('internal/v1/revocations')
  @InternalOnly()
  revocations() {
    return this.oauth.revocations();
  }
}
