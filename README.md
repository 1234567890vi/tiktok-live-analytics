# TikTok Live Analytics Tracker

A production-ready real-time analytics platform for TikTok Live streams with a hybrid C++17/Python architecture.

## Quick Start (Local)

```bash
cd tiktok-live-tracker

# 1. Install dependencies & compile the C++ engine
pip install -r requirements.txt
pip install .

# 2. Run the server
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

# 3. Open your browser at http://localhost:8000
```

## Docker Deployment

```bash
# Build & run
docker build -t tiktok-live-tracker .
docker run -p 8000:8000 tiktok-live-tracker

# Or with Railway/Render: just push this directory — auto-detected.
```
