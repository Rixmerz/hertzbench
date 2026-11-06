package dev.hertzbench.bleapp

import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.TextView
import java.util.UUID

private const val TAG = "HZB"
private const val NAME_EXTRA = "device_name"
private const val DEFAULT_NAME = "hzb sensor-1"
private const val READ_INTERVAL_MS = 1000L
private const val RECONNECT_DELAY_MS = 2000L
private val SERVICE: UUID = UUID.fromString("0000ff00-0000-1000-8000-00805f9b34fb")
private val CHARACTERISTIC: UUID = UUID.fromString("0000ff01-0000-1000-8000-00805f9b34fb")
private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

/**
 * Scans for the device the Hertzbench BLE bridge advertises (the device_name launch extra, default
 * "hzb sensor-1"), connects, subscribes to characteristic 0xFF01 of service 0xFF00 and reads it once
 * a second. Every step is logged under the HZB tag, which a scenario turns into serial lines of the
 * bridge's id. Permissions are expected to be granted at install (`adb install -g`).
 */
@SuppressLint("MissingPermission")
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var screen: TextView
    private lateinit var name: String
    private var gatt: BluetoothGatt? = null
    private var characteristic: BluetoothGattCharacteristic? = null
    private var scanning = false
    private var stopped = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        screen = TextView(this)
        setContentView(screen)
        name = intent.getStringExtra(NAME_EXTRA) ?: DEFAULT_NAME
        startScan()
    }

    override fun onDestroy() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        stopScan()
        gatt?.close()
        super.onDestroy()
    }

    private val adapter get() = getSystemService(BluetoothManager::class.java).adapter

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val found = result.scanRecord?.deviceName ?: result.device.name
            if (found != name || !scanning) return
            report("found \"$found\" ${result.device.address} rssi=${result.rssi}")
            stopScan()
            connect(result.device)
        }

        override fun onScanFailed(errorCode: Int) {
            report("scan failed: error $errorCode")
            scanning = false
            retryLater()
        }
    }

    private fun startScan() {
        if (stopped) return
        val bt = adapter
        if (bt == null || !bt.isEnabled) {
            report("bluetooth is off; retrying")
            retryLater()
            return
        }
        report("scanning for \"$name\"")
        scanning = true
        // No name filter: netsim may put the name in the scan response only, so match in the callback.
        bt.bluetoothLeScanner.startScan(
            listOf<ScanFilter>(),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
            scanCallback,
        )
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        adapter?.bluetoothLeScanner?.stopScan(scanCallback)
    }

    private fun retryLater() {
        if (!stopped) handler.postDelayed({ startScan() }, RECONNECT_DELAY_MS)
    }

    private fun connect(device: BluetoothDevice) {
        gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                report("connected status=$status")
                g.discoverServices()
            } else {
                report("disconnected status=$status")
                handler.removeCallbacks(readTick)
                characteristic = null
                g.close()
                gatt = null
                retryLater()
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val c = g.getService(SERVICE)?.getCharacteristic(CHARACTERISTIC)
            if (c == null) {
                report("service 0xFF00 / characteristic 0xFF01 not found (status=$status)")
                g.disconnect()
                return
            }
            report("services discovered")
            characteristic = c
            g.setCharacteristicNotification(c, true)
            val cccd = c.getDescriptor(CCCD)
            if (cccd == null) {
                handler.post(readTick)
            } else {
                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            report("subscribed status=$status")
            handler.post(readTick)
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                report("got reading \"${String(value)}\"")
            } else {
                report("read failed status=$status")
            }
            handler.postDelayed(readTick, READ_INTERVAL_MS)
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            report("got notification \"${String(value)}\"")
        }
    }

    private val readTick: Runnable = object : Runnable {
        override fun run() {
            val g = gatt
            val c = characteristic
            if (g != null && c != null && !g.readCharacteristic(c)) {
                report("read could not start; retrying")
                handler.postDelayed(this, READ_INTERVAL_MS)
            }
        }
    }

    private fun report(line: String) {
        Log.i(TAG, line)
        runOnUiThread { screen.text = line }
    }
}
