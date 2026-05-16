from __future__ import annotations

import json
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from curl_cffi.requests import Session

from services.config import DATA_DIR


PROXY_MANAGER_FILE = DATA_DIR / "proxies.json"
ALLOWED_PROXY_TYPES = {"http", "https", "socks5"}
PRIMARY_TEST_URL = "http://ip-api.com/json/?lang=zh-CN"
FALLBACK_TEST_URL = "http://httpbin.org/ip"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(value: object) -> str:
    return str(value or "").strip()


def _normalize_port(value: object) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return 0
    return port if 1 <= port <= 65535 else 0


def _safe_json(data: object) -> object:
    return json.loads(json.dumps(data, ensure_ascii=False))


def _normalize_proxy_type(value: object) -> str:
    proxy_type = _clean(value).lower()
    return proxy_type if proxy_type in ALLOWED_PROXY_TYPES else "http"


def _validate_proxy_type(value: object) -> str:
    proxy_type = _clean(value).lower()
    if proxy_type not in ALLOWED_PROXY_TYPES:
        raise ValueError(f"不支持的代理类型: {value}")
    return proxy_type


def _normalize_host(value: object) -> str:
    host = _clean(value)
    if "://" not in host:
        return host.strip("/")
    parsed = urlparse(host)
    return parsed.hostname or host


