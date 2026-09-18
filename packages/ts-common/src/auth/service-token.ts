export interface ServiceTokenOptions {
  /** Base URL of core, e.g. `http://core:3000`. */
  coreUrl: string;
  clientId: string;
  clientSecret: string;
  /** Renew this long before expiry. Default 60 s. */
  refreshSkewMs?: number;
}

/**
 * Obtains and renews a `typ=service` token from core (`POST /internal/v1/service-token`)
 * for C4 calls. Concurrent callers share one in-flight request.
 */
export class ServiceTokenClient {
  private token?: { value: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(private readonly o: ServiceTokenOptions) {}

  async getToken(): Promise<string> {
    const skew = this.o.refreshSkewMs ?? 60_000;
    if (this.token && Date.now() < this.token.expiresAt - skew) return this.token.value;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** `Authorization` header value for an internal request. */
  async authorization(): Promise<string> {
    return `Bearer ${await this.getToken()}`;
  }

  private async fetchToken(): Promise<string> {
    // ponytail: request/response shape assumed until core's endpoint (F0.6.T6) is contracted.
    const res = await fetch(new URL('/internal/v1/service-token', this.o.coreUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.o.clientId, client_secret: this.o.clientSecret }),
    });
    if (!res.ok) throw new Error(`service token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}
