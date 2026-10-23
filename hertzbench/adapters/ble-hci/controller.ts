// The virtual BLE controller: the part of a Bluetooth chip below HCI, played
// by the engine for one node (ADR 0002, F3). The firmware's own host stack
// (Bluedroid, NimBLE, or the scripted host) talks HCI to it over a UART; it
// talks to the other nodes' controllers through the AirMedium, so every
// advertising, connection and data packet pays the channel model: path loss,
// shadowing, walls, co-channel collisions and the PHY error rate.
//
// Modelled (Core v5.x, Vol 6 Part B): legacy advertising (ADV_IND,
// ADV_SCAN_IND, ADV_NONCONN_IND) with SCAN_REQ/SCAN_RSP, passive and active
// scanning with the filter accept list, the initiator and CONNECT_IND, and
// connections on the 1M PHY with channel selection algorithm #1, the SN/NESN
// acknowledgement and retransmission, the MD bit, supervision timeout,
// connection update, termination, and the version and feature exchanges. Not
// modelled: encryption and pairing, directed advertising, extended
// advertising, 2M and Coded PHYs, the data length extension, privacy and
// peripheral latency (a peripheral listens at every event). docs/fidelity.md
// lists them with what each means for a result.

import {
  type AirFrame,
  type AirReceiver,
  BLE_ADV_ACCESS_ADDRESS,
  BLE_ADV_CHANNELS,
  BLE_ADV_CRC_INIT,
  BLE_BANDWIDTH_HZ,
  BLE_CAPTURE_DB,
  BLE_MAX_DATA_PAYLOAD,
  BLE_NOISE_FIGURE_DB,
  BLE_RATE_BPS,
  BLE_REFERENCE_BYTES,
  BLE_T_IFS_MS,
  bleAirtimeUs,
  bleChannelFrequencyHz,
  bleNextDataChannel,
  bleRequiredSnrDb,
  type Clock,
  type EventLog,
  type Hearing,
  type ReceptionQuality,
  type Rng,
} from "../../engine/mod.ts";
import {
  addressToString,
  encodeHci,
  EVT,
  H4Decoder,
  type HciPacket,
  LE_SUBEVENT,
  OP,
  readU16,
  STATUS,
  supportedCommands,
  u16,
} from "./hci.ts";
import {
  ADV_PDU,
  type AdvPdu,
  type ConnectParams,
  type DataPdu,
  encodeAdvPdu,
  encodeConnectInd,
  encodeDataPdu,
  LL_CTRL,
  LLID,
  parseAdvPdu,
  parseConnectInd,
  parseDataPdu,
} from "./ll.ts";

/** Engine bookkeeping for one HCI ACL packet, shared by both controllers; never on the air. */
export interface AclItem {
  bytes: number;
  enqueuedMs: number;
  /** Link-layer transmissions of its fragments so far. */
  transmissions: number;
  delivered: boolean;
}

export interface BleAirHeader {
  /** Channel index 0-39. */
  channel: number;
  accessAddress: number;
  crcInit: number;
  /** Set on the last fragment of an HCI ACL packet. */
  acl: AclItem | null;
}

export function isBleFrame(frame: AirFrame): frame is AirFrame<BleAirHeader> {
  return frame.kind === "ble-adv" || frame.kind === "ble-data";
}

export interface BleControllerOptions {
  nodeId: string;
  /** Public device address, "02:68:7a:62:01:05". */
  address: string;
  txPowerDbm: number;
  clock: Clock;
  log: EventLog;
  rng: Rng;
  transmit(frame: AirFrame<BleAirHeader>): void;
  /** H4 bytes to the host. */
  toHost(bytes: Uint8Array): void;
  /** Something the firmware asked for that the controller does not model; once per cause. */
  warn(message: string): void;
}

/** A receiver opens this early and stays open this long after the expected start (widening plus propagation). */
const RX_SLACK_MS = 0.05;
/** From the end of one advertising PDU to the start of the next channel's. */
const ADV_CHANNEL_GAP_MS = 1.0;
/** Connection setup: the transmit window starts 1.25 ms after CONNECT_IND (transmitWindowDelay). */
const TRANSMIT_WINDOW_DELAY_MS = 1.25;
/** LE buffers the controller offers the host (LE Read Buffer Size). */
const LE_ACL_BUFFERS = 10;
const ACCEPT_LIST_SIZE = 8;
/** LL and HCI version 4.2, company 0xFFFF (reserved for tests): what LL_VERSION_IND and Read Local Version report. */
const VERSION = 0x08;
const COMPANY_ID = 0xffff;
const SUBVERSION = 0x0001;
/** Supported LE features: none of the optional ones (no encryption, no data length extension). */
const LE_FEATURES = new Uint8Array(8);
/** LMP features page 0: "BR/EDR Not Supported" (bit 37) and "LE Supported (Controller)" (bit 38). */
const LMP_FEATURES = Uint8Array.of(0, 0, 0, 0, 0x60, 0, 0, 0);
const EMPTY = new Uint8Array(0);

interface TxItem {
  llid: number;
  payload: Uint8Array;
  acl: AclItem | null;
  /** The last fragment of its HCI ACL packet: its ack frees one host buffer. */
  last: boolean;
  onAcked?: () => void;
}

const EMPTY_PDU: TxItem = { llid: LLID.continuation, payload: EMPTY, acl: null, last: false };

interface Connection {
  handle: number;
  role: "central" | "peripheral";
  peerNode: string;
  peerAddress: Uint8Array;
  peerRandom: boolean;
  aa: number;
  crcInit: number;
  intervalMs: number;
  intervalUnits: number;
  latency: number;
  timeoutMs: number;
  timeoutUnits: number;
  channelMap: number[];
  hop: number;
  lastUnmapped: number;
  channel: number;
  eventCounter: number;
  anchorMs: number;
  createdMs: number;
  established: boolean;
  lastRxMs: number;
  lastQuality: ReceptionQuality;
  sn: number;
  nesn: number;
  /** What was last sent and not yet acknowledged; it is sent again until it is. */
  unacked: TxItem | null;
  queue: TxItem[];
  peerMd: boolean;
  /** In a connection event, waiting for a packet that must start by this time. */
  expectUntil: number | null;
  pendingUpdate:
    | { instant: number; intervalUnits: number; latency: number; timeoutUnits: number }
    | null;
  versionSent: boolean;
  peerVersion: Uint8Array | null;
  hostWantsVersion: boolean;
  hostWantsFeatures: boolean;
  /** Set once a TERMINATE_IND was sent or received: the reason the host is given at the end. */
  terminating: number | null;
  /** The peer asked to terminate: close at the end of this event. */
  closeAfterEvent: number | null;
  cancelEvent: () => void;
  closed: boolean;
}

interface RxLock {
  header: BleAirHeader;
  until: number;
  heardAt: number;
  onMiss: () => void;
}

interface AdvState {
  intervalMs: number;
  type: number;
  ownRandom: boolean;
  channels: number[];
  filterPolicy: number;
  data: Uint8Array;
  scanRsp: Uint8Array;
  enabled: boolean;
  cancel: (() => void) | null;
  /** After an advertising PDU: requests may start in [from, until] on this channel. */
  listen: { channel: number; from: number; until: number } | null;
}

