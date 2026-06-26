# WatchTogether

**P2P video calling, screen sharing, and synced YouTube co-watching with ML background blur**

![React](https://img.shields.io/badge/React-19-blue?style=flat-square&logo=react)
![.NET](https://img.shields.io/badge/.NET-8-purple?style=flat-square&logo=.net)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-green?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

## About

WatchTogether is a modern, production-grade peer-to-peer video calling platform that lets two people connect directly without a centralized server processing media. It combines real-time video/audio with screen sharing, synchronized YouTube playback for co-watching, and ML-powered background blur using MediaPipe. Authentication uses passwordless passkey-based sign-in alongside traditional email/password flows.

**Live:** https://watchtogether.lol | **API:** https://api.watchtogether.lol

## Features

- **P2P Video Calling** — WebRTC-based direct peer connections; no media servers
- **Screen Sharing** — Full-resolution screen share with adaptive bitrate encoding
- **Synced YouTube Co-watching** — Paste a YouTube link; both peers play in synchronized real time
- **Background Blur** — ML-powered background blur via MediaPipe (lazy-loaded, ~2MB)
- **Passkey Sign-In** — WebAuthn support for passwordless authentication; password fallback
- **Video Quality Adaptation** — Real-time bandwidth monitoring with non-disruptive quality changes
- **Perfect Negotiation** — WebRTC renegotiation resilience with glare handling
- **Email Verification** — Resend integration for account verification
- **Admin Panel** — Manage users, invitation slots, and demo requests
- **Security Hardening** — Rate limiting, CORS, CSP, HSTS, HttpOnly cookies, input validation

## Tech Stack

**Frontend**
- React 19 + TypeScript 5.9
- Vite (build & dev server)
- Tailwind CSS 4
- WebRTC Adapter (cross-browser polyfills)
- MediaPipe Vision (background blur)
- SimpleWebAuthn (passkey sign-in)
- SignalR client (@microsoft/signalr)
- Playwright (end-to-end tests)

**Backend**
- .NET 8 with ASP.NET Core
- SignalR (WebSocket signaling for WebRTC negotiation)
- MongoDB 7 (user accounts, sessions, invitations)
- JWT (stateless session tokens)
- Fido2.AspNet (passkey verification)
- BCrypt (password hashing)
- MongoDB.Driver 3.8

**Deployment**
- Fly.io (backend + frontend)
- MongoDB Atlas (database)
- Cloudflare Realtime TURN (ICE credentials)
- Resend (email service)
- Let's Encrypt TLS (auto-renewed)

## Getting Started

### Prerequisites

- **Node.js** 18+ (for frontend)
- **.NET 8 SDK** (for backend)
- **Docker & Docker Compose** (recommended for local development)
- **MongoDB** (local or Atlas)

### Environment Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/KutayOz/WatchTogether.git
   cd WatchTogether
   ```

2. **Copy the environment template:**
   ```bash
   cp .env.example .env
   ```

3. **Fill in required values in `.env`:**
   ```bash
   # Generate strong passwords
   MONGO_ROOT_PASSWORD=$(openssl rand -base64 32)
   JWT_SECRET=$(openssl rand -base64 32)
   
   # Update .env with these values
   ```

### Option A: Docker Compose (Recommended)

```bash
# Start all services (MongoDB, backend, frontend)
docker-compose up

# Frontend: http://localhost:3000
# Backend API: http://localhost:5001
```

### Option B: Manual Setup

**Backend:**
```bash
cd backend
dotnet build
dotnet run --project API
```
Backend runs on http://localhost:5000 by default.

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```
Frontend runs on http://localhost:5173 by default.

**Database:**
Either:
- Use MongoDB Atlas (set `MONGODB_CONNECTION_STRING` in `.env`)
- Or run a local container: `docker run -d -p 27017:27017 mongo:7`

### Verify Installation

```bash
# Health check
curl http://localhost:5001/api/health

# Should return: {"status":"healthy"}
```

## Architecture

### Backend Structure

```
backend/
├── API/
│   ├── Controllers/          # REST endpoints (Auth, Session, Passkey, Invitation)
│   ├── Hubs/                 # WatchTogetherHub (SignalR for WebRTC signaling)
│   └── Program.cs            # DI setup, middleware, rate limiting
├── Business/
│   ├── Services/             # Auth, Session, Passkey, Invitation, Email services
│   ├── DTOs/                 # Request/response objects
│   └── Models/               # Session, ICE Server, User DTOs
├── Data/
│   ├── Context/              # MongoDbContext
│   ├── Entities/             # User, Invitation, Passkey entities
│   └── Repositories/         # Data access layer
└── Tests/                    # Unit and integration tests
```

### Frontend Structure

```
frontend/src/
├── components/
│   ├── Session/              # SessionRoom, video/audio controls, screen share
│   ├── Chat/                 # Text messaging (during calls)
│   ├── Auth/                 # Login, signup, passkey registration
│   ├── Settings/             # Passkey manager
│   ├── Admin/                # Admin panel for root users
│   └── common/               # Shared UI components
├── services/
│   ├── api.ts                # REST client with Bearer auth
│   ├── signalRService.ts     # WebSocket handlers for WebRTC signaling
│   ├── webrtcService.ts      # RTCPeerConnection, track management
│   └── speedTestService.ts   # Network diagnostics
├── hooks/
│   ├── useWebRTC.ts
│   ├── useSignalR.ts
│   ├── useBackgroundBlur.ts  # MediaPipe integration
│   └── useMediaDevices.ts
├── context/
│   ├── AuthContext.ts
│   └── SessionContext.ts
└── e2e/                      # Playwright tests
```

### Communication Flow

1. **Authentication** — Email/password or passkey → JWT token (REST)
2. **Session Setup** — Create session, get ICE servers (REST)
3. **Signaling** — WebRTC offer/answer/ICE candidates (SignalR WebSocket)
4. **Media Streaming** — Video, audio, screen share (P2P via WebRTC)
5. **Data Channel** — Chat and metadata (WebRTC DataChannel)

## Tests

Run the end-to-end test suite with Playwright:

```bash
cd frontend

# Run all tests
npm run e2e

# Open interactive test UI
npm run e2e:ui
```

Tests cover:
- Authentication (email/password + passkey sign-in)
- Session creation and peer joining
- Video/audio streaming
- Screen share
- Chat messaging

## Roadmap

**Completed:**
- Peer-to-peer video calling
- Screen sharing with adaptive quality
- Synchronized YouTube playback
- Background blur (MediaPipe)
- Passkey authentication
- Email verification
- Admin panel
- Security hardening (rate limiting, CORS, CSP, HSTS)
- Cloudflare TURN integration
- Perfect negotiation for reliable renegotiation

**Planned:**
- 3+ peer multi-party calling
- Recording & playback
- Custom background images
- Chat history persistence
- Vanity session URLs
- Password reset flow
- Enhanced analytics
- Mobile app (React Native or Flutter)

## Deployment

### Deploy to Fly.io

**Backend:**
```bash
cd backend
fly deploy --app watchtogether-api
```

**Frontend:**
```bash
cd frontend
fly deploy --app watchtogether-web
```

See `DEPLOYMENT.md` for full production runbook, secret management, and troubleshooting.

## Development Commands

```bash
# Frontend linting
npm run lint

# TypeScript check
tsc -b

# Backend build
dotnet build

# Backend unit tests
dotnet test
```

## Security

- **Passkeys:** WebAuthn via Fido2.AspNet
- **Passwords:** BCrypt hashing (rounds: 12)
- **Tokens:** JWT with RS256 (25-char minimum secret)
- **CORS:** Strict origin allowlist
- **Rate Limiting:** 6 failed logins / minute → 429
- **Headers:** CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- **Cookies:** HttpOnly + Secure flags
- **SignalR:** Bearer token in header (not URL query)

## Contributing

This is a production project. Pull requests are welcome for:
- Bug fixes
- Performance improvements
- Security hardening
- New features (with tests)

Please ensure all tests pass before submitting.

## License

MIT License — see `LICENSE` for details.

---

Built with WebRTC, React 19, and .NET 8. Deployed on Fly.io with MongoDB Atlas.
