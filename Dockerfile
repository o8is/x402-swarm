FROM node:20

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install ALL dependencies (including dev for build)
RUN npm ci

# Copy all source files (relies on .dockerignore to exclude secrets)
COPY . .

# Build UI and OpenAPI spec
RUN npm run build

# Prune dev dependencies
RUN npm prune --production && npm cache clean --force

# Install tsx for running TypeScript
RUN npm install -g tsx

# Create directory for secrets (will be mounted as volume)
RUN mkdir -p /data

# Set working directory for secrets file
ENV NODE_ENV=production

EXPOSE 4021

# Run with tsx
CMD ["tsx", "index.ts"]
