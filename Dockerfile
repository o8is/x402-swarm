FROM node:20

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Install tsx for running TypeScript
RUN npm install -g tsx

# Copy source
COPY index.ts README.md tsconfig.json ./

# Create directory for secrets (will be mounted as volume)
RUN mkdir -p /data

# Set working directory for secrets file
ENV NODE_ENV=production

EXPOSE 4021

# Run with tsx
CMD ["tsx", "index.ts"]
