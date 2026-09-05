import * as net from 'net'

const port = process.env.PROXY_PORT || 3000;

interface ProxyOptions extends net.TcpNetConnectOpts {
    proxyPort?: number | string;
}

// Create a TCP server that acts as a proxy
export const createProxyServer = (targetHost: string, targetPort: number, opts?: Partial<ProxyOptions>) => {
    const server = net.createServer((clientSocket) => {
        const targetSocket = net.createConnection({
            host: targetHost,
            port: targetPort,
            ...opts,
        });

        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);

        // Listen for target socket connection
        targetSocket.on('connect', () => {
            console.log(`Target socket connected to ${targetHost}:${targetPort}`);
        });

        // targetSocket.on('data', (data) => {
        //     console.log('Target socket received data length:', data.length);
        // });

        // Listen for client socket requests
        clientSocket.on('data', (data) => {
            console.log('Client socket request data', data.toString());
        });

        clientSocket.on('end', () => {
            targetSocket.end();
        });

        targetSocket.on('end', () => {
            clientSocket.end();
        });

        clientSocket.on('error', (err) => {
            console.error('Client socket error:', err);
        });

        targetSocket.on('error', (err) => {
            console.error('Target socket error:', err);
        });

        targetSocket.on('timeout', () => {
            console.log('Target socket timeout');
        });

        clientSocket.on('timeout', () => {
            console.log('Client socket timeout');
        });

    });

    const proxyPort = opts?.proxyPort || port;
    server.listen(proxyPort, () => {
        console.log(`TCP proxy server listening on port ${proxyPort} and forwarding to ${targetHost}:${targetPort}`);
    });

    return server;
}