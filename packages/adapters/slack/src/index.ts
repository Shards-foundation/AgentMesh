/**
 * @agentmesh/adapter-slack
 * Slack Bolt SDK adapter
 * Supports Slack Socket Mode (no public URL needed) + Events API
 */

import { BaseAdapter, SendMessageOptions } from '../../telegram/src/base-adapter';
import type {
  BotInstance,
  BotCredentials,
  PlatformCapabilities,
  UnifiedMessage,
  MessageContent,
} from '@agentmesh/types';

export const SLACK_CAPABILITIES: PlatformCapabilities = {
  supportsRichText: true,
  supportsFiles: true,
  supportsVoice: false,
  supportsReactions: true,
  supportsThreads: true,
  supportsGroups: true,
  supportsChannels: true,
  maxMessageLength: 40000,
  rateLimit: {
    messagesPerSecond: 1,
    messagesPerMinute: 50,
    messagesPerHour: 1000,
    burstLimit: 10,
  },
};

export class SlackAdapter extends BaseAdapter {
  readonly platformId = 'slack' as const;
  readonly capabilities = SLACK_CAPABILITIES;

  private botToken: string;
  private signingSecret: string;
  private appToken: string;   // For Socket Mode
  private apiBase = 'https://slack.com/api';

  constructor(botInstance: BotInstance) {
    super(botInstance);
    this.botToken = botInstance.credentials.apiToken!;
    this.signingSecret = botInstance.credentials.webhookSecret!;
    this.appToken = botInstance.credentials.accessToken!;
  }

  async connect(): Promise<void> {
    const valid = await this.validateCredentials(this.botInstance.credentials);
    if (!valid) throw new Error(`[Slack] Invalid credentials for bot ${this.botInstance.id}`);

    // TODO: Implement Socket Mode WebSocket connection
    // @slack/bolt handles this: const app = new App({ token, signingSecret, socketMode: true, appToken })
    this.isConnected = true;
    this.updateStatus('online');
    console.log(`[Slack] Bot ${this.botInstance.username} connected`);
  }

  async disconnect(): Promise<void> {
    // TODO: Close socket mode connection
    this.isConnected = false;
    this.updateStatus('offline');
  }

  async sendMessage(options: SendMessageOptions): Promise<string> {
    await this.enforceRateLimit();

    const payload: Record<string, unknown> = {
      channel: options.recipientId,
    };

    if (options.content.text) payload.text = options.content.text;

    if (options.content.embeds?.length) {
      payload.blocks = options.content.embeds.map((embed) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${embed.title}*\n${embed.description}` },
      }));
    }

    if (options.replyToId) {
      payload.thread_ts = options.replyToId;
    }

    if (options.content.buttons?.length) {
      payload.blocks = [
        ...(payload.blocks as unknown[] ?? []),
        {
          type: 'actions',
          elements: options.content.buttons.map((btn) => ({
            type: 'button',
            text: { type: 'plain_text', text: btn.label },
            action_id: btn.action,
            style: btn.style === 'danger' ? 'danger' : btn.style === 'primary' ? 'primary' : undefined,
          })),
        },
      ];
    }

    const result = await this.apiCall<{ ok: boolean; ts: string; error?: string }>('chat.postMessage', payload);
    return result.ts;
  }

  async editMessage(messageId: string, content: MessageContent): Promise<void> {
    throw new Error('editMessage requires channel - use editMessageInChannel');
  }

  async editMessageInChannel(channelId: string, ts: string, content: MessageContent): Promise<void> {
    await this.enforceRateLimit();
    await this.apiCall('chat.update', {
      channel: channelId,
      ts,
      text: content.text,
    });
  }

  async deleteMessage(ts: string, channelId: string): Promise<void> {
    await this.enforceRateLimit();
    await this.apiCall('chat.delete', { channel: channelId, ts });
  }

  async reactToMessage(ts: string, channelId: string, emoji: string): Promise<void> {
    await this.enforceRateLimit();
    // Remove colons if present (Slack uses names without colons)
    const name = emoji.replace(/:/g, '');
    await this.apiCall('reactions.add', { channel: channelId, timestamp: ts, name });
  }

  async getBotInfo(): Promise<Partial<BotInstance>> {
    const result = await this.apiCall<{ ok: boolean; user_id: string; url: string; team: string; user: string }>(
      'auth.test',
      {}
    );
    return {
      username: result.user,
      name: result.user,
      metadata: {
        userId: result.user_id,
        team: result.team,
        url: result.url,
      },
    };
  }

  async validateCredentials(credentials: BotCredentials): Promise<boolean> {
    if (!credentials.apiToken) return false;
    try {
      const response = await fetch(`${this.apiBase}/auth.test`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await response.json() as { ok: boolean };
      return data.ok;
    } catch {
      return false;
    }
  }

  private async apiCall<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') ?? '1') * 1000;
      this.emit('bot:rate_limited', this.botInstance.id, retryAfter);
      await new Promise((r) => setTimeout(r, retryAfter));
      return this.apiCall<T>(method, body);
    }

    const data = await response.json() as T & { ok: boolean; error?: string };
    if (!(data as any).ok) {
      throw new Error(`Slack API error: ${(data as any).error}`);
    }

    return data;
  }
}
