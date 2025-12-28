/**
 * AI Provider Interface
 * Abstract interface for different AI providers (Anthropic, OpenAI, Google)
 */

export interface AIProviderConfig {
  name: string;
  model: string;
  maxTokens: number;
}

export interface AIProviderResponse {
  content: string;
  model: string;
  tokensUsed?: number;
}

export interface AIProvider {
  /**
   * Get the provider name
   */
  getName(): string;

  /**
   * Get the model being used
   */
  getModel(): string;

  /**
   * Check if the provider is available (has valid API key)
   */
  isAvailable(): boolean;

  /**
   * Send a prompt to the AI and get a response
   */
  analyze(prompt: string): Promise<AIProviderResponse>;
}
