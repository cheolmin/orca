#!/usr/bin/env node

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'

const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_CONNECTIONS = 32
const HEARTBEAT_MS = 15_000
const ATTACH_TIMEOUT_MS = 10_000

export async function startGateway({
  host = '127.0.0.1',
  port = 8787,
  route,
  secret,
  heartbeatMs = HEARTBEAT_MS,
  attachTimeoutMs = ATTACH_TIMEOUT_MS
}) {
  assertRoute(route)
  assertSecret(secret)

  let control = null
  let closed = false
  const pending = new Map()
  const active = new Set()
  const alive = new WeakSet()
  const httpServer = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok\n')
      return
    }
    response.writeHead(404)
    response.end()
  })
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_MESSAGE_BYTES
  })
  const routePath = encodeURIComponent(route)

  function track(socket) {
    alive.add(socket)
    socket.on('pong', () => alive.add(socket))
    socket.on('message', () => alive.add(socket))
    socket.on('error', () => {})
  }

  function closePending(reason) {
    for (const state of pending.values()) {
      clearTimeout(state.timer)
      state.mobile.close(1013, reason)
    }
    pending.clear()
  }

  function accept(request, socket, head, handler) {
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      track(webSocket)
      handler(webSocket)
    })
  }

  function acceptControl(request, socket, head) {
    if (!isAuthorized(request, secret)) {
      rejectUpgrade(socket, 401)
      return
    }
    accept(request, socket, head, (webSocket) => {
      closePending('desktop replaced')
      control?.terminate()
      control = webSocket
      webSocket.once('close', () => {
        if (control === webSocket) {
          control = null
          closePending('desktop offline')
        }
      })
    })
  }

  function acceptMobile(request, socket, head) {
    accept(request, socket, head, (mobile) => {
      if (control?.readyState !== WebSocket.OPEN) {
        mobile.close(1013, 'desktop offline')
        return
      }
      if (pending.size + active.size >= MAX_CONNECTIONS) {
        mobile.close(1013, 'relay capacity reached')
        return
      }

      const connectionId = randomUUID()
      const attachToken = randomBytes(32).toString('base64url')
      const frames = []
      let queuedBytes = 0
      const queueMessage = (data, isBinary) => {
        queuedBytes += rawDataBytes(data)
        if (queuedBytes > MAX_MESSAGE_BYTES) {
          mobile.close(1009, 'pre-attach queue exceeded')
          return
        }
        frames.push({ data, isBinary })
      }
      const timer = setTimeout(() => {
        pending.delete(connectionId)
        mobile.close(1013, 'desktop attach timeout')
      }, attachTimeoutMs)
      const state = {
        attachToken,
        attaching: false,
        frames,
        mobile,
        queueMessage,
        timer
      }
      pending.set(connectionId, state)
      mobile.on('message', queueMessage)
      mobile.once('close', () => {
        if (pending.delete(connectionId)) {
          clearTimeout(timer)
        }
      })
      control.send(JSON.stringify({ type: 'open', connectionId, attachToken }), (error) => {
        if (error && pending.delete(connectionId)) {
          clearTimeout(timer)
          mobile.close(1013, 'desktop control unavailable')
        }
      })
    })
  }

  function acceptAttach(request, socket, head, connectionId) {
    const state = pending.get(connectionId)
    if (!state || state.attaching || !isAuthorized(request, state.attachToken)) {
      rejectUpgrade(socket, 401)
      return
    }
    state.attaching = true
    accept(request, socket, head, (desktop) => {
      if (!pending.delete(connectionId) || state.mobile.readyState !== WebSocket.OPEN) {
        desktop.close(1008, 'mobile unavailable')
        return
      }
      clearTimeout(state.timer)
      state.mobile.off('message', state.queueMessage)
      let pair
      pair = bridgeWebSockets(state.mobile, desktop, state.frames, () => active.delete(pair))
      active.add(pair)
    })
  }

  httpServer.on('upgrade', (request, socket, head) => {
    if (closed) {
      rejectUpgrade(socket, 503)
      return
    }
    let pathname
    try {
      pathname = new URL(request.url ?? '/', 'http://relay.invalid').pathname
    } catch {
      rejectUpgrade(socket, 400)
      return
    }
    if (pathname === `/v1/desktop/${routePath}`) {
      acceptControl(request, socket, head)
      return
    }
    if (pathname === `/v1/connect/${routePath}`) {
      acceptMobile(request, socket, head)
      return
    }
    const attachPrefix = '/v1/attach/'
    if (pathname.startsWith(attachPrefix)) {
      acceptAttach(request, socket, head, pathname.slice(attachPrefix.length))
      return
    }
    rejectUpgrade(socket, 404)
  })

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate()
        continue
      }
      alive.delete(socket)
      socket.ping()
    }
  }, heartbeatMs)
  heartbeat.unref()

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('gateway did not bind a TCP port')
  }

  return {
    port: address.port,
    get desktopOnline() {
      return control?.readyState === WebSocket.OPEN
    },
    mobileEndpoint(publicBase = `ws://${host}:${address.port}`) {
      return endpoint(publicBase, `/v1/connect/${routePath}`)
    },
    async close() {
      if (closed) {
        return
      }
      closed = true
      clearInterval(heartbeat)
      closePending('gateway stopping')
      for (const pair of active) {
        pair.stop()
      }
      active.clear()
      control?.terminate()
      for (const socket of wss.clients) {
        socket.terminate()
      }
      await Promise.all([
        new Promise((resolve) => wss.close(() => resolve())),
        new Promise((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve()))
        )
      ])
    }
  }
}

