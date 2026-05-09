"""Vinted bot manager.

A "bot" is a saved Vinted search targeting a PC part (GPU, CPU, RAM, …) plus
some price/condition filters. Scanning a bot:

  1. Hits Vinted's public catalog JSON endpoint with the bot's filters.
  2. Normalises each listing (title, price, condition, url, thumb).
  3. Scores them (cheap-vs-median, condition bonus, model-token bonus).
  4. Bucketises into BUY / WATCH / SKIP and returns the top N as suggestions.

Vinted may rate-limit or 403 anonymous catalog requests. When that happens the
runner falls back to a deterministic demo dataset so the UI is still usable —
the response carries `source: "demo"` so the webview can flag it.

Persistence is a single JSON file (default: ~/jarvis-tts/vinted-bots.json).
The HTTP layer in server.py exposes these as REST endpoints; this module
stays UI-agnostic so it can be unit-tested without a server.
"""
from __future__ import annotations

import json
import os
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Optional

VINTED_CATALOG_URL = "https://www.vinted.com/api/v2/catalog/items"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT = 8.0

DEFAULT_STORE = Path(
    os.environ.get(
        "JARVIS_VINTED_STORE",
        str(Path.home() / "jarvis-tts" / "vinted-bots.json"),
    )
)

MAX_BOTS = 32
MAX_NAME_LEN = 80
MAX_QUERY_LEN = 120
MAX_RESULTS = 25

# PC-parts category catalog. `keywords` are matched against listing titles
# (lower-cased substring) to filter out obvious off-topic hits, since
# Vinted's category filter alone is unreliable for niche electronics.
CATEGORIES: dict[str, dict[str, Any]] = {
    "gpu": {
        "label": "GPU / Graphics card",
        "keywords": ["gpu", "graphics", "gtx", "rtx", "radeon", "rx ", "geforce", "nvidia"],
        "demo_models": ["RTX 3060", "RTX 3070", "RTX 4060", "RX 6700 XT", "GTX 1660 Super"],
        "demo_price_range": (140, 520),
    },
    "cpu": {
        "label": "CPU / Processor",
        "keywords": ["cpu", "ryzen", "intel", "core i", "i3", "i5", "i7", "i9", "processor"],
        "demo_models": ["Ryzen 5 5600X", "Ryzen 7 5800X", "Core i5-12400F", "Core i7-12700K"],
        "demo_price_range": (90, 340),
    },
    "ram": {
        "label": "RAM / Memory",
        "keywords": ["ram", "ddr4", "ddr5", "memory", "dimm", "kit"],
        "demo_models": ["16GB DDR4 3200", "32GB DDR4 3600", "16GB DDR5 5600", "32GB DDR5 6000"],
        "demo_price_range": (35, 180),
    },
    "motherboard": {
        "label": "Motherboard",
        "keywords": ["motherboard", "mobo", "b550", "b650", "x570", "z690", "z790", "atx"],
        "demo_models": ["B550 Tomahawk", "B650 Aorus Elite", "Z690 Edge", "X570 Tuf"],
        "demo_price_range": (60, 280),
    },
    "psu": {
        "label": "PSU / Power supply",
        "keywords": ["psu", "power supply", "watt", "650w", "750w", "850w", "1000w", "modular"],
        "demo_models": ["Corsair RM750x", "Seasonic Focus 650W", "be quiet! 850W", "EVGA 1000 G5"],
        "demo_price_range": (45, 220),
    },
    "storage": {
        "label": "Storage / SSD / NVMe",
        "keywords": ["ssd", "nvme", "m.2", "hdd", "hard drive", "samsung 9", "wd black", "kingston"],
        "demo_models": ["Samsung 970 Evo 1TB", "WD Black SN850 2TB", "Crucial P5 1TB"],
        "demo_price_range": (30, 200),
    },
    "case": {
        "label": "Case / Chassis",
        "keywords": ["case", "chassis", "tower", "fractal", "lian li", "nzxt", "phanteks"],
        "demo_models": ["NZXT H510", "Lian Li O11 Dynamic", "Fractal Meshify 2", "Phanteks P400A"],
        "demo_price_range": (40, 180),
    },
    "cooler": {
        "label": "CPU cooler / AIO",
        "keywords": ["cooler", "aio", "noctua", "arctic", "liquid", "heatsink", "240mm", "360mm"],
        "demo_models": ["Noctua NH-D15", "Arctic Liquid Freezer II 240", "NZXT Kraken X63"],
        "demo_price_range": (35, 180),
    },
    "custom": {
        "label": "Custom search",
        "keywords": [],
        "demo_models": ["Generic PC part"],
        "demo_price_range": (20, 400),
    },
}

