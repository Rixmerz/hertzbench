// The gateway of espnow-mesh-5-nodes.yaml. It logs every ESP-NOW reading it
// hears and broadcasts a beacon every second. It prints the same lines as the
// scripted board, so the scripted twin of the scenario asserts the same text.
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
static const uint8_t BROADCAST[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
static const unsigned long BEACON_EVERY_MS = 1000;

unsigned long lastBeacon = 0;
unsigned long beaconSeq = 0;

// hertzbench gives the n-th board of the scenario the station MAC
// 02:68:7a:62:01:<n>. The gateway is first; sensor-k is board k + 1.
static void nodeName(const uint8_t *mac, char *out, size_t size) {
  static const uint8_t PREFIX[5] = {0x02, 0x68, 0x7a, 0x62, 0x01};
  if (memcmp(mac, PREFIX, 5) == 0 && mac[5] == 1) {
    snprintf(out, size, "gw");
  } else if (memcmp(mac, PREFIX, 5) == 0 && mac[5] > 1) {
    snprintf(out, size, "sensor-%u", mac[5] - 1);
  } else {
    snprintf(out, size, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3],
             mac[4], mac[5]);
  }
}

static void handleReceive(const uint8_t *mac, const uint8_t *data, int len) {
  char name[24];
  char text[64];
  nodeName(mac, name, sizeof(name));
  int n = len < (int)sizeof(text) - 1 ? len : (int)sizeof(text) - 1;
  memcpy(text, data, n);
  text[n] = '\0';
  Serial.printf("espnow rx %s from %s\n", text, name);
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

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
static void onSent(const esp_now_send_info_t *, esp_now_send_status_t status) {
#else
static void onSent(const uint8_t *, esp_now_send_status_t status) {
#endif
  Serial.printf("espnow tx %s to broadcast\n", status == ESP_NOW_SEND_SUCCESS ? "ok" : "fail");
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
  memcpy(peer.peer_addr, BROADCAST, 6);
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
  if (now - lastBeacon >= BEACON_EVERY_MS) {
    lastBeacon = now;
    char text[24];
    int n = snprintf(text, sizeof(text), "beacon:%lu", beaconSeq++);
    esp_now_send(BROADCAST, (const uint8_t *)text, n);
  }
  delay(10);
}
