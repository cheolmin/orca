#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import nacl from 'tweetnacl'
import WebSocket from 'ws'

const TIMEOUT_MS = 15_000

export async function checkLiveMobileRelay({
  endpoint,
  userData = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Orca')
}) {
  const pairing = await loadPairing(endpoint, userData)
  const socket = new WebSocket(pairing.endpoint, {
    perMessageDeflate: false,
    maxPayload: 1024 * 1024
  })
  const nextMessage = createMessageReader(socket)
  try {
    await waitForOpen(socket)
    const ephemeral = nacl.box.keyPair()
    const serverPublicKey = Buffer.from(pairing.publicKeyB64, 'base64')
    if (serverPublicKey.byteLength !== nacl.box.publicKeyLength) {
      throw new Error('invalid Orca server public key')
    }
    const sharedKey = nacl.box.before(serverPublicKey, ephemeral.secretKey)
    socket.send(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(ephemeral.publicKey).toString('base64')
      })
    )

    const ready = JSON.parse(await nextText(nextMessage))
    if (ready.type !== 'e2ee_ready') {
      throw new Error(`unexpected handshake response: ${String(ready.type)}`)
    }
    socket.send(encryptJson({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }, sharedKey))
    const authenticated = decryptJson(await nextText(nextMessage), sharedKey)
    if (authenticated.type !== 'e2ee_authenticated') {
      throw new Error(`mobile authentication failed: ${String(authenticated.type)}`)
    }

    const requestId = `live-check-${Date.now()}`
    socket.send(
      encryptJson(
        {
          id: requestId,
          deviceToken: pairing.deviceToken,
          method: 'host.platform',
          params: null
        },
        sharedKey
      )
    )
    const response = decryptJson(await nextText(nextMessage), sharedKey)
    if (response.id !== requestId || response.ok !== true || response.result?.platform !== 'win32') {
      throw new Error(`unexpected host.platform response: ${JSON.stringify(response)}`)
    }
    return {
      ok: true,
      authenticated: true,
      rpc: 'host.platform',
      platform: response.result.platform,
      pairingUrl: pairing.pairingUrl
    }
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, 'live check complete')
    } else {
      socket.terminate()
    }
  }
}

async function loadPairing(endpoint, userData) {
  const [devicesJson, keypairJson] = await Promise.all([
    readFile(path.join(userData, 'orca-devices.json'), 'utf8'),
    readFile(path.join(userData, 'orca-e2ee-keypair.json'), 'utf8')
  ])
  const devices = JSON.parse(devicesJson)
  const keypair = JSON.parse(keypairJson)
  const device =
    devices.find((candidate) => candidate.scope === 'mobile' && candidate.lastSeenAt === 0) ??
    devices.find((candidate) => candidate.scope === 'mobile')
  if (!device?.token || typeof keypair.publicKeyB64 !== 'string') {
    throw new Error('Orca mobile pairing credential is unavailable')
  }
  const offer = {
    v: 2,
    endpoint: websocketUrl(endpoint),
    deviceToken: device.token,
    publicKeyB64: keypair.publicKeyB64,
    scope: 'mobile'
  }
  return {
    ...offer,
    pairingUrl: `orca://pair?code=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`
  }
}

function createMessageReader(socket) {
  const queued = []
  const waiters = []
  let failure = null
  socket.on('message', (data, isBinary) => {
    const message = { data, isBinary }
    const waiter = waiters.shift()
    if (waiter) {
      waiter.resolve(message)
    } else {
      queued.push(message)
    }
  })
  const fail = (error) => {
    failure = error
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error)
    }
  }
  socket.once('error', fail)
  socket.once('close', (code) => fail(new Error(`socket closed (${code})`)))
  return () => {
    if (queued.length > 0) {
      return Promise.resolve(queued.shift())
    }
    if (failure) {
      return Promise.reject(failure)
    }
    return withTimeout(
      new Promise((resolve, reject) => waiters.push({ resolve, reject })),
      TIMEOUT_MS,
      'timed out waiting for Orca'
    )
  }
}

async function nextText(nextMessage) {
  const message = await nextMessage()
  if (message.isBinary) {
    throw new Error('expected a text frame')
  }
  return message.data.toString()
}

function encryptJson(value, sharedKey) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const plaintext = Buffer.from(JSON.stringify(value))
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey)
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]).toString('base64')
}

function decryptJson(value, sharedKey) {
  const bundle = Buffer.from(value, 'base64')
  const nonce = bundle.subarray(0, nacl.box.nonceLength)
  const ciphertext = bundle.subarray(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)
  if (!plaintext) {
    throw new Error('failed to decrypt Orca response')
  }
  return JSON.parse(Buffer.from(plaintext).toString('utf8'))
}

function waitForOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    }),
    TIMEOUT_MS,
    'timed out opening public relay'
  )
}

function websocketUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('pairing endpoint must use ws or wss')
  }
  return url.toString()
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

async function main() {
  const endpoint = process.env.ORCA_PUBLIC_MOBILE_ENDPOINT
  if (!endpoint) {
    throw new Error('ORCA_PUBLIC_MOBILE_ENDPOINT is required')
  }
  const result = await checkLiveMobileRelay({ endpoint })
  console.log(
    JSON.stringify({
      ok: result.ok,
      authenticated: result.authenticated,
      rpc: result.rpc,
      platform: result.platform,
      pairingUrlReady: true
    })
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[mobile-relay-check] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
