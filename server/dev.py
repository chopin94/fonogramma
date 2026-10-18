"""Server di sviluppo locale: API + file statici della PWA su http://localhost:8765
(localhost è un contesto sicuro: microfono e service worker funzionano senza HTTPS)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("DATA_DIR", str(ROOT.parent / ".devdata"))
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from main import app  # noqa: E402



@app.middleware("http")
async def no_cache(request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


app.mount("/", StaticFiles(directory=ROOT.parent / "web", html=True), name="web")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8765")))
