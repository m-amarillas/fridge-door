import os

import httpx


async def embed_query(text: str) -> list[float]:
    """Embed a search query using Nomic Embed v1.5 (task_type: search_query).

    Returns a zero vector when NOMIC_EMBED_URL is unset — results will be
    meaningless but the endpoint won't crash, which is useful in dev/test.
    """
    embed_url = os.environ.get("NOMIC_EMBED_URL", "")
    if not embed_url:
        return [0.0] * 768

    headers: dict[str, str] = {"Content-Type": "application/json"}
    api_key = os.environ.get("NOMIC_EMBED_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": "nomic-embed-text-v1.5",
        "texts": [text],
        "task_type": "search_query",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{embed_url}/v1/embedding/text",
            json=payload,
            headers=headers,
        )
        resp.raise_for_status()

    data = resp.json()
    return data["embeddings"][0]
