import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { CustomMobileRelayClient } from './custom-mobile-relay-client'
import type { CustomMobileRelayConfig } from './custom-mobile-relay-config'

describe('CustomMobileRelayClient', () => {
  const servers: WebSocketServer[] = []
  const clients: CustomMobileRelayClient[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop()
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) {
              socket.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
  })

  it('opens outbound control and attach sockets and preserves frame types', async () => {
    const route = randomBytes(16).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    const attachToken = randomBytes(32).toString('base64url')
    const connectionId = randomUUID()
    const local = createEchoServer()
    const gateway = new WebSocketServer({ port: 0, perMessageDeflate: false })
    servers.push(local, gateway)
    await Promise.all([once(local, 'listening'), once(gateway, 'listening')])
    const localPort = tcpPort(local)
    const gatewayPort = tcpPort(gateway)
    const received: Array<{ data: RawData; isBinary: boolean }> = []
    let resolveFrames: (() => void) | null = null
    const frames = new Promise<void>((resolve) => {
      resolveFrames = resolve
    })

    gateway.on('connection', (socket, request) => {
      if (request.url === `/v1/desktop/${route}`) {
        expect(request.headers.authorization).toBe(`Bearer ${secret}`)
        socket.send(JSON.stringify({ type: 'open', connectionId, attachToken }))
        return
      }
      expect(request.url).toBe(`/v1/attach/${connectionId}`)
      expect(request.headers.authorization).toBe(`Bearer ${attachToken}`)
      socket.on('message', (data, isBinary) => {
        received.push({ data, isBinary })
        if (received.length === 2) {
          resolveFrames?.()
        }
      })
      socket.send('hello')
      socket.send(randomBytes(1024), { binary: true })
    })

    const statuses = vi.fn()
    const config: CustomMobileRelayConfig = {
      gateway: `ws://127.0.0.1:${gatewayPort}`,
      route,
      secret,
      mobileEndpoint: `ws://127.0.0.1:${gatewayPort}/v1/connect/${route}`
    }
    const client = new CustomMobileRelayClient({
      config,
      localEndpoint: `ws://0.0.0.0:${localPort}`,
      onStatus: statuses
    })
    clients.push(client)
    client.start()

    await frames

    expect(statuses).toHaveBeenCalledWith('registered')
    expect(received[0]?.isBinary).toBe(false)
    expect(received[0]?.data.toString()).toBe('hello')
    expect(received[1]?.isBinary).toBe(true)
    const binary = received[1]?.data
    expect(Buffer.isBuffer(binary)).toBe(true)
    if (!Buffer.isBuffer(binary)) {
      throw new Error('expected a binary Buffer')
    }
    expect(binary.byteLength).toBe(1024)
  })
})

function createEchoServer(): WebSocketServer {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  server.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
  })
  return server
}

function tcpPort(server: WebSocketServer): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP WebSocket server')
  }
  return address.port
}
