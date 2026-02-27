/**
 * API Gateway
 * Main REST + WebSocket entry point for the AgentMesh platform.
 * Handles bot management, agent configuration, swarm orchestration,
 * and real-time event streaming.
 *
 * Built on Fastify for maximum throughput.
 */

import type { AgentConfig, SwarmConfig, BotRegistration, ApiResponse } from '@agentmesh/types';
import { BotRegistry } from '../../bot-registry/src/registry';
import { AgentRuntime } from '../../agent-runtime/src/runtime';
import { SwarmCoordinator } from '../../swarm-coordinator/src/coordinator';
import { TelegramAdapter } from '../../packages/adapters/telegram/src/index';
import { DiscordAdapter } from '../../packages/adapters/discord/src/index';

// Using raw Node.js http + ws for portability
// Production: replace with Fastify + @fastify/websocket
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

export interface GatewayConfig {
  port?: number;
  host?: string;
  apiKey?: string;        // Shared secret for API authentication
}

export class ApiGateway {
  private registry: BotRegistry;
  private runtime: AgentRuntime;
  private coordinator: SwarmCoordinator;
  private adapters = new Map<string, TelegramAdapter | DiscordAdapter>();
  private wsClients = new Set<WebSocket>();
  private config: Required<GatewayConfig>;

  constructor(
    registry: BotRegistry,
    runtime: AgentRuntime,
    coordinator: SwarmCoordinator,
    config: GatewayConfig = {}
  ) {
    this.registry = registry;
    this.runtime = runtime;
    this.coordinator = coordinator;
    this.config = {
      port: config.port ?? 3000,
      host: config.host ?? '0.0.0.0',
      apiKey: config.apiKey ?? process.env.AGENTMESH_API_KEY ?? 'dev-key',
    };

    this.coordinator.on('task:completed', ({ botInstanceId, recipientId, response }) => {
      this.sendBotResponse(botInstanceId, recipientId, response.content.text ?? '');
    });

    this.registry.on('event', (event) => this.broadcastEvent(event));
    this.coordinator.on('event', (event) => this.broadcastEvent(event));
    this.runtime.on('event', (event) => this.broadcastEvent(event));
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handleRequest(req, res));
    const wss = new WebSocketServer({ server, path: '/events' });

    wss.on('connection', (ws) => {
      this.wsClients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', data: { stats: this.registry.getStats() } }));
      ws.on('close', () => this.wsClients.delete(ws));
    });

