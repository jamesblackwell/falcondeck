#!/usr/bin/env python3
"""Loopback-only bounded simulator trace collector. No command execution API."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
import sys
import time

root = Path(sys.argv[2])
latest = {}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        body = json.dumps({'received_at': time.time(), **latest}).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 262144:
            self.send_error(413); return
        try:
            events = json.loads(self.rfile.read(size))
            if not isinstance(events,list) or len(events)>500: raise ValueError()
            path = root/'mobile-trace.jsonl'
            if path.exists() and path.stat().st_size > 32*1024*1024:
                path.replace(root/'mobile-trace.previous.jsonl')
            with path.open('a') as out:
                for event in events:
                    if not isinstance(event,dict): continue
                    event['received_at'] = time.time()
                    latest[event.get('event','unknown')] = event
                    out.write(json.dumps(event)+'\n')
            self.send_response(204); self.end_headers()
        except (ValueError, TypeError): self.send_error(400)

HTTPServer(('127.0.0.1',int(sys.argv[1])),Handler).serve_forever()
