import express from 'express';
import { Request, Response } from 'express';

const app = express();
app.use(express.json());

interface WebhookEvent {
    ip: string;
    method: string;
    headers: any;
    body?: Record<string, any>;
    query?: any;
    params?: any;
}

const getClientIp = (req: Request): string => {
    const cfConnectingIp = req.headers['cf-connecting-ip'];
    if (cfConnectingIp) {
        if (Array.isArray(cfConnectingIp)) {
            return cfConnectingIp[0];
        }

        return cfConnectingIp;
    }

    let ip = req.headers['x-forwarded-for']
    if (Array.isArray(ip)) {
        return ip[0];
    }

    if (typeof ip === 'string') {
        return ip;
    }

    ip = req.headers['x-real-ip'];
    if (ip) {
        if (Array.isArray(ip)) {
            return ip[0];
        }

        return ip;
    }

    return req.socket.remoteAddress || '';
}

const print = (req: Request, res: Response) => {
    // Print pretty JSON to the console for debugging
    const event: WebhookEvent = {
        ip: getClientIp(req),
        method: req.method,
        headers: req.headers,
        body: req.body || undefined,
        query: req.query || undefined,
        params: req.params || undefined,
    };
    console.log(JSON.stringify(event, null, 2));

    res.sendStatus(200);
}

app.get('/', print);
app.post('/', print);

export const startWebhookServer = (port: number) => {
    return app.listen(port, () => {
        console.log(`Webhook server listening on port ${port}`);
    });
}
