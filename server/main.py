"""Fonogramma — API di sincronizzazione.

Archivia pazienti, visite e metadati delle registrazioni (documenti JSON con
strategia last-write-wins) e i file audio WAV. La PWA funziona anche offline:
questo server è il punto di raccolta comune fra cellulare e PC.
"""
import hmac
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import zipfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

VERSION = "1.0.0"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
AUDIO_DIR = DATA_DIR / "audio"
DB_PATH = DATA_DIR / "fonogramma.db"
ACCESS_PIN = os.environ.get("ACCESS_PIN", "").strip()
MAX_AUDIO_BYTES = 300 * 1024 * 1024
KINDS = ("patients", "visits", "recordings")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

AUDIO_DIR.mkdir(parents=True, exist_ok=True)
_write_lock = threading.Lock()


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS docs (
                kind TEXT NOT NULL,
                id TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                seq INTEGER NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (kind, id))"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS docs_seq ON docs(seq)")
        conn.commit()
    finally:
        conn.close()


init_db()
app = FastAPI(title="Fonogramma API", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def pin_guard(request: Request, call_next):
    path = request.url.path
    if ACCESS_PIN and path.startswith("/api/") and path != "/api/health":
        given = request.headers.get("x-access-pin", "")
        if not hmac.compare_digest(given.encode(), ACCESS_PIN.encode()):
            return JSONResponse({"detail": "PIN non valido"}, status_code=401)
    return await call_next(request)


def check_id(rid: str) -> str:
    if not ID_RE.match(rid or ""):
        raise HTTPException(400, "Identificativo non valido")
    return rid


@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION, "pinRequired": bool(ACCESS_PIN), "time": int(time.time() * 1000)}


@app.get("/api/auth")
def auth():
    return {"ok": True}


@app.post("/api/sync")
async def push(request: Request):
    body = await request.json()
    docs = body.get("docs") if isinstance(body, dict) else None
    if not isinstance(docs, list) or len(docs) > 5000:
        raise HTTPException(400, "Formato non valido")
    accepted = []
    with _write_lock:
        conn = connect()
        try:
            seq = int(conn.execute("SELECT COALESCE(MAX(seq), 0) FROM docs").fetchone()[0])
            for d in docs:
                if not isinstance(d, dict):
                    continue
                kind, did = d.get("kind"), str(d.get("id", ""))
                if kind not in KINDS or not ID_RE.match(did):
                    continue
                upd = int(d.get("updatedAt") or 0)
                deleted = 1 if d.get("deleted") else 0
                data = d.get("data") if isinstance(d.get("data"), dict) else {}
                row = conn.execute("SELECT updated_at FROM docs WHERE kind=? AND id=?", (kind, did)).fetchone()
                if row is None or upd > row["updated_at"]:
                    seq += 1
                    conn.execute(
                        """INSERT INTO docs(kind, id, updated_at, deleted, seq, data) VALUES (?,?,?,?,?,?)
                           ON CONFLICT(kind, id) DO UPDATE SET updated_at=excluded.updated_at,
                           deleted=excluded.deleted, seq=excluded.seq, data=excluded.data""",
                        (kind, did, upd, deleted, seq, json.dumps(data, separators=(",", ":"))),
                    )
                    if deleted and kind == "recordings":
                        (AUDIO_DIR / f"{did}.wav").unlink(missing_ok=True)
                accepted.append({"kind": kind, "id": did, "updatedAt": upd})
            conn.commit()
        finally:
            conn.close()
    return {"accepted": accepted, "seq": seq}


@app.get("/api/sync")
def pull(since: int = 0, limit: int = 1000):
    limit = max(1, min(limit, 5000))
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT kind, id, updated_at, deleted, seq, data FROM docs WHERE seq > ? ORDER BY seq LIMIT ?",
            (since, limit),
        ).fetchall()
    finally:
        conn.close()
    docs = [
        {
            "kind": r["kind"],
            "id": r["id"],
            "updatedAt": r["updated_at"],
            "deleted": bool(r["deleted"]),
            "data": json.loads(r["data"]),
        }
        for r in rows
    ]
    return {"docs": docs, "seq": rows[-1]["seq"] if rows else since, "more": len(rows) == limit}


@app.get("/api/audio-index")
def audio_index():
    return {"ids": sorted(p.stem for p in AUDIO_DIR.glob("*.wav"))}


@app.put("/api/audio/{rid}")
async def put_audio(rid: str, request: Request):
    check_id(rid)
    tmp = AUDIO_DIR / f".{rid}.part"
    size = 0
    try:
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_AUDIO_BYTES:
                    raise HTTPException(413, "File troppo grande")
                f.write(chunk)
        if size < 44:
            raise HTTPException(400, "File audio vuoto")
        os.replace(tmp, AUDIO_DIR / f"{rid}.wav")
    finally:
        tmp.unlink(missing_ok=True)
    return {"ok": True, "size": size}


@app.get("/api/audio/{rid}")
def get_audio(rid: str):
    path = AUDIO_DIR / f"{check_id(rid)}.wav"
    if not path.exists():
        raise HTTPException(404, "Audio non presente sul server")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/backup")
def backup():
    stamp = time.strftime("%Y%m%d-%H%M")
    fd, zip_path = tempfile.mkstemp(suffix=".zip", dir=DATA_DIR)
    os.close(fd)
    snap = DATA_DIR / ".backup-snapshot.db"
    src = connect()
    dst = sqlite3.connect(snap)
    try:
        src.backup(dst)
        rows = src.execute("SELECT kind, id, updated_at, deleted, data FROM docs ORDER BY kind, id").fetchall()
    finally:
        dst.close()
        src.close()
    export = {k: [] for k in KINDS}
    for r in rows:
        if not r["deleted"]:
            export[r["kind"]].append(json.loads(r["data"]) | {"id": r["id"], "updatedAt": r["updated_at"]})
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(snap, "fonogramma.db")
        z.writestr("dati.json", json.dumps(export, ensure_ascii=False, indent=1))
        for p in sorted(AUDIO_DIR.glob("*.wav")):
            z.write(p, f"audio/{p.name}", compress_type=zipfile.ZIP_STORED)
    snap.unlink(missing_ok=True)
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"fonogramma-backup-{stamp}.zip",
        background=BackgroundTask(os.unlink, zip_path),
    )
