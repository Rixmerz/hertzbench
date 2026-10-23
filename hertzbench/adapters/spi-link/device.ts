// The contract between a board and a radio chip model: what the board drives
// (its chip select, reset and enable lines, and the bytes it clocks) and what
// the chip drives back (its interrupt lines). A model knows nothing about how
// the board reaches it, so the same model serves the Velxio ESP32 worker, a
// scripted board, a test, and later an in-process AVR or RP2040.

export type Level = 0 | 1;

export interface SpiDevice {
  /** A board pin wired to the chip changed level. Pins the chip does not use are ignored. */
  pinChanged(gpio: number, level: Level): void;
  /** One full-duplex byte while the board's bus is clocking. Returns MISO. */
  transfer(mosi: number): number;
}

/** What a chip model calls to drive one of its output lines (DIO0, IRQ) into the board. */
export type PinDriver = (gpio: number, level: Level) => void;
