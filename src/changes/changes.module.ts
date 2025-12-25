import { Module, forwardRef } from '@nestjs/common';
import { ChangesService } from './changes.service';
import { ChangesController } from './changes.controller';
import { ChangesGateway } from './changes.gateway';
import { JsonDiffService } from './diff/json-diff.service';
import { ImpactAnalyzerService } from './analyzers/impact-analyzer.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../common/audit/audit.module';
import { GitHubModule } from '../github/github.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PolicyRiskEvaluatorService } from 'src/risk/policy-risk-evaluator.service';
import { FormulaAnalyzerService } from 'src/risk/formula-analyzer.service';
import { RiskScorerService } from 'src/risk/risk-scorer.service';
import { PoliciesService } from 'src/policies/policies.service';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    forwardRef(() => GitHubModule),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('AUTH0_SECRET'),
      }),
    }),
  ],
  providers: [
    ChangesService,
    ChangesGateway,
    JsonDiffService,
    ImpactAnalyzerService,
    PolicyRiskEvaluatorService,
    FormulaAnalyzerService,
    RiskScorerService,
    PoliciesService,
  ],
  controllers: [ChangesController],
  exports: [ChangesService, ChangesGateway], // Export for other modules
})
export class ChangesModule {}
