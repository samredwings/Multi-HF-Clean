package com.samredwings.multihf

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Process
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.system.exitProcess

/** WebView shell for the shared PWA. Native file and crash operations are bridged asynchronously. */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var permissionCallbackId: String? = null
    private val saveInProgress = AtomicBoolean(false)
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val appHost = "appassets.androidplatform.net"
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val callbackId = permissionCallbackId
        permissionCallbackId = null
        if (!callbackId.isNullOrBlank()) {
            notifyPermission(callbackId, granted, if (granted) "" else "Storage permission is required to save files.")
        }
    }

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        if (callback == null) return@registerForActivityResult
        val selected = if (result.resultCode == RESULT_OK) {
            result.data?.let { data ->
                val clip = data.clipData
                if (clip != null && clip.itemCount > 1) {
                    Array(clip.itemCount) { clip.getItemAt(it).uri }
                } else {
                    data.data?.let { arrayOf(it) } ?: emptyArray()
                }
            }
        } else null
        callback.onReceiveValue(selected)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashReporter()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else finish()
            }
        })

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(0xFF0A0E17.toInt())
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            addJavascriptInterface(DownloadBridge(), "MultiHFAndroid")
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == appHost && uri.scheme == "https") return false
                if (uri.scheme == "https" || uri.scheme == "http") {
                    openExternal(uri)
                    return true
                }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                val accept = params?.acceptTypes?.filter { it.isNotBlank() }.orEmpty()
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (accept.isEmpty()) "*/*" else accept.first()
                    if (accept.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, accept.toTypedArray())
                }
                return try {
                    filePicker.launch(intent)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileChooserCallback = null
                    toast("No file picker is available on this device.")
                    false
                }
            }
        }

        webView.setDownloadListener { url, _, _, _, _ ->
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                toast("Preparing the file…")
            } else if (url.startsWith("https://")) {
                openExternal(Uri.parse(url))
            } else {
                toast("This link cannot be opened safely.")
            }
        }

        setContentView(webView)
        if (savedInstanceState == null) webView.loadUrl("https://$appHost/index.html")
        else webView.restoreState(savedInstanceState)
    }

    private fun installCrashReporter() {
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            val report = buildString {
                appendLine("Multi-HF Crash Report")
                appendLine("Time: ${java.util.Date()}")
                appendLine("App version: ${BuildConfig.VERSION_NAME}")
                appendLine("Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
                appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
                appendLine("Thread: ${thread.name}")
                appendLine("Exception: ${throwable.javaClass.name}")
                appendLine("Message: ${throwable.message ?: "(no message)"}")
                appendLine("--- Stack Trace ---")
                appendLine(throwable.stackTraceToString())
            }
            runCatching {
                openFileOutput(CRASH_REPORT_FILE, MODE_PRIVATE).bufferedWriter().use { it.write(report) }
            }
            if (previousHandler != null) previousHandler.uncaughtException(thread, throwable)
            else {
                Process.killProcess(Process.myPid())
                exitProcess(10)
            }
        }
    }

    inner class DownloadBridge {
        /** Permission is launched on the UI thread; the JS caller receives an async callback. */
        @JavascriptInterface
        fun requestStoragePermission(callbackId: String) {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q || hasLegacyWritePermission()) {
                    notifyPermission(callbackId, true, "")
                } else if (permissionCallbackId != null) {
                    notifyPermission(callbackId, false, "A storage permission request is already open.")
                } else {
                    permissionCallbackId = callbackId
                    permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                }
            }
        }

        @JavascriptInterface
        fun saveBase64(fileName: String, mimeType: String, base64: String, callbackId: String) {
            queueSave(callbackId) {
                ensureWritePermission()
                val bytes = try { Base64.decode(base64, Base64.DEFAULT) }
                catch (_: IllegalArgumentException) { throw IOException("The file data was not valid base64.") }
                writeToDownloads(fileName, mimeType, bytes.inputStream())
            }
        }

        @JavascriptInterface
        fun saveUrl(fileName: String, mimeType: String, rawUrl: String, callbackId: String) {
            queueSave(callbackId) {
                ensureWritePermission()
                val uri = runCatching { Uri.parse(rawUrl) }.getOrNull()
                    ?: throw IOException("That download URL is not valid.")
                if (uri.scheme != "https" || uri.host.isNullOrBlank() || !uri.userInfo.isNullOrBlank()) {
                    throw IOException("Only secure HTTPS download URLs are supported.")
                }
                val request = Request.Builder().url(uri.toString()).get().build()
                httpClient.newCall(request).execute().use { response ->
                    if (!response.request.url.isHttps) throw IOException("The download redirected to an insecure HTTP URL.")
                    if (!response.isSuccessful) throw IOException("Download failed (HTTP ${response.code}).")
                    val body = response.body ?: throw IOException("The server returned an empty download.")
                    writeToDownloads(fileName, mimeType, body.byteStream())
                }
            }
        }

        @JavascriptInterface
        fun getLastCrashReport(): String = runCatching {
            openFileInput(CRASH_REPORT_FILE).bufferedReader().use { it.readText() }
        }.getOrDefault("")

        @JavascriptInterface
        fun clearCrashReport(): String = runCatching {
            if (getFileStreamPath(CRASH_REPORT_FILE).exists() && !deleteFile(CRASH_REPORT_FILE)) {
                "Could not delete the crash report."
            } else ""
        }.getOrElse { it.message ?: "Could not clear the crash report." }

        @JavascriptInterface
        fun shareCrashReport() {
            runOnUiThread {
                val report = getLastCrashReport()
                if (report.isBlank()) {
                    toast("There is no crash report to share.")
                    return@runOnUiThread
                }
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, "Multi-HF crash report")
                    putExtra(Intent.EXTRA_TEXT, report)
                }
                startActivity(Intent.createChooser(intent, "Share crash report"))
            }
        }
    }

    private fun queueSave(callbackId: String, operation: () -> String) {
        if (!saveInProgress.compareAndSet(false, true)) {
            notifySave(callbackId, false, "Another save is already in progress.")
            return
        }
        ioExecutor.execute {
            val result = runCatching(operation)
            saveInProgress.set(false)
            notifySave(callbackId, result.isSuccess, result.getOrElse { it.message ?: "Saving failed." })
        }
    }

    private fun hasLegacyWritePermission(): Boolean = Build.VERSION.SDK_INT > Build.VERSION_CODES.P ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    private fun ensureWritePermission() {
        if (!hasLegacyWritePermission()) throw IOException("Storage permission is required. Grant it, then tap Save again.")
    }

    /** Writes on the dedicated IO executor, not on the WebView JavaScript or UI thread. */
    private fun writeToDownloads(fileName: String, mimeType: String, input: InputStream): String {
        val safeName = sanitizeFileName(fileName, mimeType)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType.ifBlank { "application/octet-stream" })
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("Could not create a file in Downloads.")
            try {
                input.use { source ->
                    contentResolver.openOutputStream(uri)?.use { output -> source.copyTo(output) }
                        ?: throw IOException("Could not open the destination file.")
                }
                val published = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                contentResolver.update(uri, published, null, null)
            } catch (error: Exception) {
                contentResolver.delete(uri, null, null)
                throw error
            }
            return "Saved to Downloads/$safeName"
        }

        val directory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!directory.exists() && !directory.mkdirs()) throw IOException("Could not create the Downloads folder.")
        val file = uniqueFile(directory, safeName)
        try {
            input.use { source -> FileOutputStream(file).use { output -> source.copyTo(output) } }
        } catch (error: Exception) {
            file.delete()
            throw error
        }
        return "Saved to Downloads/${file.name}"
    }

    private fun uniqueFile(directory: File, requestedName: String): File {
        val stem = requestedName.substringBeforeLast('.', requestedName)
        val extension = requestedName.substringAfterLast('.', "").let { if (it.isBlank()) "" else ".$it" }
        var candidate = File(directory, requestedName)
        var index = 1
        while (candidate.exists()) {
            candidate = File(directory, "$stem ($index)$extension")
            index += 1
        }
        return candidate
    }

    private fun sanitizeFileName(rawName: String, mimeType: String): String {
        val decoded = runCatching { URLDecoder.decode(rawName, "UTF-8") }.getOrDefault(rawName)
        val base = decoded.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._-]"), "_").take(96)
        val fallbackExtension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)?.let { ".$it" }.orEmpty()
        if (base.isBlank() || base == "_") return "multi-hf-download$fallbackExtension"
        return if (base.contains('.')) base else base + fallbackExtension
    }

    private fun notifySave(callbackId: String, success: Boolean, message: String) {
        val script = "window.MultiHFAndroidCallbacks?.onSaveResult(${JSONObject.quote(callbackId)},$success,${JSONObject.quote(message)});"
        runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript(script, null) }
    }

    private fun notifyPermission(callbackId: String, granted: Boolean, message: String) {
        val script = "window.MultiHFAndroidCallbacks?.onPermissionResult(${JSONObject.quote(callbackId)},$granted,${JSONObject.quote(message)});"
        if (::webView.isInitialized) webView.evaluateJavascript(script, null)
    }

    private fun openExternal(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
        catch (_: ActivityNotFoundException) { toast("No app can open this link.") }
    }

    private fun toast(message: String) { Toast.makeText(this, message, Toast.LENGTH_SHORT).show() }

    override fun onSaveInstanceState(outState: Bundle) {
        if (::webView.isInitialized) webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        ioExecutor.shutdownNow()
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.removeJavascriptInterface("MultiHFAndroid")
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val CRASH_REPORT_FILE = "crash-report.txt"
    }
}
