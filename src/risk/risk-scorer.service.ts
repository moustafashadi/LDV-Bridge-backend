import { Injectable, Logger } from '@nestjs/common';
import type { Change } from '@prisma/client';
import { ImpactAnalysis } from '../changes/analyzers/impact-analyzer.service';
import { PolicyEvaluationResult } from './policy-risk-evaluator.service';
import { FormulaAnalysisResult } from './formula-analyzer.service';

export interface RiskScoreBreakdown {
  policyScore: number;
  complexityPenalty: number;
  formulaPenalty: number;
  autoBlockBonus: number;
  breakingChanges: number;
  affectedComponents: number;
  riskFactorScore: number;
  total: number;
}

export interface EnhancedRiskAssessment {
  score: number; // 0-100
  level: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
  autoBlockRules: string[];
  policyViolations: any[];
  formulaAnalysis?: FormulaAnalysisResult;
  impactAnalysis: ImpactAnalysis;
  scoreBreakdown: RiskScoreBreakdown;
  recommendations: string[];
  reviewers: string[];
  timestamp: Date;
}

/**
 * Tunable scoring parameters
 */
const WEIGHTS = {
  policySeverityMultiplier: 5, // severity × 5
  autoBlockBonus: 10, // +10 per autoBlock rule
  complexityMultiplier: 4, // log(nodes) × 4
  formulaMultiplier: 2, // formula score × 2
  breakingChangeMultiplier: 8, // breaking × 8
  affectedComponentMultiplier: 2, // components × 2
  riskFactorWeights: {
    low: 2,
    medium: 5,
    high: 10,
    critical: 15,
  },
};

@Injectable()
export class RiskScorerService {
  private readonly logger = new Logger(RiskScorerService.name);

  /**
   * Calculate enhanced risk score using policy violations, formula analysis, and impact analysis
   */
  calculateEnhancedRiskScore(
    change: Change,
    policyResult: PolicyEvaluationResult,
    formulaAnalysis: FormulaAnalysisResult | null,
    impactAnalysis: ImpactAnalysis,
  ): EnhancedRiskAssessment {
    this.logger.log(`Calculating enhanced risk score for change ${change.id}`);

    const scoreBreakdown: RiskScoreBreakdown = {
      policyScore: 0,
      complexityPenalty: 0,
      formulaPenalty: 0,
      autoBlockBonus: 0,
      breakingChanges: 0,
      affectedComponents: 0,
      riskFactorScore: 0,
      total: 0,
    };

    // 1. Policy violations score
    scoreBreakdown.policyScore = this.applyPolicyWeights(policyResult);

    // 2. Complexity penalty (from diff summary)
    const diffSummary = change.diffSummary as any;
    scoreBreakdown.complexityPenalty = this.applyComplexityPenalty(diffSummary);

    // 3. Formula complexity penalty
    if (formulaAnalysis && formulaAnalysis.hasFormulas) {
      scoreBreakdown.formulaPenalty = this.applyFormulaPenalty(formulaAnalysis);
    }

    // 4. AutoBlock bonus
    scoreBreakdown.autoBlockBonus =
      policyResult.autoBlockRules.length * WEIGHTS.autoBlockBonus;

    // 5. Breaking changes score
    scoreBreakdown.breakingChanges =
      impactAnalysis.breakingChanges * WEIGHTS.breakingChangeMultiplier;

    // 6. Affected components score
    scoreBreakdown.affectedComponents = Math.min(
      impactAnalysis.affectedComponents * WEIGHTS.affectedComponentMultiplier,
      20, // Cap at 20
    );

    // 7. Risk factors from impact analysis
    scoreBreakdown.riskFactorScore = this.calculateRiskFactorScore(
      impactAnalysis.riskFactors || [],
    );

    // Calculate total
    scoreBreakdown.total =
      scoreBreakdown.policyScore +
      scoreBreakdown.complexityPenalty +
      scoreBreakdown.formulaPenalty +
      scoreBreakdown.autoBlockBonus +
      scoreBreakdown.breakingChanges +
      scoreBreakdown.affectedComponents +
      scoreBreakdown.riskFactorScore;

    // Cap at 100
    const finalScore = Math.min(Math.round(scoreBreakdown.total), 100);

    // Determine risk level
    const level = this.determineRiskLevel(finalScore);

    // Determine if approval required
    const requiresApproval =
      policyResult.autoBlockDetected || level === 'high' || level === 'critical';

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      policyResult,
      formulaAnalysis,
      impactAnalysis,
      level,
    );

    // Determine required reviewers
    const reviewers = this.determineReviewers(level, policyResult.autoBlockDetected);

