import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MqttAuthorizer } from '../src/mqtt-auth'
import type { Store } from '../src/store'

function fixture() {
  const credential = {
    gateway_sn: 'controller-a',
    username: 'gw_controller-a',
    password_hash: '',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    revoked: false,
  }
  let aircraft: string[] = ['matrice-4t-a']
  let unavailable: string[] = []
  const store = {
    findGatewayCredentialByUsername: async (username: string) =>
      username === credential.username ? credential : null,
    aircraftSnsForGateway: async () => aircraft,
    // Enrolment approval is the second gate; these tests exercise the topic rules.
    isControllerApproved: async () => true,
    // A disabled or deleted aircraft is refused at the broker, not just by the API.
    deviceUnavailable: async (sn: string) => unavailable.includes(sn),
  } as unknown as Store
  const authorizer = new MqttAuthorizer(store)
  return {
    credential,
    authorize: (sn: string, topic: string, action: string) =>
      authorizer.authorize(credential.username, `thing/product/${sn}/${topic}`, action),
    authorizeSys: (sn: string, topic: string, action: string) =>
      authorizer.authorize(credential.username, `sys/product/${sn}/${topic}`, action),
    setAircraft: (sns: string[]) => {
      aircraft = sns
    },
    setUnavailable: (sns: string[]) => {
      unavailable = sns
    },
  }
}

test('Pilot 2 can subscribe to linked Matrice 4T services and return command replies', async () => {
  const { authorize } = fixture()
  for (const sn of ['controller-a', 'matrice-4t-a']) {
    for (const topic of [
      'services',
      'requests_reply',
      'events_reply',
      'state_reply',
      'property/set',
      'drc/down',
    ]) {
      assert.equal(await authorize(sn, topic, 'subscribe'), true, `${sn}/${topic}`)
    }
    for (const topic of [
      'osd',
      'state',
      'events',
      'services_reply',
      'property/set_reply',
      'drc/up',
    ]) {
      assert.equal(await authorize(sn, topic, 'publish'), true, `${sn}/${topic}`)
    }
  }
})

test('system replies and network probes allow the controller and linked aircraft only', async () => {
  const { authorizeSys, setAircraft } = fixture()
  for (const sn of ['controller-a', 'matrice-4t-a']) {
    assert.equal(await authorizeSys(sn, 'network/probe', 'subscribe'), true)
    assert.equal(await authorizeSys(sn, 'network/probe', 'publish'), false)
    assert.equal(await authorizeSys(sn, 'status_reply', 'subscribe'), true)
  }
  for (const sn of ['controller-b', 'matrice-4t-b', '+', '#']) {
    assert.equal(await authorizeSys(sn, 'network/probe', 'subscribe'), false)
    assert.equal(await authorizeSys(sn, 'status_reply', 'subscribe'), false)
  }
  assert.equal(await authorizeSys('matrice-4t-a', 'status', 'publish'), false)
  setAircraft([])
  assert.equal(await authorizeSys('matrice-4t-a', 'network/probe', 'subscribe'), false)
})

test('aircraft permissions still reject other devices, wildcards and wrong directions', async () => {
  const { authorize } = fixture()
  for (const sn of ['controller-b', 'matrice-4t-b', '+', '#']) {
    assert.equal(await authorize(sn, 'services', 'subscribe'), false)
    assert.equal(await authorize(sn, 'osd', 'publish'), false)
  }
  assert.equal(await authorize('matrice-4t-a', '#', 'subscribe'), false)
  assert.equal(await authorize('matrice-4t-a', 'services', 'publish'), false)
  assert.equal(await authorize('matrice-4t-a', 'osd', 'subscribe'), false)
})

test('topology changes take effect immediately, including first aircraft discovery', async () => {
  const { authorize, setAircraft } = fixture()
  setAircraft([])
  assert.equal(await authorize('matrice-4t-a', 'services', 'subscribe'), false)
  setAircraft(['matrice-4t-a'])
  assert.equal(await authorize('matrice-4t-a', 'services', 'subscribe'), true)
  setAircraft(['matrice-4t-b'])
  assert.equal(await authorize('matrice-4t-a', 'services', 'subscribe'), false)
  assert.equal(await authorize('matrice-4t-b', 'services', 'subscribe'), true)
})

test('revoked and expired controller credentials cannot access aircraft topics', async () => {
  const { authorize, credential } = fixture()
  credential.revoked = true
  assert.equal(await authorize('matrice-4t-a', 'services', 'subscribe'), false)
  credential.revoked = false
  credential.expires_at = new Date(Date.now() - 1_000).toISOString()
  assert.equal(await authorize('matrice-4t-a', 'services', 'subscribe'), false)
})

test('a disabled or deleted aircraft is refused at the broker, but its gateway still works', async () => {
  const { authorize, setUnavailable } = fixture()
  assert.equal(await authorize('matrice-4t-a', 'osd', 'publish'), true)
  assert.equal(await authorize('matrice-4t-a', 'services', 'subscribe'), true)

  setUnavailable(['matrice-4t-a'])
  assert.equal(await authorize('matrice-4t-a', 'osd', 'publish'), false)
  assert.equal(await authorize('matrice-4t-a', 'services', 'subscribe'), false)
  // The gateway's own topics stay open: it must still announce topology, which is how the
  // aircraft reappears after a re-enable.
  assert.equal(await authorize('controller-a', 'osd', 'publish'), true)
  assert.equal(await authorize('controller-a', 'services', 'subscribe'), true)

  setUnavailable([])
  assert.equal(await authorize('matrice-4t-a', 'osd', 'publish'), true)
})
