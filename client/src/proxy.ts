import express from 'express';
import { createProxyMiddleware, Options as ProxyOpts } from 'http-proxy-middleware';

interface ProxyOptions extends ProxyOpts {
    basePath?: string;
    proxyPort?: number | string;
}

interface SSLProxyOptions extends ProxyOptions {
    ssl?: {
        key: string;
        cert: string;
    };
}

const port = process.env.PROXY_PORT || 3000;
const app = express();

export const createProxyServer = (target: string, opts?: ProxyOptions) => {
    if (!target) {
        throw new Error('Proxy target is required');
    }

    app.use(
        opts?.basePath || '',
        createProxyMiddleware({
            target,
            changeOrigin: true,
            ws: true,
            onProxyReq: (proxyReq: any, req: any, res: any) => {
                console.log(`[HTTP] Proxying ${req.method} ${req.url} to ${target}`);
            },
            onProxyReqWs: (proxyReq: any, req: any, socket: any, options: any, head: any) => {
                console.log(`[WS] Proxying ${req.method} ${req.url} to ${target}`);
            },
            onError: (err: any, req: any, res: any) => {
                console.error(`Proxy error: ${err.message}`);
            },
            ...opts
        } as any)
    );

    const proxyPort = opts?.proxyPort || port;
    return app.listen(proxyPort, () => {
        console.log(`Proxy listening on port ${proxyPort} and forwarding to ${target}`);
    });
};
