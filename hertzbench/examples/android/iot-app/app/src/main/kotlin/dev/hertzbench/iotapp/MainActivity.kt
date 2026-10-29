package dev.hertzbench.iotapp

import android.app.Activity
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

private const val TAG = "HZB"
private const val BOARD_URL_EXTRA = "board_url"
private const val POLL_INTERVAL_MS = 1000L
private const val TIMEOUT_MS = 3000

/**
 * Asks the board for GET /status once a second and logs the outcome under the HZB tag, which a
 * Hertzbench scenario turns into serial lines of the phone node. The board's address comes from the
 * board_url launch extra (`am start --es board_url http://192.168.4.11/`, the scenario's
 * `android.extras`).
 */
class MainActivity : Activity() {
    @Volatile
    private var poller: Thread? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val screen = TextView(this)
        setContentView(screen)
        val base = intent.getStringExtra(BOARD_URL_EXTRA)
        if (base == null) {
            report(screen, "no $BOARD_URL_EXTRA extra; nothing to poll")
            return
        }
        val url = URL(base.trimEnd('/') + "/status")
        report(screen, "polling $url every $POLL_INTERVAL_MS ms")
        poller = thread(name = "hzb-poller") {
            try {
                while (!Thread.currentThread().isInterrupted) {
                    report(screen, poll(url))
                    Thread.sleep(POLL_INTERVAL_MS)
                }
            } catch (_: InterruptedException) {
                // onDestroy asked the poller to stop.
            }
        }
    }

    override fun onDestroy() {
        poller?.interrupt()
        super.onDestroy()
    }

    private fun report(screen: TextView, line: String) {
        Log.i(TAG, line)
        runOnUiThread { screen.text = line }
    }

    /** One request, as the line to log: `status ok 200 <first line of the body>`, or why it failed. */
    private fun poll(url: URL): String {
        val network = wifiNetwork() ?: return "status failed: no Wi-Fi network"
        return try {
            val connection = network.openConnection(url) as HttpURLConnection
            try {
                connection.connectTimeout = TIMEOUT_MS
                connection.readTimeout = TIMEOUT_MS
                val code = connection.responseCode
                if (code == 200) {
                    "status ok 200 " + connection.inputStream.bufferedReader().readLine().orEmpty()
                } else {
                    "status http $code"
                }
            } finally {
                connection.disconnect()
            }
        } catch (e: IOException) {
            "status failed: ${e.javaClass.simpleName} ${e.message.orEmpty().replace('\n', ' ')}"
        }
    }

    /**
     * The request goes out on Wi-Fi explicitly: the board is only on the simulated Wi-Fi, and
     * Android may keep the default network on the emulator's mobile "radio" link because this
     * Wi-Fi has no internet. A GET over the default network would test the wrong path.
     */
    @Suppress("DEPRECATION")
    private fun wifiNetwork(): Network? {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        return connectivity.allNetworks.firstOrNull {
            connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        }
    }
}