    return new Promise((resolve) => {
      server.listen(this.config.port, this.config.host, () => {
        console.log(`[Gateway] AgentMesh API running on http://${this.config.host}:${this.config.port}`);
        console.log(`[Gateway] WebSocket events at ws://${this.config.host}:${this.config.port}/events`);
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const method = req.method ?? 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check (except health endpoint)
    if (url.pathname !== '/health' && !this.checkAuth(req)) {
      this.json(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
      return;
    }

    // Parse body
    const body = await this.parseBody(req);

    try {
      // ── Routes ───────────────────────────────────────────────────────────

      // Health
      if (method === 'GET' && url.pathname === '/health') {
        return this.json(res, 200, { success: true, data: { status: 'healthy', uptime: process.uptime() } });
      }

      // Stats
      if (method === 'GET' && url.pathname === '/stats') {
        return this.json(res, 200, {
          success: true,
          data: {
            registry: this.registry.getStats(),
            agents: this.runtime.getAllAgents().length,
            swarms: this.coordinator.getAllSwarms().length,
          },
        });
      }

      // ── Bots ──────────────────────────────────────────────────────────────

      if (method === 'GET' && url.pathname === '/bots') {
        const filter = Object.fromEntries(url.searchParams);
        const bots = this.registry.findMany(filter);
        return this.json(res, 200, { success: true, data: bots });
      }

      if (method === 'POST' && url.pathname === '/bots') {
        const reg = body as BotRegistration;
        const bot = await this.registry.register(reg);

        // Auto-connect adapter
        await this.connectBotAdapter(bot.id);

        return this.json(res, 201, { success: true, data: bot });
      }

      if (method === 'DELETE' && url.pathname.startsWith('/bots/')) {
        const botId = url.pathname.split('/')[2];
        await this.disconnectBotAdapter(botId);
        await this.registry.deregister(botId);
        return this.json(res, 200, { success: true, data: { deleted: botId } });
      }

      if (method === 'GET' && url.pathname.startsWith('/bots/') && !url.pathname.endsWith('/')) {
        const botId = url.pathname.split('/')[2];
        const bot = this.registry.get(botId);
        if (!bot) return this.json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Bot not found' } });
        return this.json(res, 200, { success: true, data: bot });
      }

      // ── Agents ─────────────────────────────────────────────────────────────

      if (method === 'GET' && url.pathname === '/agents') {
        return this.json(res, 200, { success: true, data: this.runtime.getAllAgents() });
      }

      if (method === 'POST' && url.pathname === '/agents') {
        const config = body as AgentConfig;
        const instance = await this.runtime.spawnAgent(config);
        return this.json(res, 201, { success: true, data: instance });
      }

      if (method === 'DELETE' && url.pathname.startsWith('/agents/')) {
        const agentId = url.pathname.split('/')[2];
        await this.runtime.terminateAgent(agentId);
        return this.json(res, 200, { success: true, data: { terminated: agentId } });
      }

      // ── Swarms ─────────────────────────────────────────────────────────────

      if (method === 'GET' && url.pathname === '/swarms') {
        return this.json(res, 200, { success: true, data: this.coordinator.getAllSwarms() });
      }

      if (method === 'POST' && url.pathname === '/swarms') {
        const config = body as SwarmConfig;
        const swarm = await this.coordinator.formSwarm(config);
        return this.json(res, 201, { success: true, data: swarm });
      }

      if (method === 'DELETE' && url.pathname.startsWith('/swarms/')) {
        const swarmId = url.pathname.split('/')[2];
        await this.coordinator.dissolveSwarm(swarmId);
        return this.json(res, 200, { success: true, data: { dissolved: swarmId } });
      }

      if (method === 'GET' && url.pathname.startsWith('/swarms/')) {
        const swarmId = url.pathname.split('/')[2];
        const swarm = this.coordinator.getSwarm(swarmId);
        if (!swarm) return this.json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Swarm not found' } });
        return this.json(res, 200, { success: true, data: swarm });
      }

      // ── Webhooks (receive messages from platforms) ─────────────────────────

      if (method === 'POST' && url.pathname.startsWith('/webhook/')) {
        const [, , platform, botToken] = url.pathname.split('/');
        await this.handleWebhook(platform, botToken, body);
        return this.json(res, 200, { success: true, data: 'ok' });
      }

      // ── 404 ───────────────────────────────────────────────────────────────
      this.json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: `No route: ${method} ${url.pathname}` } });

    } catch (error) {
      console.error('[Gateway] Request error:', error);
      this.json(res, 500, {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }

  // ── Adapter Management ─────────────────────────────────────────────────────

  private async connectBotAdapter(botId: string): Promise<void> {
    const bot = this.registry.getOrThrow(botId);

    let adapter: TelegramAdapter | DiscordAdapter;

    switch (bot.platformId) {
      case 'telegram':
        adapter = new TelegramAdapter(bot, {
          webhookUrl: process.env.WEBHOOK_BASE_URL
            ? `${process.env.WEBHOOK_BASE_URL}/webhook/telegram/${bot.credentials.apiToken}`
            : undefined,
        });
        break;

      case 'discord':
        adapter = new DiscordAdapter(bot);
        break;

      default:
        console.warn(`[Gateway] No adapter for platform: ${bot.platformId}`);
        return;
    }

    // Wire adapter events
    adapter.on('message:received', async (message) => {
      this.registry.incrementMessageCount(botId);
      this.registry.recordHeartbeat(botId);

      // Route to assigned agent or swarm
      if (bot.swarmId) {
        await this.coordinator.routeMessage(bot.swarmId, message);
      } else if (bot.assignedAgentId) {
        const response = await this.runtime.processMessage(bot.assignedAgentId, message);
        await this.sendBotResponse(botId, message.metadata.platformChatId, response.content.text ?? '');
      }
    });

    adapter.on('bot:error', (id, error) => {
      this.registry.updateStatus(id, 'error');
      console.error(`[Gateway] Bot error: ${id}`, error);
    });

    adapter.on('bot:rate_limited', (id) => {
      this.registry.updateStatus(id, 'rate_limited');
    });

    this.adapters.set(botId, adapter);
    await adapter.connect();
  }

  private async disconnectBotAdapter(botId: string): Promise<void> {
    const adapter = this.adapters.get(botId);
    if (adapter) {
      await adapter.disconnect();
      this.adapters.delete(botId);
    }
  }

  private async sendBotResponse(botId: string, recipientId: string, text: string): Promise<void> {
    const adapter = this.adapters.get(botId);
    if (!adapter) return;

    try {
      await adapter.sendMessage({ recipientId, content: { text } });
      this.registry.incrementMessageCount(botId);
    } catch (error) {
      console.error(`[Gateway] Failed to send response via bot ${botId}:`, error);
    }
  }

  private async handleWebhook(platform: string, token: string, body: unknown): Promise<void> {
    // Find the bot by token
    const bot = this.registry.findMany({ platformId: platform as any }).find(
      (b) => b.credentials.apiToken === token
    );
    if (!bot) return;

    const adapter = this.adapters.get(bot.id);
    if (!adapter) return;

    if (platform === 'telegram' && adapter instanceof TelegramAdapter) {
      adapter.processUpdate(body as any);
    }
  }

  // ── WebSocket Broadcast ────────────────────────────────────────────────────

  private broadcastEvent(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const client of this.wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private checkAuth(req: IncomingMessage): boolean {
    const key = req.headers['x-api-key'];
    return key === this.config.apiKey;
  }

  private json(res: ServerResponse, status: number, data: ApiResponse): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

async function main() {
  const registry = new BotRegistry({
    healthCheckIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    encryptionKey: process.env.ENCRYPTION_KEY,
  });

  const runtime = new AgentRuntime({
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY ?? '50'),
    defaultTimeoutMs: 30_000,
    retryAttempts: 2,
  });

  const coordinator = new SwarmCoordinator(runtime, registry);

  const gateway = new ApiGateway(registry, runtime, coordinator, {
    port: parseInt(process.env.PORT ?? '3000'),
    apiKey: process.env.AGENTMESH_API_KEY,
  });

  await gateway.start();
}

main().catch(console.error);
