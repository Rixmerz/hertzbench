// One firmware for all three boards of udp-3-nodes.yaml. Each board learns who
// it is from the address the engine's DHCP server leases it (192.168.4.11-13),
// pings the other two every 200 ms, answers pings with pongs and logs what it
// hears. The engine has no DNS, so peers are addressed by IP.
#include <WiFi.h>
#include <WiFiUdp.h>

// Velxio's compile step rewrites any WiFi.begin() to this SSID, open auth and
// channel 5 (backend/app/services/espidf_compiler.py), so say it plainly here.
static const char *WIFI_SSID = "Espressif";
static const int WIFI_CHANNEL = 5;
static const uint16_t UDP_PORT = 5000;
static const uint8_t FIRST_HOST = 11;
static const uint8_t NODE_COUNT = 3;
static const unsigned long PING_EVERY_MS = 200;

WiFiUDP udp;
unsigned long lastPing = 0;
unsigned long sequence = 0;

void sendTo(IPAddress target, const char *kind, unsigned long seq) {
  udp.beginPacket(target, UDP_PORT);
  udp.printf("%s:%lu", kind, seq);
  udp.endPacket();
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, "", WIFI_CHANNEL);
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
  }
  Serial.printf("wifi up ip=%s\n", WiFi.localIP().toString().c_str());
  udp.begin(UDP_PORT);
}

void loop() {
  unsigned long now = millis();
  if (now - lastPing >= PING_EVERY_MS) {
    lastPing = now;
    IPAddress self = WiFi.localIP();
    for (uint8_t host = FIRST_HOST; host < FIRST_HOST + NODE_COUNT; host++) {
      if (host == self[3]) continue;
      sendTo(IPAddress(self[0], self[1], self[2], host), "ping", sequence);
    }
    sequence++;
  }

  int size = udp.parsePacket();
  if (size > 0) {
    char text[32];
    int n = udp.read(text, sizeof(text) - 1);
    text[n > 0 ? n : 0] = '\0';
    Serial.printf("rx %s from %s\n", text, udp.remoteIP().toString().c_str());
    if (strncmp(text, "ping:", 5) == 0) {
      sendTo(udp.remoteIP(), "pong", strtoul(text + 5, nullptr, 10));
    }
  }
}
