import { expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr') }
}))

import { registerMobileHandlers } from './mobile'

it('uses a configured custom relay endpoint without Orca Relay provisioning', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  const createMobilePairingOffer = vi.fn().mockResolvedValue({
    available: true,
    pairingUrl: 'orca://pair#custom',
    endpoint: 'wss://relay.example/v1/connect/route',
    deviceId: 'mobile-custom',
    connectionMode: 'local-only'
  })

  registerMobileHandlers(
    { createMobilePairingOffer } as never,
    { getCustomPairingEndpoint: () => 'wss://relay.example/v1/connect/route' }
  )
  await handlers.get('mobile:getPairingQR')?.(null, {
    address: '192.168.1.24',
    connectionMode: 'automatic'
  })

  expect(createMobilePairingOffer).toHaveBeenCalledWith(
    expect.objectContaining({
      address: 'wss://relay.example/v1/connect/route',
      connectionMode: 'local-only'
    })
  )
})
