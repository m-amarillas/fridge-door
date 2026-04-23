import hashlib
import os
import uuid

import httpx
import jwt as pyjwt
from fastapi import APIRouter, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse
from supabase import Client, create_client

router = APIRouter()

# ---------------------------------------------------------------------------
# Supabase client — initialised once at import time with the service role key
# so the API can bypass RLS for server-side operations (storage upload, DB writes).
# ---------------------------------------------------------------------------
_supabase: Client | None = None


def _get_supabase() -> Client:
    global _supabase
    if _supabase is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _supabase = create_client(url, key)
    return _supabase


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def _extract_user_id(authorization: str) -> str:
    """Verify the Supabase JWT and return the user_id (sub claim)."""
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
            # Dev-only: skip signature verification so local testing works without
            # the JWT secret. Never ship this without SUPABASE_JWT_SECRET set.
            payload = pyjwt.decode(token, options={"verify_signature": False})
    except pyjwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}") from exc

    user_id: str | None = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing sub claim")
    return user_id


# ---------------------------------------------------------------------------
# Ingest endpoint
# ---------------------------------------------------------------------------

_DEV_USER_ID = "00000000-0000-0000-0000-000000000001"


@router.post("/documents", status_code=202)
async def ingest_document(
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    supabase = _get_supabase()
    user_id = _extract_user_id(authorization) if authorization else _DEV_USER_ID

    image_bytes = await file.read()
    image_hash = hashlib.sha256(image_bytes).hexdigest()

    # Dedup: reject if the same user has already uploaded this exact image.
    existing = (
        supabase.table("documents")
        .select("id")
        .eq("user_id", user_id)
        .eq("image_hash", image_hash)
        .limit(1)
        .execute()
    )
    if existing.data:
        raise HTTPException(
            status_code=409,
            detail={"document_id": existing.data[0]["id"], "reason": "duplicate"},
        )

    document_id = str(uuid.uuid4())
    storage_path = f"{user_id}/{document_id}.jpg"

    # Upload raw image to Supabase Storage.
    try:
        supabase.storage.from_("documents").upload(
            path=storage_path,
            file=image_bytes,
            file_options={"content-type": file.content_type or "image/jpeg"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Storage upload failed: {exc}") from exc

    supabase_url = os.environ["SUPABASE_URL"]
    image_url = f"{supabase_url}/storage/v1/object/documents/{storage_path}"

    # Enqueue the processing job via the worker's HTTP endpoint.
    worker_url = os.environ.get("WORKER_URL", "http://127.0.0.1:8080")
    job_payload = {
        "document_id": document_id,
        "user_id": user_id,
        "image_url": image_url,
        "image_hash": image_hash,
        "attempt": 1,
    }

    # All post-upload steps are wrapped together. On any failure we do best-effort
    # cleanup to avoid orphaned Storage objects and documents stuck at 'pending'.
    try:
        # Create the document record at status 'pending'.
        supabase.table("documents").insert(
            {
                "id": document_id,
                "user_id": user_id,
                "image_url": image_url,
                "image_hash": image_hash,
                "status": "pending",
            }
        ).execute()

        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                resp = await client.post(f"{worker_url}/enqueue", json=job_payload)
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"Worker enqueue error: {exc.response.status_code}",
                ) from exc
            except httpx.RequestError as exc:
                raise HTTPException(status_code=503, detail="Worker unavailable") from exc

        # Mark queued only after the worker has accepted the job.
        supabase.table("documents").update({"status": "queued"}).eq("id", document_id).execute()

    except Exception:
        try:
            supabase.storage.from_("documents").remove([storage_path])
        except Exception:
            pass
        try:
            supabase.table("documents").delete().eq("id", document_id).execute()
        except Exception:
            pass
        raise

    return JSONResponse(
        status_code=202,
        content={"document_id": document_id, "status": "queued"},
    )


# ---------------------------------------------------------------------------
# List documents
# ---------------------------------------------------------------------------

_STORAGE_MARKER = "/storage/v1/object/documents/"


def _storage_path(image_url: str) -> str | None:
    idx = image_url.find(_STORAGE_MARKER)
    if idx == -1:
        return None
    return image_url[idx + len(_STORAGE_MARKER):]


@router.get("/documents")
async def list_documents(
    authorization: str | None = Header(default=None),
    limit: int = Query(default=20, ge=1, le=200),
) -> JSONResponse:
    supabase = _get_supabase()
    user_id = _extract_user_id(authorization) if authorization else _DEV_USER_ID

    result = (
        supabase.table("documents")
        .select("id, image_url, document_type, status, actions_status, created_at, ocr_text")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )

    internal_url = os.environ["SUPABASE_URL"].rstrip("/")
    public_url = os.environ.get("SUPABASE_PUBLIC_URL", "").rstrip("/")

    documents = []
    for doc in result.data:
        signed_url = None
        path = _storage_path(doc["image_url"])
        if path:
            try:
                signed = supabase.storage.from_("documents").create_signed_url(path, 3600)
                signed_url = signed.get("signedURL") or signed.get("signedUrl")
                if signed_url and public_url and public_url != internal_url:
                    signed_url = signed_url.replace(internal_url, public_url, 1)
            except Exception:
                pass

        documents.append({
            "id": doc["id"],
            "image_url": signed_url,
            "document_type": doc["document_type"],
            "status": doc["status"],
            "actions_status": doc.get("actions_status"),
            "created_at": doc["created_at"],
            "ocr_text": doc.get("ocr_text"),
        })

    return JSONResponse(content={"documents": documents})
