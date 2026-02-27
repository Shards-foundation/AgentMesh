/**
 * @agentmesh/adapter-base
 * Abstract base class for all platform adapters.
 * Every platform (Telegram, Discord, Slack, etc.) implements this contract.
 */

import { EventEmitter } from 'events';
import type {
  BotInstance,
  BotCredentials,
  BotStatus,
  PlatformCapabilities,
  UnifiedMessage,
  MessageContent,
  MessageRecipient,
  PlatformId,
  SystemEvent,
  RateLimitState,
} from '@agentmesh/types';

export interface SendMessageOptions {
  recipientId: string;
  content: MessageContent;
  replyToId?: string;
  threadId?: string;
  silent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AdapterEvents {
  'message:received': (message: UnifiedMessage) => void;
  'message:delivered': (messageId: string, platformMessageId: string) => void;
  'message:failed': (messageId: string, error: Error) => void;
  'bot:status_changed': (botId: string, status: BotStatus) => void;
  'bot:rate_limited': (botId: string, retryAfter: number) => void;
  'bot:error': (botId: string, error: Error) => void;
  'event:raw': (event: SystemEvent) => void;
}

export abstract class BaseAdapter extends EventEmitter {
  abstract readonly platformId: PlatformId;
  abstract readonly capabilities: PlatformCapabilities;

  protected botInstance: BotInstance;
  protected isConnected = false;
  protected rateLimitState: RateLimitState;

  constructor(botInstance: BotInstance) {
    super();
    this.setMaxListeners(100);
    this.botInstance = botInstance;
    this.rateLimitState = {
      currentSecond: 0,
      currentMinute: 0,
      currentHour: 0,
      windowStart: new Date(),
      isThrottled: false,
    };
  }

  // ── Abstract methods every adapter must implement ──────────────────────────

  /**
   * Establish connection to the platform.
   * Should start listening for incoming messages and set up webhooks/polling.
   */
  abstract connect(): Promise<void>;

  /**
   * Gracefully disconnect from the platform.
   * Should clean up webhooks, close connections, flush queues.
   */
  abstract disconnect(): Promise<void>;

  /**
   * Send a message to a recipient on the platform.
   * Returns the platform-native message ID.
   */
  abstract sendMessage(options: SendMessageOptions): Promise<string>;

  /**
   * Edit an already-sent message.
   */
  abstract editMessage(platformMessageId: string, content: MessageContent): Promise<void>;

  /**
   * Delete a message.
   */
  abstract deleteMessage(platformMessageId: string, chatId: string): Promise<void>;

  /**
   * React to a message with an emoji.
   */
  abstract reactToMessage(platformMessageId: string, chatId: string, emoji: string): Promise<void>;

  /**
   * Get information about the bot itself from the platform.
   */
  abstract getBotInfo(): Promise<Partial<BotInstance>>;

  /**
   * Validate that the credentials work before fully connecting.
   */
  abstract validateCredentials(credentials: BotCredentials): Promise<boolean>;

  // ── Rate limit enforcement ─────────────────────────────────────────────────

  protected async enforceRateLimit(): Promise<void> {
    const { rateLimit } = this.capabilities;
    const now = new Date();
    const windowAge = (now.getTime() - this.rateLimitState.windowStart.getTime()) / 1000;

    // Reset counters if windows have elapsed
    if (windowAge >= 3600) {
      this.rateLimitState.currentHour = 0;
      this.rateLimitState.currentMinute = 0;
      this.rateLimitState.currentSecond = 0;
      this.rateLimitState.windowStart = now;
    } else if (windowAge >= 60) {
      this.rateLimitState.currentMinute = 0;
      this.rateLimitState.currentSecond = 0;
    } else if (windowAge >= 1) {
      this.rateLimitState.currentSecond = 0;
    }

    // Check limits
    if (
      this.rateLimitState.currentSecond >= rateLimit.messagesPerSecond ||
      this.rateLimitState.currentMinute >= rateLimit.messagesPerMinute ||
      this.rateLimitState.currentHour >= rateLimit.messagesPerHour
    ) {
      const retryAfter = this.rateLimitState.currentSecond >= rateLimit.messagesPerSecond ? 1000 : 60000;
      this.rateLimitState.isThrottled = true;
      this.rateLimitState.throttleUntil = new Date(now.getTime() + retryAfter);
      this.emit('bot:rate_limited', this.botInstance.id, retryAfter);
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
      this.rateLimitState.isThrottled = false;
    }

    this.rateLimitState.currentSecond++;
    this.rateLimitState.currentMinute++;
    this.rateLimitState.currentHour++;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  getStatus(): BotStatus {
    return this.botInstance.status;
  }

  isHealthy(): boolean {
    return this.isConnected && this.botInstance.status === 'online';
  }

  getBotId(): string {
    return this.botInstance.id;
  }

  protected emitMessage(message: UnifiedMessage): void {
    this.emit('message:received', message);
  }

  protected updateStatus(status: BotStatus): void {
    this.botInstance.status = status;
    this.emit('bot:status_changed', this.botInstance.id, status);
  }

  protected generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
