import { SolariClient } from '@solarisdk/sdk'

/**
 * A demo target, hosted in a Solari sandbox and exposed on a public URL.
 *
 * It exists because delivery cannot be verified against localhost: the browser
 * doing the auditing runs on Solari's infrastructure, so a sink on your laptop
 * is unreachable to it and to any form backend. The sandbox solves that — it is
 * the same product, and `previewUrl` hands back a real public address.
 *
 * It serves two forms that are identical to a visitor:
 *   /good    records the lead, then says thank you
 *   /silent  says thank you, and records nothing
 *
 * `/silent` is the whole point. It answers HTTP 200 and shows a confirmation,
 * so uptime checks and status-code checks both call it healthy.
 */
export type Fixture = {
  /**
   * Build a URL for a path on the fixture.
   *
   * Not string concatenation: `previewUrl` returns an address that already
   * carries a `?pt_token=` query string, so appending "/good" to it lands the
   * path after the query and the request 404s.
   */
  urlFor(path: string): string
  seen(token: string): Promise<boolean>
  stop(): Promise<void>
}

const PORT = 3000

const SERVER_PY = `
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

SEEN = set()

PAGE = """<!doctype html><meta charset="utf-8"><title>Contacto</title>
<h1>Contacto</h1>
<form method="post" action="ACTION">
  <label>Nombre <input name="nombre" required></label>
  <label>Correo <input type="email" name="correo" required></label>
  <input name="_gotcha" style="display:none">
  <label>Mensaje <textarea name="mensaje" required></textarea></label>
  <button type="submit">Enviar</button>
</form>"""

DONE = """<!doctype html><meta charset="utf-8"><title>Listo</title>
<h1>Gracias, mensaje enviado</h1>"""

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/good":
            self._send(200, PAGE.replace("ACTION", "/good"))
        elif path == "/silent":
            self._send(200, PAGE.replace("ACTION", "/silent"))
        elif path == "/seen":
            token = (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
            self._send(200, "yes" if token in SEEN else "no")
        else:
            self._send(404, "not found")

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        # /good delivers. /silent drops the lead and lies about it.
        if path == "/good":
            for match in re.findall(r"SLPA-[A-Z0-9-]+", body.upper()):
                SEEN.add(match)
        self._send(200, DONE)

    def log_message(self, *args):
        pass

HTTPServer(("0.0.0.0", PORTNUM), Handler).serve_forever()
`.replace('PORTNUM', String(PORT))

export async function startFixture(apiKey: string): Promise<Fixture> {
  const client = new SolariClient({ apiKey })
  const sandbox = await client.sandboxes.create({
    template: 'base',
    timeoutMs: 10 * 60_000,
  })
  await sandbox.connect()
  await sandbox.files.write('/tmp/fixture.py', SERVER_PY)

  // Background it with a shell — `commands.run` waits for the process to exit,
  // so a foreground server would block until the idle timeout.
  await sandbox.commands.run('sh', {
    args: ['-c', 'nohup python3 /tmp/fixture.py >/dev/null 2>&1 &'],
  })

  const { url } = await sandbox.previewUrl(PORT)

  const urlFor = (path: string) => {
    const u = new URL(url)
    u.pathname = path
    return u.toString()
  }

  let ready = false
  for (let attempt = 0; attempt < 20 && !ready; attempt++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      ready = (await fetch(urlFor('/good'))).ok
    } catch {
      // preview routing is not up yet
    }
  }
  if (!ready) {
    await sandbox.kill()
    throw new Error(`fixture never became reachable at ${urlFor('/good')}`)
  }

  return {
    urlFor,
    seen: async (token) => {
      const u = new URL(url)
      u.pathname = '/seen'
      u.searchParams.set('token', token)
      const res = await fetch(u.toString())
      return (await res.text()).trim() === 'yes'
    },
    stop: () => sandbox.kill(),
  }
}
