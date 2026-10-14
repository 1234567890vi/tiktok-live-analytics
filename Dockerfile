# =============================================================================
#  Dockerfile — Production deployment for TikTok Live Analytics Tracker
# =============================================================================
FROM python:3.11-slim

LABEL maintainer="TikTok Live Tracker"
LABEL description="Real-Time TikTok Live Analytics — FastAPI & Pure-Python Engine"

WORKDIR /app

# Install curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY backend/ backend/
COPY frontend/ frontend/

# Create a non-root user for security
RUN useradd --no-create-home --shell /bin/false appuser \
 && chown -R appuser:appuser /app
USER appuser

# Environment defaults
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000 \
    HOST=0.0.0.0 \
    MAX_SESSIONS=10

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-8000}/health" || exit 1

# Launch uvicorn listening on the dynamically assigned $PORT
CMD ["sh", "-c", "exec uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --log-level info"]
