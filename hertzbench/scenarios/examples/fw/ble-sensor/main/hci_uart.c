/*
 * Adapted from ESP-IDF's examples/bluetooth/bluedroid/bluedroid_host_only/
 * bluedroid_host_only_uart/main/uart_driver.c
 * (SPDX-FileCopyrightText: 2021-2023 Espressif Systems (Shanghai) CO LTD,
 * SPDX-License-Identifier: Unlicense OR CC0-1.0).
 *
 * Changes for hertzbench: UART1 at a fixed 921600 baud with hardware flow
 * control off, because nothing in the emulated board drives CTS; the pins are
 * the example's, and only matter on silicon.
 */

#include <assert.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"
#include "hci_uart.h"

#define HCI_UART_NUM (1)
#define HCI_UART_BAUD (921600)
#define HCI_UART_BUF (1024)
#define HCI_UART_TX_PIN (5)
#define HCI_UART_RX_PIN (18)

enum { H4_ACL = 2, H4_SCO = 3, H4_EVENT = 4 };

static esp_bluedroid_hci_driver_callbacks_t s_callback = {0};

/* Reads one H4 packet at a time (indicator, header, body) and hands it to Bluedroid. */
static void hci_uart_rx_task(void *arg)
{
    uint8_t buf[1026];
    for (;;) {
        int n = uart_read_bytes(HCI_UART_NUM, buf, 1, portMAX_DELAY);
        assert(n == 1);
        uint32_t header = buf[0] == H4_ACL ? 4 : buf[0] == H4_SCO ? 3 : buf[0] == H4_EVENT ? 2 : 0;
        assert(header != 0);
        n = uart_read_bytes(HCI_UART_NUM, &buf[1], header, portMAX_DELAY);
        assert(n == (int)header);
        uint32_t body = buf[0] == H4_ACL ? (buf[3] | (buf[4] << 8)) : buf[0] == H4_SCO ? buf[3] : buf[2];
        if (body > 0) {
            n = uart_read_bytes(HCI_UART_NUM, &buf[1 + header], body, portMAX_DELAY);
            assert(n == (int)body);
        }
        if (s_callback.notify_host_recv) {
            s_callback.notify_host_recv(buf, 1 + header + body);
        }
    }
}

void hci_uart_send(uint8_t *data, uint16_t len)
{
    while (len) {
        int written = uart_write_bytes(HCI_UART_NUM, data, len);
        assert(written > 0);
        len -= written;
        data += written;
    }
}

bool hci_check_send_available(void)
{
    return true;
}

esp_err_t hci_register_host_callback(const esp_bluedroid_hci_driver_callbacks_t *callback)
{
    s_callback.notify_host_send_available = callback->notify_host_send_available;
    s_callback.notify_host_recv = callback->notify_host_recv;
    return ESP_OK;
}

void hci_uart_open(void)
{
    uart_config_t config = {
        .baud_rate = HCI_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(HCI_UART_NUM, HCI_UART_BUF * 2, HCI_UART_BUF * 2, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(HCI_UART_NUM, &config));
    ESP_ERROR_CHECK(uart_set_pin(HCI_UART_NUM, HCI_UART_TX_PIN, HCI_UART_RX_PIN,
                                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    xTaskCreate(hci_uart_rx_task, "hci_uart_rx", 3072, NULL, 12, NULL);
}
