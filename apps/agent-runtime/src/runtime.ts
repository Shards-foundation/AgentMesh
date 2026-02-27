/**
 * Agent Runtime
 * Manages the lifecycle, execution, and LLM inference for AI agents.
 * Each agent instance processes messages from bots and generates responses.
 *
 * Supports: Anthropic Claude, OpenAI, Google Gemini, Groq, local Ollama
 */

import { EventEmitter } from 'events';
import type {
  AgentConfig,
  AgentInstance,
  AgentStatus,
  AgentModel,
  UnifiedMessage,
  MessageContent,
  SystemEvent,
} from '@agentmesh/types';

export interface AgentResponse {
  content: MessageContent;
  agentId: string;
  tokensUsed: number;
  latencyMs: number;
  model: string;
  finishReason: 'stop' | 'max_tokens' | 'tool_use' | 'error';
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface AgentRuntimeConfig {
  maxConcurrency?: number;       // Max concurrent LLM calls per agent
  defaultTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  enableToolUse?: boolean;
}

export class AgentRuntime extends EventEmitter {
  private agents = new Map<string, AgentInstance>();
  private conversations = new Map<string, ConversationMessage[]>();
  private activeRequests = new Map<string, number>();
  private config: Required<AgentRuntimeConfig>;

  // LLM API keys injected via environment
  private llmKeys: Record<string, string>;

  constructor(config: AgentRuntimeConfig = {}) {
    super();
    this.setMaxListeners(1000);
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 50,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000,
      retryAttempts: config.retryAttempts ?? 2,
      retryDelayMs: config.retryDelayMs ?? 1_000,
      enableToolUse: config.enableToolUse ?? true,
    };

    this.llmKeys = {
      anthropic: process.env.ANTHROPIC_API_KEY ?? '',
      openai: process.env.OPENAI_API_KEY ?? '',
      google: process.env.GOOGLE_AI_API_KEY ?? '',
      groq: process.env.GROQ_API_KEY ?? '',
    };
  }

  // ── Agent Lifecycle ────────────────────────────────────────────────────────

  async spawnAgent(agentConfig: AgentConfig): Promise<AgentInstance> {
    const instance: AgentInstance = {
      id: agentConfig.id,
      config: agentConfig,
      status: 'running',
      assignedBotIds: [],
      activeConversations: 0,
      totalMessagesProcessed: 0,
      totalTokensUsed: 0,
      lastActivity: new Date(),
      healthScore: 100,
      createdAt: new Date(),
    };

    this.agents.set(agentConfig.id, instance);
    this.activeRequests.set(agentConfig.id, 0);

    this.emitEvent('agent.started', agentConfig.id, { config: agentConfig });
    console.log(`[Runtime] Agent spawned: ${agentConfig.name} (${agentConfig.role})`);
    return instance;
  }

  async terminateAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.status = 'terminated';
    this.agents.delete(agentId);
    this.activeRequests.delete(agentId);

