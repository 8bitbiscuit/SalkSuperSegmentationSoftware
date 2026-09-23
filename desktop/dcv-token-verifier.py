"""DCV external authenticator that accepts exactly one token: this session's.

The website puts the token in the desktop URL (?authToken=...), DCV posts it
here, and a match logs the browser in as the desktop user. dcv.conf points
auth-token-verifier at this server; systemd gives it DCV_TOKEN from
/etc/annotate/secrets.env.
"""
import hmac
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

TOKEN = os.environ["DCV_TOKEN"].encode()
SESSION = "annotate"
USER = "annotate"


class Verify(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        form = parse_qs(self.rfile.read(length).decode())
        given = form.get("authenticationToken", [""])[0].encode()
        ok = (form.get("sessionId", [""])[0] == SESSION
              and hmac.compare_digest(given, TOKEN))

        body = (f'<auth result="yes"><username>{USER}</username></auth>' if ok
                else '<auth result="no"><message>Invalid token</message></auth>')
        self.send_response(200)
        self.send_header("Content-Type", "text/xml")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, fmt, *args):
        pass  # one line per connection attempt adds nothing to the journal


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8444), Verify).serve_forever()
