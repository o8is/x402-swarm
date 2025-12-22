import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { stringify as yamlStringify } from "yaml";
import { buildSwaggerSpec } from "../swagger.js";

const outputDir = join(process.cwd(), "public");
mkdirSync(outputDir, { recursive: true });

const spec = buildSwaggerSpec();

const jsonPath = join(outputDir, "openapi.json");
writeFileSync(jsonPath, JSON.stringify(spec, null, 2));

const yamlPath = join(outputDir, "openapi.yaml");
writeFileSync(yamlPath, yamlStringify(spec));

console.log(`OpenAPI spec generated:\n- ${jsonPath}\n- ${yamlPath}`);
