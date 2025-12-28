import { Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider, AIProviderResponse } from './ai-provider.interface';

/**
 * Google Gemini AI Provider
 */
export class GeminiProvider implements AIProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  private client: GoogleGenerativeAI | null = null;
  private readonly model = 'gemini-1.5-pro';

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
      this.logger.log('Google Gemini provider initialized');
    } else {
      this.logger.warn('Google Gemini API key not provided');
    }
  }

  getName(): string {
    return 'gemini';
  }

  getModel(): string {
    return this.model;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async analyze(prompt: string): Promise<AIProviderResponse> {
    if (!this.client) {
      throw new Error('Gemini client not initialized');
    }

    try {
      const model = this.client.getGenerativeModel({ model: this.model });

      const result = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `You are BridgeAI, a security expert specializing in low-code/no-code platform security analysis. Always respond with valid JSON when asked for structured output.\n\n${prompt}`,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.3,
        },
      });

      const response = result.response;
      const content = response.text();

      if (!content) {
        throw new Error('No content in Gemini response');
      }

      return {
        content,
        model: this.model,
        tokensUsed: response.usageMetadata?.totalTokenCount,
      };
    } catch (error: any) {
      // Handle specific Gemini errors
      if (
        error.message?.includes('quota') ||
        error.message?.includes('RESOURCE_EXHAUSTED')
      ) {
        throw new Error('CREDITS_EXHAUSTED: Google Gemini API quota exhausted');
      }
      if (error.message?.includes('API_KEY_INVALID') || error.status === 401) {
        throw new Error('INVALID_API_KEY: Google Gemini API key is invalid');
      }
      if (error.status === 429 || error.message?.includes('RATE_LIMIT')) {
        throw new Error('RATE_LIMITED: Google Gemini rate limit exceeded');
      }
      throw error;
    }
  }
}
