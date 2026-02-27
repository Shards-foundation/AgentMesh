# 🕸️ AgentMesh

**Enterprise AI Agent Swarm ↔ Bot Network Bridge**

Connect AI agent swarms to thousands of real bots across Telegram, Discord, Slack, WhatsApp, Twitter, Reddit, and any custom platform — with full orchestration, auto-scaling, and real-time observability.

Built by [Shards Inc / Shards Labs](https://shardsinc.io) — Sunil Singh

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        API Gateway :3000                            │
│              REST + WebSocket — Single entry point                  │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
         ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌──────────────┐
   │   Bot    │  │  Agent   │  │    Swarm     │
   │Registry  │  │ Runtime  │  │ Coordinator  │
   └────┬─────┘  └────┬─────┘  └──────┬───────┘
        │             │               │
        ▼             ▼               ▼
   ┌──────────────────────────────────────────┐
   │           Message Bus (Redis/RabbitMQ)   │
   └──────────────────────────────────────────┘
        │
   ┌────┴──────────────────────────────┐
   │        Platform Adapters          │
   │  Telegram │ Discord │ Slack │ ... │
   └───────────────────────────────────┘
        │
   ┌────┴──────────────────────────────┐
   │         Real Bot Instances        │
   │  1,000+ concurrent bot sessions   │
   └───────────────────────────────────┘
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| `api-gateway` | 3000 | REST API + WebSocket event stream |
| `bot-registry` | 3001 | Central bot instance management |
| `agent-runtime` | 3002 | LLM agent execution engine |
| `swarm-coordinator` | 3003 | Multi-agent swarm orchestration |
| `admin-dashboard` | 3004 | Real-time monitoring UI |

### Supported Platforms

| Platform | Status | Adapter |
|----------|--------|---------|
| Telegram | ✅ Production | `packages/adapters/telegram` |
| Discord | ✅ Production | `packages/adapters/discord` |
| Slack | 🔧 In Progress | `packages/adapters/slack` |
| WhatsApp (via Cloud API) | 🔧 In Progress | `packages/adapters/whatsapp` |
| Twitter/X | 🔧 In Progress | `packages/adapters/twitter` |
| Reddit | 🔧 In Progress | `packages/adapters/reddit` |
| Matrix | 📋 Planned | `packages/adapters/matrix` |
| Custom | ✅ Extensible | Extend `BaseAdapter` |

### Supported LLM Providers

| Provider | Models |
|----------|--------|
| Anthropic | Claude Opus, Sonnet, Haiku |
| OpenAI | GPT-4o, GPT-4, GPT-3.5 |
| Google | Gemini 1.5 Pro/Flash |
| Groq | Llama 3.1, Mixtral |
| Ollama | Local models (self-hosted) |

---

## Quick Start

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9
- Docker + Docker Compose
- Git

### 1. Clone & Install

```bash
git clone https://github.com/shardsinc/agentmesh.git
cd agentmesh
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

Required variables:
```env
# Database
DATABASE_URL=postgresql://agentmesh:password@localhost:5432/agentmesh
REDIS_URL=redis://localhost:6379

# Security
AGENTMESH_API_KEY=your-secret-api-key
ENCRYPTION_KEY=32-char-key-for-bot-credential-enc

# LLM Providers (add the ones you use)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_AI_API_KEY=AIza...
GROQ_API_KEY=gsk_...
```

### 3. Start Infrastructure

```bash
pnpm docker:up
pnpm db:migrate
```

### 4. Start Services

```bash
pnpm dev
```

### 5. Register Your First Bot

```bash
# Register a Telegram bot
curl -X POST http://localhost:3000/bots \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "platformId": "telegram",
    "name": "MyBot",
    "username": "my_bot",
    "credentials": { "apiToken": "YOUR_TELEGRAM_BOT_TOKEN" }
  }'
```

### 6. Spawn an Agent

```bash
curl -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "id": "agent-001",
    "name": "Shards AI Assistant",
    "role": "responder",
    "description": "Customer support agent",
    "systemPrompt": "You are a helpful AI assistant for Shards Inc.",
    "model": {
      "provider": "anthropic",
      "modelId": "claude-sonnet-4-5",
      "temperature": 0.7,
      "maxTokens": 1024
    },
    "tools": [],
    "memory": { "type": "short_term", "maxTokens": 4096 },
    "routing": { "platforms": ["telegram"], "priority": 5, "loadBalancing": "least_loaded" },
    "rateLimits": { "maxConcurrentConversations": 50, "maxMessagesPerMinute": 300, "maxTokensPerMinute": 100000 },
    "capabilities": { "canSendMessages": true, "canReceiveMessages": true, "canExecuteCommands": false, "canManageBots": false, "canAccessDatabase": false, "canCallExternalAPIs": false }
  }'
```

### 7. Form a Swarm (Advanced)

```bash
curl -X POST http://localhost:3000/swarms \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "id": "swarm-001",
    "name": "Customer Support Swarm",
    "topology": "star",
    "minAgents": 3,
    "maxAgents": 20,
    "agentConfigs": [ /* array of AgentConfig objects */ ],
    "botAssignment": {
      "mode": "pool",
      "platforms": ["telegram", "discord"],
      "maxBotsPerAgent": 10,
      "botSelectionStrategy": "least_loaded"
    },
    "scaling": {
      "autoScale": true,
      "scaleUpThreshold": 80,
      "scaleDownThreshold": 20,
      "cooldownPeriod": 60,
      "maxScaleUpStep": 5,
      "maxScaleDownStep": 2
    },
    "communication": {
      "bus": "redis",
      "protocol": "json",
      "encryption": false,
      "compression": false
    },
    "goals": []
  }'
