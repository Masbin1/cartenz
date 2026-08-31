import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { IllegalTaskTransitionError } from '../../agent/task-state';
import { SecretNotFoundError } from '../secrets/secrets.provider';

interface ErrorBody {
  statusCode: number;
  message: string;
  error: string;
  correlationId: string;
  path: string;
}

/**
 * Single exception boundary for the API.
 *
 * Two things matter here. First, an unexpected error returns a generic message
 * and a correlation id; the detail goes to the server log and not to the client,
 * so an internal failure cannot disclose a query, a path or a connection string.
 * Second, domain errors are mapped to their proper status here rather than each
 * service throwing HTTP exceptions, which keeps the domain free of HTTP concerns.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const correlationId = randomUUID();

    const body = this.toBody(exception, correlationId, request.url);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${correlationId} ${request.method} ${request.url} -> ${body.statusCode}: ${
          exception instanceof Error ? exception.stack : String(exception)
        }`,
      );
    } else {
      this.logger.warn(
        `${correlationId} ${request.method} ${request.url} -> ${body.statusCode}: ${body.message}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, correlationId: string, path: string): ErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : this.joinMessage((payload as { message?: string | string[] }).message) ??
            exception.message;

      return { statusCode: status, message, error: exception.name, correlationId, path };
    }

    if (exception instanceof IllegalTaskTransitionError) {
      return {
        statusCode: HttpStatus.CONFLICT,
        message: exception.message,
        error: exception.name,
        correlationId,
        path,
      };
    }

    if (exception instanceof SecretNotFoundError) {
      // The reference is not echoed back: it is a handle to a credential.
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'The requested credential is no longer available.',
        error: exception.name,
        correlationId,
        path,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: `An unexpected error occurred. Quote reference ${correlationId} when reporting it.`,
      error: 'InternalServerError',
      correlationId,
      path,
    };
  }

  private joinMessage(message: string | string[] | undefined): string | undefined {
    if (message === undefined) return undefined;
    return Array.isArray(message) ? message.join('; ') : message;
  }
}
