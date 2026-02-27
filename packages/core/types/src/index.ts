/**
 * @agentmesh/types
 * Core type definitions for the entire AgentMesh system
 * Sunil Singh — Shards Inc / Shards Labs
 */

// ============================================================
// PLATFORM TYPES
// ============================================================

export type PlatformId =
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp'
  | 'twitter'
  | 'reddit'
  | 'matrix'
  | 'twitch'
  | 'youtube'
  | 'instagram'
  | 'linkedin'
  | 'custom';

export interface PlatformCapabilities {
  supportsRichText: boolean;
  supportsFiles: boolean;
  supportsVoice: boolean;
  supportsReactions: boolean;
  supportsThreads: boolean;
  supportsGroups: boolean;
  supportsChannels: boolean;
  maxMessageLength: number;
  rateLimit: RateLimit;
}

export interface RateLimit {
  messagesPerSecond: number;
  messagesPerMinute: number;
  messagesPerHour: number;
  burstLimit: number;
}

// ============================================================
// BOT INSTANCE TYPES
// ============================================================

export type BotStatus =
  | 'online'
  | 'offline'
  | 'rate_limited'
  | 'banned'
  | 'error'
  | 'initializing'
  | 'draining';

export interface BotCredentials {
  apiToken?: string;
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  webhookSecret?: string;
  appId?: string;
  botId?: string;
  [key: string]: string | undefined;
}

export interface BotInstance {
  id: string;                          // UUID
  platformId: PlatformId;
  name: string;
  username: string;
  status: BotStatus;
  credentials: BotCredentials;         // Encrypted in DB
  capabilities: PlatformCapabilities;
  metadata: Record<string, unknown>;
  assignedAgentId?: string;
  swarmId?: string;
  workspaceId?: string;                // For multi-tenant
  rateLimitState: RateLimitState;
  healthScore: number;                 // 0-100
  messagesProcessed: number;
  lastHeartbeat: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RateLimitState {
  currentSecond: number;
  currentMinute: number;
  currentHour: number;
  windowStart: Date;
  isThrottled: boolean;
  throttleUntil?: Date;
}

// ============================================================
// MESSAGE TYPES
// ============================================================

export type MessageDirection = 'inbound' | 'outbound';
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'location'
  | 'contact'
  | 'sticker'
  | 'reaction'
  | 'system'
  | 'command';

export interface UnifiedMessage {
  id: string;
  platformId: PlatformId;
  botInstanceId: string;
  direction: MessageDirection;
  type: MessageType;
  content: MessageContent;
  sender: MessageSender;
  recipient: MessageRecipient;
  channel?: MessageChannel;
  thread?: MessageThread;
  metadata: MessageMetadata;
  agentId?: string;
  swarmId?: string;
  correlationId?: string;              // For request/response tracking
  parentMessageId?: string;
  timestamp: Date;
  processedAt?: Date;
  deliveredAt?: Date;
}

export interface MessageContent {
  text?: string;
  html?: string;
  markdown?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaSize?: number;
  buttons?: ActionButton[];
  embeds?: MessageEmbed[];
  entities?: MessageEntity[];
  raw?: unknown;                       // Platform-native raw payload
}

export interface ActionButton {
  id: string;
  label: string;
  action: string;
  style?: 'primary' | 'secondary' | 'danger' | 'link';
  url?: string;
  data?: Record<string, unknown>;
}

export interface MessageEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  image?: string;
  thumbnail?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
  timestamp?: Date;
}

export interface MessageEntity {
  type: 'mention' | 'url' | 'hashtag' | 'command' | 'bold' | 'italic' | 'code';
  offset: number;
  length: number;
  value?: string;
}

export interface MessageSender {
  id: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  isBot: boolean;
  roles?: string[];
  permissions?: string[];
}

export interface MessageRecipient {
  id: string;
  type: 'user' | 'group' | 'channel' | 'dm';
  name?: string;
}

