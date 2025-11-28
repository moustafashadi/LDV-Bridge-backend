import { Module } from '@nestjs/common';
import { ChangesService } from './changes.service';
import { ChangesController } from './changes.controller';
import { JsonDiffService } from './diff/json-diff.service';
import { ImpactAnalyzerService } from './analyzers/impact-analyzer.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../common/audit/audit.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('AUTH0_SECRET'),
      }),
    }),
  ],
  providers: [ChangesService, JsonDiffService, ImpactAnalyzerService],
  controllers: [ChangesController],
  exports: [ChangesService], // Export for SyncService to use
})
export class ChangesModule {}
