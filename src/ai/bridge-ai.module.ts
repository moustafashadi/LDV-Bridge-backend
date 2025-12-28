import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BridgeAIService } from './bridge-ai.service';
import { BridgeAIController } from './bridge-ai.controller';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * BridgeAI Module
 *
 * Provides AI-powered security analysis for code changes using Anthropic Claude.
 * Features:
 * - On-demand security analysis triggered by pro-developers
 * - Analysis results stored for audit trail
 * - Advisory-only (does not affect risk score)
 */
@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [BridgeAIController],
  providers: [BridgeAIService],
  exports: [BridgeAIService],
})
export class BridgeAIModule {}
