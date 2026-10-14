# =============================================================================
#  Dockerfile — Multi-stage build for TikTok Live Analytics Tracker
#  Stage 1: Builder  — compiles the C++ pybind11 extension
#  Stage 2: Runtime  — lean production image
# =============================================================================

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

LABEL maintainer="TikTok Live Tracker"
LABEL description="Real-Time TikTok Live Analytics — C++17 + Python + FastAPI"

# Build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        ninja-build \
        git \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install Python build tools first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
 && pip install --no-cache-dir pybind11[global] cmake ninja \
 && pip install --no-cache-dir -r requirements.txt

# Copy source
COPY CMakeLists.txt setup.py ./
COPY cpp_core/ cpp_core/

# Build the C++ extension
RUN pip install --no-cache-dir --no-deps -e . \
 && python -c "import tiktok_cpp_engine; print('✅ tiktok_cpp_engine built:', tiktok_cpp_engine.__version__)"

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# Runtime system deps only
RUN apt-get update && apt-get install -y --no-install-recommends \
        libstdc++6 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /usr/local/lib/python3.11/ /usr/local/lib/python3.11/
COPY --from=builder /usr/local/bin/ /usr/local/bin/

# Copy the compiled extension module (.so / .pyd)
COPY --from=builder /build/tiktok_cpp_engine*.so ./
COPY --from=builder /build/tiktok_cpp_engine*.pyd ./ 2>/dev/null || true

# Copy application code
COPY backend/  backend/
COPY frontend/ frontend/

# Create non-root user for security
RUN useradd --no-create-home --shell /bin/false appuser \
 && chown -R appuser:appuser /app
USER appuser

# Environment
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000 \
    HOST=0.0.0.0 \
    MAX_SESSIONS=10

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Launch (uses $PORT dynamically if set by cloud host like Render/Railway, defaulting to 8000)
CMD ["sh", "-c", "exec uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --log-level info"]
