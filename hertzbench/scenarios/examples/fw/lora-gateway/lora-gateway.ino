// The gateway of lora-gateway-6-nodes.yaml: an ESP32 with an SX1276 on VSPI
// that listens with arduino-LoRa's polling receive (parsePacket, RX single)
// and logs every packet with the RSSI and SNR the chip measured.
#include <SPI.h>
#include <LoRa.h>

// Must match radios[0].pins in the scenario.
static const int PIN_SS = 5;
static const int PIN_RST = 14;
static const int PIN_DIO0 = 26;

static const long FREQUENCY_HZ = 868100000;

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
  Serial.println("lora gateway ready");
}

void loop() {
  int size = LoRa.parsePacket();
  if (size == 0) return;
  String text;
  while (LoRa.available()) text += (char)LoRa.read();
  Serial.printf("rx \"%s\" rssi=%d snr=%.2f\n", text.c_str(), LoRa.packetRssi(), LoRa.packetSnr());
}
