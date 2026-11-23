#!/usr/bin/env node
/**
 * Checks the encrypted RTMP (RTMPS) ingest from the outside, the way an acceptance test would:
 *
 *   node tools/docker/rtmps-check.mjs fleet.example.com [port]
 *
 * It opens a TLS connection, prints the protocol, cipher and certificate, then performs the RTMP handshake
 * inside the TLS session. If the media server answers, the whole path (TLS in Nginx, then plain RTMP to SRS)
 * works, and everything sent after this point, video and stream key included, travels encrypted.
 * It never publishes anything, so it needs no stream key and leaves nothing behind.
 */
import { randomBytes } from 'node:crypto'
import tls from 'node:tls'

const host = process.argv[2]
const port = Number(process.argv[3] ?? 1936)
if (!host) {
  console.error('usage: node tools/docker/rtmps-check.mjs <host> [port]')
  process.exit(2)
}

const socket = tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' })
socket.setTimeout(15_000, () => fail('timed out'))
socket.on('error', (error) => fail(error.message))

let received = Buffer.alloc(0)

function fail(message) {
  console.error(`FAILED: ${message}`)
  socket.destroy()
  process.exit(1)
}

socket.on('secureConnect', () => {
  const cert = socket.getPeerCertificate()
  const cipher = socket.getCipher()
  console.log(`TLS         ${socket.getProtocol()}  ${cipher.name}`)
  console.log(
    `Certificate ${cert.subject?.CN ?? '?'}  issuer ${cert.issuer?.O ?? cert.issuer?.CN ?? '?'}  valid to ${cert.valid_to}`,
  )
  console.log(`Trusted     ${socket.authorized ? 'yes' : `NO (${socket.authorizationError})`}`)
  if (!socket.authorized) fail('the certificate is not trusted')
  // RTMP handshake: C0 (version 3) then C1 (time, zero, 1528 random bytes).
  const c1 = Buffer.concat([Buffer.alloc(8), randomBytes(1528)])
  socket.write(Buffer.concat([Buffer.from([3]), c1]))
})

socket.on('data', (chunk) => {
  received = Buffer.concat([received, chunk])
  // S0 (1 byte) + S1 (1536) + S2 (1536, an echo of our C1).
  if (received.length >= 1 + 1536 + 1536) {
    if (received[0] !== 3) fail(`not an RTMP server (first byte ${received[0]})`)
    console.log('RTMP        handshake completed inside TLS: the media server answered')
    console.log('RESULT      RTMPS ingest works')
    socket.end()
    process.exit(0)
  }
})
