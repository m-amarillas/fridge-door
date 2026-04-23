import os

import jwt as pyjwt
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from supabase import Client, create_client

from services.embed import embed_query

router = APIRouter()

_supabase: Client | None = None


def _get_supabase() -> Client:
    global _supabase
    if _supabase is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _supabase = create_client(url, key)
    return _supabase


_DEV_USER_ID = "00000000-0000-0000-0000-000000000001"


def _extract_user_id(authorization: str) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization header must be 'Bearer <token>'")

    token = authorization.removeprefix("Bearer ")
    secret = os.environ.get("SUPABASE_JWT_SECRET")

    try:
        if secret:
            payload = pyjwt.decode(
                token,
                secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
        else:
            payload = pyjwt.decode(token, options={"verify_signature": False})
    except pyjwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}") from exc

    user_id: str | None = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing sub claim")
    return user_id


_STORAGE_MARKER = "/storage/v1/object/documents/"


def _storage_path(image_url: str) -> str | None:
    idx = image_url.find(_STORAGE_MARKER)
    if idx == -1:
        return None
    return image_url[idx + len(_STORAGE_MARKER):]


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    limit: int = Field(default=10, ge=1, le=50)


@router.post("/search")
async def search(
    body: SearchRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    supabase = _get_supabase()
    user_id = _extract_user_id(authorization) if authorization else _DEV_USER_ID

    embedding = await embed_query(body.query)

    rpc_result = supabase.rpc(
        "search_documents",
        {
            "query_embedding": embedding,
            "p_user_id": user_id,
            "match_count": body.limit,
        },
    ).execute()

    if not rpc_result.data:
        return JSONResponse(content={"documents": []})

    doc_ids = [row["document_id"] for row in rpc_result.data]
    score_map = {row["document_id"]: row["score"] for row in rpc_result.data}

    docs_result = (
        supabase.table("documents")
        .select("id, image_url, document_type, status, actions_status, created_at, ocr_text")
        .in_("id", doc_ids)
        .eq("user_id", user_id)
        .execute()
    )

    internal_url = os.environ["SUPABASE_URL"].rstrip("/")
    public_url = os.environ.get("SUPABASE_PUBLIC_URL", "").rstrip("/")

    doc_map: dict = {}
    for doc in docs_result.data:
        signed_url = None
        raw_url = doc.get("image_url") or ""
        path = _storage_path(raw_url)
        if path:
            try:
                signed = supabase.storage.from_("documents").create_signed_url(path, 3600)
                signed_url = signed.get("signedURL") or signed.get("signedUrl")
                if signed_url and public_url and public_url != internal_url:
                    signed_url = signed_url.replace(internal_url, public_url, 1)
            except Exception:
                pass

        doc_map[doc["id"]] = {
            "id": doc["id"],
            "image_url": signed_url,
            "document_type": doc["document_type"],
            "status": doc["status"],
            "actions_status": doc.get("actions_status"),
            "created_at": doc["created_at"],
            "ocr_text": doc.get("ocr_text"),
        }

    # Preserve relevance order from the RPC result.
    documents = [doc_map[doc_id] for doc_id in doc_ids if doc_id in doc_map]
    return JSONResponse(content={"documents": documents})
