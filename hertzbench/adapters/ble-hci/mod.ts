export * from "./adapter.ts";
export * from "./btsnoop.ts";
export * from "./controller.ts";
export * from "./hci.ts";
export * from "./ll.ts";

/** The UART the firmware's host stack writes HCI to; UART0 is the serial console and never carries it. */
export type HciUart = 1 | 2;
