import { Module } from '@nestjs/common';
import { PoliciesService } from './policies.service';
import { PoliciesController } from './policies.controller';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Policies Module
 * Provides policy management functionality for governance
 */
@Module({
  imports: [PrismaModule],
  controllers: [PoliciesController],
  providers: [PoliciesService],
  exports: [PoliciesService], // Export for use in other modules (Risk Assessment, Reviews)
})
export class PoliciesModule {}
