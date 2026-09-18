import { type Principal, TokenVerifier } from '@oe/ts-common/auth';

/**
 * Wraps a `TokenVerifier` and rejects `typ=client` tokens whose client is revoked. Tokens
 * live at most 1 h (`CLIENT_TOKEN_TTL`), so a revocation list only needs to cover that window.
 *
 * In core: `new RevocationAwareVerifier(signer.verifier(), (id) => oauthService.isRevoked(id))`.
 * Elsewhere: back `isRevoked` with `GET /internal/v1/revocations` or `system.api_client.revoked`.
 */
export class RevocationAwareVerifier extends TokenVerifier {
  constructor(
    private readonly inner: TokenVerifier,
    private readonly isRevoked: (clientId: string) => Promise<boolean>
  ) {
    // Keys and issuer belong to `inner`; this instance never verifies on its own.
    super(() => {
      throw new Error('unreachable');
    }, '');
  }

  override async verify(token: string): Promise<Principal> {
    const principal = await this.inner.verify(token);
    if (principal.typ === 'client' && (await this.isRevoked(principal.sub))) throw new Error('API client revoked');
    return principal;
  }
}
