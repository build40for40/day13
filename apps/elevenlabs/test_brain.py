"""Synthetic Day 13 brain for testing the ElevenLabs voice loop."""

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NOTES = {
    ("launch", "demo"): "The sample launch plan is to show a 30-second voice demo on Friday.",
    ("gift", "gifts", "christmas"): "The sample gift idea was a build-your-own robot kit.",
    ("inbox", "filing", "mind dump"): "The sample inbox plan is to capture ideas by voice and file them automatically.",
}


class BrainHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # Keep spoken questions and request details out of the demo logs.
        pass

    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/ask":
            return self.reply(404, {"error": "Unknown endpoint."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192:
                return self.reply(400, {"error": "Send a JSON body of up to 8192 bytes."})
            payload = json.loads(self.rfile.read(length))
        except (ValueError, TimeoutError):
            return self.reply(400, {"error": "Invalid JSON request."})

        question = payload.get("question") if isinstance(payload, dict) else None
        if not isinstance(question, str) or not question.strip():
            return self.reply(400, {"error": "Provide a question string."})

        normalized = question.casefold()
        matches = [
            answer
            for terms, answer in NOTES.items()
            if any(re.search(r"\b" + re.escape(term) + r"\b", normalized) for term in terms)
        ]
        answer = " ".join(matches) or "I couldn't find anything about that in the sample notes."
        self.reply(200, {"answer": answer})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 18743), BrainHandler)
    print("Test brain listening on http://127.0.0.1:18743/ask", flush=True)
    server.serve_forever()