export function startDesktopBridge({
  gateway,
  route,
  secret,
  local = 'ws://127.0.0.1:6768',
  reconnectMinMs = 250,
  reconnectMaxMs = 10_000,
  log = console.log
}) {
  assertRoute(route)
  assertSecret(secret)
  const gatewayUrl = websocketOrigin(gateway)
  const localUrl = websocketUrl(local)
  const controlUrl = endpoint(gatewayUrl, `/v1/desktop/${encodeURIComponent(route)}`)
  const connections = new Map()
  let control = null
  let reconnectTimer = null
  let reconnectAttempts = 0
  let stopped = false
  let markReady
  const ready = new Promise((resolve) => {
    markReady = resolve
  })

  async function openConnection({ connectionId, attachToken }) {
    if (connections.has(connectionId)) {
      return
    }
    const state = { local: null, remote: null, pair: null }
    const stop = () => {
      state.pair?.stop()
      state.local?.terminate()
      state.remote?.terminate()
      connections.delete(connectionId)
    }
    connections.set(connectionId, { stop })
    try {
      state.local = new WebSocket(localUrl, {
        perMessageDeflate: false,
        maxPayload: MAX_MESSAGE_BYTES
      })
      await waitForOpen(state.local)
      if (stopped) {
        stop()
        return
      }
      state.remote = new WebSocket(endpoint(gatewayUrl, `/v1/attach/${connectionId}`), {
        headers: { authorization: `Bearer ${attachToken}` },
        perMessageDeflate: false,
        maxPayload: MAX_MESSAGE_BYTES
      })
      const remoteFrames = []
      let queuedBytes = 0
      const queueRemoteMessage = (data, isBinary) => {
        queuedBytes += rawDataBytes(data)
        if (queuedBytes > MAX_MESSAGE_BYTES) {
          state.remote.close(1009, 'pre-bridge queue exceeded')
          return
        }
        remoteFrames.push({ data, isBinary })
      }
      state.remote.on('message', queueRemoteMessage)
      await waitForOpen(state.remote)
      if (stopped) {
        stop()
        return
      }
      state.remote.off('message', queueRemoteMessage)
      if (state.remote.readyState !== WebSocket.OPEN) {
        throw new Error('remote socket closed before bridge attached')
      }
      state.pair = bridgeWebSockets(state.remote, state.local, remoteFrames, () =>
        connections.delete(connectionId)
      )
    } catch (error) {
      log(`[mobile-relay] connection ${connectionId} failed: ${errorMessage(error)}`)
      stop()
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) {
      return
    }
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** reconnectAttempts)
    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectControl()
    }, delay)
  }

  function connectControl() {
    if (stopped) {
      return
    }
    const socket = new WebSocket(controlUrl, {
      headers: { authorization: `Bearer ${secret}` },
      perMessageDeflate: false,
      maxPayload: 64 * 1024
    })
    control = socket
    socket.once('open', () => {
      reconnectAttempts = 0
      markReady()
      log('[mobile-relay] desktop connected')
    })
    socket.on('message', (raw, isBinary) => {
      const message = isBinary ? null : parseOpenMessage(raw.toString())
      if (!message) {
        socket.close(1002, 'invalid control message')
        return
      }
      void openConnection(message)
    })
    socket.once('error', (error) => {
      log(`[mobile-relay] control error: ${errorMessage(error)}`)
      socket.terminate()
    })
    socket.once('close', () => {
      if (control === socket) {
        control = null
        scheduleReconnect()
      }
    })
  }

  connectControl()
  return {
    ready,
    stop() {
      if (stopped) {
        return
      }
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      control?.terminate()
      for (const connection of connections.values()) {
        connection.stop()
      }
      connections.clear()
    }
  }
}

