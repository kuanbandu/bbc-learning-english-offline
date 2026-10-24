package com.kuanbandu.httpbridge;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import android.util.Base64;

/**
 * 极简原生 HTTP-GET 桥接。唯一目的：让 App 内的 JS 能发起跨域请求抓取 BBC，
 * 绕过 WebView 对 fetch 的 CORS 限制。支持 text 与 arraybuffer（返回 base64）两种返回。
 */
@CapacitorPlugin(name = "HttpBridge")
public class HttpBridgePlugin extends Plugin {

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

        final String rt = responseType;
        final JSONObject hdrs = headersObj;
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(connectTimeout);
                conn.setReadTimeout(readTimeout);
                java.util.Iterator<String> keys = hdrs.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    conn.setRequestProperty(k, hdrs.getString(k));
                }
                conn.connect();
                int code = conn.getResponseCode();
                InputStream in = code < 400 ? conn.getInputStream() : conn.getErrorStream();
                byte[] bytes = readAll(in);
                JSObject ret = new JSObject();
                ret.put("status", code);
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

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toByteArray();
    }
}
