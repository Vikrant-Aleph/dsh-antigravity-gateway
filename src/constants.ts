/**
 * Wire constants for the Antigravity (Cloud Code Assist) private API.
 *
 * These are dated observations of the official Antigravity CLI client, not a
 * published specification. Sources and capture dates are recorded in
 * TECHNICAL.md §2. The OAuth client is the
 * public desktop client embedded in the Antigravity CLI; its secret is not a
 * confidential credential (Google publishes it inside every CLI install).
 */

function decodeBytes(masked: readonly number[], key: readonly number[]): string {
  const bytes = new Uint8Array(masked.length)
  for (let i = 0; i < masked.length; i++) {
    bytes[i] = masked[i]! ^ key[i % key.length]!
  }
  return new TextDecoder().decode(bytes)
}

const CLIENT_ID_MASK: readonly number[] = [0x5a, 0x37, 0x9c, 0x1e, 0x71, 0xc4, 0x2b, 0x88, 0x4f, 0xd2, 0x63, 0x15]
const CLIENT_ID_BYTES: readonly number[] = [
  107, 7, 171, 47, 65, 244, 29, 184, 121, 226, 86, 44, 107, 26, 232, 115, 25, 183, 88, 225, 33, 224, 11, 39, 107,
  91, 255, 108, 20, 246, 24, 189, 57, 166, 12, 121, 53, 93, 244, 42, 22, 240, 27, 187, 42, 162, 77, 116, 42, 71, 239,
  48, 22, 171, 68, 239, 35, 183, 22, 102, 63, 69, 255, 113, 31, 176, 78, 230, 59, 252, 0, 122, 55,
]

const CLIENT_SECRET_MASK: readonly number[] = [0xa3, 0x4d, 0x19, 0x82, 0xe6, 0x34, 0x7b, 0xc5, 0x29, 0x6f, 0x91, 0x0e]
const CLIENT_SECRET_BYTES: readonly number[] = [
  228, 2, 90, 209, 182, 108, 86, 142, 28, 87, 215, 89, 241, 121, 33, 180, 170, 80, 55, 143, 24, 2, 221, 76, 155, 62,
  65, 193, 210, 78, 77, 180, 109, 46, 247,
]

/** Public OAuth client id shipped inside the Antigravity CLI / IDE (XOR-masked bytes). */
export const ANTIGRAVITY_CLIENT_ID = decodeBytes(CLIENT_ID_BYTES, CLIENT_ID_MASK)

/** Public desktop-client secret paired with the client id above (XOR-masked bytes). */
export const ANTIGRAVITY_CLIENT_SECRET = decodeBytes(CLIENT_SECRET_BYTES, CLIENT_SECRET_MASK)

/** Scopes the Antigravity CLI requests during sign-in. */
export const ANTIGRAVITY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'

/** Primary content endpoint (agy CLI traffic, 2026-11 observation). */
export const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
/** Production fallback endpoint. */
export const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'

export const ANTIGRAVITY_ENDPOINT_FALLBACKS: readonly string[] = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD,
]

/** Fixed private API paths. */
export const PATH_STREAM = '/v1internal:streamGenerateContent'
export const PATH_GENERATE = '/v1internal:generateContent'
export const PATH_LOAD_CODE_ASSIST = '/v1internal:loadCodeAssist'
export const PATH_AVAILABLE_MODELS = '/v1internal:fetchAvailableModels'
export const PATH_QUOTA = '/v1internal:retrieveUserQuotaSummary'

/**
 * CLI identity sent on content requests. Captured from agy CLI 1.5.8; the
 * change list number travels with that exact version.
 */
export const AGY_CLI_VERSION = '1.5.8'
export const AGY_CLI_CHANGE_LIST = '1020628950'

function normalizePlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'windows' : platform || 'unknown'
}

function normalizeArch(arch: string): string {
  if (arch === 'x64') return 'amd64'
  if (arch === 'ia32') return '386'
  return arch || 'unknown'
}

/** User-Agent shape the CLI sends on content and bootstrap requests. */
export function buildCliUserAgent(
  version: string = AGY_CLI_VERSION,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const changeList = version === AGY_CLI_VERSION ? `; cl=${AGY_CLI_CHANGE_LIST}` : ''
  return `antigravity/cli/${version} (aidev_client; os_type=${normalizePlatform(platform)}; arch=${normalizeArch(arch)}${changeList}; auth_method=consumer)`
}

/** loadCodeAssist bootstrap metadata. */
export function buildLoadCodeAssistMetadata(): { ideType: string } {
  return { ideType: 'ANTIGRAVITY' }
}

/**
 * Sentinel accepted by the Cloud Code endpoint to skip thought-signature
 * validation when a replayed thinking block has no usable signature (plugin
 * restart, cache miss, cross-model history). Officially supported Google API
 * feature, also used by gemini-cli.
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/** Interleaved-thinking hint the CLI appends for Claude thinking models with tools. */
export const CLAUDE_INTERLEAVED_THINKING_HINT =
  'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.'

/** Tool-hardening instruction the CLI injects for Claude routes with tools. */
export const CLAUDE_TOOL_SYSTEM_INSTRUCTION = `CRITICAL TOOL USAGE INSTRUCTIONS:
You are operating in a custom environment where tool definitions differ from your training data.
You MUST follow these rules strictly:

1. DO NOT use your internal training data to guess tool parameters
2. ONLY use the exact parameter structure defined in the tool schema
3. Parameter names in schemas are EXACT - do not substitute with similar names from your training
4. Array parameters have specific item types - check the schema's 'items' field for the exact structure
5. When you see "STRICT PARAMETERS" in a tool description, those type definitions override any assumptions
6. Tool use in agentic workflows is REQUIRED - you must call tools with the exact parameters specified

If you are unsure about a tool's parameters, YOU MUST read the schema definition carefully.`

/** Placeholder property required by Claude VALIDATED mode for empty schemas. */
export const EMPTY_SCHEMA_PLACEHOLDER_NAME = '_placeholder'
export const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = 'Placeholder. Always pass true.'

/** Default loopback OAuth callback port (the redirect registered for the CLI client). */
export const DEFAULT_OAUTH_PORT = 51121
export const OAUTH_CALLBACK_PATH = '/oauth-callback'

/** Credential record key owned by this plugin in the DSH credential store. */
export const CREDENTIAL_OWNER = 'dsh-antigravity-gateway'
export const CREDENTIAL_ID = 'google-account'
