import WebSocket, { type RawData } from 'ws'
import type { RelayBrokerStatus } from './relay/relay-session-broker'
import type { CustomMobileRelayConfig } from './custom-mobile-relay-config'
import {
  bridgeCustomMobileRelaySockets,
  createCustomMobileRelaySocket,
  customMobileRelayEndpoint,
  customMobileRelayLoopbackUrl,
  customMobileRelayRawDataBytes,
  waitForCustomMobileRelaySocket,
  type CustomMobileRelayQueuedFrame
} from './custom-mobile-relay-socket-bridge'

const MAX_MESSAGE_BYTES = 1024 * 1024
const CONTROL_MAX_MESSAGE_BYTES = 64 * 1024
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 30_000

type OpenMessage = {
  type: 'open'
  connectionId: string
  attachToken: string
}

export class CustomMobileRelayClient {
  private readonly config: CustomMobileRelayConfig
  private readonly localEndpoint: string
  private readonly onStatus: (status: RelayBrokerStatus) => void
  private readonly connections = new Map<string, () => void>()
  private control: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private stopped = true

  constructor(options: {
    config: CustomMobileRelayConfig
    localEndpoint: string
    onStatus: (status: RelayBrokerStatus) => void
  }) {
    this.config = options.config
    this.localEndpoint = customMobileRelayLoopbackUrl(options.localEndpoint)
    this.onStatus = options.onStatus
  }

  start(): void {
    if (!this.stopped) {
      return
    }
    this.stopped = false
    this.connectControl()
  }

  stop(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.control?.terminate()
    this.control = null
    for (const close of this.connections.values()) {
      close()
    }
    this.connections.clear()
    this.onStatus('offline')
  }

  private connectControl(): void {
    if (this.stopped) {
      return
    }
    this.onStatus('connecting')
    const control = new WebSocket(
      customMobileRelayEndpoint(
        this.config.gateway,
        `/v1/desktop/${encodeURIComponent(this.config.route)}`
      ),
      {
        headers: { authorization: `Bearer ${this.config.secret}` },
        perMessageDeflate: false,
        maxPayload: CONTROL_MAX_MESSAGE_BYTES
      }
    )
    this.control = control
    control.once('open', () => {
      if (this.control !== control || this.stopped) {
        control.terminate()
        return
      }
      this.reconnectAttempts = 0
      this.onStatus('registered')
    })
    control.on('message', (raw, isBinary) => {
      const message = isBinary ? null : parseOpenMessage(raw.toString())
      if (!message) {
        control.close(1002, 'invalid control message')
        return
      }
      void this.openConnection(message)
    })
    control.once('error', () => control.terminate())
    control.once('close', () => {
      if (this.control !== control) {
        return
      }
      this.control = null
      this.onStatus('offline')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectControl()
    }, delay)
    this.reconnectTimer.unref()
  }

  private async openConnection(message: OpenMessage): Promise<void> {
    if (this.stopped || this.connections.has(message.connectionId)) {
      return
    }
    let local: WebSocket | null = null
    let remote: WebSocket | null = null
    let closeBridge: (() => void) | null = null
    const close = (): void => {
      closeBridge?.()
      local?.terminate()
      remote?.terminate()
      this.connections.delete(message.connectionId)
    }
    this.connections.set(message.connectionId, close)
    try {
      local = createCustomMobileRelaySocket(this.localEndpoint)
      await waitForCustomMobileRelaySocket(local)
      if (this.stopped) {
        close()
        return
      }
      remote = createCustomMobileRelaySocket(
        customMobileRelayEndpoint(
          this.config.gateway,
          `/v1/attach/${encodeURIComponent(message.connectionId)}`
        ),
        message.attachToken
      )
      const queued: CustomMobileRelayQueuedFrame[] = []
      let queuedBytes = 0
      const queueMessage = (data: RawData, isBinary: boolean): void => {
        queuedBytes += customMobileRelayRawDataBytes(data)
        if (queuedBytes > MAX_MESSAGE_BYTES) {
          remote?.close(1009, 'pre-bridge queue exceeded')
          return
        }
        queued.push({ data, isBinary })
      }
      remote.on('message', queueMessage)
      await waitForCustomMobileRelaySocket(remote)
      remote.off('message', queueMessage)
      if (this.stopped || remote.readyState !== WebSocket.OPEN) {
        close()
        return
      }
      closeBridge = bridgeCustomMobileRelaySockets(remote, local, queued, () =>
        this.connections.delete(message.connectionId)
      )
    } catch {
      close()
    }
  }
}

function parseOpenMessage(value: string): OpenMessage | null {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
  return message.type === 'open' &&
    typeof message.connectionId === 'string' &&
    /^[0-9a-f-]{36}$/.test(message.connectionId) &&
    typeof message.attachToken === 'string' &&
    message.attachToken.length >= 32
    ? (message as OpenMessage)
    : null
}
