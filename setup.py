"""
setup.py — builds the tiktok_cpp_engine pybind11 extension using CMake.
Run: pip install .   (or pip install -e . for editable/dev mode)
"""
import os
import re
import sys
import subprocess
from pathlib import Path
from setuptools import setup, Extension, find_packages
from setuptools.command.build_ext import build_ext


class CMakeExtension(Extension):
    """Minimal extension shim — actual build is delegated to CMake."""
    def __init__(self, name: str, sourcedir: str = "") -> None:
        super().__init__(name, sources=[])
        self.sourcedir = os.path.abspath(sourcedir)


class CMakeBuild(build_ext):
    def build_extension(self, ext: CMakeExtension) -> None:
        ext_fullpath = Path.cwd() / self.get_ext_fullpath(ext.name)
        extdir = ext_fullpath.parent.resolve()

        # CMake args
        debug = int(os.environ.get("DEBUG", 0)) if self.debug is None else self.debug
        cfg = "Debug" if debug else "Release"

        cmake_args = [
            f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY={extdir}",
            f"-DPYTHON_EXECUTABLE={sys.executable}",
            f"-DCMAKE_BUILD_TYPE={cfg}",
            "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
        ]

        build_args = ["--config", cfg]

        # Use Ninja if available for faster builds
        if sys.platform != "win32":
            try:
                import ninja  # noqa: F401
                cmake_args += ["-GNinja"]
            except ImportError:
                pass

        build_temp = Path(self.build_temp) / ext.name
        build_temp.mkdir(parents=True, exist_ok=True)

        subprocess.run(
            ["cmake", ext.sourcedir, *cmake_args],
            cwd=build_temp,
            check=True,
        )
        subprocess.run(
            ["cmake", "--build", ".", "--parallel", *build_args],
            cwd=build_temp,
            check=True,
        )

    def run(self) -> None:
        # Ensure cmake is available
        try:
            out = subprocess.check_output(["cmake", "--version"])
        except OSError:
            raise RuntimeError(
                "CMake must be installed to build the C++ extension. "
                "Install via: pip install cmake"
            )
        cmake_version = re.search(r"version\s*([\d.]+)", out.decode()).group(1)
        if tuple(int(x) for x in cmake_version.split(".")[:2]) < (3, 18):
            raise RuntimeError("CMake >= 3.18 required.")
        super().run()


setup(
    name="tiktok-live-tracker",
    version="1.0.0",
    author="TikTok Live Tracker Team",
    description="Real-Time TikTok Live Analytics with C++ Core Engine",
    long_description=open("README.md", encoding="utf-8").read() if Path("README.md").exists() else "",
    packages=find_packages(exclude=["cpp_core*", "frontend*"]),
    ext_modules=[CMakeExtension("tiktok_cpp_engine")],
    cmdclass={"build_ext": CMakeBuild},
    python_requires=">=3.11",
    install_requires=[
        "fastapi>=0.115.0",
        "uvicorn[standard]>=0.30.6",
        "websockets>=13.1",
        "TikTokLive>=6.3.5",
        "aiofiles>=24.1.0",
    ],
    zip_safe=False,
)
