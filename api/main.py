from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import actions, ingest

load_dotenv()

app = FastAPI(title="The Fridge Door API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "PATCH"],
    allow_headers=["*"],
)

app.include_router(ingest.router)
app.include_router(actions.router)
