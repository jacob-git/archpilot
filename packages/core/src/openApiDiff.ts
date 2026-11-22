import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { loadConfig } from './config.js';
import { scanWorkspace } from './scanner.js';
import type { Severity } from './types.js';

const execFileAsync = promisify(execFile);

export interface OpenApiBreakingChange {
  file: string;
  ruleId:
    | 'openapi-path-removed'
    | 'openapi-method-removed'
    | 'openapi-success-response-removed'
    | 'openapi-schema-removed'
    | 'openapi-schema-property-removed'
    | 'openapi-schema-required-added';
  severity: Severity;
  message: string;
  suggestion: string;
}

export interface OpenApiDiffReport {
  rootDir: string;
  specsChecked: number;
  comparedAgainst: string;
  breakingChanges: OpenApiBreakingChange[];
  addedEndpoints: string[];
}

interface ParsedOperation {
  responses: Set<string>;
}

interface ParsedSchema {
  required: Set<string>;
  properties: Set<string>;
}

interface ParsedSpec {
  paths: Map<string, Map<string, ParsedOperation>>;
  schemas: Map<string, ParsedSchema>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

function parseJsonSpec(raw: string): ParsedSpec | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const paths = new Map<string, Map<string, ParsedOperation>>();
  const schemas = new Map<string, ParsedSchema>();

  const rawPaths = obj.paths;
  if (rawPaths && typeof rawPaths === 'object') {
    for (const [pKey, pathVal] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (!pathVal || typeof pathVal !== 'object') continue;
      const methods = new Map<string, ParsedOperation>();
      for (const [mKey, opVal] of Object.entries(pathVal as Record<string, unknown>)) {
        const lower = mKey.toLowerCase();
        if (!HTTP_METHODS.has(lower) || !opVal || typeof opVal !== 'object') continue;
        const responses = new Set<string>();
        const rawRes = (opVal as Record<string, unknown>).responses;
        if (rawRes && typeof rawRes === 'object') {
          for (const code of Object.keys(rawRes as Record<string, unknown>)) {
            responses.add(code);
          }
        }
        methods.set(lower, { responses });
      }
      paths.set(pKey, methods);
    }
  }

  const rawSchemas =
    ((obj.components as Record<string, unknown> | undefined)?.schemas as Record<string, unknown> | undefined) ??
    (obj.definitions as Record<string, unknown> | undefined);
  if (rawSchemas && typeof rawSchemas === 'object') {
    for (const [sName, sVal] of Object.entries(rawSchemas)) {
      if (!sVal || typeof sVal !== 'object') continue;
      const sObj = sVal as Record<string, unknown>;
      const required = new Set<string>(
        Array.isArray(sObj.required)
          ? sObj.required.filter((x): x is string => typeof x === 'string')
          : []
      );
      const properties = new Set<string>(
        sObj.properties && typeof sObj.properties === 'object'
          ? Object.keys(sObj.properties as Record<string, unknown>)
          : []
      );
      schemas.set(sName, { required, properties });
    }
  }

  return { paths, schemas };
}

