# LDV-Bridge Backend

Backend API for LDV-Bridge platform - Governance and version control for low-code/no-code applications.

## Tech Stack

- **Framework:** NestJS 11 with TypeScript
- **Database:** PostgreSQL 16 + Prisma ORM
- **Cache:** Redis 7
- **Queue:** Bull (Redis-based)
- **WebSockets:** Socket.io
- **Authentication:** Auth0 + Passport JWT
- **API Documentation:** Swagger/OpenAPI
- **Logging:** Winston
- **Testing:** Jest

## Quick Start

### Prerequisites

- Node.js 20+ and npm
- Docker & Docker Compose (for databases)
- Auth0 account (for authentication)

### Installation

1. **Install dependencies:**
```bash
npm install
```

2. **Set up environment variables:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Start databases (Docker):**
```bash
docker compose up -d
```

This starts:
- PostgreSQL on port 5433 ⚠️ (changed from 5432 due to local conflict)
- Redis on port 6379
- PgAdmin on port 5050 (optional GUI)
- Redis Commander on port 8081 (optional GUI)

4. **Run database migrations:**
```bash
npm run prisma:migrate
npm run prisma:generate
```

5. **Start development server:**
```bash
npm run start:dev
```

The API will be available at `http://localhost:3001`

## Project Structure

```
backend/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── main.ts                # Application entry point
│   ├── app.module.ts          # Root module
│   ├── auth/                  # Authentication & authorization
│   ├── users/                 # User management
│   ├── organizations/         # Multi-tenant organizations
│   ├── connectors/            # Platform connectors (PowerApps, Mendix)
│   ├── apps/                  # App management
│   ├── changes/               # Change management & version control
│   ├── reviews/               # Review workflow
│   ├── diff/                  # Diff engine (metadata, code)
│   ├── risk/                  # Risk assessment engine
│   ├── sandbox/               # Sandbox management
│   ├── deployment/            # CI/CD & deployment
│   ├── notifications/         # Real-time notifications
│   ├── analytics/             # Analytics & reporting
│   ├── audit/                 # Audit logs
│   ├── policies/              # Policy management
│   ├── learning/              # Learning hub content
│   ├── common/                # Shared utilities
│   │   ├── guards/            # Auth guards
│   │   ├── decorators/        # Custom decorators
│   │   ├── filters/           # Exception filters
│   │   ├── interceptors/      # Interceptors
│   │   └── pipes/             # Validation pipes
│   └── config/                # Configuration
├── test/                      # E2E tests
├── docker-compose.yml         # Docker services
└── README.md                  # This file
```

## Available Scripts

```bash
# Development
npm run start              # Start server
npm run start:dev          # Start with watch mode
npm run start:debug        # Start with debug mode

# Building
npm run build              # Build for production

# Testing
npm run test               # Run unit tests
npm run test:watch         # Run tests in watch mode
npm run test:cov           # Run tests with coverage
npm run test:e2e           # Run E2E tests

# Database
npm run prisma:generate    # Generate Prisma client
npm run prisma:migrate     # Run migrations
npm run prisma:studio      # Open Prisma Studio GUI

# Code Quality
npm run lint               # Lint code
npm run format             # Format code
```

## API Documentation

Once the server is running, visit:
- Swagger UI: `http://localhost:3001/api/docs`
- API JSON: `http://localhost:3001/api/docs-json`

## Database Access

### PgAdmin (Web UI)
- URL: `http://localhost:5050`
- Email: `admin@ldv-bridge.local`
- Password: `admin`

### Redis Commander (Web UI)
- URL: `http://localhost:8081`

### Prisma Studio
```bash
npm run prisma:studio
```

## Environment Variables

See `.env.example` for all available configuration options.

### Required for Development

1. **Auth0:**
   - Create an Auth0 application
   - Set `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`

2. **PowerApps (optional for testing):**
   - Register Azure AD application
   - Set `POWERAPP_CLIENT_ID`, `POWERAPP_CLIENT_SECRET`, `POWERAPP_TENANT_ID`

3. **Mendix (optional for testing):**
   - Get API credentials from Mendix
   - Set `MENDIX_API_KEY`, `MENDIX_USERNAME`

4. **GitHub (optional for CI/CD):**
   - Create GitHub App or OAuth App
   - Set GitHub credentials

5. **Email (optional):**
   - Use Gmail with app password
   - Set `SMTP_USER`, `SMTP_PASSWORD`

## Multi-Tenancy

The platform is multi-tenant from day one. Every request must include:
- Organization context (via JWT or header)
- All data queries are scoped to `organizationId`

## Authentication Flow

1. User authenticates with Auth0
2. Backend validates JWT token
3. User/Organization context attached to request
4. Role-based access control (RBAC) enforced

### Roles
- **CITIZEN_DEVELOPER:** Create and submit changes
- **PRO_DEVELOPER:** Review and approve changes
- **ADMIN:** Full platform access

## Development Workflow

### Adding a New Feature

1. **Create module:**
```bash
nest g module features/my-feature
nest g service features/my-feature
nest g controller features/my-feature
```

2. **Update Prisma schema** (if needed):
```prisma
model MyFeature {
  id String @id @default(uuid())
  // ...fields
}
```

3. **Generate migration:**
```bash
npm run prisma:migrate
```

4. **Implement service & controller**

5. **Write tests**

6. **Update API documentation** (Swagger decorators)

## Testing

### Unit Tests
```bash
npm run test
```

### E2E Tests
```bash
npm run test:e2e
```

### Test Coverage
```bash
npm run test:cov
```

## Deployment

### Railway (Recommended)

1. Install Railway CLI:
```bash
npm i -g @railway/cli
```

2. Initialize:
```bash
railway init
```

3. Deploy:
```bash
railway up
```

### Docker

1. Build image:
```bash
docker build -t ldv-bridge-backend .
```

2. Run:
```bash
docker run -p 3001:3001 ldv-bridge-backend
```

## Monitoring & Logging

Logs are written to:
- Console (development)
- Files in `./logs` directory (production)
- Winston rotating file logger

Log Levels:
- `error`: Errors only
- `warn`: Warnings + errors
- `info`: Info + above (production default)
- `debug`: Debug + above (development default)

## Security

- All external API credentials encrypted at rest
- CORS configured for frontend origin
- Rate limiting enabled
- JWT validation on all protected routes
- SQL injection prevention (Prisma parameterized queries)
- XSS protection via input validation
- CSRF protection for state-changing operations

## Troubleshooting

### Database Connection Issues
```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# View logs
docker logs ldv-bridge-postgres
```

### Redis Connection Issues
```bash
# Check if Redis is running
docker ps | grep redis

# Test connection
redis-cli ping
```

### Prisma Issues
```bash
# Reset database (CAUTION: Deletes all data)
npx prisma migrate reset

# Regenerate client
npm run prisma:generate
```

### Port Already in Use
```bash
# Find process using port 3001
netstat -ano | findstr :3001

# Kill process (Windows)
taskkill /PID <PID> /F
```

## Contributing

1. Create feature branch
2. Make changes
3. Write/update tests
4. Ensure linting passes: `npm run lint`
5. Submit pull request

## License

MIT

## Support

For issues and questions, please open a GitHub issue.
