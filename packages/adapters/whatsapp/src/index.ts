/**
 * @agentmesh/adapter-whatsapp
 * WhatsApp Business Cloud API adapter
 * Uses Meta's official WhatsApp Cloud API (not unofficial clients)
 */

import { BaseAdapter, SendMessageOptions } from '../../telegram/src/base-adapter';
import type {
  BotInstance,
  BotCredentials,
  PlatformCapabilities,
  UnifiedMessage,
  MessageContent,
  MessageSender,
} from '@agentmesh/types';

interface WhatsAppWebhookPayload {
  entry: WhatsAppEntry[];
}

interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

interface WhatsAppChange {
  value: WhatsAppValue;
  field: string;
}

interface WhatsAppValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
  contacts?: WhatsAppContact[];
}

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'interactive' | 'sticker';
  text?: { body: string };
  image?: { id: string; caption?: string; mime_type: string };
  audio?: { id: string; mime_type: string };
  video?: { id: string; caption?: string; mime_type: string };
  document?: { id: string; caption?: string; filename?: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: WhatsAppInteractive;
  context?: { id: string; from: string };
}

interface WhatsAppInteractive {
  type: 'button_reply' | 'list_reply';
  button_reply?: { id: string; title: string };
  list_reply?: { id: string; title: string; description?: string };
}

interface WhatsAppContact {
  profile: { name: string };
  wa_id: string;
}

interface WhatsAppStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
}

export const WHATSAPP_CAPABILITIES: PlatformCapabilities = {
  supportsRichText: false,
  supportsFiles: true,
  supportsVoice: true,
  supportsReactions: false,
  supportsThreads: false,
  supportsGroups: false,
  supportsChannels: false,
  maxMessageLength: 4096,
  rateLimit: {
    messagesPerSecond: 80,     // Tier 1: 1K conversations/day by default
    messagesPerMinute: 1000,
    messagesPerHour: 3600,
    burstLimit: 100,
  },
};

export class WhatsAppAdapter extends BaseAdapter {
  readonly platformId = 'whatsapp' as const;
  readonly capabilities = WHATSAPP_CAPABILITIES;

  private accessToken: string;
  private phoneNumberId: string;
  private apiVersion = 'v21.0';
  private apiBase: string;

