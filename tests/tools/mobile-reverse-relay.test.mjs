import { test } from 'vitest'
import { runRelayCheck } from './mobile-reverse-relay-check.mjs'

test('relays Orca frames and recovers after a gateway restart', runRelayCheck)
