# ESP-IDF project of the BLE sensor in ble-sensors-3-nodes.yaml. Bluedroid runs
# host-only and talks HCI over UART1 to hertzbench's virtual controller
# (ADR 0002, F3). Build: hertzbench/docs/e2e-esp32.md, "The BLE example".
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(ble-sensor)
