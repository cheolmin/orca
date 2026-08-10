import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { startDesktopBridge, startGateway } from './mobile-reverse-relay.mjs'

export async function runRelayCheck() {
  const route = randomBytes(16).toString('base64url')
  const secret = randomBytes(32).toString('base64url')
  const localHttp = createServer()
  const local = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024
  })
  localHttp.on('upgrade', (request, socket, head) => {
    setTimeout(
      () =>
        local.handleUpgrade(request, socket, head, (webSocket) =>
          local.emit('connection', webSocket, request)
        ),
      50
    )
  })
  await new Promise((resolve, reject) => {
    localHttp.once('error', reject)
    localHttp.listen(0, '127.0.0.1', () => {
      localHttp.off('error', reject)
      resolve()
    })
  })
  const localAddress = localHttp.address()
  assert.notEqual(typeof localAddress, 'string')
  assert.ok(localAddress)
  local.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
  })

  let gateway = await startGateway({ port: 0, route, secret })
  const gatewayPort = gateway.port
  const bridge = startDesktopBridge({
    gateway: `ws://127.0.0.1:${gateway.port}`,
    local: `ws://127.0.0.1:${localAddress.port}`,
    route,
    secret,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    log: () => {}
  })
  let mobile
  try {
    await withTimeout(bridge.ready, 2_000, 'desktop bridge did not connect')
    mobile = new WebSocket(gateway.mobileEndpoint())
    await once(mobile, 'open')

    const textReply = nextMessage(mobile)
    mobile.send('queued-before-desktop-attach')
    const [text, textIsBinary] = await withTimeout(textReply, 2_000, 'text reply timed out')
    assert.equal(textIsBinary, false)
    assert.equal(text.toString(), 'queued-before-desktop-attach')

    const payload = randomBytes(1024 * 1024)
    const binaryReply = nextMessage(mobile)
    mobile.send(payload)
    const [binary, binaryIsBinary] = await withTimeout(
      binaryReply,
      2_000,
      'binary reply timed out'
    )
    assert.equal(binaryIsBinary, true)
    assert.deepEqual(binary, payload)

    const oversizedClose = once(mobile, 'close')
    mobile.send(randomBytes(1024 * 1024 + 1))
    const [oversizedCode] = await withTimeout(
      oversizedClose,
      2_000,
      'oversized message was not rejected'
    )
    assert.equal(oversizedCode, 1009)

    await gateway.close()
    gateway = await startGateway({ port: gatewayPort, route, secret })
    await waitUntil(() => gateway.desktopOnline, 2_000, 'desktop bridge did not reconnect')
    mobile = new WebSocket(gateway.mobileEndpoint())
    await once(mobile, 'open')
    const reconnectReply = nextMessage(mobile)
    mobile.send('after-gateway-restart')
    const [reconnected] = await withTimeout(reconnectReply, 2_000, 'reconnect reply timed out')
    assert.equal(reconnected.toString(), 'after-gateway-restart')
  } finally {
    mobile?.terminate()
    bridge.stop()
    await gateway.close()
    for (const socket of local.clients) {
      socket.terminate()
    }
    await Promise.all([
      new Promise((resolve) => local.close(resolve)),
      new Promise((resolve, reject) =>
        localHttp.close((error) => (error ? reject(error) : resolve()))
      )
    ])
  }
}

function nextMessage(socket) {
  return new Promise((resolve) => socket.once('message', (data, isBinary) => resolve([data, isBinary])))
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
