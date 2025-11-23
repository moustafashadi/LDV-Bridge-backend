import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global module for audit logging
 * Available throughout the application
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