interface ScanParams {
  active: boolean;
  intervalMs: number;
  windowMs: number;
  ownRandom: boolean;
  filterPolicy: number;
}

interface Initiator {
  scan: ScanParams;
  acceptList: boolean;
  peer: Uint8Array;
  peerRandom: boolean;
  ownRandom: boolean;
  intervalUnits: number;
  latency: number;
  timeoutUnits: number;
}

export class BleController implements AirReceiver {
  readonly #o: BleControllerOptions;
  readonly #decoder = new H4Decoder();
  readonly #public: Uint8Array;
  #random: Uint8Array | null = null;
  #leHostSupported = false;
  readonly #warned = new Set<string>();
  readonly #acceptList = new Set<string>();
  readonly #conns = new Map<number, Connection>();
  #nextHandle = 1;
  #adv: AdvState = defaultAdv();
  #scan: ScanParams = {
    active: false,
    intervalMs: 10,
    windowMs: 10,
    ownRandom: false,
    filterPolicy: 0,
  };
  #scanEnabled = false;
  #filterDuplicates = false;
  readonly #seen = new Set<string>();
  #initiator: Initiator | null = null;
  #scanTimer: (() => void) | null = null;
  #scanChannel = 0;
  #scanWindow: { channel: number; until: number } | null = null;
  #awaitScanRsp: { channel: number; advA: string; until: number } | null = null;
  /** The connection whose event holds the radio. */
  #active: Connection | null = null;
  #txUntil = -Infinity;
  #rxLock: RxLock | null = null;
  readonly #timers = new Set<() => void>();
  #closed = false;

  constructor(options: BleControllerOptions) {
    this.#o = options;
    this.#public = Uint8Array.from(
      options.address.split(":").reverse().map((p) => Number.parseInt(p, 16)),
    );
  }

  get address(): string {
    return this.#o.address;
  }

  /** Bytes from the host's UART. Throws on a stream that is not H4, which ends the connection. */
  fromHost(chunk: Uint8Array): void {
    for (const packet of this.#decoder.push(chunk)) this.#handle(packet);
  }

  /** The run is over: stop every timer. */
  close(): void {
    this.#closed = true;
    for (const cancel of this.#timers) cancel();
    this.#timers.clear();
    for (const conn of this.#conns.values()) conn.cancelEvent();
  }

  // ── HCI ─────────────────────────────────────────────────────────────────

  #send(packet: HciPacket): void {
    if (!this.#closed) this.#o.toHost(encodeHci(packet));
  }

  #event(code: number, params: ArrayLike<number>): void {
    this.#send({ type: "event", code, params: Uint8Array.from(params) });
  }

  #complete(op: number, params: ArrayLike<number> = [STATUS.success]): void {
    this.#event(EVT.commandComplete, [1, ...u16(op), ...Array.from(params)]);
  }

  #status(op: number, status: number): void {
    this.#event(EVT.commandStatus, [status, 1, ...u16(op)]);
  }

  #leMeta(subevent: number, params: ArrayLike<number>): void {
    this.#event(EVT.leMeta, [subevent, ...Array.from(params)]);
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#o.warn(message);
  }

  #handle(packet: HciPacket): void {
    if (packet.type === "command") this.#command(packet.opcode, packet.params);
    else if (packet.type === "acl") this.#hostAcl(packet.handle, packet.pb, packet.data);
    else this.#warnOnce("host-event", "the host sent an HCI event, which only a controller sends");
  }

  /** Minimum parameter length of each command; a shorter one is answered 0x12. */
  static readonly #MIN_PARAMS: ReadonlyMap<number, number> = new Map([
    [OP.disconnect, 3],
    [OP.readRemoteVersion, 2],
    [OP.setEventMask, 8],
    [OP.setControllerToHostFlowControl, 1],
    [OP.hostBufferSize, 7],
    [OP.setEventMaskPage2, 8],
    [OP.writeLeHostSupport, 2],
    [OP.readLocalExtendedFeatures, 1],
    [OP.readRssi, 2],
    [OP.leSetEventMask, 8],
    [OP.leSetRandomAddress, 6],
    [OP.leSetAdvParams, 15],
    [OP.leSetAdvData, 1],
    [OP.leSetScanRspData, 1],
    [OP.leSetAdvEnable, 1],
    [OP.leSetScanParams, 7],
    [OP.leSetScanEnable, 2],
    [OP.leCreateConnection, 25],
    [OP.leAddToAcceptList, 7],
    [OP.leRemoveFromAcceptList, 7],
    [OP.leConnectionUpdate, 14],
    [OP.leReadRemoteFeatures, 2],
    [OP.leEncrypt, 32],
  ]);

  #command(op: number, p: Uint8Array): void {
    if (op === OP.hostNumberOfCompletedPackets) return; // no event unless it is malformed
    const min = BleController.#MIN_PARAMS.get(op);
    if (min !== undefined && p.length < min) {
      const statusOnly = op === OP.disconnect || op === OP.readRemoteVersion ||
        op === OP.leCreateConnection || op === OP.leConnectionUpdate ||
        op === OP.leReadRemoteFeatures;
      if (statusOnly) this.#status(op, STATUS.invalidParameters);
      else this.#complete(op, [STATUS.invalidParameters]);
      return;
    }
    switch (op) {
      case OP.reset:
        this.#reset();
        return this.#complete(op);
      case OP.setEventMask:
      case OP.setEventMaskPage2:
      case OP.leSetEventMask:
      case OP.setControllerToHostFlowControl:
      case OP.hostBufferSize:
        // Masks and host flow control are accepted and not enforced: every event is sent.
        return this.#complete(op);
      case OP.writeLeHostSupport:
        this.#leHostSupported = p[0] === 1;
        return this.#complete(op);
      case OP.readLeHostSupport:
        return this.#complete(op, [STATUS.success, this.#leHostSupported ? 1 : 0, 0]);
      case OP.readLocalVersion:
        return this.#complete(op, [
          STATUS.success,
          VERSION,
          ...u16(0),
          VERSION,
          ...u16(COMPANY_ID),
          ...u16(SUBVERSION),
        ]);
      case OP.readLocalCommands:
        return this.#complete(op, [STATUS.success, ...supportedCommands()]);
      case OP.readLocalFeatures:
        return this.#complete(op, [STATUS.success, ...LMP_FEATURES]);
      case OP.readLocalExtendedFeatures: {
        const page = p[0] as number;
        if (page > 1) {
          return this.#complete(op, [STATUS.invalidParameters, page, 1, ...new Uint8Array(8)]);
        }
        // Page 1 bit 1: "LE Supported (Host)", as Write LE Host Support set it.
        const features = page === 0
          ? LMP_FEATURES
          : Uint8Array.of(this.#leHostSupported ? 2 : 0, 0, 0, 0, 0, 0, 0, 0);
        return this.#complete(op, [STATUS.success, page, 1, ...features]);
      }
      case OP.readBufferSize:
        return this.#complete(op, [
          STATUS.success,
          ...u16(BLE_MAX_DATA_PAYLOAD),
          0,
          ...u16(LE_ACL_BUFFERS),
          ...u16(0),
        ]);
      case OP.readBdAddr:
        return this.#complete(op, [STATUS.success, ...this.#public]);
      case OP.readRssi: {
        const handle = readU16(p, 0);
        const conn = this.#conns.get(handle);
        if (!conn) return this.#complete(op, [STATUS.unknownConnection, ...u16(handle), 0]);
        return this.#complete(op, [STATUS.success, ...u16(handle), int8(conn.lastQuality.rssiDbm)]);
      }
      case OP.leReadBufferSize:
        return this.#complete(op, [STATUS.success, ...u16(BLE_MAX_DATA_PAYLOAD), LE_ACL_BUFFERS]);
      case OP.leReadLocalFeatures:
        return this.#complete(op, [STATUS.success, ...LE_FEATURES]);
      case OP.leReadSupportedStates:
        // Every state and combination of Vol 4 Part E §7.8.27, bits 0-41.
        return this.#complete(op, [STATUS.success, 0xff, 0xff, 0xff, 0xff, 0xff, 0x03, 0, 0]);
      case OP.leSetRandomAddress:
        this.#random = p.slice(0, 6);
        return this.#complete(op);
      case OP.leReadAdvTxPower:
        return this.#complete(op, [STATUS.success, int8(this.#o.txPowerDbm)]);
      case OP.leSetAdvParams:
        return this.#complete(op, [this.#setAdvParams(p)]);
      case OP.leSetAdvData:
        this.#adv.data = p.slice(1, 1 + Math.min(31, p[0] as number));
        return this.#complete(op);
      case OP.leSetScanRspData:
        this.#adv.scanRsp = p.slice(1, 1 + Math.min(31, p[0] as number));
        return this.#complete(op);
      case OP.leSetAdvEnable:
        return this.#complete(op, [this.#setAdvEnable(p[0] === 1)]);
      case OP.leSetScanParams:
        return this.#complete(op, [this.#setScanParams(p)]);
      case OP.leSetScanEnable:
        return this.#complete(op, [this.#setScanEnable(p[0] === 1, p[1] === 1)]);
      case OP.leCreateConnection:
        return this.#status(op, this.#createConnection(p));
      case OP.leCreateConnectionCancel:
        return this.#cancelCreateConnection();
      case OP.leReadAcceptListSize:
        return this.#complete(op, [STATUS.success, ACCEPT_LIST_SIZE]);
      case OP.leClearAcceptList:
        this.#acceptList.clear();
        return this.#complete(op);
      case OP.leAddToAcceptList:
        if (this.#acceptList.size >= ACCEPT_LIST_SIZE) return this.#complete(op, [0x07]);
        this.#acceptList.add(listKey(p[0] === 1, p.subarray(1, 7)));
        return this.#complete(op);
      case OP.leRemoveFromAcceptList:
        this.#acceptList.delete(listKey(p[0] === 1, p.subarray(1, 7)));
        return this.#complete(op);
      case OP.leConnectionUpdate:
        return this.#status(op, this.#connectionUpdate(p));
      case OP.leReadRemoteFeatures:
        return this.#status(op, this.#readRemoteFeatures(readU16(p, 0)));
      case OP.readRemoteVersion:
        return this.#status(op, this.#readRemoteVersion(readU16(p, 0)));
      case OP.disconnect:
        return this.#status(op, this.#disconnect(readU16(p, 0), p[2] as number));
      case OP.leRand: {
        const bytes = Array.from({ length: 8 }, () => this.#o.rng.int(256));
        return this.#complete(op, [STATUS.success, ...bytes]);
      }
      case OP.leEncrypt:
        void this.#encrypt(op, p);
        return;
      default:
        this.#warnOnce(
          `op:${op}`,
          `the host sent HCI command 0x${op.toString(16).padStart(4, "0")} (OGF 0x${
            (op >> 10).toString(16)
          }, ` +
            `OCF 0x${
              (op & 0x3ff).toString(16)
            }), which the virtual controller does not implement; ` +
            `answered "Unknown HCI Command"`,
        );
        return this.#complete(op, [STATUS.unknownCommand]);
    }
  }

  async #encrypt(op: number, p: Uint8Array): Promise<void> {
    // HCI carries the key and the block least significant octet first; AES wants them the other way round.
    const key = p.slice(0, 16).reverse();
    const block = p.slice(16, 32).reverse();
    const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
    // CBC with a zero IV over one block is ECB; the padding block that follows is dropped.
    const out = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, cryptoKey, block),
    ).slice(0, 16).reverse();
    this.#complete(op, [STATUS.success, ...out]);
  }

  #reset(): void {
    for (const conn of [...this.#conns.values()]) this.#forget(conn);
    this.#stopAdvertising();
    this.#adv = defaultAdv();
    this.#scanEnabled = false;
    this.#initiator = null;
    this.#updateScanner();
    this.#random = null;
    this.#acceptList.clear();
    this.#leHostSupported = false;
  }

  #ownAddress(random: boolean): Uint8Array {
    return random && this.#random ? this.#random : this.#public;
  }

  // ── advertising ─────────────────────────────────────────────────────────

  #setAdvParams(p: Uint8Array): number {
    if (this.#adv.enabled) return STATUS.commandDisallowed;
    const type = p[4] as number;
    if (type === 0x01 || type === 0x04) {
      this.#warnOnce(
        "directed-adv",
        "directed advertising is not modelled; the host's request was refused",
      );
      return STATUS.unsupportedParameter;
    }
    if (type > 0x04) return STATUS.invalidParameters;
    const ownType = p[5] as number;
    if (ownType > 1) {
      this.#warnOnce(
        "privacy",
        "resolvable private addresses are not modelled; using the identity address",
      );
    }
    const map = (p[13] as number) & 7;
    this.#adv = {
      ...this.#adv,
      intervalMs: readU16(p, 0) * 0.625,
      type,
      ownRandom: (ownType & 1) === 1,
      channels: BLE_ADV_CHANNELS.filter((_, i) => (map >> i) & 1),
      filterPolicy: p[14] as number,
    };
    return STATUS.success;
  }

  #setAdvEnable(enable: boolean): number {
    if (enable === this.#adv.enabled) return STATUS.success;
    if (!enable) {
      this.#stopAdvertising();
      return STATUS.success;
    }
    if (this.#adv.ownRandom && !this.#random) return STATUS.invalidParameters;
    if (this.#adv.channels.length === 0) return STATUS.invalidParameters;
    this.#adv.enabled = true;
    this.#later(0.1, () => this.#advEvent());
    return STATUS.success;
  }

  #stopAdvertising(): void {
    this.#adv.enabled = false;
    this.#adv.cancel?.();
    this.#adv.cancel = null;
    this.#adv.listen = null;
  }

  #advPduType(): number {
    return this.#adv.type === 0x02
      ? ADV_PDU.advScanInd
      : this.#adv.type === 0x03
      ? ADV_PDU.advNonconnInd
      : ADV_PDU.advInd;
  }

  #advEvent(): void {
    if (!this.#adv.enabled) return;
    const start = this.#o.clock.now();
    const channels = [...this.#adv.channels];
    const sendOn = (i: number) => {
      if (!this.#adv.enabled) return;
      const channel = channels[i];
      if (channel === undefined) {
        // advDelay: 0 to 10 ms of pseudo-random delay per event (Vol 6 Part B §4.4.2.2.1).
        const next = start + this.#adv.intervalMs + this.#o.rng.next() * 10;
        this.#adv.cancel = this.#at(next, () => this.#advEvent());
        return;
      }
      const busy = this.#active !== null || this.#o.clock.now() < this.#txUntil;
      let end = this.#o.clock.now();
      if (!busy) {
        const own = this.#ownAddress(this.#adv.ownRandom);
        const pdu = encodeAdvPdu({
          type: this.#advPduType(),
          txRandom: this.#adv.ownRandom,
          rxRandom: false,
          payload: Uint8Array.from([...own, ...this.#adv.data]),
        });
        end = this.#transmitAdv(channel, pdu);
        if (this.#advPduType() !== ADV_PDU.advNonconnInd) {
          this.#adv.listen = { channel, from: end, until: end + BLE_T_IFS_MS + RX_SLACK_MS };
        }
      }
      this.#adv.cancel = this.#at(end + ADV_CHANNEL_GAP_MS, () => sendOn(i + 1));
    };
    sendOn(0);
  }

  #onAdvRequest(pdu: AdvPdu, from: string, lock: RxLock, quality: ReceptionQuality): void {
    const own = this.#ownAddress(this.#adv.ownRandom);
    const reqEnd = lock.heardAt + bleAirtimeUs(2 + pdu.payload.length) / 1000;
    const channel = this.#adv.listen?.channel;
    if (channel === undefined) return;
    if (pdu.type === ADV_PDU.scanReq) {
      if (!sameAddress(pdu.payload.subarray(6, 12), own)) return;
      if (
        this.#adv.filterPolicy & 1 &&
        !this.#acceptList.has(listKey(pdu.txRandom, pdu.payload.subarray(0, 6)))
      ) return;
      this.#at(reqEnd + BLE_T_IFS_MS, () => {
        this.#transmitAdv(
          channel,
          encodeAdvPdu({
            type: ADV_PDU.scanRsp,
            txRandom: this.#adv.ownRandom,
            rxRandom: false,
            payload: Uint8Array.from([...own, ...this.#adv.scanRsp]),
          }),
        );
      });
      return;
    }
    if (pdu.type !== ADV_PDU.connectInd || this.#advPduType() !== ADV_PDU.advInd) return;
    const connect = parseConnectInd(pdu.payload);
    if (!connect || !sameAddress(connect.advA, own)) return;
    if (this.#adv.filterPolicy & 2 && !this.#acceptList.has(listKey(pdu.txRandom, connect.initA))) {
      return;
    }
    this.#stopAdvertising();
    this.#open("peripheral", from, connect.initA, pdu.txRandom, connect.params, reqEnd, quality);
  }

  #transmitAdv(channel: number, pdu: Uint8Array): number {
    return this.#transmit("ble-adv", channel, BLE_ADV_ACCESS_ADDRESS, BLE_ADV_CRC_INIT, pdu, null);
  }

  // ── scanning and initiating ─────────────────────────────────────────────

  #setScanParams(p: Uint8Array): number {
    if (this.#scanEnabled) return STATUS.commandDisallowed;
    const interval = readU16(p, 1);
    const window = readU16(p, 3);
    if (window > interval || window === 0) return STATUS.invalidParameters;
    this.#scan = {
      active: p[0] === 1,
      intervalMs: interval * 0.625,
      windowMs: window * 0.625,
      ownRandom: ((p[5] as number) & 1) === 1,
      filterPolicy: (p[6] as number) & 1,
    };
    return STATUS.success;
  }

  #setScanEnable(enable: boolean, filterDuplicates: boolean): number {
    if (enable && !this.#scanEnabled) this.#seen.clear();
    this.#scanEnabled = enable;
    this.#filterDuplicates = filterDuplicates;
    this.#updateScanner();
    return STATUS.success;
  }

  #createConnection(p: Uint8Array): number {
    if (this.#initiator) return STATUS.commandDisallowed;
    const interval = readU16(p, 0);
    const window = readU16(p, 2);
    if (window > interval || window === 0) return STATUS.invalidParameters;
    const ownType = p[12] as number;
    const intervalUnits = readU16(p, 13);
    const timeoutUnits = readU16(p, 19);
    if (intervalUnits < 6 || intervalUnits > 3200 || timeoutUnits < 10 || timeoutUnits > 3200) {
      return STATUS.invalidParameters;
    }
    this.#initiator = {
      scan: {
        active: false,
        intervalMs: interval * 0.625,
        windowMs: window * 0.625,
        ownRandom: (ownType & 1) === 1,
        filterPolicy: 0,
      },
      acceptList: p[4] === 1,
      peer: p.slice(6, 12),
      peerRandom: ((p[5] as number) & 1) === 1,
      ownRandom: (ownType & 1) === 1,
      intervalUnits,
      latency: readU16(p, 17),
      timeoutUnits,
    };
    this.#updateScanner();
    return STATUS.success;
  }

  #cancelCreateConnection(): void {
    if (!this.#initiator) {
      return this.#complete(OP.leCreateConnectionCancel, [STATUS.commandDisallowed]);
    }
    this.#initiator = null;
    this.#updateScanner();
    this.#complete(OP.leCreateConnectionCancel);
    this.#leMeta(LE_SUBEVENT.connectionComplete, [STATUS.unknownConnection, ...new Uint8Array(17)]);
  }

  /** (Re)start the scan windows with the initiator's timing, or the scanner's, or stop them. */
  #updateScanner(): void {
    this.#scanTimer?.();
    this.#scanTimer = null;
    this.#scanWindow = null;
    this.#awaitScanRsp = null;
    const params = this.#initiator?.scan ?? (this.#scanEnabled ? this.#scan : null);
    if (!params) return;
    const openWindow = () => {
      const now = this.#o.clock.now();
      const channel = BLE_ADV_CHANNELS[this.#scanChannel % 3] as number;
      this.#scanChannel++;
      this.#scanWindow = { channel, until: now + params.windowMs };
      this.#scanTimer = this.#at(now + params.intervalMs, openWindow);
    };
    openWindow();
  }

  #onAdvertising(
    pdu: AdvPdu,
    from: string,
    lock: RxLock,
    quality: ReceptionQuality,
    channel: number,
  ): void {
    const advA = pdu.payload.subarray(0, 6);
    const advEnd = lock.heardAt + bleAirtimeUs(2 + pdu.payload.length) / 1000;
    const init = this.#initiator;
    if (init && pdu.type === ADV_PDU.advInd) {
      const wanted = init.acceptList
        ? this.#acceptList.has(listKey(pdu.txRandom, advA))
        : sameAddress(advA, init.peer) && pdu.txRandom === init.peerRandom;
      if (wanted) {
        return this.#initiate(init, pdu.txRandom, advA.slice(), from, channel, advEnd, quality);
      }
    }
    if (!this.#scanEnabled) return;
    if (this.#scan.filterPolicy === 1 && !this.#acceptList.has(listKey(pdu.txRandom, advA))) return;
    const eventType = pdu.type === ADV_PDU.advInd
      ? 0x00
      : pdu.type === ADV_PDU.advScanInd
      ? 0x02
      : pdu.type === ADV_PDU.advNonconnInd
      ? 0x03
      : pdu.type === ADV_PDU.scanRsp
      ? 0x04
      : -1;
    if (eventType < 0) return;
    this.#report(eventType, pdu.txRandom, advA, pdu.payload.subarray(6), quality);
    if (!this.#scan.active || (pdu.type !== ADV_PDU.advInd && pdu.type !== ADV_PDU.advScanInd)) {
      return;
    }
    const own = this.#ownAddress(this.#scan.ownRandom);
    const req = encodeAdvPdu({
      type: ADV_PDU.scanReq,
      txRandom: this.#scan.ownRandom,
      rxRandom: pdu.txRandom,
      payload: Uint8Array.from([...own, ...advA]),
    });
    this.#at(advEnd + BLE_T_IFS_MS, () => {
      if (!this.#scanEnabled || this.#active) return;
      const end = this.#transmitAdv(channel, req);
      this.#awaitScanRsp = {
        channel,
        advA: addressToString(advA),
        until: end + BLE_T_IFS_MS + RX_SLACK_MS,
      };
    });
  }

  #report(
    eventType: number,
    random: boolean,
    address: Uint8Array,
    data: Uint8Array,
    quality: ReceptionQuality,
  ): void {
    const key = `${eventType}/${listKey(random, address)}`;
    if (this.#filterDuplicates && this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#leMeta(LE_SUBEVENT.advertisingReport, [
      1,
      eventType,
      random ? 1 : 0,
      ...address,
      data.length,
      ...data,
      int8(quality.rssiDbm),
    ]);
  }

  #initiate(
    init: Initiator,
    peerRandom: boolean,
    peer: Uint8Array,
    peerNode: string,
    channel: number,
    advEnd: number,
    quality: ReceptionQuality,
  ): void {
    this.#initiator = null;
    this.#updateScanner();
    const intervalMs = init.intervalUnits * 1.25;
    const params: ConnectParams = {
      accessAddress: this.#accessAddress(),
      crcInit: this.#o.rng.int(0x1000000),
      winSize: 2,
      winOffset: this.#windowOffset(intervalMs, advEnd),
      interval: init.intervalUnits,
      latency: init.latency,
      timeout: init.timeoutUnits,
      channelMap: Array.from({ length: 37 }, (_, i) => i),
      hop: 5 + this.#o.rng.int(12),
      sca: 0,
    };
    const own = this.#ownAddress(init.ownRandom);
    const pdu = encodeAdvPdu({
      type: ADV_PDU.connectInd,
      txRandom: init.ownRandom,
      rxRandom: peerRandom,
      payload: encodeConnectInd(own, peer, params),
    });
    this.#at(advEnd + BLE_T_IFS_MS, () => {
      const end = this.#transmitAdv(channel, pdu);
      this.#open("central", peerNode, peer, peerRandom, params, end, quality);
    });
  }

  /** A random access address; the spec's bit-pattern rules are not checked (nothing on this air depends on them). */
  #accessAddress(): number {
    for (;;) {
      const aa = (this.#o.rng.int(0x10000) | (this.#o.rng.int(0x10000) << 16)) >>> 0;
      if (aa !== BLE_ADV_ACCESS_ADDRESS) return aa;
    }
  }

  /**
   * A transmit window offset that keeps this connection's anchors at least
   * 3 ms from those of the controller's other connections, when their
   * intervals are equal, so their events do not take each other's turns.
   */
  #windowOffset(intervalMs: number, advEnd: number): number {
    // CONNECT_IND: a 2-byte header and 34 bytes of payload.
    const base = advEnd + BLE_T_IFS_MS + bleAirtimeUs(36) / 1000 + TRANSMIT_WINDOW_DELAY_MS;
    const others = [...this.#conns.values()].filter((c) =>
      Math.abs(c.intervalMs - intervalMs) < 1e-9
    );
    const steps = Math.floor(intervalMs / 1.25);
    for (let k = 0; k < steps; k++) {
      const anchor = base + k * 1.25;
      const clear = others.every((c) => {
        const d = (((anchor - c.anchorMs) % intervalMs) + intervalMs) % intervalMs;
        return Math.min(d, intervalMs - d) >= 3;
      });
      if (clear) return k;
    }
    return 0;
  }

  // ── connections ─────────────────────────────────────────────────────────

  #open(
    role: "central" | "peripheral",
    peerNode: string,
    peerAddress: Uint8Array,
    peerRandom: boolean,
    params: ConnectParams,
    connectIndEnd: number,
    quality: ReceptionQuality,
  ): void {
    const handle = this.#nextHandle++;
    const intervalMs = params.interval * 1.25;
    const conn: Connection = {
      handle,
      role,
      peerNode,
      peerAddress,
      peerRandom,
      aa: params.accessAddress,
      crcInit: params.crcInit,
      intervalMs,
      intervalUnits: params.interval,
      latency: params.latency,
      timeoutMs: params.timeout * 10,
      timeoutUnits: params.timeout,
      channelMap: params.channelMap,
      hop: params.hop,
      lastUnmapped: 0,
      channel: 0,
      eventCounter: 0,
      anchorMs: connectIndEnd + TRANSMIT_WINDOW_DELAY_MS + params.winOffset * 1.25,
      createdMs: connectIndEnd,
      established: false,
      lastRxMs: connectIndEnd,
      lastQuality: quality,
      sn: 0,
      nesn: 0,
      unacked: null,
      queue: [],
      peerMd: false,
      expectUntil: null,
      pendingUpdate: null,
      versionSent: false,
      peerVersion: null,
      hostWantsVersion: false,
      hostWantsFeatures: false,
      terminating: null,
      closeAfterEvent: null,
      cancelEvent: () => {},
      closed: false,
    };
    this.#conns.set(handle, conn);
    this.#leMeta(LE_SUBEVENT.connectionComplete, [
      STATUS.success,
      ...u16(handle),
      role === "central" ? 0 : 1,
      peerRandom ? 1 : 0,
      ...peerAddress,
      ...u16(params.interval),
      ...u16(params.latency),
      ...u16(params.timeout),
      0,
    ]);
    this.#o.log.append({
      type: "ble-link",
      t: this.#o.clock.now(),
      node: this.#o.nodeId,
      peer: peerNode,
      role,
      state: "up",
      reason: null,
      intervalMs,
    });
    this.#scheduleEvent(conn);
  }

  #scheduleEvent(conn: Connection): void {
    const at = conn.role === "central" ? conn.anchorMs : conn.anchorMs - RX_SLACK_MS;
    conn.cancelEvent = this.#at(at, () => this.#eventStart(conn));
  }

  #eventStart(conn: Connection): void {
    if (conn.closed) return;
    const now = this.#o.clock.now();
    const update = conn.pendingUpdate;
    if (update && update.instant === conn.eventCounter) {
      conn.pendingUpdate = null;
      conn.intervalUnits = update.intervalUnits;
      conn.intervalMs = update.intervalUnits * 1.25;
      conn.latency = update.latency;
      conn.timeoutUnits = update.timeoutUnits;
      conn.timeoutMs = update.timeoutUnits * 10;
      this.#leMeta(LE_SUBEVENT.connectionUpdateComplete, [
        STATUS.success,
        ...u16(conn.handle),
        ...u16(conn.intervalUnits),
        ...u16(conn.latency),
        ...u16(conn.timeoutUnits),
      ]);
    }
    if (!conn.established && conn.eventCounter >= 6) {
      return this.#close(conn, STATUS.connectionFailedToEstablish);
    }
    if (now - conn.lastRxMs >= conn.timeoutMs) {
      return this.#close(conn, conn.terminating ?? STATUS.connectionTimeout);
    }
    const next = bleNextDataChannel(conn.lastUnmapped, conn.hop, conn.channelMap);
    conn.lastUnmapped = next.unmapped;
    conn.channel = next.channel;
    if (this.#active !== null || now < this.#txUntil || this.#rxLock !== null) {
      // The radio is in another connection's event or a reception: this event is missed.
      return this.#finishEvent(conn);
    }
    this.#active = conn;
    if (conn.role === "central") this.#centralSend(conn);
    else this.#expect(conn, conn.anchorMs + RX_SLACK_MS);
  }

  /** Listen for the peer's next packet, which must start by `until`. */
  #expect(conn: Connection, until: number): void {
    conn.expectUntil = until;
    this.#at(until, () => {
      if (conn.expectUntil === until && this.#rxLock === null) this.#endEvent(conn);
    });
  }

  #nextItem(conn: Connection): TxItem {
    if (!conn.unacked) conn.unacked = conn.queue[0] ?? EMPTY_PDU;
    return conn.unacked;
  }

  #sendData(conn: Connection): number {
    const item = this.#nextItem(conn);
    const pending = conn.queue.length - (conn.queue[0] === item ? 1 : 0);
    const pdu = encodeDataPdu({
      llid: item.llid,
      nesn: conn.nesn,
      sn: conn.sn,
      md: pending > 0,
      payload: item.payload,
    });
    if (item.acl) item.acl.transmissions++;
    return this.#transmit(
      "ble-data",
      conn.channel,
      conn.aa,
      conn.crcInit,
      pdu,
      item.last ? item.acl : null,
    );
  }

  #centralSend(conn: Connection): void {
    const end = this.#sendData(conn);
    this.#expect(conn, end + BLE_T_IFS_MS + RX_SLACK_MS);
  }

  #onData(
    conn: Connection,
    pdu: DataPdu,
    frame: AirFrame<BleAirHeader>,
    from: string,
    lock: RxLock,
    quality: ReceptionQuality,
  ): void {
    const now = this.#o.clock.now();
    conn.expectUntil = null;
    conn.established = true;
    conn.lastRxMs = now;
    conn.lastQuality = quality;
    if (pdu.nesn !== conn.sn && conn.unacked) {
      const acked = conn.unacked;
      conn.unacked = null;
      conn.sn ^= 1;
      if (acked !== EMPTY_PDU) {
        conn.queue.shift();
        if (acked.last && acked.acl) {
          this.#event(EVT.numberOfCompletedPackets, [1, ...u16(conn.handle), ...u16(1)]);
        }
        acked.onAcked?.();
        if (conn.closed) return;
      }
    }
    if (pdu.sn === conn.nesn) {
      conn.nesn ^= 1;
      if (pdu.llid === LLID.control) this.#onControl(conn, pdu.payload);
      else if (pdu.payload.length > 0) {
        // PB 0b10 starts an L2CAP message, 0b01 continues one.
        this.#send({
          type: "acl",
          handle: conn.handle,
          pb: pdu.llid === LLID.start ? 2 : 1,
          data: pdu.payload,
        });
        const acl = frame.header.acl;
        if (acl && !acl.delivered) {
          acl.delivered = true;
          this.#o.log.append({
            type: "deliver",
            t: now,
            from,
            to: this.#o.nodeId,
            bytes: acl.bytes,
            kind: "ble-acl",
            delayMs: now - acl.enqueuedMs,
            attempts: acl.transmissions,
            rateMbps: BLE_RATE_BPS / 1e6,
            rssiDbm: quality.rssiDbm,
            snrDb: quality.snrDb,
          });
        }
      }
    }
    if (conn.closed) return;
    conn.peerMd = pdu.md;
    const moreFromUs = conn.queue.length > 0;
    const end = lock.heardAt + frame.airtimeMs;
    if (conn.role === "peripheral") {
      this.#at(end + BLE_T_IFS_MS, () => {
        if (conn.closed || this.#active !== conn) return;
        const replyEnd = this.#sendData(conn);
        if (conn.closeAfterEvent !== null) {
          const reason = conn.closeAfterEvent;
          this.#at(replyEnd, () => this.#close(conn, reason));
        } else if (conn.peerMd || conn.queue.length > 0) {
          this.#expect(conn, replyEnd + BLE_T_IFS_MS + RX_SLACK_MS);
        } else this.#at(replyEnd, () => this.#endEvent(conn));
      });
      return;
    }
    if (conn.closeAfterEvent !== null) return this.#close(conn, conn.closeAfterEvent);
    // Room for one more exchange of full packets before the next anchor?
    const full = bleAirtimeUs(2 + BLE_MAX_DATA_PAYLOAD) / 1000;
    const room =
      end + 2 * (BLE_T_IFS_MS + full) + 3 * RX_SLACK_MS < conn.anchorMs + conn.intervalMs;
    if ((moreFromUs || conn.peerMd) && room) {
      this.#at(end + BLE_T_IFS_MS, () => {
        if (!conn.closed && this.#active === conn) this.#centralSend(conn);
      });
    } else this.#endEvent(conn);
  }

  #endEvent(conn: Connection): void {
    if (this.#active === conn) this.#active = null;
    conn.expectUntil = null;
    if (conn.closed) return;
    if (conn.closeAfterEvent !== null) return this.#close(conn, conn.closeAfterEvent);
    this.#finishEvent(conn);
  }

  #finishEvent(conn: Connection): void {
    conn.anchorMs += conn.intervalMs;
    conn.eventCounter = (conn.eventCounter + 1) & 0xffff;
    this.#scheduleEvent(conn);
  }

  #enqueueControl(conn: Connection, payload: number[], onAcked?: () => void): void {
    const item: TxItem = {
      llid: LLID.control,
      payload: Uint8Array.from(payload),
      acl: null,
      last: false,
      onAcked,
    };
    // Control PDUs go ahead of queued data, behind the packet in flight and earlier control PDUs.
    let index = conn.unacked && conn.queue[0] === conn.unacked ? 1 : 0;
    while (index < conn.queue.length && conn.queue[index]?.llid === LLID.control) index++;
    conn.queue.splice(index, 0, item);
  }

  #onControl(conn: Connection, payload: Uint8Array): void {
    const opcode = payload[0];
    switch (opcode) {
      case LL_CTRL.versionInd:
        conn.peerVersion = payload.slice(1, 6);
        if (!conn.versionSent) this.#sendVersion(conn);
        if (conn.hostWantsVersion) this.#versionComplete(conn);
        return;
      case LL_CTRL.featureReq:
      case LL_CTRL.peripheralFeatureReq:
        return this.#enqueueControl(conn, [LL_CTRL.featureRsp, ...LE_FEATURES]);
      case LL_CTRL.featureRsp:
        if (conn.hostWantsFeatures) {
          conn.hostWantsFeatures = false;
          this.#leMeta(LE_SUBEVENT.readRemoteFeaturesComplete, [
            STATUS.success,
            ...u16(conn.handle),
            ...payload.slice(1, 9),
          ]);
        }
        return;
      case LL_CTRL.terminateInd:
        conn.terminating = payload[1] ?? STATUS.remoteUserTerminated;
        conn.closeAfterEvent = conn.terminating;
        return;
      case LL_CTRL.connectionUpdateInd: {
        const instant = readU16(payload, 10);
        if (((instant - conn.eventCounter) & 0xffff) >= 0x8000) {
          conn.closeAfterEvent = STATUS.instantPassed;
          return;
        }
        conn.pendingUpdate = {
          instant,
          intervalUnits: readU16(payload, 4),
          latency: readU16(payload, 6),
          timeoutUnits: readU16(payload, 8),
        };
        return;
      }
      case LL_CTRL.unknownRsp:
        return;
      default:
        return this.#enqueueControl(conn, [LL_CTRL.unknownRsp, opcode ?? 0]);
    }
  }

  #sendVersion(conn: Connection): void {
    conn.versionSent = true;
    this.#enqueueControl(conn, [
      LL_CTRL.versionInd,
      VERSION,
      ...u16(COMPANY_ID),
      ...u16(SUBVERSION),
    ]);
  }

  #versionComplete(conn: Connection): void {
    conn.hostWantsVersion = false;
    const v = conn.peerVersion ?? new Uint8Array(5);
    this.#event(EVT.readRemoteVersionComplete, [STATUS.success, ...u16(conn.handle), ...v]);
  }

  #readRemoteVersion(handle: number): number {
    const conn = this.#conns.get(handle);
    if (!conn) return STATUS.unknownConnection;
    conn.hostWantsVersion = true;
    if (conn.peerVersion) this.#later(0, () => this.#versionComplete(conn));
    else if (!conn.versionSent) this.#sendVersion(conn);
    return STATUS.success;
  }

  #readRemoteFeatures(handle: number): number {
    const conn = this.#conns.get(handle);
    if (!conn) return STATUS.unknownConnection;
    conn.hostWantsFeatures = true;
    this.#enqueueControl(conn, [
      conn.role === "central" ? LL_CTRL.featureReq : LL_CTRL.peripheralFeatureReq,
      ...LE_FEATURES,
    ]);
    return STATUS.success;
  }

  #connectionUpdate(p: Uint8Array): number {
    const conn = this.#conns.get(readU16(p, 0));
    if (!conn) return STATUS.unknownConnection;
    // A peripheral would need the connection parameters request procedure, which this controller does not offer.
    if (conn.role !== "central") return STATUS.unsupportedRemoteFeature;
    const intervalUnits = readU16(p, 4);
    const latency = readU16(p, 6);
    const timeoutUnits = readU16(p, 8);
    if (intervalUnits < 6 || intervalUnits > 3200 || timeoutUnits < 10 || timeoutUnits > 3200) {
      return STATUS.invalidParameters;
    }
    const instant = (conn.eventCounter + 6) & 0xffff;
    conn.pendingUpdate = { instant, intervalUnits, latency, timeoutUnits };
    this.#enqueueControl(conn, [
      LL_CTRL.connectionUpdateInd,
      1,
      ...u16(0),
      ...u16(intervalUnits),
      ...u16(latency),
      ...u16(timeoutUnits),
      ...u16(instant),
    ]);
    return STATUS.success;
  }

  #disconnect(handle: number, reason: number): number {
    const conn = this.#conns.get(handle);
    if (!conn || conn.terminating !== null) {
      return conn ? STATUS.commandDisallowed : STATUS.unknownConnection;
    }
    conn.terminating = STATUS.localHostTerminated;
    this.#enqueueControl(conn, [LL_CTRL.terminateInd, reason], () => {
      conn.closeAfterEvent = STATUS.localHostTerminated;
    });
    return STATUS.success;
  }

  #hostAcl(handle: number, pb: number, data: Uint8Array): void {
    const conn = this.#conns.get(handle);
    if (!conn) {
      this.#warnOnce(
        `acl:${handle}`,
        `the host sent ACL data on handle 0x${handle.toString(16)}, which has no connection`,
      );
      return;
    }
    const acl: AclItem = {
      bytes: data.length,
      enqueuedMs: this.#o.clock.now(),
      transmissions: 0,
      delivered: false,
    };
    const fragments = Math.max(1, Math.ceil(data.length / BLE_MAX_DATA_PAYLOAD));
    for (let i = 0; i < fragments; i++) {
      conn.queue.push({
        llid: i === 0 && pb !== 1 ? LLID.start : LLID.continuation,
        payload: data.slice(i * BLE_MAX_DATA_PAYLOAD, (i + 1) * BLE_MAX_DATA_PAYLOAD),
        acl,
        last: i === fragments - 1,
      });
    }
  }

  /** The connection is gone: tell the host, log it, and count the data that never arrived. */
  #close(conn: Connection, reason: number): void {
    if (conn.closed) return;
    this.#forget(conn);
    const now = this.#o.clock.now();
    for (const item of conn.queue) {
      if (!item.last || !item.acl || item.acl.delivered) continue;
      this.#o.log.append({
        type: "drop",
        t: now,
        from: this.#o.nodeId,
        to: conn.peerNode,
        bytes: item.acl.bytes,
        kind: "ble-acl",
        reason: "link_lost",
        attempts: item.acl.transmissions,
        rssiDbm: conn.lastQuality.rssiDbm,
        snrDb: conn.lastQuality.snrDb,
      });
    }
    this.#event(EVT.disconnectionComplete, [STATUS.success, ...u16(conn.handle), reason]);
    this.#o.log.append({
      type: "ble-link",
      t: now,
      node: this.#o.nodeId,
      peer: conn.peerNode,
      role: conn.role,
      state: "down",
      reason,
      intervalMs: conn.intervalMs,
    });
  }

  /** Drop a connection without telling anyone (HCI Reset, or the first step of #close). */
  #forget(conn: Connection): void {
    conn.closed = true;
    conn.cancelEvent();
    this.#conns.delete(conn.handle);
    if (this.#active === conn) this.#active = null;
  }

  // ── the air ─────────────────────────────────────────────────────────────

  #transmit(
    kind: "ble-adv" | "ble-data",
    channel: number,
    accessAddress: number,
    crcInit: number,
    pdu: Uint8Array,
    acl: AclItem | null,
  ): number {
    const airtimeMs = bleAirtimeUs(pdu.length) / 1000;
    const now = this.#o.clock.now();
    this.#txUntil = now + airtimeMs;
    const header: BleAirHeader = { channel, accessAddress, crcInit, acl };
    const parsed = kind === "ble-adv" ? parseAdvPdu(pdu) : null;
    this.#o.transmit({
      kind,
      payload: pdu,
      airtimeMs,
      frequencyHz: bleChannelFrequencyHz(channel),
      bandwidthHz: BLE_BANDWIDTH_HZ,
      noiseFigureDb: BLE_NOISE_FIGURE_DB,
      requiredSnrDb: bleRequiredSnrDb(),
      referenceBytes: BLE_REFERENCE_BYTES,
      captureDb: BLE_CAPTURE_DB,
      txPowerDbm: this.#o.txPowerDbm,
      interferenceKey: `ble:${channel}`,
      rateBps: BLE_RATE_BPS,
      dst: "",
      src: this.#o.address,
      params: {
        channel,
        pdu: parsed ? ADV_PDU_NAMES[parsed.type] ?? "unknown" : "data",
        access_address: `0x${(accessAddress >>> 0).toString(16).padStart(8, "0")}`,
      },
      header,
    });
    return now + airtimeMs;
  }

  hear(frame: AirFrame, _from: string): Hearing {
    if (!isBleFrame(frame) || this.#closed) return "deaf";
    const now = this.#o.clock.now();
    if (now < this.#txUntil || this.#rxLock !== null) return "deaf";
    const h = frame.header;
    if (h.accessAddress !== BLE_ADV_ACCESS_ADDRESS) {
      const conn = this.#active;
      if (!conn || conn.expectUntil === null || now > conn.expectUntil) return "deaf";
      if (h.accessAddress !== conn.aa || h.channel !== conn.channel) return "deaf";
      return this.#lock(frame, () => this.#endEvent(conn));
    }
    if (this.#active) return "deaf";
    const pdu = parseAdvPdu(frame.payload);
    if (!pdu) return "deaf";
    const listen = this.#adv.listen;
    if (
      listen && h.channel === listen.channel && now >= listen.from && now <= listen.until &&
      (pdu.type === ADV_PDU.scanReq || pdu.type === ADV_PDU.connectInd) &&
      sameAddress(pdu.payload.subarray(6, 12), this.#ownAddress(this.#adv.ownRandom))
    ) {
      return this.#lock(frame, () => {});
    }
    const awaiting = this.#awaitScanRsp;
    if (awaiting && h.channel === awaiting.channel && now <= awaiting.until) {
      if (pdu.type !== ADV_PDU.scanRsp) return "deaf";
      return this.#lock(frame, () => {
        this.#awaitScanRsp = null;
      });
    }
    const window = this.#scanWindow;
    if (window && h.channel === window.channel && now < window.until) {
      const advertising = pdu.type === ADV_PDU.advInd || pdu.type === ADV_PDU.advScanInd ||
        pdu.type === ADV_PDU.advNonconnInd;
      if (advertising) return this.#lock(frame, () => {});
    }
    return "deaf";
  }

  #lock(frame: AirFrame<BleAirHeader>, onMiss: () => void): Hearing {
    const now = this.#o.clock.now();
    const lock: RxLock = {
      header: frame.header,
      heardAt: now,
      until: now + frame.airtimeMs + RX_SLACK_MS,
      onMiss,
    };
    this.#rxLock = lock;
    this.#at(lock.until, () => {
      if (this.#rxLock !== lock) return;
      this.#rxLock = null;
      lock.onMiss();
    });
    return "listen";
  }

  receive(frame: AirFrame, from: string, quality: ReceptionQuality): boolean {
    const lock = this.#rxLock;
    if (!isBleFrame(frame) || !lock || lock.header !== frame.header || this.#closed) return false;
    this.#rxLock = null;
    const h = frame.header;
    if (h.accessAddress !== BLE_ADV_ACCESS_ADDRESS) {
      const conn = this.#active;
      const pdu = parseDataPdu(frame.payload);
      if (!conn || !pdu || conn.aa !== h.accessAddress) return false;
      this.#onData(conn, pdu, frame, from, lock, quality);
      return true;
    }
    const pdu = parseAdvPdu(frame.payload);
    if (!pdu) return false;
    if (pdu.type === ADV_PDU.scanReq || pdu.type === ADV_PDU.connectInd) {
      this.#onAdvRequest(pdu, from, lock, quality);
    } else if (pdu.type === ADV_PDU.scanRsp) {
      const awaiting = this.#awaitScanRsp;
      this.#awaitScanRsp = null;
      if (awaiting && awaiting.advA === addressToString(pdu.payload.subarray(0, 6))) {
        this.#onAdvertising(pdu, from, lock, quality, h.channel);
      }
    } else this.#onAdvertising(pdu, from, lock, quality, h.channel);
    return true;
  }

  // ── timers ──────────────────────────────────────────────────────────────

  #at(atMs: number, fn: () => void): () => void {
    const cancel = this.#o.clock.schedule(atMs, () => {
      this.#timers.delete(cancel);
      if (!this.#closed) fn();
    });
    this.#timers.add(cancel);
    return () => {
      cancel();
      this.#timers.delete(cancel);
    };
  }

  #later(delayMs: number, fn: () => void): void {
    this.#at(this.#o.clock.now() + delayMs, fn);
  }
}

