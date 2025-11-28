import { Injectable, Logger } from '@nestjs/common';

export interface FormulaRisk {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  function?: string;
  action?: string;
  description: string;
  line?: number;
}

export interface FormulaAnalysisResult {
  hasFormulas: boolean;
  platform?: 'powerapps' | 'mendix';
  complexityScore: number; // 0-100
  unsafeFunctions: string[];
  nestingDepth: number;
  functionCallCount: number;
  externalConnectors: string[];
  risks: FormulaRisk[];
}

@Injectable()
export class FormulaAnalyzerService {
  private readonly logger = new Logger(FormulaAnalyzerService.name);

  // PowerFx unsafe functions
  private readonly POWERAPPS_UNSAFE_FUNCTIONS = [
    'HTTP',
    'Patch',
    'Remove',
    'RemoveIf',
    'Clear',
    'Collect',
    'ClearCollect',
    'UpdateContext',
    'Navigate',
    'Back',
    'Exit',
    'Launch',
    'Param',
  ];

  // PowerFx external connectors
  private readonly POWERAPPS_EXTERNAL_CONNECTORS = [
    'Office365',
    'Office365Users',
    'Office365Outlook',
    'SharePoint',
    'OneDrive',
    'Dynamics',
    'SQL',
    'Excel',
    'PowerBI',
  ];

  // Mendix unsafe actions
  private readonly MENDIX_UNSAFE_ACTIONS = [
    'CallREST',
    'CallWebService',
    'Delete',
    'Create',
    'Change',
    'Commit',
    'Rollback',
    'DeleteObject',
    'ChangeObject',
  ];

  /**
   * Analyze formula complexity and risks
   */
  analyzeFormula(code: string | null, platform: 'powerapps' | 'mendix'): FormulaAnalysisResult {
    if (!code) {
      return this.getEmptyResult();
    }

    this.logger.log(`Analyzing ${platform} formula (${code.length} chars)`);

    if (platform === 'powerapps') {
      return this.analyzePowerFx(code);
    } else {
      return this.analyzeMicroflow(code);
    }
  }

  /**
   * Analyze PowerFx formula
   */
  private analyzePowerFx(formula: string): FormulaAnalysisResult {
    const risks: FormulaRisk[] = [];
    const unsafeFunctions: string[] = [];
    const externalConnectors: string[] = [];

    // Tokenize formula (simple approach)
    const tokens = formula.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
    const functionCalls = formula.match(/[a-zA-Z_][a-zA-Z0-9_]*\s*\(/g) || [];

    // Count nesting depth (parentheses)
    const nestingDepth = this.calculateNestingDepth(formula);

    // Detect unsafe functions
    for (const func of this.POWERAPPS_UNSAFE_FUNCTIONS) {
      const regex = new RegExp(`\\b${func}\\s*\\(`, 'gi');
      if (regex.test(formula)) {
        unsafeFunctions.push(func);
        risks.push(this.createPowerFxRisk(func, formula));
      }
    }

    // Detect external connectors
    for (const connector of this.POWERAPPS_EXTERNAL_CONNECTORS) {
      const regex = new RegExp(`\\b${connector}\\.`, 'gi');
      if (regex.test(formula)) {
        externalConnectors.push(connector);
        risks.push({
          type: 'external_connector',
          severity: 'medium',
          function: connector,
          description: `Uses external connector: ${connector}`,
        });
      }
    }

    // Detect string concatenation with user input (potential injection)
    if (this.detectStringConcatenation(formula)) {
      risks.push({
        type: 'string_concatenation',
        severity: 'high',
        description: 'Concatenates strings with user input - potential injection risk',
      });
    }

    // Calculate complexity score
    const complexityScore = this.calculateComplexityScore(
      functionCalls.length,
      nestingDepth,
      tokens.length,
    );

    return {
      hasFormulas: true,
      platform: 'powerapps',
      complexityScore,
      unsafeFunctions,
      nestingDepth,
      functionCallCount: functionCalls.length,
      externalConnectors,
      risks,
    };
  }

  /**
   * Analyze Mendix Microflow (XML)
   */
  private analyzeMicroflow(xml: string): FormulaAnalysisResult {
    const risks: FormulaRisk[] = [];
    const unsafeActions: string[] = [];
    const externalConnectors: string[] = [];

    // Simple XML parsing (can be enhanced with xml2js)
    const actionMatches = xml.match(/<action[^>]*type="([^"]+)"/gi) || [];
    const actionCount = actionMatches.length;

    // Detect unsafe actions
    for (const action of this.MENDIX_UNSAFE_ACTIONS) {
      const regex = new RegExp(`type="${action}"`, 'gi');
      if (regex.test(xml)) {
        unsafeActions.push(action);
        risks.push(this.createMendixRisk(action, xml));
      }
    }

    // Detect external REST calls
    if (xml.includes('CallREST') || xml.includes('CallWebService')) {
      const urlMatch = xml.match(/<url>([^<]+)<\/url>/);
      const url = urlMatch ? urlMatch[1] : 'unknown';

      if (!url.includes('localhost') && !url.includes('internal.')) {
        risks.push({
          type: 'external_api',
          severity: 'high',
          action: 'CallREST',
          description: `Makes external API call to: ${url}`,
        });
      }
    }

    // Calculate complexity (based on action count and depth)
    const nestingDepth = this.calculateXmlNestingDepth(xml);
    const complexityScore = this.calculateComplexityScore(actionCount, nestingDepth, 100);

    return {
      hasFormulas: true,
      platform: 'mendix',
      complexityScore,
      unsafeFunctions: unsafeActions,
      nestingDepth,
      functionCallCount: actionCount,
      externalConnectors,
      risks,
    };
  }

