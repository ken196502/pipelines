export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatContext {
  /** Pipeline stage that issued the call, used in errors and logs. */
  stage: string;
  /** Short task name inside the stage, e.g. "score", "article". */
  task: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  /** Required: every call has an explicit budget. */
  maxTokens: number;
  responseFormat?: 'json_object' | 'text';
  context: ChatContext;
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  finishReason: string;
  usage?: ChatUsage;
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
