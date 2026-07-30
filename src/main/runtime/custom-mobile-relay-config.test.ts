import { describe, expect, it } from 'vitest'
import { parseCustomMobileRelayConfig } from './custom-mobile-relay-config'

describe('parseCustomMobileRelayConfig', () => {
  it('builds the stock mobile endpoint from a trusted WSS origin', () => {
    expect(
      parseCustomMobileRelayConfig({
        v: 1,
        gateway: 'wss://relay.example.com',
        route: '0123456789012345678901',
        secret: '0123456789012345678901234567890123456789012'
      })
    ).toEqual({
      gateway: 'wss://relay.example.com',
      route: '0123456789012345678901',
      secret: '0123456789012345678901234567890123456789012',
      mobileEndpoint: 'wss://relay.example.com/v1/connect/0123456789012345678901'
    })
  })

  it('rejects insecure non-loopback gateways', () => {
    expect(() =>
      parseCustomMobileRelayConfig({
        v: 1,
        gateway: 'ws://relay.example.com',
        route: '0123456789012345678901',
        secret: '0123456789012345678901234567890123456789012'
      })
    ).toThrow('canonical wss origin')
  })
})
