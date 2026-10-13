cmake_minimum_required(VERSION 3.18)
project(tiktok_cpp_engine VERSION 1.0.0 LANGUAGES CXX)

# C++17 required
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Release build optimizations
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG -march=native")

# Find pybind11 (installed via pip)
find_package(pybind11 CONFIG REQUIRED)

# Include directories
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/cpp_core/include)

# Source files
set(SOURCES
    cpp_core/src/live_engine.cpp
    cpp_core/src/bindings.cpp
)

# Build the Python extension module
pybind11_add_module(tiktok_cpp_engine ${SOURCES})

# Compiler warnings
target_compile_options(tiktok_cpp_engine PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic>
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
)

# Install the module to the package root
install(TARGETS tiktok_cpp_engine
    LIBRARY DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}
    RUNTIME DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}
)