CONDITIONS = ["any", "new", "very_good", "good", "fair"]
CONDITION_BONUS = {"new": 12, "very_good": 8, "good": 4, "fair": 0, "any": 0}

# ─── persistence ──────────────────────────────────────────────────────────────

_lock = threading.RLock()


def _load() -> dict[str, Any]:
    try:
        with DEFAULT_STORE.open("r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("bots"), list):
                return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {"bots": []}


def _save(state: dict[str, Any]) -> None:
    DEFAULT_STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DEFAULT_STORE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, DEFAULT_STORE)


# ─── public API ───────────────────────────────────────────────────────────────


def health() -> dict[str, Any]:
    return {
        "ok": True,
        "store": str(DEFAULT_STORE),
        "categories": [{"id": k, "label": v["label"]} for k, v in CATEGORIES.items()],
        "conditions": CONDITIONS,
        "max_bots": MAX_BOTS,
    }


def list_bots() -> list[dict[str, Any]]:
    with _lock:
        return list(_load()["bots"])


def get_bot(bot_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        for b in _load()["bots"]:
            if b.get("id") == bot_id:
                return b
    return None


def upsert_bot(payload: dict[str, Any]) -> dict[str, Any]:
    bot = _validate_bot_input(payload)
    with _lock:
        state = _load()
        bots = state["bots"]
        if bot["id"]:
            for i, existing in enumerate(bots):
                if existing.get("id") == bot["id"]:
                    bot["created_at"] = existing.get("created_at", time.time())
                    bot["last_scan_at"] = existing.get("last_scan_at")
                    bot["last_results"] = existing.get("last_results", [])
                    bots[i] = bot
                    _save(state)
                    return bot
            # id supplied but not found — treat as create with that id
        else:
            bot["id"] = uuid.uuid4().hex[:12]
        if len(bots) >= MAX_BOTS:
            raise ValueError(f"too many bots (max {MAX_BOTS})")
        bot["created_at"] = time.time()
        bot["last_scan_at"] = None
        bot["last_results"] = []
        bots.append(bot)
        _save(state)
        return bot


def delete_bot(bot_id: str) -> bool:
    with _lock:
        state = _load()
        before = len(state["bots"])
        state["bots"] = [b for b in state["bots"] if b.get("id") != bot_id]
        if len(state["bots"]) == before:
            return False
        _save(state)
        return True


def scan_bot(bot_id: str) -> dict[str, Any]:
    with _lock:
        bot = get_bot(bot_id)
    if not bot:
        raise ValueError(f"bot {bot_id} not found")

    listings, source, error = _fetch_vinted(bot)
    suggestions = _rank(listings, bot)
    summary = _summarise(suggestions)

    with _lock:
        state = _load()
        for b in state["bots"]:
            if b.get("id") == bot_id:
                b["last_scan_at"] = time.time()
                b["last_results"] = suggestions
                b["last_summary"] = summary
                b["last_source"] = source
                break
        _save(state)

    return {
        "bot_id": bot_id,
        "scanned_at": time.time(),
        "source": source,
        "error": error,
        "summary": summary,
        "suggestions": suggestions,
    }


def scan_all() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for b in list_bots():
        try:
            out.append(scan_bot(b["id"]))
        except Exception as e:  # pragma: no cover - defensive
            out.append({"bot_id": b["id"], "error": str(e), "suggestions": []})
    return out


# ─── input validation ─────────────────────────────────────────────────────────


def _validate_bot_input(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")

    name = (payload.get("name") or "").strip()
    if not name or len(name) > MAX_NAME_LEN:
        raise ValueError(f"name must be 1..{MAX_NAME_LEN} chars")

    query = (payload.get("query") or "").strip()
    if not query or len(query) > MAX_QUERY_LEN:
        raise ValueError(f"query must be 1..{MAX_QUERY_LEN} chars")

    category = payload.get("category") or "custom"
    if category not in CATEGORIES:
        raise ValueError(f"category must be one of {list(CATEGORIES)}")

    condition = payload.get("condition") or "any"
    if condition not in CONDITIONS:
        raise ValueError(f"condition must be one of {CONDITIONS}")

    def _num(value: Any, default: Optional[float], lo: float, hi: float) -> Optional[float]:
        if value is None or value == "":
            return default
        try:
            n = float(value)
        except (TypeError, ValueError):
            raise ValueError("price must be a number")
        if not lo <= n <= hi:
            raise ValueError(f"price out of range [{lo}..{hi}]")
        return n

    min_price = _num(payload.get("min_price"), None, 0, 100000)
    max_price = _num(payload.get("max_price"), None, 0, 100000)
    if min_price is not None and max_price is not None and min_price > max_price:
        raise ValueError("min_price must be <= max_price")

    max_results = int(payload.get("max_results") or 8)
    if not 1 <= max_results <= MAX_RESULTS:
        raise ValueError(f"max_results must be 1..{MAX_RESULTS}")

    return {
        "id": (payload.get("id") or "").strip(),
        "name": name,
        "query": query,
        "category": category,
        "condition": condition,
        "min_price": min_price,
        "max_price": max_price,
        "max_results": max_results,
    }


# ─── Vinted fetch ─────────────────────────────────────────────────────────────


def _fetch_vinted(bot: dict[str, Any]) -> tuple[list[dict[str, Any]], str, Optional[str]]:
    """Return (listings, source, error). source is "vinted" or "demo"."""
    params = {
        "search_text": bot["query"],
        "order": "price_low_to_high",
        "per_page": "40",
    }
    if bot.get("min_price") is not None:
        params["price_from"] = str(bot["min_price"])
    if bot.get("max_price") is not None:
        params["price_to"] = str(bot["max_price"])

    url = f"{VINTED_CATALOG_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError) as e:
        return _demo_listings(bot), "demo", f"vinted unreachable: {e.__class__.__name__}"

    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return _demo_listings(bot), "demo", "unexpected response shape"

    listings = [_normalise_item(it) for it in items]
    listings = [li for li in listings if li]
    if not listings:
        return _demo_listings(bot), "demo", "no items returned"
    return listings, "vinted", None


def _normalise_item(it: dict[str, Any]) -> Optional[dict[str, Any]]:
    if not isinstance(it, dict):
        return None
    title = (it.get("title") or "").strip()
    if not title:
        return None
    price_block = it.get("total_item_price") or it.get("price") or {}
    price_amount = price_block.get("amount") if isinstance(price_block, dict) else price_block
    try:
        price = float(price_amount)
    except (TypeError, ValueError):
        return None
    currency = "EUR"
    if isinstance(price_block, dict):
        currency = price_block.get("currency_code") or "EUR"
    photo = it.get("photo") or {}
    thumb = photo.get("url") if isinstance(photo, dict) else None
    return {
        "id": str(it.get("id") or uuid.uuid4().hex[:8]),
        "title": title,
        "price": round(price, 2),
        "currency": currency,
        "url": it.get("url") or "",
        "thumb": thumb,
        "condition": (it.get("status") or it.get("condition") or "").lower() or None,
        "favourite_count": it.get("favourite_count") or 0,
    }


def _demo_listings(bot: dict[str, Any]) -> list[dict[str, Any]]:
    cat = CATEGORIES[bot["category"]]
    rng = random.Random(hash((bot["query"], bot["category"])) & 0xFFFFFFFF)
    lo, hi = cat["demo_price_range"]
    if bot.get("min_price") is not None:
        lo = max(lo, int(bot["min_price"]))
    if bot.get("max_price") is not None:
        hi = min(hi, int(bot["max_price"]))
    if hi <= lo:
        hi = lo + 50
    out: list[dict[str, Any]] = []
    for i in range(12):
        model = rng.choice(cat["demo_models"])
        cond = rng.choice(["new", "very_good", "good", "fair"])
        price = round(rng.uniform(lo, hi), 2)
        out.append({
            "id": f"demo-{i}-{rng.randrange(10000)}",
            "title": f"{model} ({cond}) — {bot['query']}",
            "price": price,
            "currency": "EUR",
            "url": f"https://www.vinted.com/?demo={urllib.parse.quote(bot['query'])}",
            "thumb": None,
            "condition": cond,
            "favourite_count": rng.randint(0, 30),
        })
    return out


# ─── ranking ──────────────────────────────────────────────────────────────────

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text.lower()))


