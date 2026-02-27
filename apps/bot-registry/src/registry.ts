/**
 * Bot Registry Service
 * The central registry for all bot instances across all platforms.
 * Handles registration, health monitoring, lifecycle, and assignment.
 *
 * Designed to manage 10,000+ concurrent bot instances.
 */

import { EventEmitter } from 'events';
import type {
  BotInstance,
  BotStatus,
  PlatformId,
  SystemEvent,
  BotCredentials,
} from '@agentmesh/types';

export interface BotFilter {
  platformId?: PlatformId;
  status?: BotStatus | BotStatus[];
  assignedAgentId?: string;
  swarmId?: string;
  workspaceId?: string;
  minHealthScore?: number;
  unassigned?: boolean;
}

export interface BotRegistryConfig {
  healthCheckIntervalMs?: number;    // Default: 30s
  staleThresholdMs?: number;         // Mark offline if no heartbeat for this long. Default: 60s
  maxBotsPerPlatform?: number;       // Default: unlimited
  encryptionKey?: string;            // For credential encryption
}

export interface BotRegistration {
  platformId: PlatformId;
  name: string;
  username: string;
  credentials: BotCredentials;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * In-memory bot registry with Redis persistence layer.
 * For production: back this with Redis + Postgres.
 */
export class BotRegistry extends EventEmitter {
  private bots = new Map<string, BotInstance>();
  private platformIndex = new Map<PlatformId, Set<string>>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private config: Required<BotRegistryConfig>;

  constructor(config: BotRegistryConfig = {}) {
    super();
    this.setMaxListeners(1000);
    this.config = {
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30_000,
      staleThresholdMs: config.staleThresholdMs ?? 60_000,
      maxBotsPerPlatform: config.maxBotsPerPlatform ?? Infinity,
      encryptionKey: config.encryptionKey ?? '',
    };

    this.startHealthMonitor();
  }

  // ── Registration ───────────────────────────────────────────────────────────

  async register(registration: BotRegistration): Promise<BotInstance> {
    const id = this.generateId('bot');

    const instance: BotInstance = {
      id,
      platformId: registration.platformId,
      name: registration.name,
      username: registration.username,
      status: 'initializing',
      credentials: this.encryptCredentials(registration.credentials),
      capabilities: this.getDefaultCapabilities(registration.platformId),
      metadata: registration.metadata ?? {},
      workspaceId: registration.workspaceId,
      rateLimitState: {
        currentSecond: 0,
        currentMinute: 0,
        currentHour: 0,
        windowStart: new Date(),
        isThrottled: false,
      },
      healthScore: 100,
      messagesProcessed: 0,
      lastHeartbeat: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.bots.set(id, instance);

    if (!this.platformIndex.has(registration.platformId)) {
      this.platformIndex.set(registration.platformId, new Set());
    }
    this.platformIndex.get(registration.platformId)!.add(id);

    this.emitEvent('bot.connected', 'registry', id, { botInstance: instance });

    console.log(`[Registry] Registered bot: ${registration.username} (${registration.platformId}) → ${id}`);
    return instance;
  }

  async deregister(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);

    this.bots.delete(botId);
    this.platformIndex.get(bot.platformId)?.delete(botId);

    this.emitEvent('bot.disconnected', 'registry', botId, { reason: 'deregistered' });
    console.log(`[Registry] Deregistered bot: ${botId}`);
  }

  // ── Querying ───────────────────────────────────────────────────────────────

  get(botId: string): BotInstance | undefined {
    return this.bots.get(botId);
  }