  constructor(botInstance: BotInstance) {
    super(botInstance);
    this.accessToken = botInstance.credentials.accessToken!;
    this.phoneNumberId = botInstance.credentials.appId!;
    this.apiBase = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}`;
  }

  async connect(): Promise<void> {
    const valid = await this.validateCredentials(this.botInstance.credentials);
    if (!valid) throw new Error(`[WhatsApp] Invalid credentials for bot ${this.botInstance.id}`);

    // WhatsApp uses webhooks only — no persistent connection
    // Webhook registration is done via Meta developer dashboard
    this.isConnected = true;
    this.updateStatus('online');
    console.log(`[WhatsApp] Bot ${this.botInstance.username} ready (webhook mode)`);
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.updateStatus('offline');
  }

  async sendMessage(options: SendMessageOptions): Promise<string> {
    await this.enforceRateLimit();

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: options.recipientId,
    };

    if (options.content.text) {
      payload.type = 'text';
      payload.text = {
        body: options.content.text,
        preview_url: false,
      };
    }

    if (options.replyToId) {
      payload.context = { message_id: options.replyToId };
    }

    if (options.content.buttons?.length) {
      payload.type = 'interactive';
      payload.interactive = {
        type: 'button',
        body: { text: options.content.text ?? 'Choose an option:' },
        action: {
          buttons: options.content.buttons.slice(0, 3).map((btn) => ({
            type: 'reply',
            reply: { id: btn.action, title: btn.label.slice(0, 20) },
          })),
        },
      };
      delete payload.text;
    }

    if (options.content.mediaUrl) {
      const type = options.content.mediaType?.split('/')[0] ?? 'document';
      payload.type = type;
      payload[type] = {
        link: options.content.mediaUrl,
        caption: options.content.text,
      };
      delete payload.text;
    }

    const result = await this.apiCall<{ messages: Array<{ id: string }> }>('messages', 'POST', payload);
    return result.messages[0].id;
  }

  async editMessage(_platformMessageId: string, _content: MessageContent): Promise<void> {
    // WhatsApp doesn't support message editing
    throw new Error('[WhatsApp] Message editing is not supported');
  }

  async deleteMessage(_platformMessageId: string, _chatId: string): Promise<void> {
    // WhatsApp doesn't support message deletion via API
    throw new Error('[WhatsApp] Message deletion is not supported via Cloud API');
  }

  async reactToMessage(platformMessageId: string, chatId: string, emoji: string): Promise<void> {
    await this.enforceRateLimit();
    await this.apiCall('messages', 'POST', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: 'reaction',
      reaction: { message_id: platformMessageId, emoji },
    });
  }

  async sendTemplate(to: string, templateName: string, languageCode: string, components?: unknown[]): Promise<string> {
    await this.enforceRateLimit();
    const result = await this.apiCall<{ messages: Array<{ id: string }> }>('messages', 'POST', {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: components ?? [],
      },
    });
    return result.messages[0].id;
  }

  async getBotInfo(): Promise<Partial<BotInstance>> {
    const result = await this.apiCall<{
      id: string;
      display_phone_number: string;
      verified_name: string;
    }>('', 'GET');

    return {
      username: result.display_phone_number,
      name: result.verified_name,
      metadata: { whatsappId: result.id },
    };
  }

  async validateCredentials(credentials: BotCredentials): Promise<boolean> {
    if (!credentials.accessToken || !credentials.appId) return false;
    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.apiVersion}/${credentials.appId}`,
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Process incoming webhook from Meta's servers.
   * Call this from your webhook handler after verifying the signature.
   */
  processWebhook(payload: WhatsAppWebhookPayload): void {
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const { messages, contacts } = change.value;
        if (!messages) continue;

        const contactMap = new Map(contacts?.map((c) => [c.wa_id, c.profile.name]) ?? []);

        for (const message of messages) {
          const unified = this.normalizeMessage(message, change.value.metadata.phone_number_id, contactMap);
          this.emitMessage(unified);
        }
      }
    }
  }

  /**
   * Verify webhook signature from Meta
   */
  verifyWebhookSignature(signature: string, body: string, appSecret: string): boolean {
    const crypto = require('crypto') as typeof import('crypto');
    const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(body).digest('hex')}`;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  private normalizeMessage(
    msg: WhatsAppMessage,
    phoneNumberId: string,
    contactMap: Map<string, string>
  ): UnifiedMessage {
    const sender: MessageSender = {
      id: msg.from,
      username: msg.from,
      displayName: contactMap.get(msg.from),
      isBot: false,
    };

    const content: MessageContent = {
      text: msg.text?.body ?? msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption,
    };

    if (msg.image) content.mediaType = msg.image.mime_type;
    if (msg.audio) content.mediaType = msg.audio.mime_type;
    if (msg.video) content.mediaType = msg.video.mime_type;

    return {
      id: this.generateMessageId(),
      platformId: 'whatsapp',
      botInstanceId: this.botInstance.id,
      direction: 'inbound',
      type: msg.type === 'text' ? 'text' : msg.type === 'image' ? 'image' : msg.type === 'audio' ? 'audio' : msg.type === 'video' ? 'video' : 'file',
      content,
      sender,
      recipient: { id: phoneNumberId, type: 'user' },
      channel: { id: msg.from, type: 'dm' },
      metadata: {
        platformMessageId: msg.id,
        platformChatId: msg.from,
        platformUserId: msg.from,
        replyToMessageId: msg.context?.id,
      },
      timestamp: new Date(parseInt(msg.timestamp) * 1000),
    };
  }

  private async apiCall<T>(path: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const url = path ? `${this.apiBase}/${path}` : this.apiBase;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') ?? '1') * 1000;
      this.emit('bot:rate_limited', this.botInstance.id, retryAfter);
      await new Promise((r) => setTimeout(r, retryAfter));
      return this.apiCall<T>(path, method, body);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WhatsApp API error ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }
}
