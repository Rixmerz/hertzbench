// The HCI transport of the simulation-only build: H4 over UART1.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_bluedroid_hci.h"

void hci_uart_open(void);
void hci_uart_send(uint8_t *data, uint16_t len);
bool hci_check_send_available(void);
esp_err_t hci_register_host_callback(const esp_bluedroid_hci_driver_callbacks_t *callback);
