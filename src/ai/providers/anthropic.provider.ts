import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AIProviderResponse } from './ai-provider.interface';

/**
 * Anthropic Claude AI Provider
 */
export class AnthropicProvider implements AIProvider {
  private readonly logger = new Logger(AnthropicProvider.name);
  private client: Anthropic | null = null;
  private readonly model = 'claude-sonnet-4-20250514';

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log('Anthropic Claude provider initialized');
    } else {
      this.logger.warn('Anthropic API key not provided');
    }
  }

  getName(): string {
    return 'anthropic';
  }

  getModel(): string {
    return this.model;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async analyze(prompt: string): Promise<AIProviderResponse> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized');
    }

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response format from Claude');
      }

      return {
        content: content.text,
        model: this.model,
        tokensUsed:
          response.usage?.input_tokens + response.usage?.output_tokens,
      };
    } catch (error: any) {
      // Handle specific Anthropic errors
      if (error.status === 400 && error.message?.includes('credit balance')) {
        throw new Error('CREDITS_EXHAUSTED: Anthropic API credits exhausted');
      }
      if (error.status === 401) {
        throw new Error('INVALID_API_KEY: Anthropic API key is invalid');
      }
      if (error.status === 429) {
        throw new Error('RATE_LIMITED: Anthropic rate limit exceeded');
      }
      throw error;
    }
  }
}
