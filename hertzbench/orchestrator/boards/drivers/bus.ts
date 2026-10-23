// What a scripted driver needs from the board it pretends to be: drive a pin,
// clock a byte, wait. A scripted board implements it over the spi-link socket;
// a test implements it in process on a manual clock.

import type { Level } from "../../../adapters/spi-link/device.ts";

export interface DriverBus {
  digitalWrite(gpio: number, level: Level): Promise<void>;
  transfer(mosi: number): Promise<number>;
  delay(ms: number): Promise<void>;
}
