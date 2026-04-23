import os

import jwt as pyjwt
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import JSONResponse
from supabase import Client, create_client

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


@router.get("/documents/{document_id}/actions")
async def get_document_actions(
    document_id: str,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    supabase = _get_supabase()
    user_id = _extract_user_id(authorization) if authorization else _DEV_USER_ID

    doc = (
        supabase.table("documents")
        .select("id, actions_status")
        .eq("id", document_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not doc.data:
        raise HTTPException(status_code=404, detail="Document not found")

    result = (
        supabase.table("document_actions")
        .select("id, action_type, status, payload, created_at")
        .eq("document_id", document_id)
        .eq("user_id", user_id)
        .order("created_at")
        .execute()
    )

    return JSONResponse(content={
        "document_id": document_id,
        "actions_status": doc.data[0]["actions_status"],
        "actions": result.data,
    })
