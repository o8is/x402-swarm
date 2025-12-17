.PHONY: generate compose akash clean dev build

# Generate both compose.yaml and deploy.yaml from score.yaml
generate: compose akash

# Generate docker-compose for local development
compose:
	@if [ ! -d .score-compose ]; then score-compose init; fi
	score-compose generate score.yaml --publish 4021:x402-swarm:4021 -o compose.yaml

# Generate Akash SDL for deployment
akash:
	score-akash generate -f score.yaml -o deploy.yaml

# Clean generated files
clean:
	rm -rf .score-compose compose.yaml deploy.yaml

# Run locally with docker-compose (builds from local Dockerfile)
dev:
	@if [ ! -d .score-compose ]; then score-compose init; fi
	score-compose generate score.yaml --publish 4021:x402-swarm:4021 --build=app=. -o compose.yaml
	docker compose up --build

# Build docker image for linux/amd64 (deployment target)
build:
	docker build --platform linux/amd64 -t ghcr.io/o8is/x402-swarm:latest .
