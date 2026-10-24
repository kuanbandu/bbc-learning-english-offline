// httpbridge 的 Web 端占位：
// 真正的能力在原生（Android）侧，由 app/net.js 通过 Capacitor.registerPlugin('HttpBridge') 调用。
// 这里只提供一个 CommonJS 入口，避免 npm 安装时缺少 main 的警告。
module.exports = {};
