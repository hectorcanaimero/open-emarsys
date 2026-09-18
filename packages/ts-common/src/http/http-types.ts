/**
 * Minimal structural shape of the underlying HTTP request/response objects
 * Nest hands to filters/interceptors, kept dependency-free (no `express`
 * import) since only status/header/send/url are ever used here.
 */
export interface HttpResponseLike {
  status(code: number): this;
  header(name: string, value: string): this;
  send(body: unknown): void;
}

export interface HttpRequestLike {
  method: string;
  url: string;
  originalUrl?: string;
}