function bridgeWebSockets(left, right, initialLeftFrames, onEnd) {
  let ended = false
  const forward = (destination) => (data, isBinary) => {
    if (destination.readyState !== WebSocket.OPEN) {
      end()
      return
    }
    destination.send(data, { binary: isBinary }, (error) => {
      if (error) {
        end()
      }
    })
  }
  const leftMessage = forward(right)
  const rightMessage = forward(left)
  const end = (source, destination, code, reason) => {
    if (ended) {
      return
    }
    ended = true
    left.off('message', leftMessage)
    right.off('message', rightMessage)
    if (destination) {
      relayClose(destination, code, reason)
    } else {
      left.terminate()
      right.terminate()
    }
    onEnd()
  }

  left.on('message', leftMessage)
  right.on('message', rightMessage)
  left.once('close', (code, reason) => end(left, right, code, reason))
  right.once('close', (code, reason) => end(right, left, code, reason))
  left.once('error', () => end(left, right))
  right.once('error', () => end(right, left))
  for (const frame of initialLeftFrames) {
    right.send(frame.data, { binary: frame.isBinary }, (error) => {
      if (error) {
        end()
      }
    })
  }
  return { stop: () => end() }
}

function relayClose(socket, code, reason) {
  if (socket.readyState !== WebSocket.OPEN) {
    socket.terminate()
    return
  }
  if (code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)) {
    socket.close(code, reason)
    return
  }
  socket.terminate()
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onClose = (code) => {
      cleanup()
      reject(new Error(`socket closed before open (${code})`))
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function parseOpenMessage(value) {
  let message
  try {
    message = JSON.parse(value)
  } catch {
    return null
  }
  return message?.type === 'open' &&
    typeof message.connectionId === 'string' &&
    /^[0-9a-f-]{36}$/.test(message.connectionId) &&
    typeof message.attachToken === 'string' &&
    message.attachToken.length >= 32
    ? message
    : null
}

function isAuthorized(request, token) {
  const actual = Buffer.from(String(request.headers.authorization ?? ''))
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function rejectUpgrade(socket, statusCode) {
  const statusText = {
    400: 'Bad Request',
    401: 'Unauthorized',
    404: 'Not Found',
    503: 'Service Unavailable'
  }[statusCode]
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
}

function rawDataBytes(data) {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  }
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}

function endpoint(base, pathname) {
  const url = new URL(base)
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url.toString()
}

function websocketOrigin(value) {
  const url = new URL(value)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('gateway must use http(s) or ws(s)')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('gateway must be an origin without a path, query, or fragment')
  }
  return url.origin
}

function websocketUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('local endpoint must use ws or wss')
  }
  return url.toString()
}

function assertRoute(route) {
  if (typeof route !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(route)) {
    throw new Error('route must be a 128-bit-or-stronger base64url value')
  }
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('secret must be at least 32 bytes')
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function parseArgs(values) {
  const args = {}
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument: ${name ?? ''}`)
    }
    args[name.slice(2)] = value
  }
  return args
}

async function main() {
  const [mode, ...values] = process.argv.slice(2)
  if (mode === 'key') {
    console.log(
      JSON.stringify({
        route: randomBytes(16).toString('base64url'),
        secret: randomBytes(32).toString('base64url')
      })
    )
    return
  }
  const args = parseArgs(values)
  const route = args.route ?? process.env.ORCA_RELAY_ROUTE
  const secret = args.secret ?? process.env.ORCA_RELAY_SECRET
  if (mode === 'gateway') {
    const gateway = await startGateway({
      host: args.host ?? '127.0.0.1',
      port: Number(args.port ?? 8787),
      route,
      secret
    })
    console.log(
      `[mobile-relay] gateway listening; mobile endpoint: ${gateway.mobileEndpoint(args['public-base'])}`
    )
    await waitForShutdown(() => gateway.close())
    return
  }
  if (mode === 'desktop') {
    const bridge = startDesktopBridge({
      gateway: args.gateway,
      local: args.local,
      route,
      secret
    })
    await bridge.ready
    await waitForShutdown(() => bridge.stop())
    return
  }
  throw new Error(
    'usage: mobile-reverse-relay.mjs key | gateway --route VALUE --secret VALUE [--host HOST --port PORT --public-base URL] | desktop --gateway URL --route VALUE --secret VALUE [--local URL]'
  )
}

function waitForShutdown(stop) {
  return new Promise((resolve) => {
    const shutdown = async () => {
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      await stop()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[mobile-relay] ${errorMessage(error)}`)
    process.exitCode = 1
  })
}
