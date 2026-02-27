/**
 * Swarm Coordinator
 * Orchestrates multi-agent swarms across thousands of bots.
 * Handles topology, load balancing, auto-scaling, and inter-agent communication.
 *
 * Core of the AgentMesh distributed intelligence layer.
 */

import { EventEmitter } from 'events';
import type {
  SwarmConfig,
  SwarmInstance,
  SwarmMetrics,
  SwarmStatus,
  AgentConfig,
  AgentInstance,
  BotInstance,
  UnifiedMessage,
  SystemEvent,
  PlatformId,
} from '@agentmesh/types';
import { AgentRuntime, AgentResponse } from '../../agent-runtime/src/runtime';
import { BotRegistry } from '../../bot-registry/src/registry';

export interface SwarmMessage {
  fromAgentId: string;
  toAgentId: string | 'broadcast';
  type: 'task' | 'result' | 'query' | 'coordinate' | 'escalate';
  payload: unknown;
  priority: 1 | 2 | 3 | 4 | 5;
  timestamp: Date;
}

export interface TaskAssignment {
  taskId: string;
  agentId: string;
  botId?: string;
  message: UnifiedMessage;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  result?: AgentResponse;
  error?: string;
}

export class SwarmCoordinator extends EventEmitter {
  private swarms = new Map<string, SwarmInstance>();
  private messageBus = new Map<string, SwarmMessage[]>();
  private tasks = new Map<string, TaskAssignment>();
  private scalingCooldowns = new Map<string, number>();

  constructor(
    private runtime: AgentRuntime,
    private registry: BotRegistry
  ) {
    super();
    this.setMaxListeners(1000);
    this.startMetricsLoop();
  }

  // ── Swarm Lifecycle ────────────────────────────────────────────────────────

