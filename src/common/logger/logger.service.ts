import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as path from 'path';

@Injectable()
export class LoggerService implements NestLoggerService {
  private logger: winston.Logger;
  private context?: string;

  constructor() {
    this.logger = this.createLogger();
  }

  /**
   * Create Winston logger instance with file rotation
   */
  private createLogger(): winston.Logger {
    const isDevelopment = process.env.NODE_ENV !== 'production';

    // Define log format
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json(),
    );

    // Console format for development
    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, context, trace, ...meta }) => {
        let log = `${timestamp} [${context || 'Application'}] ${level}: ${message}`;
        if (trace) {
          log += `\n${trace}`;
        }
        if (Object.keys(meta).length > 0) {
          log += `\n${JSON.stringify(meta, null, 2)}`;
        }
        return log;
      }),
    );

    // Create transports
    const transports: winston.transport[] = [];

    // Console transport (always enabled)
    transports.push(
      new winston.transports.Console({
        format: isDevelopment ? consoleFormat : logFormat,
      }),
    );

    // File transports (only in production or if LOG_TO_FILE is true)
    if (!isDevelopment || process.env.LOG_TO_FILE === 'true') {
      const logsDir = path.join(process.cwd(), 'logs');

      // Error log - rotate daily
      transports.push(
        new DailyRotateFile({
          filename: path.join(logsDir, 'error-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          level: 'error',
          format: logFormat,
          maxSize: '20m',
          maxFiles: '14d',
          zippedArchive: true,
        }),
      );

      // Combined log - rotate daily
      transports.push(
        new DailyRotateFile({
          filename: path.join(logsDir, 'combined-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          format: logFormat,
          maxSize: '20m',
          maxFiles: '30d',
          zippedArchive: true,
        }),
      );
    }

    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      transports,
      exitOnError: false,
    });
  }

  /**
   * Set context for subsequent log messages
   */
  setContext(context: string) {
    this.context = context;
  }

  /**
   * Log a message at the specified level
   */
  private logMessage(level: string, message: any, context?: string, trace?: string) {
    const logContext = context || this.context || 'Application';
    
    if (typeof message === 'object') {
      this.logger.log(level, JSON.stringify(message), { context: logContext, trace });
    } else {
      this.logger.log(level, message, { context: logContext, trace });
    }
  }

  /**
   * Log info level message
   */
  log(message: any, context?: string) {
    this.logMessage('info', message, context);
  }

  /**
   * Log error level message
   */
  error(message: any, trace?: string, context?: string) {
    this.logMessage('error', message, context, trace);
  }

  /**
   * Log warn level message
   */
  warn(message: any, context?: string) {
    this.logMessage('warn', message, context);
  }

  /**
   * Log debug level message
   */
  debug(message: any, context?: string) {
    this.logMessage('debug', message, context);
  }

  /**
   * Log verbose level message
   */
  verbose(message: any, context?: string) {
    this.logMessage('verbose', message, context);
  }

  /**
   * Log fatal level message (alias for error)
   */
  fatal(message: any, trace?: string, context?: string) {
    this.logMessage('error', message, context, trace);
  }

  /**
   * Get the underlying Winston logger instance
   */
  getWinstonLogger(): winston.Logger {
    return this.logger;
  }
}
