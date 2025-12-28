import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  AIProvider,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
} from './providers';

export interface BridgeAIAnalysis {
  id: string;
  changeId: string;
  analyzedAt: Date;
  securityConcerns: SecurityConcern[];
  overallAssessment: 'safe' | 'warning' | 'critical';
  summary: string;
  recommendations: string[];
  provider?: string;
  model?: string;
  rawResponse?: string;
}

export interface SecurityConcern {
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  description: string;
  affectedFiles?: string[];
  remediation?: string;
}

export type AIProviderName = 'anthropic' | 'openai' | 'gemini';

export interface AIProviderStatus {
  name: AIProviderName;
  available: boolean;
  model: string;
}

@Injectable()
export class BridgeAIService {
  private readonly logger = new Logger(BridgeAIService.name);
  private providers: Map<AIProviderName, AIProvider> = new Map();
  private providerPriority: AIProviderName[] = ['anthropic', 'openai', 'gemini'];

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.initializeProviders();
  }

  /**
   * Initialize all configured AI providers
   */
  private initializeProviders(): void {
    // Anthropic Claude
    const anthropicKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (anthropicKey) {
      this.providers.set('anthropic', new AnthropicProvider(anthropicKey));
      this.logger.log('✅ Anthropic Claude provider configured');
    }

    // OpenAI GPT-4
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (openaiKey) {
      this.providers.set('openai', new OpenAIProvider(openaiKey));
      this.logger.log('✅ OpenAI GPT-4 provider configured');
    }

    // Google Gemini
    const geminiKey = this.configService.get<string>('GOOGLE_GEMINI_API_KEY');
    if (geminiKey) {
      this.providers.set('gemini', new GeminiProvider(geminiKey));
      this.logger.log('✅ Google Gemini provider configured');
    }

    // Set priority from config if specified
    const priorityConfig = this.configService.get<string>('AI_PROVIDER_PRIORITY');
    if (priorityConfig) {
      const priority = priorityConfig.split(',').map(p => p.trim() as AIProviderName);
      this.providerPriority = priority.filter(p => this.providers.has(p));
    }

    if (this.providers.size === 0) {
      this.logger.warn('⚠️ No AI providers configured - BridgeAI features will be disabled');
    } else {
      this.logger.log(`BridgeAI initialized with ${this.providers.size} provider(s): ${Array.from(this.providers.keys()).join(', ')}`);
      this.logger.log(`Provider priority: ${this.providerPriority.join(' → ')}`);
    }
  }

  /**
   * Check if any AI provider is available
   */
  isAvailable(): boolean {
    return this.providers.size > 0 && this.providerPriority.some(p => this.providers.get(p)?.isAvailable());
  }

  /**
   * Get status of all providers
   */
  getProvidersStatus(): AIProviderStatus[] {
    return Array.from(this.providers.entries()).map(([name, provider]) => ({
      name,
      available: provider.isAvailable(),
      model: provider.getModel(),
    }));
  }

  /**
   * Get the currently active provider (highest priority available)
   */
  getActiveProvider(): AIProvider | null {
    for (const name of this.providerPriority) {
      const provider = this.providers.get(name);
      if (provider?.isAvailable()) {
        return provider;
      }
    }
    return null;
  }

  /**
   * Analyze a change using AI with automatic fallback
   */
  async analyzeChange(
    changeId: string,
    organizationId: string,
    preferredProvider?: AIProviderName,
  ): Promise<BridgeAIAnalysis> {
    if (!this.isAvailable()) {
      throw new Error('No AI providers configured. Please set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GEMINI_API_KEY.');
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

    // Create the prompt
    const prompt = this.createSecurityAnalysisPrompt(
      change.app?.name || 'Unknown App',
      change.app?.platform || 'MENDIX',
      change.title || 'Untitled Change',
      change.description || '',
      diffContext,
      riskAssessment,
    );

    // Build provider list (preferred first, then by priority)
    const providersToTry: AIProviderName[] = [];
    if (preferredProvider && this.providers.has(preferredProvider)) {
      providersToTry.push(preferredProvider);
    }
    for (const name of this.providerPriority) {
      if (!providersToTry.includes(name) && this.providers.has(name)) {
        providersToTry.push(name);
      }
    }

    let lastError: Error | null = null;

    // Try each provider until one succeeds
    for (const providerName of providersToTry) {
      const provider = this.providers.get(providerName);
      if (!provider?.isAvailable()) continue;

      try {
        this.logger.log(`Trying ${providerName} provider...`);
        
        const response = await provider.analyze(prompt);
        
        // Parse the response
        const analysis = this.parseAIResponse(response.content, changeId, providerName, provider.getModel());

        // Store the analysis in the database
        await this.storeAnalysis(changeId, analysis, response.content);

        this.logger.log(`BridgeAI analysis completed using ${providerName} for change ${changeId}: ${analysis.overallAssessment}`);

        return analysis;
      } catch (error: any) {
        this.logger.warn(`${providerName} provider failed: ${error.message}`);
        lastError = error;

        // Check if we should try next provider
        if (error.message?.includes('CREDITS_EXHAUSTED') || 
            error.message?.includes('RATE_LIMITED') ||
            error.message?.includes('INVALID_API_KEY')) {
          this.logger.log(`Falling back to next provider...`);
          continue;
        }

        // For other errors, still try next provider
        continue;
      }
    }

    // All providers failed
    this.logger.error('All AI providers failed');
    throw new Error(lastError?.message || 'All AI providers failed. Please check your API keys and quotas.');
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

      // Include raw diff if available
      if (diffSummary.rawDiff) {
        parts.push(`## Raw Diff`);
        parts.push('```diff');
        // Truncate if too long
        const rawDiff = diffSummary.rawDiff.length > 8000 
          ? diffSummary.rawDiff.substring(0, 8000) + '\n...(truncated)'
          : diffSummary.rawDiff;
        parts.push(rawDiff);
        parts.push('```');
        parts.push('');
      }

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
   * Create the security analysis prompt
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
Respond ONLY with the following JSON (no other text):
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
   * Parse AI response into structured format
   */
  private parseAIResponse(
    response: string, 
    changeId: string, 
    provider: string,
    model: string,
  ): BridgeAIAnalysis {
    try {
      // Extract JSON from response (it might be wrapped in markdown code blocks)
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
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
        provider,
        model,
        rawResponse: response,
      };
    } catch (error: any) {
      this.logger.error(`Failed to parse AI response: ${error.message}`);
      
      // Return a fallback analysis
      return {
        id: `ai-${changeId}-${Date.now()}`,
        changeId,
        analyzedAt: new Date(),
        securityConcerns: [],
        overallAssessment: 'warning',
        summary: 'AI analysis completed but response parsing failed. Manual review recommended.',
        recommendations: ['Review the change manually due to AI parsing issues'],
        provider,
        model,
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
