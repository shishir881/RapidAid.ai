import asyncio
from app.database import AsyncSessionLocal
from app.agents.pipeline import pipeline
from app.models.schemas import SOSRequest
import traceback

async def test():
    async with AsyncSessionLocal() as db:
        req = SOSRequest(
            patient_lat=27.7172,
            patient_lng=85.3240,
            emergency_type="CRITICAL_SOS",
        )
        try:
            emg = await pipeline.process_sos(req, db)
            print("SUCCESS:", emg.id)
        except Exception as e:
            traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test())
