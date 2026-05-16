from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from api.support import require_admin
from services.proxy_manager_service import proxy_manager_service


class ProxyUpsertRequest(BaseModel):
    name: str | None = None
    type: str
    host: str
    port: int
    username: str | None = None
    password: str | None = None


class ProxyTestRequest(BaseModel):
    ids: list[str] = []


class ProxyBatchCreateRequest(BaseModel):
    text: str = ""


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/proxies")
    async def list_proxies(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": proxy_manager_service.list()}

    @router.post("/api/proxies")
    async def create_proxy(body: ProxyUpsertRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = proxy_manager_service.create(body.model_dump(mode="python"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"item": item, "items": proxy_manager_service.list()}

    @router.post("/api/proxies/batch")
    async def batch_create_proxies(body: ProxyBatchCreateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return proxy_manager_service.create_many_from_text(body.text)

    @router.post("/api/proxies/test")
    async def test_proxies(body: ProxyTestRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        started = proxy_manager_service.start_test(body.ids)
        return {"started": len(started), "items": proxy_manager_service.list()}

    @router.post("/api/proxies/{proxy_id}")
    async def update_proxy(proxy_id: str, body: ProxyUpsertRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = proxy_manager_service.update(proxy_id, body.model_dump(mode="python"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "proxy not found"})
        return {"item": item, "items": proxy_manager_service.list()}

    @router.delete("/api/proxies/{proxy_id}")
    async def delete_proxy(proxy_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if not proxy_manager_service.delete(proxy_id):
            raise HTTPException(status_code=404, detail={"error": "proxy not found"})
        return {"items": proxy_manager_service.list()}

    return router
