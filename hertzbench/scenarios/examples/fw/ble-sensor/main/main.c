/*
 * BLE sensor for hertzbench's ble-sensors-3-nodes.yaml (Phase 6, F3).
 *
 * Bluedroid runs host-only: HCI goes over UART1 (hci_uart.c) to the virtual
 * controller the engine plays for this node, so advertising, the connection
 * and every notification cross the channel model. The application is plain
 * Bluedroid GAP and GATT server code, as on silicon: it advertises, serves one
 * notify characteristic (service 0xFF00, characteristic 0xFF01) and, while a
 * central is connected, notifies "reading:<n>" every 200 ms.
 *
 * Serial lines (UART0), for the scenario's assertions:
 *   ble up addr=<address>
 *   ble advertising
 *   ble connected peer=<address>
 *   ble disconnected reason=0x<code>
 *   ble tx reading:<n>
 *
 * Never compiled on the host this was written on (no ESP-IDF there); written
 * against ESP-IDF v5.3's Bluedroid API.
 */

#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "esp_bt_main.h"
#include "esp_bt_device.h"
#include "esp_gap_ble_api.h"
#include "esp_gatts_api.h"
#include "esp_bluedroid_hci.h"
#include "hci_uart.h"

#define NOTIFY_PERIOD_MS 200

enum { IDX_SVC, IDX_CHAR_DECL, IDX_CHAR_VAL, IDX_CHAR_CCCD, IDX_COUNT };

static const uint16_t primary_service_uuid = ESP_GATT_UUID_PRI_SERVICE;
static const uint16_t char_decl_uuid = ESP_GATT_UUID_CHAR_DECLARE;
static const uint16_t cccd_uuid = ESP_GATT_UUID_CHAR_CLIENT_CONFIG;
static const uint16_t service_uuid = 0xFF00;
static const uint16_t reading_uuid = 0xFF01;
static const uint8_t reading_props = ESP_GATT_CHAR_PROP_BIT_READ | ESP_GATT_CHAR_PROP_BIT_NOTIFY;
static uint8_t reading_value[20] = "reading:-";
static uint8_t cccd_value[2] = {0x00, 0x00};

static const esp_gatts_attr_db_t gatt_db[IDX_COUNT] = {
    [IDX_SVC] = {{ESP_GATT_AUTO_RSP},
                 {ESP_UUID_LEN_16, (uint8_t *)&primary_service_uuid, ESP_GATT_PERM_READ,
                  sizeof(service_uuid), sizeof(service_uuid), (uint8_t *)&service_uuid}},
    [IDX_CHAR_DECL] = {{ESP_GATT_AUTO_RSP},
                       {ESP_UUID_LEN_16, (uint8_t *)&char_decl_uuid, ESP_GATT_PERM_READ,
                        sizeof(reading_props), sizeof(reading_props), (uint8_t *)&reading_props}},
    [IDX_CHAR_VAL] = {{ESP_GATT_AUTO_RSP},
                      {ESP_UUID_LEN_16, (uint8_t *)&reading_uuid, ESP_GATT_PERM_READ,
                       sizeof(reading_value), 9, reading_value}},
    [IDX_CHAR_CCCD] = {{ESP_GATT_AUTO_RSP},
                       {ESP_UUID_LEN_16, (uint8_t *)&cccd_uuid,
                        ESP_GATT_PERM_READ | ESP_GATT_PERM_WRITE, sizeof(cccd_value),
                        sizeof(cccd_value), cccd_value}},
};

