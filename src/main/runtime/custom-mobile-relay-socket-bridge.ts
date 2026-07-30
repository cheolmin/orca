import WebSocket, { type RawData } from 'ws'

const MAX_MESSAGE_BYTES = 1024 * 1024
const CONNECT_TIMEOUT_MS = 10_000

export type CustomMobileRelayQueuedFrame = {
  data: RawData
  isBinary: boolean
}

export function createCustomMobileRelaySocket(url: string, token?: string): WebSocket {
  return new WebSocket(url, {
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    perMessageDeflate: false,
    maxPayload: MAX_MESSAGE_BYTES
  })
}

export function bridgeCustomMobileRelaySockets(
  left: WebSocket,
  right: WebSocket,
  queued: readonly CustomMobileRelayQueuedFrame[],
  onEnd: () => void
): () => void {
  let ended = false
  const forward =
    (destination: WebSocket) =>
    (data: RawData, isBinary: boolean): void => {
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
  const end = (destination?: WebSocket, code?: number, reason?: Buffer): void => {
    if (ended) {
      return
    }
    ended = true
    left.off('message', leftMessage)
    right.off('message', rightMessage)
    if (destination) {
      if (code !== undefined) {
        relayClose(destination, code, reason)
      } else {
        destination.terminate()
      }
    } else {
      left.terminate()
      right.terminate()
    }
    onEnd()
  }
  left.on('message', leftMessage)
  right.on('message', rightMessage)
  left.once('close', (code, reason) => end(right, code, reason))
  right.once('close', (code, reason) => end(left, code, reason))
  left.once('error', () => end(right))
  right.once('error', () => end(left))
  for (const frame of queued) {
    right.send(frame.data, { binary: frame.isBinary }, (error) => {
      if (error) {
        end()
      }
    })
  }
  return () => end()
}

export function waitForCustomMobileRelaySocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      socket.terminate()
      reject(new Error('socket open timeout'))
    }, CONNECT_TIMEOUT_MS)
    timer.unref()
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (code: number): void => {
      cleanup()
      reject(new Error(`socket closed before open (${code})`))
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

export function customMobileRelayEndpoint(origin: string, pathname: string): string {
  const url = new URL(origin)
  url.pathname = pathname
  return url.toString()
}

export function customMobileRelayLoopbackUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('local endpoint must use ws or wss')
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    url.hostname = '127.0.0.1'
  }
  return url.toString()
}

export function customMobileRelayRawDataBytes(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  }
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}

function relayClose(socket: WebSocket, code: number, reason?: Buffer): void {
  if (socket.readyState !== WebSocket.OPEN) {
    socket.terminate()
    return
  }
  if (code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)) {
    socket.close(code, reason?.toString())
    return
  }
  socket.terminate()
}
