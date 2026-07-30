import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile } from '../../shared/secure-file'

export const CUSTOM_MOBILE_RELAY_CONFIG_FILENAME = 'orca-mobile-relay.json'
const MAX_CONFIG_BYTES = 16 * 1024
const ROUTE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/

export type CustomMobileRelayConfig = {
  gateway: string
  route: string
  secret: string
  mobileEndpoint: string
}

export function loadCustomMobileRelayConfig(userDataPath: string): CustomMobileRelayConfig | null {
  const configPath = join(userDataPath, CUSTOM_MOBILE_RELAY_CONFIG_FILENAME)
  if (!existsSync(configPath)) {
    return null
  }
  try {
    hardenExistingSecureFile(configPath)
    if (statSync(configPath).size > MAX_CONFIG_BYTES) {
      throw new Error('config is too large')
    }
    return parseCustomMobileRelayConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch (error) {
    console.warn(
      '[custom-mobile-relay] Ignoring invalid config:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

export function parseCustomMobileRelayConfig(value: unknown): CustomMobileRelayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be an object')
  }
  const config = value as Record<string, unknown>
  if (config.v !== 1) {
    throw new Error('unsupported config version')
  }
  const gateway = canonicalWebSocketOrigin(config.gateway)
  if (typeof config.route !== 'string' || !ROUTE_PATTERN.test(config.route)) {
    throw new Error('route must be a 128-bit-or-stronger base64url value')
  }
  if (typeof config.secret !== 'string' || !SECRET_PATTERN.test(config.secret)) {
    throw new Error('secret must be a 256-bit-or-stronger base64url value')
  }
  return {
    gateway,
    route: config.route,
    secret: config.secret,
    mobileEndpoint: endpoint(gateway, `/v1/connect/${encodeURIComponent(config.route)}`)
  }
}

function canonicalWebSocketOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('gateway must be a WebSocket origin')
  }
  const url = new URL(value)
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (
    url.origin !== value ||
    (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))
  ) {
    throw new Error('gateway must be a canonical wss origin')
  }
  return url.origin
}

function endpoint(origin: string, pathname: string): string {
  const url = new URL(origin)
  url.pathname = pathname
  return url.toString()
}
