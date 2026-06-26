# Build stage
FROM node:20.18.0-alpine AS build
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build args for environment variables
ARG VITE_API_URL=http://localhost:5000
ARG VITE_SIGNALR_URL=http://localhost:5000/hubs/watchtogether

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SIGNALR_URL=$VITE_SIGNALR_URL

# Build the app
RUN npm run build

# Runtime stage with nginx (unprivileged image runs as non-root UID 101 on port 8080)
FROM nginxinc/nginx-unprivileged:1.27.3-alpine AS runtime

# Copy nginx config template
COPY --chown=nginx:nginx nginx.conf.template /etc/nginx/templates/default.conf.template

# Copy built assets
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

# nginx-unprivileged binds to 8080 by default (non-root cannot bind <1024)
ENV PORT=8080
# CSP requires the backend host (overridden via fly.toml or docker-compose env)
ENV BACKEND_HOST=localhost:5000

EXPOSE 8080

# nginx docker image automatically runs envsubst on templates
CMD ["nginx", "-g", "daemon off;"]
