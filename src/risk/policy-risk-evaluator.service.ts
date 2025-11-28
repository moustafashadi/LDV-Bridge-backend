import { Injectable, Logger } from '@nestjs/common';
import { PoliciesService } from '../policies/policies.service';
import type { Change } from '@prisma/client';
import { DiffOperation } from '../changes/diff/json-diff.service';

export interface PolicyRuleResult {
  policyId: string;
  policyName: string;
  ruleId: string;
  title: string;
  category: 'security' | 'operational' | 'complexity' | 'governance' | 'dependency';
  severity: number; // 1-10
  autoBlock: boolean;
  evidence: any;
  message: string;
}

export interface PolicyEvaluationResult {
  violations: PolicyRuleResult[];
  autoBlockDetected: boolean;
  autoBlockRules: string[];
  totalViolations: number;
  severityScore: number; // Sum of all severities
}

@Injectable()
export class PolicyRiskEvaluatorService {
  private readonly logger = new Logger(PolicyRiskEvaluatorService.name);

  constructor(private readonly policiesService: PoliciesService) {}

  /**
   * Evaluate active policies as risk rules against a change
   */
  async evaluatePolicies(
    change: Change,
    organizationId: string,
  ): Promise<PolicyEvaluationResult> {
    try {
      this.logger.log(`Evaluating policies for change ${change.id}`);

      // Fetch active policies for organization
      const policies = await this.policiesService.findAll(organizationId, true);

      if (policies.length === 0) {
        this.logger.log('No active policies found');
        return this.getEmptyResult();
      }

      const diffSummary = change.diffSummary as any;
      const diffOperations: DiffOperation[] = diffSummary?.operations || [];

      const violations: PolicyRuleResult[] = [];

      // Evaluate each policy
      for (const policy of policies) {
        const policyRules = this.extractRulesFromPolicy(policy.rules);

        // Evaluate each rule in the policy
        for (const rule of policyRules) {
          const ruleViolations = this.evaluateRule(
            rule,
            diffOperations,
            diffSummary,
            change,
          );

          if (ruleViolations.length > 0) {
            // Add policy context to violations
            violations.push(
              ...ruleViolations.map((v) => ({
                ...v,
                policyId: policy.id,
                policyName: policy.name,
              })),
            );
          }
        }
      }

      // Detect autoBlock
      const autoBlockRules = violations.filter((v) => v.autoBlock).map((v) => v.ruleId);
      const autoBlockDetected = autoBlockRules.length > 0;

      // Calculate severity score
      const severityScore = violations.reduce((sum, v) => sum + v.severity, 0);

      this.logger.log(
        `Found ${violations.length} policy violations (${autoBlockRules.length} autoBlock)`,
      );

      return {
        violations,
        autoBlockDetected,
        autoBlockRules,
        totalViolations: violations.length,
        severityScore,
      };
    } catch (error) {
      this.logger.error(`Failed to evaluate policies: ${error.message}`, error.stack);
      return this.getEmptyResult();
    }
  }

  /**
   * Extract rules array from policy rules JSON
   */
  private extractRulesFromPolicy(policyRules: any): any[] {
    // Policy rules can be:
    // 1. { rules: [...] } - standard format
    // 2. [...] - array of rules
    // 3. { version: "1.0", rules: [...] } - versioned format

    if (Array.isArray(policyRules)) {
      return policyRules;
    }

    if (policyRules?.rules && Array.isArray(policyRules.rules)) {
      return policyRules.rules;
    }

    // Fallback: treat as single rule
    if (policyRules?.id) {
      return [policyRules];
    }

    return [];
  }