const ADV_PDU_NAMES: Record<number, string> = {
  [ADV_PDU.advInd]: "ADV_IND",
  [ADV_PDU.advDirectInd]: "ADV_DIRECT_IND",
  [ADV_PDU.advNonconnInd]: "ADV_NONCONN_IND",
  [ADV_PDU.scanReq]: "SCAN_REQ",
  [ADV_PDU.scanRsp]: "SCAN_RSP",
  [ADV_PDU.connectInd]: "CONNECT_IND",
  [ADV_PDU.advScanInd]: "ADV_SCAN_IND",
};

function defaultAdv(): AdvState {
  // Vol 4 Part E §7.8.5 defaults: 1.28 s, ADV_IND, public address, all three channels.
  return {
    intervalMs: 1280,
    type: 0,
    ownRandom: false,
    channels: [...BLE_ADV_CHANNELS],
    filterPolicy: 0,
    data: EMPTY,
    scanRsp: EMPTY,
    enabled: false,
    cancel: null,
    listen: null,
  };
}

function listKey(random: boolean, address: Uint8Array): string {
  return `${random ? 1 : 0}/${addressToString(address)}`;
}

function sameAddress(a: Uint8Array, b: Uint8Array): boolean {
  return a.length >= 6 && b.length >= 6 && a.subarray(0, 6).every((v, i) => v === b[i]);
}

function int8(value: number): number {
  return Math.max(-127, Math.min(20, Math.round(value))) & 0xff;
}