static esp_ble_adv_params_t adv_params = {
    .adv_int_min = 0x50, /* 0x50 * 0.625 ms = 50 ms */
    .adv_int_max = 0x50,
    .adv_type = ADV_TYPE_IND,
    .own_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL,
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

static uint16_t s_handles[IDX_COUNT];
static esp_gatt_if_t s_gatts_if = ESP_GATT_IF_NONE;
static uint16_t s_conn_id;
static volatile bool s_connected;

static void print_address(const char *prefix, const uint8_t *a)
{
    printf("%s%02x:%02x:%02x:%02x:%02x:%02x\n", prefix, a[0], a[1], a[2], a[3], a[4], a[5]);
}

/* Flags (LE General Discoverable, BR/EDR not supported) and the complete local name "hzb-<last byte of the address>". */
static void set_advertising_data(void)
{
    const uint8_t *addr = esp_bt_dev_get_address();
    char name[12];
    int name_len = snprintf(name, sizeof(name), "hzb-%02x", addr[5]);
    uint8_t raw[31] = {2, ESP_BLE_AD_TYPE_FLAG, ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT,
                       (uint8_t)(name_len + 1), ESP_BLE_AD_TYPE_NAME_CMPL};
    memcpy(&raw[5], name, name_len);
    esp_ble_gap_config_adv_data_raw(raw, 5 + name_len);
}

static void gap_event(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param)
{
    switch (event) {
    case ESP_GAP_BLE_ADV_DATA_RAW_SET_COMPLETE_EVT:
        esp_ble_gap_start_advertising(&adv_params);
        break;
    case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
        if (param->adv_start_cmpl.status == ESP_BT_STATUS_SUCCESS) {
            printf("ble advertising\n");
        } else {
            printf("ble advertising failed status=%d\n", param->adv_start_cmpl.status);
        }
        break;
    default:
        break;
    }
}

static void gatts_event(esp_gatts_cb_event_t event, esp_gatt_if_t gatts_if, esp_ble_gatts_cb_param_t *param)
{
    switch (event) {
    case ESP_GATTS_REG_EVT:
        s_gatts_if = gatts_if;
        set_advertising_data();
        esp_ble_gatts_create_attr_tab(gatt_db, gatts_if, IDX_COUNT, 0);
        break;
    case ESP_GATTS_CREAT_ATTR_TAB_EVT:
        if (param->add_attr_tab.status != ESP_GATT_OK || param->add_attr_tab.num_handle != IDX_COUNT) {
            printf("ble attribute table failed status=%d\n", param->add_attr_tab.status);
            break;
        }
        memcpy(s_handles, param->add_attr_tab.handles, sizeof(s_handles));
        esp_ble_gatts_start_service(s_handles[IDX_SVC]);
        break;
    case ESP_GATTS_CONNECT_EVT:
        s_conn_id = param->connect.conn_id;
        s_connected = true;
        print_address("ble connected peer=", param->connect.remote_bda);
        break;
    case ESP_GATTS_DISCONNECT_EVT:
        s_connected = false;
        printf("ble disconnected reason=0x%02x\n", param->disconnect.reason);
        esp_ble_gap_start_advertising(&adv_params);
        break;
    default:
        break;
    }
}

/* Notifies whether or not the central enabled the CCCD: the scenario's central is a scripted host that does not discover. */
static void notify_task(void *arg)
{
    unsigned seq = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(NOTIFY_PERIOD_MS));
        if (!s_connected) {
            continue;
        }
        char text[20];
        int len = snprintf(text, sizeof(text), "reading:%u", seq++);
        if (esp_ble_gatts_send_indicate(s_gatts_if, s_conn_id, s_handles[IDX_CHAR_VAL], len,
                                        (uint8_t *)text, false) == ESP_OK) {
            printf("ble tx %s\n", text);
        }
    }
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    hci_uart_open();
    esp_bluedroid_hci_driver_operations_t operations = {
        .send = hci_uart_send,
        .check_send_available = hci_check_send_available,
        .register_host_callback = hci_register_host_callback,
    };
    ESP_ERROR_CHECK(esp_bluedroid_attach_hci_driver(&operations));

    esp_bluedroid_config_t config = BT_BLUEDROID_INIT_CONFIG_DEFAULT();
    if ((err = esp_bluedroid_init_with_cfg(&config)) != ESP_OK) {
        printf("ble init failed: %s\n", esp_err_to_name(err));
        return;
    }
    if ((err = esp_bluedroid_enable()) != ESP_OK) {
        printf("ble enable failed: %s\n", esp_err_to_name(err));
        return;
    }
    print_address("ble up addr=", esp_bt_dev_get_address());

    ESP_ERROR_CHECK(esp_ble_gap_register_callback(gap_event));
    ESP_ERROR_CHECK(esp_ble_gatts_register_callback(gatts_event));
    ESP_ERROR_CHECK(esp_ble_gatts_app_register(0));
    xTaskCreate(notify_task, "notify", 3072, NULL, 5, NULL);
}