function unquote(val: string): string {
  const t = val.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseYamlSpec(raw: string): ParsedSpec {
  const paths = new Map<string, Map<string, ParsedOperation>>();
  const schemas = new Map<string, ParsedSchema>();
  const lines = raw.split(/\r?\n/);

  let section: 'none' | 'paths' | 'components' | 'schemas' = 'none';
  let currentPath: string | undefined;
  let pathIndent = -1;
  let currentMethod: string | undefined;
  let methodIndent = -1;
  let inResponses = false;
  let responsesIndent = -1;

  let schemasIndent = -1;
  let currentSchema: string | undefined;
  let schemaIndent = -1;
  let schemaSub: 'none' | 'required' | 'properties' = 'none';
  let schemaSubIndent = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      currentPath = undefined;
      currentMethod = undefined;
      inResponses = false;
      currentSchema = undefined;
      schemaSub = 'none';
      if (/^paths\s*:/.test(trimmed)) {
        section = 'paths';
      } else if (/^components\s*:/.test(trimmed)) {
        section = 'components';
      } else if (/^definitions\s*:/.test(trimmed)) {
        section = 'schemas';
        schemasIndent = 0;
      } else {
        section = 'none';
      }
      continue;
    }

    if (section === 'paths') {
      const keyMatch = /^(['"]?\/[^:'"]+['"]?)\s*:/.exec(trimmed);
      if (keyMatch && (pathIndent === -1 || indent <= pathIndent)) {
        pathIndent = indent;
        currentPath = unquote(keyMatch[1]);
        if (!paths.has(currentPath)) paths.set(currentPath, new Map());
        currentMethod = undefined;
        inResponses = false;
        continue;
      }
      if (currentPath && indent > pathIndent) {
        const mMatch = /^([a-zA-Z]+)\s*:/.exec(trimmed);
        if (mMatch && HTTP_METHODS.has(mMatch[1].toLowerCase()) && (methodIndent === -1 || indent <= methodIndent)) {
          methodIndent = indent;
          currentMethod = mMatch[1].toLowerCase();
          paths.get(currentPath)!.set(currentMethod, { responses: new Set() });
          inResponses = false;
          continue;
        }
        if (currentMethod && indent > methodIndent) {
          if (/^responses\s*:/.test(trimmed)) {
            inResponses = true;
            responsesIndent = indent;
            continue;
          }
          if (inResponses) {
            if (indent <= responsesIndent) {
              inResponses = false;
            } else {
              const codeMatch = /^['"]?([1-5][0-9]{2}|default)['"]?\s*:/.exec(trimmed);
              if (codeMatch) {
                paths.get(currentPath)!.get(currentMethod)!.responses.add(codeMatch[1]);
              }
            }
          }
        }
      }
      continue;
    }

    if (section === 'components') {
      if (/^schemas\s*:/.test(trimmed)) {
        section = 'schemas';
        schemasIndent = indent;
        schemaIndent = -1;
      }
      continue;
    }

    if (section === 'schemas') {
      if (indent <= schemasIndent) {
        section = 'components';
        currentSchema = undefined;
        schemaSub = 'none';
        continue;
      }
      const sKeyMatch = /^([a-zA-Z0-9_.-]+)\s*:/.exec(trimmed);
      if (sKeyMatch && (schemaIndent === -1 || indent <= schemaIndent)) {
        schemaIndent = indent;
        currentSchema = sKeyMatch[1];
        if (!schemas.has(currentSchema)) {
          schemas.set(currentSchema, { required: new Set(), properties: new Set() });
        }
        schemaSub = 'none';
        continue;
      }
      if (currentSchema && indent > schemaIndent) {
        if (/^required\s*:/.test(trimmed)) {
          schemaSub = 'required';
          schemaSubIndent = indent;
          // Handle inline required: [a, b]
          const inlineArr = /\[([^\]]+)\]/.exec(trimmed);
          if (inlineArr) {
            for (const item of inlineArr[1].split(',')) {
              const name = unquote(item);
              if (name) schemas.get(currentSchema)!.required.add(name);
            }
            schemaSub = 'none';
          }
          continue;
        }
        if (/^properties\s*:/.test(trimmed)) {
          schemaSub = 'properties';
          schemaSubIndent = indent;
          continue;
        }
        if (schemaSub === 'required') {
          if (indent <= schemaSubIndent) {
            schemaSub = 'none';
          } else {
            const listMatch = /^-\s+(.+)$/.exec(trimmed);
            if (listMatch) {
              schemas.get(currentSchema)!.required.add(unquote(listMatch[1]));
            }
          }
        } else if (schemaSub === 'properties') {
          if (indent <= schemaSubIndent) {
            schemaSub = 'none';
          } else if (indent === schemaSubIndent + 2) {
            const propMatch = /^(['"]?[a-zA-Z0-9_.-]+['"]?)\s*:/.exec(trimmed);
            if (propMatch) {
              schemas.get(currentSchema)!.properties.add(unquote(propMatch[1]));
            }
          }
        }
      }
    }
  }

  return { paths, schemas };
}

function parseOpenApiSpec(raw: string): ParsedSpec {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{')) {
    return parseJsonSpec(raw) ?? { paths: new Map(), schemas: new Map() };
  }
  return parseYamlSpec(raw);
}

export function diffOpenApiSpecs(
  oldSpecRaw: string,
  newSpecRaw: string,
  filePath: string
): { breakingChanges: OpenApiBreakingChange[]; addedEndpoints: string[] } {
  const oldSpec = parseOpenApiSpec(oldSpecRaw);
  const newSpec = parseOpenApiSpec(newSpecRaw);
  const breakingChanges: OpenApiBreakingChange[] = [];
  const addedEndpoints: string[] = [];

  for (const [pKey, oldMethods] of oldSpec.paths.entries()) {
    const newMethods = newSpec.paths.get(pKey);
    if (!newMethods) {
      breakingChanges.push({
        file: filePath,
        ruleId: 'openapi-path-removed',
        severity: 'error',
        message: `Endpoint path "${pKey}" was removed.`,
        suggestion: 'Deprecate the path or bump the API major version instead of removing it.',
      });
      continue;
    }

    for (const [method, oldOp] of oldMethods.entries()) {
      const newOp = newMethods.get(method);
      if (!newOp) {
        breakingChanges.push({
          file: filePath,
          ruleId: 'openapi-method-removed',
          severity: 'error',
          message: `HTTP method "${method.toUpperCase()} ${pKey}" was removed.`,
          suggestion: 'Keep the operation with deprecated: true until consumers migrate.',
        });
        continue;
      }

      for (const code of oldOp.responses) {
        if (code.startsWith('2') && !newOp.responses.has(code)) {
          breakingChanges.push({
            file: filePath,
            ruleId: 'openapi-success-response-removed',
            severity: 'error',
            message: `Success response "${code}" was removed from ${method.toUpperCase()} ${pKey}.`,
            suggestion: 'Preserve existing 2xx response contracts for backward compatibility.',
          });
        }
      }
    }
  }

  for (const [pKey, newMethods] of newSpec.paths.entries()) {
    const oldMethods = oldSpec.paths.get(pKey);
    for (const method of newMethods.keys()) {
      if (!oldMethods || !oldMethods.has(method)) {
        addedEndpoints.push(`${method.toUpperCase()} ${pKey}`);
      }
    }
  }

  for (const [sName, oldSchema] of oldSpec.schemas.entries()) {
    const newSchema = newSpec.schemas.get(sName);
    if (!newSchema) {
      breakingChanges.push({
        file: filePath,
        ruleId: 'openapi-schema-removed',
        severity: 'error',
        message: `Schema "${sName}" was removed.`,
        suggestion: 'Retain the schema or version it to avoid breaking generated SDK clients.',
      });
      continue;
    }

    for (const prop of oldSchema.properties) {
      if (!newSchema.properties.has(prop)) {
        breakingChanges.push({
          file: filePath,
          ruleId: 'openapi-schema-property-removed',
          severity: 'warning',
          message: `Property "${prop}" was removed from schema "${sName}".`,
          suggestion: 'Mark the field deprecated before removing it from API payloads.',
        });
      }
    }

    for (const req of newSchema.required) {
      if (!oldSchema.required.has(req)) {
        breakingChanges.push({
          file: filePath,
          ruleId: 'openapi-schema-required-added',
          severity: 'error',
          message: `New required field "${req}" was added to schema "${sName}".`,
          suggestion: 'Make new fields optional with a safe server-side default to avoid breaking existing clients.',
        });
      }
    }
  }

  return { breakingChanges, addedEndpoints };
}

async function gitShowFile(rootDir: string, ref: string, relPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${relPath}`], {
      cwd: rootDir,
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

function isOpenApiContent(raw: string): boolean {
  return /(^|\n)\s*["']?(openapi|swagger)["']?\s*:/i.test(raw.slice(0, 1500));
}

export async function analyzeOpenApiBreakingChanges(rootDir: string): Promise<OpenApiDiffReport> {
  const { config } = await loadConfig(rootDir);
  const files = await scanWorkspace(rootDir, config.ignore);
  const candidates = files.filter(
    (f) => (f.ext === '.yml' || f.ext === '.yaml' || f.ext === '.json') && f.sizeBytes <= 500_000
  );

  const breakingChanges: OpenApiBreakingChange[] = [];
  const addedEndpoints: string[] = [];
  let specsChecked = 0;
  let comparedAgainst = 'HEAD';

  for (const file of candidates) {
    let currentRaw: string;
    try {
      currentRaw = await readFile(file.absPath, 'utf8');
    } catch {
      continue;
    }
    if (!isOpenApiContent(currentRaw)) continue;
    specsChecked += 1;

    let baselineRaw = await gitShowFile(rootDir, 'HEAD', file.relPath);
    if (baselineRaw === currentRaw) {
      const mainRaw =
        (await gitShowFile(rootDir, 'main', file.relPath)) ??
        (await gitShowFile(rootDir, 'master', file.relPath));
      if (mainRaw && mainRaw !== currentRaw) {
        baselineRaw = mainRaw;
        comparedAgainst = 'main';
      }
    }
    if (!baselineRaw || baselineRaw === currentRaw) continue;

    const diff = diffOpenApiSpecs(baselineRaw, currentRaw, file.relPath);
    breakingChanges.push(...diff.breakingChanges);
    addedEndpoints.push(...diff.addedEndpoints);
  }

  return {
    rootDir,
    specsChecked,
    comparedAgainst,
    breakingChanges,
    addedEndpoints,
  };
}
