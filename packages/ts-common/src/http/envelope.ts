import {
  type ArgumentsHost,
  type CallHandler,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { HttpResponseLike } from './http-types.js';

export interface Envelope<T> {
  replyCode: number;
  replyText: string;
  data: T;
}

/**
 * Business error for the public API (C2). `replyCode` is a non-zero
 * application error code, distinct from the HTTP status.
 */
export class PublicApiError extends HttpException {
  constructor(
    public readonly replyCode: number,
    replyText: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST
  ) {
    super(replyText, status);
  }
}

/** Wraps every successful `/api/v3` response in `{replyCode: 0, replyText: 'OK', data}` (C2). */
@Injectable()
export class PublicEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<Envelope<unknown>> {
    return next.handle().pipe(map((data) => ({ replyCode: 0, replyText: 'OK', data })));
  }
}

/** Wraps errors thrown under `/api/v3` in the same envelope shape, with a business `replyCode` (C2). */
@Catch()
export class PublicEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    // The envelope hides the cause from the client; without this a 500 leaves no trace at all.
    if (!(exception instanceof HttpException)) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<HttpResponseLike>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const replyCode = exception instanceof PublicApiError ? exception.replyCode : status;
    const replyText = exception instanceof HttpException ? messageOf(exception) : 'Internal server error';

    const envelope: Envelope<null> = { replyCode, replyText, data: null };
    response.status(status).header('Content-Type', 'application/json').send(envelope);
  }
}

function messageOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
  }
  return exception.message;
}