export interface MessageChannel {
  id: string;
  name?: string;
  type: 'dm' | 'group' | 'channel' | 'forum' | 'voice';
  guildId?: string;
  guildName?: string;
}

export interface MessageThread {
  id: string;
  parentMessageId: string;
  title?: string;
}

export interface MessageMetadata {
  platformMessageId: string;          // Original platform message ID
  platformChatId: string;
  platformUserId: string;
  editedAt?: Date;
  forwardedFrom?: string;
  replyToMessageId?: string;
  reactions?: MessageReaction[];
  isPinned?: boolean;
  isForwarded?: boolean;
  raw?: unknown;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

// ============================================================
// AGENT TYPES
// ============================================================

export type AgentStatus = 'idle' | 'running' | 'paused' | 'error' | 'terminated';
export type AgentRole =
  | 'orchestrator'
  | 'executor'
  | 'analyst'
  | 'responder'
  | 'monitor'
  | 'moderator'
  | 'trader'
  | 'content_creator'
  | 'customer_support'
  | 'custom';

export interface AgentConfig {
  id: string;
  name: string;
  role: AgentRole;
  description: string;
  systemPrompt: string;
  model: AgentModel;
  tools: AgentTool[];
  memory: AgentMemoryConfig;
  routing: AgentRoutingConfig;
  rateLimits: AgentRateLimits;
  capabilities: AgentCapabilities;
  metadata: Record<string, unknown>;
}

export interface AgentModel {
  provider: 'anthropic' | 'openai' | 'google' | 'groq' | 'ollama' | 'custom';
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  streaming?: boolean;
  fallbackModel?: AgentModel;
}

export interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: string;                     // Handler function name
  requiredPermissions?: string[];
}

export interface AgentMemoryConfig {
  type: 'none' | 'short_term' | 'long_term' | 'hybrid';
  maxTokens?: number;
  vectorStore?: string;
  ttl?: number;
}

export interface AgentRoutingConfig {
  platforms: PlatformId[];
  botInstances?: string[];             // Specific bot instance IDs
  swarmId?: string;
  priority: number;                    // 1-10
  loadBalancing: 'round_robin' | 'least_loaded' | 'random' | 'sticky';
}

export interface AgentRateLimits {
  maxConcurrentConversations: number;
  maxMessagesPerMinute: number;
  maxTokensPerMinute: number;
}

export interface AgentCapabilities {
  canSendMessages: boolean;
  canReceiveMessages: boolean;
  canExecuteCommands: boolean;
  canManageBots: boolean;
  canAccessDatabase: boolean;
  canCallExternalAPIs: boolean;
  customCapabilities?: string[];
}

export interface AgentInstance {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  swarmId?: string;
  assignedBotIds: string[];
  activeConversations: number;
  totalMessagesProcessed: number;
  totalTokensUsed: number;
  lastActivity: Date;
  healthScore: number;
  createdAt: Date;
}

// ============================================================
// SWARM TYPES
// ============================================================

export type SwarmStatus = 'forming' | 'active' | 'scaling' | 'pausing' | 'dissolved';
export type SwarmTopology =
  | 'star'          // One orchestrator + many executors
  | 'mesh'          // All agents connected to all others
  | 'hierarchical'  // Tree structure
  | 'pipeline'      // Sequential processing
  | 'broadcast';    // One-to-many

export interface SwarmConfig {
  id: string;
  name: string;
  description: string;
  topology: SwarmTopology;
  minAgents: number;
  maxAgents: number;
  agentConfigs: AgentConfig[];
  orchestratorAgentId?: string;
  botAssignment: SwarmBotAssignment;
  scaling: SwarmScalingConfig;
  communication: SwarmCommunicationConfig;
  goals: SwarmGoal[];
  metadata: Record<string, unknown>;
}

