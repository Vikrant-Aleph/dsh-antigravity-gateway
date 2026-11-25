/**
 * Tool-parameter JSON Schema projection onto the Antigravity Schema proto
 * subset, plus tool-name sanitization and empty-schema placeholder injection.
 */
import { isRecord } from '../shared/guards.js'
import { EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION, EMPTY_SCHEMA_PLACEHOLDER_NAME } from './constants.js'

export function sanitizeToolName(name: string): string {
  const cleaned = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned.length > 0 ? cleaned : 'tool'
}

export function parameterSignature(parameters: Record<string, unknown>): string {
  const properties = isRecord(parameters.properties) ? parameters.properties : {}
  const entries = Object.entries(properties).map(([name, schema]) => {
    const type = isRecord(schema) && typeof schema.type === 'string' ? schema.type : 'any'
    return `${name}: ${type}`
  })
  return entries.join(', ')
}

/**
 * Schema keywords the endpoint's Schema proto accepts. Anything else is
 * dropped: the proto JSON parser rejects unknown fields with
 * `Invalid JSON payload received. Unknown name …` (HTTP 400), so JSON Schema
 * vocabulary beyond this subset must never reach the wire.
 */
const SCHEMA_KEEP = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'oneOf', 'anyOf', 'minItems', 'maxItems', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'additionalProperties', 'propertyOrdering',
])

/**
 * Recursively project one JSON Schema onto the endpoint's subset.
 * `const` becomes a single-value `enum` (same semantics, accepted keyword);
 * metadata and unsupported structural keywords are dropped.
 */
export function sanitizeToolSchema(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (key === 'const') {
      out.enum = [val]
      continue
    }
    if (!SCHEMA_KEEP.has(key)) continue
    if (key === 'properties' && isRecord(val)) {
      const properties: Record<string, unknown> = {}
      for (const [name, schema] of Object.entries(val)) {
        const cleaned = sanitizeToolSchema(schema)
        if (cleaned !== undefined) properties[name] = cleaned
      }
      out.properties = properties
    } else if (key === 'items') {
      // The proto carries a single items schema; tuple forms keep the first.
      const cleaned = Array.isArray(val) ? sanitizeToolSchema(val[0]) : sanitizeToolSchema(val)
      if (cleaned !== undefined) out.items = cleaned
    } else if ((key === 'oneOf' || key === 'anyOf') && Array.isArray(val)) {
      out[key] = val.map((branch) => sanitizeToolSchema(branch)).filter((branch) => branch !== undefined)
    } else if (key === 'additionalProperties' && isRecord(val)) {
      const cleaned = sanitizeToolSchema(val)
      if (cleaned !== undefined) out.additionalProperties = cleaned
    } else if (key === 'enum' && Array.isArray(val)) {
      out.enum = val
    } else if (key === 'required' && Array.isArray(val)) {
      out.required = val.filter((item) => typeof item === 'string')
    } else {
      out[key] = val
    }
  }
  return out
}

export function normalizeToolParameters(schema: unknown): Record<string, unknown> {
  const cleaned: Record<string, unknown> = sanitizeToolSchema(schema) ?? {}
  cleaned.type = 'object'
  const properties = isRecord(cleaned.properties) ? cleaned.properties : undefined
  if (!properties || Object.keys(properties).length === 0) {
    cleaned.properties = {
      [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
        type: 'boolean',
        description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
      },
    }
    cleaned.required = Array.isArray(cleaned.required)
      ? Array.from(new Set([...(cleaned.required as unknown[]).filter((item) => typeof item === 'string'), EMPTY_SCHEMA_PLACEHOLDER_NAME]))
      : [EMPTY_SCHEMA_PLACEHOLDER_NAME]
  }
  return cleaned
}
