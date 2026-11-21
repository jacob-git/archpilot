import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectedLanguage, DetectedStack, ScannedFile } from './types.js';

async function readIfExists(rootDir: string, relPath: string): Promise<string> {
  try {
    return await readFile(path.join(rootDir, relPath), 'utf8');
  } catch {
    return '';
  }
}

export async function detectStack(
  rootDir: string,
  files: ScannedFile[],
  fileSet: Set<string>,
  packageJson?: Record<string, unknown>
): Promise<DetectedStack> {
  const languages = new Set<DetectedLanguage>();
  const frameworks = new Set<string>();
  const capabilities = new Set<'rest-api' | 'ai-llm' | 'mcp'>();

  for (const f of files) {
    if (f.ext === '.ts' || f.ext === '.tsx') languages.add('typescript');
    else if (f.ext === '.js' || f.ext === '.jsx' || f.ext === '.mjs' || f.ext === '.cjs')
      languages.add('javascript');
    else if (f.ext === '.java') languages.add('java');
    else if (f.ext === '.py') languages.add('python');
    else if (f.ext === '.go') languages.add('go');
    else if (f.ext === '.rs') languages.add('rust');
  }

  // 1. Node / TypeScript / JS manifests
  if (packageJson) {
    const allDeps = {
      ...(typeof packageJson.dependencies === 'object' && packageJson.dependencies !== null
        ? (packageJson.dependencies as Record<string, unknown>)
        : {}),
      ...(typeof packageJson.devDependencies === 'object' && packageJson.devDependencies !== null
        ? (packageJson.devDependencies as Record<string, unknown>)
        : {}),
    };
    const depNames = Object.keys(allDeps);
    const hasDep = (name: string) => depNames.includes(name);

    if (hasDep('next')) {
      frameworks.add('Next.js');
      capabilities.add('rest-api');
    }
    if (hasDep('react')) frameworks.add('React');
    if (hasDep('vite')) frameworks.add('Vite');
    if (hasDep('@nestjs/core')) {
      frameworks.add('NestJS');
      capabilities.add('rest-api');
    }
    if (hasDep('express')) {
      frameworks.add('Express');
      capabilities.add('rest-api');
    }
    if (hasDep('fastify')) {
      frameworks.add('Fastify');
      capabilities.add('rest-api');
    }
    if (hasDep('hono')) {
      frameworks.add('Hono');
      capabilities.add('rest-api');
    }
    if (
      hasDep('openai') ||
      hasDep('@anthropic-ai/sdk') ||
      hasDep('@google/genai') ||
      hasDep('@google/generative-ai') ||
      hasDep('langchain') ||
      hasDep('ai')
    ) {
      capabilities.add('ai-llm');
    }
    if (hasDep('@modelcontextprotocol/sdk')) {
      capabilities.add('mcp');
    }
  }

  // 2. Java / Spring Boot manifests
  const javaManifests = files.filter(
    (f) =>
      f.relPath.endsWith('pom.xml') ||
      f.relPath.endsWith('build.gradle') ||
      f.relPath.endsWith('build.gradle.kts')
  );
  for (const mf of javaManifests.slice(0, 5)) {
    const content = await readIfExists(rootDir, mf.relPath);
    if (/spring-boot/i.test(content)) {
      frameworks.add('Spring Boot');
      capabilities.add('rest-api');
    }
    if (/spring-ai|openai|langchain4j/i.test(content)) {
      capabilities.add('ai-llm');
    }
    if (/modelcontextprotocol|spring-ai-mcp/i.test(content)) {
      capabilities.add('mcp');
    }
  }

  // 3. Python manifests
  const pyManifest =
    (await readIfExists(rootDir, 'pyproject.toml')) +
    '\n' +
    (await readIfExists(rootDir, 'requirements.txt'));
  if (pyManifest.trim()) {
    if (/\bfastapi\b/i.test(pyManifest)) {
      frameworks.add('FastAPI');
      capabilities.add('rest-api');
    }
    if (/\bdjango\b/i.test(pyManifest)) {
      frameworks.add('Django');
      capabilities.add('rest-api');
    }
    if (/\bflask\b/i.test(pyManifest)) {
      frameworks.add('Flask');
      capabilities.add('rest-api');
    }
    if (/\b(openai|anthropic|google-genai|langchain|llama-index)\b/i.test(pyManifest)) {
      capabilities.add('ai-llm');
    }
    if (/\b(mcp|fastmcp)\b/i.test(pyManifest)) {
      capabilities.add('mcp');
    }
  }

  // 4. Go manifest
  if (fileSet.has('go.mod')) {
    const goMod = await readIfExists(rootDir, 'go.mod');
    if (/gin-gonic|labstack\/echo|gofiber\/fiber|go-chi\/chi/i.test(goMod)) {
      frameworks.add('Go Web API');
      capabilities.add('rest-api');
    }
    if (/openai|anthropic|generative-ai-go/i.test(goMod)) {
      capabilities.add('ai-llm');
    }
    if (/mcp-go|modelcontextprotocol/i.test(goMod)) {
      capabilities.add('mcp');
    }
  }

  // 5. Rust manifest
  if (fileSet.has('Cargo.toml')) {
    const cargo = await readIfExists(rootDir, 'Cargo.toml');
    if (/\b(axum|actix-web|rocket|warp)\b/i.test(cargo)) {
      frameworks.add('Rust Web API');
      capabilities.add('rest-api');
    }
    if (/\b(async-openai|rig-core|anthropic)\b/i.test(cargo)) {
      capabilities.add('ai-llm');
    }
    if (/\b(rmcp|mcp)\b/i.test(cargo)) {
      capabilities.add('mcp');
    }
  }

  // 6. MCP config files or OpenAPI specs
  if (fileSet.has('.vscode/mcp.json') || fileSet.has('.cursor/mcp.json')) {
    capabilities.add('mcp');
  }
  if (
    files.some((f) =>
      /(?:^|\/)(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(f.relPath)
    )
  ) {
    capabilities.add('rest-api');
  }

  return {
    languages: Array.from(languages),
    frameworks: Array.from(frameworks),
    capabilities: Array.from(capabilities),
  };
}
