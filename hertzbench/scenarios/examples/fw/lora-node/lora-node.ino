// One firmware for the six sensor nodes of lora-gateway-6-nodes.yaml: an
// ESP32 with an SX1276 on VSPI, sending a reading every two seconds with
// sandeepmistry/arduino-LoRa (install it with `arduino-cli lib install LoRa`).
//
// LoRa has no addresses, so the payload names its sender. Every board runs
// the same binary; each one takes its id from RegRssiWideband (LoRa.random()),
// the usual trick on real radios, which hertzbench's SX127x model answers with
// a different seeded value per node. The same byte spreads the first send and
// the period, so the six nodes do not all key up at once (they can still
// collide, as an ALOHA network does).
#include <SPI.h>
#include <LoRa.h>

// Must match radios[0].pins in the scenario.
static const int PIN_SS = 5;
static const int PIN_RST = 14;
static const int PIN_DIO0 = 26;

static const long FREQUENCY_HZ = 868100000;
static const unsigned long PERIOD_MS = 2000;

uint8_t nodeId = 0;
unsigned long sequence = 0;

void setup() {
  Serial.begin(115200);
  SPI.begin(18, 19, 23, PIN_SS);  // VSPI: SCK, MISO, MOSI, SS
  LoRa.setPins(PIN_SS, PIN_RST, PIN_DIO0);
  if (!LoRa.begin(FREQUENCY_HZ)) {
    Serial.println("lora init failed");
    while (true) delay(1000);
  }
  LoRa.setSpreadingFactor(7);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  LoRa.enableCrc();
  LoRa.setTxPower(14);
  nodeId = LoRa.random();
  Serial.printf("lora node %02x ready\n", nodeId);
  delay(200 + (nodeId % 16) * 60);
}

void loop() {
  char message[32];
  snprintf(message, sizeof message, "reading:%lu from %02x", sequence++, nodeId);
  LoRa.beginPacket();
  LoRa.print(message);
  LoRa.endPacket();  // blocks until TxDone
  Serial.printf("tx %s\n", message);
  delay(PERIOD_MS + (nodeId % 8) * 37);
}
