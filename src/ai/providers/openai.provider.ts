import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AIProvider, AIProviderResponse } from './ai-provider.interface';

/**
 * OpenAI GPT-4 AI Provider
 */
export class OpenAIProvider implements AIProvider {
  private readonly logger = new Logger(OpenAIProvider.name);
  private client: OpenAI | null = null;
  private readonly model = 'gpt-4-turbo-preview';

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
      this.logger.log('OpenAI GPT-4 provider initialized');
    } else {
      this.logger.warn('OpenAI API key not provided');
    }
  }

  getName(): string {
    return 'openai';
  }

  getModel(): string {
    return this.model;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async analyze(prompt: string): Promise<AIProviderResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 4096,
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
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in OpenAI response');
      }

      return {
        content,
        model: this.model,
        tokensUsed: response.usage?.total_tokens,
      };
    } catch (error: any) {
      // Handle specific OpenAI errors
      if (
        error.code === 'insufficient_quota' ||
        error.message?.includes('quota')
      ) {
        throw new Error('CREDITS_EXHAUSTED: OpenAI API credits exhausted');
      }
      if (error.status === 401 || error.code === 'invalid_api_key') {
        throw new Error('INVALID_API_KEY: OpenAI API key is invalid');
      }
      if (error.status === 429) {
        throw new Error('RATE_LIMITED: OpenAI rate limit exceeded');
      }
      throw error;
    }
  }
}