  /**
   * Create PowerFx-specific risk description
   */
  private createPowerFxRisk(func: string, formula: string): FormulaRisk {
    const riskMap: Record<string, { severity: any; description: string }> = {
      HTTP: {
        severity: 'high',
        description: 'Makes external HTTP API calls - security and reliability risk',
      },
      Patch: {
        severity: 'medium',
        description: 'Modifies data records - ensure proper validation',
      },
      Remove: {
        severity: 'high',
        description: 'Deletes data records - irreversible operation',
      },
      RemoveIf: {
        severity: 'high',
        description: 'Conditionally deletes data records - verify conditions',
      },
      Clear: {
        severity: 'medium',
        description: 'Clears collection or data - ensure intentional',
      },
      Collect: {
        severity: 'low',
        description: 'Adds data to collection - monitor memory usage',
      },
      ClearCollect: {
        severity: 'medium',
        description: 'Replaces entire collection - verify data loss acceptable',
      },
      Navigate: {
        severity: 'low',
        description: 'Changes screen navigation - verify user flow',
      },
      Launch: {
        severity: 'medium',
        description: 'Launches external URL or app - verify target',
      },
    };

    const risk = riskMap[func] || {
      severity: 'medium',
      description: `Uses function: ${func}`,
    };

    return {
      type: 'unsafe_function',
      severity: risk.severity,
      function: func,
      description: risk.description,
    };
  }

  /**
   * Create Mendix-specific risk description
   */
  private createMendixRisk(action: string, xml: string): FormulaRisk {
    const riskMap: Record<string, { severity: any; description: string }> = {
      CallREST: {
        severity: 'high',
        description: 'Makes external REST API call - verify security and error handling',
      },
      CallWebService: {
        severity: 'high',
        description: 'Calls external web service - verify security',
      },
      Delete: {
        severity: 'high',
        description: 'Deletes entity objects - irreversible operation',
      },
      Create: {
        severity: 'low',
        description: 'Creates new entity objects - monitor data growth',
      },
      Change: {
        severity: 'medium',
        description: 'Modifies entity objects - ensure validation',
      },
      Commit: {
        severity: 'medium',
        description: 'Commits database transaction - ensure data integrity',
      },
      Rollback: {
        severity: 'medium',
        description: 'Rolls back transaction - verify error handling',
      },
    };

    const risk = riskMap[action] || {
      severity: 'medium',
      description: `Uses action: ${action}`,
    };

    return {
      type: 'unsafe_action',
      severity: risk.severity,
      action,
      description: risk.description,
    };
  }

  /**
   * Calculate nesting depth from parentheses
   */
  private calculateNestingDepth(code: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of code) {
      if (char === '(') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === ')') {
        currentDepth--;
      }
    }

    return maxDepth;
  }

  /**
   * Calculate XML nesting depth
   */
  private calculateXmlNestingDepth(xml: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    const tags = xml.match(/<[^\/][^>]*>/g) || [];
    const closeTags = xml.match(/<\/[^>]*>/g) || [];

    for (const tag of tags) {
      if (!tag.includes('/>')) {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      }
    }

    return maxDepth;
  }

  /**
   * Detect string concatenation patterns (potential SQL injection, etc.)
   */
  private detectStringConcatenation(formula: string): boolean {
    // Look for patterns like: "string" & variable
    // or: "string" + variable
    const patterns = [
      /["'][^"']*["']\s*&\s*[a-zA-Z_]/,
      /["'][^"']*["']\s*\+\s*[a-zA-Z_]/,
      /Concatenate\s*\(/i,
    ];

    return patterns.some((pattern) => pattern.test(formula));
  }

  /**
   * Calculate complexity score (0-100)
   */
  private calculateComplexityScore(
    functionCount: number,
    nestingDepth: number,
    tokenCount: number,
  ): number {
    let score = 0;

    // Function call penalty
    score += Math.min(functionCount * 3, 30);

    // Nesting depth penalty
    if (nestingDepth > 4) {
      score += (nestingDepth - 4) * 8;
    }

    // Token count penalty (length/complexity)
    score += Math.min(Math.log(tokenCount + 1) * 5, 20);

    return Math.min(Math.round(score), 100);
  }

  /**
   * Get empty analysis result
   */
  private getEmptyResult(): FormulaAnalysisResult {
    return {
      hasFormulas: false,
      complexityScore: 0,
      unsafeFunctions: [],
      nestingDepth: 0,
      functionCallCount: 0,
      externalConnectors: [],
      risks: [],
    };
  }
}