export interface SwarmBotAssignment {
  mode: 'dedicated' | 'shared' | 'pool';
  platforms: PlatformId[];
  maxBotsPerAgent: number;
  botSelectionStrategy: 'random' | 'least_loaded' | 'platform_affinity' | 'geographic';
}

export interface SwarmScalingConfig {
  autoScale: boolean;
  scaleUpThreshold: number;           // % utilisation
  scaleDownThreshold: number;
  cooldownPeriod: number;             // seconds
  maxScaleUpStep: number;
  maxScaleDownStep: number;
}

export interface SwarmCommunicationConfig {
  bus: 'redis' | 'rabbitmq' | 'kafka' | 'nats';
  protocol: 'json' | 'msgpack' | 'protobuf';
  encryption: boolean;
  compression: boolean;
}

export interface SwarmGoal {
  id: string;
  description: string;
  priority: number;
  deadline?: Date;
  successCriteria: Record<string, unknown>;
  assignedAgentId?: string;
}

export interface SwarmInstance {
  id: string;
  config: SwarmConfig;
  status: SwarmStatus;
  agents: AgentInstance[];
  assignedBotIds: string[];
  metrics: SwarmMetrics;
  createdAt: Date;
  updatedAt: Date;
}

export interface SwarmMetrics {
  totalMessagesProcessed: number;
  totalTokensUsed: number;
  averageResponseTime: number;        // ms
  errorRate: number;                  // 0-1
  activeConversations: number;
  botsOnline: number;
  agentsUtilisation: number;          // 0-1
}

// ============================================================
// ROUTING & PIPELINE TYPES
// ============================================================

export interface RoutingRule {
  id: string;
  name: string;
  priority: number;
  conditions: RoutingCondition[];
  action: RoutingAction;
  enabled: boolean;
}

export interface RoutingCondition {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'startsWith' | 'matches' | 'in' | 'gt' | 'lt';
  value: unknown;
}

export interface RoutingAction {
  type: 'route_to_agent' | 'route_to_swarm' | 'drop' | 'queue' | 'transform' | 'escalate';
  targetId?: string;
  transform?: MessageTransform;
  queueName?: string;
  escalationLevel?: number;
}

export interface MessageTransform {
  addFields?: Record<string, unknown>;
  removeFields?: string[];
  mapFields?: Record<string, string>;
  template?: string;
}

// ============================================================
// EVENT TYPES
// ============================================================

export type EventType =
  | 'bot.connected'
  | 'bot.disconnected'
  | 'bot.rate_limited'
  | 'bot.banned'
  | 'bot.error'
  | 'message.received'
  | 'message.sent'
  | 'message.delivered'
  | 'message.failed'
  | 'agent.started'
  | 'agent.stopped'
  | 'agent.error'
  | 'agent.response'
  | 'swarm.formed'
  | 'swarm.dissolved'
  | 'swarm.scaled_up'
  | 'swarm.scaled_down'
  | 'system.health_check'
  | 'system.alert';

export interface SystemEvent<T = unknown> {
  id: string;
  type: EventType;
  source: 'bot' | 'agent' | 'swarm' | 'gateway' | 'registry' | 'system';
  sourceId: string;
  payload: T;
  correlationId?: string;
  workspaceId?: string;
  timestamp: Date;
}

// ============================================================
// API TYPES
// ============================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

export interface ApiMeta {
  pagination?: Pagination;
  requestId: string;
  processingTime: number;
  version: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// ============================================================
// HEALTH & MONITORING TYPES
// ============================================================

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  timestamp: Date;
  checks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  duration: number;
  metadata?: Record<string, unknown>;
}

export interface SystemMetrics {
  botsTotal: number;
  botsOnline: number;
  agentsTotal: number;
  agentsRunning: number;
  swarmsActive: number;
  messagesPerSecond: number;
  messagesQueueDepth: number;
  averageLatency: number;
  errorRate: number;
  cpuUsage: number;
  memoryUsage: number;
  timestamp: Date;
}