    return {
      score: finalScore,
      level,
      requiresApproval,
      autoBlockRules: policyResult.autoBlockRules,
      policyViolations: policyResult.violations,
      formulaAnalysis: formulaAnalysis || undefined,
      impactAnalysis,
      scoreBreakdown,
      recommendations,
      reviewers,
      timestamp: new Date(),
    };
  }

  /**
   * Apply policy severity weights
   */
  private applyPolicyWeights(policyResult: PolicyEvaluationResult): number {
    return policyResult.severityScore * WEIGHTS.policySeverityMultiplier;
  }

  /**
   * Apply complexity penalty based on change volume
   */
  private applyComplexityPenalty(diffSummary: any): number {
    if (!diffSummary) return 0;

    const newNodes = diffSummary.added || 0;
    const totalChanges = diffSummary.totalChanges || 0;

    // Logarithmic penalty for node count
    const nodePenalty = Math.log(1 + newNodes) * WEIGHTS.complexityMultiplier;

    // Additional penalty for high total changes
    const changePenalty = totalChanges > 50 ? 10 : totalChanges > 20 ? 5 : 0;

    return Math.round(nodePenalty + changePenalty);
  }

  /**
   * Apply formula complexity penalty
   */
  private applyFormulaPenalty(formulaAnalysis: FormulaAnalysisResult): number {
    let penalty = 0;

    // Base penalty from complexity score
    penalty += (formulaAnalysis.complexityScore / 100) * 20; // Max 20 points

    // Additional penalties for specific risks
    penalty += formulaAnalysis.unsafeFunctions.length * 3;
    penalty += formulaAnalysis.externalConnectors.length * 2;

    // High-severity risks
    const criticalRisks = formulaAnalysis.risks.filter((r) => r.severity === 'critical');
    const highRisks = formulaAnalysis.risks.filter((r) => r.severity === 'high');

    penalty += criticalRisks.length * 8;
    penalty += highRisks.length * 5;

    return Math.round(penalty * WEIGHTS.formulaMultiplier);
  }

  /**
   * Calculate score from risk factors
   */
  private calculateRiskFactorScore(
    riskFactors: Array<{ severity: 'low' | 'medium' | 'high' | 'critical' }>,
  ): number {
    let score = 0;

    for (const factor of riskFactors) {
      score += WEIGHTS.riskFactorWeights[factor.severity];
    }

    return score;
  }

  /**
   * Determine risk level from score
   */
  private determineRiskLevel(
    score: number,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    return 'low';
  }

  /**
   * Generate actionable recommendations
   */
  private generateRecommendations(
    policyResult: PolicyEvaluationResult,
    formulaAnalysis: FormulaAnalysisResult | null,
    impactAnalysis: ImpactAnalysis,
    level: string,
  ): string[] {
    const recommendations: string[] = [];

    // Policy violation recommendations
    for (const violation of policyResult.violations) {
      if (violation.category === 'security') {
        if (violation.title.toLowerCase().includes('external')) {
          recommendations.push(
            'Remove external API call or move to approved connector list',
          );
        } else if (violation.title.toLowerCase().includes('pii')) {
          recommendations.push('Review PII handling and ensure proper encryption/masking');
        }
      }

      if (violation.autoBlock) {
        recommendations.push(
          `Address critical policy violation: ${violation.title}`,
        );
      }
    }

    // Formula recommendations
    if (formulaAnalysis?.hasFormulas) {
      if (formulaAnalysis.complexityScore > 60) {
        recommendations.push('Consider refactoring complex formulas for maintainability');
      }

      for (const risk of formulaAnalysis.risks) {
        if (risk.severity === 'critical' || risk.severity === 'high') {
          recommendations.push(`Formula risk: ${risk.description}`);
        }
      }
    }

    // Impact recommendations
    if (impactAnalysis.breakingChanges > 0) {
      recommendations.push(
        `Review ${impactAnalysis.breakingChanges} breaking changes and update dependent components`,
      );
    }

    if (impactAnalysis.affectedComponents > 5) {
      recommendations.push(
        `${impactAnalysis.affectedComponents} components affected - thorough testing recommended`,
      );
    }

    // High-risk recommendations
    if (level === 'critical' || level === 'high') {
      recommendations.push('Request security review before deployment');
      recommendations.push('Create rollback plan in case of issues');
      recommendations.push('Monitor deployment closely and have team on standby');
    }

    // Deduplicate
    return Array.from(new Set(recommendations));
  }

  /**
   * Determine required reviewers based on risk level
   */
  private determineReviewers(level: string, autoBlock: boolean): string[] {
    const reviewers: string[] = [];

    if (autoBlock || level === 'critical') {
      reviewers.push('senior-pro-developer');
      reviewers.push('security-team');
    } else if (level === 'high') {
      reviewers.push('senior-pro-developer');
    } else if (level === 'medium') {
      reviewers.push('pro-developer');
    }

    // Low risk may not require explicit review (auto-approve)

    return reviewers;
  }
}
