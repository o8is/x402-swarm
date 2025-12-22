import { readFileSync } from "fs";
import { join } from "path";
import swaggerJsdoc, { type Options } from "swagger-jsdoc";

const swaggerOptions: Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "x402 Swarm Storage API",
      version: "2.0.0",
      description: "A decentralized storage service powered by Swarm and x402 payments.",
    },
    servers: [
      {
        url: "https://x402.o8.is",
        description: "Production Server",
      },
    ],
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "PAYMENT-SIGNATURE",
          description: "x402 Payment Signature Header (v2)",
        },
      },
    },
    security: [
      {
        x402: [],
      },
    ],
  },
  apis: ["./index.ts"],
};

function buildDescription(): string {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  return readme.split("\n").slice(1).join("\n");
}

export function buildSwaggerSpec() {
  const description = buildDescription();

  return swaggerJsdoc({
    ...swaggerOptions,
    definition: {
      ...swaggerOptions.definition,
      info: {
        ...(swaggerOptions.definition?.info || {}),
        description,
      },
    },
  });
}

export { swaggerOptions };