  getOrThrow(botId: string): BotInstance {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot ${botId} not found in registry`);
    return bot;
  }

  findMany(filter: BotFilter = {}): BotInstance[] {
    let candidates: BotInstance[];

    if (filter.platformId) {
      const ids = this.platformIndex.get(filter.platformId) ?? new Set();
      candidates = Array.from(ids).map((id) => this.bots.get(id)!).filter(Boolean);
    } else {
      candidates = Array.from(this.bots.values());
    }

    return candidates.filter((bot) => {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(bot.status)) return false;
      }
      if (filter.assignedAgentId !== undefined) {
        if (bot.assignedAgentId !== filter.assignedAgentId) return false;
      }
      if (filter.swarmId !== undefined) {
        if (bot.swarmId !== filter.swarmId) return false;
      }
      if (filter.workspaceId !== undefined) {
        if (bot.workspaceId !== filter.workspaceId) return false;
      }
      if (filter.minHealthScore !== undefined) {
        if (bot.healthScore < filter.minHealthScore) return false;
      }
      if (filter.unassigned === true) {
        if (bot.assignedAgentId) return false;
      }
      return true;
    });
  }

  findAvailable(platformId: PlatformId, count = 1): BotInstance[] {
    return this.findMany({
      platformId,
      status: 'online',
      minHealthScore: 50,
      unassigned: true,
    }).slice(0, count);
  }

  getStats() {
    const stats: Record<string, unknown> = {
      total: this.bots.size,
      byStatus: {} as Record<string, number>,
      byPlatform: {} as Record<string, number>,
      averageHealthScore: 0,
    };

    let totalHealth = 0;
    for (const bot of this.bots.values()) {
      const s = stats.byStatus as Record<string, number>;
      s[bot.status] = (s[bot.status] ?? 0) + 1;

      const p = stats.byPlatform as Record<string, number>;
      p[bot.platformId] = (p[bot.platformId] ?? 0) + 1;

      totalHealth += bot.healthScore;
    }

    stats.averageHealthScore = this.bots.size > 0 ? totalHealth / this.bots.size : 0;
    return stats;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  updateStatus(botId: string, status: BotStatus): void {
    const bot = this.bots.get(botId);
    if (!bot) return;

    const prev = bot.status;
    bot.status = status;
    bot.updatedAt = new Date();

    if (status !== prev) {
      this.emitEvent(
        status === 'offline' ? 'bot.disconnected' : 'bot.connected',
        'registry',
        botId,
        { previousStatus: prev, newStatus: status }
      );
    }
  }

  recordHeartbeat(botId: string, healthScore?: number): void {
    const bot = this.bots.get(botId);
    if (!bot) return;
    bot.lastHeartbeat = new Date();
    if (healthScore !== undefined) bot.healthScore = healthScore;
    bot.updatedAt = new Date();
  }

  incrementMessageCount(botId: string): void {
    const bot = this.bots.get(botId);
    if (bot) {
      bot.messagesProcessed++;
      bot.updatedAt = new Date();
    }
  }

  assignToAgent(botId: string, agentId: string): void {
    const bot = this.getOrThrow(botId);
    bot.assignedAgentId = agentId;
    bot.updatedAt = new Date();
  }

  assignToSwarm(botId: string, swarmId: string): void {
    const bot = this.getOrThrow(botId);
    bot.swarmId = swarmId;
    bot.updatedAt = new Date();
  }

  releaseBot(botId: string): void {
    const bot = this.bots.get(botId);
    if (!bot) return;
    delete bot.assignedAgentId;
    delete bot.swarmId;
    bot.updatedAt = new Date();
  }

  getDecryptedCredentials(botId: string): BotCredentials {
    const bot = this.getOrThrow(botId);
    return this.decryptCredentials(bot.credentials);
  }

  // ── Health Monitor ─────────────────────────────────────────────────────────

  private startHealthMonitor(): void {
    this.healthCheckTimer = setInterval(() => {
      this.runHealthChecks();
    }, this.config.healthCheckIntervalMs);
  }

  private runHealthChecks(): void {
    const now = Date.now();
    const threshold = this.config.staleThresholdMs;

    for (const bot of this.bots.values()) {
      if (bot.status === 'offline' || bot.status === 'banned') continue;

      const age = now - bot.lastHeartbeat.getTime();
      if (age > threshold && bot.status === 'online') {
        console.warn(`[Registry] Bot ${bot.id} stale (${Math.round(age / 1000)}s no heartbeat) — marking offline`);
        this.updateStatus(bot.id, 'offline');
        bot.healthScore = Math.max(0, bot.healthScore - 20);
      }
    }

    this.emitEvent('system.health_check', 'registry', 'registry', this.getStats());
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private encryptCredentials(credentials: BotCredentials): BotCredentials {
    // TODO: implement AES-256-GCM encryption using config.encryptionKey
    // For now, return as-is — production MUST encrypt
    return credentials;
  }

  private decryptCredentials(credentials: BotCredentials): BotCredentials {
    // TODO: implement decryption
    return credentials;
  }

  private getDefaultCapabilities(platformId: PlatformId) {
    // Import from platform-specific files in production
    return {
      supportsRichText: true,
      supportsFiles: true,
      supportsVoice: false,
      supportsReactions: true,
      supportsThreads: false,
      supportsGroups: true,
      supportsChannels: true,
      maxMessageLength: 4096,
      rateLimit: { messagesPerSecond: 10, messagesPerMinute: 300, messagesPerHour: 5000, burstLimit: 15 },
    };
  }

  private emitEvent(type: string, source: string, sourceId: string, payload: unknown): void {
    const event: SystemEvent = {
      id: this.generateId('evt'),
      type: type as SystemEvent['type'],
      source: source as SystemEvent['source'],
      sourceId,
      payload,
      timestamp: new Date(),
    };
    this.emit('event', event);
  }
}