  async formSwarm(config: SwarmConfig): Promise<SwarmInstance> {
    console.log(`[Swarm] Forming swarm: ${config.name} (${config.topology} topology)`);

    // Spawn agents
    const agentInstances: AgentInstance[] = [];
    for (const agentConfig of config.agentConfigs) {
      const instance = await this.runtime.spawnAgent(agentConfig);
      agentInstances.push(instance);
    }

    // Assign bots to swarm
    const botIds = await this.assignBotsToSwarm(config);

    const metrics: SwarmMetrics = {
      totalMessagesProcessed: 0,
      totalTokensUsed: 0,
      averageResponseTime: 0,
      errorRate: 0,
      activeConversations: 0,
      botsOnline: botIds.length,
      agentsUtilisation: 0,
    };

    const instance: SwarmInstance = {
      id: config.id,
      config,
      status: 'active',
      agents: agentInstances,
      assignedBotIds: botIds,
      metrics,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.swarms.set(config.id, instance);
    this.messageBus.set(config.id, []);

    // Wire up bots to send messages to this swarm
    this.wireBotsToSwarm(instance, botIds);

    this.emitEvent('swarm.formed', config.id, { agentCount: agentInstances.length, botCount: botIds.length });
    console.log(`[Swarm] ${config.name} active with ${agentInstances.length} agents and ${botIds.length} bots`);

    return instance;
  }

  async dissolveSwarm(swarmId: string): Promise<void> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm ${swarmId} not found`);

    // Terminate all agents
    for (const agent of swarm.agents) {
      await this.runtime.terminateAgent(agent.id);
    }

    // Release all bots
    for (const botId of swarm.assignedBotIds) {
      this.registry.releaseBot(botId);
    }

    swarm.status = 'dissolved';
    this.swarms.delete(swarmId);
    this.messageBus.delete(swarmId);

    this.emitEvent('swarm.dissolved', swarmId, {});
    console.log(`[Swarm] Dissolved: ${swarmId}`);
  }

  // ── Message Routing ────────────────────────────────────────────────────────

  async routeMessage(swarmId: string, incomingMessage: UnifiedMessage): Promise<void> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm || swarm.status !== 'active') return;

    const agent = this.selectAgent(swarm, incomingMessage);
    if (!agent) {
      console.warn(`[Swarm] No available agent for message ${incomingMessage.id}`);
      return;
    }

    const task: TaskAssignment = {
      taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      agentId: agent.id,
      botId: incomingMessage.botInstanceId,
      message: incomingMessage,
      status: 'processing',
      startedAt: new Date(),
    };

    this.tasks.set(task.taskId, task);

    try {
      const response = await this.runtime.processMessage(agent.id, incomingMessage);
      task.status = 'completed';
      task.completedAt = new Date();
      task.result = response;

      swarm.metrics.totalMessagesProcessed++;
      swarm.metrics.totalTokensUsed += response.tokensUsed;
      swarm.metrics.averageResponseTime = this.updateRollingAvg(
        swarm.metrics.averageResponseTime,
        response.latencyMs,
        swarm.metrics.totalMessagesProcessed
      );

      // Emit response so gateway can send it back via the bot
      this.emit('task:completed', {
        task,
        response,
        swarmId,
        botInstanceId: incomingMessage.botInstanceId,
        recipientId: incomingMessage.metadata.platformChatId,
      });

    } catch (error) {
      task.status = 'failed';
      task.error = (error as Error).message;
      swarm.metrics.errorRate = this.updateErrorRate(swarm);

      this.emit('task:failed', { task, error, swarmId });
      console.error(`[Swarm] Task failed: ${task.taskId}`, error);
    }
  }

  // ── Auto-Scaling ──────────────────────────────────────────────────────────

  async evaluateScaling(swarmId: string): Promise<void> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return;

    const { scaling } = swarm.config;
    if (!scaling.autoScale) return;

    // Respect cooldown period
    const lastScale = this.scalingCooldowns.get(swarmId) ?? 0;
    if (Date.now() - lastScale < scaling.cooldownPeriod * 1000) return;

    const utilisation = swarm.metrics.agentsUtilisation;

    if (utilisation > scaling.scaleUpThreshold / 100 && swarm.agents.length < swarm.config.maxAgents) {
      const toAdd = Math.min(scaling.maxScaleUpStep, swarm.config.maxAgents - swarm.agents.length);
      await this.scaleUp(swarm, toAdd);
    } else if (utilisation < scaling.scaleDownThreshold / 100 && swarm.agents.length > swarm.config.minAgents) {
      const toRemove = Math.min(scaling.maxScaleDownStep, swarm.agents.length - swarm.config.minAgents);
      await this.scaleDown(swarm, toRemove);
    }
  }

  private async scaleUp(swarm: SwarmInstance, count: number): Promise<void> {
    const templateConfig = swarm.config.agentConfigs[0]; // Clone template agent
    const newAgents: AgentInstance[] = [];

    for (let i = 0; i < count; i++) {
      const config: AgentConfig = {
        ...templateConfig,
        id: `${templateConfig.id}_scaled_${Date.now()}_${i}`,
      };
      const instance = await this.runtime.spawnAgent(config);
      newAgents.push(instance);
      swarm.agents.push(instance);
    }

    // Assign more bots if available
    const newBots = this.registry.findAvailable(
      swarm.config.botAssignment.platforms[0] as PlatformId,
      count * swarm.config.botAssignment.maxBotsPerAgent
    );

    for (const bot of newBots) {
      this.registry.assignToSwarm(bot.id, swarm.id);
      swarm.assignedBotIds.push(bot.id);
    }

    this.scalingCooldowns.set(swarm.id, Date.now());
    this.emitEvent('swarm.scaled_up', swarm.id, { addedAgents: count });
    console.log(`[Swarm] Scaled up ${swarm.config.name}: +${count} agents`);
  }

  private async scaleDown(swarm: SwarmInstance, count: number): Promise<void> {
    // Remove idle agents from the end of the list
    const toRemove = swarm.agents.splice(-count);

    for (const agent of toRemove) {
      await this.runtime.terminateAgent(agent.id);
    }

    this.scalingCooldowns.set(swarm.id, Date.now());
    this.emitEvent('swarm.scaled_down', swarm.id, { removedAgents: count });
    console.log(`[Swarm] Scaled down ${swarm.config.name}: -${count} agents`);
  }

  // ── Inter-Agent Communication ──────────────────────────────────────────────

  broadcastToSwarm(swarmId: string, message: Omit<SwarmMessage, 'toAgentId'>): void {
    const bus = this.messageBus.get(swarmId);
    if (!bus) return;

    bus.push({ ...message, toAgentId: 'broadcast' });
    this.emit(`swarm:${swarmId}:broadcast`, message);
  }

  sendToAgent(swarmId: string, toAgentId: string, message: Omit<SwarmMessage, 'toAgentId'>): void {
    const bus = this.messageBus.get(swarmId);
    if (!bus) return;

    const fullMessage = { ...message, toAgentId };
    bus.push(fullMessage);
    this.emit(`agent:${toAgentId}:message`, fullMessage);
  }

  // ── Bot Assignment ─────────────────────────────────────────────────────────

  private async assignBotsToSwarm(config: SwarmConfig): Promise<string[]> {
    const botIds: string[] = [];

    for (const platformId of config.botAssignment.platforms) {
      const needed = config.agentConfigs.length * config.botAssignment.maxBotsPerAgent;
      const bots = this.registry.findAvailable(platformId as PlatformId, needed);

      for (const bot of bots) {
        this.registry.assignToSwarm(bot.id, config.id);
        botIds.push(bot.id);
      }
    }

    return botIds;
  }

  private wireBotsToSwarm(swarm: SwarmInstance, botIds: string[]): void {
    // In production: subscribe to Redis channel / message bus
    // Here we emit so the gateway layer can pick it up
    this.emit('swarm:bots_assigned', {
      swarmId: swarm.id,
      botIds,
      handler: (message: UnifiedMessage) => this.routeMessage(swarm.id, message),
    });
  }

  // ── Agent Selection ────────────────────────────────────────────────────────

  private selectAgent(swarm: SwarmInstance, message: UnifiedMessage): AgentInstance | null {
    const runningAgents = swarm.agents.filter((a) => a.status === 'running');
    if (!runningAgents.length) return null;

    const { loadBalancing } = swarm.config.agentConfigs[0]?.routing ?? { loadBalancing: 'least_loaded' };

    switch (loadBalancing) {
      case 'round_robin':
        return runningAgents[swarm.metrics.totalMessagesProcessed % runningAgents.length];

      case 'least_loaded':
        return runningAgents.reduce((least, agent) =>
          agent.activeConversations < least.activeConversations ? agent : least
        );

      case 'random':
        return runningAgents[Math.floor(Math.random() * runningAgents.length)];

      case 'sticky': {
        // Route to same agent based on user ID for conversation continuity
        const hash = this.hash(message.sender.id) % runningAgents.length;
        return runningAgents[hash];
      }

      default:
        return runningAgents[0];
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private updateRollingAvg(current: number, newValue: number, count: number): number {
    return (current * (count - 1) + newValue) / count;
  }

  private updateErrorRate(swarm: SwarmInstance): number {
    const failedTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'failed' && swarm.assignedBotIds.includes(t.botId ?? '')
    ).length;
    return failedTasks / Math.max(1, swarm.metrics.totalMessagesProcessed);
  }

  private hash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private startMetricsLoop(): void {
    setInterval(() => {
      for (const [swarmId, swarm] of this.swarms) {
        // Update utilisation
        const totalActive = swarm.agents.reduce((sum, a) => sum + a.activeConversations, 0);
        const totalCapacity = swarm.agents.reduce(
          (sum, a) => sum + a.config.rateLimits.maxConcurrentConversations,
          0
        );
        swarm.metrics.agentsUtilisation = totalCapacity > 0 ? totalActive / totalCapacity : 0;
        swarm.metrics.botsOnline = swarm.assignedBotIds.filter(
          (id) => this.registry.get(id)?.status === 'online'
        ).length;

        this.evaluateScaling(swarmId);
      }
    }, 10_000); // Every 10s
  }

  getSwarm(swarmId: string): SwarmInstance | undefined {
    return this.swarms.get(swarmId);
  }

  getAllSwarms(): SwarmInstance[] {
    return Array.from(this.swarms.values());
  }

  private emitEvent(type: string, sourceId: string, payload: unknown): void {
    const event: SystemEvent = {
      id: `evt_${Date.now()}`,
      type: type as SystemEvent['type'],
      source: 'swarm',
      sourceId,
      payload,
      timestamp: new Date(),
    };
    this.emit('event', event);
  }
}
