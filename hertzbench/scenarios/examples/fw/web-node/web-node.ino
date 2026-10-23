// The web node of bridge-web-esp32.yaml: an ESP32 HTTP server a phone reaches
// through hertzbench's IP bridge (PLAN Phase 5a). It joins the simulated
// Wi-Fi, takes its address from the engine's DHCP server and answers
//   GET /status  with its uptime and request count, in plain text
//   GET /led?on=1 or ?on=0, which switches the built-in LED and says so
// printing one serial line per request for `serial:` assertions.
//
// The bridge relays any TCP, so a sketch with a WebSocket server
// (arduinoWebSockets) or an MQTT broker (PicoMQTT) is reached the same way;
// those libraries are not part of Velxio's default build, so this example
// stays on the core's WebServer.
#include <WiFi.h>
#include <WebServer.h>

// Velxio's compile step rewrites any WiFi.begin() to this SSID, open auth and
// channel 5 (backend/app/services/espidf_compiler.py), so say it plainly here.
static const char *WIFI_SSID = "Espressif";
static const int WIFI_CHANNEL = 5;
static const int LED_PIN = 2;

WebServer server(80);
unsigned long requests = 0;

void handleStatus() {
  requests++;
  Serial.printf("http GET /status from %s\n", server.client().remoteIP().toString().c_str());
  server.send(200, "text/plain",
              String("web-node uptime_ms=") + millis() + " requests=" + requests + "\n");
}

void handleLed() {
  requests++;
  bool on = server.arg("on") == "1";
  digitalWrite(LED_PIN, on ? HIGH : LOW);
  Serial.printf("http GET /led on=%d\n", on ? 1 : 0);
  server.send(200, "text/plain", on ? "led on\n" : "led off\n");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  WiFi.begin(WIFI_SSID, "", WIFI_CHANNEL);
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
  }
  Serial.printf("wifi up ip=%s\n", WiFi.localIP().toString().c_str());
  server.on("/status", handleStatus);
  server.on("/led", handleLed);
  server.begin();
  Serial.println("http listening on 80");
}

void loop() {
  server.handleClient();
}
