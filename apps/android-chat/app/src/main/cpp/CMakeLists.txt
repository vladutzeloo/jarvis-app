cmake_minimum_required(VERSION 3.22.1)
project(jarvis_localchat LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Size + speed for release inference.
# Note: -ffast-math includes -ffinite-math-only which breaks ggml's non-finite checks,
# so we add -fno-finite-math-only to restore support for NaN/Inf handling.
add_compile_options(-O3 -ffast-math -fno-finite-math-only -fvisibility=hidden -fvisibility-inlines-hidden)

# Expects llama.cpp checked out as a sibling under cpp/llama.cpp.
# See README — `git submodule update --init --recursive` from project root.
set(LLAMA_CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp)

if(NOT EXISTS ${LLAMA_CPP_DIR}/CMakeLists.txt)
    message(FATAL_ERROR
        "llama.cpp sources not found at ${LLAMA_CPP_DIR}. "
        "Run: git submodule add https://github.com/ggerganov/llama.cpp "
        "apps/android-chat/app/src/main/cpp/llama.cpp && git submodule update --init --recursive")
endif()

# llama.cpp build switches — keep it lean for mobile.
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL           OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP          OFF CACHE BOOL "" FORCE)

add_subdirectory(${LLAMA_CPP_DIR} ${CMAKE_BINARY_DIR}/llama.cpp EXCLUDE_FROM_ALL)

add_library(jarvis_llm SHARED llama_jni.cpp)

target_include_directories(jarvis_llm PRIVATE
    ${LLAMA_CPP_DIR}/include
    ${LLAMA_CPP_DIR}/ggml/include
    ${LLAMA_CPP_DIR}/common
)

target_link_libraries(jarvis_llm PRIVATE
    llama
    common
    log
    android
)
