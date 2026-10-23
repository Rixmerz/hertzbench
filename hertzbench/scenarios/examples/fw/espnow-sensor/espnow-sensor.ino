// A sensor of espnow-mesh-5-nodes.yaml. Every 500 ms it sends a reading to the
// gateway over unicast ESP-NOW and logs whether the ACK came back; it logs the
// gateway's beacons too. It prints the same lines as the scripted board, so
// the scripted twin of the scenario asserts the same text.
//
// Not compiled on the host this was written on (no ESP-IDF toolchain there);
// docs/e2e-esp32.md says how to run it. Velxio builds Arduino sketches with
// arduino-esp32 2.x (ESP-IDF 4.4) or 3.x (ESP-IDF 5.5); the callbacks below
// take the signature each one expects.
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// Must match the scenario's radio channel: the fork drops frames from any other.
static const uint8_t WIFI_CHANNEL = 1;
// hertzbench gives the n-th board of the scenario the station MAC
// 02:68:7a:62:01:<n>, and the gateway is the first board.
static const uint8_t GATEWAY[6] = {0x02, 0x68, 0x7a, 0x62, 0x01, 0x01};
static const unsigned long READING_EVERY_MS = 500;

unsigned long lastReading = 0;
unsigned long readingSeq = 0;

static void handleReceive(const uint8_t *mac, const uint8_t *data, int len) {
  char text[64];
  int n = len < (int)sizeof(text) - 1 ? len : (int)sizeof(text) - 1;
  memcpy(text, data, n);
  text[n] = '\0';
  bool fromGateway = memcmp(mac, GATEWAY, 6) == 0;
  Serial.printf("espnow rx %s from %s\n", text, fromGateway ? "gw" : "another node");
}

#if ESP_IDF_VERSION_MAJOR >= 5
static void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  handleReceive(info->src_addr, data, len);
}
#else
static void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  handleReceive(mac, data, len);
}
#endif

// The send callback reports what the radio's MAC decided: under QEMU, whether
// the fork saw the ACK within its 10 ms wait.
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
static void onSent(const esp_now_send_info_t *, esp_now_send_status_t status) {
#else
static void onSent(const uint8_t *, esp_now_send_status_t status) {
#endif
  Serial.printf("espnow tx %s to gw\n", status == ESP_NOW_SEND_SUCCESS ? "ok" : "fail");
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  if (esp_now_init() != ESP_OK) {
    Serial.println("espnow init failed");
    return;
  }
  esp_now_register_recv_cb(onReceive);
  esp_now_register_send_cb(onSent);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, GATEWAY, 6);
  peer.channel = 0;  // the current channel
  peer.encrypt = false;
  esp_now_add_peer(&peer);
  uint8_t self[6];
  esp_wifi_get_mac(WIFI_IF_STA, self);
  Serial.printf("espnow up mac=%02x:%02x:%02x:%02x:%02x:%02x channel=%u\n", self[0], self[1],
                self[2], self[3], self[4], self[5], WIFI_CHANNEL);
}

void loop() {
  unsigned long now = millis();
  if (now - lastReading >= READING_EVERY_MS) {
    lastReading = now;
    char text[24];
    int n = snprintf(text, sizeof(text), "reading:%lu", readingSeq++);
    esp_now_send(GATEWAY, (const uint8_t *)text, n);
  }
  delay(10);
}
