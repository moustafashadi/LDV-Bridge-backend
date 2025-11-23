import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger.service';

/**
 * Global Logger Module
 * Provides Winston-based logging throughout the application
 */
@Global()
@Module({
  providers: [LoggerService],
  exports: [LoggerService],
})
export class LoggerModule {}
