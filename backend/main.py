"""
RapidAid.ai — FastAPI Application Entry Point

Run from /backend directory:
    envir/bin/uvicorn main:app --reload --port 8000

Or directly:
    envir/bin/python main.py
"""
from contextlib import asynccontextmanager
import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import init_db
from app.core.config import settings
from app.routers.routers import (
    health_router, emergency_router, hospital_router,
    vehicle_router, navigation_router, dashboard_router, ws_router
)
from app.routers.auth import auth_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan: startup → yield → shutdown."""
    # ── Startup ──────────────────────────────────────────────────────────────
    await init_db()

    if settings.DEMO_MODE:
        try:
            # main.py is at backend/main.py → parent is backend/ → parent is RapidAid/
            # So data_simulation/ is at os.path.dirname(__file__) + "/data_simulation"
            # But since we run uvicorn from backend/, the CWD-relative import works too.
            # Add the RapidAid root to sys.path so 'data_simulation' package is importable.
            rapidaid_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            if rapidaid_root not in sys.path:
                sys.path.insert(0, rapidaid_root)

            from data_simulation.seed import seed_demo_data
            await seed_demo_data()
            print("✅ Demo data seeded")
        except Exception as e:
            print(f"⚠️  Could not seed demo data: {e}")

    groq_status = (
        "🤖 Groq LLM (LLaMA 3.3) enabled"
        if settings.GROQ_API_KEY
        else "📋 Rule-based triage (set GROQ_API_KEY to enable AI triage)"
    )
    print(f"\n🚀 {settings.APP_NAME} started → http://localhost:8000")
    print(f"   📚 Swagger UI  : http://localhost:8000/docs")
    print(f"   🔧 ReDoc       : http://localhost:8000/redoc")
    print(f"   🧠 Triage mode : {groq_status}\n")

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    print(f"🛑 {settings.APP_NAME} shutting down...")


# ─────────────────────────── App ─────────────────────────────────────────────

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description=(
        "**RapidAid.ai** — Multi-Agent Emergency Medical Response Ecosystem\n\n"
        "5-agent autonomous pipeline: SmartTriage → Hospital → Negotiation → Dispatch → Route\n\n"
        "Built for eSewa Hackathon 2026 🇳🇵"
    ),
    lifespan=lifespan,
)

# CORS — strip whitespace from each origin in the comma-separated list
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────── Routers ─────────────────────────────────────────
app.include_router(health_router)
app.include_router(auth_router)
app.include_router(emergency_router)
app.include_router(hospital_router)
app.include_router(vehicle_router)
app.include_router(navigation_router)
app.include_router(dashboard_router)
app.include_router(ws_router)


# ─────────────────────────── Dev runner ──────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",          # module is 'main' not 'app.main'
        host="0.0.0.0",
        port=8000,
        reload=settings.DEBUG,
    )
