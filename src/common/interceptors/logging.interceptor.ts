import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LoggerService } from '../logger/logger.service';

/**
 * Logging Interceptor
 * Logs all HTTP requests and responses with timing information
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('HTTP');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const { method, url, body, query, params, ip, headers } = request;
    const userAgent = headers['user-agent'] || '';
    const startTime = Date.now();

    // Get user info if available
    const user = request.user;
    const userId = user?.id || 'anonymous';
    const organizationId = user?.organizationId || 'none';

    // Log incoming request
    this.logger.log(
      `Incoming Request: ${method} ${url}`,
      JSON.stringify({
        method,
        url,
        userId,
        organizationId,
        ip,
        userAgent,
        query: Object.keys(query).length > 0 ? query : undefined,
        params: Object.keys(params).length > 0 ? params : undefined,
        body: this.sanitizeBody(body),
      }),
    );

    return next.handle().pipe(
      tap({
        next: (data) => {
          const duration = Date.now() - startTime;
          const statusCode = response.statusCode;

          // Log successful response
          this.logger.log(
            `Response Sent: ${method} ${url} ${statusCode} - ${duration}ms`,
            JSON.stringify({
              method,
              url,
              statusCode,
              duration: `${duration}ms`,
              userId,
              organizationId,
            }),
          );
        },
        error: (error) => {
          const duration = Date.now() - startTime;
          const statusCode = error.status || 500;

          // Log error response
          this.logger.error(
            `Error Response: ${method} ${url} ${statusCode} - ${duration}ms`,
            error.stack,
            JSON.stringify({
              method,
              url,
              statusCode,
              duration: `${duration}ms`,
              userId,
              organizationId,
              error: error.message,
            }),
          );
        },
      }),
    );
  }

  /**
   * Sanitize request body to remove sensitive information
   */
  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') {
      return body;
    }

    const sanitized = { ...body };
    const sensitiveFields = [
      'password',
      'token',
      'secret',
      'apiKey',
      'accessToken',
      'refreshToken',
      'authorization',
    ];

    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '***REDACTED***';
      }
    }

    return sanitized;
  }
}