    this.emitEvent('agent.stopped', agentId, {});
    console.log(`[Runtime] Agent terminated: ${agentId}`);
  }

  // ── Message Processing ─────────────────────────────────────────────────────

  async processMessage(agentId: string, message: UnifiedMessage): Promise<AgentResponse> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (agent.status !== 'running') throw new Error(`Agent ${agentId} is ${agent.status}`);

    const current = this.activeRequests.get(agentId) ?? 0;
    if (current >= this.config.maxConcurrency) {
      throw new Error(`Agent ${agentId} at max concurrency (${this.config.maxConcurrency})`);
    }

    this.activeRequests.set(agentId, current + 1);
    agent.activeConversations++;
    agent.lastActivity = new Date();

    const start = Date.now();

    try {
      // Build conversation history
      const convKey = `${agentId}:${message.metadata.platformChatId}`;
      const history = this.getOrCreateConversation(convKey, agent.config.systemPrompt);

      // Append incoming user message
      history.push({
        role: 'user',
        content: message.content.text ?? '[non-text message]',
      });

      // Truncate if exceeding memory limit
      this.truncateHistory(history, agent.config.memory.maxTokens ?? 4096);

      // Call LLM
      const llmResponse = await this.callLLM(agent.config.model, history, agent.config.tools);

      // Append assistant response
      history.push({ role: 'assistant', content: llmResponse.text });

      const latency = Date.now() - start;
      const response: AgentResponse = {
        content: { text: llmResponse.text },
        agentId,
        tokensUsed: llmResponse.inputTokens + llmResponse.outputTokens,
        latencyMs: latency,
        model: agent.config.model.modelId,
        finishReason: llmResponse.finishReason,
        toolCalls: llmResponse.toolCalls,
      };

      // Update stats
      agent.totalMessagesProcessed++;
      agent.totalTokensUsed += response.tokensUsed;

      this.emitEvent('agent.response', agentId, {
        messageId: message.id,
        latencyMs: latency,
        tokensUsed: response.tokensUsed,
      });

      return response;
    } finally {
      this.activeRequests.set(agentId, (this.activeRequests.get(agentId) ?? 1) - 1);
      agent.activeConversations--;
    }
  }

  // ── LLM Dispatch ──────────────────────────────────────────────────────────

  private async callLLM(
    model: AgentModel,
    messages: ConversationMessage[],
    tools: AgentConfig['tools'] = []
  ): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    finishReason: AgentResponse['finishReason'];
    toolCalls?: ToolCall[];
  }> {
    const attempts = this.config.retryAttempts;

    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        switch (model.provider) {
          case 'anthropic':
            return await this.callAnthropic(model, messages, tools);
          case 'openai':
            return await this.callOpenAI(model, messages, tools);
          case 'google':
            return await this.callGemini(model, messages);
          case 'groq':
            return await this.callGroq(model, messages);
          default:
            throw new Error(`Unsupported LLM provider: ${model.provider}`);
        }
      } catch (error) {
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, this.config.retryDelayMs * (attempt + 1)));
          // Try fallback model if available
          if (model.fallbackModel && attempt === attempts - 1) {
            model = model.fallbackModel;
          }
          continue;
        }
        throw error;
      }
    }

    throw new Error('LLM call exhausted all retries');
  }

  private async callAnthropic(
    model: AgentModel,
    messages: ConversationMessage[],
    tools: AgentConfig['tools']
  ) {
    const [systemMsg, ...rest] = messages;
    const anthropicMessages = rest
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const body: Record<string, unknown> = {
      model: model.modelId,
      max_tokens: model.maxTokens ?? 4096,
      temperature: model.temperature ?? 0.7,
      system: systemMsg?.role === 'system' ? systemMsg.content : undefined,
      messages: anthropicMessages,
    };

    if (tools.length > 0 && this.config.enableToolUse) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.llmKeys.anthropic,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    const textContent = data.content.find((c) => c.type === 'text');
    const toolUseContent = data.content.filter((c) => c.type === 'tool_use');

    return {
      text: textContent?.text ?? '',
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      finishReason: (data.stop_reason === 'tool_use' ? 'tool_use' : 'stop') as AgentResponse['finishReason'],
      toolCalls: toolUseContent.map((t) => ({
        id: t.id ?? '',
        name: t.name ?? '',
        input: t.input ?? {},
      })),
    };
  }

  private async callOpenAI(model: AgentModel, messages: ConversationMessage[], tools: AgentConfig['tools']) {
    const body: Record<string, unknown> = {
      model: model.modelId,
      max_tokens: model.maxTokens ?? 4096,
      temperature: model.temperature ?? 0.7,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (tools.length > 0 && this.config.enableToolUse) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.llmKeys.openai}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);

    const data = await response.json() as {
      choices: Array<{ message: { content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    return {
      text: choice.message.content ?? '',
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      finishReason: (choice.finish_reason === 'tool_calls' ? 'tool_use' : 'stop') as AgentResponse['finishReason'],
      toolCalls: choice.message.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })),
    };
  }

  private async callGemini(model: AgentModel, messages: ConversationMessage[]) {
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.modelId}:generateContent?key=${this.llmKeys.google}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
      }
    );

    if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);

    const data = await response.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> }; finishReason: string }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
    };

    return {
      text: data.candidates[0]?.content.parts[0]?.text ?? '',
      inputTokens: data.usageMetadata.promptTokenCount,
      outputTokens: data.usageMetadata.candidatesTokenCount,
      finishReason: 'stop' as AgentResponse['finishReason'],
    };
  }

  private async callGroq(model: AgentModel, messages: ConversationMessage[]) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.llmKeys.groq}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: model.maxTokens ?? 4096,
        temperature: model.temperature ?? 0.7,
      }),
    });

    if (!response.ok) throw new Error(`Groq API error: ${response.status}`);

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      text: data.choices[0]?.message.content ?? '',
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      finishReason: 'stop' as AgentResponse['finishReason'],
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getOrCreateConversation(key: string, systemPrompt: string): ConversationMessage[] {
    if (!this.conversations.has(key)) {
      this.conversations.set(key, [{ role: 'system', content: systemPrompt }]);
    }
    return this.conversations.get(key)!;
  }

  private truncateHistory(messages: ConversationMessage[], maxTokens: number): void {
    // Simple truncation: keep system prompt + last N messages
    // Production: use tiktoken for precise token counting
    const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    if (estimatedTokens > maxTokens && messages.length > 3) {
      // Remove oldest non-system messages
      const systemMsg = messages[0];
      const recent = messages.slice(-10);
      messages.splice(0, messages.length, systemMsg, ...recent);
    }
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  private emitEvent(type: string, sourceId: string, payload: unknown): void {
    const event: SystemEvent = {
      id: `evt_${Date.now()}`,
      type: type as SystemEvent['type'],
      source: 'agent',
      sourceId,
      payload,
      timestamp: new Date(),
    };
    this.emit('event', event);
  }
}