  /**
   * Evaluate a single rule against the change
   */
  private evaluateRule(
    rule: any,
    diffOperations: DiffOperation[],
    diffSummary: any,
    change: Change,
  ): PolicyRuleResult[] {
    const results: PolicyRuleResult[] = [];

    try {
      const matcher = rule.matcher || {};

      // Handle different matcher types
      if (matcher.type === 'jsonpath') {
        // JSONPath matching on diff operations
        const hits = this.matchJsonPath(matcher, diffOperations);
        if (hits.length > 0) {
          results.push(this.createViolation(rule, hits));
        }
      } else if (matcher.type === 'regex') {
        // Regex matching on field values
        const hits = this.matchRegex(matcher, diffOperations, change);
        if (hits.length > 0) {
          results.push(this.createViolation(rule, hits));
        }
      } else if (matcher.type === 'operation') {
        // Match specific diff operation types
        const hits = this.matchOperation(matcher, diffOperations);
        if (hits.length > 0) {
          results.push(this.createViolation(rule, hits));
        }
      } else if (matcher.type === 'count') {
        // Match on count thresholds
        const threshold = matcher.threshold || 0;
        const field = matcher.field || 'totalChanges';
        const value = diffSummary?.[field] || 0;

        if (value > threshold) {
          results.push(
            this.createViolation(rule, [
              { field, value, threshold, exceeded: value - threshold },
            ]),
          );
        }
      }

      // Apply invert logic if specified
      if (rule.invert && results.length === 0) {
        // Rule expects NO match, but we found no violations
        // So this is actually a violation
        results.push(
          this.createViolation(rule, [{ message: 'Expected condition not met' }]),
        );
      } else if (rule.invert && results.length > 0) {
        // Rule expects NO match, and we found matches
        // So clear violations (this is correct)
        return [];
      }
    } catch (error) {
      this.logger.warn(`Failed to evaluate rule ${rule.id}: ${error.message}`);
    }

    return results;
  }

  /**
   * Match JSONPath expression against diff operations
   */
  private matchJsonPath(matcher: any, operations: DiffOperation[]): any[] {
    const hits: any[] = [];
    const pattern = matcher.pattern || matcher.path;

    if (!pattern) return hits;

    // Simple JSONPath matching (can be enhanced with jsonpath library)
    for (const op of operations) {
      // Match path patterns
      if (pattern.includes('*')) {
        // Wildcard matching
        const regexPattern = pattern.replace(/\*/g, '.*').replace(/\//g, '\\/');
        if (new RegExp(regexPattern, 'i').test(op.path)) {
          hits.push(op);
        }
      } else if (op.path.includes(pattern)) {
        // Substring matching
        hits.push(op);
      }

      // Match value patterns (e.g., URLs, field names)
      if (matcher.valuePattern && op.value) {
        const valueStr = JSON.stringify(op.value);
        if (new RegExp(matcher.valuePattern, 'i').test(valueStr)) {
          hits.push(op);
        }
      }
    }

    return hits;
  }

  /**
   * Match regex pattern against field values
   */
  private matchRegex(matcher: any, operations: DiffOperation[], change: Change): any[] {
    const hits: any[] = [];
    const pattern = matcher.pattern;
    const field = matcher.field || 'path';

    if (!pattern) return hits;

    const regex = new RegExp(pattern, 'i');

    for (const op of operations) {
      let testValue: string | null = null;

      if (field === 'path') {
        testValue = op.path;
      } else if (field === 'value') {
        testValue = op.value ? JSON.stringify(op.value) : null;
      } else if (field === 'componentName' && change.afterMetadata) {
        // Extract component name from metadata
        const metadata = change.afterMetadata as any;
        testValue = metadata?.componentName || metadata?.name || null;
      }

      if (testValue && regex.test(testValue)) {
        hits.push({ ...op, matchedField: field, matchedValue: testValue });
      }
    }

    return hits;
  }

  /**
   * Match specific operation types (add, remove, replace)
   */
  private matchOperation(matcher: any, operations: DiffOperation[]): any[] {
    const targetOp = matcher.op;

    if (!targetOp) return [];

    return operations.filter((op) => op.op === targetOp);
  }

  /**
   * Create violation result from rule and evidence
   */
  private createViolation(rule: any, evidence: any[]): PolicyRuleResult {
    // Interpolate message with evidence values
    let message = rule.message || rule.title || 'Policy violation detected';

    // Replace {{field}} placeholders with actual values
    if (evidence.length > 0) {
      const firstEvidence = evidence[0];
      message = message.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string) => {
        // Navigate nested keys (e.g., {{value.url}})
        const keys = key.split('.');
        let value: any = firstEvidence;
        for (const k of keys) {
          value = value?.[k];
        }
        return value?.toString() || match;
      });
    }

    return {
      policyId: '', // Will be set by caller
      policyName: '', // Will be set by caller
      ruleId: rule.id || 'unknown',
      title: rule.title || 'Unnamed rule',
      category: rule.category || 'governance',
      severity: rule.severity || 5,
      autoBlock: rule.autoBlock === true,
      evidence: evidence.slice(0, 5), // Limit evidence size
      message,
    };
  }

  /**
   * Get empty evaluation result
   */
  private getEmptyResult(): PolicyEvaluationResult {
    return {
      violations: [],
      autoBlockDetected: false,
      autoBlockRules: [],
      totalViolations: 0,
      severityScore: 0,
    };
  }
}