def _rank(listings: list[dict[str, Any]], bot: dict[str, Any]) -> list[dict[str, Any]]:
    if not listings:
        return []
    cat = CATEGORIES[bot["category"]]
    keywords = set(cat.get("keywords") or [])
    query_tokens = _tokens(bot["query"])

    # Prefilter: keep listings that mention at least one keyword from the
    # category OR a token from the query. For "custom" category, only the
    # query-token gate applies.
    def relevant(li: dict[str, Any]) -> bool:
        title = li["title"].lower()
        if keywords and not any(k in title for k in keywords):
            # Allow if query tokens hit
            if not any(t in title for t in query_tokens):
                return False
        return True

    filtered = [li for li in listings if relevant(li)] or listings

    prices = sorted(li["price"] for li in filtered)
    median = prices[len(prices) // 2] if prices else 0.0
    min_price = prices[0] if prices else 0.0

    suggestions: list[dict[str, Any]] = []
    for li in filtered:
        price = li["price"]
        # cheaper-than-median = up to +60 points; equal/higher = 0
        if median > 0:
            ratio = (median - price) / median
            price_score = max(0.0, min(60.0, ratio * 80.0))
        else:
            price_score = 0.0
        cond_score = CONDITION_BONUS.get((li.get("condition") or "any"), 0)
        title_tokens = _tokens(li["title"])
        token_overlap = len(query_tokens & title_tokens)
        token_score = min(20, token_overlap * 6)
        score = round(price_score + cond_score + token_score, 1)

        if price <= min_price * 1.05 and score >= 50:
            verdict = "buy"
        elif score >= 35:
            verdict = "watch"
        else:
            verdict = "skip"

        # Condition mismatch demotes a buy to watch
        if bot["condition"] != "any" and li.get("condition") and li["condition"] != bot["condition"]:
            if verdict == "buy":
                verdict = "watch"

        reason = _reason(price, median, li.get("condition"), token_overlap)
        suggestions.append({
            **li,
            "score": score,
            "verdict": verdict,
            "reason": reason,
            "median_price": round(median, 2),
        })

    suggestions.sort(key=lambda s: s["score"], reverse=True)
    return suggestions[: bot["max_results"]]


def _reason(price: float, median: float, condition: Optional[str], tokens: int) -> str:
    bits = []
    if median > 0:
        delta = (price - median) / median * 100
        if delta <= -25:
            bits.append(f"{abs(delta):.0f}% under median")
        elif delta <= -10:
            bits.append(f"{abs(delta):.0f}% below median")
        elif delta >= 25:
            bits.append(f"{delta:.0f}% above median")
        else:
            bits.append("near median price")
    if condition in ("new", "very_good"):
        bits.append(f"condition: {condition.replace('_', ' ')}")
    if tokens >= 2:
        bits.append("strong title match")
    return " · ".join(bits) if bits else "neutral signal"


def _summarise(suggestions: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {"buy": 0, "watch": 0, "skip": 0}
    for s in suggestions:
        counts[s["verdict"]] = counts.get(s["verdict"], 0) + 1
    if suggestions:
        cheapest = min(suggestions, key=lambda s: s["price"])
        top = suggestions[0]
    else:
        cheapest = None
        top = None
    return {
        "counts": counts,
        "total": len(suggestions),
        "cheapest": cheapest,
        "top_pick": top,
    }
