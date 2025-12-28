import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import Anthropic from '@anthropic-ai/sdk';

export interface BridgeAIAnalysis {
  id: string;
  changeId: string;
  analyzedAt: Date;
  securityConcerns: SecurityConcern[];
  overallAssessment: 'safe' | 'warning' | 'critical';
  summary: string;
  recommendations: string[];
  rawResponse?: string;
}

export interface SecurityConcern {
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  description: string;
  affectedFiles?: string[];
  remediation?: string;
}

@Injectable()
export class BridgeAIService {
  private readonly logger = new Logger(BridgeAIService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
      this.logger.log('BridgeAI initialized with Anthropic Claude');
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not configured - BridgeAI features will be disabled');
    }
  }

  /**
   * Check if BridgeAI is available
   */
  isAvailable(): boolean {
    return this.anthropic !== null;
  }

  /**
   * Analyze a change using Claude AI
   */
  async analyzeChange(
    changeId: string,
    organizationId: string,
  ): Promise<BridgeAIAnalysis> {
    if (!this.anthropic) {
      throw new Error('BridgeAI is not configured. Please set ANTHROPIC_API_KEY.');
    }

    this.logger.log(`Starting BridgeAI analysis for change ${changeId}`);

    // Fetch the change with all relevant data
    const change = await this.prisma.change.findFirst({
      where: { id: changeId, organizationId },
      include: {
        app: true,
        sandbox: true,
      },
    });

    if (!change) {
      throw new Error(`Change ${changeId} not found`);
    }

    // Build context for the AI
    const diffSummary = change.diffSummary as any;
    const beforeCode = change.beforeCode as any;
    const afterCode = change.afterCode as any;
    const riskAssessment = change.riskAssessment as any;

    // Prepare the code diff context
    const diffContext = this.prepareDiffContext(diffSummary, beforeCode, afterCode);

    // Create the prompt for Claude
    const prompt = this.createSecurityAnalysisPrompt(
      change.app?.name || 'Unknown App',
      change.app?.platform || 'MENDIX',
      change.title || 'Untitled Change',
      change.description || '',
      diffContext,
      riskAssessment,
    );

    try {
      // Call Claude API
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Parse the response
      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response format from Claude');
      }

      const analysis = this.parseClaudeResponse(content.text, changeId);

      // Store the analysis in the database
      await this.storeAnalysis(changeId, analysis, content.text);

      this.logger.log(`BridgeAI analysis completed for change ${changeId}: ${analysis.overallAssessment}`);

      return analysis;
    } catch (error) {
      this.logger.error(`BridgeAI analysis failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Get stored analysis for a change
   */
  async getStoredAnalysis(changeId: string): Promise<BridgeAIAnalysis | null> {
    const change = await this.prisma.change.findUnique({
      where: { id: changeId },
      select: { aiAnalysis: true },
    });

    if (!change?.aiAnalysis) {
      return null;
    }

    return change.aiAnalysis as unknown as BridgeAIAnalysis;
  }

  /**
   * Prepare diff context for the AI
   */
  private prepareDiffContext(
    diffSummary: any,
    beforeCode: any,
    afterCode: any,
  ): string {
    const parts: string[] = [];

    // Summary statistics
    if (diffSummary) {
      parts.push(`## Change Statistics`);
      parts.push(`- Total files changed: ${diffSummary.totalChanges || 0}`);
      parts.push(`- Additions: ${diffSummary.added || 0}`);
      parts.push(`- Modifications: ${diffSummary.modified || 0}`);
      parts.push(`- Deletions: ${diffSummary.deleted || 0}`);
      parts.push('');

      // Include categorized changes
      if (diffSummary.categories) {
        parts.push(`## Changed Components by Category`);
        for (const [category, files] of Object.entries(diffSummary.categories)) {
          if (Array.isArray(files) && files.length > 0) {
            parts.push(`### ${category}`);
            files.slice(0, 10).forEach((file: any) => {
              parts.push(`- ${file.path || file.name || file}`);
            });
            if (files.length > 10) {
              parts.push(`  ... and ${files.length - 10} more`);
            }
          }
        }
        parts.push('');
      }
    }

    // Include actual code diffs (limited to avoid token overflow)
    if (diffSummary?.operations) {
      parts.push(`## Code Changes (Sample)`);
      const operations = diffSummary.operations.slice(0, 20);
      for (const op of operations) {
        parts.push(`### ${op.op?.toUpperCase() || 'CHANGE'}: ${op.path || 'unknown'}`);
        if (op.value) {
          const valueStr = typeof op.value === 'string' 
            ? op.value 
            : JSON.stringify(op.value, null, 2);
          // Truncate long values
          const truncated = valueStr.length > 500 
            ? valueStr.substring(0, 500) + '...(truncated)' 
            : valueStr;
          parts.push('```json');
          parts.push(truncated);
          parts.push('```');
        }
        parts.push('');
      }
    }

    // Include model-json content for Mendix
    if (afterCode) {
      parts.push(`## Model JSON Content (After)`);
      
      // Pages
      if (afterCode.pages) {
        parts.push(`### Pages (${Object.keys(afterCode.pages).length} total)`);
        const pageEntries = Object.entries(afterCode.pages).slice(0, 5);
        for (const [name, content] of pageEntries) {
          parts.push(`#### ${name}`);
          const contentStr = JSON.stringify(content, null, 2);
          const truncated = contentStr.length > 1000 
            ? contentStr.substring(0, 1000) + '...(truncated)' 
            : contentStr;
          parts.push('```json');
          parts.push(truncated);
          parts.push('```');
        }
      }

      // Microflows
      if (afterCode.microflows) {
        parts.push(`### Microflows (${Object.keys(afterCode.microflows).length} total)`);
        const mfEntries = Object.entries(afterCode.microflows).slice(0, 5);
        for (const [name, content] of mfEntries) {
          parts.push(`#### ${name}`);
          const contentStr = JSON.stringify(content, null, 2);
          const truncated = contentStr.length > 1000 
            ? contentStr.substring(0, 1000) + '...(truncated)' 
            : contentStr;
          parts.push('```json');
          parts.push(truncated);
          parts.push('```');
        }
      }

      // Domain Models
      if (afterCode.domainModels) {
        parts.push(`### Domain Models`);
        const dmEntries = Object.entries(afterCode.domainModels).slice(0, 3);
        for (const [name, content] of dmEntries) {
          parts.push(`#### ${name}`);
          const contentStr = JSON.stringify(content, null, 2);
          const truncated = contentStr.length > 1000 
            ? contentStr.substring(0, 1000) + '...(truncated)' 
            : contentStr;
          parts.push('```json');
          parts.push(truncated);
          parts.push('```');
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Create the security analysis prompt for Claude
   */
  private createSecurityAnalysisPrompt(
    appName: string,
    platform: string,
    changeTitle: string,
    changeDescription: string,
    diffContext: string,
    existingRiskAssessment: any,
  ): string {
    return `You are BridgeAI, a security expert specializing in low-code/no-code platform security. You are analyzing a change made by a citizen developer in a ${platform} application.

## Application Context
- **App Name:** ${appName}
- **Platform:** ${platform}
- **Change Title:** ${changeTitle}
- **Change Description:** ${changeDescription}

## Existing Risk Assessment
${existingRiskAssessment ? JSON.stringify(existingRiskAssessment, null, 2) : 'No existing assessment'}

## Code Changes
${diffContext}

## Your Task
Analyze the code changes for security concerns. Focus on:

1. **Data Exposure Risks**
   - Are any sensitive fields (PII, credentials, tokens) exposed in UI?
   - Are there any data leaks through logging or error messages?

2. **Access Control Issues**
   - Are there any broken access controls?
   - Can unauthorized users access sensitive data or actions?

3. **External Integration Risks**
   - Are there new external API calls or REST services?
   - Are credentials properly secured?

4. **Logic Vulnerabilities**
   - Are there any business logic flaws?
   - Can the flow be bypassed or manipulated?

5. **Data Integrity Concerns**
   - Are there unsafe delete/modify operations?
   - Is data validation sufficient?

## Response Format
Respond in the following JSON format:
\`\`\`json
{
  "overallAssessment": "safe" | "warning" | "critical",
  "summary": "One paragraph summary of the security posture of this change",
  "securityConcerns": [
    {
      "severity": "low" | "medium" | "high" | "critical",
      "category": "Data Exposure | Access Control | External Integration | Logic Vulnerability | Data Integrity | Other",
      "description": "Detailed description of the concern",
      "affectedFiles": ["list of affected files/components"],
      "remediation": "Suggested fix or mitigation"
    }
  ],
  "recommendations": [
    "Actionable recommendation 1",
    "Actionable recommendation 2"
  ]
}
\`\`\`

If no security concerns are found, return an empty array for securityConcerns and set overallAssessment to "safe".`;
  }

  /**
   * Parse Claude's response into structured format
   */
  private parseClaudeResponse(response: string, changeId: string): BridgeAIAnalysis {
    try {
      // Extract JSON from response (it might be wrapped in markdown code blocks)
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        throw new Error('No JSON found in Claude response');
      }

      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr);

      return {
        id: `ai-${changeId}-${Date.now()}`,
        changeId,
        analyzedAt: new Date(),
        securityConcerns: parsed.securityConcerns || [],
        overallAssessment: parsed.overallAssessment || 'safe',
        summary: parsed.summary || 'No summary available',
        recommendations: parsed.recommendations || [],
        rawResponse: response,
      };
    } catch (error) {
      this.logger.error(`Failed to parse Claude response: ${error.message}`);
      
      // Return a fallback analysis
      return {
        id: `ai-${changeId}-${Date.now()}`,
        changeId,
        analyzedAt: new Date(),
        securityConcerns: [],
        overallAssessment: 'warning',
        summary: 'AI analysis completed but response parsing failed. Manual review recommended.',
        recommendations: ['Review the change manually due to AI parsing issues'],
        rawResponse: response,
      };
    }
  }

  /**
   * Store analysis in the database
   */
  private async storeAnalysis(
    changeId: string,
    analysis: BridgeAIAnalysis,
    rawResponse: string,
  ): Promise<void> {
    await this.prisma.change.update({
      where: { id: changeId },
      data: {
        aiAnalysis: analysis as any,
      },
    });

    this.logger.log(`Stored BridgeAI analysis for change ${changeId}`);
  }
}
