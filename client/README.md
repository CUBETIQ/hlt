# CUBETIQ HTTP Tunnel Client

A lightweight http tunnel client using nodejs and socket.io client.

### Installation

```shell
npm i -g @cubetiq/hlt

OR

npx -y @cubetiq/hlt

```

### Usages

-   If installed to global (bin), please using cli

```shell
hlt [command] [options]
```

-   Initialize Client and Start (Quick)

```shell
# Initialize a client and token for connect (default's profile)
npx -y @cubetiq/hlt init

# Start port 3000 to remote server
npx -y @cubetiq/hlt start 3000
```

# Start port 3000 with suffix to remote server

npx -y @cubetiq/hlt start 3000 -s mytest

````

- Initialize Client and Start (Quick with custom's profile)

```shell
# Initialize a client and token for connect (mytest's profile)
npx -y @cubetiq/hlt init -p mytest

# Start port 3000 to remote server (mytest's profile)
npx -y @cubetiq/hlt start 3000 -p mytest
````

### Custom Config

-   Generate Client Key

```shell
npx -y @cubetiq/hlt config client new
```

-   Set Client Token (Required, contact to vendor)

```shell
npx -y @cubetiq/hlt config token $TOKEN
```

-   Set Custom Server

```shell
npx -y @cubetiq/hlt config server https://lt.ctdn.net
```

-   Start Client

```shell
npx -y @cubetiq/hlt start $YOUR_PORT
```

### Contributors

-   Original [web-tunnel](https://github.com/web-tunnel/lite-http-tunnel-client)
-   Sambo Chea <sombochea@cubetiqs.com>
