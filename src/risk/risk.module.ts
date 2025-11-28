import { Module } from '@nestjs/common';
import { PolicyRiskEvaluatorService } from './policy-risk-evaluator.service';
import { FormulaAnalyzerService } from './formula-analyzer.service';
import { RiskScorerService } from './risk-scorer.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PoliciesModule } from '../policies/policies.module';

/**
 * Risk Assessment Module
 * 
 * Provides enhanced risk assessment capabilities for change detection:
 * - Policy-based risk rule evaluation
 * - PowerFx/Microflow formula complexity analysis
 * - Enhanced risk scoring algorithm
 * 
 * Used by ChangesModule to calculate risk scores and determine approval requirements.
 */
@Module({
  imports: [PrismaModule, PoliciesModule],
  providers: [
    PolicyRiskEvaluatorService,
    FormulaAnalyzerService,
    RiskScorerService,
  ],
  exports: [
    PolicyRiskEvaluatorService,
    FormulaAnalyzerService,
    RiskScorerService,
  ],
})
export class RiskModule {}
