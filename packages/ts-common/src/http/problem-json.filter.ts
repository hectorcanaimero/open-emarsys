import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { HttpRequestLike, HttpResponseLike } from './http-types.js';

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Array<{ pointer: string; detail: string }>;
}

/**
 * RFC 9457 `application/problem+json` error format for `/admin/v1` and
 * `/internal/v1` (C3).
 */
@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<HttpResponseLike>();
    const request = ctx.getRequest<HttpRequestLike>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = exception instanceof HttpException ? exception.getResponse() : undefined;
    const { title, detail, errors } = extractProblemFields(exception, body);

    const problem: ProblemDetail = {
      type: 'about:blank',
      title,
      status,
      detail,
      instance: request.originalUrl ?? request.url,
      ...(errors ? { errors } : {}),
    };

    response.status(status).header('Content-Type', 'application/problem+json').send(problem);
  }
}

function extractProblemFields(
  exception: unknown,
  body: string | object | undefined
): {
  title: string;
  detail?: string;
  errors?: Array<{ pointer: string; detail: string }>;
} {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.errors !== 'undefined') {
      return {
        title: typeof record.title === 'string' ? record.title : httpExceptionTitle(exception),
        detail: typeof record.detail === 'string' ? record.detail : undefined,
        errors: record.errors as Array<{ pointer: string; detail: string }>,
      };
    }
    const message = record.message;
    return {
      title: httpExceptionTitle(exception),
      detail: typeof message === 'string' ? message : Array.isArray(message) ? message.join('; ') : undefined,
    };
  }
  if (typeof body === 'string') {
    return { title: httpExceptionTitle(exception), detail: body };
  }
  return {
    title: httpExceptionTitle(exception),
    detail: exception instanceof Error ? exception.message : 'Internal server error',
  };
}

function httpExceptionTitle(exception: unknown): string {
  const status =
    exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  return STATUS_CODES[status] ?? 'Internal Server Error';
}
