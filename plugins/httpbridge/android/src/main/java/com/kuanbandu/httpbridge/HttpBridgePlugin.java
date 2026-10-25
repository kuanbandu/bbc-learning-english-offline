package com.kuanbandu.httpbridge;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.ProxyInfo;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 极简原生 HTTP-GET 桥接。唯一目的：让 App 内的 JS 能发起跨域请求抓取 BBC，
 * 绕过 WebView 对 fetch 的 CORS 限制。支持 text 与 arraybuffer（返回 base64）两种返回。
 *
 * 说明：HttpURLConnection 默认【不会】走安卓的系统 HTTP 代理，而浏览器/WebView 会。
 * 所以这里主动读取系统代理并套用，避免出现“浏览器能打开、App 连不上”的情况。
 */
@CapacitorPlugin(name = "HttpBridge")
public class HttpBridgePlugin extends Plugin {

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    /** 读取当前网络配置里的 HTTP 代理；没有或读不到则返回 null（直连）。 */
    private Proxy systemProxy() {
        try {
            ConnectivityManager cm =
                (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return null;
            Network net = cm.getActiveNetwork();
            if (net == null) return null;
            LinkProperties lp = cm.getLinkProperties(net);
            if (lp == null) return null;
            ProxyInfo pi = lp.getHttpProxy();
            if (pi == null || pi.getHost() == null || pi.getPort() <= 0) return null;
            return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(pi.getHost(), pi.getPort()));
        } catch (Throwable ignore) {
            return null;
        }
    }

    private static String proxyText(Proxy proxy) {
        if (proxy == null) return "";
        try {
            InetSocketAddress sa = (InetSocketAddress) proxy.address();
            return sa.getHostString() + ":" + sa.getPort();
        } catch (Throwable ignore) {
            return "";
        }
    }

    private HttpURLConnection open(String url, int connectTimeout, int readTimeout, Proxy proxy)
        throws IOException {
        URL u = new URL(url);
        HttpURLConnection conn = (proxy != null)
            ? (HttpURLConnection) u.openConnection(proxy)
            : (HttpURLConnection) u.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(connectTimeout);
        conn.setReadTimeout(readTimeout);
        conn.setRequestProperty("User-Agent", UA);
        return conn;
    }

    @PluginMethod
    public void get(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url required");
            return;
        }
        JSONObject headersObj;
        try {
            headersObj = call.getObject("headers");
        } catch (Exception e) {
            headersObj = new JSONObject();
        }
        if (headersObj == null) headersObj = new JSONObject();

        String responseType = call.getString("responseType", "text");
        int connectTimeout = call.getInt("connectTimeout", 30000);
        int readTimeout = call.getInt("readTimeout", 600000);
        // 传入 progressId 时，边读边发 downloadProgress 事件，前端据此显示进度条
        final String progressId = call.getString("progressId");

        final String rt = responseType;
        final JSONObject hdrs = headersObj;
        final Proxy proxy = systemProxy();

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = open(url, connectTimeout, readTimeout, proxy);
                java.util.Iterator<String> keys = hdrs.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    conn.setRequestProperty(k, hdrs.getString(k));
                }
                conn.connect();
                int code = conn.getResponseCode();
                InputStream in = code < 400 ? conn.getInputStream() : conn.getErrorStream();
                long total = -1;
                try { total = conn.getContentLengthLong(); } catch (Throwable ignore) { /* 分块传输没有长度 */ }
                byte[] bytes = readAll(in, progressId, total);
                JSObject ret = new JSObject();
                ret.put("status", code);
                ret.put("bytes", bytes.length);
                ret.put("viaProxy", proxyText(proxy));
                if ("arraybuffer".equals(rt)) {
                    ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    ret.put("data", new String(bytes, StandardCharsets.UTF_8));
                }
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /**
     * 网络自检：DNS 解析 / 系统代理 / HTTPS 探测，一次把“卡在哪一层”说清楚。
     * 返回 { ok, status, ms, error, dns:[], dnsError, proxy }
     */
    @PluginMethod
    public void diag(PluginCall call) {
        String url = call.getString("url", "https://www.bbc.co.uk/learningenglish");
        String host = call.getString("host", "www.bbc.co.uk");
        int timeout = call.getInt("timeout", 12000);
        final Proxy proxy = systemProxy();

        new Thread(() -> {
            JSObject ret = new JSObject();
            ret.put("proxy", proxyText(proxy));

            try {
                InetAddress[] addrs = InetAddress.getAllByName(host);
                JSONArray arr = new JSONArray();
                for (InetAddress a : addrs) arr.put(a.getHostAddress());
                ret.put("dns", arr);
            } catch (Throwable e) {
                ret.put("dns", new JSONArray());
                ret.put("dnsError", String.valueOf(e.getMessage()));
            }

            HttpURLConnection conn = null;
            long t0 = System.currentTimeMillis();
            try {
                conn = open(url, timeout, timeout, proxy);
                int code = conn.getResponseCode();
                ret.put("ok", code < 400);
                ret.put("status", code);
                ret.put("ms", System.currentTimeMillis() - t0);
            } catch (Throwable e) {
                ret.put("ok", false);
                ret.put("error", String.valueOf(e.getMessage()));
                ret.put("ms", System.currentTimeMillis() - t0);
            } finally {
                if (conn != null) conn.disconnect();
            }
            call.resolve(ret);
        }).start();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        return readAll(in, null, -1);
    }

    /**
     * 读完整流。progressId 非空时，每 ~150ms 回调一次 downloadProgress，避免刷屏。
     * total 为 -1 表示服务器没给 Content-Length（分块传输）。
     */
    private byte[] readAll(InputStream in, String progressId, long total) throws IOException {
        // 只在“已知且不算太大”时按总量预分配，避免一次性申请过大内存
        int cap = (total > 0 && total < 32L * 1024 * 1024) ? (int) total : 8192;
        ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(cap, 8192));
        byte[] buf = new byte[16384];
        int n;
        long loaded = 0;
        long lastEmit = 0;
        while ((n = in.read(buf)) != -1) {
            bos.write(buf, 0, n);
            loaded += n;
            if (progressId != null) {
                long now = System.currentTimeMillis();
                if (now - lastEmit >= 150) {
                    lastEmit = now;
                    emitProgress(progressId, loaded, total);
                }
            }
        }
        if (progressId != null) emitProgress(progressId, loaded, total);
        return bos.toByteArray();
    }

    private void emitProgress(String progressId, long loaded, long total) {
        try {
            JSObject o = new JSObject();
            o.put("id", progressId);
            o.put("loaded", loaded);
            o.put("total", total);
            notifyListeners("downloadProgress", o);
        } catch (Throwable ignore) {
            // 页面已销毁等情况忽略即可，不影响下载
        }
    }
}
