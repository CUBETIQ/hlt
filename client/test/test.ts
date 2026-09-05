import { startClient } from '../src/api';

async function main() {
    const client = await startClient({
        // port: 8081,
        address: '172.17.0.2:8222',
        options: {
            profile: 'mytest',
        },
    });

    console.log('Client started:', client?.getEndpoint());

    setTimeout(async () => {
        client?.stop();
    }, 10000);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

// import { createProxyServer } from './proxy';
// import { createProxyServer } from './proxy_tcp';

// const proxy = createProxyServer('https://git.cubetiqs.com', {
//     proxyPort: 3005,
//     basePath: '/',
// });

// const proxy = createProxyServer('192.168.0.202', 8081, {
//     proxyPort: 3005,
// });
