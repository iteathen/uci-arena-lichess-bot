cmake_minimum_required(VERSION 3.24)
project(lichess_adapter_launcher LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "lichess_adapter_launcher is Windows-only")
endif()

add_executable(lichess_adapter_launcher WIN32 lichess_adapter_launcher.cpp)
target_compile_features(lichess_adapter_launcher PRIVATE cxx_std_20)
target_compile_definitions(lichess_adapter_launcher PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
target_link_libraries(lichess_adapter_launcher PRIVATE Shell32)

if(MSVC)
    target_compile_options(lichess_adapter_launcher PRIVATE /W4 /permissive- /EHsc)
else()
    target_compile_options(lichess_adapter_launcher PRIVATE -Wall -Wextra -Wpedantic)
endif()