```

---

## Monorepo Structure

```
agentmesh/
├── apps/
│   ├── api-gateway/         # REST + WebSocket gateway
│   ├── agent-runtime/       # LLM agent execution
│   ├── swarm-coordinator/   # Swarm orchestration
│   ├── bot-registry/        # Bot instance management
│   └── admin-dashboard/     # Next.js monitoring UI
│
├── packages/
│   ├── adapters/
│   │   ├── telegram/        # Telegram Bot API adapter
│   │   ├── discord/         # Discord Gateway + REST adapter
│   │   ├── slack/           # Slack Bolt adapter
│   │   ├── whatsapp/        # WhatsApp Cloud API adapter
│   │   ├── twitter/         # Twitter API v2 adapter
│   │   ├── reddit/          # Reddit PRAW adapter
│   │   └── matrix/          # Matrix SDK adapter
│   │
│   ├── core/
│   │   ├── types/           # Shared TypeScript types
│   │   ├── utils/           # Shared utilities
│   │   ├── logger/          # Structured logging
│   │   ├── config/          # Config management
│   │   └── errors/          # Error classes
│   │
│   ├── messaging/
│   │   ├── router/          # Message routing engine
│   │   ├── queue/           # Queue management
│   │   └── bus/             # Event bus abstraction
│   │
│   ├── agent/
│   │   ├── base/            # Agent base class
│   │   ├── swarm/           # Swarm abstractions
│   │   └── tools/           # Built-in agent tools
│   │
│   ├── db/                  # Prisma schema + migrations
│   ├── auth/                # JWT + API key auth
│   └── monitoring/          # Metrics + tracing
│
├── infrastructure/
│   ├── docker/              # Dockerfiles + Compose
│   ├── k8s/                 # Kubernetes manifests
│   └── nginx/               # Reverse proxy config
│
├── scripts/                 # Dev + ops scripts
├── docs/                    # Documentation
└── .github/
    └── workflows/           # CI/CD pipelines
```

---

## Key Concepts

### Bot Instance
A live, authenticated connection to a platform. AgentMesh manages thousands simultaneously, tracking health, rate limits, and assignment.

### Agent
An AI-powered processing unit. Each agent has a model, system prompt, tools, and memory. Agents process messages from bots and generate responses.

### Swarm
A coordinated group of agents working together. Supports multiple topologies (star, mesh, pipeline, hierarchical, broadcast) and auto-scales based on load.

### Adapter
Platform-specific integration code. Each adapter normalises platform messages into the `UnifiedMessage` format and handles platform-specific rate limits, auth, and features.

### Message Router
Rules-based routing engine that directs incoming messages to the right agent or swarm based on configurable conditions.

---

## Scaling

AgentMesh is designed for horizontal scale:

- **Bot instances**: Redis-backed registry supports 10,000+ concurrent bots
- **Agents**: Stateless runtime — add instances behind a load balancer
- **Swarms**: Auto-scale agents up/down based on utilisation thresholds
- **Messages**: RabbitMQ queue handles burst traffic with backpressure
- **Database**: Prisma + Postgres with read replicas for heavy query loads

Production deployment uses Kubernetes with HPA for agent-runtime pods.

---

## API Reference

All endpoints require `X-API-Key` header except `/health`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/stats` | System statistics |
| GET | `/bots` | List all bots |
| POST | `/bots` | Register a new bot |
| GET | `/bots/:id` | Get bot details |
| DELETE | `/bots/:id` | Deregister a bot |
| GET | `/agents` | List all agents |
| POST | `/agents` | Spawn an agent |
| DELETE | `/agents/:id` | Terminate an agent |
| GET | `/swarms` | List all swarms |
| POST | `/swarms` | Form a swarm |
| GET | `/swarms/:id` | Get swarm details |
| DELETE | `/swarms/:id` | Dissolve a swarm |

### WebSocket Events

Connect to `ws://localhost:3000/events` (with `X-API-Key` query param) to receive real-time events:

```json
{ "type": "bot.connected", "sourceId": "bot_xxx", "payload": { ... } }
{ "type": "message.received", "sourceId": "bot_xxx", "payload": { ... } }
{ "type": "agent.response", "sourceId": "agent_xxx", "payload": { ... } }
{ "type": "swarm.scaled_up", "sourceId": "swarm_xxx", "payload": { ... } }
```

---

## Adding a New Platform

1. Create `packages/adapters/{platform}/src/index.ts`
2. Extend `BaseAdapter`
3. Implement all abstract methods: `connect`, `disconnect`, `sendMessage`, `editMessage`, `deleteMessage`, `reactToMessage`, `getBotInfo`, `validateCredentials`
4. Define `platformId` and `capabilities` constants
5. Register the adapter in `apps/api-gateway/src/gateway.ts`

---

## Contributing

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/new-adapter`
3. Commit with conventional commits: `feat(adapters): add Twitter adapter`
4. Push and open a pull request

---

## Roadmap

- [ ] Slack adapter
- [ ] WhatsApp Cloud API adapter
- [ ] Twitter/X v2 adapter
- [ ] Matrix adapter (self-hosted)
- [ ] Agent tool marketplace
- [ ] Visual swarm builder (drag-and-drop)
- [ ] Built-in RAG + vector memory
- [ ] Crypto trading agent templates (Hyperliquid)
- [ ] Multi-tenant workspace isolation
- [ ] Billing + usage metering
- [ ] Admin dashboard (Next.js)

---

## License

Proprietary — Shards Inc / Shards Labs © 2025
All rights reserved. Contact sunil@shardsinc.io for licensing.

---

*Built with precision by Shards Labs — the AI-first innovation hub.*
