// Service Worker for the VODopad mtcute probe.
//
// It does not know where bytes come from. For every request to `__stream/<id>`
// it asks the page that owns the stream (over a MessageChannel) for the
// requested byte range and answers the <video> element with a 206 response.
// The page reads the bytes from Telegram (mtcute) or over plain HTTP (control).
//
// Plain JS on purpose: a Service Worker must be a single file at the scope root.

const SW_VERSION = 'probe-1'
const REPLY_TIMEOUT_MS = 45000

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version' && event.ports[0]) {
    event.ports[0].postMessage({ version: SW_VERSION })
  }
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.pathname.endsWith('/__ping')) {
    event.respondWith(new Response('pong ' + SW_VERSION, { headers: { 'x-vodopad-sw': SW_VERSION } }))
    return
  }
  const match = url.pathname.match(/\/__stream\/([^/]+)/)
  if (!match) return
  event.respondWith(handleStream(event, decodeURIComponent(match[1])))
})

function parseRange(header) {
  // "bytes=START-" or "bytes=START-END"; suffix ranges ("bytes=-N") are not used by media elements.
  if (!header) return { start: 0, end: null, hadRange: false }
  const m = /bytes=(\d+)-(\d*)/.exec(header)
  if (!m) return { start: 0, end: null, hadRange: false }
  return { start: Number(m[1]), end: m[2] === '' ? null : Number(m[2]), hadRange: true }
}

async function ownerClients(event) {
  // A media element's request usually carries the page as clientId, but not in every engine,
  // so fall back to every controlled window and let the owner of the stream answer.
  const out = []
  if (event.clientId) {
    const c = await self.clients.get(event.clientId)
    if (c) out.push(c)
  }
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const c of all) if (!out.includes(c)) out.push(c)
  return out
}

function askClient(client, payload) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), REPLY_TIMEOUT_MS)
    channel.port1.onmessage = (e) => {
      clearTimeout(timer)
      resolve(e.data)
    }
    client.postMessage(payload, [channel.port2])
  })
}

async function handleStream(event, streamId) {
  const range = parseRange(event.request.headers.get('range'))
  const clients = await ownerClients(event)
  const payload = {
    type: 'vodopad-range',
    streamId,
    start: range.start,
    end: range.end,
    hadRange: range.hadRange,
    clientIdPresent: !!event.clientId,
  }
  let reply = { ok: false, error: 'no-client' }
  for (const client of clients) {
    reply = await askClient(client, payload)
    if (reply.ok || reply.error !== 'unknown-stream') break
  }
  if (!reply.ok) {
    if (reply.error === 'range-not-satisfiable') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${reply.size}` } })
    }
    return new Response('stream error: ' + reply.error, { status: 502 })
  }
  const body = reply.data
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': reply.mime || 'video/mp4',
      'Content-Length': String(body.byteLength),
      'Content-Range': `bytes ${reply.start}-${reply.end}/${reply.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}
