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
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

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

    /* ================= HLS（m3u8）下载 =================
     * BBC 很多节目只有 HLS 分段流，没有 mp4 直链。
     * 这里在原生层抓播放列表、按顺序拉分片并合并成一个文件：
     *   - fMP4（有 #EXT-X-MAP 或 .m4s 分片）→ 拼成 .mp4
     *   - 传统 TS 分片               → 拼成 .ts
     *   - AES-128 加密             → 用 javax.crypto 解密后再写
     * 只支持单一视频轨；多轨 / SAMPLE-AES / BYTERANGE 直接报“不支持”，
     * 让前端明确告诉用户“该节目视频格式暂不支持”，而不是悄悄换成音频。
     */

    /** 表示这个流我们处理不了，前端收到后提示“格式暂不支持” */
    private static final class HlsUnsupported extends Exception {
        HlsUnsupported(String msg) { super(msg); }
    }

    private static final class HlsKey {
        final String uri;
        final String ivHex;
        HlsKey(String uri, String ivHex) { this.uri = uri; this.ivHex = ivHex; }
    }

    private static final class HlsSeg {
        final String uri;
        final HlsKey key;
        final long seq;
        HlsSeg(String uri, HlsKey key, long seq) { this.uri = uri; this.key = key; this.seq = seq; }
    }

    /** 从 m3u8 的一行里取 KEY=VALUE（值可以带引号也可以不带） */
    private static String kv(String line, String name) {
        try {
            Matcher m = Pattern.compile(name + "=(?:\"([^\"]*)\"|([^,\\s]+))").matcher(line);
            if (m.find()) return m.group(1) != null ? m.group(1) : m.group(2);
        } catch (Throwable ignore) { /* 语法异常就当没有这个属性 */ }
        return null;
    }

    private static long numAfterColon(String line) {
        try {
            Matcher m = Pattern.compile(":(\\d+)").matcher(line);
            if (m.find()) return Long.parseLong(m.group(1));
        } catch (Throwable ignore) { /* 保持 0 */ }
        return 0;
    }

    private static String absUrl(String base, String ref) throws IOException {
        return new URL(new URL(base), ref).toString();
    }

    private static byte[] hexToBytes(String hex) {
        String h = hex == null ? "" : hex.trim();
        if (h.length() > 2 && (h.charAt(1) == 'x' || h.charAt(1) == 'X')) h = h.substring(2);
        if (h.length() % 2 != 0) h = "0" + h;
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /** IV：有就用之；没有则按 HLS 规范用媒体序号构造 16 字节大端 IV */
    private static byte[] ivBytes(String ivHex, long seq) {
        if (ivHex != null) {
            byte[] iv = null;
            try { iv = hexToBytes(ivHex); } catch (Throwable ignore) { iv = null; }
            if (iv != null && iv.length == 16) return iv;
        }
        byte[] iv = new byte[16];
        for (int i = 0; i < 8; i++) iv[15 - i] = (byte) ((seq >>> (8 * i)) & 0xff);
        return iv;
    }

    private static byte[] aesDecrypt(byte[] data, byte[] keyBytes, byte[] iv) throws Exception {
        // 对 AES 的 16 字节块，PKCS5Padding 与 HLS 用的 PKCS7 填充等价，
        // 而 PKCS5Padding 在所有 JCE 提供者里都有，兼容性更好
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(keyBytes, "AES"), new IvParameterSpec(iv));
        return c.doFinal(data);
    }

    private static String swapExt(String path, String ext) {
        int dot = path.lastIndexOf('.');
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return dot > slash ? path.substring(0, dot) + "." + ext : path + "." + ext;
    }

    private static String safePath(String p) {
        String s = p.replace('\\', '/').replace("../", "");
        while (s.startsWith("/")) s = s.substring(1);
        return s;
    }

    private String getText(String url, int ct, int rt, Proxy proxy) throws IOException {
        return new String(getBytes(url, ct, rt, proxy), StandardCharsets.UTF_8);
    }

    private byte[] getBytes(String url, int ct, int rt, Proxy proxy) throws IOException {
        HttpURLConnection conn = open(url, ct, rt, proxy);
        try {
            int code = conn.getResponseCode();
            if (code >= 400) throw new IOException("HTTP " + code);
            InputStream in = conn.getInputStream();
            return readAll(in, null, -1);
        } finally {
            conn.disconnect();
        }
    }

    /** 从 master playlist 里挑一路：分辨率不超过 maxHeight 的里面码率最高的 */
    private static String pickVariant(String text, String baseUrl, int maxHeight) {
        String best = null;
        int bestBw = -1;
        int pendingBw = 0;
        int pendingH = 0;
        for (String raw : text.split("\n")) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-STREAM-INF")) {
                pendingBw = 0;
                String bw = kv(line, "BANDWIDTH");
                if (bw != null) {
                    try { pendingBw = Integer.parseInt(bw.trim()); } catch (Throwable ignore) { /* 保持 0 */ }
                }
                pendingH = 0;
                String res = kv(line, "RESOLUTION");
                if (res != null) {
                    String[] wh = res.split("[xX]");
                    if (wh.length > 1) {
                        try { pendingH = Integer.parseInt(wh[1].trim()); } catch (Throwable ignore) { /* 保持 0 */ }
                    }
                }
                continue;
            }
            if (line.isEmpty() || line.startsWith("#")) continue;
            // 这一行是变体的 URI
            if (maxHeight <= 0 || pendingH <= maxHeight) {
                if (pendingBw > bestBw) { bestBw = pendingBw; best = line; }
            }
            pendingBw = 0;
            pendingH = 0;
        }
        if (best == null) return null;
        try { return absUrl(baseUrl, best); } catch (Exception e) { return null; }
    }

    private void emitSegments(String id, int done, int total, long bytes) {
        try {
            JSObject o = new JSObject();
            o.put("id", id);
            o.put("kind", "segment");
            o.put("loaded", done);
            o.put("total", total);
            o.put("bytes", bytes);
            notifyListeners("downloadProgress", o);
        } catch (Throwable ignore) { /* 忽略 */ }
    }

    /**
     * 下载并合并一路 HLS 流。
     * @param outPath 相对于 Filesystem 的 DATA 目录（getFilesDir），如 downloads/x/y.mp4
     */
    private JSObject downloadHls(String url, String outPath, String progressId,
                                 int ct, int rt, int maxHeight) throws Exception {
        Proxy proxy = systemProxy();

        String listUrl = url;
        String text = getText(url, ct, rt, proxy);
        if (text.contains("#EXT-X-STREAM-INF")) {
            String picked = pickVariant(text, url, maxHeight);
            if (picked == null) throw new HlsUnsupported("多码率列表解析失败");
            listUrl = picked;
            text = getText(picked, ct, rt, proxy);
        }

        List<HlsSeg> segs = new ArrayList<>();
        String mapUri = null;
        HlsKey curKey = null;
        long seq = 0;

        for (String raw : text.split("\n")) {
            String line = raw.trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
                seq = numAfterColon(line);
                continue;
            }
            if (line.startsWith("#EXT-X-MAP")) {
                mapUri = kv(line, "URI");
                continue;
            }
            if (line.startsWith("#EXT-X-KEY")) {
                String method = kv(line, "METHOD");
                if (method == null || "NONE".equalsIgnoreCase(method)) {
                    curKey = null;
                } else if ("AES-128".equalsIgnoreCase(method)) {
                    curKey = new HlsKey(kv(line, "URI"), kv(line, "IV"));
                } else {
                    throw new HlsUnsupported("加密方式为 " + method + "（只支持 AES-128）");
                }
                continue;
            }
            if (line.startsWith("#EXT-X-BYTERANGE")) throw new HlsUnsupported("BYTERANGE 分片流");
            if (line.startsWith("#")) continue;
            segs.add(new HlsSeg(line, curKey, seq));
            seq++;
        }
        if (segs.isEmpty()) throw new HlsUnsupported("播放列表里没有可用分片");

        boolean fmp4 = mapUri != null;
        if (!fmp4) {
            String u0 = segs.get(0).uri.toLowerCase();
            fmp4 = u0.contains(".m4s") || u0.contains(".cmfv") || u0.contains(".cmfa") || u0.contains(".mp4");
        }
        String realPath = fmp4 ? outPath : swapExt(outPath, "ts");

        File out = new File(getContext().getFilesDir(), safePath(realPath));
        File parent = out.getParentFile();
        if (parent != null) parent.mkdirs();

        long written = 0;
        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(out, false);
            Map<String, byte[]> keyCache = new HashMap<>();

            if (mapUri != null) {
                byte[] init = getBytes(absUrl(listUrl, mapUri), ct, rt, proxy);
                fos.write(init);
                written += init.length;
            }

            int i = 0;
            for (HlsSeg s : segs) {
                byte[] data = getBytes(absUrl(listUrl, s.uri), ct, rt, proxy);
                if (s.key != null) {
                    byte[] kb = keyCache.get(s.key.uri);
                    if (kb == null) {
                        kb = getBytes(absUrl(listUrl, s.key.uri), ct, rt, proxy);
                        keyCache.put(s.key.uri, kb);
                    }
                    data = aesDecrypt(data, kb, ivBytes(s.key.ivHex, s.seq));
                }
                fos.write(data);
                written += data.length;
                i++;
                if (progressId != null && (i % 2 == 0 || i == segs.size())) {
                    emitSegments(progressId, i, segs.size(), written);
                }
            }
        } catch (Exception e) {
            // 半成品文件没用，直接删掉，别占用户空间
            try { out.delete(); } catch (Throwable ignore) { /* 忽略 */ }
            throw e;
        } finally {
            if (fos != null) {
                try { fos.close(); } catch (Throwable ignore) { /* 忽略 */ }
            }
        }

        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("path", realPath);
        ret.put("bytes", written);
        ret.put("segments", segs.size());
        ret.put("format", fmp4 ? "mp4" : "ts");
        return ret;
    }

    @PluginMethod
    public void hls(PluginCall call) {
        final String url = call.getString("url");
        final String path = call.getString("path");
        final String progressId = call.getString("progressId");
        final int ct = call.getInt("connectTimeout", 25000);
        final int rt = call.getInt("readTimeout", 60000);
        final int maxHeight = call.getInt("maxHeight", 720);
        if (url == null || path == null || path.isEmpty()) {
            call.reject("url and path required");
            return;
        }

        new Thread(() -> {
            try {
                call.resolve(downloadHls(url, path, progressId, ct, rt, maxHeight));
            } catch (HlsUnsupported e) {
                call.reject("UNSUPPORTED:" + e.getMessage());
            } catch (Throwable e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }
}
