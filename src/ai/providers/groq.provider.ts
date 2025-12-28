import { Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { AIProvider, AIProviderResponse } from './ai-provider.interface';

/**
 * Groq AI Provider - Free tier with fast inference
 * Uses LLaMA 3.3 70B model for high-quality responses
 */
export class GroqProvider implements AIProvider {
  private readonly logger = new Logger(GroqProvider.name);
  private client: Groq | null = null;
  private readonly model = 'llama-3.3-70b-versatile';

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new Groq({ apiKey });
      this.logger.log('Groq provider initialized');
    } else {
      this.logger.warn('Groq API key not provided');
    }
  }

  getName(): string {
    return 'groq';
  }

  getModel(): string {
    return this.model;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async analyze(prompt: string): Promise<AIProviderResponse> {
    if (!this.client) {
      throw new Error('Groq client not initialized');
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'You are BridgeAI, a security expert specializing in low-code/no-code platform security analysis. Always respond with valid JSON when asked for structured output.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;

      if (!content) {
        throw new Error('No content in Groq response');
      }

      return {
        content,
        model: this.model,
        tokensUsed: response.usage?.total_tokens,
      };
    } catch (error: any) {
      // Handle specific Groq errors
      if (
        error.status === 429 ||
        error.message?.includes('rate_limit') ||
        error.message?.includes('quota')
      ) {
        throw new Error('RATE_LIMITED: Groq rate limit exceeded');
      }
      if (error.status === 401 || error.message?.includes('invalid_api_key')) {
        throw new Error('INVALID_API_KEY: Groq API key is invalid');
      }
      if (error.status === 503 || error.message?.includes('overloaded')) {
        throw new Error(
          'SERVICE_UNAVAILABLE: Groq service is temporarily overloaded',
        );
      }
      throw error;
    }
  }
}