def _normalize_proxy(raw: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    proxy_id = _clean(raw.get("id")) or uuid.uuid4().hex
    host = _normalize_host(raw.get("host"))
    port = _normalize_port(raw.get("port"))
    if not host or not port:
        return None
    last_test = raw.get("last_test") if isinstance(raw.get("last_test"), dict) else None
    testing = bool(raw.get("testing"))
    return {
        "id": proxy_id,
        "name": _clean(raw.get("name")),
        "type": _normalize_proxy_type(raw.get("type")),
        "host": host,
        "port": port,
        "username": _clean(raw.get("username")),
        "password": _clean(raw.get("password")),
        "testing": testing,
        "last_test": last_test,
        "created_at": _clean(raw.get("created_at")) or _now(),
        "updated_at": _clean(raw.get("updated_at")) or _now(),
    }


def _public_proxy(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in item.items()
        if key != "password"
    } | {"has_password": bool(_clean(item.get("password")))}


def build_proxy_url(proxy: dict[str, Any]) -> str:
    proxy_type = _normalize_proxy_type(proxy.get("type"))
    host = _clean(proxy.get("host"))
    port = _normalize_port(proxy.get("port"))
    username = _clean(proxy.get("username"))
    password = _clean(proxy.get("password"))
    auth = ""
    if username:
        auth = quote(username, safe="")
        if password:
            auth += f":{quote(password, safe='')}"
        auth += "@"
    return f"{proxy_type}://{auth}{host}:{port}"


def proxy_display_name(proxy: dict[str, Any]) -> str:
    name = _clean(proxy.get("name"))
    if name:
        return name
    return f"{_normalize_proxy_type(proxy.get('type'))}://{_clean(proxy.get('host'))}:{_normalize_port(proxy.get('port'))}"


def is_proxy_error_message(value: object) -> bool:
    text = str(value or "").lower()
    if not text:
        return False
    markers = (
        "proxy",
        "socks",
        "tunnel",
        "407",
        "502 bad gateway",
        "503 service unavailable",
        "504 gateway timeout",
        "could not resolve proxy",
        "proxyerror",
        "failed to connect to proxy",
        "connection refused",
        "connection reset",
        "connection aborted",
        "connection closed",
        "connection timed out",
        "connect failed",
        "connect timeout",
        "connecttimeout",
        "read timeout",
        "readtimeout",
        "read timed out",
        "timed out",
        "max retries exceeded",
        "name or service not known",
        "temporary failure in name resolution",
        "getaddrinfo failed",
        "curl: (5)",
        "curl: (7)",
        "curl: (18)",
        "curl: (35)",
        "curl: (52)",
        "curl: (56)",
        "curl: (28)",
        "operation timed out",
        "tls connect error",
        "ssl connect error",
        "connection reset by peer",
    )
    return any(marker in text for marker in markers)


def _split_host_port(value: str) -> tuple[str, int]:
    endpoint = _clean(value)
    if not endpoint:
        raise ValueError("代理地址不能为空")
    if "://" in endpoint:
        parsed = urlparse(endpoint)
        host = parsed.hostname or ""
        port = parsed.port or 0
    else:
        host, _, raw_port = endpoint.rpartition(":")
        port = _normalize_port(raw_port)
    host = _normalize_host(host)
    if not host or not port:
        raise ValueError("代理地址格式应为 地址:端口")
    return host, port


def parse_proxy_line(line: str) -> dict[str, Any]:
    text = _clean(line)
    proxy_type, sep, rest = text.partition("|")
    if not sep:
        raise ValueError("格式应为 协议|账号:密码@地址:端口 或 协议|@地址:端口")
    proxy_type = _validate_proxy_type(proxy_type)
    rest = _clean(rest)
    if not rest:
        raise ValueError("代理地址不能为空")
    username = ""
    password = ""
    endpoint = rest
    if rest.startswith("@"):
        endpoint = rest[1:]
    elif "@" in rest:
        auth, endpoint = rest.rsplit("@", 1)
        username, _, password = auth.partition(":")
        username = _clean(username)
        password = _clean(password)
    host, port = _split_host_port(endpoint)
    return {
        "type": proxy_type,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
    }


class ProxyManagerService:
    def __init__(self, store_file: Path):
        self._store_file = store_file
        self._lock = threading.RLock()
        self._items = self._load()

    def _load(self) -> list[dict[str, Any]]:
        try:
            payload = json.loads(self._store_file.read_text(encoding="utf-8"))
        except Exception:
            return []
        raw_items = payload.get("items") if isinstance(payload, dict) else payload
        if not isinstance(raw_items, list):
            return []
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw in raw_items:
            item = _normalize_proxy(raw)
            if item is None:
                continue
            if isinstance(payload, dict):
                runtime_error_ids = payload.get("runtime_error_ids")
                if isinstance(runtime_error_ids, list) and item["id"] in {str(value) for value in runtime_error_ids}:
                    item["runtime_error"] = True
            if item["id"] in seen:
                item["id"] = uuid.uuid4().hex
            item["testing"] = False
            seen.add(item["id"])
            items.append(item)
        return items

    def _save_locked(self) -> None:
        self._store_file.parent.mkdir(parents=True, exist_ok=True)
        self._store_file.write_text(
            json.dumps({"items": self._items}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [_public_proxy(item) for item in _safe_json(self._items)]

    def get_private(self, proxy_id: str) -> dict[str, Any] | None:
        proxy_id = _clean(proxy_id)
        with self._lock:
            for item in self._items:
                if item["id"] == proxy_id:
                    return _safe_json(item)
        return None

    def get_private_many(self, proxy_ids: list[str]) -> list[dict[str, Any]]:
        wanted = [_clean(item) for item in proxy_ids if _clean(item)]
        if not wanted:
            return []
        with self._lock:
            by_id = {item["id"]: item for item in self._items}
            return [_safe_json(by_id[proxy_id]) for proxy_id in wanted if proxy_id in by_id]

    def get_proxy_url(self, proxy_id: str) -> str:
        item = self.get_private(proxy_id)
        return build_proxy_url(item) if item else ""

    def create(self, data: dict[str, Any]) -> dict[str, Any]:
        item = _normalize_proxy({
            **dict(data or {}),
            "id": uuid.uuid4().hex,
            "created_at": _now(),
            "updated_at": _now(),
            "testing": False,
            "last_test": None,
        })
        if item is None:
            raise ValueError("代理地址和端口不能为空，端口范围为 1-65535")
        with self._lock:
            self._items.append(item)
            self._save_locked()
            return _public_proxy(_safe_json(item))

    def create_many_from_text(self, text: str) -> dict[str, Any]:
        added: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        for line_no, raw_line in enumerate(str(text or "").splitlines(), start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                added.append(self.create(parse_proxy_line(line)))
            except Exception as exc:
                errors.append({"line": line_no, "text": line, "error": str(exc)})
        return {"added": len(added), "errors": errors, "items": self.list()}

    def update(self, proxy_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        proxy_id = _clean(proxy_id)
        data = dict(data or {})
        with self._lock:
            for index, current in enumerate(self._items):
                if current["id"] != proxy_id:
                    continue
                next_item = {
                    **current,
                    **data,
                    "id": current["id"],
                    "created_at": current["created_at"],
                    "updated_at": _now(),
                    "testing": bool(current.get("testing")),
                }
                if "password" not in data or data.get("password") is None:
                    next_item["password"] = current.get("password", "")
                connection_changed = (
                    ("type" in data and _normalize_proxy_type(data.get("type")) != current.get("type"))
                    or ("host" in data and _normalize_host(data.get("host")) != current.get("host"))
                    or ("port" in data and _normalize_port(data.get("port")) != int(current.get("port") or 0))
                    or ("username" in data and _clean(data.get("username")) != current.get("username"))
                    or ("password" in data and data.get("password") is not None and _clean(data.get("password")) != current.get("password"))
                )
                if connection_changed:
                    next_item["last_test"] = None
                item = _normalize_proxy(next_item)
                if item is None:
                    raise ValueError("代理地址和端口不能为空，端口范围为 1-65535")
                self._items[index] = item
                self._save_locked()
                return _public_proxy(_safe_json(item))
        return None

    def delete(self, proxy_id: str) -> bool:
        proxy_id = _clean(proxy_id)
        with self._lock:
            before = len(self._items)
            self._items = [item for item in self._items if item["id"] != proxy_id]
            removed = len(self._items) != before
            if removed:
                self._save_locked()
            return removed

    def start_test(self, proxy_ids: list[str]) -> list[dict[str, Any]]:
        target_ids = {_clean(item) for item in proxy_ids if _clean(item)}
        started: list[dict[str, Any]] = []
        with self._lock:
            for item in self._items:
                if item["id"] not in target_ids or item.get("testing"):
                    continue
                item["testing"] = True
                item["updated_at"] = _now()
                item["last_test"] = {
                    "ok": False,
                    "status": "testing",
                    "latency_ms": None,
                    "region": "",
                    "ip": "",
                    "tested_at": _now(),
                    "error": None,
                }
                started.append(_safe_json(item))
            if started:
                self._save_locked()
        for item in started:
            thread = threading.Thread(target=self._test_worker, args=(str(item["id"]),), daemon=True, name=f"proxy-test-{item['id'][:8]}")
            thread.start()
        return [_public_proxy(item) for item in started]

    def _get_item_snapshot(self, proxy_id: str) -> dict[str, Any] | None:
        with self._lock:
            for item in self._items:
                if item["id"] == proxy_id:
                    return _safe_json(item)
        return None

    def _set_test_result(self, proxy_id: str, result: dict[str, Any]) -> None:
        with self._lock:
            for item in self._items:
                if item["id"] != proxy_id:
                    continue
                item["testing"] = False
                item["updated_at"] = _now()
                item["last_test"] = result
                self._save_locked()
                return

    def mark_runtime_error(self, proxy_id: str, error: object) -> None:
        message = str(error or "").strip() or "runtime proxy error"
        self._set_test_result(proxy_id, {
            "ok": False,
            "status": "failed",
            "latency_ms": None,
            "region": "",
            "ip": "",
            "tested_at": _now(),
            "source": "register",
            "error": message[:1000],
        })

    def _test_worker(self, proxy_id: str) -> None:
        item = self._get_item_snapshot(proxy_id)
        if item is None:
            return
        result = test_proxy_connectivity(item)
        self._set_test_result(proxy_id, result)


def _request_json(url: str, proxy_url: str, timeout: float) -> tuple[dict[str, Any], int, int]:
    session = Session(impersonate="edge101", verify=False, proxy=proxy_url)
    started = time.perf_counter()
    try:
        response = session.get(url, timeout=timeout, headers={"user-agent": "Mozilla/5.0 (chatgpt2api proxy manager)"})
        latency_ms = int((time.perf_counter() - started) * 1000)
        payload = response.json()
        if not isinstance(payload, dict):
            payload = {}
        return payload, int(response.status_code), latency_ms
    finally:
        session.close()


def _format_region(data: dict[str, Any]) -> str:
    parts = [
        _clean(data.get("country")),
        _clean(data.get("regionName")),
        _clean(data.get("city")),
    ]
    seen: set[str] = set()
    normalized: list[str] = []
    for part in parts:
        if part and part not in seen:
            seen.add(part)
            normalized.append(part)
    return " / ".join(normalized)


def test_proxy_connectivity(proxy: dict[str, Any], *, timeout: float = 15.0) -> dict[str, Any]:
    proxy_url = build_proxy_url(proxy)
    tested_at = _now()
    try:
        payload, status_code, latency_ms = _request_json(PRIMARY_TEST_URL, proxy_url, timeout)
        if status_code != 200 or payload.get("status") != "success":
            message = payload.get("message") if isinstance(payload, dict) else ""
            raise RuntimeError(f"ip-api HTTP {status_code}{': ' + _clean(message) if message else ''}")
        return {
            "ok": True,
            "status": "success",
            "latency_ms": latency_ms,
            "region": _format_region(payload),
            "ip": _clean(payload.get("query")),
            "tested_at": tested_at,
            "source": "ip-api",
            "error": None,
            "country": _clean(payload.get("country")),
            "country_code": _clean(payload.get("countryCode")),
            "region_name": _clean(payload.get("regionName")),
            "city": _clean(payload.get("city")),
            "isp": _clean(payload.get("isp")),
        }
    except Exception as primary_error:
        fallback_tested_at = _now()
        try:
            payload, status_code, latency_ms = _request_json(FALLBACK_TEST_URL, proxy_url, timeout)
            origin = _clean(payload.get("origin"))
            if status_code != 200 or not origin:
                raise RuntimeError(f"httpbin HTTP {status_code}")
            return {
                "ok": True,
                "status": "success",
                "latency_ms": latency_ms,
                "region": "",
                "ip": origin,
                "tested_at": fallback_tested_at,
                "source": "httpbin",
                "error": None,
            }
        except Exception as fallback_error:
            return {
                "ok": False,
                "status": "failed",
                "latency_ms": None,
                "region": "",
                "ip": "",
                "tested_at": fallback_tested_at,
                "source": "httpbin",
                "error": f"{primary_error}; fallback: {fallback_error}",
            }


proxy_manager_service = ProxyManagerService(PROXY_MANAGER_FILE)
