from check_hosting import Hop, evaluate, walk

ORIGIN = "https://example.com"


def _ok_chain():
    return [
        Hop("https://github.com/x/releases/download/v/demo-points.bin", 302,
            {"location": "https://objects.githubusercontent.com/x", "access-control-allow-origin": "*"}, 0),
        Hop("https://objects.githubusercontent.com/x", 206,
            {"content-range": "bytes 0-15/16000000", "access-control-allow-origin": "*", "accept-ranges": "bytes"}, 16),
    ]


def test_evaluate_passes_good_chain():
    res = evaluate(_ok_chain(), ORIGIN)
    assert all(ok for _, ok, _ in res) and len(res) == 5   # cors ×2 hops, range 206, content-range, accept-ranges


def test_evaluate_fails_missing_cors_on_redirect():
    hops = _ok_chain()
    del hops[0].headers["access-control-allow-origin"]
    res = dict((name, ok) for name, ok, _ in evaluate(hops, ORIGIN))
    assert res["cors hop 1"] is False and res["range 206"] is True


def test_evaluate_fails_200_without_content_range():
    hops = _ok_chain()
    hops[1] = Hop(hops[1].url, 200, {"access-control-allow-origin": "*"}, 16_000_000)
    res = dict((name, ok) for name, ok, _ in evaluate(hops, ORIGIN))
    assert res["range 206"] is False and res["content-range"] is False


def test_evaluate_accepts_echoed_origin():
    hops = _ok_chain()
    hops[1].headers["access-control-allow-origin"] = ORIGIN
    assert all(ok for _, ok, _ in evaluate(hops, ORIGIN))


def test_walk_handles_dns_failure_without_crashing():
    hops = walk("https://this-host-does-not-exist.invalid/x", ORIGIN)
    assert len(hops) == 1 and hops[0].status == 0
    res = dict((name, ok) for name, ok, _ in evaluate(hops, ORIGIN))
    assert res["range 206"] is False
