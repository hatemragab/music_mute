cmake_minimum_required(VERSION 3.24)
project(MusicMuteStoreUpload NONE)
if(NOT WIN32)
  message(FATAL_ERROR "WINDOWS_STORE_PACK_REQUIRED")
endif()
add_custom_target(musicmute-store-upload ALL
  COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_SOURCE_DIR}/pack.cmake"
  VERBATIM)
