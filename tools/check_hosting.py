#!/usr/bin/env python3
"""Probe a hosted points.bin the way the viewer's loader will use it: Range GET + CORS on every hop."""
from __future__ import annotations

import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


@dataclass
class Hop:
    url: str
    status: int
    headers: dict[str, str]
    body_len: int


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _lower(headers) -> dict[str, str]:
    return {k.lower(): v for k, v in headers.items()}


def walk(url: str, origin: str, max_hops: int = 10) -> list[Hop]:
    opener = urllib.request.build_opener(_NoRedirect())
    hops: list[Hop] = []
    for _ in range(max_hops):
        req = urllib.request.Request(url, headers={"Range": "bytes=0-15", "Origin": origin, "User-Agent": "check_hosting/1"})
        try:
            with opener.open(req, timeout=60) as r:
                # Read only 17 B: a 206 response is 16 B anyway, and this avoids
                # downloading the whole body on a host that ignores Range and
                # returns 200 + full content (seen up to 160 MB in practice).
                hops.append(Hop(url, r.status, _lower(r.headers), len(r.read(17))))
                return hops
        except urllib.error.HTTPError as e:
            headers = _lower(e.headers)
            hops.append(Hop(url, e.code, headers, 0))
            if e.code in (301, 302, 303, 307, 308) and "location" in headers:
                url = urllib.parse.urljoin(url, headers["location"])
                continue
            return hops
        except urllib.error.URLError as e:
            hops.append(Hop(url, 0, {"x-error": str(e.reason)}, 0))
            return hops
    return hops


def evaluate(hops: list[Hop], origin: str) -> list[tuple[str, bool, str]]:
    res: list[tuple[str, bool, str]] = []
    for i, h in enumerate(hops):
        acao = h.headers.get("access-control-allow-origin")
        res.append((f"cors hop {i + 1}", acao in ("*", origin), f"{h.status} {h.url} → access-control-allow-origin: {acao}"))
    last = hops[-1]
    res.append(("range 206", last.status == 206, f"status {last.status}"))
    cr = last.headers.get("content-range", "")
    res.append(("content-range", cr.startswith("bytes 0-15/") and last.body_len == 16, f"{cr!r}, body {last.body_len} B"))
    res.append(("accept-ranges (informational)", True, f"{last.headers.get('accept-ranges')!r}"))
    return res


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: check_hosting.py URL", file=sys.stderr)
        return 2
    origin = "https://example.com"
    hops = walk(argv[0], origin)
    for h in hops:
        print(f"{h.status} {h.url}")
    failed = False
    for name, ok, detail in evaluate(hops, origin):
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
        failed |= not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
