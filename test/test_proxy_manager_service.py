import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.proxy_manager_service import (
    ProxyManagerService,
    build_proxy_url,
    is_proxy_error_message,
    parse_proxy_line,
    test_proxy_connectivity,
)


class ProxyManagerServiceTests(unittest.TestCase):
    def test_build_proxy_url_quotes_auth(self) -> None:
        url = build_proxy_url({
            "type": "socks5",
            "host": "127.0.0.1",
            "port": 7890,
            "username": "user@example.com",
            "password": "p@ ss",
        })

        self.assertEqual(url, "socks5://user%40example.com:p%40%20ss@127.0.0.1:7890")

    def test_update_preserves_password_when_omitted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ProxyManagerService(Path(tmp_dir) / "proxies.json")
            created = service.create({
                "type": "http",
                "host": "127.0.0.1",
                "port": 7890,
                "username": "u",
                "password": "secret",
            })

            service.update(created["id"], {
                "type": "http",
                "host": "127.0.0.1",
                "port": 7891,
                "username": "u",
            })

            snapshot = service._get_item_snapshot(created["id"])
            self.assertIsNotNone(snapshot)
            self.assertEqual(snapshot["password"], "secret")

    def test_connectivity_falls_back_to_httpbin_and_restarts_latency(self) -> None:
        calls: list[str] = []

        def fake_request(url: str, proxy_url: str, timeout: float):
            calls.append(url)
            if "ip-api" in url:
                raise RuntimeError("primary failed")
            return {"origin": "14.199.30.185"}, 200, 23

        with mock.patch("services.proxy_manager_service._request_json", side_effect=fake_request):
            result = test_proxy_connectivity({"type": "http", "host": "127.0.0.1", "port": 7890})

        self.assertEqual(calls, [
            "http://ip-api.com/json/?lang=zh-CN",
            "http://httpbin.org/ip",
        ])
        self.assertTrue(result["ok"])
        self.assertEqual(result["latency_ms"], 23)
        self.assertEqual(result["region"], "")
        self.assertEqual(result["source"], "httpbin")

    def test_parse_proxy_line_with_auth(self) -> None:
        result = parse_proxy_line("socks5|user:pa:ss@127.0.0.1:7890")

        self.assertEqual(result["type"], "socks5")
        self.assertEqual(result["username"], "user")
        self.assertEqual(result["password"], "pa:ss")
        self.assertEqual(result["host"], "127.0.0.1")
        self.assertEqual(result["port"], 7890)

    def test_parse_proxy_line_without_auth(self) -> None:
        result = parse_proxy_line("http|@proxy.example.test:8080")

        self.assertEqual(result["type"], "http")
        self.assertEqual(result["username"], "")
        self.assertEqual(result["password"], "")
        self.assertEqual(result["host"], "proxy.example.test")
        self.assertEqual(result["port"], 8080)

    def test_batch_create_reports_invalid_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ProxyManagerService(Path(tmp_dir) / "proxies.json")
            result = service.create_many_from_text("http|@127.0.0.1:7890\nbad|@127.0.0.1:7891")

        self.assertEqual(result["added"], 1)
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["items"][0]["host"], "127.0.0.1")

    def test_proxy_error_detection(self) -> None:
        self.assertTrue(is_proxy_error_message("ProxyError: tunnel connection failed 407"))
        self.assertTrue(is_proxy_error_message("curl: (28) Operation timed out"))
        self.assertFalse(is_proxy_error_message("邮箱域名很可能因滥用被封禁"))


if __name__ == "__main__":
    unittest.main()
